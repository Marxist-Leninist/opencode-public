import { Effect, Schema } from "effect"
import { Instance } from "../project/instance"
import * as nodePath from "node:path"
import { promises as fs } from "node:fs"
import DESCRIPTION from "./ini.txt"
import * as Tool from "./tool"

const ACTIONS = ["parse", "stringify", "to_json", "from_json"] as const

export const Parameters = Schema.Struct({
  action: Schema.Literals(ACTIONS).annotate({ description: ACTIONS.join(" | ") }),
  value: Schema.optional(Schema.String).annotate({ description: "INI text or JSON-encoded object." }),
  data: Schema.optional(Schema.Unknown).annotate({ description: "JSON value to stringify." }),
  filePath: Schema.optional(Schema.String).annotate({ description: "Read INI from this file." }),
  output_path: Schema.optional(Schema.String).annotate({ description: "Write stringify result to this file." }),
  comment_chars: Schema.optional(Schema.String).annotate({ description: "Characters that start a comment (default '#;')." }),
  delimiter: Schema.optional(Schema.String).annotate({ description: "Key/value separator on output (default '=')." }),
  lower_case_keys: Schema.optional(Schema.Boolean).annotate({ description: "Lowercase keys/sections during parse." }),
  coerce_numbers: Schema.optional(Schema.Boolean).annotate({ description: "Coerce 'true/false' and numbers during parse." }),
})

type Params = Schema.Schema.Type<typeof Parameters>

type Metadata = {
  action: (typeof ACTIONS)[number]
  sections?: number
  keys?: number
  bytes_in?: number
  bytes_out?: number
  source?: "value" | "filePath"
  output_path?: string
}

function unquote(v: string): string {
  if (v.length >= 2) {
    const first = v[0]
    const last = v[v.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return v.slice(1, -1)
    }
  }
  return v
}

function coerce(v: string): string | number | boolean {
  if (v === "true") return true
  if (v === "false") return false
  if (/^-?\d+$/.test(v)) return parseInt(v, 10)
  if (/^-?\d+\.\d+$/.test(v)) return parseFloat(v)
  return v
}

export function parseINI(
  text: string,
  options: { commentChars?: string; lowerCaseKeys?: boolean; coerceNumbers?: boolean } = {},
): Record<string, Record<string, unknown>> {
  const commentChars = options.commentChars ?? "#;"
  const lc = options.lowerCaseKeys === true
  const co = options.coerceNumbers === true
  const result: Record<string, Record<string, unknown>> = { "": {} }
  let section = ""
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    if (commentChars.includes(line[0]!)) continue
    if (line.startsWith("[") && line.endsWith("]")) {
      let name = line.slice(1, -1).trim()
      if (lc) name = name.toLowerCase()
      section = name
      if (!result[section]) result[section] = {}
      continue
    }
    let eq = line.indexOf("=")
    let colon = line.indexOf(":")
    let sep: number
    if (eq === -1 && colon === -1) {
      // Bare key — treat as flag = true
      let k = lc ? line.toLowerCase() : line
      if (!result[section]) result[section] = {}
      result[section]![k] = co ? true : ""
      continue
    }
    if (eq === -1) sep = colon
    else if (colon === -1) sep = eq
    else sep = Math.min(eq, colon)
    let key = line.slice(0, sep).trim()
    let value = unquote(line.slice(sep + 1).trim())
    if (lc) key = key.toLowerCase()
    if (!result[section]) result[section] = {}
    result[section]![key] = co ? coerce(value) : value
  }
  return result
}

export function stringifyINI(
  obj: Record<string, Record<string, unknown>>,
  options: { delimiter?: string } = {},
): string {
  const delim = options.delimiter ?? "="
  const lines: string[] = []
  // Top-level (empty section) first
  const topKeys = obj[""]
  if (topKeys && Object.keys(topKeys).length > 0) {
    for (const [k, v] of Object.entries(topKeys)) {
      lines.push(`${k} ${delim} ${formatValue(v)}`)
    }
    lines.push("")
  }
  for (const [section, kvs] of Object.entries(obj)) {
    if (section === "") continue
    if (!kvs || typeof kvs !== "object") continue
    lines.push(`[${section}]`)
    for (const [k, v] of Object.entries(kvs)) {
      lines.push(`${k} ${delim} ${formatValue(v)}`)
    }
    lines.push("")
  }
  return lines.join("\n").replace(/\n+$/, "\n")
}

