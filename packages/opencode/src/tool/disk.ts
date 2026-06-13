import { Effect, Schema } from "effect"
import { spawn } from "node:child_process"
import { statfs } from "node:fs/promises"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { killTree } from "../shell/shell"
import DESCRIPTION from "./disk.txt"
import * as Tool from "./tool"

const ACTIONS = ["volumes", "path", "usage"] as const

export const Parameters = Schema.Struct({
  action: Schema.Literals(ACTIONS)
    .pipe(Schema.optional, Schema.withDecodingDefault(Effect.succeed("volumes" as const)))
    .annotate({
      description:
        "Action: 'volumes' lists all mounted disks (default), 'path' reports free/total for a specific filesystem path, 'usage' totals the bytes used by a directory tree.",
    }),
  path: Schema.optional(Schema.String).annotate({
    description: "Absolute filesystem path. Required for 'path' and 'usage'.",
  }),
  top_n: Schema.optional(
    Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(50)),
  ).annotate({
    description: "How many largest files to return for 'usage'. Default 5, 0 disables the list, max 50.",
  }),
  max_depth: Schema.optional(
    Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(32)),
  ).annotate({
    description: "Recursion cap for 'usage'. Default 6, max 32.",
  }),
})

type Params = Schema.Schema.Type<typeof Parameters>
type Action = (typeof ACTIONS)[number]

type Volume = {
  mount: string
  total_bytes: number
  free_bytes: number
  used_bytes: number
  percent_used: number
  fs_type?: string
}

type PathReport = {
  mount: string
  total_bytes: number
  free_bytes: number
  used_bytes: number
  percent_used: number
}

type LargestFile = { path: string; size_bytes: number }

