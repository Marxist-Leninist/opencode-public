import { Effect, Schema } from "effect"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Instance } from "../project/instance"
import { assertExternalDirectoryEffect } from "./external-directory"
import DESCRIPTION from "./jsonpath.txt"
import * as Tool from "./tool"

const MODES = ["values", "paths", "first", "count"] as const
const MAX_FILE_BYTES = 64 * 1024 * 1024
const MAX_OUTPUT_CHARS = 32_000
const DEFAULT_LIMIT = 100
const MAX_LIMIT = 1000
const MAX_RECURSION_DEPTH = 64
const MAX_DATA_BYTES = 8 * 1024 * 1024

export const Parameters = Schema.Struct({
  path: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2048)).annotate({
    description:
      "JSONPath expression. Examples: '$', '$.foo.bar', '$.items[*].name', '$..price', '$.items[0:5]', \"$['users','admins']\".",
  }),
  data: Schema.optional(Schema.String).annotate({
    description:
      "Inline JSON string to query. Use this OR filePath, not both. Up to ~8 MiB.",
  }),
  filePath: Schema.optional(Schema.String).annotate({
    description:
      "Path to a JSON file to query. Absolute preferred; relative paths resolve from the project directory. Up to 64 MiB.",
  }),
  mode: Schema.optional(Schema.Literals(MODES)).annotate({
    description:
      "values (default): JSON array of matched values. paths: bracket-notation paths. first: first match or null. count: number of matches.",
  }),
  limit: Schema.optional(
    Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(MAX_LIMIT)),
  ).annotate({
    description: `Cap on returned matches (1-${MAX_LIMIT}). Default ${DEFAULT_LIMIT}.`,
  }),
  pretty: Schema.optional(Schema.Boolean).annotate({
    description: "Pretty-print the output JSON (default true).",
  }),
})

type Params = Schema.Schema.Type<typeof Parameters>
type Mode = (typeof MODES)[number]

type Metadata = {
  mode: Mode
  path: string
  source: "data" | "file"
  filePath?: string
  matches: number
  truncated?: boolean
  capped?: boolean
  elapsed_ms: number
}

const done = (result: Tool.ExecuteResult<Metadata>) => result

// ---------- JSONPath segment representation ----------

type Step =
  | { kind: "key"; key: string }
  | { kind: "keys"; keys: string[] } // union: ['a','b']
  | { kind: "index"; index: number }
  | { kind: "indices"; indices: number[] } // union: [0,1,2]
  | { kind: "slice"; start?: number; end?: number; step: number }
  | { kind: "wildcard" } // [*] or .*
  | { kind: "descendant"; key?: string } // ..foo or just .. (matches all descendants)

// ---------- Tokenizer / parser ----------

