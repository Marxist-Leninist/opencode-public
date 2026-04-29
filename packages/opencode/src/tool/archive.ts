import { Effect, Schema } from "effect"
import { mkdir, stat as fsStat, readFile, readdir, writeFile } from "node:fs/promises"
import { createReadStream, createWriteStream } from "node:fs"
import * as path from "node:path"
import {
  ZipReader,
  ZipWriter,
  Uint8ArrayReader,
  Uint8ArrayWriter,
  TextReader,
  configure,
  terminateWorkers,
  type Entry,
} from "@zip.js/zip.js"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Instance } from "../project/instance"
import { assertExternalDirectoryEffect } from "./external-directory"
import DESCRIPTION from "./archive.txt"
import * as Tool from "./tool"

// zip.js spawns Web Workers by default. In Node/Bun that's slower than running
// in the main thread for the small-to-medium archives we use here, and worker
// startup also fails under bundled Bun binaries. Force single-threaded mode.
configure({ useWebWorkers: false })

const ACTIONS = ["list", "extract", "create"] as const
const DEFAULT_MAX_ENTRIES = 5_000
const DEFAULT_MAX_TOTAL_BYTES = 1024 * 1024 * 1024 // 1 GiB
const HARD_MAX_TOTAL_BYTES = 8 * 1024 * 1024 * 1024 // 8 GiB

export const Parameters = Schema.Struct({
  action: Schema.Literals(ACTIONS).annotate({
    description:
      "Action: 'list' enumerates entries (no writes), 'extract' writes entries into dest_dir, 'create' packs source_paths into a new zip at archive_path.",
  }),
  archive_path: Schema.String.check(Schema.isMinLength(1)).annotate({
    description:
      "Path to the .zip file. For 'list' and 'extract' it must already exist. For 'create' it must NOT exist (no clobber).",
  }),
  dest_dir: Schema.optional(Schema.String).annotate({
    description:
      "Required for 'extract'. Output directory. Created if it does not exist. Must be inside the project unless the user has authorized an external path.",
  }),
  source_paths: Schema.optional(Schema.Array(Schema.String)).annotate({
    description:
      "Required for 'create'. Files or directories to include in the new archive. Directories are walked recursively. Symlinks are followed via stat (no special symlink entries are written).",
  }),
  base_dir: Schema.optional(Schema.String).annotate({
    description:
      "Optional for 'create'. If set, source_paths are stored relative to this directory inside the zip. Defaults to the project directory.",
  }),
  name_pattern: Schema.optional(Schema.String.check(Schema.isMaxLength(512))).annotate({
    description:
      "Optional substring filter applied to entry names for 'list' and 'extract'. Case-insensitive. Useful when you only want a subset of a large archive.",
  }),
  max_entries: Schema.optional(
    Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(50_000)),
  ).annotate({
    description: `Hard cap on number of entries processed. Default ${DEFAULT_MAX_ENTRIES}, max 50000. Defends against zip bombs with millions of empty files.`,
  }),
  max_total_bytes: Schema.optional(
    Schema.Number.check(Schema.isInt())
      .check(Schema.isGreaterThanOrEqualTo(1024))
      .check(Schema.isLessThanOrEqualTo(HARD_MAX_TOTAL_BYTES)),
  ).annotate({
    description: `Hard cap on the total uncompressed bytes processed. Default ${DEFAULT_MAX_TOTAL_BYTES} (1 GiB). Defends against zip bombs.`,
  }),
})

type Params = Schema.Schema.Type<typeof Parameters>
type Action = (typeof ACTIONS)[number]

type ListedEntry = {
  name: string
  size_bytes: number
  compressed_bytes: number
  directory: boolean
  encrypted?: boolean
}

type Metadata = {
  action: Action
  archive_path: string
  archive_size_bytes?: number
  entry_count?: number
  total_uncompressed_bytes?: number
  entries?: ListedEntry[]
  extracted?: number
  skipped?: number
  dest_dir?: string
  base_dir?: string
  truncated?: boolean
  elapsed_ms?: number
  error?: string
}

const done = (result: Tool.ExecuteResult<Metadata>) => result

function resolveProjectPath(p: string): string {
  return path.isAbsolute(p) ? p : path.resolve(Instance.directory, p)
}

function isUnsafeEntryName(name: string): boolean {
  // Reject absolute paths, backslash absolute (Windows), drive letters, and any '..' segments.
  if (!name) return true
  if (name.startsWith("/") || name.startsWith("\\")) return true
  if (/^[A-Za-z]:[\\/]/.test(name)) return true
  // Normalize and inspect components.
  const norm = name.replace(/\\/g, "/")
  const parts = norm.split("/")
  for (const seg of parts) {
    if (seg === "..") return true
  }
  return false
}

