import { Effect, Schema } from "effect"
import { spawn } from "node:child_process"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { Global } from "@opencode-ai/core/global"
import { Instance } from "../project/instance"
import DESCRIPTION from "./automation.txt"
import * as Tool from "./tool"

const ACTIONS = [
  "create",
  "update",
  "list",
  "show",
  "delete",
  "enable",
  "disable",
  "run_now",
  "logs",
  "history",
] as const
const SCHEDULES = ["every_minutes", "hourly", "daily", "weekly"] as const
const WEEKDAYS = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"] as const
const DEFAULT_TASK_FOLDER = "\\OpenCode SG"
const HISTORY_KEEP = 200
const LOGS_KEEP = 50
const DEFAULT_LOG_TAIL_BYTES = 32_768

export const Parameters = Schema.Struct({
  action: Schema.Literals(ACTIONS).annotate({
    description: "Action: create, update, list, show, delete, enable, disable, or run_now.",
  }),
  id: Schema.optional(Schema.String).annotate({
    description:
      "Stable automation id. Optional for create; if omitted it is derived from title. Required for show/update/delete/enable/disable/run_now.",
  }),
  title: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120))).annotate({
    description: "Short automation title. Required for create.",
  }),
  prompt: Schema.optional(Schema.String.check(Schema.isMinLength(1))).annotate({
    description: "Prompt sent to `opencode-sg.cmd run` when the automation fires. Required for create.",
  }),
  schedule: Schema.optional(Schema.Literals(SCHEDULES)).annotate({
    description: "Schedule type: every_minutes, hourly, or daily. Required for create.",
  }),
  interval_minutes: Schema.optional(
    Schema.Number.check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(1)).check(Schema.isLessThanOrEqualTo(10080)),
  ).annotate({
    description:
      "For every_minutes, run every N minutes. For hourly, this is interpreted as every N hours. Defaults to 1 for hourly.",
  }),
  time: Schema.optional(Schema.String).annotate({
    description: "Daily/weekly start time in HH:mm 24-hour format, e.g. 09:00. Required for daily and weekly schedules.",
  }),
  days_of_week: Schema.optional(Schema.Array(Schema.Literals(WEEKDAYS))).annotate({
    description:
      "For weekly schedules: which days the task should run. List of MON,TUE,WED,THU,FRI,SAT,SUN. Defaults to all 7 days.",
  }),
  tail_lines: Schema.optional(
    Schema.Number.check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(1)).check(Schema.isLessThanOrEqualTo(2000)),
  ).annotate({
    description: "For logs action: how many trailing lines of the log to return. Defaults to about 200 lines.",
  }),
  history_limit: Schema.optional(
    Schema.Number.check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(1)).check(Schema.isLessThanOrEqualTo(200)),
  ).annotate({
    description: "For history action: how many recent runs to summarize. Defaults to 20.",
  }),
  log_run: Schema.optional(Schema.String).annotate({
    description:
      "For logs action: ISO timestamp prefix or filename of a specific run log. Defaults to the latest run.",
  }),
  working_directory: Schema.optional(Schema.String).annotate({
    description: "Directory to run SG OpenCode in. Defaults to the current project directory.",
  }),
  model: Schema.optional(Schema.String).annotate({
    description: "Optional model in provider/model format.",
  }),
  agent: Schema.optional(Schema.String).annotate({
    description: "Optional primary agent name.",
  }),
  enabled: Schema.optional(Schema.Boolean).annotate({
    description: "Whether the automation should be enabled. Defaults to true on create.",
  }),
  install: Schema.optional(Schema.Boolean).annotate({
    description: "Whether to install/update the OS scheduled task. Defaults to true.",
  }),
})

export type Params = Schema.Schema.Type<typeof Parameters>
type Action = (typeof ACTIONS)[number]
type ScheduleType = (typeof SCHEDULES)[number]
type Weekday = (typeof WEEKDAYS)[number]

export type AutomationDefinition = {
  id: string
  title: string
  prompt: string
  schedule: ScheduleType
  interval_minutes?: number
  time?: string
  days_of_week?: ReadonlyArray<Weekday>
  working_directory: string
  model?: string
  agent?: string
  enabled: boolean
  task_name: string
  definition_path: string
  prompt_path: string
  script_path: string
  log_dir: string
  history_path: string
  created_at: string
  updated_at: string
}

