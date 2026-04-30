import { Effect, Schema } from "effect"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { InstanceState } from "@/effect"
import { assertExternalDirectoryEffect } from "./external-directory"
import DESCRIPTION from "./tree.txt"
import * as Tool from "./tool"

const SORTS = ["name", "size_desc", "mtime_desc"] as const

const DEFAULT_EXCLUDES = [
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "target",
  "__pycache__",
  ".venv",
  "venv",
  ".cache",
  "coverage",
]

export const Parameters = Schema.Struct({
  path: Schema.String.annotate({
    description: "Directory to walk. Required. Relative paths resolve against the current working directory.",
  }),
  max_depth: Schema.optional(
    Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(16)),
  ).annotate({ description: "Recursion cap. Default 4. Range 1..16." }),
  max_entries: Schema.optional(
    Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(10000)),
  ).annotate({ description: "Cap on total files+dirs returned. Default 500." }),
  dirs_only: Schema.optional(Schema.Boolean).annotate({
    description: "If true, omit regular files.",
  }),
  show_hidden: Schema.optional(Schema.Boolean).annotate({
    description: "If true, include entries starting with `.`",
  }),
  pattern: Schema.optional(Schema.String).annotate({
    description: "Case-insensitive substring filter on entry basename.",
  }),
  exclude: Schema.optional(Schema.Array(Schema.String)).annotate({
    description:
      "Array of substrings; matching entries are skipped. Default excludes common noise (node_modules, .git, dist, etc.).",
  }),
  sort: Schema.optional(Schema.Literals(SORTS)).annotate({
    description: "name (default), size_desc, or mtime_desc.",
  }),
  show_size: Schema.optional(Schema.Boolean).annotate({
    description: "If true, append `(<bytes>)` next to each file.",
  }),
})

type Params = Schema.Schema.Type<typeof Parameters>

type Metadata = {
  dirs: number
  files: number
  truncated: boolean
  root: string
  bytes_total?: number
}

type Entry = {
  name: string
  full: string
  isDir: boolean
  isSymlink: boolean
  size: number
  mtime: number
}

async function readEntries(dir: string): Promise<{ entries: Entry[]; error?: string }> {
  let dirents: import("node:fs").Dirent[]
  try {
    dirents = await fs.readdir(dir, { withFileTypes: true })
  } catch (err: unknown) {
    return { entries: [], error: ((err as NodeJS.ErrnoException).code ?? "EUNKNOWN") }
  }
  const entries: Entry[] = []
  for (const d of dirents) {
    const full = path.join(dir, d.name)
    let size = 0
    let mtime = 0
    let isDir = d.isDirectory()
    const isSymlink = d.isSymbolicLink()
    try {
      // Use lstat so symlink targets aren't followed (cycle protection).
      const st = await fs.lstat(full)
      size = st.isFile() ? st.size : 0
      mtime = st.mtimeMs
      if (!isDir && !isSymlink) isDir = st.isDirectory()
    } catch {
      // ignore: stat failed; keep zeros.
    }
    entries.push({ name: d.name, full, isDir, isSymlink, size, mtime })
  }
  return { entries }
}

function shouldIncludeName(
  name: string,
  full: string,
  opts: { showHidden: boolean; pattern?: string; excludes: string[]; isDir?: boolean },
): boolean {
  if (!opts.showHidden && name.startsWith(".")) return false
  // Pattern filters file basenames only - directories are always traversed so
  // the user can see files matching the pattern at any depth.
  if (opts.pattern && opts.isDir !== true && !name.toLowerCase().includes(opts.pattern.toLowerCase())) return false
  for (const ex of opts.excludes) {
    if (!ex) continue
    if (name === ex) return false
    if (name.includes(ex)) return false
    if (full.includes(ex)) return false
  }
  return true
}

function sortEntries(entries: Entry[], sort: (typeof SORTS)[number]): Entry[] {
  const dirs = entries.filter((e) => e.isDir)
  const files = entries.filter((e) => !e.isDir)
  const cmpName = (a: Entry, b: Entry) => a.name.localeCompare(b.name, "en", { sensitivity: "base" })
  if (sort === "name") {
    dirs.sort(cmpName)
    files.sort(cmpName)
  } else if (sort === "size_desc") {
    dirs.sort(cmpName) // size on dirs is meaningless; keep alpha
    files.sort((a, b) => b.size - a.size || cmpName(a, b))
  } else if (sort === "mtime_desc") {
    dirs.sort((a, b) => b.mtime - a.mtime || cmpName(a, b))
    files.sort((a, b) => b.mtime - a.mtime || cmpName(a, b))
  }
  return [...dirs, ...files]
}