function matchesPattern(name: string, pattern?: string): boolean {
  if (!pattern) return true
  return name.toLowerCase().includes(pattern.toLowerCase())
}

async function readZipEntries(archivePath: string): Promise<{ entries: Entry[]; size: number }> {
  const buf = await readFile(archivePath)
  const u8 = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
  const reader = new ZipReader(new Uint8ArrayReader(u8))
  try {
    const entries = await reader.getEntries()
    return { entries, size: buf.byteLength }
  } finally {
    try {
      await reader.close()
    } catch {
      /* noop */
    }
  }
}

async function listAction(
  archivePath: string,
  pattern: string | undefined,
  maxEntries: number,
): Promise<{
  entries: ListedEntry[]
  total_uncompressed_bytes: number
  archive_size_bytes: number
  truncated: boolean
}> {
  const { entries, size } = await readZipEntries(archivePath)
  const out: ListedEntry[] = []
  let total = 0
  let truncated = false
  for (const e of entries) {
    if (!matchesPattern(e.filename, pattern)) continue
    if (out.length >= maxEntries) {
      truncated = true
      break
    }
    const uncomp = Number((e as any).uncompressedSize ?? 0)
    const comp = Number((e as any).compressedSize ?? 0)
    out.push({
      name: e.filename,
      size_bytes: uncomp,
      compressed_bytes: comp,
      directory: !!e.directory,
      encrypted: (e as any).encrypted === true,
    })
    total += uncomp
  }
  return {
    entries: out,
    total_uncompressed_bytes: total,
    archive_size_bytes: size,
    truncated,
  }
}

async function extractAction(
  archivePath: string,
  destDir: string,
  pattern: string | undefined,
  maxEntries: number,
  maxTotalBytes: number,
  signal: AbortSignal,
): Promise<{
  extracted: number
  skipped: number
  total_uncompressed_bytes: number
  archive_size_bytes: number
}> {
  const { entries, size } = await readZipEntries(archivePath)
  await mkdir(destDir, { recursive: true })

  let extracted = 0
  let skipped = 0
  let totalBytes = 0
  let processed = 0
  const destResolved = path.resolve(destDir)

  for (const e of entries) {
    if (signal.aborted) throw new Error("archive: aborted")
    if (processed >= maxEntries) {
      throw new Error(
        `archive: too many entries (>${maxEntries}). Raise max_entries explicitly if intentional.`,
      )
    }
    processed++

    if (!matchesPattern(e.filename, pattern)) {
      skipped++
      continue
    }

    if (isUnsafeEntryName(e.filename)) {
      throw new Error(`archive: refusing to extract entry with unsafe path: ${e.filename}`)
    }

    const outPath = path.resolve(destResolved, e.filename.replace(/\\/g, "/"))
    // Defense in depth: ensure outPath is contained within destResolved.
    const rel = path.relative(destResolved, outPath)
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new Error(`archive: refusing to extract entry that escapes dest_dir: ${e.filename}`)
    }

    if (e.directory) {
      await mkdir(outPath, { recursive: true })
      extracted++
      continue
    }

    const uncomp = Number((e as any).uncompressedSize ?? 0)
    if (totalBytes + uncomp > maxTotalBytes) {
      throw new Error(
        `archive: extracted size would exceed max_total_bytes (${maxTotalBytes}). Stopped at entry: ${e.filename}`,
      )
    }

    await mkdir(path.dirname(outPath), { recursive: true })

    if (typeof e.getData !== "function") {
      // Empty/no-data entry — touch a zero-byte file.
      await writeFile(outPath, "")
      extracted++
      continue
    }

    const writer = new Uint8ArrayWriter()
    const data = await e.getData(writer)
    await writeFile(outPath, data)
    extracted++
    totalBytes += data.byteLength
  }

  return {
    extracted,
    skipped,
    total_uncompressed_bytes: totalBytes,
    archive_size_bytes: size,
  }
}

async function* walkFiles(
  root: string,
  signal: AbortSignal,
): AsyncGenerator<{ absPath: string; relName: string; isDir: boolean }> {
  const baseStat = await fsStat(root).catch(() => undefined)
  if (!baseStat) return
  if (baseStat.isFile()) {
    yield { absPath: root, relName: path.basename(root), isDir: false }
    return
  }
  // Directory: walk recursively; entry names are relative to `root`'s parent so
  // the directory becomes the top-level folder inside the zip.
  const top = path.basename(root)
  const stack: string[] = [root]
  while (stack.length > 0) {
    if (signal.aborted) throw new Error("archive: aborted")
    const cur = stack.pop()!
    let entries: import("node:fs").Dirent[]
    try {
      entries = await readdir(cur, { withFileTypes: true })
    } catch {
      continue
    }
    for (const ent of entries) {
      const abs = path.join(cur, ent.name)
      const rel = path.posix.join(top, path.relative(root, abs).replace(/\\/g, "/"))
      if (ent.isDirectory()) {
        yield { absPath: abs, relName: rel + "/", isDir: true }
        stack.push(abs)
      } else if (ent.isFile()) {
        yield { absPath: abs, relName: rel, isDir: false }
      }
    }
  }
}

