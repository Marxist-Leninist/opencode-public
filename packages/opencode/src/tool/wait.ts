import path from "path"
import { Duration, Effect, Schema } from "effect"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { InstanceState } from "@/effect"
import DESCRIPTION from "./wait.txt"
import * as Tool from "./tool"

const MAX_SECONDS = 3600
const DEFAULT_POLL_INTERVAL_MS = 5_000
const MIN_POLL_INTERVAL_MS = 100
const MAX_POLL_INTERVAL_MS = 60_000
const DEFAULT_STABLE_REQUIRED_MS = 10_000
const MAX_STABLE_REQUIRED_MS = 600_000

export const Parameters = Schema.Struct({
  seconds: Schema.Number.check(Schema.isInt())
    .check(Schema.isGreaterThanOrEqualTo(1))
    .check(Schema.isLessThanOrEqualTo(MAX_SECONDS))
    .annotate({
      description: `Maximum number of seconds to wait before continuing in this same chat. Range 1-${MAX_SECONDS} (1 hour cap).`,
    }),
  reason: Schema.String.annotate({
    description: "Short reason shown to the user in the UI explaining why the agent is paused.",
  }),
  until_file: Schema.optional(Schema.String).annotate({
    description:
      "Optional file path. If provided, poll this file and return early once its size has been stable for stable_ms. Relative paths resolve from the current project directory.",
  }),
  min_size_bytes: Schema.optional(Schema.Number.check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(0))).annotate(
    {
      description:
        "Optional. Used only with until_file. The file must reach at least this many bytes before the stable-size check can succeed.",
    },
  ),
  poll_interval_ms: Schema.optional(
    Schema.Number.check(Schema.isInt())
      .check(Schema.isGreaterThanOrEqualTo(MIN_POLL_INTERVAL_MS))
      .check(Schema.isLessThanOrEqualTo(MAX_POLL_INTERVAL_MS)),
  ).annotate({
    description: `Optional polling interval in milliseconds for until_file and cancel_if_file checks. Range ${MIN_POLL_INTERVAL_MS}-${MAX_POLL_INTERVAL_MS}. Default ${DEFAULT_POLL_INTERVAL_MS}.`,
  }),
  stable_ms: Schema.optional(
    Schema.Number.check(Schema.isInt())
      .check(Schema.isGreaterThanOrEqualTo(0))
      .check(Schema.isLessThanOrEqualTo(MAX_STABLE_REQUIRED_MS)),
  ).annotate({
    description: `Optional stable-size window in milliseconds for until_file. Default ${DEFAULT_STABLE_REQUIRED_MS}. Use 0 to return as soon as the file exists and meets min_size_bytes.`,
  }),
  cancel_if_file: Schema.optional(Schema.String).annotate({
    description:
      "Optional sentinel file path. If this file appears while waiting, return early with cancelled_by_file=true instead of waiting for the timeout. Relative paths resolve from the current project directory.",
  }),
})

type Params = Schema.Schema.Type<typeof Parameters>

type Metadata = {
  mode: "fixed" | "until_file"
  seconds: number
  reason: string
  elapsed_seconds?: number
  remaining_seconds?: number
  aborted?: boolean
  target?: string
  min_size_bytes?: number
  poll_interval_ms?: number
  stable_ms?: number
  size_bytes?: number
  polls?: number
  ready?: boolean
  timed_out?: boolean
  reached_min_size?: boolean
  cancel_if_file?: string
  cancelled_by_file?: boolean
}

const abortable = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  signal: AbortSignal,
): Effect.Effect<A | "__aborted__", E, R> =>
  Effect.race(
    effect,
    Effect.callback<"__aborted__">((resume) => {
      if (signal.aborted) {
        resume(Effect.succeed("__aborted__"))
        return
      }
      const handler = () => resume(Effect.succeed("__aborted__"))
      signal.addEventListener("abort", handler, { once: true })
      return Effect.sync(() => signal.removeEventListener("abort", handler))
    }),
  )

const mb = (bytes: number) => (bytes / 1024 / 1024).toFixed(1)
const done = (result: Tool.ExecuteResult<Metadata>) => result
const sleepMs = (ms: number) => Effect.sleep(Duration.millis(Math.max(0, ms)))