type Metadata = {
  platform: NodeJS.Platform
  action: Action
  backend?: string
  // volumes
  volumes?: Volume[]
  // path
  report?: PathReport
  resolved_path?: string
  // usage
  total_bytes?: number
  file_count?: number
  dir_count?: number
  top?: LargestFile[]
  truncated?: boolean
  errors?: number
  elapsed_ms?: number
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

// Parse a Windows `wmic logicaldisk get DeviceID,Size,FreeSpace,FileSystem /format:csv` row.
// Output looks like: Node,DeviceID,FileSystem,FreeSpace,Size
//                    HOSTNAME,C:,NTFS,123456789,987654321
export function parseWmicCsvLine(line: string): Volume | undefined {
  const cells = line.split(",").map((c) => c.trim())
  // node, deviceID, filesystem, freeSpace, size
  if (cells.length < 5) return undefined
  const deviceID = cells[1]
  if (!/^[A-Za-z]:$/.test(deviceID)) return undefined
  const fs_type = cells[2] || undefined
  const free_bytes = Number(cells[3])
  const total_bytes = Number(cells[4])
  if (!Number.isFinite(free_bytes) || !Number.isFinite(total_bytes) || total_bytes === 0) return undefined
  const used_bytes = Math.max(0, total_bytes - free_bytes)
  const percent_used = Math.round((used_bytes / total_bytes) * 1000) / 10
  return { mount: deviceID + "\\", total_bytes, free_bytes, used_bytes, percent_used, fs_type }
}

// Parse a `df -kP` row (POSIX portable). Header skipped by caller.
//   Filesystem 1024-blocks Used Available Capacity Mounted on
//   /dev/disk1   488245288 ...      ...     33%   /
export function parseDfPosixLine(line: string): Volume | undefined {
  const trimmed = line.trim()
  if (!trimmed) return undefined
  const tokens = trimmed.split(/\s+/)
  if (tokens.length < 6) return undefined
  const total_kb = Number(tokens[1])
  const used_kb = Number(tokens[2])
  const free_kb = Number(tokens[3])
  if (!Number.isFinite(total_kb) || !Number.isFinite(used_kb) || !Number.isFinite(free_kb)) return undefined
  const total_bytes = total_kb * 1024
  const used_bytes = used_kb * 1024
  const free_bytes = free_kb * 1024
  if (total_bytes === 0) return undefined
  const mount = tokens.slice(5).join(" ")
  const percent_used = Math.round((used_bytes / total_bytes) * 1000) / 10
  return { mount, total_bytes, free_bytes, used_bytes, percent_used }
}

async function listVolumesWindows(signal: AbortSignal): Promise<{ volumes: Volume[]; backend: string; error?: string }> {
  // Try wmic first — it's been deprecated in Windows 11 24H2+ but still ships on most installs and is the easiest CSV.
  const wmic = await runProcess(
    "wmic",
    ["logicaldisk", "get", "DeviceID,Size,FreeSpace,FileSystem", "/format:csv"],
    signal,
    8000,
  )
  if (wmic.code === 0 && wmic.stdout.trim()) {
    const volumes: Volume[] = []
    for (const line of wmic.stdout.split(/\r?\n/)) {
      if (!line.trim()) continue
      if (/^Node,/i.test(line)) continue
      const v = parseWmicCsvLine(line)
      if (v) volumes.push(v)
    }
    if (volumes.length > 0) return { volumes, backend: "wmic" }
  }
  // Fallback: PowerShell Get-PSDrive (filesystem only)
  const psScript =
    "Get-PSDrive -PSProvider FileSystem | ForEach-Object { '{0},{1},{2}' -f $_.Root,$_.Used,$_.Free }"
  const ps = await runProcess(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", psScript],
    signal,
    8000,
  )
  if (ps.code !== 0) {
    return { volumes: [], backend: "powershell", error: ps.stderr.trim() || `exit=${ps.code}` }
  }
  const volumes: Volume[] = []
  for (const line of ps.stdout.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const cells = trimmed.split(",")
    if (cells.length < 3) continue
    const mount = cells[0]
    const used_bytes = Number(cells[1])
    const free_bytes = Number(cells[2])
    if (!Number.isFinite(used_bytes) || !Number.isFinite(free_bytes)) continue
    const total_bytes = used_bytes + free_bytes
    if (total_bytes === 0) continue
    const percent_used = Math.round((used_bytes / total_bytes) * 1000) / 10
    volumes.push({ mount, total_bytes, free_bytes, used_bytes, percent_used })
  }
  return { volumes, backend: "powershell" }
}

async function listVolumesUnix(signal: AbortSignal): Promise<{ volumes: Volume[]; backend: string; error?: string }> {
  const r = await runProcess("df", ["-kP"], signal, 8000)
  if (r.code !== 0) {
    return { volumes: [], backend: "df", error: r.stderr.trim() || `exit=${r.code}` }
  }
  const lines = r.stdout.split(/\r?\n/)
  const volumes: Volume[] = []
  let seenHeader = false
  for (const line of lines) {
    if (!line.trim()) continue
    if (!seenHeader) {
      seenHeader = true
      continue
    }
    const v = parseDfPosixLine(line)
    if (v) volumes.push(v)
  }
  return { volumes, backend: "df" }
}

async function reportPath(absPath: string): Promise<PathReport> {
  // Node's statfs gives us per-mount block info. f_bavail is what an unprivileged user can use.
  const s = await statfs(absPath)
  const blockSize = Number(s.bsize)
  const total_bytes = Number(s.blocks) * blockSize
  const free_bytes = Number(s.bavail ?? s.bfree) * blockSize
  const used_bytes = Math.max(0, total_bytes - free_bytes)
  const percent_used = total_bytes > 0 ? Math.round((used_bytes / total_bytes) * 1000) / 10 : 0
  // Mount root: cheap heuristic is the path itself; refining requires platform-specific lookups.
  const mount = process.platform === "win32" ? absPath.slice(0, 3) : "/"
  return { mount, total_bytes, free_bytes, used_bytes, percent_used }
}

type UsageWalk = {
  total_bytes: number
  file_count: number
  dir_count: number
  top: LargestFile[]
  errors: number
  truncated: boolean
}

async function walkUsage(root: string, top_n: number, max_depth: number, signal: AbortSignal): Promise<UsageWalk> {
  const result: UsageWalk = { total_bytes: 0, file_count: 0, dir_count: 0, top: [], errors: 0, truncated: false }
  const heap: LargestFile[] = []

  async function walk(dir: string, depth: number) {
    if (signal.aborted) {
      result.truncated = true
      return
    }
    if (depth > max_depth) {
      result.truncated = true
      return
    }
    let entries: import("node:fs").Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      result.errors++
      return
    }
    result.dir_count++
    for (const entry of entries) {
      if (signal.aborted) {
        result.truncated = true
        return
      }
      const full = path.join(dir, entry.name)
      try {
        if (entry.isSymbolicLink()) {
          // Skip symlinks/junctions to avoid loops + double-counting.
          continue
        }
        if (entry.isDirectory()) {
          await walk(full, depth + 1)
        } else if (entry.isFile()) {
          const stat = await fs.stat(full)
          const size = Number(stat.size ?? 0)
          result.total_bytes += size
          result.file_count++
          if (top_n > 0) {
            if (heap.length < top_n) {
              heap.push({ path: full, size_bytes: size })
              heap.sort((a, b) => b.size_bytes - a.size_bytes)
            } else if (size > heap[heap.length - 1].size_bytes) {
              heap[heap.length - 1] = { path: full, size_bytes: size }
              heap.sort((a, b) => b.size_bytes - a.size_bytes)
            }
          }
        }
      } catch {
        result.errors++
      }
    }
  }

  await walk(root, 0)
  result.top = heap
  return result
}

function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "?"
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  if (n < 1024 * 1024 * 1024 * 1024) return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
  return `${(n / 1024 / 1024 / 1024 / 1024).toFixed(2)} TB`
}