export function parseJsonPath(input: string): Step[] {
  const trimmed = input.trim()
  if (!trimmed) throw new Error("jsonpath: empty path")
  let s = trimmed
  if (s === "$") return []
  if (s.startsWith("$")) s = s.slice(1)

  const steps: Step[] = []
  let i = 0

  const peek = (off = 0) => s[i + off]
  const consume = (n = 1) => {
    i += n
  }
  const error = (msg: string): never => {
    throw new Error(`jsonpath: ${msg} at offset ${i + 1} of '${input}'`)
  }

  while (i < s.length) {
    const c = peek()
    if (c === "." && peek(1) === ".") {
      // descendant
      consume(2)
      const next = peek()
      if (next === "[") {
        // Descendant followed by bracket: this becomes descendant{} then bracket steps.
        steps.push({ kind: "descendant" })
        // bracket parsed in next iteration
        continue
      }
      if (next === "*") {
        consume(1)
        steps.push({ kind: "descendant" }) // "all descendants"
        continue
      }
      if (next === undefined) error("trailing '..' must be followed by a key, [, or *")
      // descendant key like ..foo
      const key = readIdent()
      if (!key) error("expected identifier after '..'")
      steps.push({ kind: "descendant", key })
      continue
    }

    if (c === ".") {
      consume(1)
      const next = peek()
      if (next === "*") {
        consume(1)
        steps.push({ kind: "wildcard" })
        continue
      }
      if (next === "[") {
        // .[ is unusual but tolerate as bracket step
        continue
      }
      const key = readIdent()
      if (!key) error("expected identifier after '.'")
      steps.push({ kind: "key", key })
      continue
    }

    if (c === "[") {
      consume(1)
      parseBracket()
      continue
    }

    error(`unexpected character '${c}'`)
  }

  return steps

  function readIdent(): string {
    let start = i
    while (i < s.length) {
      const ch = s[i]
      if (
        (ch >= "a" && ch <= "z") ||
        (ch >= "A" && ch <= "Z") ||
        (ch >= "0" && ch <= "9") ||
        ch === "_" ||
        ch === "-" ||
        ch === "$"
      ) {
        i++
      } else {
        break
      }
    }
    return s.slice(start, i)
  }

  function parseBracket() {
    // Read content up to the closing ], ignoring ] inside quoted keys.
    let start = i
    let quote: "'" | '"' | undefined
    let escaped = false
    while (i < s.length) {
      const ch = s[i]
      if (quote) {
        if (escaped) {
          escaped = false
        } else if (ch === "\\") {
          escaped = true
        } else if (ch === quote) {
          quote = undefined
        }
        i++
        continue
      }
      if (ch === "'" || ch === '"') {
        quote = ch
        i++
        continue
      }
      if (ch === "]") break
      i++
    }
    if (i >= s.length || s[i] !== "]") error("unterminated bracket")
    const content = s.slice(start, i).trim()
    consume(1) // consume ]

    if (content === "*") {
      steps.push({ kind: "wildcard" })
      return
    }

    // Numeric union or single index
    if (/^-?\d+$/.test(content)) {
      steps.push({ kind: "index", index: parseInt(content, 10) })
      return
    }

    // Slice: [start:end] or [start:end:step]
    if (content.includes(":") && !content.includes("'") && !content.includes('"')) {
      const parts = content.split(":").map((p) => p.trim())
      if (parts.length < 2 || parts.length > 3) error(`bad slice '[${content}]'`)
      const startStr = parts[0]
      const endStr = parts[1]
      const stepStr = parts[2]
      const startN = startStr === "" ? undefined : parseInt(startStr, 10)
      const endN = endStr === "" ? undefined : parseInt(endStr, 10)
      const stepN = stepStr === "" || stepStr === undefined ? 1 : parseInt(stepStr, 10)
      if ((startStr !== "" && Number.isNaN(startN)) || (endStr !== "" && Number.isNaN(endN)) || Number.isNaN(stepN))
        error(`bad slice '[${content}]'`)
      if (stepN <= 0) error(`slice step must be a positive integer, got ${stepN}`)
      steps.push({ kind: "slice", start: startN, end: endN, step: stepN })
      return
    }

    // Numeric union: [0,1,2]
    if (/^-?\d+(\s*,\s*-?\d+)*$/.test(content)) {
      const parts = content.split(",").map((p) => parseInt(p.trim(), 10))
      if (parts.length === 1) steps.push({ kind: "index", index: parts[0] })
      else steps.push({ kind: "indices", indices: parts })
      return
    }

    // Quoted strings: ['foo'] or ["foo"] or ['a','b']
    const quoted = parseQuotedList(content)
    if (quoted) {
      if (quoted.length === 1) steps.push({ kind: "key", key: quoted[0] })
      else steps.push({ kind: "keys", keys: quoted })
      return
    }

    error(`unsupported bracket expression '[${content}]' (filters and functions are not supported)`)
  }
}

function parseQuotedList(input: string): string[] | undefined {
  const out: string[] = []
  let i = 0
  while (i < input.length) {
    while (i < input.length && /\s/.test(input[i]!)) i++
    if (i >= input.length) break
    const q = input[i]
    if (q !== "'" && q !== '"') return undefined
    i++
    let val = ""
    while (i < input.length && input[i] !== q) {
      if (input[i] === "\\" && i + 1 < input.length) {
        val += input[i + 1]
        i += 2
      } else {
        val += input[i]
        i++
      }
    }
    if (input[i] !== q) return undefined
    i++
    out.push(val)
    while (i < input.length && /\s/.test(input[i]!)) i++
    if (i < input.length) {
      if (input[i] === ",") i++
      else return undefined
    }
  }
  return out.length > 0 ? out : undefined
}

// ---------- Evaluator ----------

type Match = { value: unknown; path: (string | number)[] }

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v)
}

