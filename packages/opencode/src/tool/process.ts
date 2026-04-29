import { Effect, Schema } from "effect"
import { spawn } from "node:child_process"
import DESCRIPTION from "./process.txt"
import * as Tool from "./tool"

const ACTIONS = ["list", "kill"] as const

export const Parameters = Schema.Struct({
  action: Schema.Literals(ACTIONS).annotate({
    description: "Action: 'list' to enumerate processes, 'kill' to terminate one.",
  }),
  name_pattern: Schema.optional(Schema.String.check(Schema.isMaxLength(200))).annotate({
    description: "Case-insensitive substring matched against the process image name.",
  }),
  pid: Schema.optional(Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))).annotate({
    description: "PID to kill. Required when action is 'kill'.",
  }),
  force: Schema.optional(Schema.Boolean).annotate({
    description: "When killing, force-terminate (SIGKILL / taskkill /F) instead of requesting graceful exit.",
  }),
  limit: Schema.optional(
    Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(500)),
  ).annotate({
    description: "Max rows to return for 'list' (1-500). Default 50.",
  }),
})

type Params = Schema.Schema.Type<typeof Parameters>
type Action = (typeof ACTIONS)[number]

type ProcRow = {
  pid: number
  name: string
  cpu_percent?: number
  rss_kb?: number
}

type Metadata = {
  platform: NodeJS.Platform
  backend: string
  action: Action
  name_pattern?: string
  pid?: number
  force?: boolean
  limit?: number
  processes?: ProcRow[]
  match_count?: number
  total_seen?: number
  killed?: boolean
  exit_code?: number
  delivered: boolean
  error?: string
}

const done = (result: Tool.ExecuteResult<Metadata>) => result

function runProcess(
  cmd: string,
  args: string[],
  signal: AbortSignal,
  timeoutMs = 8000,
): Promise<{ code: number | null; stderr: string; stdout: string }> {
  return new Promise((resolve) => {
    let settled = false
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true })
    const timer = setTimeout(() => {
      if (!settled) {
        try {
          child.kill()
        } catch {}
        settled = true
        resolve({ code: null, stderr: "timeout", stdout: "" })
      }
    }, timeoutMs)
    const onAbort = () => {
      try {
        child.kill()
      } catch {}
    }
    signal.addEventListener("abort", onAbort, { once: true })
    let stdout = ""
    let stderr = ""
    child.stdout?.on("data", (c) => {
      stdout += c.toString()
    })
    child.stderr?.on("data", (c) => {
      stderr += c.toString()
    })
    child.on("error", (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener("abort", onAbort)
      resolve({ code: null, stderr: err.message, stdout })
    })
    child.on("close", (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener("abort", onAbort)
      resolve({ code, stderr, stdout })
    })
  })
}

// Parse a Windows `tasklist /FO CSV /NH` line. Format:
//   "image.exe","PID","Session Name","Session#","Mem Usage"
// where Mem Usage is a string like "12,345 K".
export function parseTasklistCsvLine(line: string): ProcRow | undefined {
  const cells = parseCsvLine(line)
  if (cells.length < 5) return undefined
  const name = cells[0]
  const pid = parseInt(cells[1], 10)
  if (!Number.isFinite(pid)) return undefined
  // Memory in form "12,345 K"
  const memRaw = cells[4].replace(/[^\d]/g, "")
  const rss_kb = memRaw ? parseInt(memRaw, 10) : undefined
  return { pid, name, rss_kb }
}

// Minimal CSV-with-quoted-cells parser. Covers the tasklist CSV shape — quoted cells with internal commas.
export function parseCsvLine(line: string): string[] {
  const out: string[] = []
  let cur = ""
  let inQuoted = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inQuoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"'
          i++
        } else {
          inQuoted = false
        }
      } else {
        cur += ch
      }
    } else {
      if (ch === '"') {
        inQuoted = true
      } else if (ch === ",") {
        out.push(cur)
        cur = ""
      } else {
        cur += ch
      }
    }
  }
  out.push(cur)
  return out
}

