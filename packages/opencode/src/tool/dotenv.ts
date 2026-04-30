import { Effect, Schema } from "effect"
import * as path from "node:path"
import { readFile } from "node:fs/promises"
import { Instance } from "../project/instance"
import { assertExternalDirectoryEffect } from "./external-directory"
import DESCRIPTION from "./dotenv.txt"
import * as Tool from "./tool"

const ACTIONS = ["parse", "stringify", "info"] as const

export const Parameters = Schema.Struct({
  action: Schema.Literals(ACTIONS).annotate({
    description:
      "What to do: 'parse' (decode .env text or file into key/value pairs), 'stringify' (encode an object back into .env text), 'info' (counts, no key dump).",
  }),
  text: Schema.optional(Schema.String.check(Schema.isMaxLength(2_097_152))).annotate({
    description: ".env source text for parse/info. Up to 2 MB. Mutually exclusive with `file`.",
  }),
  file: Schema.optional(Schema.String).annotate({
    description: "Path to a .env file for parse/info. Absolute preferred; relative resolves from project dir.",
  }),
  values: Schema.optional(Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Number, Schema.Boolean, Schema.Null]))).annotate({
    description:
      "Key/value object for action='stringify'. Numbers/booleans are coerced to strings; null becomes an empty value.",
  }),
  comments: Schema.optional(Schema.Record(Schema.String, Schema.String.check(Schema.isMaxLength(1024)))).annotate({
    description: "Optional per-key comment for stringify; emitted as `# <comment>` on the line above the key.",
  }),
  expand: Schema.optional(Schema.Boolean).annotate({
    description:
      "When parsing, perform $VAR / ${VAR} expansion against earlier keys in the same file. Default false (safe).",
  }),
  redact_secrets: Schema.optional(Schema.Boolean).annotate({
    description:
      "When true, replace values whose name looks secret-y (KEY/SECRET/TOKEN/PASSWORD/AUTH/PRIVATE) with '***' in output. Metadata still reports the real key count. Default false.",
  }),
  mode: Schema.optional(Schema.Literals(["dotenv", "shell"])).annotate({
    description:
      "Stringify quoting style. 'dotenv' (default) double-quotes only when the value needs it (whitespace, quotes, backslashes, '#', or empty). 'shell' single-quotes every value POSIX-style for use with `source`.",
  }),
  preserve_unset: Schema.optional(Schema.Boolean).annotate({
    description:
      "Stringify only - when true, emit `KEY=` for null values rather than skipping them. Default true.",
  }),
})

type Params = Schema.Schema.Type<typeof Parameters>
type Action = (typeof ACTIONS)[number]

type ParseEntry = { key: string; value: string; comment?: string; quoted: "none" | "single" | "double" | "backtick" }

type Metadata = {
  action: Action
  bytes_in?: number
  bytes_out?: number
  keys?: number
  unique_keys?: number
  duplicates?: string[]
  comment_count?: number
  blank_count?: number
  malformed_lines?: number[]
  mode?: "dotenv" | "shell"
  expand?: boolean
}

const done = (result: Tool.ExecuteResult<Metadata>) => result

const SECRET_PATTERN = /(?:^|_)(?:KEY|SECRET|TOKEN|PASSWORD|PASSWD|AUTH|PRIVATE|API_KEY|DSN|SESSION|COOKIE)(?:_|$)/i

function isSecretName(name: string): boolean {
  return SECRET_PATTERN.test(name)
}

// --- parsing ---------------------------------------------------------------

const ESCAPE_DOUBLE: Record<string, string> = {
  n: "\n",
  r: "\r",
  t: "\t",
  v: "\v",
  f: "\f",
  b: "\b",
  '"': '"',
  "'": "'",
  "\\": "\\",
  "$": "$",
  "0": "\0",
}

function decodeDoubleQuoted(raw: string): string {
  let out = ""
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]
    if (c === "\\" && i + 1 < raw.length) {
      const next = raw[i + 1]
      const mapped = ESCAPE_DOUBLE[next]
      if (mapped !== undefined) {
        out += mapped
        i++
        continue
      }
      // Unknown escape: keep as-is.
      out += c
      continue
    }
    out += c
  }
  return out
}

