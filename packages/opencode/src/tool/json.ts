import { Effect, Schema } from "effect"
import { readFile, writeFile, stat as fsStat } from "node:fs/promises"
import * as path from "node:path"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Instance } from "../project/instance"
import { assertExternalDirectoryEffect } from "./external-directory"
import DESCRIPTION from "./json.txt"
import * as Tool from "./tool"

const ACTIONS = ["get", "set", "delete", "has", "type", "keys", "merge"] as const
const MAX_FILE_BYTES = 64 * 1024 * 1024 // 64 MiB — enormous JSON; refuses bigger to keep memory bounded.
const MAX_OUTPUT_CHARS = 16_000

export const Parameters = Schema.Struct({
  action: Schema.Literals(ACTIONS).annotate({
    description:
      "Action: 'get' returns the value at path; 'set' replaces the value at path (writes file); 'delete' removes the value at path (writes file); 'has' returns boolean existence; 'type' returns the JSON type at path; 'keys' lists object keys at path; 'merge' deep-merges a value object into the value at path (writes file).",
  }),
  filePath: Schema.String.check(Schema.isMinLength(1)).annotate({
    description:
      "Path to the JSON file. Absolute preferred; relative paths resolve from the project directory. The file must exist.",
  }),
  path: Schema.optional(Schema.String).annotate({
    description:
      "Dot/bracket path into the JSON, e.g. 'foo.bar', 'foo.bar[0]', or '$.foo.bar'. Empty string or '.' or '$' means the root. For 'set'/'delete', this is required and must be non-empty (refuses to overwrite the whole file with a single set call).",
  }),
  value: Schema.optional(Schema.Unknown).annotate({
    description:
      "Required for 'set' and 'merge'. Any JSON value (string, number, boolean, null, array, object). For 'merge' it MUST be an object. The serialized representation is what is written to disk.",
  }),
  pretty: Schema.optional(Schema.Boolean).annotate({
    description:
      "When writing the file (set/delete/merge), pretty-print with 2-space indentation. Default true.",
  }),
  create_missing: Schema.optional(Schema.Boolean).annotate({
    description:
      "For 'set'/'merge': if true (default), missing intermediate object/array steps are created. If false, the action fails when the path doesn't already exist.",
  }),
})

type Params = Schema.Schema.Type<typeof Parameters>
type Action = (typeof ACTIONS)[number]

type Metadata = {
  action: Action
  filePath: string
  path?: string
  found?: boolean
  written?: boolean
  size_bytes_before?: number
  size_bytes_after?: number
  json_type?: "string" | "number" | "boolean" | "null" | "array" | "object" | "undefined"
  elapsed_ms?: number
  // For 'keys' action.
  keys?: string[]
  // For 'has'.
  has?: boolean
}

const done = (result: Tool.ExecuteResult<Metadata>) => result

type Segment = { kind: "key"; key: string } | { kind: "index"; index: number }

export function parsePath(input: string | undefined): Segment[] {
  if (!input) return []
  let s = input.trim()
  if (s === "" || s === "." || s === "$") return []
  if (s.startsWith("$")) s = s.slice(1)
  if (s.startsWith(".")) s = s.slice(1)

  const segments: Segment[] = []
  let i = 0
  while (i < s.length) {
    if (s[i] === ".") {
      i++
      continue
    }
    if (s[i] === "[") {
      const end = s.indexOf("]", i)
      if (end === -1) throw new Error(`json.path: unterminated bracket in '${input}'`)
      const inner = s.slice(i + 1, end).trim()
      if (inner.length === 0) throw new Error(`json.path: empty bracket in '${input}'`)
      // Quoted key: ['foo bar'] or ["foo bar"]
      if (
        (inner.startsWith("'") && inner.endsWith("'")) ||
        (inner.startsWith('"') && inner.endsWith('"'))
      ) {
        segments.push({ kind: "key", key: inner.slice(1, -1) })
      } else if (/^-?\d+$/.test(inner)) {
        segments.push({ kind: "index", index: Number(inner) })
      } else {
        // Bare bracket key (e.g. [foo]) — treat as key.
        segments.push({ kind: "key", key: inner })
      }
      i = end + 1
      continue
    }
    // Read until next '.' or '['
    let j = i
    while (j < s.length && s[j] !== "." && s[j] !== "[") j++
    const key = s.slice(i, j)
    if (key.length > 0) segments.push({ kind: "key", key })
    i = j
  }
  return segments
}