type RunHistoryEntry = {
  id: string
  ts: string
  exit?: number | null
  log: string
  duration_ms?: number
}

export type AutomationRunHistoryEntry = RunHistoryEntry

type Metadata = {
  action: Action
  id?: string
  enabled?: boolean
  installed?: boolean
  scheduler?: "windows_schtasks" | "definition_only"
  task_name?: string
  count?: number
  definition_path?: string
  prompt_path?: string
  script_path?: string
  log_dir?: string
  history_path?: string
  log_path?: string
  log_run_ts?: string
  log_bytes?: number
  log_truncated?: boolean
  history_count?: number
  exit_code?: number | null
}

const done = (result: Tool.ExecuteResult<Metadata>) => result

function automationRoot() {
  return process.env.OPENCODE_SG_AUTOMATION_DIR || path.join(Global.Path.data, "automations")
}

function dirs() {
  const root = automationRoot()
  return {
    root,
    definitions: path.join(root, "definitions"),
    prompts: path.join(root, "prompts"),
    scripts: path.join(root, "scripts"),
    logs: path.join(root, "logs"),
    history: path.join(root, "history"),
  }
}

function logDir(id: string) {
  return path.join(dirs().logs, id)
}

function historyPath(id: string) {
  return path.join(dirs().history, `${id}.jsonl`)
}

function sanitizeId(input: string) {
  const normalized = input
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
  if (!normalized) throw new Error("automation: id/title must contain at least one letter or number")
  return normalized
}

function taskName(id: string) {
  return `${DEFAULT_TASK_FOLDER}\\${id}`
}

function requireID(params: Params) {
  if (!params.id?.trim()) throw new Error(`automation: action ${params.action} requires id`)
  return sanitizeId(params.id)
}

function requireCreate(params: Params) {
  const title = params.title?.trim()
  const prompt = params.prompt?.trim()
  const schedule = params.schedule
  if (!title) throw new Error("automation: create requires title")
  if (!prompt) throw new Error("automation: create requires prompt")
  if (!schedule) throw new Error("automation: create requires schedule")
  validateSchedule(schedule, params)
  return { title, prompt, schedule }
}

function validateSchedule(
  schedule: ScheduleType,
  params: Pick<Params, "interval_minutes" | "time" | "days_of_week">,
) {
  if (schedule === "every_minutes" && !params.interval_minutes) {
    throw new Error("automation: every_minutes schedule requires interval_minutes")
  }
  if (schedule === "daily" && !isHHMM(params.time)) {
    throw new Error("automation: daily schedule requires time in HH:mm format")
  }
  if (schedule === "weekly") {
    if (!isHHMM(params.time)) {
      throw new Error("automation: weekly schedule requires time in HH:mm format")
    }
    if (params.days_of_week && params.days_of_week.length === 0) {
      throw new Error("automation: weekly schedule days_of_week must not be empty if provided")
    }
  }
}

function isHHMM(value: unknown) {
  if (typeof value !== "string") return false
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value)
  return Boolean(match)
}

function definitionPath(id: string) {
  return path.join(dirs().definitions, `${id}.json`)
}

function promptPath(id: string) {
  return path.join(dirs().prompts, `${id}.txt`)
}

function scriptPath(id: string) {
  return path.join(dirs().scripts, `${id}.cmd`)
}

async function ensureDirs() {
  const d = dirs()
  await fs.mkdir(d.definitions, { recursive: true })
  await fs.mkdir(d.prompts, { recursive: true })
  await fs.mkdir(d.scripts, { recursive: true })
  await fs.mkdir(d.logs, { recursive: true })
  await fs.mkdir(d.history, { recursive: true })
}

async function readDefinition(id: string): Promise<AutomationDefinition> {
  const raw = await fs.readFile(definitionPath(id), "utf8")
  return JSON.parse(raw) as AutomationDefinition
}

async function readAllDefinitions() {
  await ensureDirs()
  const files = await fs.readdir(dirs().definitions).catch(() => [] as string[])
  const result: AutomationDefinition[] = []
  for (const file of files) {
    if (!file.endsWith(".json")) continue
    const id = path.basename(file, ".json")
    try {
      result.push(await readDefinition(id))
    } catch {}
  }
  return result.toSorted((a, b) => a.id.localeCompare(b.id))
}

function cmdQuote(input: string) {
  return `"${input.replace(/"/g, '""')}"`
}