function expandValue(value: string, env: Record<string, string>): string {
  // Replace ${VAR}, ${VAR:-default}, $VAR with values from prior keys (or empty).
  let out = ""
  let i = 0
  while (i < value.length) {
    const c = value[i]
    if (c === "\\" && i + 1 < value.length && value[i + 1] === "$") {
      out += "$"
      i += 2
      continue
    }
    if (c !== "$") {
      out += c
      i++
      continue
    }
    if (i + 1 >= value.length) {
      out += "$"
      break
    }
    const next = value[i + 1]
    if (next === "{") {
      const close = value.indexOf("}", i + 2)
      if (close === -1) {
        out += "$"
        i++
        continue
      }
      const expr = value.slice(i + 2, close)
      const colonDash = expr.indexOf(":-")
      let name: string
      let fallback: string | undefined
      if (colonDash !== -1) {
        name = expr.slice(0, colonDash)
        fallback = expr.slice(colonDash + 2)
      } else {
        name = expr
      }
      out += env[name] ?? fallback ?? ""
      i = close + 1
      continue
    }
    if (/[A-Za-z_]/.test(next)) {
      let j = i + 1
      while (j < value.length && /[A-Za-z0-9_]/.test(value[j])) j++
      const name = value.slice(i + 1, j)
      out += env[name] ?? ""
      i = j
      continue
    }
    out += "$"
    i++
  }
  return out
}