function formatValue(v: unknown): string {
  if (v === null || v === undefined) return ""
  if (typeof v === "string") {
    // Quote if contains leading/trailing whitespace or comment chars
    if (/^[\s]/.test(v) || /[\s]$/.test(v) || /[#;]/.test(v)) return JSON.stringify(v)
    return v
  }
  if (typeof v === "boolean" || typeof v === "number") return String(v)
  return JSON.stringify(v)
}

const done = (result: Tool.ExecuteResult<Metadata>) => result

function resolvePath(p: string): string {
  return nodePath.isAbsolute(p) ? p : nodePath.join(Instance.directory, p)
}

export const IniTool = Tool.define(
  "ini",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Params, _ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const action = params.action
          const isParse = action === "parse" || action === "to_json"
          const isStringify = action === "stringify" || action === "from_json"

          if (isParse) {
            let text: string
            let source: "value" | "filePath"
            if (params.filePath) {
              const abs = resolvePath(params.filePath)
              text = yield* Effect.promise(() => fs.readFile(abs, "utf8"))
              source = "filePath"
            } else if (params.value !== undefined) {
              text = params.value
              source = "value"
            } else throw new Error("ini.parse: requires `value` or `filePath`")
            const parsed = parseINI(text, {
              commentChars: params.comment_chars,
              lowerCaseKeys: params.lower_case_keys,
              coerceNumbers: params.coerce_numbers,
            })
            const out = JSON.stringify(parsed, null, 2)
            const sectionCount = Object.keys(parsed).length
            const keyCount = Object.values(parsed).reduce((acc, kvs) => acc + Object.keys(kvs ?? {}).length, 0)
            return done({
              title: `ini.parse: ${sectionCount} sections, ${keyCount} keys`,
              metadata: {
                action,
                sections: sectionCount,
                keys: keyCount,
                bytes_in: text.length,
                bytes_out: out.length,
                source,
              },
              output: out,
            })
          }

          if (isStringify) {
            let data: unknown
            if (params.data !== undefined) data = params.data
            else if (params.value !== undefined) {
              try {
                data = JSON.parse(params.value)
              } catch (e: any) {
                throw new Error(`ini.stringify: \`value\` is not valid JSON (${e?.message ?? e})`)
              }
            } else throw new Error("ini.stringify: requires `data` or JSON-encoded `value`")
            if (data === null || typeof data !== "object" || Array.isArray(data))
              throw new Error("ini.stringify: data must be an object")
            // Normalize: allow flat objects (auto-promote to empty section)
            let normalized: Record<string, Record<string, unknown>>
            const obj = data as Record<string, unknown>
            const allObjValues = Object.values(obj).every(
              (v) => v !== null && typeof v === "object" && !Array.isArray(v),
            )
            if (allObjValues && Object.keys(obj).length > 0) {
              normalized = obj as Record<string, Record<string, unknown>>
            } else {
              normalized = { "": obj as Record<string, unknown> }
            }
            const text = stringifyINI(normalized, { delimiter: params.delimiter })
            let outputPath: string | undefined
            if (params.output_path) {
              const abs = resolvePath(params.output_path)
              yield* Effect.promise(() => fs.mkdir(nodePath.dirname(abs), { recursive: true }))
              yield* Effect.promise(() => fs.writeFile(abs, text, "utf8"))
              outputPath = abs
            }
            return done({
              title: `ini.stringify: ${text.length} bytes${outputPath ? ` → ${outputPath}` : ""}`,
              metadata: {
                action,
                bytes_out: text.length,
                output_path: outputPath,
              },
              output: outputPath ? `Wrote ${text.length} bytes → ${outputPath}` : text,
            })
          }

          throw new Error(`ini: unknown action '${action}'`)
        }),
    }
  }),
)

export const __testing = {
  parseINI,
  stringifyINI,
}
