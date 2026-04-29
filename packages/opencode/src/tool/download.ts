import { Effect, Schema } from "effect"
import { createHash, type Hash } from "node:crypto"
import { open as fsOpen, unlink as fsUnlink, stat as fsStat } from "node:fs/promises"
import { mkdir } from "node:fs/promises"
import path from "path"
import { Instance } from "../project/instance"
import DESCRIPTION from "./download.txt"
import * as Tool from "./tool"

const MAX_TIMEOUT_MS = 3_600_000
const MIN_TIMEOUT_MS = 1_000
const DEFAULT_TIMEOUT_MS = 60_000
const MAX_BYTES_CAP = 21_474_836_480 // 20 GiB
const MIN_BYTES_CAP = 1024
const PROGRESS_INTERVAL_MS = 1_000

const IF_EXISTS = ["overwrite", "skip", "fail"] as const
type IfExists = (typeof IF_EXISTS)[number]

export const Parameters = Schema.Struct({
  url: Schema.String.check(Schema.isMinLength(8), Schema.isMaxLength(4096)).annotate({
    description: "http(s) URL to fetch. Redirects are followed.",
  }),
  dest: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2048)).annotate({
    description: "Local file path. Absolute preferred; relative paths resolve from the project directory.",
  }),
  expected_sha256: Schema.optional(Schema.String).annotate({
    description: "Optional sha256 hex digest. Bytes are hashed in-stream and verified before commit.",
  }),
  expected_size_bytes: Schema.optional(
    Schema.Number.check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(0)),
  ).annotate({
    description: "Optional exact content length. Mismatch with reported Content-Length aborts before any disk write.",
  }),
  headers: Schema.optional(Schema.Record(Schema.String, Schema.String)).annotate({
    description: "Optional extra request headers, e.g. {\"Authorization\":\"Bearer ...\"}.",
  }),
  timeout_ms: Schema.optional(
    Schema.Number.check(Schema.isInt())
      .check(Schema.isGreaterThanOrEqualTo(MIN_TIMEOUT_MS))
      .check(Schema.isLessThanOrEqualTo(MAX_TIMEOUT_MS)),
  ).annotate({
    description: `Connection + per-chunk inactivity timeout in ms. Default ${DEFAULT_TIMEOUT_MS}.`,
  }),
  if_exists: Schema.optional(Schema.Literals(IF_EXISTS)).annotate({
    description: "What to do if dest already exists. Default 'overwrite'.",
  }),
  max_bytes: Schema.optional(
    Schema.Number.check(Schema.isInt())
      .check(Schema.isGreaterThanOrEqualTo(MIN_BYTES_CAP))
      .check(Schema.isLessThanOrEqualTo(MAX_BYTES_CAP)),
  ).annotate({
    description: `Hard cap on bytes accepted. Range ${MIN_BYTES_CAP}-${MAX_BYTES_CAP}.`,
  }),
})

type Params = Schema.Schema.Type<typeof Parameters>

type Metadata = {
  url: string
  final_url?: string
  dest: string
  bytes_received: number
  bytes_total?: number
  percent?: number
  kbps?: number
  elapsed_ms: number
  sha256?: string
  expected_sha256?: string
  matches?: boolean
  status_code?: number
  content_type?: string
  if_exists?: IfExists
  skipped?: boolean
  aborted?: boolean
  error?: string
}

const normalizeHex = (s: string) => s.toLowerCase().replace(/[^a-f0-9]/g, "")

function isHttpUrl(value: string) {
  try {
    const u = new URL(value)
    return u.protocol === "http:" || u.protocol === "https:"
  } catch {
    return false
  }
}

function fmtBytes(n: number) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

async function fileExists(p: string) {
  try {
    const s = await fsStat(p)
    return { exists: true, size: Number(s.size ?? 0) }
  } catch {
    return { exists: false, size: 0 }
  }
}

async function safeUnlink(p: string) {
  try {
    await fsUnlink(p)
  } catch {}
}

const done = (result: Tool.ExecuteResult<Metadata>) => result

type StreamArgs = {
  body: ReadableStream<Uint8Array>
  dest: string
  hasher?: Hash
  maxBytes?: number
  abort: AbortSignal
  timeoutMs: number
  totalHint?: number
  onProgress: (received: number) => void
}