export function jsonTypeOf(v: unknown): NonNullable<Metadata["json_type"]> {
  if (v === null) return "null"
  if (Array.isArray(v)) return "array"
  if (v === undefined) return "undefined"
  const t = typeof v
  if (t === "string" || t === "number" || t === "boolean" || t === "object") return t
  return "undefined"
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

function getAt(root: unknown, segs: Segment[]): { found: boolean; value: unknown } {
  let cur: unknown = root
  for (const seg of segs) {
    if (seg.kind === "key") {
      if (!isPlainObject(cur)) return { found: false, value: undefined }
      if (!Object.prototype.hasOwnProperty.call(cur, seg.key)) return { found: false, value: undefined }
      cur = (cur as Record<string, unknown>)[seg.key]
    } else {
      if (!Array.isArray(cur)) return { found: false, value: undefined }
      const idx = seg.index < 0 ? cur.length + seg.index : seg.index
      if (idx < 0 || idx >= cur.length) return { found: false, value: undefined }
      cur = cur[idx]
    }
  }
  return { found: true, value: cur }
}

function setAt(root: unknown, segs: Segment[], value: unknown, createMissing: boolean): unknown {
  if (segs.length === 0) {
    return value
  }
  // Clone-on-write at each step so we don't mutate the caller's object.
  const cloneShallow = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.slice()
    if (isPlainObject(v)) return { ...(v as Record<string, unknown>) }
    return v
  }
  if (!isPlainObject(root) && !Array.isArray(root)) {
    if (!createMissing) throw new Error("json.set: root is not an object/array")
    root = segs[0].kind === "index" ? [] : {}
  }
  const newRoot = cloneShallow(root)
  let parent: any = newRoot
  for (let i = 0; i < segs.length - 1; i++) {
    const seg = segs[i]
    const next = segs[i + 1]
    if (seg.kind === "key") {
      if (!isPlainObject(parent)) {
        throw new Error(`json.set: cannot descend into non-object at segment ${i}`)
      }
      const existing = (parent as Record<string, unknown>)[seg.key]
      let child: unknown
      if (existing === undefined) {
        if (!createMissing) throw new Error(`json.set: missing key '${seg.key}'`)
        child = next.kind === "index" ? [] : {}
      } else {
        child = cloneShallow(existing)
      }
      ;(parent as Record<string, unknown>)[seg.key] = child
      parent = child
    } else {
      if (!Array.isArray(parent)) {
        throw new Error(`json.set: cannot index into non-array at segment ${i}`)
      }
      const idx = seg.index < 0 ? parent.length + seg.index : seg.index
      let child: unknown
      const existing = parent[idx]
      if (existing === undefined) {
        if (!createMissing) throw new Error(`json.set: missing index ${seg.index}`)
        child = next.kind === "index" ? [] : {}
      } else {
        child = cloneShallow(existing)
      }
      parent[idx] = child
      parent = child
    }
  }
  const last = segs[segs.length - 1]
  if (last.kind === "key") {
    if (!isPlainObject(parent)) {
      throw new Error("json.set: parent of final segment is not an object")
    }
    ;(parent as Record<string, unknown>)[last.key] = value
  } else {
    if (!Array.isArray(parent)) {
      throw new Error("json.set: parent of final segment is not an array")
    }
    const idx = last.index < 0 ? parent.length + last.index : last.index
    parent[idx] = value
  }
  return newRoot
}