export function applyJsonPath(
  root: unknown,
  steps: Step[],
  opts: { limit: number; abort?: AbortSignal },
): { matches: Match[]; capped: boolean } {
  const out: Match[] = []
  let capped = false
  const checkAbort = () => {
    if (!opts.abort?.aborted) return
    const reason = opts.abort.reason
    if (reason instanceof Error) throw reason
    throw new Error("jsonpath: aborted")
  }
  const visit = (val: unknown, p: (string | number)[], stepIdx: number, depth: number): void => {
    checkAbort()
    if (capped) return
    if (out.length >= opts.limit) {
      capped = true
      return
    }
    if (depth > MAX_RECURSION_DEPTH) return
    if (stepIdx >= steps.length) {
      out.push({ value: val, path: p })
      return
    }
    const step = steps[stepIdx]
    switch (step.kind) {
      case "key": {
        if (isPlainObject(val) && Object.prototype.hasOwnProperty.call(val, step.key)) {
          visit(val[step.key], [...p, step.key], stepIdx + 1, depth + 1)
        }
        return
      }
      case "keys": {
        if (isPlainObject(val)) {
          for (const k of step.keys) {
            if (Object.prototype.hasOwnProperty.call(val, k)) {
              visit(val[k], [...p, k], stepIdx + 1, depth + 1)
              if (capped) return
            }
          }
        }
        return
      }
      case "index": {
        if (Array.isArray(val)) {
          const idx = step.index < 0 ? val.length + step.index : step.index
          if (idx >= 0 && idx < val.length) visit(val[idx], [...p, idx], stepIdx + 1, depth + 1)
        }
        return
      }
      case "indices": {
        if (Array.isArray(val)) {
          for (const raw of step.indices) {
            const idx = raw < 0 ? val.length + raw : raw
            if (idx >= 0 && idx < val.length) visit(val[idx], [...p, idx], stepIdx + 1, depth + 1)
            if (capped) return
          }
        }
        return
      }
      case "slice": {
        if (Array.isArray(val)) {
          const len = val.length
          let start = step.start ?? 0
          let end = step.end ?? len
          if (start < 0) start = Math.max(0, len + start)
          if (end < 0) end = Math.max(0, len + end)
          start = Math.min(Math.max(0, start), len)
          end = Math.min(Math.max(0, end), len)
          for (let i = start; i < end; i += step.step) {
            visit(val[i], [...p, i], stepIdx + 1, depth + 1)
            if (capped) return
          }
        }
        return
      }
      case "wildcard": {
        if (Array.isArray(val)) {
          for (let i = 0; i < val.length; i++) {
            visit(val[i], [...p, i], stepIdx + 1, depth + 1)
            if (capped) return
          }
        } else if (isPlainObject(val)) {
          for (const [k, v] of Object.entries(val)) {
            visit(v, [...p, k], stepIdx + 1, depth + 1)
            if (capped) return
          }
        }
        return
      }
      case "descendant": {
        // Visit the current node first, then recurse.
        const walk = (v: unknown, ps: (string | number)[]): void => {
          checkAbort()
          if (capped) return
          if (step.key === undefined) {
            // Bare descendant: feed every node into the next step.
            visit(v, ps, stepIdx + 1, depth + 1)
          } else {
            // ..key: every property named `key` anywhere.
            if (isPlainObject(v) && Object.prototype.hasOwnProperty.call(v, step.key)) {
              visit(v[step.key], [...ps, step.key], stepIdx + 1, depth + 1)
              if (capped) return
            }
          }
          if (Array.isArray(v)) {
            for (let i = 0; i < v.length; i++) {
              walk(v[i], [...ps, i])
              if (capped) return
            }
          } else if (isPlainObject(v)) {
            for (const [k, vv] of Object.entries(v)) {
              walk(vv, [...ps, k])
              if (capped) return
            }
          }
        }
        walk(val, p)
        return
      }
    }
  }
  visit(root, [], 0, 0)
  return { matches: out, capped }
}

export function formatPath(p: (string | number)[]): string {
  let out = "$"
  for (const seg of p) {
    if (typeof seg === "number") {
      out += `[${seg}]`
    } else {
      out += `['${seg.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}']`
    }
  }
  return out
}

function truncate(s: string, max = MAX_OUTPUT_CHARS): { content: string; truncated: boolean } {
  if (s.length <= max) return { content: s, truncated: false }
  return { content: s.slice(0, max) + `\n... [truncated ${s.length - max} chars]`, truncated: true }
}