function launcherPath() {
  return path.join(Global.Path.home, ".opencode", "bin", "opencode-sg.cmd")
}

function timestampCommand() {
  return `powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command "Get-Date -Format yyyyMMdd-HHmmss"`
}

function buildRunnerScript(def: AutomationDefinition) {
  const args = [
    "run",
    "--title",
    cmdQuote(def.title),
    ...(def.model ? ["--model", cmdQuote(def.model)] : []),
    ...(def.agent ? ["--agent", cmdQuote(def.agent)] : []),
  ]

  // Build a sortable timestamp without WMIC. Recent Windows installs often do
  // not include wmic.exe, which made every automation log collide at
  // 00000000-000000 and produced malformed history rows.
  return [
    "@echo off",
    "setlocal enabledelayedexpansion",
    "set OPENCODE_SG_PERMISSION_MODE=allow",
    "set OPENCODE_SG_AUTOMATION_RUN=1",
    `set OPENCODE_SG_AUTOMATION_ID=${def.id}`,
    `cd /d ${cmdQuote(def.working_directory)}`,
    `if not exist ${cmdQuote(def.log_dir)} mkdir ${cmdQuote(def.log_dir)}`,
    `if not exist ${cmdQuote(path.dirname(def.history_path))} mkdir ${cmdQuote(path.dirname(def.history_path))}`,
    `for /f "delims=" %%a in ('${timestampCommand()}') do set "TS=%%a"`,
    "if not defined TS set \"TS=00000000-000000\"",
    `set "LOG=${def.log_dir}\\!TS!.log"`,
    `set "HIST=${def.history_path}"`,
    `> "!LOG!" echo === SG OpenCode automation: ${def.id} (!TS!) ===`,
    `>> "!LOG!" echo cwd: ${def.working_directory}`,
    `>> "!LOG!" echo title: ${def.title}`,
    "echo. >> \"!LOG!\"",
    `type ${cmdQuote(def.prompt_path)} | call ${cmdQuote(launcherPath())} ${args.join(" ")} 1>> "!LOG!" 2>&1`,
    "set EXITCODE=!errorlevel!",
    `for /f "delims=" %%a in ('${timestampCommand()}') do set "END_TS=%%a"`,
    "if not defined END_TS set \"END_TS=!TS!\"",
    "echo. >> \"!LOG!\"",
    `>> "!LOG!" echo === end (exit !EXITCODE!) at !END_TS! ===`,
    "set \"LOG_JSON=!LOG:\\=\\\\!\"",
    `>> "!HIST!" echo {"id":"${def.id}","ts":"!TS!","exit":!EXITCODE!,"log":"!LOG_JSON!","end_ts":"!END_TS!"}`,
    "endlocal & exit /b %EXITCODE%",
    "",
  ].join("\r\n")
}

// Sibling .vbs wrapper for the .cmd runner. Windows Task Scheduler invokes
// this via `wscript.exe` so the .cmd does not flash a console window (cmd is
// launched with SW_HIDE). The wrapper waits for the cmd to exit so Task
// Scheduler's Running/Last Result state reflects the real automation run.
function vbsPath(scriptPath: string) {
  return scriptPath.replace(/\.cmd$/i, ".vbs")
}

function buildVbsLauncher(scriptPath: string) {
  // Triple double-quotes in VBS = a single literal double-quote.
  const vbsQuoted = `""${scriptPath.replace(/"/g, '""')}""`
  return [
    "' SG OpenCode automation launcher (auto-generated)",
    "' Runs the sibling .cmd hidden so users don't see a terminal flash.",
    `Dim WShell`,
    `Set WShell = CreateObject("WScript.Shell")`,
    `WShell.Run "${vbsQuoted}", 0, True`,
    "",
  ].join("\r\n")
}

async function writeDefinition(def: AutomationDefinition) {
  await ensureDirs()
  await fs.writeFile(def.prompt_path, def.prompt, "utf8")
  await fs.writeFile(def.script_path, buildRunnerScript(def), "utf8")
  await fs.writeFile(vbsPath(def.script_path), buildVbsLauncher(def.script_path), "utf8")
  await fs.writeFile(def.definition_path, JSON.stringify(def, null, 2), "utf8")
}