async function createAction(
  archivePath: string,
  sources: readonly string[],
  baseDir: string,
  maxEntries: number,
  maxTotalBytes: number,
  signal: AbortSignal,
): Promise<{
  entry_count: number
  total_uncompressed_bytes: number
  archive_size_bytes: number
}> {
  const out = createWriteStream(archivePath)
  const writableStream = new WritableStream<Uint8Array>({
    write(chunk) {
      return new Promise<void>((resolve, reject) => {
        out.write(chunk, (err) => (err ? reject(err) : resolve()))
      })
    },
    close() {
      return new Promise<void>((resolve, reject) => {
        out.end((err: unknown) => (err ? reject(err as Error) : resolve()))
      })
    },
  })
  const writer = new ZipWriter(writableStream)

  let count = 0
  let totalBytes = 0
  try {
    for (const src of sources) {
      if (signal.aborted) throw new Error("archive: aborted")
      const abs = path.isAbsolute(src) ? src : path.resolve(baseDir, src)
      for await (const entry of walkFiles(abs, signal)) {
        if (count >= maxEntries) {
          throw new Error(
            `archive: too many entries (>${maxEntries}). Raise max_entries explicitly if intentional.`,
          )
        }
        if (entry.isDir) {
          await writer.add(entry.relName, new TextReader(""), { directory: true })
          count++
          continue
        }
        const buf = await readFile(entry.absPath)
        if (totalBytes + buf.byteLength > maxTotalBytes) {
          throw new Error(
            `archive: source size would exceed max_total_bytes (${maxTotalBytes}) at entry: ${entry.relName}`,
          )
        }
        const u8 = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
        await writer.add(entry.relName, new Uint8ArrayReader(u8))
        count++
        totalBytes += buf.byteLength
      }
    }
  } finally {
    try {
      await writer.close()
    } catch {
      /* noop — we've thrown above already */
    }
    try {
      await terminateWorkers()
    } catch {
      /* noop */
    }
  }

  const finalStat = await fsStat(archivePath).catch(() => undefined)
  return {
    entry_count: count,
    total_uncompressed_bytes: totalBytes,
    archive_size_bytes: Number(finalStat?.size ?? 0),
  }
}