function deleteAt(root: unknown, segs: Segment[]): { changed: boolean; root: unknown } {
  if (segs.length === 0) {
    return { changed: false, root }
  }
  const cloneShallow = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.slice()
    if (isPlainObject(v)) return { ...(v as Record<string, unknown>) }
    return v
  }
  const newRoot = cloneShallow(root)
  let parent: any = newRoot
  for (let i = 0; i < segs.length - 1; i++) {
    const seg = segs[i]
    if (seg.kind === "key") {
      if (!isPlainObject(parent)) return { changed: false, root }
      const existing = (parent as Record<string, unknown>)[seg.key]
      if (existing === undefined) return { changed: false, root }
      const child = cloneShallow(existing)
      ;(parent as Record<string, unknown>)[seg.key] = child
      parent = child
    } else {
      if (!Array.isArray(parent)) return { changed: false, root }
      const idx = seg.index < 0 ? parent.length + seg.index : seg.index
      const existing = parent[idx]
      if (existing === undefined) return { changed: false, root }
      const child = cloneShallow(existing)
      parent[idx] = child
      parent = child
    }
  }
  const last = segs[segs.length - 1]
  if (last.kind === "key") {
    if (!isPlainObject(parent)) return { changed: false, root }
    if (!Object.prototype.hasOwnProperty.call(parent, last.key)) return { changed: false, root }
    delete (parent as Record<string, unknown>)[last.key]
    return { changed: true, root: newRoot }
  } else {
    if (!Array.isArray(parent)) return { changed: false, root }
    const idx = last.index < 0 ? parent.length + last.index : last.index
    if (idx < 0 || idx >= parent.length) return { changed: false, root }
    parent.splice(idx, 1)
    return { changed: true, root: newRoot }
  }
}

export function deepMerge(target: unknown, source: unknown): unknown {
  if (!isPlainObject(target) || !isPlainObject(source)) return source
  const out: Record<string, unknown> = { ...target }
  for (const [k, v] of Object.entries(source)) {
    if (isPlainObject(v) && isPlainObject(out[k])) {
      out[k] = deepMerge(out[k], v)
    } else {
      out[k] = v
    }
  }
  return out
}

function truncate(s: string, max = MAX_OUTPUT_CHARS): string {
  if (s.length <= max) return s
  return s.slice(0, max) + `\n... [truncated ${s.length - max} chars]`
}

function serialize(value: unknown): string {
  if (value === undefined) return "undefined"
  return JSON.stringify(value, null, 2)
}