function schtasksCreateArgs(def: AutomationDefinition) {
  // /TR points at the wscript wrapper instead of the .cmd directly so
  // Windows Task Scheduler launches us with no visible console window.
  const tr = `wscript.exe ${cmdQuote(vbsPath(def.script_path))}`
  const args = ["/Create", "/TN", def.task_name, "/TR", tr, "/F"]
  if (def.schedule === "every_minutes") {
    args.push("/SC", "MINUTE", "/MO", String(def.interval_minutes ?? 1))
    return args
  }
  if (def.schedule === "hourly") {
    args.push("/SC", "HOURLY", "/MO", String(def.interval_minutes ?? 1))
    return args
  }
  if (def.schedule === "weekly") {
    const days = (def.days_of_week && def.days_of_week.length > 0 ? def.days_of_week : WEEKDAYS).join(",")
    args.push("/SC", "WEEKLY", "/D", days, "/ST", def.time ?? "09:00")
    return args
  }
  args.push("/SC", "DAILY", "/ST", def.time ?? "09:00")
  return args
}

function runProcess(command: string, args: string[], signal: AbortSignal, timeoutMs = 15000) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    let settled = false
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true })
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try {
        child.kill()
      } catch {}
      resolve({ code: null, stdout: "", stderr: "timeout" })
    }, timeoutMs)
    const onAbort = () => {
      try {
        child.kill()
      } catch {}
    }
    signal.addEventListener("abort", onAbort, { once: true })
    let stdout = ""
    let stderr = ""
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString()
    })
    child.on("error", (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener("abort", onAbort)
      resolve({ code: null, stdout, stderr: err.message })
    })
    child.on("close", (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener("abort", onAbort)
      resolve({ code, stdout, stderr })
    })
  })
}

async function scheduler(action: "create" | "delete" | "enable" | "disable" | "run", def: AutomationDefinition, signal: AbortSignal) {
  if (process.platform !== "win32") {
    return { code: 0, stdout: "", stderr: "OS scheduled task install is only implemented on Windows." }
  }
  if (action === "create") return runProcess("schtasks.exe", schtasksCreateArgs(def), signal)
  if (action === "delete") return runProcess("schtasks.exe", ["/Delete", "/TN", def.task_name, "/F"], signal)
  if (action === "enable") return runProcess("schtasks.exe", ["/Change", "/TN", def.task_name, "/ENABLE"], signal)
  if (action === "disable") return runProcess("schtasks.exe", ["/Change", "/TN", def.task_name, "/DISABLE"], signal)
  return runProcess("schtasks.exe", ["/Run", "/TN", def.task_name], signal)
}

function schedulerFailure(result: { code: number | null; stdout: string; stderr: string }) {
  if (result.code === 0) return undefined
  const detail = `${result.stderr || result.stdout || `exit=${result.code}`}`.trim()
  return detail || "unknown scheduler error"
}

function summarize(def: AutomationDefinition) {
  const when =
    def.schedule === "daily"
      ? `daily at ${def.time}`
      : def.schedule === "weekly"
        ? `weekly ${(def.days_of_week ?? WEEKDAYS).join("/")} at ${def.time}`
        : def.schedule === "hourly"
          ? `every ${def.interval_minutes ?? 1} hour(s)`
          : `every ${def.interval_minutes} minute(s)`
  return `${def.id}: ${def.title} (${when}, ${def.enabled ? "enabled" : "disabled"})`
}

async function readHistory(id: string): Promise<RunHistoryEntry[]> {
  const file = historyPath(id)
  const text = await fs.readFile(file, "utf8").catch(() => "")
  if (!text) return []
  const out: RunHistoryEntry[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    try {
      const entry = JSON.parse(line) as RunHistoryEntry
      if (entry && typeof entry.ts === "string") out.push(entry)
    } catch {
      // ignore malformed line
    }
  }
  return out
}

async function pruneHistory(id: string) {
  const file = historyPath(id)
  const entries = await readHistory(id)
  if (entries.length <= HISTORY_KEEP) return
  const trimmed = entries.slice(-HISTORY_KEEP)
  const text = trimmed.map((e) => JSON.stringify(e)).join("\n") + "\n"
  await fs.writeFile(file, text, "utf8").catch(() => undefined)
}