export const JsonpathTool = Tool.define(
  "jsonpath",
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Params, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const start = Date.now()
          const mode: Mode = params.mode ?? "values"
          const limit = params.limit ?? DEFAULT_LIMIT
          const pretty = params.pretty ?? true
          if (ctx.abort.aborted) throw new Error("jsonpath: aborted")

          // Source resolution.
          if (params.data === undefined && params.filePath === undefined) {
            throw new Error("jsonpath: either 'data' or 'filePath' must be provided")
          }
          if (params.data !== undefined && params.filePath !== undefined) {
            throw new Error("jsonpath: pass only one of 'data' or 'filePath', not both")
          }

          let raw: string
          let source: "data" | "file"
          let filePathResolved: string | undefined

          if (params.data !== undefined) {
            const sizeBytes = Buffer.byteLength(params.data, "utf8")
            if (sizeBytes > MAX_DATA_BYTES) {
              throw new Error(
                `jsonpath: 'data' too large (${sizeBytes} > ${MAX_DATA_BYTES} bytes); use filePath instead`,
              )
            }
            raw = params.data
            source = "data"
          } else {
            const target = path.isAbsolute(params.filePath!)
              ? params.filePath!
              : path.resolve(Instance.directory, params.filePath!)
            yield* ctx.ask({
              permission: "read",
              patterns: [target],
              always: ["*"],
              metadata: { filePath: target },
            })
            yield* assertExternalDirectoryEffect(ctx, target, { kind: "file" })
            const info = yield* fs.stat(target).pipe(Effect.catch(() => Effect.succeed(undefined)))
            if (!info) throw new Error(`jsonpath: file not found: ${target}`)
            if (info.type !== "File") throw new Error(`jsonpath: not a regular file: ${target}`)
            const sizeBytes = Number(info.size ?? 0)
            if (sizeBytes > MAX_FILE_BYTES) {
              throw new Error(`jsonpath: file too large (${sizeBytes} > ${MAX_FILE_BYTES} bytes); refusing to load`)
            }
            raw = yield* Effect.promise(() => readFile(target, "utf8"))
            source = "file"
            filePathResolved = target
          }

          let root: unknown
          try {
            root = raw.trim().length === 0 ? null : JSON.parse(raw)
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err)
            throw new Error(`jsonpath: failed to parse JSON: ${msg}`)
          }

          const steps = parseJsonPath(params.path)
          const { matches, capped } = applyJsonPath(root, steps, { limit, abort: ctx.abort })

          const elapsed_ms = Date.now() - start

          if (mode === "count") {
            return done({
              title: `jsonpath ${params.path} -> ${matches.length}${capped ? "+" : ""}`,
              metadata: {
                mode,
                path: params.path,
                source,
                filePath: filePathResolved,
                matches: matches.length,
                capped,
                elapsed_ms,
              },
              output: capped ? `${matches.length}+ (capped at limit ${limit})` : String(matches.length),
            })
          }

          if (mode === "first") {
            const v = matches[0]?.value
            const json = pretty ? JSON.stringify(v ?? null, null, 2) : JSON.stringify(v ?? null)
            const t = truncate(json)
            return done({
              title:
                matches.length > 0
                  ? `jsonpath ${params.path} -> first match`
                  : `jsonpath ${params.path} -> no match`,
              metadata: {
                mode,
                path: params.path,
                source,
                filePath: filePathResolved,
                matches: matches.length,
                truncated: t.truncated,
                capped,
                elapsed_ms,
              },
              output: t.content,
            })
          }

          if (mode === "paths") {
            const list = matches.map((m) => formatPath(m.path))
            const out = list.join("\n")
            const t = truncate(out)
            return done({
              title: `jsonpath ${params.path} -> ${list.length}${capped ? "+" : ""} paths`,
              metadata: {
                mode,
                path: params.path,
                source,
                filePath: filePathResolved,
                matches: list.length,
                truncated: t.truncated,
                capped,
                elapsed_ms,
              },
              output: t.content || "(no matches)",
            })
          }

          // values (default)
          const vals = matches.map((m) => m.value)
          const json = pretty ? JSON.stringify(vals, null, 2) : JSON.stringify(vals)
          const t = truncate(json)
          return done({
            title: `jsonpath ${params.path} -> ${vals.length}${capped ? "+" : ""} values`,
            metadata: {
              mode,
              path: params.path,
              source,
              filePath: filePathResolved,
              matches: vals.length,
              truncated: t.truncated,
              capped,
              elapsed_ms,
            },
            output: t.content,
          })
        }),
    }
  }),
)

export const __testing = {
  parseJsonPath,
  applyJsonPath,
  formatPath,
  parseQuotedList,
}
