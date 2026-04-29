import { Effect, Schema } from "effect"
import { lookup, resolve4, resolve6 } from "node:dns/promises"
import { createConnection } from "node:net"
import DESCRIPTION from "./net_check.txt"
import * as Tool from "./tool"

const MODES = ["dns", "tcp", "http"] as const
const HTTP_METHODS = ["HEAD", "GET"] as const

export const Parameters = Schema.Struct({
  mode: Schema.Literals(MODES).annotate({
    description: "Probe mode: 'dns' resolves a hostname, 'tcp' opens a TCP connection, 'http' makes a HEAD/GET request.",
  }),
  host: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(255))).annotate({
    description: "Hostname for 'dns' and 'tcp' modes. Use 'url' instead for 'http'.",
  }),
  port: Schema.optional(
    Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(65535)),
  ).annotate({
    description: "TCP port for 'tcp' mode (1-65535).",
  }),
  url: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2048))).annotate({
    description: "Full URL for 'http' mode. Must use http:// or https://.",
  }),
  method: Schema.optional(Schema.Literals(HTTP_METHODS)).annotate({
    description: "HTTP method for 'http' mode. Default HEAD. Use GET to also fetch a body preview.",
  }),
  timeout_ms: Schema.optional(
    Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(100), Schema.isLessThanOrEqualTo(60_000)),
  ).annotate({
    description: "Per-attempt timeout in ms. Default 5000, max 60000.",
  }),
  expect_status: Schema.optional(
    Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(100), Schema.isLessThanOrEqualTo(599)),
  ).annotate({
    description: "Optional expected HTTP status. Sets metadata.matches.",
  }),
  expect_substring: Schema.optional(Schema.String.check(Schema.isMaxLength(500))).annotate({
    description: "Optional substring to check in the response body (only with mode=http, method=GET).",
  }),
})

type Params = Schema.Schema.Type<typeof Parameters>
type Mode = (typeof MODES)[number]
type HttpMethod = (typeof HTTP_METHODS)[number]

type DnsRecord = { kind: "A" | "AAAA"; value: string }

type Metadata = {
  mode: Mode
  // dns
  host?: string
  addresses?: DnsRecord[]
  // tcp
  port?: number
  connected?: boolean
  latency_ms?: number
  // http
  url?: string
  method?: HttpMethod
  status?: number
  status_text?: string
  server?: string
  content_type?: string
  content_length?: number
  headers?: Record<string, string>
  body_preview?: string
  body_size?: number
  total_ms?: number
  matches?: boolean
  body_matches?: boolean
  error?: string
  timeout_ms: number
}

const done = (result: Tool.ExecuteResult<Metadata>) => result

const DEFAULT_TIMEOUT_MS = 5_000

async function probeDns(host: string, timeoutMs: number, signal: AbortSignal): Promise<Metadata> {
  const start = Date.now()
  // node:dns/promises doesn't take an abort signal directly, so race with one.
  const race = async <T>(p: Promise<T>): Promise<T | undefined> => {
    let timer: NodeJS.Timeout | undefined
    try {
      return await Promise.race([
        p,
        new Promise<T>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`timeout ${timeoutMs}ms`)), timeoutMs)
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
        }),
      ])
    } catch {
      return undefined
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  const [v4, v6] = await Promise.all([
    race(resolve4(host)).catch(() => undefined),
    race(resolve6(host)).catch(() => undefined),
  ])
  const addresses: DnsRecord[] = []
  for (const a of v4 ?? []) addresses.push({ kind: "A", value: a })
  for (const a of v6 ?? []) addresses.push({ kind: "AAAA", value: a })
  // c-ares-based resolve4/resolve6 sometimes returns nothing on Windows where the
  // resolver only knows about the local DNS server. Fall back to the OS resolver
  // (which is what `nslookup`/`getaddrinfo` use) so we still return something useful.
  if (addresses.length === 0) {
    try {
      const all = await race(lookup(host, { all: true, verbatim: true } as any))
      for (const entry of (all as unknown as Array<{ address: string; family: number }>) ?? []) {
        addresses.push({ kind: entry.family === 6 ? "AAAA" : "A", value: entry.address })
      }
    } catch {}
  }
  const elapsed = Date.now() - start
  return {
    mode: "dns",
    host,
    addresses,
    latency_ms: elapsed,
    timeout_ms: timeoutMs,
    error: addresses.length === 0 ? "no records (or all timeouts)" : undefined,
  }
}