async function pruneLogs(id: string) {
  const dir = logDir(id)
  const files = await fs.readdir(dir).catch(() => [] as string[])
  const sorted = files.filter((f) => f.endsWith(".log")).toSorted()
  if (sorted.length <= LOGS_KEEP) return
  const remove = sorted.slice(0, sorted.length - LOGS_KEEP)
  await Promise.all(remove.map((f) => fs.rm(path.join(dir, f), { force: true }).catch(() => undefined)))
}

async function findLogPath(id: string, runHint?: string): Promise<string | undefined> {
  const dir = logDir(id)
  const files = (await fs.readdir(dir).catch(() => [] as string[])).filter((f) => f.endsWith(".log"))
  if (!files.length) return undefined
  if (runHint) {
    const trimmed = runHint.replace(/\.log$/, "")
    const exact = files.find((f) => f === `${trimmed}.log` || f === runHint)
    if (exact) return path.join(dir, exact)
    const prefix = files.filter((f) => f.startsWith(trimmed))
    if (prefix.length > 0) return path.join(dir, prefix.toSorted().at(-1)!)
    return undefined
  }
  return path.join(dir, files.toSorted().at(-1)!)
}

async function tailFile(file: string, maxBytes: number, maxLines: number) {
  const stat = await fs.stat(file)
  const size = Number(stat.size ?? 0)
  const fh = await fs.open(file, "r")
  try {
    const readBytes = Math.min(size, maxBytes)
    const start = size - readBytes
    const buf = Buffer.alloc(readBytes)
    await fh.read(buf, 0, readBytes, start)
    let text = buf.toString("utf8")
    if (start > 0) {
      const nl = text.indexOf("\n")
      if (nl >= 0) text = text.slice(nl + 1)
    }
    const lines = text.split(/\r?\n/)
    const truncatedByBytes = start > 0 || lines.length > maxLines
    const limited = lines.length > maxLines ? lines.slice(-maxLines) : lines
    return { content: limited.join("\n"), size, bytes_read: readBytes, truncated: truncatedByBytes }
  } finally {
    await fh.close()
  }
}

export const AutomationStore = {
  root: automationRoot,
  dirs,
  sanitizeId,
  list: readAllDefinitions,
  get: (id: string) => readDefinition(sanitizeId(id)),
  history: (id: string) => readHistory(sanitizeId(id)),
  latestLog: (id: string, runHint?: string) => findLogPath(sanitizeId(id), runHint),
  tailLog: tailFile,
}