export const DiskTool = Tool.define(
  "disk",
  Effect.succeed({
    description: DESCRIPTION,
    parameters: Parameters,
    execute: (params: Params, ctx: Tool.Context<Metadata>) =>
      Effect.gen(function* () {
        const action: Action = params.action ?? "volumes"
        const platform = process.platform
        const start = Date.now()

        yield* ctx.metadata({
          title: `disk: ${action}`,
          metadata: { platform, action },
        })

        if (action === "volumes") {
          const r = yield* Effect.promise(() =>
            platform === "win32" ? listVolumesWindows(ctx.abort) : listVolumesUnix(ctx.abort),
          )
          const elapsed_ms = Date.now() - start
          const lines = r.volumes.map(
            (v) =>
              `  ${v.mount.padEnd(8)} ${fmtBytes(v.free_bytes).padStart(10)} free / ${fmtBytes(v.total_bytes).padStart(10)} total (${v.percent_used}% used${v.fs_type ? `, ${v.fs_type}` : ""})`,
          )
          const output =
            r.volumes.length > 0
              ? [`Volumes (${r.backend}):`, ...lines].join("\n")
              : `No volumes returned (${r.backend}). ${r.error ?? ""}`.trim()
          return done({
            title: r.volumes.length > 0 ? `${r.volumes.length} volumes` : "no volumes",
            metadata: {
              platform,
              action,
              backend: r.backend,
              volumes: r.volumes,
              elapsed_ms,
              error: r.error,
            },
            output,
          })
        }

        if (action === "path") {
          if (!params.path) {
            return done({
              title: "disk path: missing path",
              metadata: { platform, action, error: "path is required for action='path'" },
              output: "Error: 'path' is required when action is 'path'.",
            })
          }
          const abs = path.isAbsolute(params.path) ? params.path : path.resolve(params.path)
          const report = yield* Effect.promise(async () => {
            try {
              return await reportPath(abs)
            } catch (err) {
              return { _failed: true as const, error: err instanceof Error ? err.message : String(err) }
            }
          })
          if ("_failed" in report) {
            return done({
              title: `disk path failed: ${path.basename(abs)}`,
              metadata: { platform, action, resolved_path: abs, error: report.error },
              output: `Could not stat path ${abs}: ${report.error}`,
            })
          }
          const elapsed_ms = Date.now() - start
          return done({
            title: `${fmtBytes(report.free_bytes)} free on ${report.mount}`,
            metadata: {
              platform,
              action,
              resolved_path: abs,
              report,
              elapsed_ms,
            },
            output: [
              `Disk report for ${abs} (mount=${report.mount}):`,
              `  total: ${fmtBytes(report.total_bytes)} (${report.total_bytes} bytes)`,
              `  used:  ${fmtBytes(report.used_bytes)} (${report.percent_used}%)`,
              `  free:  ${fmtBytes(report.free_bytes)}`,
            ].join("\n"),
          })
        }

        // action === "usage"
        if (!params.path) {
          return done({
            title: "disk usage: missing path",
            metadata: { platform, action, error: "path is required for action='usage'" },
            output: "Error: 'path' is required when action is 'usage'.",
          })
        }
        const abs = path.isAbsolute(params.path) ? params.path : path.resolve(params.path)
        const top_n = params.top_n ?? 5
        const max_depth = params.max_depth ?? 6

        const stat = yield* Effect.promise(async () => {
          try {
            return await fs.stat(abs)
          } catch (err) {
            return { _failed: true as const, error: err instanceof Error ? err.message : String(err) }
          }
        })
        if ("_failed" in stat) {
          return done({
            title: `disk usage failed`,
            metadata: { platform, action, resolved_path: abs, error: stat.error },
            output: `Could not stat path ${abs}: ${stat.error}`,
          })
        }
        if (!stat.isDirectory()) {
          return done({
            title: `disk usage: not a directory`,
            metadata: { platform, action, resolved_path: abs, error: "not a directory" },
            output: `Path is not a directory: ${abs}`,
          })
        }

        const walk = yield* Effect.promise(() => walkUsage(abs, top_n, max_depth, ctx.abort))
        const elapsed_ms = Date.now() - start
        const topLines = walk.top.map((t) => `  ${fmtBytes(t.size_bytes).padStart(10)}  ${t.path}`)
        const output = [
          `Usage of ${abs} (depth<=${max_depth}, top=${top_n}):`,
          `  total: ${fmtBytes(walk.total_bytes)} (${walk.total_bytes} bytes)`,
          `  files: ${walk.file_count}, dirs: ${walk.dir_count}, errors: ${walk.errors}${walk.truncated ? ", TRUNCATED" : ""}`,
          ...(topLines.length ? ["  largest:", ...topLines] : []),
        ].join("\n")
        return done({
          title: `${fmtBytes(walk.total_bytes)} in ${walk.file_count} files`,
          metadata: {
            platform,
            action,
            resolved_path: abs,
            total_bytes: walk.total_bytes,
            file_count: walk.file_count,
            dir_count: walk.dir_count,
            top: walk.top,
            truncated: walk.truncated,
            errors: walk.errors,
            elapsed_ms,
          },
          output,
        })
      }),
  }),
)

export const __testing = { parseWmicCsvLine, parseDfPosixLine, fmtBytes, walkUsage, reportPath }