export const ArchiveTool = Tool.define(
  "archive",
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Params, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const action = params.action
          const archivePath = resolveProjectPath(params.archive_path)
          const maxEntries = params.max_entries ?? DEFAULT_MAX_ENTRIES
          const maxTotalBytes = params.max_total_bytes ?? DEFAULT_MAX_TOTAL_BYTES
          const pattern = params.name_pattern

          if (action === "list") {
            yield* ctx.ask({
              permission: "read",
              patterns: [archivePath],
              always: ["*"],
              metadata: { action, archive_path: archivePath },
            })
            yield* assertExternalDirectoryEffect(ctx, archivePath, { kind: "file" })

            const info = yield* fs.stat(archivePath).pipe(Effect.catch(() => Effect.succeed(undefined)))
            if (!info) throw new Error(`archive: file not found: ${archivePath}`)

            yield* ctx.metadata({
              title: `archive list: ${path.basename(archivePath)}`,
              metadata: { action, archive_path: archivePath },
            })

            const start = Date.now()
            const r = yield* Effect.promise(() => listAction(archivePath, pattern, maxEntries))
            const elapsed_ms = Date.now() - start

            const previewLines = r.entries.slice(0, 25).map((e) => {
              const sizeKb = (e.size_bytes / 1024).toFixed(1)
              const flag = e.directory ? "d" : e.encrypted ? "e" : "-"
              return `  ${flag} ${sizeKb.padStart(10)} KB  ${e.name}`
            })
            const totalMb = (r.total_uncompressed_bytes / 1024 / 1024).toFixed(1)

            return done({
              title: `archive: ${r.entries.length} entries (${totalMb} MB)`,
              metadata: {
                action,
                archive_path: archivePath,
                archive_size_bytes: r.archive_size_bytes,
                entry_count: r.entries.length,
                total_uncompressed_bytes: r.total_uncompressed_bytes,
                entries: r.entries,
                truncated: r.truncated,
                elapsed_ms,
              },
              output: [
                `Archive: ${archivePath}`,
                `Entries: ${r.entries.length}${r.truncated ? " (truncated)" : ""}`,
                `Total uncompressed: ${totalMb} MB`,
                ...previewLines,
                ...(r.entries.length > previewLines.length
                  ? [`  ... and ${r.entries.length - previewLines.length} more`]
                  : []),
              ].join("\n"),
            })
          }

          if (action === "extract") {
            if (!params.dest_dir) {
              throw new Error("archive.extract: dest_dir is required")
            }
            const destDir = resolveProjectPath(params.dest_dir)

            yield* ctx.ask({
              permission: "write",
              patterns: [destDir + "/*"],
              always: ["*"],
              metadata: { action, archive_path: archivePath, dest_dir: destDir },
            })
            yield* assertExternalDirectoryEffect(ctx, archivePath, { kind: "file" })
            yield* assertExternalDirectoryEffect(ctx, destDir, { kind: "directory" })

            const info = yield* fs.stat(archivePath).pipe(Effect.catch(() => Effect.succeed(undefined)))
            if (!info) throw new Error(`archive: file not found: ${archivePath}`)

            yield* ctx.metadata({
              title: `archive extract: ${path.basename(archivePath)} → ${path.basename(destDir)}`,
              metadata: { action, archive_path: archivePath, dest_dir: destDir },
            })

            const start = Date.now()
            const r = yield* Effect.promise(() =>
              extractAction(archivePath, destDir, pattern, maxEntries, maxTotalBytes, ctx.abort),
            )
            const elapsed_ms = Date.now() - start
            const sizeMb = (r.total_uncompressed_bytes / 1024 / 1024).toFixed(1)

            return done({
              title: `archive extracted ${r.extracted} entries (${sizeMb} MB)`,
              metadata: {
                action,
                archive_path: archivePath,
                dest_dir: destDir,
                archive_size_bytes: r.archive_size_bytes,
                extracted: r.extracted,
                skipped: r.skipped,
                total_uncompressed_bytes: r.total_uncompressed_bytes,
                elapsed_ms,
              },
              output: [
                `Extracted ${r.extracted} entries (${sizeMb} MB)${r.skipped ? `, skipped ${r.skipped} by name_pattern` : ""}`,
                `Source: ${archivePath}`,
                `Dest:   ${destDir}`,
              ].join("\n"),
            })
          }

          // create
          if (!params.source_paths || params.source_paths.length === 0) {
            throw new Error("archive.create: source_paths is required and must be non-empty")
          }
          const baseDir = params.base_dir
            ? resolveProjectPath(params.base_dir)
            : Instance.directory
          const sources = params.source_paths.map((p) => (path.isAbsolute(p) ? p : path.resolve(baseDir, p)))

          // archive_path must NOT exist (avoid silent clobber).
          const existing = yield* fs.stat(archivePath).pipe(Effect.catch(() => Effect.succeed(undefined)))
          if (existing) {
            throw new Error(`archive.create: refusing to overwrite existing file: ${archivePath}`)
          }

          yield* ctx.ask({
            permission: "write",
            patterns: [archivePath],
            always: ["*"],
            metadata: { action, archive_path: archivePath, source_paths: sources, base_dir: baseDir },
          })
          yield* assertExternalDirectoryEffect(ctx, archivePath, { kind: "file" })
          for (const src of sources) {
            yield* assertExternalDirectoryEffect(ctx, src, { kind: "file" })
          }

          yield* Effect.promise(() => mkdir(path.dirname(archivePath), { recursive: true }))

          yield* ctx.metadata({
            title: `archive create: ${path.basename(archivePath)}`,
            metadata: { action, archive_path: archivePath, base_dir: baseDir },
          })

          const start = Date.now()
          const r = yield* Effect.promise(() =>
            createAction(archivePath, sources, baseDir, maxEntries, maxTotalBytes, ctx.abort),
          )
          const elapsed_ms = Date.now() - start
          const sizeMb = (r.archive_size_bytes / 1024 / 1024).toFixed(2)
          const uncompMb = (r.total_uncompressed_bytes / 1024 / 1024).toFixed(2)

          return done({
            title: `archive created: ${r.entry_count} entries → ${sizeMb} MB`,
            metadata: {
              action,
              archive_path: archivePath,
              base_dir: baseDir,
              archive_size_bytes: r.archive_size_bytes,
              entry_count: r.entry_count,
              total_uncompressed_bytes: r.total_uncompressed_bytes,
              elapsed_ms,
            },
            output: [
              `Created: ${archivePath}`,
              `Entries: ${r.entry_count}`,
              `Compressed:   ${sizeMb} MB`,
              `Uncompressed: ${uncompMb} MB`,
            ].join("\n"),
          })
        }),
    }
  }),
)

export const __testing = {
  isUnsafeEntryName,
  matchesPattern,
}