async function streamToFile(args: StreamArgs): Promise<{ received: number }> {
  const { body, dest, hasher, maxBytes, abort, timeoutMs, onProgress } = args
  const fh = await fsOpen(dest, "w")
  const reader = body.getReader()
  let received = 0
  let lastChunkAt = Date.now()
  const inactivityTimer = setInterval(() => {
    if (Date.now() - lastChunkAt > timeoutMs) {
      try {
        reader.cancel(new Error(`download stalled: no bytes received for ${timeoutMs}ms`)).catch(() => {})
      } catch {}
    }
  }, Math.min(2000, timeoutMs / 2))
  const onAbort = () => {
    try {
      reader.cancel(new Error("download aborted")).catch(() => {})
    } catch {}
  }
  abort.addEventListener("abort", onAbort, { once: true })
  try {
    while (true) {
      const { done: finished, value } = await reader.read()
      if (finished) break
      if (!value) continue
      lastChunkAt = Date.now()
      received += value.byteLength
      if (maxBytes !== undefined && received > maxBytes) {
        throw new Error(`download exceeded max_bytes (${maxBytes}); aborting`)
      }
      hasher?.update(value)
      await fh.write(value)
      onProgress(received)
    }
  } finally {
    clearInterval(inactivityTimer)
    abort.removeEventListener("abort", onAbort)
    await fh.close().catch(() => undefined)
  }
  return { received }
}

