import { Effect, Schema } from "effect"
import { spawn } from "node:child_process"
import { Instance } from "../project/instance"
import DESCRIPTION from "./bench.txt"
import * as Tool from "./tool"

const ACTIONS = ["command", "http"] as const
const MAX_RUNS = 1000
const DEFAULT_TIMEOUT_MS = 60_000

export const Parameters = Schema.Struct({
  action: Schema.Literals(ACTIONS).annotate({ description: ACTIONS.join(" | ") }),
  command: Schema.optional(Schema.String).annotate({ description: "Shell command line for `command` action." }),
  url: Schema.optional(Schema.String).annotate({ description: "URL for `http` action." }),
  method: Schema.optional(Schema.String).annotate({ description: "HTTP method (default GET)." }),
  headers: Schema.optional(Schema.Record(Schema.String, Schema.String)).annotate({ description: "HTTP headers." }),
  body: Schema.optional(Schema.String).annotate({ description: "HTTP body (string)." }),
  runs: Schema.optional(Schema.Number).annotate({ description: "Iterations. Default 10. Max 1000." }),
  warmup: Schema.optional(Schema.Number).annotate({ description: "Discarded warm-up iterations. Default 0." }),
  timeout_ms: Schema.optional(Schema.Number).annotate({ description: "Per-iteration timeout. Default 60000." }),
  parallel: Schema.optional(Schema.Number).annotate({ description: "Max concurrent iterations. Default 1." }),
  cwd: Schema.optional(Schema.String).annotate({ description: "Working directory for command." }),
  env: Schema.optional(Schema.Record(Schema.String, Schema.String)).annotate({ description: "Extra env vars." }),
  expected_status: Schema.optional(Schema.Union([Schema.Number, Schema.Array(Schema.Number)])).annotate({
    description: "HTTP status codes treated as success.",
  }),
  fail_fast: Schema.optional(Schema.Boolean).annotate({ description: "Abort after first failed iteration." }),
})

type Params = Schema.Schema.Type<typeof Parameters>

type IterResult = { duration_ms: number; ok: boolean; error?: string }

type Stats = {
  runs: number
  successes: number
  failures: number
  min: number
  max: number
  mean: number
  median: number
  p95: number
  p99: number
  stdev: number
  total: number
  ops_per_sec: number
}

type Metadata = {
  action: (typeof ACTIONS)[number]
  stats?: Stats
  success_stats?: Stats
  iterations?: IterResult[]
}

function statsOf(durations: number[]): Stats {
  if (durations.length === 0) {
    return { runs: 0, successes: 0, failures: 0, min: 0, max: 0, mean: 0, median: 0, p95: 0, p99: 0, stdev: 0, total: 0, ops_per_sec: 0 }
  }
  const sorted = [...durations].sort((a, b) => a - b)
  const total = sorted.reduce((a, b) => a + b, 0)
  const mean = total / sorted.length
  const variance = sorted.reduce((acc, d) => acc + (d - mean) ** 2, 0) / sorted.length
  const stdev = Math.sqrt(variance)
  const pct = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0
  const median =
    sorted.length % 2
      ? sorted[(sorted.length - 1) / 2]!
      : (sorted[sorted.length / 2 - 1]! + sorted[sorted.length / 2]!) / 2
  return {
    runs: sorted.length,
    successes: sorted.length,
    failures: 0,
    min: sorted[0]!,
    max: sorted[sorted.length - 1]!,
    mean,
    median,
    p95: pct(0.95),
    p99: pct(0.99),
    stdev,
    total,
    ops_per_sec: total > 0 ? (sorted.length * 1000) / total : 0,
  }
}

function runCommandOnce(cmd: string, opts: {
  timeoutMs: number
  cwd: string
  env: NodeJS.ProcessEnv
  signal: AbortSignal
}): Promise<IterResult> {
  return new Promise((resolve) => {
    const isWin = process.platform === "win32"
    const shell = isWin ? "cmd.exe" : "/bin/sh"
    const args = isWin ? ["/c", cmd] : ["-c", cmd]
    const start = performance.now()
    const child = spawn(shell, args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ["ignore", "ignore", "pipe"],
    })
    let stderr = ""
    child.stderr?.on("data", (d) => {
      stderr += d.toString()
      if (stderr.length > 4096) stderr = stderr.slice(-4096)
    })
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
    }, opts.timeoutMs)
    const onAbort = () => child.kill("SIGKILL")
    if (opts.signal.aborted) child.kill("SIGKILL")
    else opts.signal.addEventListener("abort", onAbort, { once: true })
    child.on("close", (code) => {
      clearTimeout(timer)
      opts.signal.removeEventListener("abort", onAbort)
      const duration_ms = performance.now() - start
      if (code === 0) resolve({ duration_ms, ok: true })
      else resolve({ duration_ms, ok: false, error: `exit ${code}${stderr ? `: ${stderr.trim().slice(0, 200)}` : ""}` })
    })
    child.on("error", (e) => {
      clearTimeout(timer)
      opts.signal.removeEventListener("abort", onAbort)
      resolve({ duration_ms: performance.now() - start, ok: false, error: e.message })
    })
  })
}