export const JsonTool = Tool.define(
  "json",
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Params, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const action = params.action
          const target = path.isAbsolute(params.filePath)
            ? params.filePath
            : path.resolve(Instance.directory, params.filePath)

          const isWrite = action === "set" || action === "delete" || action === "merge"
          yield* ctx.ask({
            permission: isWrite ? "write" : "read",
            patterns: [target],
            always: ["*"],
            metadata: { filePath: target, action, path: params.path },
          })
          yield* assertExternalDirectoryEffect(ctx, target, { kind: "file" })

          const info = yield* fs.stat(target).pipe(Effect.catch(() => Effect.succeed(undefined)))
          if (!info) throw new Error(`json: file not found: ${target}`)
          if (info.type !== "File") throw new Error(`json: not a regular file: ${target}`)
          const sizeBefore = Number(info.size ?? 0)
          if (sizeBefore > MAX_FILE_BYTES) {
            throw new Error(
              `json: file too large (${sizeBefore} bytes > ${MAX_FILE_BYTES}); refusing to load`,
            )
          }

          const start = Date.now()
          const raw = yield* Effect.promise(() => readFile(target, "utf8"))
          let root: unknown
          try {
            root = raw.length === 0 ? null : JSON.parse(raw)
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err)
            throw new Error(`json: failed to parse ${target}: ${msg}`)
          }

          const segs = parsePath(params.path)

          if (action === "get") {
            const r = getAt(root, segs)
            const elapsed_ms = Date.now() - start
            const out = r.found ? truncate(serialize(r.value)) : `(not found)`
            return done({
              title: r.found ? `json get ${params.path ?? "$"} → ${jsonTypeOf(r.value)}` : `json get ${params.path ?? "$"} (missing)`,
              metadata: {
                action,
                filePath: target,
                path: params.path,
                found: r.found,
                json_type: r.found ? jsonTypeOf(r.value) : undefined,
                elapsed_ms,
              },
              output: out,
            })
          }

          if (action === "has") {
            const r = getAt(root, segs)
            const elapsed_ms = Date.now() - start
            return done({
              title: `json has ${params.path ?? "$"} → ${r.found}`,
              metadata: {
                action,
                filePath: target,
                path: params.path,
                has: r.found,
                found: r.found,
                elapsed_ms,
              },
              output: r.found ? "true" : "false",
            })
          }

          if (action === "type") {
            const r = getAt(root, segs)
            const elapsed_ms = Date.now() - start
            return done({
              title: `json type ${params.path ?? "$"}`,
              metadata: {
                action,
                filePath: target,
                path: params.path,
                found: r.found,
                json_type: r.found ? jsonTypeOf(r.value) : undefined,
                elapsed_ms,
              },
              output: r.found ? jsonTypeOf(r.value) : "(not found)",
            })
          }

          if (action === "keys") {
            const r = getAt(root, segs)
            if (!r.found) {
              return done({
                title: `json keys ${params.path ?? "$"} (missing)`,
                metadata: {
                  action,
                  filePath: target,
                  path: params.path,
                  found: false,
                  elapsed_ms: Date.now() - start,
                },
                output: "(not found)",
              })
            }
            let keys: string[]
            if (Array.isArray(r.value)) {
              keys = r.value.map((_, i) => `[${i}]`)
            } else if (isPlainObject(r.value)) {
              keys = Object.keys(r.value)
            } else {
              keys = []
            }
            return done({
              title: `json keys ${params.path ?? "$"} → ${keys.length}`,
              metadata: {
                action,
                filePath: target,
                path: params.path,
                found: true,
                json_type: jsonTypeOf(r.value),
                keys,
                elapsed_ms: Date.now() - start,
              },
              output: keys.length === 0 ? "(no keys)" : keys.join("\n"),
            })
          }

          // Write actions
          if (segs.length === 0) {
            throw new Error(
              `json.${action}: path is required and cannot be root for write actions; refusing to overwrite the whole file`,
            )
          }
          const pretty = params.pretty ?? true
          const createMissing = params.create_missing ?? true

          let newRoot: unknown
          let changed = true
          if (action === "set") {
            if (params.value === undefined) {
              throw new Error("json.set: value is required")
            }
            newRoot = setAt(root, segs, params.value, createMissing)
          } else if (action === "delete") {
            const r = deleteAt(root, segs)
            newRoot = r.root
            changed = r.changed
          } else {
            // merge
            if (!isPlainObject(params.value)) {
              throw new Error("json.merge: value must be an object")
            }
            const cur = getAt(root, segs)
            if (!cur.found) {
              if (!createMissing) {
                throw new Error("json.merge: target path not found and create_missing=false")
              }
              newRoot = setAt(root, segs, params.value, true)
            } else if (!isPlainObject(cur.value)) {
              throw new Error("json.merge: target path is not an object")
            } else {
              newRoot = setAt(root, segs, deepMerge(cur.value, params.value), false)
            }
          }

          if (!changed) {
            return done({
              title: `json ${action} ${params.path}: no change`,
              metadata: {
                action,
                filePath: target,
                path: params.path,
                written: false,
                size_bytes_before: sizeBefore,
                size_bytes_after: sizeBefore,
                elapsed_ms: Date.now() - start,
              },
              output: `No change — path '${params.path}' did not exist.`,
            })
          }

          const serialized = pretty ? JSON.stringify(newRoot, null, 2) : JSON.stringify(newRoot)
          // Preserve a trailing newline if the original had one — common convention.
          const finalText = raw.endsWith("\n") ? serialized + "\n" : serialized
          yield* Effect.promise(() => writeFile(target, finalText, "utf8"))
          const after = yield* Effect.promise(() => fsStat(target).then((s) => Number(s.size)))

          return done({
            title: `json ${action} ${params.path} (${after - sizeBefore >= 0 ? "+" : ""}${after - sizeBefore} bytes)`,
            metadata: {
              action,
              filePath: target,
              path: params.path,
              written: true,
              size_bytes_before: sizeBefore,
              size_bytes_after: after,
              elapsed_ms: Date.now() - start,
            },
            output: `${action} ${params.path} in ${target} (${sizeBefore} → ${after} bytes)`,
          })
        }),
    }
  }),
)

export const __testing = {
  parsePath,
  jsonTypeOf,
  deepMerge,
}