export const WaitTool = Tool.define(
  "wait",
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Params, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const ins = yield* InstanceState.context
          const start = Date.now()
          const deadline = start + params.seconds * 1000
          const pollIntervalMs = params.poll_interval_ms ?? DEFAULT_POLL_INTERVAL_MS
          const stableRequiredMs = params.stable_ms ?? DEFAULT_STABLE_REQUIRED_MS
          const cancelTarget = params.cancel_if_file
            ? path.isAbsolute(params.cancel_if_file)
              ? params.cancel_if_file
              : path.resolve(ins.directory, params.cancel_if_file)
            : undefined

          const checkCancel = () =>
            cancelTarget
              ? fs.stat(cancelTarget).pipe(
                  Effect.map(() => true),
                  Effect.catch(() => Effect.succeed(false)),
                )
              : Effect.succeed(false)

          if (!params.until_file) {
            yield* ctx.metadata({
              title: `wait ${params.seconds}s - ${params.reason}`,
              metadata: {
                mode: "fixed",
                seconds: params.seconds,
                reason: params.reason,
                poll_interval_ms: pollIntervalMs,
                cancel_if_file: cancelTarget,
              },
            })

            let aborted = false
            let cancelledByFile = false
            let pollCount = 0
            let lastTitleUpdate = start

            while (Date.now() < deadline) {
              if (yield* checkCancel()) {
                cancelledByFile = true
                break
              }

              const remaining = deadline - Date.now()
              if (remaining <= 0) break

              const result = yield* abortable(sleepMs(Math.min(pollIntervalMs, 1000, remaining)), ctx.abort)
              if (result === "__aborted__") {
                aborted = true
                break
              }
              pollCount++

              const now = Date.now()
              if (now - lastTitleUpdate >= 1000 && now < deadline) {
                lastTitleUpdate = now
                const left = Math.max(0, Math.ceil((deadline - now) / 1000))
                yield* ctx.metadata({
                  title: `wait ${left}s left - ${params.reason}`,
                  metadata: {
                    mode: "fixed",
                    seconds: params.seconds,
                    reason: params.reason,
                    elapsed_seconds: (now - start) / 1000,
                    remaining_seconds: left,
                    polls: pollCount,
                    poll_interval_ms: pollIntervalMs,
                    cancel_if_file: cancelTarget,
                  },
                })
              }
            }

            const elapsed = (Date.now() - start) / 1000
            return done({
              title: cancelledByFile
                ? `wait cancelled by file after ${elapsed.toFixed(1)}s`
                : aborted
                  ? `wait cancelled after ${elapsed.toFixed(1)}s`
                  : `waited ${elapsed.toFixed(1)}s`,
              metadata: {
                mode: "fixed",
                seconds: params.seconds,
                elapsed_seconds: elapsed,
                reason: params.reason,
                aborted,
                polls: pollCount,
                poll_interval_ms: pollIntervalMs,
                cancel_if_file: cancelTarget,
                cancelled_by_file: cancelledByFile,
              },
              output: cancelledByFile
                ? `Wait cancelled after ${elapsed.toFixed(1)}s because sentinel file exists: ${cancelTarget}. Reason: ${params.reason}`
                : aborted
                  ? `Wait cancelled after ${elapsed.toFixed(1)}s. Reason: ${params.reason}`
                  : `Waited ${elapsed.toFixed(1)}s. Reason: ${params.reason}`,
            })
          }

          const target = path.isAbsolute(params.until_file)
            ? params.until_file
            : path.resolve(ins.directory, params.until_file)

          yield* ctx.metadata({
            title: `wait up to ${params.seconds}s for ${path.basename(target)}`,
            metadata: {
              mode: "until_file",
              target,
              seconds: params.seconds,
              reason: params.reason,
              min_size_bytes: params.min_size_bytes,
              poll_interval_ms: pollIntervalMs,
              stable_ms: stableRequiredMs,
              cancel_if_file: cancelTarget,
            },
          })

          let lastSize = -1
          let lastChanged = Date.now()
          let pollCount = 0
          let aborted = false
          let cancelledByFile = false
          let lastTitleSize = -1

          while (Date.now() < deadline) {
            if (yield* checkCancel()) {
              cancelledByFile = true
              break
            }
            pollCount++

            const info = yield* fs.stat(target).pipe(Effect.catch(() => Effect.succeed(undefined)))
            if (info && info.type === "File") {
              const size = Number(info.size ?? 0)

              // Refresh progress when the file grows by at least 1 MB.
              const sizeDeltaMb = lastTitleSize < 0 ? Infinity : Math.abs(size - lastTitleSize) / 1024 / 1024
              if (sizeDeltaMb >= 1) {
                lastTitleSize = size
                const elapsedNow = (Date.now() - start) / 1000
                const targetSuffix = params.min_size_bytes ? ` / ${mb(params.min_size_bytes)} MB` : ""
                yield* ctx.metadata({
                  title: `${path.basename(target)} ${mb(size)} MB${targetSuffix} (${elapsedNow.toFixed(0)}s)`,
                  metadata: {
                    mode: "until_file",
                    target,
                    seconds: params.seconds,
                    elapsed_seconds: elapsedNow,
                    size_bytes: size,
                    polls: pollCount,
                    reason: params.reason,
                    poll_interval_ms: pollIntervalMs,
                    stable_ms: stableRequiredMs,
                    min_size_bytes: params.min_size_bytes,
                    cancel_if_file: cancelTarget,
                  },
                })
              }

              if (size !== lastSize) {
                lastSize = size
                lastChanged = Date.now()
              }

              const stableFor = Date.now() - lastChanged
              const meetsSize = params.min_size_bytes === undefined || size >= params.min_size_bytes
              if (stableFor >= stableRequiredMs && meetsSize) {
                const elapsed = (Date.now() - start) / 1000
                return done({
                  title: `${path.basename(target)} ready (${mb(size)} MB)`,
                  metadata: {
                    mode: "until_file",
                    target,
                    seconds: params.seconds,
                    elapsed_seconds: elapsed,
                    size_bytes: size,
                    polls: pollCount,
                    reason: params.reason,
                    ready: true,
                    poll_interval_ms: pollIntervalMs,
                    stable_ms: stableRequiredMs,
                    min_size_bytes: params.min_size_bytes,
                    cancel_if_file: cancelTarget,
                  },
                  output: `File ready after ${elapsed.toFixed(1)}s: ${target} (${mb(size)} MB, stable ${(stableFor / 1000).toFixed(0)}s). Reason: ${params.reason}`,
                })
              }
            }

            const remaining = deadline - Date.now()
            if (remaining <= 0) break

            const tick = yield* abortable(sleepMs(Math.min(pollIntervalMs, remaining)), ctx.abort)
            if (tick === "__aborted__") {
              aborted = true
              break
            }
          }

          const elapsed = (Date.now() - start) / 1000
          const lastInfo = yield* fs.stat(target).pipe(Effect.catch(() => Effect.succeed(undefined)))
          const sizeNow = lastInfo && lastInfo.type === "File" ? Number(lastInfo.size ?? 0) : 0
          const reachedMin = params.min_size_bytes === undefined || sizeNow >= params.min_size_bytes
          return done({
            title: cancelledByFile
              ? `wait cancelled by file after ${elapsed.toFixed(1)}s`
              : aborted
                ? `wait cancelled after ${elapsed.toFixed(1)}s`
                : `wait timed out after ${elapsed.toFixed(1)}s`,
            metadata: {
              mode: "until_file",
              target,
              seconds: params.seconds,
              elapsed_seconds: elapsed,
              size_bytes: sizeNow,
              polls: pollCount,
              reason: params.reason,
              timed_out: !aborted && !cancelledByFile,
              aborted,
              reached_min_size: reachedMin,
              poll_interval_ms: pollIntervalMs,
              stable_ms: stableRequiredMs,
              min_size_bytes: params.min_size_bytes,
              cancel_if_file: cancelTarget,
              cancelled_by_file: cancelledByFile,
            },
            output: cancelledByFile
              ? `Wait cancelled after ${elapsed.toFixed(1)}s because sentinel file exists: ${cancelTarget}. Last size: ${mb(sizeNow)} MB. Reason: ${params.reason}`
              : aborted
                ? `Wait cancelled after ${elapsed.toFixed(1)}s. Last size: ${mb(sizeNow)} MB. Reason: ${params.reason}`
                : `Timed out after ${elapsed.toFixed(1)}s waiting for ${target}. Last observed size: ${mb(sizeNow)} MB${params.min_size_bytes ? ` (min required: ${mb(params.min_size_bytes)} MB, reached: ${reachedMin})` : ""}. Reason: ${params.reason}`,
          })
        }),
    }
  }),
)