async function runHttpOnce(opts: {
  url: string
  method: string
  headers: Record<string, string>
  body?: string
  timeoutMs: number
  expected: Set<number>
  signal: AbortSignal
}): Promise<IterResult> {
  const start = performance.now()
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs)
  const linkAbort = () => ctrl.abort()
  if (opts.signal.aborted) ctrl.abort()
  else opts.signal.addEventListener("abort", linkAbort, { once: true })
  try {
    const res = await fetch(opts.url, {
      method: opts.method,
      headers: opts.headers,
      body: opts.body,
      signal: ctrl.signal,
    } as any)
    // Drain body to count proper TTFB+download
    await res.arrayBuffer()
    const duration_ms = performance.now() - start
    if (opts.expected.has(res.status)) return { duration_ms, ok: true }
    return { duration_ms, ok: false, error: `status ${res.status}` }
  } catch (e: any) {
    return { duration_ms: performance.now() - start, ok: false, error: e?.message ?? String(e) }
  } finally {
    clearTimeout(timer)
    opts.signal.removeEventListener("abort", linkAbort)
  }
}

function pool<T>(items: T[], concurrency: number, runner: (item: T) => Promise<IterResult>, abort: AbortSignal, failFast: boolean): Promise<IterResult[]> {
  return new Promise((resolve) => {
    const results: IterResult[] = new Array(items.length)
    let next = 0
    let active = 0
    let stopped = false
    const launch = () => {
      while (!stopped && active < concurrency && next < items.length) {
        if (abort.aborted) {
          stopped = true
          break
        }
        const idx = next++
        active++
        runner(items[idx]!).then((r) => {
          results[idx] = r
          active--
          if (failFast && !r.ok) stopped = true
          if (stopped && active === 0) {
            // fill any unfilled slots with synthetic abort entries
            for (let i = 0; i < results.length; i++) {
              if (!results[i]) results[i] = { duration_ms: 0, ok: false, error: "aborted" }
            }
            resolve(results)
            return
          }
          if (next >= items.length && active === 0) {
            resolve(results)
            return
          }
          launch()
        })
      }
    }
    launch()
  })
}

const done = (result: Tool.ExecuteResult<Metadata>) => result

export const BenchTool = Tool.define(
  "bench",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Params, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const action = params.action
          const runs = Math.min(MAX_RUNS, Math.max(1, params.runs ?? 10))
          const warmup = Math.max(0, params.warmup ?? 0)
          const parallel = Math.max(1, params.parallel ?? 1)
          const timeoutMs = Math.max(1, params.timeout_ms ?? DEFAULT_TIMEOUT_MS)
          const failFast = params.fail_fast === true

          let runner: (idx: number) => Promise<IterResult>
          if (action === "command") {
            if (!params.command) throw new Error("bench.command: requires `command`")
            const cwd = params.cwd ?? Instance.directory
            const env = { ...process.env, ...(params.env ?? {}) } as NodeJS.ProcessEnv
            runner = (_idx: number) =>
              runCommandOnce(params.command!, {
                timeoutMs,
                cwd,
                env,
                signal: ctx.abort,
              })
          } else if (action === "http") {
            if (!params.url) throw new Error("bench.http: requires `url`")
            const expected = new Set<number>()
            if (params.expected_status === undefined) {
              for (let i = 200; i < 300; i++) expected.add(i)
            } else if (typeof params.expected_status === "number") {
              expected.add(params.expected_status)
            } else {
              for (const s of params.expected_status) expected.add(s)
            }
            runner = (_idx: number) =>
              runHttpOnce({
                url: params.url!,
                method: (params.method ?? "GET").toUpperCase(),
                headers: params.headers ?? {},
                body: params.body,
                timeoutMs,
                expected,
                signal: ctx.abort,
              })
          } else {
            throw new Error(`bench: unknown action '${action}'`)
          }

          // Warmup (results discarded)
          if (warmup > 0) {
            const warmIdx = Array.from({ length: warmup }, (_, i) => i)
            yield* Effect.promise(() => pool(warmIdx, parallel, (i) => runner(i), ctx.abort, false))
          }

          const idx = Array.from({ length: runs }, (_, i) => i)
          const results = yield* Effect.promise(() => pool(idx, parallel, (i) => runner(i), ctx.abort, failFast))
          const successes = results.filter((r) => r.ok)
          const allDurations = results.map((r) => r.duration_ms)
          const overall = statsOf(allDurations)
          overall.successes = successes.length
          overall.failures = results.length - successes.length
          const successOnly = statsOf(successes.map((r) => r.duration_ms))

          const stats = overall
          const out: string[] = []
          out.push(`bench.${action}: ${runs} runs, ${stats.successes}/${stats.runs} successful`)
          out.push(`min     ${stats.min.toFixed(2)} ms`)
          out.push(`max     ${stats.max.toFixed(2)} ms`)
          out.push(`mean    ${stats.mean.toFixed(2)} ms`)
          out.push(`median  ${stats.median.toFixed(2)} ms`)
          out.push(`p95     ${stats.p95.toFixed(2)} ms`)
          out.push(`p99     ${stats.p99.toFixed(2)} ms`)
          out.push(`stdev   ${stats.stdev.toFixed(2)} ms`)
          out.push(`total   ${stats.total.toFixed(2)} ms`)
          out.push(`ops/s   ${stats.ops_per_sec.toFixed(2)}`)
          if (stats.failures > 0) {
            out.push("")
            out.push("first failures:")
            for (const r of results.filter((r) => !r.ok).slice(0, 5)) {
              out.push(`  - ${r.error ?? "?"} (${r.duration_ms.toFixed(2)} ms)`)
            }
          }

          return done({
            title: `bench.${action}: median ${stats.median.toFixed(2)} ms (n=${stats.runs})`,
            metadata: {
              action,
              stats,
              success_stats: successOnly,
              iterations: results,
            },
            output: out.join("\n"),
          })
        }),
    }
  }),
)

export const __testing = {
  statsOf,
  runCommandOnce,
  runHttpOnce,
  pool,
}