type RenderState = {
  lines: string[]
  dirs: number
  files: number
  emitted: number
  bytesTotal: number
  truncated: boolean
}

async function render(
  dir: string,
  prefix: string,
  depth: number,
  opts: {
    maxDepth: number
    maxEntries: number
    dirsOnly: boolean
    showHidden: boolean
    showSize: boolean
    pattern?: string
    excludes: string[]
    sort: (typeof SORTS)[number]
  },
  state: RenderState,
): Promise<void> {
  if (state.truncated) return
  if (depth > opts.maxDepth) return
  const { entries, error } = await readEntries(dir)
  if (error) {
    if (state.emitted < opts.maxEntries) {
      state.lines.push(`${prefix}${path.basename(dir)} (error: ${error})`)
      state.emitted++
    } else {
      state.truncated = true
    }
    return
  }
  const filtered = entries.filter((e) =>
    shouldIncludeName(e.name, e.full, {
      showHidden: opts.showHidden,
      pattern: opts.pattern,
      excludes: opts.excludes,
      isDir: e.isDir,
    }),
  )
  // dirs_only filters out files but keeps dirs so we can still recurse.
  const display = opts.dirsOnly ? filtered.filter((e) => e.isDir) : filtered
  const sorted = sortEntries(display, opts.sort)
  for (let i = 0; i < sorted.length; i++) {
    if (state.truncated) return
    const e = sorted[i]!
    const last = i === sorted.length - 1
    const branch = last ? "`-- " : "|-- "
    const childPrefix = prefix + (last ? "    " : "|   ")
    if (state.emitted >= opts.maxEntries) {
      state.truncated = true
      return
    }
    const sizeSuffix = opts.showSize && !e.isDir ? ` (${e.size})` : ""
    const symMark = e.isSymlink ? "@" : ""
    state.lines.push(`${prefix}${branch}${e.name}${symMark}${sizeSuffix}`)
    state.emitted++
    if (e.isDir) {
      state.dirs++
      if (!e.isSymlink && depth < opts.maxDepth) {
        await render(e.full, childPrefix, depth + 1, opts, state)
      }
    } else {
      state.files++
      state.bytesTotal += e.size
    }
  }
}

export const TreeTool = Tool.define(
  "tree",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Params, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const ins = yield* InstanceState.context
          const requested = params.path
          const root = path.isAbsolute(requested) ? requested : path.resolve(ins.directory, requested)
          yield* assertExternalDirectoryEffect(ctx, root, { kind: "directory" })

          let st: import("node:fs").Stats
          try {
            st = yield* Effect.promise(() => fs.stat(root))
          } catch (err: unknown) {
            throw new Error(`tree: cannot stat '${root}': ${(err as Error).message}`)
          }
          if (!st.isDirectory()) throw new Error(`tree: '${root}' is not a directory`)

          yield* ctx.ask({
            permission: "read",
            patterns: [root],
            always: ["*"],
            metadata: {},
          })

          const excludes = params.exclude ? [...params.exclude] : DEFAULT_EXCLUDES
          const state: RenderState = {
            lines: [root],
            dirs: 0,
            files: 0,
            emitted: 1, // root itself counts
            bytesTotal: 0,
            truncated: false,
          }
          yield* Effect.promise(() =>
            render(
              root,
              "",
              1,
              {
                maxDepth: params.max_depth ?? 4,
                maxEntries: params.max_entries ?? 500,
                dirsOnly: params.dirs_only ?? false,
                showHidden: params.show_hidden ?? false,
                showSize: params.show_size ?? false,
                pattern: params.pattern,
                excludes,
                sort: params.sort ?? "name",
              },
              state,
            ),
          )
          if (state.truncated) {
            state.lines.push(`... (truncated at max_entries=${params.max_entries ?? 500})`)
          }

          const meta: Metadata = {
            dirs: state.dirs,
            files: state.files,
            truncated: state.truncated,
            root,
            ...(params.show_size ? { bytes_total: state.bytesTotal } : {}),
          }
          const title = `${path.basename(root) || root} (${state.dirs} dirs, ${state.files} files${state.truncated ? ", truncated" : ""})`
          return {
            title,
            metadata: meta,
            output: state.lines.join("\n"),
          }
        }),
    }
  }),
)

export const __testing = {
  DEFAULT_EXCLUDES,
  shouldIncludeName,
  sortEntries,
  readEntries,
  render,
}