function parseLines(text: string, expand: boolean) {
  const entries: ParseEntry[] = []
  const malformed: number[] = []
  let commentCount = 0
  let blankCount = 0
  const env: Record<string, string> = {}
  let pendingComment: string | undefined

  const raw = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
  const lines = raw.split("\n")
  let i = 0
  let lineNo = 0
  while (i < lines.length) {
    const line = lines[i]
    lineNo = i + 1
    const trimmed = line.trim()
    if (trimmed === "") {
      blankCount++
      pendingComment = undefined
      i++
      continue
    }
    if (trimmed.startsWith("#")) {
      commentCount++
      const comment = trimmed.replace(/^#+\s*/, "")
      pendingComment = pendingComment ? `${pendingComment} ${comment}` : comment
      i++
      continue
    }
    // Strip optional leading `export ` or `set -gx ` etc.
    let body = line.replace(/^\s*(?:export\s+|set\s+-gx\s+)/, "")
    const eq = body.indexOf("=")
    if (eq <= 0) {
      malformed.push(lineNo)
      pendingComment = undefined
      i++
      continue
    }
    const key = body.slice(0, eq).trim()
    if (!/^[A-Za-z_][A-Za-z0-9_.\-]*$/.test(key)) {
      malformed.push(lineNo)
      pendingComment = undefined
      i++
      continue
    }
    let rest = body.slice(eq + 1)
    let quoted: ParseEntry["quoted"] = "none"
    let value = ""
    // Strip leading whitespace before the value.
    rest = rest.replace(/^\s+/, "")
    if (rest.startsWith('"')) {
      // Double-quoted; may span multiple lines.
      quoted = "double"
      let acc = rest.slice(1)
      let consumedLines = 1
      while (true) {
        // Look for unescaped closing quote
        const end = (() => {
          let j = 0
          while (j < acc.length) {
            const ch = acc[j]
            if (ch === "\\") {
              j += 2
              continue
            }
            if (ch === '"') return j
            j++
          }
          return -1
        })()
        if (end !== -1) {
          value = decodeDoubleQuoted(acc.slice(0, end))
          break
        }
        // continue to next line
        if (i + consumedLines >= lines.length) {
          // Unterminated quote - treat as malformed.
          value = decodeDoubleQuoted(acc)
          malformed.push(lineNo)
          break
        }
        acc += "\n" + lines[i + consumedLines]
        consumedLines++
      }
      i += consumedLines
    } else if (rest.startsWith("'")) {
      // Single-quoted; literal, may span multiple lines.
      quoted = "single"
      let acc = rest.slice(1)
      let consumedLines = 1
      while (true) {
        const end = acc.indexOf("'")
        if (end !== -1) {
          value = acc.slice(0, end)
          break
        }
        if (i + consumedLines >= lines.length) {
          value = acc
          malformed.push(lineNo)
          break
        }
        acc += "\n" + lines[i + consumedLines]
        consumedLines++
      }
      i += consumedLines
    } else if (rest.startsWith("`")) {
      quoted = "backtick"
      let acc = rest.slice(1)
      let consumedLines = 1
      while (true) {
        const end = acc.indexOf("`")
        if (end !== -1) {
          value = acc.slice(0, end)
          break
        }
        if (i + consumedLines >= lines.length) {
          value = acc
          malformed.push(lineNo)
          break
        }
        acc += "\n" + lines[i + consumedLines]
        consumedLines++
      }
      i += consumedLines
    } else {
      // Unquoted: stop at unescaped '#' for inline comment.
      let v = ""
      let j = 0
      while (j < rest.length) {
        const ch = rest[j]
        if (ch === "#") {
          // Inline comment - only if preceded by whitespace or at start of value.
          if (j === 0 || /\s/.test(rest[j - 1])) break
        }
        v += ch
        j++
      }
      value = v.trimEnd()
      i++
    }
    if (expand && quoted !== "single") {
      value = expandValue(value, env)
    }
    env[key] = value
    entries.push({ key, value, comment: pendingComment, quoted })
    pendingComment = undefined
  }
  return { entries, malformed, commentCount, blankCount }
}

// --- stringify -------------------------------------------------------------

const SHELL_NEEDS_QUOTE = /[^A-Za-z0-9_.,/+-]/

function needsDotenvQuoting(value: string): boolean {
  if (value === "") return true
  if (/[\s"'`\\#]/.test(value)) return true
  if (value.startsWith(" ") || value.endsWith(" ")) return true
  return false
}

function escapeDouble(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\$/g, "\\$")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t")
}

function escapeSingle(value: string): string {
  // POSIX single-quote escaping: '...' has no escapes; close, add \', reopen.
  return value.replace(/'/g, `'\\''`)
}

function quoteForDotenv(value: string): string {
  if (!needsDotenvQuoting(value)) return value
  return `"${escapeDouble(value)}"`
}

function quoteForShell(value: string): string {
  if (value === "") return "''"
  if (!SHELL_NEEDS_QUOTE.test(value)) return value
  return `'${escapeSingle(value)}'`
}

function stringifyValues(
  values: Record<string, string | number | boolean | null>,
  comments: Record<string, string> | undefined,
  mode: "dotenv" | "shell",
  preserveUnset: boolean,
): string {
  const lines: string[] = []
  for (const [key, raw] of Object.entries(values)) {
    if (raw === null && !preserveUnset) continue
    const value = raw === null ? "" : typeof raw === "string" ? raw : String(raw)
    const comment = comments?.[key]
    if (comment) {
      for (const ln of comment.split(/\r?\n/)) lines.push(`# ${ln}`)
    }
    const encoded = mode === "shell" ? quoteForShell(value) : quoteForDotenv(value)
    lines.push(`${key}=${encoded}`)
  }
  return lines.join("\n") + (lines.length ? "\n" : "")
}

// --- IO --------------------------------------------------------------------

async function loadText(params: Params): Promise<string> {
  const hasText = typeof params.text === "string" && params.text.length > 0
  const hasFile = typeof params.file === "string" && params.file.length > 0
  if (hasText && hasFile) throw new Error("dotenv: pass exactly one of text or file, not both.")
  if (!hasText && !hasFile) throw new Error("dotenv: pass either text or file for parse/info.")
  if (hasText) return params.text!
  const target = path.isAbsolute(params.file!) ? params.file! : path.resolve(Instance.directory, params.file!)
  return await readFile(target, "utf8")
}

function resolveFile(file: string): string {
  return path.isAbsolute(file) ? file : path.resolve(Instance.directory, file)
}

function uniqAndDuplicates(entries: ParseEntry[]): { uniqueKeys: number; duplicates: string[] } {
  const seen = new Map<string, number>()
  for (const e of entries) {
    seen.set(e.key, (seen.get(e.key) ?? 0) + 1)
  }
  const duplicates: string[] = []
  for (const [k, n] of seen) {
    if (n > 1) duplicates.push(k)
  }
  return { uniqueKeys: seen.size, duplicates }
}

export const DotenvTool = Tool.define(
  "dotenv",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Params, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const action = params.action
          const redact = params.redact_secrets ?? false
          const expand = params.expand ?? false
          const mode = params.mode ?? "dotenv"
          const preserveUnset = params.preserve_unset ?? true

          if (action === "stringify") {
            if (!params.values || Object.keys(params.values).length === 0) {
              throw new Error("dotenv stringify: 'values' must be a non-empty object.")
            }
            const text = stringifyValues(params.values, params.comments, mode, preserveUnset)
            const meta: Metadata = {
              action: "stringify",
              keys: Object.keys(params.values).length,
              unique_keys: Object.keys(params.values).length,
              bytes_out: Buffer.byteLength(text, "utf8"),
              mode,
            }
            return done({
              title: `dotenv stringify: ${meta.keys} key${meta.keys === 1 ? "" : "s"} (${mode})`,
              metadata: meta,
              output: text,
            })
          }

          if (params.file) {
            const target = resolveFile(params.file)
            yield* assertExternalDirectoryEffect(ctx, target, { kind: "file" })
            yield* ctx.ask({
              permission: "read",
              patterns: [target],
              always: ["*"],
              metadata: { source: "dotenv", action, file: target },
            })
          }
          const source = yield* Effect.promise(() => loadText(params))
          const { entries, malformed, commentCount, blankCount } = parseLines(source, expand)
          const { uniqueKeys, duplicates } = uniqAndDuplicates(entries)

          if (action === "info") {
            const meta: Metadata = {
              action: "info",
              bytes_in: Buffer.byteLength(source, "utf8"),
              keys: entries.length,
              unique_keys: uniqueKeys,
              duplicates: duplicates.length ? duplicates : undefined,
              comment_count: commentCount,
              blank_count: blankCount,
              malformed_lines: malformed.length ? malformed : undefined,
              expand,
            }
            const lines = [
              `keys: ${entries.length}`,
              `unique_keys: ${uniqueKeys}`,
              `duplicates: ${duplicates.length ? duplicates.join(", ") : "(none)"}`,
              `comments: ${commentCount}`,
              `blank_lines: ${blankCount}`,
              `malformed_lines: ${malformed.length ? malformed.join(", ") : "(none)"}`,
              `bytes: ${meta.bytes_in}`,
            ]
            return done({
              title: `dotenv info: ${entries.length} key${entries.length === 1 ? "" : "s"}, ${uniqueKeys} unique`,
              metadata: meta,
              output: lines.join("\n"),
            })
          }

          // parse - return JSON
          const result: Record<string, string> = {}
          for (const e of entries) {
            const v = redact && isSecretName(e.key) ? "***" : e.value
            result[e.key] = v
          }
          const meta: Metadata = {
            action: "parse",
            bytes_in: Buffer.byteLength(source, "utf8"),
            keys: entries.length,
            unique_keys: uniqueKeys,
            duplicates: duplicates.length ? duplicates : undefined,
            comment_count: commentCount,
            blank_count: blankCount,
            malformed_lines: malformed.length ? malformed : undefined,
            expand,
          }
          return done({
            title: `dotenv parse: ${entries.length} key${entries.length === 1 ? "" : "s"}${malformed.length ? `, ${malformed.length} malformed` : ""}`,
            metadata: meta,
            output: JSON.stringify(result, null, 2),
          })
        }),
    }
  }),
)

export const __testing = {
  parseLines,
  stringifyValues,
  decodeDoubleQuoted,
  expandValue,
  isSecretName,
  needsDotenvQuoting,
  quoteForDotenv,
  quoteForShell,
  resolveFile,
}