// Parse a `ps -eo pid,comm,pcpu,rss` line on macOS / Linux.
// Columns are whitespace-separated. We assume the rss is the last column,
// pcpu is second-to-last, comm is everything between pid and pcpu.
export function parsePsLine(line: string): ProcRow | undefined {
  const trimmed = line.trim()
  if (!trimmed) return undefined
  const tokens = trimmed.split(/\s+/)
  if (tokens.length < 4) return undefined
  const pid = parseInt(tokens[0], 10)
  if (!Number.isFinite(pid)) return undefined
  const rss = parseInt(tokens[tokens.length - 1], 10)
  const cpu = parseFloat(tokens[tokens.length - 2])
  const name = tokens.slice(1, tokens.length - 2).join(" ")
  return {
    pid,
    name,
    cpu_percent: Number.isFinite(cpu) ? cpu : undefined,
    rss_kb: Number.isFinite(rss) ? rss : undefined,
  }
}

async function listWindows(signal: AbortSignal): Promise<{ rows: ProcRow[]; raw: string; error?: string }> {
  // /FO CSV /NH = CSV without header.
  const r = await runProcess("tasklist", ["/FO", "CSV", "/NH"], signal, 10_000)
  if (r.code !== 0) return { rows: [], raw: r.stdout, error: r.stderr.trim() || `tasklist exit=${r.code}` }
  const rows: ProcRow[] = []
  for (const line of r.stdout.split(/\r?\n/)) {
    if (!line.trim()) continue
    const row = parseTasklistCsvLine(line)
    if (row) rows.push(row)
  }
  return { rows, raw: r.stdout }
}

async function listUnix(signal: AbortSignal): Promise<{ rows: ProcRow[]; raw: string; error?: string }> {
  // Use POSIX-portable `ps -eo pid,comm,pcpu,rss`. Skip header line.
  const r = await runProcess("ps", ["-eo", "pid,comm,pcpu,rss"], signal, 10_000)
  if (r.code !== 0) return { rows: [], raw: r.stdout, error: r.stderr.trim() || `ps exit=${r.code}` }
  const rows: ProcRow[] = []
  const lines = r.stdout.split(/\r?\n/)
  // Skip header (first non-empty line)
  let seenHeader = false
  for (const line of lines) {
    if (!line.trim()) continue
    if (!seenHeader) {
      seenHeader = true
      continue
    }
    const row = parsePsLine(line)
    if (row) rows.push(row)
  }
  return { rows, raw: r.stdout }
}

async function killWindows(pid: number, force: boolean, signal: AbortSignal) {
  const args = ["/PID", String(pid)]
  if (force) args.unshift("/F")
  return runProcess("taskkill", args, signal, 6000)
}

async function killUnix(pid: number, force: boolean, signal: AbortSignal) {
  const sig = force ? "-9" : "-15"
  return runProcess("kill", [sig, String(pid)], signal, 6000)
}

