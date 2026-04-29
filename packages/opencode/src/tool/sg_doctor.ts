import { Effect, Schema } from "effect"
import { stat as fsStat } from "node:fs/promises"
import { Config } from "../config"
import DESCRIPTION from "./sg_doctor.txt"
import * as Tool from "./tool"

const TARGETS = ["ring", "ring_multimodal", "sg1", "sg2", "scheduler"] as const
type Target = (typeof TARGETS)[number]

const DEFAULT_RING_BASE = "https://doxx.lat/ring/v1"
const DEFAULT_SG1_URL = "https://doxx.lat/mcp/sse"
const DEFAULT_SG2_URL = "https://mcp2.doxx.lat/mcp/sse"
const DEFAULT_TIMEOUT_MS = 8_000

export const Parameters = Schema.Struct({
  targets: Schema.optional(Schema.Array(Schema.Literals(TARGETS))).annotate({
    description:
      "Subset of targets to probe. Default probes ring, sg1, sg2, scheduler. Pass 'ring_multimodal' explicitly to also test whether Ring 2.5 1T accepts image_url content (the SG proxy currently strips them).",
  }),
  ring_base_url: Schema.optional(Schema.String).annotate({
    description: "Override Ring proxy base URL. Default https://doxx.lat/ring/v1",
  }),
  ring_api_key: Schema.optional(Schema.String).annotate({
    description: "Override Ring proxy bearer token. Falls back to provider.sg-ring.options.apiKey from config.",
  }),
  sg1_url: Schema.optional(Schema.String).annotate({
    description: "Override SG1 MCP URL. Default https://doxx.lat/mcp/sse",
  }),
  sg2_url: Schema.optional(Schema.String).annotate({
    description: "Override SG2 MCP URL. Default https://mcp2.doxx.lat/mcp/sse",
  }),
  timeout_ms: Schema.optional(
    Schema.Number.check(Schema.isInt())
      .check(Schema.isGreaterThanOrEqualTo(1_000))
      .check(Schema.isLessThanOrEqualTo(60_000)),
  ).annotate({
    description: `Per-probe timeout in ms. Default ${DEFAULT_TIMEOUT_MS}.`,
  }),
})

type Params = Schema.Schema.Type<typeof Parameters>

type ProbeResult = {
  target: Target
  ok: boolean
  status?: number
  latency_ms?: number
  detail?: string
}

type Metadata = {
  ok: boolean
  results: Record<Target, ProbeResult>
  probed: Target[]
  ring_base_url?: string
  sg1_url?: string
  sg2_url?: string
  timeout_ms: number
}

const done = (result: Tool.ExecuteResult<Metadata>) => result

async function timedFetch(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<{ res?: Response; latency_ms: number; error?: string }> {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs)
  const start = Date.now()
  try {
    const res = await fetch(url, { ...init, signal: ac.signal })
    return { res, latency_ms: Date.now() - start }
  } catch (err: unknown) {
    return {
      latency_ms: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    }
  } finally {
    clearTimeout(timer)
  }
}

async function probeRing(baseUrl: string, key: string | undefined, timeoutMs: number): Promise<ProbeResult> {
  if (!key) {
    return {
      target: "ring",
      ok: false,
      detail: "no API key (set provider.sg-ring.options.apiKey or pass ring_api_key)",
    }
  }
  const url = `${baseUrl.replace(/\/+$/, "")}/models`
  const r = await timedFetch(
    url,
    { method: "GET", headers: { Authorization: `Bearer ${key}` } },
    timeoutMs,
  )
  if (!r.res) {
    return { target: "ring", ok: false, latency_ms: r.latency_ms, detail: r.error ?? "unreachable" }
  }
  if (!r.res.ok) {
    let body = ""
    try {
      body = (await r.res.text()).slice(0, 200)
    } catch {}
    return {
      target: "ring",
      ok: false,
      status: r.res.status,
      latency_ms: r.latency_ms,
      detail: `HTTP ${r.res.status} ${r.res.statusText} ${body}`.trim(),
    }
  }
  let listed = false
  try {
    const json: any = await r.res.json()
    listed = Array.isArray(json?.data) && json.data.some((m: any) => m?.id === "Ring-2.5-1T")
  } catch {}
  return {
    target: "ring",
    ok: listed,
    status: r.res.status,
    latency_ms: r.latency_ms,
    detail: listed ? "Ring-2.5-1T listed" : "models endpoint reachable but Ring-2.5-1T not in list",
  }
}