export const AutomationTool = Tool.define(
  "automation",
  Effect.succeed({
    description: DESCRIPTION,
    parameters: Parameters,
    execute: (params: Params, ctx: Tool.Context<Metadata>) =>
      Effect.gen(function* () {
        if (params.action === "list") {
          const items = yield* Effect.promise(() => readAllDefinitions())
          return done({
            title: `automations: ${items.length}`,
            metadata: { action: "list", count: items.length, scheduler: "definition_only" },
            output: items.length ? items.map(summarize).join("\n") : "No SG OpenCode automations are saved.",
          })
        }

        const id = params.action === "create" ? sanitizeId(params.id || params.title || "") : requireID(params)

        if (params.action === "show") {
          const def = yield* Effect.promise(() => readDefinition(id))
          return done({
            title: `automation: ${def.id}`,
            metadata: {
              action: "show",
              id: def.id,
              enabled: def.enabled,
              scheduler: "definition_only",
              task_name: def.task_name,
              definition_path: def.definition_path,
              prompt_path: def.prompt_path,
              script_path: def.script_path,
              log_dir: def.log_dir ?? logDir(def.id),
              history_path: def.history_path ?? historyPath(def.id),
            },
            output: JSON.stringify(def, null, 2),
          })
        }

        if (params.action === "history") {
          const def = yield* Effect.promise(() => readDefinition(id))
          const limit = params.history_limit ?? 20
          const all = yield* Effect.promise(() => readHistory(id))
          const recent = all.slice(-limit).reverse()
          const lines = recent.map((entry) => {
            const exit =
              entry.exit === undefined || entry.exit === null
                ? "??"
                : entry.exit === 0
                  ? "ok"
                  : `exit=${entry.exit}`
            return `${entry.ts}  ${exit.padEnd(8)}  ${entry.log}`
          })
          return done({
            title: `automation history: ${id} (${recent.length}/${all.length})`,
            metadata: {
              action: "history",
              id,
              count: recent.length,
              history_count: all.length,
              history_path: def.history_path ?? historyPath(id),
              log_dir: def.log_dir ?? logDir(id),
            },
            output: lines.length
              ? `Recent runs of ${id}:\n${lines.join("\n")}`
              : `No recorded runs for ${id} yet. The history file will appear once the scheduled task fires for the first time: ${historyPath(id)}`,
          })
        }

        if (params.action === "logs") {
          const def = yield* Effect.promise(() => readDefinition(id))
          const tailLines = params.tail_lines ?? 200
          const found = yield* Effect.promise(() => findLogPath(id, params.log_run))
          if (!found) {
            return done({
              title: `automation logs: ${id} (no logs yet)`,
              metadata: {
                action: "logs",
                id,
                log_dir: def.log_dir ?? logDir(id),
              },
              output: `No log files found for ${id}. Logs are written to ${def.log_dir ?? logDir(id)} once the scheduled task runs.`,
            })
          }
          const tailed = yield* Effect.promise(() => tailFile(found, DEFAULT_LOG_TAIL_BYTES, tailLines))
          const tsMatch = path.basename(found).match(/^(\d{8}-\d{6})\.log$/)
          return done({
            title: `automation logs: ${id} (${path.basename(found)})`,
            metadata: {
              action: "logs",
              id,
              log_dir: def.log_dir ?? logDir(id),
              log_path: found,
              log_run_ts: tsMatch ? tsMatch[1] : undefined,
              log_bytes: tailed.size,
              log_truncated: tailed.truncated,
            },
            output:
              `# ${found}\n# size=${tailed.size} bytes${tailed.truncated ? " (tail only)" : ""}\n` + tailed.content,
          })
        }

        yield* ctx.ask({
          permission: "automation",
          patterns: [id],
          always: [id],
          metadata: { action: params.action, id },
        })

        if (params.action === "delete") {
          const def = yield* Effect.promise(() => readDefinition(id))
          const scheduled = yield* Effect.promise(() => scheduler("delete", def, ctx.abort))
          yield* Effect.promise(async () => {
            await fs.rm(def.definition_path, { force: true })
            await fs.rm(def.prompt_path, { force: true })
            await fs.rm(def.script_path, { force: true })
            await fs.rm(vbsPath(def.script_path), { force: true })
            await fs.rm(def.log_dir ?? logDir(id), { recursive: true, force: true })
            await fs.rm(def.history_path ?? historyPath(id), { force: true })
          })
          return done({
            title: `deleted automation: ${id}`,
            metadata: {
              action: "delete",
              id,
              scheduler: process.platform === "win32" ? "windows_schtasks" : "definition_only",
              exit_code: scheduled.code,
            },
            output: `Deleted automation ${id}.${schedulerFailure(scheduled) ? ` Scheduler detail: ${schedulerFailure(scheduled)}` : ""}`,
          })
        }

        if (params.action === "enable" || params.action === "disable" || params.action === "run_now") {
          const def = yield* Effect.promise(() => readDefinition(id))
          if (params.action === "run_now") {
            const scheduled = yield* Effect.promise(() => scheduler("run", def, ctx.abort))
            const failure = schedulerFailure(scheduled)
            if (failure) throw new Error(`automation: failed to run ${id}: ${failure}`)
            yield* Effect.promise(async () => {
              await pruneLogs(id).catch(() => undefined)
              await pruneHistory(id).catch(() => undefined)
            })
            return done({
              title: `started automation: ${id}`,
              metadata: {
                action: "run_now",
                id,
                enabled: def.enabled,
                installed: true,
                scheduler: process.platform === "win32" ? "windows_schtasks" : "definition_only",
                task_name: def.task_name,
                log_dir: def.log_dir ?? logDir(id),
                history_path: def.history_path ?? historyPath(id),
                exit_code: scheduled.code,
              },
              output: `Started scheduled task for ${summarize(def)}. Output streams to ${def.log_dir ?? logDir(id)}; use {"action":"logs","id":"${id}"} after the run to inspect.`,
            })
          }

          def.enabled = params.action === "enable"
          def.updated_at = new Date().toISOString()
          yield* Effect.promise(() => writeDefinition(def))
          const scheduled =
            params.action === "enable"
              ? yield* Effect.promise(() => scheduler("create", def, ctx.abort))
              : yield* Effect.promise(() => scheduler("disable", def, ctx.abort))
          const failure = schedulerFailure(scheduled)
          if (failure && params.action === "enable") throw new Error(`automation: failed to enable ${id}: ${failure}`)
          return done({
            title: `${params.action}d automation: ${id}`,
            metadata: {
              action: params.action,
              id,
              enabled: def.enabled,
              installed: scheduled.code === 0,
              scheduler: process.platform === "win32" ? "windows_schtasks" : "definition_only",
              task_name: def.task_name,
              exit_code: scheduled.code,
            },
            output: `${params.action === "enable" ? "Enabled" : "Disabled"} ${summarize(def)}.${failure ? ` Scheduler detail: ${failure}` : ""}`,
          })
        }

        const now = new Date().toISOString()
        const existing = params.action === "update" ? yield* Effect.promise(() => readDefinition(id)) : undefined
        const create = params.action === "create" ? requireCreate(params) : undefined
        const schedule = (params.schedule ?? existing?.schedule ?? create?.schedule) as ScheduleType
        validateSchedule(schedule, {
          interval_minutes: params.interval_minutes ?? existing?.interval_minutes,
          time: params.time ?? existing?.time,
          days_of_week: params.days_of_week ?? existing?.days_of_week,
        })

        const def: AutomationDefinition = {
          id,
          title: params.title?.trim() ?? existing?.title ?? create!.title,
          prompt: params.prompt?.trim() ?? existing?.prompt ?? create!.prompt,
          schedule,
          interval_minutes:
            schedule === "daily" || schedule === "weekly"
              ? undefined
              : params.interval_minutes ?? existing?.interval_minutes ?? (schedule === "hourly" ? 1 : undefined),
          time:
            schedule === "daily" || schedule === "weekly" ? params.time ?? existing?.time : undefined,
          days_of_week:
            schedule === "weekly" ? params.days_of_week ?? existing?.days_of_week : undefined,
          working_directory: path.resolve(params.working_directory ?? existing?.working_directory ?? Instance.directory),
          model: params.model ?? existing?.model,
          agent: params.agent ?? existing?.agent,
          enabled: params.enabled ?? existing?.enabled ?? true,
          task_name: taskName(id),
          definition_path: definitionPath(id),
          prompt_path: promptPath(id),
          script_path: scriptPath(id),
          log_dir: logDir(id),
          history_path: historyPath(id),
          created_at: existing?.created_at ?? now,
          updated_at: now,
        }

        yield* ctx.metadata({
          title: `${params.action} automation: ${def.id}`,
          metadata: {
            action: params.action,
            id: def.id,
            enabled: def.enabled,
            scheduler: "definition_only",
            task_name: def.task_name,
          },
        })

        yield* Effect.promise(() => writeDefinition(def))

        const shouldInstall = params.install ?? true
        const scheduled =
          shouldInstall && def.enabled
            ? yield* Effect.promise(() => scheduler("create", def, ctx.abort))
            : undefined
        const failure = scheduled ? schedulerFailure(scheduled) : undefined
        if (failure) throw new Error(`automation: failed to install ${id}: ${failure}`)

        return done({
          title: `${params.action === "create" ? "created" : "updated"} automation: ${def.id}`,
          metadata: {
            action: params.action,
            id: def.id,
            enabled: def.enabled,
            installed: Boolean(scheduled && scheduled.code === 0),
            scheduler: scheduled && process.platform === "win32" ? "windows_schtasks" : "definition_only",
            task_name: def.task_name,
            definition_path: def.definition_path,
            prompt_path: def.prompt_path,
            script_path: def.script_path,
            log_dir: def.log_dir,
            history_path: def.history_path,
            exit_code: scheduled?.code,
          },
          output: [
            `${params.action === "create" ? "Created" : "Updated"} ${summarize(def)}.`,
            `Definition: ${def.definition_path}`,
            `Prompt: ${def.prompt_path}`,
            `Runner: ${def.script_path}`,
            `Logs: ${def.log_dir} (history: ${def.history_path})`,
            scheduled ? `Scheduled task: ${def.task_name}` : "Scheduled task not installed by request or disabled state.",
          ].join("\n"),
        })
      }),
  }),
)

export const __testing = {
  automationRoot,
  sanitizeId,
  taskName,
  buildRunnerScript,
  schtasksCreateArgs,
  summarize,
  logDir,
  historyPath,
  readHistory,
  pruneHistory,
  pruneLogs,
  findLogPath,
  tailFile,
  vbsPath,
  buildVbsLauncher,
}
