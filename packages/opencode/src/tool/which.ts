import { Effect, Schema } from "effect"
import { stat as fsStat } from "node:fs/promises"
import * as path from "node:path"
import DESCRIPTION from "./which.txt"
import * as Tool from "./tool"

const ACTIONS = ["find", "all", "has"] as const

export const Parameters = Schema.Struct({
  action: Schema.Literals(ACTIONS).annotate({
    description: "Action: 'find' (first hit + limit-1 more), 'all' (every hit), 'has' (boolean only).",
  }),
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(255)).annotate({
    description: "Executable name. Must not contain path separators ('/' or '\\\\').",
  }),
  path_override: Schema.optional(Schema.String.check(Schema.isMaxLength(8192))).annotate({
    description:
      "Explicit PATH string to use instead of process.env.PATH. Use platform separator (';' on Windows, ':' on POSIX).",
  }),
  extra_paths: Schema.optional(Schema.Array(Schema.String.check(Schema.isMaxLength(2048)))).annotate({
    description: "Optional list of additional absolute directories searched after the resolved PATH.",
  }),
  limit: Schema.optional(
    Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(256)),
  ).annotate({
    description: "Cap. Default 1 for 'find', 32 for 'all'. Max 256.",
  }),
})

type Params = Schema.Schema.Type<typeof Parameters>
type Action = (typeof ACTIONS)[number]

type Match = {
  path: string
  exists: boolean
  executable: boolean
  ext_used?: string
}

type Metadata = {
  action: Action
  name: string
  platform: NodeJS.Platform
  found: boolean
  matches: Match[]
  searched_path_count: number
  pathext?: string[]
  truncated?: boolean
}

const SEPARATOR = process.platform === "win32" ? ";" : ":"

function defaultPathext(): string[] {
  if (process.platform !== "win32") return [""]
  const raw = process.env.PATHEXT
  if (!raw) return [".COM", ".EXE", ".BAT", ".CMD", ".VBS", ".JS", ".PS1"]
  return raw
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean)
}

function splitPath(value: string): string[] {
  return value
    .split(SEPARATOR)
    .map((s) => s.trim())
    .filter(Boolean)
}

function nameHasSeparator(name: string): boolean {
  return name.includes("/") || name.includes("\\")
}

async function statExec(filepath: string): Promise<{ exists: boolean; executable: boolean }> {
  try {
    const st = await fsStat(filepath)
    if (!st.isFile()) return { exists: false, executable: false }
    if (process.platform === "win32") return { exists: true, executable: true }
    // On POSIX a regular file is "executable" if any of u/g/o have +x.
    const mode = st.mode
    const executable = (mode & 0o111) !== 0
    return { exists: true, executable }
  } catch {
    return { exists: false, executable: false }
  }
}

async function probeOne(dir: string, name: string, exts: string[]): Promise<Match | undefined> {
  // Honor the pre-existing extension on Windows. If the name already ends in a known PATHEXT,
  // try it as-is first and then with each ext appended only if the bare-name probe misses.
  const baseProbe = await statExec(path.join(dir, name))
  if (baseProbe.exists && baseProbe.executable) {
    return { path: path.join(dir, name), exists: true, executable: true, ext_used: path.extname(name) || undefined }
  }
  for (const ext of exts) {
    if (!ext) continue
    const full = path.join(dir, name + ext)
    const r = await statExec(full)
    if (r.exists && r.executable) {
      return { path: full, exists: true, executable: true, ext_used: ext }
    }
  }
  return undefined
}

async function search(params: Params, action: Action, limit: number): Promise<Metadata> {
  if (nameHasSeparator(params.name)) {
    throw new Error(`'name' must not contain path separators: ${params.name}`)
  }
  const rawPath = params.path_override ?? process.env.PATH ?? ""
  const dirs = splitPath(rawPath)
  const extra = (params.extra_paths ?? []).map((p) => String(p)).filter(Boolean)
  const allDirs = [...dirs, ...extra]
  const exts = defaultPathext()

  const matches: Match[] = []
  let stopAfter = limit
  if (action === "has") stopAfter = 1
  if (action === "find") stopAfter = limit
  // 'all' iterates all dirs, capped at limit hits.

  for (const dir of allDirs) {
    if (matches.length >= stopAfter) break
    const hit = await probeOne(dir, params.name, exts)
    if (hit) matches.push(hit)
  }

  return {
    action,
    name: params.name,
    platform: process.platform,
    found: matches.length > 0,
    matches,
    searched_path_count: allDirs.length,
    pathext: process.platform === "win32" ? exts : undefined,
    truncated: matches.length >= stopAfter && action !== "has",
  }
}

const done = (result: Tool.ExecuteResult<Metadata>) => result

export const WhichTool = Tool.define(
  "which",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Params, _ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const action = params.action
          const limit = params.limit ?? (action === "find" ? 1 : action === "all" ? 32 : 1)

          const meta = yield* Effect.promise(() => search(params, action, limit))

          if (action === "has") {
            return done({
              title: `which has ${params.name}: ${meta.found}`,
              metadata: meta,
              output: meta.found ? "true" : "false",
            })
          }

          if (!meta.found) {
            return done({
              title: `which ${action} ${params.name}: not found (${meta.searched_path_count} dirs)`,
              metadata: meta,
              output: `not found in PATH (${meta.searched_path_count} directories)`,
            })
          }

          const lines = meta.matches.map((m) => m.path)
          const suffix = meta.truncated ? `\n... (truncated; raise limit to see more)` : ""
          return done({
            title: `which ${action} ${params.name}: ${meta.matches.length} match${meta.matches.length === 1 ? "" : "es"}`,
            metadata: meta,
            output: lines.join("\n") + suffix,
          })
        }),
    }
  }),
)

export const __testing = { defaultPathext, splitPath, statExec, probeOne, nameHasSeparator, search }