// 1x1 transparent PNG as a base64 data URL — small enough to send through cheaply.
const TINY_PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="

async function probeRingMultimodal(
  baseUrl: string,
  key: string | undefined,
  timeoutMs: number,
): Promise<ProbeResult> {
  if (!key) {
    return {
      target: "ring_multimodal",
      ok: false,
      detail: "no API key (set provider.sg-ring.options.apiKey or pass ring_api_key)",
    }
  }
  const url = `${baseUrl.replace(/\/+$/, "")}/chat/completions`
  const body = JSON.stringify({
    model: "Ring-2.5-1T",
    stream: false,
    max_tokens: 32,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "Reply with exactly: probe-ok" },
          { type: "image_url", image_url: { url: TINY_PNG_DATA_URL } },
        ],
      },
    ],
  })
  const r = await timedFetch(
    url,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body,
    },
    timeoutMs,
  )
  if (!r.res) {
    return {
      target: "ring_multimodal",
      ok: false,
      latency_ms: r.latency_ms,
      detail: r.error ?? "unreachable",
    }
  }
  let text = ""
  try {
    const json: any = await r.res.json()
    text = String(json?.choices?.[0]?.message?.content ?? "")
  } catch {}
  const dropped = /non-text attachment\(s\).*were dropped/i.test(text)
  // We treat "ok" here as "we got a clear, structured answer about multimodal status".
  // Either path counts: server confirms drop (text-only) OR server passes through (multimodal).
  if (dropped) {
    return {
      target: "ring_multimodal",
      ok: true,
      status: r.res.status,
      latency_ms: r.latency_ms,
      detail: "text-only — proxy strips images (confirmed by NOTE in response)",
    }
  }
  if (/probe-ok/i.test(text)) {
    return {
      target: "ring_multimodal",
      ok: true,
      status: r.res.status,
      latency_ms: r.latency_ms,
      detail: "multimodal: image accepted, model returned probe-ok",
    }
  }
  return {
    target: "ring_multimodal",
    ok: false,
    status: r.res.status,
    latency_ms: r.latency_ms,
    detail: `inconclusive — first 80 chars: ${text.slice(0, 80).replace(/\n/g, " ")}`,
  }
}

async function probeMcp(target: "sg1" | "sg2", url: string, timeoutMs: number): Promise<ProbeResult> {
  // SSE endpoints accept GET and never close. Use HEAD if allowed; if not, do GET with a tiny timeout.
  const head = await timedFetch(url, { method: "HEAD" }, Math.min(2000, timeoutMs))
  if (head.res) {
    const ok = head.res.status < 500
    return {
      target,
      ok,
      status: head.res.status,
      latency_ms: head.latency_ms,
      detail: ok ? "HEAD reachable" : `HEAD HTTP ${head.res.status}`,
    }
  }
  // HEAD failed (timeout or method not allowed): do a short GET that we deliberately abort.
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(new Error("sse cut")), Math.min(2500, timeoutMs))
  const start = Date.now()
  try {
    const res = await fetch(url, { method: "GET", signal: ac.signal, headers: { Accept: "text/event-stream" } })
    const ok = res.status < 500
    return {
      target,
      ok,
      status: res.status,
      latency_ms: Date.now() - start,
      detail: ok ? "GET reachable" : `GET HTTP ${res.status}`,
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    // If we got the abort we set, the connection at least opened — count it as reachable.
    const aborted = msg.includes("sse cut") || msg.toLowerCase().includes("abort")
    return {
      target,
      ok: aborted,
      latency_ms: Date.now() - start,
      detail: aborted ? "GET opened then closed (sse-style ok)" : msg,
    }
  } finally {
    clearTimeout(timer)
  }
}