export const DownloadTool = Tool.define(
  "download",
  Effect.succeed({
    description: DESCRIPTION,
    parameters: Parameters,
    execute: (params: Params, ctx: Tool.Context<Metadata>) =>
      Effect.gen(function* () {
        if (!isHttpUrl(params.url)) {
          throw new Error(`download: url must start with http:// or https://, got ${params.url}`)
        }

        const target = path.isAbsolute(params.dest) ? params.dest : path.resolve(Instance.directory, params.dest)
        const ifExists: IfExists = params.if_exists ?? "overwrite"
        const timeoutMs = params.timeout_ms ?? DEFAULT_TIMEOUT_MS
        const expected = params.expected_sha256 ? normalizeHex(params.expected_sha256) : undefined

        yield* ctx.ask({
          permission: "write",
          patterns: [target],
          always: ["*"],
          metadata: { url: params.url, dest: target },
        })

        const existing = yield* Effect.promise(() => fileExists(target))
        if (existing.exists) {
          if (ifExists === "skip") {
            return done({
              title: `download skipped (exists ${fmtBytes(existing.size)})`,
              metadata: {
                url: params.url,
                dest: target,
                bytes_received: existing.size,
                bytes_total: existing.size,
                percent: 100,
                elapsed_ms: 0,
                if_exists: "skip",
                skipped: true,
              },
              output: `Skipped download because ${target} already exists (${fmtBytes(existing.size)}). Pass if_exists='overwrite' to redownload.`,
            })
          }
          if (ifExists === "fail") {
            throw new Error(`download: dest already exists and if_exists='fail': ${target}`)
          }
        }

        // Ensure parent dir exists.
        yield* Effect.promise(() => mkdir(path.dirname(target), { recursive: true }).catch(() => undefined))

        yield* ctx.metadata({
          title: `download ${path.basename(target)} starting`,
          metadata: {
            url: params.url,
            dest: target,
            bytes_received: 0,
            elapsed_ms: 0,
            if_exists: ifExists,
            expected_sha256: expected,
          },
        })

        // Wire fetch with combined abort signal + connection timeout.
        const ac = new AbortController()
        const cleanupAbort = () => ac.abort()
        ctx.abort.addEventListener("abort", cleanupAbort, { once: true })
        const connectTimer = setTimeout(
          () => ac.abort(new Error(`download connection timeout after ${timeoutMs}ms`)),
          timeoutMs,
        )

        const start = Date.now()
        let res: Response
        try {
          res = yield* Effect.promise(() =>
            fetch(params.url, {
              method: "GET",
              redirect: "follow",
              signal: ac.signal,
              headers: params.headers,
            }),
          )
        } finally {
          clearTimeout(connectTimer)
        }

        const contentType = res.headers.get("content-type") ?? undefined
        const totalHeader = res.headers.get("content-length")
        const totalHint = totalHeader ? Number(totalHeader) : undefined

        if (!res.ok) {
          ctx.abort.removeEventListener("abort", cleanupAbort)
          throw new Error(
            `download: ${res.status} ${res.statusText} fetching ${params.url}` +
              (contentType ? ` (content-type: ${contentType})` : ""),
          )
        }

        if (params.expected_size_bytes !== undefined && totalHint !== undefined && totalHint !== params.expected_size_bytes) {
          ctx.abort.removeEventListener("abort", cleanupAbort)
          throw new Error(
            `download: server reported Content-Length=${totalHint} but expected_size_bytes=${params.expected_size_bytes}; refusing to write`,
          )
        }

        if (!res.body) {
          ctx.abort.removeEventListener("abort", cleanupAbort)
          throw new Error(`download: response has no body for ${params.url}`)
        }

        const hasher = expected !== undefined ? createHash("sha256") : undefined

        let lastReport = start
        let aborted = false
        let received = 0
        try {
          const result = yield* Effect.promise(() =>
            streamToFile({
              body: res.body!,
              dest: target,
              hasher,
              maxBytes: params.max_bytes,
              abort: ctx.abort,
              timeoutMs,
              totalHint,
              onProgress: (n) => {
                received = n
                const now = Date.now()
                if (now - lastReport >= PROGRESS_INTERVAL_MS) {
                  lastReport = now
                  const elapsed = now - start
                  const kbps = elapsed > 0 ? Math.round((n / 1024) / (elapsed / 1000)) : undefined
                  const percent = totalHint ? Math.min(100, Math.round((n * 100) / totalHint)) : undefined
                  const titleSize = totalHint
                    ? `${fmtBytes(n)} / ${fmtBytes(totalHint)}`
                    : fmtBytes(n)
                  const titlePercent = percent !== undefined ? ` (${percent}%)` : ""
                  Effect.runFork(
                    ctx.metadata({
                      title: `download ${path.basename(target)} ${titleSize}${titlePercent}`,
                      metadata: {
                        url: params.url,
                        dest: target,
                        bytes_received: n,
                        bytes_total: totalHint,
                        percent,
                        kbps,
                        elapsed_ms: elapsed,
                        if_exists: ifExists,
                        expected_sha256: expected,
                        content_type: contentType,
                        status_code: res.status,
                      },
                    }),
                  )
                }
              },
            }),
          )
          received = result.received
        } catch (err: unknown) {
          ctx.abort.removeEventListener("abort", cleanupAbort)
          yield* Effect.promise(() => safeUnlink(target))
          if (ctx.abort.aborted) {
            aborted = true
          } else {
            const msg = err instanceof Error ? err.message : String(err)
            throw new Error(`download failed (${received} bytes received): ${msg}`)
          }
        }
        ctx.abort.removeEventListener("abort", cleanupAbort)

        const elapsed = Date.now() - start
        const kbps = elapsed > 0 ? Math.round((received / 1024) / (elapsed / 1000)) : undefined
        const digest = hasher ? hasher.digest("hex") : undefined
        const matches = expected !== undefined && digest !== undefined ? digest === expected : undefined

        if (matches === false) {
          yield* Effect.promise(() => safeUnlink(target))
          throw new Error(
            `download: sha256 mismatch for ${target}\n  computed: ${digest}\n  expected: ${expected}\nFile removed.`,
          )
        }

        if (aborted) {
          return done({
            title: `download cancelled (${fmtBytes(received)})`,
            metadata: {
              url: params.url,
              final_url: res.url,
              dest: target,
              bytes_received: received,
              bytes_total: totalHint,
              elapsed_ms: elapsed,
              if_exists: ifExists,
              status_code: res.status,
              content_type: contentType,
              kbps,
              aborted: true,
              expected_sha256: expected,
            },
            output: `Download cancelled after ${(elapsed / 1000).toFixed(1)}s (${fmtBytes(received)} written then removed).`,
          })
        }

        const percent = totalHint ? Math.min(100, Math.round((received * 100) / totalHint)) : undefined
        const verifiedNote = matches === true ? " (sha256 verified)" : ""
        return done({
          title: `download ${path.basename(target)} ${fmtBytes(received)}${verifiedNote}`,
          metadata: {
            url: params.url,
            final_url: res.url,
            dest: target,
            bytes_received: received,
            bytes_total: totalHint,
            percent,
            kbps,
            elapsed_ms: elapsed,
            sha256: digest,
            expected_sha256: expected,
            matches,
            status_code: res.status,
            content_type: contentType,
            if_exists: ifExists,
          },
          output: [
            `Downloaded ${fmtBytes(received)} to ${target} in ${(elapsed / 1000).toFixed(1)}s`,
            kbps !== undefined ? `(${kbps} KB/s)` : undefined,
            digest ? `\n  sha256: ${digest}${matches === true ? " (verified)" : ""}` : undefined,
            contentType ? `\n  content-type: ${contentType}` : undefined,
            res.url && res.url !== params.url ? `\n  final url: ${res.url}` : undefined,
          ]
            .filter(Boolean)
            .join(" "),
        })
      }),
  }),
)

export const __testing = { isHttpUrl, fmtBytes, normalizeHex }