export const ProcessTool = Tool.define(
  "process",
  Effect.succeed({
    description: DESCRIPTION,
    parameters: Parameters,
    execute: (params: Params, ctx: Tool.Context<Metadata>) =>
      Effect.gen(function* () {
        const platform = process.platform
        const backend = platform === "win32" ? "tasklist/taskkill" : "ps/kill"
        const action = params.action
        const limit = params.limit ?? 50

        if (action === "kill") {
          if (params.pid === undefined) {
            return done({
              title: "process kill: missing pid",
              metadata: { platform, backend, action, delivered: false, error: "pid is required for kill" },
              output: "Error: 'pid' is required when action is 'kill'.",
            })
          }
          if (params.pid <= 1) {
            return done({
              title: `process kill refused: pid=${params.pid}`,
              metadata: {
                platform,
                backend,
                action,
                pid: params.pid,
                force: params.force ?? false,
                delivered: false,
                error: "refusing to kill system pid",
              },
              output: `Refusing to kill PID ${params.pid} — system process. Use bash explicitly if you really need to.`,
            })
          }

          yield* ctx.metadata({
            title: `kill ${params.pid}${params.force ? " /F" : ""}`,
            metadata: {
              platform,
              backend,
              action,
              pid: params.pid,
              force: params.force ?? false,
              delivered: false,
            },
          })

          const result = yield* Effect.promise(async () => {
            try {
              if (platform === "win32") return await killWindows(params.pid!, params.force ?? false, ctx.abort)
              return await killUnix(params.pid!, params.force ?? false, ctx.abort)
            } catch (err: unknown) {
              const msg = err instanceof Error ? err.message : String(err)
              return { code: null as number | null, stderr: msg, stdout: "" }
            }
          })

          const killed = result.code === 0
          return done({
            title: killed ? `killed ${params.pid}` : `kill ${params.pid} failed`,
            metadata: {
              platform,
              backend,
              action,
              pid: params.pid,
              force: params.force ?? false,
              killed,
              exit_code: result.code ?? undefined,
              delivered: killed,
              error: killed ? undefined : result.stderr.trim() || `exit=${result.code}`,
            },
            output: killed
              ? `Killed PID ${params.pid}${params.force ? " (forced)" : ""} via ${backend}.`
              : `Failed to kill PID ${params.pid} (${backend}, exit=${result.code}). ${result.stderr.trim() || ""}`,
          })
        }

        // action === "list"
        const pat = params.name_pattern?.toLowerCase()
        yield* ctx.metadata({
          title: pat ? `process list: ${pat}` : "process list (all)",
          metadata: {
            platform,
            backend,
            action,
            name_pattern: params.name_pattern,
            limit,
            delivered: false,
          },
        })

        const out = yield* Effect.promise(async () => {
          try {
            if (platform === "win32") return await listWindows(ctx.abort)
            return await listUnix(ctx.abort)
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err)
            return { rows: [] as ProcRow[], raw: "", error: msg }
          }
        })

        if (out.error) {
          return done({
            title: `process list failed`,
            metadata: {
              platform,
              backend,
              action,
              name_pattern: params.name_pattern,
              limit,
              delivered: false,
              error: out.error,
            },
            output: `Process listing failed (${backend}, ${platform}): ${out.error}. Continue without retrying.`,
          })
        }

        const total = out.rows.length
        let matched = pat ? out.rows.filter((r) => r.name.toLowerCase().includes(pat)) : out.rows
        const matchCount = matched.length
        if (matched.length > limit) matched = matched.slice(0, limit)

        const lines = matched.map((r) => {
          const cpu = r.cpu_percent !== undefined ? ` cpu=${r.cpu_percent.toFixed(1)}%` : ""
          const mem = r.rss_kb !== undefined ? ` rss=${r.rss_kb}KB` : ""
          return `  ${String(r.pid).padStart(7)} ${r.name}${cpu}${mem}`
        })
        const truncatedNote =
          matchCount > matched.length ? `\n… ${matchCount - matched.length} more rows truncated (limit=${limit}).` : ""

        return done({
          title: pat ? `process list ${pat} (${matchCount}/${total})` : `process list (${total} total)`,
          metadata: {
            platform,
            backend,
            action,
            name_pattern: params.name_pattern,
            limit,
            processes: matched,
            match_count: matchCount,
            total_seen: total,
            delivered: true,
          },
          output:
            matchCount === 0
              ? `No processes ${pat ? `matching "${pat}" ` : ""}found (${total} total seen).`
              : [
                  `${matchCount} process(es)${pat ? ` matching "${pat}"` : ""} (of ${total} total):`,
                  ...lines,
                  truncatedNote.trim(),
                ]
                  .filter(Boolean)
                  .join("\n"),
        })
      }),
  }),
)

export const __testing = { parseCsvLine, parseTasklistCsvLine, parsePsLine, runProcess }
