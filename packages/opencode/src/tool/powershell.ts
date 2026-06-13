import { Effect, Schema } from "effect"
import { spawn } from "node:child_process"
import * as path from "node:path"
import * as fs from "node:fs"
import { Instance } from "../project/instance"
import { killTree } from "../shell/shell"
import { which } from "@/util/which"
import DESCRIPTION from "./powershell.txt"
import * as Tool from "./tool"

const DEFAULT_TIMEOUT_MS = 60_000
const MAX_TIMEOUT_MS = 600_000
const DEFAULT_OUTPUT_BYTES = 1_048_576 // 1 MB
const MAX_OUTPUT_BYTES = 10_485_760 // 10 MB
const MAX_COMMAND_LENGTH = 524_288 // 512 KB script body cap

const PREFERRED_VALUES = ["auto", "pwsh", "powershell"] as const
type Preferred = (typeof PREFERRED_VALUES)[number]

const PRELUDE = [
  "$ErrorActionPreference = 'Stop'",
  "$ProgressPreference = 'SilentlyContinue'",
  "$ConfirmPreference = 'None'",
  "[System.Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()",
  "$OutputEncoding = [System.Text.UTF8Encoding]::new()",
].join("; ")

export const Parameters = Schema.Struct({
  command: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(MAX_COMMAND_LENGTH)).annotate({
    description:
      "PowerShell script body. Multi-line input is fine - the whole block runs as one script through stdin. Prefer Verb-Noun cmdlets over external exes when both are available.",
  }),
  description: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(160)).annotate({
    description: "5-15 word summary of what the script does. Surfaced in the chat UI and logs.",
  }),
  workdir: Schema.optional(Schema.String).annotate({
    description:
      "Optional working directory. Absolute preferred; relative paths resolve from the project directory. Defaults to the project directory.",
  }),
  timeout_ms: Schema.optional(
    Schema.Number.check(Schema.isInt())
      .check(Schema.isGreaterThanOrEqualTo(500))
      .check(Schema.isLessThanOrEqualTo(MAX_TIMEOUT_MS)),
  ).annotate({
    description: `Timeout in milliseconds. Default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS} (10 min).`,
  }),
  prefer: Schema.optional(Schema.Literals(PREFERRED_VALUES)).annotate({
    description:
      "Which PowerShell executable to use: 'auto' (default - prefer pwsh, fall back to powershell.exe on Windows), 'pwsh' (PowerShell 7+; cross-platform), or 'powershell' (Windows PowerShell 5.1; Windows only).",
  }),
  max_output_bytes: Schema.optional(
    Schema.Number.check(Schema.isInt())
      .check(Schema.isGreaterThanOrEqualTo(1024))
      .check(Schema.isLessThanOrEqualTo(MAX_OUTPUT_BYTES)),
  ).annotate({
    description: `Per-stream byte cap for stdout/stderr (each). Default ${DEFAULT_OUTPUT_BYTES} (1 MB). When exceeded, the tail of the stream is preserved and a clear marker is added.`,
  }),
  ignore_exit_code: Schema.optional(Schema.Boolean).annotate({
    description:
      "When true, treat any exit code as success (still reported in metadata). Useful for cmdlets where a non-zero exit is informational. Default false.",
  }),
})

type Params = Schema.Schema.Type<typeof Parameters>

type Metadata = {
  executable: string
  preferred: Preferred
  exit_code: number | null
  signal: string | null
  timed_out: boolean
  aborted: boolean
  workdir: string
  duration_ms: number
  stdout_bytes: number
  stderr_bytes: number
  stdout_truncated: boolean
  stderr_truncated: boolean
  ok: boolean
  ignore_exit_code: boolean
}

const done = (result: Tool.ExecuteResult<Metadata>) => result

// Known full-path install locations, checked before falling back to PATH lookup.
const PWSH_CANDIDATES =
  process.platform === "win32"
    ? [
        path.join(process.env.LOCALAPPDATA ?? "", "Programs", "PowerShell", "7", "pwsh.exe"),
        path.join(process.env.ProgramFiles ?? "", "PowerShell", "7", "pwsh.exe"),
        path.join(process.env["ProgramFiles(x86)"] ?? "", "PowerShell", "7", "pwsh.exe"),
      ]
    : []

