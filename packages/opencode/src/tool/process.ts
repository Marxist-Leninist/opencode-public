import { Effect, Schema } from "effect"
import { spawn } from "node:child_process"
import { killTree } from "../shell/shell"
import DESCRIPTION from "./process.txt"
import * as Tool from "./tool"

const ACTIONS = ["list", "kill", "by_port", "info"] as const

export const Parameters = Schema.Struct({
  action: Schema.Literals(ACTIONS).annotate({
    description:
      "Action: 'list' to enumerate processes, 'kill' to terminate one, 'by_port' to find which process is listening on a TCP port, 'info' to look up a single PID by id.",
  }),
  name_pattern: Schema.optional(Schema.String.check(Schema.isMaxLength(200))).annotate({
    description: "Case-insensitive substring matched against the process image name (used by 'list').",
  }),
  pid: Schema.optional(Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))).annotate({
    description: "PID. Required for 'kill' or 'info'.",
  }),
  port: Schema.optional(Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(65535))).annotate({
    description: "TCP port. Required for 'by_port'. Returns processes whose local listening socket binds this port.",
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

type PortListener = {
  pid: number
  name?: string
  proto: "TCP" | "UDP"
  local_address: string
  port: number
}

type Metadata = {
  platform: NodeJS.Platform
  backend: string
  action: Action
  name_pattern?: string
  pid?: number
  port?: number
  force?: boolean
  limit?: number
  processes?: ProcRow[]
  listeners?: PortListener[]
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
    const childExited = () => child.exitCode !== null || child.signalCode !== null
    const stopChild = () => {
      void killTree(child, { exited: childExited }).catch(() => {
        try {
          child.kill()
        } catch {}
      })
    }
    const timer = setTimeout(() => {
      if (!settled) {
        stopChild()
        settled = true
        resolve({ code: null, stderr: "timeout", stdout: "" })
      }
    }, timeoutMs)
    const onAbort = () => {
      stopChild()
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

// Parse a Windows `netstat -ano -p TCP` line. Format (whitespace-separated):
//   "  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1344"
// Only LISTENING rows are interesting for "what's bound to port X".
export function parseNetstatTcpLine(line: string): PortListener | undefined {
  const trimmed = line.trim()
  if (!trimmed.startsWith("TCP") && !trimmed.startsWith("UDP")) return undefined
  const tokens = trimmed.split(/\s+/)
  if (tokens.length < 4) return undefined
  const proto = tokens[0] === "UDP" ? "UDP" : "TCP"
  const local = tokens[1]
  // For TCP, the row layout is: PROTO LOCAL FOREIGN STATE PID
  // For UDP, the layout is: PROTO LOCAL FOREIGN PID (no STATE column)
  let pidIdx = -1
  let stateOk = true
  if (proto === "TCP") {
    if (tokens.length < 5) return undefined
    if (tokens[3] !== "LISTENING") stateOk = false
    pidIdx = 4
  } else {
    pidIdx = 3
  }
  if (!stateOk) return undefined
  const pid = parseInt(tokens[pidIdx], 10)
  if (!Number.isFinite(pid)) return undefined
  // local is HOST:PORT, but IPv6 looks like [::1]:80 — split from the right.
  const colon = local.lastIndexOf(":")
  if (colon < 0) return undefined
  const host = local.slice(0, colon)
  const port = parseInt(local.slice(colon + 1), 10)
  if (!Number.isFinite(port)) return undefined
  return { pid, proto, local_address: host, port }
}

// Parse a `lsof -nP -iTCP -sTCP:LISTEN -F pcLn` line stream. lsof -F emits one field per line, prefixed:
//   p<pid>\nc<command>\n... n*:port (LISTEN)\n... TST=LISTEN
// We only need to keep state across lines: current pid + name + ports.
// We instead parse the simpler default `lsof -nP -iTCP:PORT -sTCP:LISTEN` table:
//   COMMAND PID  USER ... NAME
//   node 12345 user 23u IPv4 0xabc 0t0 TCP *:3000 (LISTEN)
export function parseLsofLine(line: string): PortListener | undefined {
  const trimmed = line.trim()
  if (!trimmed) return undefined
  if (/^COMMAND\s+PID/i.test(trimmed)) return undefined
  const tokens = trimmed.split(/\s+/)
  if (tokens.length < 9) return undefined
  const name = tokens[0]
  const pid = parseInt(tokens[1], 10)
  if (!Number.isFinite(pid)) return undefined
  const proto = tokens[7] === "UDP" ? "UDP" : "TCP"
  const addr = tokens[8]
  // addr is HOST:PORT, possibly *:PORT or [::]:PORT
  const colon = addr.lastIndexOf(":")
  if (colon < 0) return undefined
  const host = addr.slice(0, colon)
  const port = parseInt(addr.slice(colon + 1), 10)
  if (!Number.isFinite(port)) return undefined
  return { pid, name, proto, local_address: host, port }
}

// Parse a `ss -ltnpH` (no header) line on Linux.
// Format (LISTEN rows only since we passed -l):
//   LISTEN 0      4096      0.0.0.0:3000        0.0.0.0:*    users:(("node",pid=12345,fd=23))
export function parseSsLine(line: string): PortListener | undefined {
  const trimmed = line.trim()
  if (!trimmed) return undefined
  if (!/^LISTEN\b/i.test(trimmed)) return undefined
  const tokens = trimmed.split(/\s+/)
  if (tokens.length < 5) return undefined
  const local = tokens[3]
  const colon = local.lastIndexOf(":")
  if (colon < 0) return undefined
  const host = local.slice(0, colon)
  const port = parseInt(local.slice(colon + 1), 10)
  if (!Number.isFinite(port)) return undefined
  // The users column is everything from token 4 onward.
  const usersCol = tokens.slice(4).join(" ")
  const m = /pid=(\d+)/.exec(usersCol)
  const pid = m ? parseInt(m[1], 10) : NaN
  if (!Number.isFinite(pid)) return undefined
  const nameMatch = /\("([^"]+)",pid=/.exec(usersCol)
  const name = nameMatch?.[1]
  return { pid, name, proto: "TCP", local_address: host, port }
}

async function listenersWindows(port: number, signal: AbortSignal): Promise<{ rows: PortListener[]; raw: string; error?: string }> {
  const r = await runProcess("netstat", ["-ano", "-p", "TCP"], signal, 8000)
  if (r.code !== 0) return { rows: [], raw: r.stdout, error: r.stderr.trim() || `netstat exit=${r.code}` }
  const rows: PortListener[] = []
  for (const line of r.stdout.split(/\r?\n/)) {
    const row = parseNetstatTcpLine(line)
    if (row && row.port === port) rows.push(row)
  }
  return { rows, raw: r.stdout }
}

async function listenersUnix(port: number, signal: AbortSignal): Promise<{ rows: PortListener[]; raw: string; error?: string }> {
  // Prefer lsof — present on macOS by default, common on Linux. Fall back to ss on Linux when lsof is missing.
  const lsof = await runProcess("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"], signal, 8000)
  if (lsof.code === 0) {
    const rows: PortListener[] = []
    for (const line of lsof.stdout.split(/\r?\n/)) {
      const row = parseLsofLine(line)
      if (row && row.port === port) rows.push(row)
    }
    return { rows, raw: lsof.stdout }
  }
  // ss flags: -l listening, -t TCP, -n numeric, -p processes, -H no header
  const ss = await runProcess("ss", ["-ltnpH", `sport`, `=`, `:${port}`], signal, 8000)
  if (ss.code === 0) {
    const rows: PortListener[] = []
    for (const line of ss.stdout.split(/\r?\n/)) {
      const row = parseSsLine(line)
      if (row && row.port === port) rows.push(row)
    }
    return { rows, raw: ss.stdout }
  }
  return {
    rows: [],
    raw: lsof.stdout || ss.stdout,
    error: (lsof.stderr || ss.stderr || `lsof exit=${lsof.code}, ss exit=${ss.code}`).trim(),
  }
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

        if (action === "by_port") {
          if (params.port === undefined) {
            return done({
              title: "process by_port: missing port",
              metadata: { platform, backend, action, delivered: false, error: "port is required for by_port" },
              output: "Error: 'port' is required when action is 'by_port'.",
            })
          }
          yield* ctx.metadata({
            title: `port ${params.port} listener probe`,
            metadata: { platform, backend, action, port: params.port, delivered: false },
          })
          const out = yield* Effect.promise(async () => {
            try {
              if (platform === "win32") return await listenersWindows(params.port!, ctx.abort)
              return await listenersUnix(params.port!, ctx.abort)
            } catch (err: unknown) {
              const msg = err instanceof Error ? err.message : String(err)
              return { rows: [] as PortListener[], raw: "", error: msg }
            }
          })
          if (out.error && out.rows.length === 0) {
            return done({
              title: `port ${params.port} probe failed`,
              metadata: { platform, backend, action, port: params.port, delivered: false, error: out.error },
              output: `Port ${params.port} probe failed (${backend === "tasklist/taskkill" ? "netstat" : "lsof/ss"}, ${platform}): ${out.error}. On Linux without lsof, install procps/iproute2 or run as root.`,
            })
          }
          // For Windows, augment with names from tasklist (one tasklist call covers everyone).
          let listeners = out.rows
          if (listeners.length > 0 && platform === "win32") {
            const tl = yield* Effect.promise(() => listWindows(ctx.abort))
            const byPid = new Map(tl.rows.map((r) => [r.pid, r.name]))
            listeners = listeners.map((l) => ({ ...l, name: byPid.get(l.pid) ?? l.name }))
          }
          if (listeners.length === 0) {
            return done({
              title: `port ${params.port}: nothing listening`,
              metadata: { platform, backend, action, port: params.port, listeners: [], delivered: true },
              output: `No process is listening on TCP port ${params.port}.`,
            })
          }
          const lines = listeners.map((l) => `  ${String(l.pid).padStart(7)} ${l.name ?? "?"} (${l.proto} ${l.local_address}:${l.port})`)
          return done({
            title: `port ${params.port}: ${listeners.map((l) => l.pid).join(",")}`,
            metadata: { platform, backend, action, port: params.port, listeners, delivered: true },
            output: [`${listeners.length} listener(s) on TCP port ${params.port}:`, ...lines].join("\n"),
          })
        }

        if (action === "info") {
          if (params.pid === undefined) {
            return done({
              title: "process info: missing pid",
              metadata: { platform, backend, action, delivered: false, error: "pid is required for info" },
              output: "Error: 'pid' is required when action is 'info'.",
            })
          }
          yield* ctx.metadata({
            title: `process info ${params.pid}`,
            metadata: { platform, backend, action, pid: params.pid, delivered: false },
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
              title: `process info ${params.pid} failed`,
              metadata: { platform, backend, action, pid: params.pid, delivered: false, error: out.error },
              output: `Process listing failed (${backend}, ${platform}): ${out.error}.`,
            })
          }
          const row = out.rows.find((r) => r.pid === params.pid)
          if (!row) {
            return done({
              title: `pid ${params.pid} not found`,
              metadata: { platform, backend, action, pid: params.pid, processes: [], delivered: true },
              output: `No process with PID ${params.pid} (scanned ${out.rows.length} entries).`,
            })
          }
          const cpu = row.cpu_percent !== undefined ? ` cpu=${row.cpu_percent.toFixed(1)}%` : ""
          const mem = row.rss_kb !== undefined ? ` rss=${row.rss_kb}KB` : ""
          return done({
            title: `pid ${params.pid}: ${row.name}`,
            metadata: { platform, backend, action, pid: params.pid, processes: [row], delivered: true },
            output: `PID ${params.pid}: ${row.name}${cpu}${mem}`,
          })
        }

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

export const __testing = {
  parseCsvLine,
  parseTasklistCsvLine,
  parsePsLine,
  parseNetstatTcpLine,
  parseLsofLine,
  parseSsLine,
  runProcess,
}