async function probeTcp(host: string, port: number, timeoutMs: number, signal: AbortSignal): Promise<Metadata> {
  const start = Date.now()
  return new Promise<Metadata>((resolve) => {
    let settled = false
    const socket = createConnection({ host, port })
    const cleanup = () => {
      try {
        socket.destroy()
      } catch {}
    }
    const onAbort = () => {
      if (settled) return
      settled = true
      cleanup()
      resolve({
        mode: "tcp",
        host,
        port,
        connected: false,
        latency_ms: Date.now() - start,
        timeout_ms: timeoutMs,
        error: "aborted",
      })
    }
    signal.addEventListener("abort", onAbort, { once: true })
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      signal.removeEventListener("abort", onAbort)
      cleanup()
      resolve({
        mode: "tcp",
        host,
        port,
        connected: false,
        latency_ms: Date.now() - start,
        timeout_ms: timeoutMs,
        error: `timeout after ${timeoutMs}ms`,
      })
    }, timeoutMs)
    socket.once("connect", () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener("abort", onAbort)
      cleanup()
      resolve({
        mode: "tcp",
        host,
        port,
        connected: true,
        latency_ms: Date.now() - start,
        timeout_ms: timeoutMs,
      })
    })
    socket.once("error", (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener("abort", onAbort)
      cleanup()
      resolve({
        mode: "tcp",
        host,
        port,
        connected: false,
        latency_ms: Date.now() - start,
        timeout_ms: timeoutMs,
        error: err.message || "connect failed",
      })
    })
  })
}

const HTTP_BODY_PREVIEW_BYTES = 32 * 1024 // 32 KB

async function probeHttp(
  url: string,
  method: HttpMethod,
  timeoutMs: number,
  signal: AbortSignal,
  expectStatus: number | undefined,
  expectSubstring: string | undefined,
): Promise<Metadata> {
  const start = Date.now()
  // Wire up our own abort for timeout, plus parent signal.
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs)
  const onParent = () => ac.abort(new Error("aborted"))
  signal.addEventListener("abort", onParent, { once: true })
  try {
    const res = await fetch(url, { method, signal: ac.signal, redirect: "manual" })
    const headers: Record<string, string> = {}
    res.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value
    })
    let body_preview: string | undefined
    let body_size: number | undefined
    let body_matches: boolean | undefined
    if (method === "GET") {
      const reader = res.body?.getReader()
      if (reader) {
        const chunks: Uint8Array[] = []
        let total = 0
        while (true) {
          const { done: rdone, value } = await reader.read()
          if (rdone || !value) break
          total += value.byteLength
          if (total <= HTTP_BODY_PREVIEW_BYTES) chunks.push(value)
          else {
            // Cap and stop reading to avoid pulling massive bodies.
            const remaining = HTTP_BODY_PREVIEW_BYTES - (total - value.byteLength)
            if (remaining > 0) chunks.push(value.subarray(0, remaining))
            try {
              await reader.cancel()
            } catch {}
            break
          }
        }
        body_size = total
        const buf = Buffer.concat(chunks)
        body_preview = buf.toString("utf8").slice(0, HTTP_BODY_PREVIEW_BYTES)
        if (expectSubstring) body_matches = body_preview.includes(expectSubstring)
      }
    }
    const total_ms = Date.now() - start
    const matches = expectStatus !== undefined ? res.status === expectStatus : undefined
    return {
      mode: "http",
      url,
      method,
      status: res.status,
      status_text: res.statusText,
      server: headers["server"],
      content_type: headers["content-type"],
      content_length: headers["content-length"] ? Number(headers["content-length"]) : undefined,
      headers,
      body_preview,
      body_size,
      total_ms,
      matches,
      body_matches,
      timeout_ms: timeoutMs,
    }
  } catch (err: unknown) {
    return {
      mode: "http",
      url,
      method,
      total_ms: Date.now() - start,
      timeout_ms: timeoutMs,
      error: err instanceof Error ? err.message : String(err),
    }
  } finally {
    clearTimeout(timer)
    signal.removeEventListener("abort", onParent)
  }
}