const POWERSHELL_CANDIDATES =
  process.platform === "win32"
    ? [path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe")]
    : []

function firstExisting(paths: Array<string | undefined>): string | undefined {
  for (const p of paths) {
    if (p && fs.existsSync(p)) return p
  }
  return undefined
}

function findPwsh(): string | undefined {
  return firstExisting(PWSH_CANDIDATES) ?? which("pwsh.exe") ?? which("pwsh") ?? undefined
}

function findPowershell(): string | undefined {
  return firstExisting(POWERSHELL_CANDIDATES) ?? which("powershell.exe") ?? which("powershell") ?? undefined
}

// Resolve to a full executable PATH once and cache it. Resolving by path (rather
// than spawn-probing a bare command name with a short timeout) avoids two Windows
// failure modes that surfaced as "neither pwsh nor powershell found" / constant
// timeouts on machines where the shell is actually present:
//   1. `pwsh` on PATH being a non-executable .cmd shim (node:child_process spawn
//      cannot launch .cmd files), and
//   2. a slow PowerShell cold start (15s+ under heavy load) blowing the probe's
//      timeout, so a present shell is misreported as missing.
// Resolution is filesystem-only (instant) and memoized per preference.
const resolvedCache = new Map<Preferred, string>()

function resolveExecutable(preferred: Preferred): string {
  const cached = resolvedCache.get(preferred)
  if (cached) return cached

  let resolved: string | undefined
  if (preferred === "pwsh") {
    resolved = findPwsh()
    if (!resolved)
      throw new Error(
        "powershell: 'pwsh' (PowerShell 7+) not found. Install from https://aka.ms/powershell or use prefer='powershell' on Windows.",
      )
  } else if (preferred === "powershell") {
    if (process.platform !== "win32")
      throw new Error("powershell: prefer='powershell' is Windows-only. On macOS/Linux use prefer='pwsh'.")
    resolved = findPowershell()
    if (!resolved) throw new Error("powershell: powershell.exe not found.")
  } else {
    // auto: prefer pwsh 7 (faster cold start), fall back to Windows PowerShell 5.1.
    resolved = findPwsh() ?? (process.platform === "win32" ? findPowershell() : undefined)
    if (!resolved)
      throw new Error(
        "powershell: neither 'pwsh' nor 'powershell' found. Install PowerShell 7+ (https://aka.ms/powershell).",
      )
  }

  resolvedCache.set(preferred, resolved)
  return resolved
}

async function pickExecutable(preferred: Preferred, _signal: AbortSignal): Promise<string> {
  return resolveExecutable(preferred)
}

type RunResult = {
  exitCode: number | null
  signal: string | null
  stdout: string
  stderr: string
  stdoutBytes: number
  stderrBytes: number
  stdoutTruncated: boolean
  stderrTruncated: boolean
  timedOut: boolean
  aborted: boolean
}

function runScript(
  cmd: string,
  script: string,
  workdir: string,
  timeoutMs: number,
  maxOutputBytes: number,
  signal: AbortSignal,
): Promise<RunResult> {
  return new Promise((resolve) => {
    const ac = new AbortController()
    const onAbort = () => ac.abort()
    signal.addEventListener("abort", onAbort, { once: true })

    let stdoutBytes = 0
    let stderrBytes = 0
    let stdoutTruncated = false
    let stderrTruncated = false
    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    let timedOut = false

    const args = ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", "-"]
    const child = spawn(cmd, args, {
      cwd: workdir,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: { ...process.env, NO_COLOR: "1" },
    })

    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let onAbortKill: () => void = () => {}
    const finish = (code: number | null, sig: NodeJS.Signals | null, extraStderr?: string) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      signal.removeEventListener("abort", onAbort)
      ac.signal.removeEventListener("abort", onAbortKill)
      const stderr = Buffer.concat(stderrChunks).toString("utf8")
      resolve({
        exitCode: typeof code === "number" ? code : null,
        signal: sig ? String(sig) : null,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: extraStderr ? (stderr ? `${stderr}\n${extraStderr}` : extraStderr) : stderr,
        stdoutBytes,
        stderrBytes,
        stdoutTruncated,
        stderrTruncated,
        timedOut,
        aborted: ac.signal.aborted && !timedOut,
      })
    }

    const childExited = () => child.exitCode !== null || child.signalCode !== null
    const stopChild = () => {
      return killTree(child, { exited: childExited }).catch(() => {
        try {
          child.kill()
        } catch {
          /* noop */
        }
      })
    }

    timer = setTimeout(() => {
      timedOut = true
      void stopChild().finally(() => finish(null, null))
    }, timeoutMs)

    const collect = (chunks: Buffer[], chunk: Buffer, isStdout: boolean) => {
      const haveBytes = isStdout ? stdoutBytes : stderrBytes
      const truncated = isStdout ? stdoutTruncated : stderrTruncated
      if (truncated) {
        // Already over the cap - still count to report total, but stop buffering.
        if (isStdout) stdoutBytes += chunk.length
        else stderrBytes += chunk.length
        return
      }
      const remaining = maxOutputBytes - haveBytes
      if (chunk.length <= remaining) {
        chunks.push(chunk)
        if (isStdout) stdoutBytes += chunk.length
        else stderrBytes += chunk.length
        return
      }
      if (remaining > 0) chunks.push(chunk.subarray(0, remaining))
      if (isStdout) {
        stdoutBytes += chunk.length
        stdoutTruncated = true
      } else {
        stderrBytes += chunk.length
        stderrTruncated = true
      }
    }

    child.stdout?.on("data", (chunk) => collect(stdoutChunks, chunk, true))
    child.stderr?.on("data", (chunk) => collect(stderrChunks, chunk, false))

    const fullScript = `${PRELUDE}\n${script}\n`
    try {
      child.stdin?.end(fullScript, "utf8")
    } catch {
      /* ignore - child may have died already */
    }

    onAbortKill = () => {
      void stopChild().finally(() => finish(null, null))
    }
    ac.signal.addEventListener("abort", onAbortKill, { once: true })

    child.on("error", (err) => {
      finish(null, null, err.message)
    })

    child.on("close", (code, sig) => {
      finish(code, sig)
    })
  })
}