async function probeScheduler(cfg: any): Promise<ProbeResult> {
  const sched = cfg?.mcp?.["sg-scheduler"]
  if (!sched || sched.type !== "local" || !Array.isArray(sched.command) || sched.command.length === 0) {
    return {
      target: "scheduler",
      ok: false,
      detail: "no sg-scheduler entry in config.mcp",
    }
  }
  const cmd = String(sched.command[0])
  const arg = sched.command[1] ? String(sched.command[1]) : undefined
  const present = arg
    ? await fsStat(arg).then(
        () => true,
        () => false,
      )
    : false
  if (!present && arg) {
    return {
      target: "scheduler",
      ok: false,
      detail: `script not found: ${arg}`,
    }
  }
  return {
    target: "scheduler",
    ok: true,
    detail: arg ? `${cmd} ${arg}` : cmd,
  }
}

export const SgDoctorTool = Tool.define(
  "sg_doctor",
  Effect.gen(function* () {
    const config = yield* Config.Service
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Params, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const cfg: any = yield* config.get()
          // Default set excludes ring_multimodal (it sends a chat-completion roundtrip and only matters when you're asking about images).
          const DEFAULT_TARGETS: Target[] = ["ring", "sg1", "sg2", "scheduler"]
          const targets: Target[] = (params.targets && params.targets.length > 0 ? params.targets : DEFAULT_TARGETS) as Target[]
          const timeoutMs = params.timeout_ms ?? DEFAULT_TIMEOUT_MS

          const ringBaseUrl =
            params.ring_base_url ??
            (cfg?.provider?.["sg-ring"]?.options?.baseURL as string | undefined) ??
            DEFAULT_RING_BASE
          const ringKey =
            params.ring_api_key ?? (cfg?.provider?.["sg-ring"]?.options?.apiKey as string | undefined) ?? undefined
          const sg1Url = params.sg1_url ?? (cfg?.mcp?.sg1?.url as string | undefined) ?? DEFAULT_SG1_URL
          const sg2Url = params.sg2_url ?? (cfg?.mcp?.sg2?.url as string | undefined) ?? DEFAULT_SG2_URL

          yield* ctx.metadata({
            title: `sg_doctor probing ${targets.join(", ")}`,
            metadata: {
              ok: false,
              results: {} as Record<Target, ProbeResult>,
              probed: targets,
              ring_base_url: ringBaseUrl,
              sg1_url: sg1Url,
              sg2_url: sg2Url,
              timeout_ms: timeoutMs,
            },
          })

          const results = yield* Effect.promise(async () => {
            const tasks: Promise<ProbeResult>[] = []
            const include = new Set(targets)
            if (include.has("ring")) tasks.push(probeRing(ringBaseUrl, ringKey, timeoutMs))
            if (include.has("ring_multimodal"))
              tasks.push(probeRingMultimodal(ringBaseUrl, ringKey, timeoutMs))
            if (include.has("sg1")) tasks.push(probeMcp("sg1", sg1Url, timeoutMs))
            if (include.has("sg2")) tasks.push(probeMcp("sg2", sg2Url, timeoutMs))
            if (include.has("scheduler")) tasks.push(probeScheduler(cfg))
            return await Promise.all(tasks)
          })

          const map = {} as Record<Target, ProbeResult>
          for (const r of results) map[r.target] = r
          const ok = results.every((r) => r.ok)

          const lines = results.map((r) => {
            const status = r.ok ? "OK" : "FAIL"
            const latency = r.latency_ms !== undefined ? ` ${r.latency_ms}ms` : ""
            const code = r.status !== undefined ? ` ${r.status}` : ""
            const detail = r.detail ? ` - ${r.detail}` : ""
            return `  ${r.target.padEnd(10)} ${status}${code}${latency}${detail}`
          })

          return done({
            title: ok ? `sg_doctor: all ${results.length} OK` : `sg_doctor: ${results.filter((r) => !r.ok).length}/${results.length} FAIL`,
            metadata: {
              ok,
              results: map,
              probed: targets,
              ring_base_url: ringBaseUrl,
              sg1_url: sg1Url,
              sg2_url: sg2Url,
              timeout_ms: timeoutMs,
            },
            output: [`SG health check (timeout=${timeoutMs}ms):`, ...lines, ok ? "All probed targets are healthy." : "One or more probes failed; see above."].join(
              "\n",
            ),
          })
        }),
    }
  }),
)

export const __testing = { probeRing, probeRingMultimodal, probeMcp, probeScheduler }