function summarise(meta: Metadata): { title: string; output: string } {
  if (meta.mode === "dns") {
    if (meta.error || (meta.addresses && meta.addresses.length === 0)) {
      return {
        title: `dns ${meta.host}: no records`,
        output: `dns ${meta.host} → no records (${meta.error ?? "timeout"})`,
      }
    }
    const lines = (meta.addresses ?? []).map((a) => `  ${a.kind.padEnd(4)} ${a.value}`)
    return {
      title: `dns ${meta.host}: ${meta.addresses?.length ?? 0} records`,
      output: [`dns ${meta.host} (${meta.latency_ms}ms):`, ...lines].join("\n"),
    }
  }
  if (meta.mode === "tcp") {
    if (meta.connected) {
      return {
        title: `tcp ${meta.host}:${meta.port} OK ${meta.latency_ms}ms`,
        output: `tcp ${meta.host}:${meta.port} connected in ${meta.latency_ms}ms`,
      }
    }
    return {
      title: `tcp ${meta.host}:${meta.port} FAIL`,
      output: `tcp ${meta.host}:${meta.port} failed: ${meta.error ?? "unknown"} (${meta.latency_ms}ms)`,
    }
  }
  // http
  if (meta.error) {
    return {
      title: `http ${meta.url}: ${meta.error}`,
      output: `http ${meta.method} ${meta.url} failed: ${meta.error} (${meta.total_ms}ms)`,
    }
  }
  const matchPart =
    meta.matches === true ? " (status matches)" : meta.matches === false ? ` (expected ${meta.matches})` : ""
  const bodyPart =
    meta.body_matches === true ? " body matches" : meta.body_matches === false ? " body NO match" : ""
  return {
    title: `http ${meta.method} ${meta.url}: ${meta.status}${matchPart}${bodyPart}`,
    output: [
      `http ${meta.method} ${meta.url}`,
      `  status:       ${meta.status} ${meta.status_text ?? ""}`.trimEnd(),
      meta.server ? `  server:       ${meta.server}` : undefined,
      meta.content_type ? `  content-type: ${meta.content_type}` : undefined,
      meta.content_length !== undefined ? `  content-length: ${meta.content_length}` : undefined,
      meta.body_size !== undefined ? `  body bytes:   ${meta.body_size} (preview ${meta.body_preview?.length ?? 0})` : undefined,
      `  total:        ${meta.total_ms}ms`,
      bodyPart || matchPart ? `  match:       ${matchPart.trim()}${bodyPart}` : undefined,
    ]
      .filter(Boolean)
      .join("\n"),
  }
}

export const NetCheckTool = Tool.define(
  "net_check",
  Effect.succeed({
    description: DESCRIPTION,
    parameters: Parameters,
    execute: (params: Params, ctx: Tool.Context<Metadata>) =>
      Effect.gen(function* () {
        const timeout_ms = params.timeout_ms ?? DEFAULT_TIMEOUT_MS

        if (params.mode === "dns") {
          if (!params.host) {
            return done({
              title: "net_check dns: missing host",
              metadata: { mode: "dns", timeout_ms, error: "host is required" },
              output: "Error: 'host' is required for mode='dns'.",
            })
          }
          yield* ctx.metadata({
            title: `dns ${params.host}`,
            metadata: { mode: "dns", host: params.host, timeout_ms },
          })
          const meta = yield* Effect.promise(() => probeDns(params.host!, timeout_ms, ctx.abort))
          const sum = summarise(meta)
          return done({ title: sum.title, metadata: meta, output: sum.output })
        }

        if (params.mode === "tcp") {
          if (!params.host || !params.port) {
            return done({
              title: "net_check tcp: missing host/port",
              metadata: { mode: "tcp", timeout_ms, error: "host and port are required" },
              output: "Error: both 'host' and 'port' are required for mode='tcp'.",
            })
          }
          yield* ctx.metadata({
            title: `tcp ${params.host}:${params.port}`,
            metadata: { mode: "tcp", host: params.host, port: params.port, timeout_ms },
          })
          const meta = yield* Effect.promise(() =>
            probeTcp(params.host!, params.port!, timeout_ms, ctx.abort),
          )
          const sum = summarise(meta)
          return done({ title: sum.title, metadata: meta, output: sum.output })
        }

        // mode === "http"
        if (!params.url) {
          return done({
            title: "net_check http: missing url",
            metadata: { mode: "http", timeout_ms, error: "url is required" },
            output: "Error: 'url' is required for mode='http'.",
          })
        }
        let parsed: URL
        try {
          parsed = new URL(params.url)
        } catch {
          return done({
            title: "net_check http: bad url",
            metadata: { mode: "http", url: params.url, timeout_ms, error: "invalid url" },
            output: `Error: not a valid URL: ${params.url}`,
          })
        }
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
          return done({
            title: "net_check http: unsupported protocol",
            metadata: { mode: "http", url: params.url, timeout_ms, error: `unsupported protocol ${parsed.protocol}` },
            output: `Error: only http:// and https:// are supported (got ${parsed.protocol}).`,
          })
        }
        const method: HttpMethod = params.method ?? "HEAD"
        yield* ctx.metadata({
          title: `http ${method} ${params.url}`,
          metadata: { mode: "http", url: params.url, method, timeout_ms },
        })
        const meta = yield* Effect.promise(() =>
          probeHttp(params.url!, method, timeout_ms, ctx.abort, params.expect_status, params.expect_substring),
        )
        const sum = summarise(meta)
        return done({ title: sum.title, metadata: meta, output: sum.output })
      }),
  }),
)

export const __testing = { probeDns, probeTcp, probeHttp, summarise }