function annotate(label: string, value: string, truncated: boolean): string {
  const trimmed = value.replace(/\s+$/g, "")
  if (!trimmed && !truncated) return ""
  const header = truncated ? `--- ${label} (TAIL - head dropped due to byte cap) ---` : `--- ${label} ---`
  return `${header}\n${trimmed}\n`
}

export const PowerShellTool = Tool.define(
  "powershell",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Params, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const preferred: Preferred = (params.prefer ?? "auto") as Preferred
          const timeoutMs = params.timeout_ms ?? DEFAULT_TIMEOUT_MS
          const maxOutputBytes = params.max_output_bytes ?? DEFAULT_OUTPUT_BYTES
          const ignoreExitCode = params.ignore_exit_code ?? false

          const workdir = params.workdir
            ? path.isAbsolute(params.workdir)
              ? params.workdir
              : path.resolve(Instance.directory, params.workdir)
            : Instance.directory

          yield* ctx.ask({
            permission: "powershell",
            patterns: [params.command],
            always: [params.command],
            metadata: {
              description: params.description,
              workdir,
              preferred,
              timeout_ms: timeoutMs,
            },
          })

          yield* ctx.metadata({
            title: `powershell: ${params.description}`,
            metadata: {
              executable: "(resolving)",
              preferred,
              exit_code: null,
              signal: null,
              timed_out: false,
              aborted: false,
              workdir,
              duration_ms: 0,
              stdout_bytes: 0,
              stderr_bytes: 0,
              stdout_truncated: false,
              stderr_truncated: false,
              ok: false,
              ignore_exit_code: ignoreExitCode,
            },
          })

          const executable = yield* Effect.promise(() => pickExecutable(preferred, ctx.abort))

          yield* ctx.metadata({
            title: `powershell: ${params.description}`,
            metadata: {
              executable,
              preferred,
              exit_code: null,
              signal: null,
              timed_out: false,
              aborted: false,
              workdir,
              duration_ms: 0,
              stdout_bytes: 0,
              stderr_bytes: 0,
              stdout_truncated: false,
              stderr_truncated: false,
              ok: false,
              ignore_exit_code: ignoreExitCode,
            },
          })

          const start = Date.now()
          const result = yield* Effect.promise(() =>
            runScript(executable, params.command, workdir, timeoutMs, maxOutputBytes, ctx.abort),
          )
          const duration_ms = Date.now() - start

          const success = result.exitCode === 0
          const ok = ignoreExitCode ? !result.timedOut && !result.aborted : success && !result.timedOut && !result.aborted

          const meta: Metadata = {
            executable,
            preferred,
            exit_code: result.exitCode,
            signal: result.signal,
            timed_out: result.timedOut,
            aborted: result.aborted,
            workdir,
            duration_ms,
            stdout_bytes: result.stdoutBytes,
            stderr_bytes: result.stderrBytes,
            stdout_truncated: result.stdoutTruncated,
            stderr_truncated: result.stderrTruncated,
            ok,
            ignore_exit_code: ignoreExitCode,
          }

          const stdoutBlock = annotate("stdout", result.stdout, result.stdoutTruncated)
          const stderrBlock = annotate("stderr", result.stderr, result.stderrTruncated)

          const summaryParts: string[] = []
          summaryParts.push(`exit=${result.exitCode === null ? "(killed)" : result.exitCode}`)
          if (result.signal) summaryParts.push(`signal=${result.signal}`)
          if (result.timedOut) summaryParts.push(`timed_out=true`)
          if (result.aborted) summaryParts.push(`aborted=true`)
          summaryParts.push(`duration=${duration_ms}ms`)
          summaryParts.push(`exe=${executable}`)
          const summary = summaryParts.join(" ")

          const body = [stdoutBlock, stderrBlock].filter(Boolean).join("\n")
          const output = body
            ? `${summary}\n${body.trimEnd()}`
            : `${summary}\n(no output captured)`

          let title: string
          if (result.timedOut) title = `powershell timed out after ${timeoutMs}ms: ${params.description}`
          else if (result.aborted) title = `powershell aborted: ${params.description}`
          else if (ok) title = `powershell ok (${duration_ms}ms): ${params.description}`
          else title = `powershell exit=${result.exitCode ?? "killed"}: ${params.description}`

          return done({ title, metadata: meta, output })
        }),
    }
  }),
)

export const __testing = { pickExecutable, runScript, PRELUDE }
