import { Effect, Schema } from "effect"
import { readFile, writeFile, stat as fsStat } from "node:fs/promises"
import * as path from "node:path"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Instance } from "../project/instance"
import { assertExternalDirectoryEffect } from "./external-directory"
import DESCRIPTION from "./csv.txt"
import * as Tool from "./tool"

const ACTIONS = ["parse", "generate", "info"] as const
const MAX_INPUT_BYTES = 64 * 1024 * 1024
const MAX_OUTPUT_CHARS = 16_000

export const Parameters = Schema.Struct({
  action: Schema.Literals(ACTIONS).annotate({
    description:
      "parse: read CSV → JSON rows. generate: write JSON rows → CSV. info: parse and report shape (rows, columns, header) without printing all data.",
  }),
  content: Schema.optional(Schema.String).annotate({
    description: "Inline content. For parse/info: CSV text. For generate: JSON array of arrays or array of objects.",
  }),
  filePath: Schema.optional(Schema.String).annotate({
    description: "Read input from this file instead of `content`. Absolute or relative to project directory.",
  }),
  output_path: Schema.optional(Schema.String).annotate({
    description:
      "If set, write the result here instead of returning inline. Required for very large outputs. Absolute or relative to project directory.",
  }),
  delimiter: Schema.optional(Schema.String).annotate({
    description: "Field separator. Default ','. Use '\\t' for TSV.",
  }),
  has_header: Schema.optional(Schema.Boolean).annotate({
    description:
      "For parse/info: treat the first row as a header (default true). When true, parse returns objects keyed by header name; when false, parse returns arrays. For generate: emit a header row (default true when input is array of objects, false when array of arrays).",
  }),
  quote: Schema.optional(Schema.String).annotate({
    description: "Quote character. Default '\"'. Single character.",
  }),
  trim: Schema.optional(Schema.Boolean).annotate({
    description: "Trim whitespace from each parsed field. Default false.",
  }),
  limit: Schema.optional(Schema.Number.check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(0))).annotate({
    description: "Cap rows returned by parse. 0 = no cap. Default 0.",
  }),
})

type Params = Schema.Schema.Type<typeof Parameters>
type Action = (typeof ACTIONS)[number]

type Metadata = {
  action: Action
  rows?: number
  columns?: number
  truncated?: boolean
  header?: string[]
  filePath?: string
  output_path?: string
  bytes_in?: number
  bytes_out?: number
  elapsed_ms?: number
}

export function parseCsv(input: string, opts: { delimiter?: string; quote?: string; trim?: boolean } = {}): string[][] {
  const delim = opts.delimiter ?? ","
  const quote = opts.quote ?? '"'
  const trim = opts.trim ?? false
  const out: string[][] = []
  let row: string[] = []
  let field = ""
  let inQuotes = false
  let i = 0
  const n = input.length
  // Trailing newline gets handled by the loop end (push only if any data was seen).
  while (i < n) {
    const c = input[i]!
    if (inQuotes) {
      if (c === quote) {
        if (i + 1 < n && input[i + 1] === quote) {
          field += quote
          i += 2
          continue
        }
        inQuotes = false
        i++
        continue
      }
      field += c
      i++
      continue
    }
    if (c === quote && field.length === 0) {
      inQuotes = true
      i++
      continue
    }
    if (c === delim) {
      row.push(trim ? field.trim() : field)
      field = ""
      i++
      continue
    }
    if (c === "\r") {
      if (i + 1 < n && input[i + 1] === "\n") i++
      row.push(trim ? field.trim() : field)
      out.push(row)
      row = []
      field = ""
      i++
      continue
    }
    if (c === "\n") {
      row.push(trim ? field.trim() : field)
      out.push(row)
      row = []
      field = ""
      i++
      continue
    }
    field += c
    i++
  }
  // Flush final field/row only if there was actually content.
  if (field.length > 0 || row.length > 0) {
    row.push(trim ? field.trim() : field)
    out.push(row)
  }
  return out
}

function escapeField(value: unknown, delimiter: string, quote: string): string {
  const s = value === null || value === undefined ? "" : String(value)
  const needsQuoting = s.includes(delimiter) || s.includes(quote) || s.includes("\n") || s.includes("\r")
  if (!needsQuoting) return s
  const escaped = s.split(quote).join(quote + quote)
  return `${quote}${escaped}${quote}`
}

export function generateCsv(
  rows: unknown[],
  opts: { delimiter?: string; quote?: string; has_header?: boolean } = {},
): { text: string; header: string[] } {
  const delim = opts.delimiter ?? ","
  const quote = opts.quote ?? '"'
  if (!Array.isArray(rows)) throw new Error("csv.generate: input must be an array")
  if (rows.length === 0) return { text: "", header: [] }
  const isObjects = rows.every((r) => r !== null && typeof r === "object" && !Array.isArray(r))
  const isArrays = rows.every((r) => Array.isArray(r))
  if (!isObjects && !isArrays) {
    throw new Error("csv.generate: input must be all-arrays or all-objects, not mixed")
  }
  let header: string[] = []
  let dataRows: unknown[][] = []
  if (isObjects) {
    const seen = new Set<string>()
    for (const r of rows as Record<string, unknown>[]) {
      for (const k of Object.keys(r)) {
        if (!seen.has(k)) {
          seen.add(k)
          header.push(k)
        }
      }
    }
    dataRows = (rows as Record<string, unknown>[]).map((r) => header.map((k) => r[k]))
  } else {
    dataRows = rows as unknown[][]
  }
  const includeHeader = opts.has_header ?? isObjects
  const lines: string[] = []
  if (includeHeader && header.length > 0) {
    lines.push(header.map((h) => escapeField(h, delim, quote)).join(delim))
  }
  for (const r of dataRows) {
    lines.push(r.map((v) => escapeField(v, delim, quote)).join(delim))
  }
  return { text: lines.join("\n") + (lines.length > 0 ? "\n" : ""), header }
}

function truncate(s: string): string {
  if (s.length <= MAX_OUTPUT_CHARS) return s
  return s.slice(0, MAX_OUTPUT_CHARS) + `\n... [truncated ${s.length - MAX_OUTPUT_CHARS} chars]`
}

const done = (result: Tool.ExecuteResult<Metadata>) => result

export const CsvTool = Tool.define(
  "csv",
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Params, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const start = Date.now()
          const action = params.action

          let inputText: string | undefined
          let inputBytes = 0
          if (params.filePath !== undefined) {
            const target = path.isAbsolute(params.filePath)
              ? params.filePath
              : path.resolve(Instance.directory, params.filePath)
            yield* ctx.ask({
              permission: "read",
              patterns: [target],
              always: ["*"],
              metadata: { filePath: target, action },
            })
            yield* assertExternalDirectoryEffect(ctx, target, { kind: "file" })
            const info = yield* fs.stat(target).pipe(Effect.catch(() => Effect.succeed(undefined)))
            if (!info) throw new Error(`csv: file not found: ${target}`)
            if (info.type !== "File") throw new Error(`csv: not a regular file: ${target}`)
            inputBytes = Number(info.size ?? 0)
            if (inputBytes > MAX_INPUT_BYTES) {
              throw new Error(`csv: file too large (${inputBytes} bytes > ${MAX_INPUT_BYTES})`)
            }
            inputText = yield* Effect.promise(() => readFile(target, "utf8"))
          } else if (params.content !== undefined) {
            inputText = params.content
            inputBytes = Buffer.byteLength(inputText, "utf8")
          } else {
            throw new Error("csv: provide either 'content' or 'filePath'")
          }

          const delimiter = params.delimiter ?? ","
          const quote = params.quote ?? '"'
          if (quote.length !== 1) throw new Error("csv: 'quote' must be a single character")

          let outputPath: string | undefined
          if (params.output_path !== undefined) {
            outputPath = path.isAbsolute(params.output_path)
              ? params.output_path
              : path.resolve(Instance.directory, params.output_path)
            yield* ctx.ask({
              permission: "write",
              patterns: [outputPath],
              always: ["*"],
              metadata: { filePath: outputPath, action },
            })
            yield* assertExternalDirectoryEffect(ctx, outputPath, { kind: "file" })
          }

          if (action === "parse" || action === "info") {
            const rows = parseCsv(inputText!, { delimiter, quote, trim: params.trim ?? false })
            const hasHeader = params.has_header ?? true
            let header: string[] = []
            let body: string[][] = rows
            if (hasHeader && rows.length > 0) {
              header = rows[0]!
              body = rows.slice(1)
            }
            const limit = params.limit ?? 0
            const limited = limit > 0 && body.length > limit ? body.slice(0, limit) : body
            const truncated = limited.length < body.length

            if (action === "info") {
              const meta: Metadata = {
                action,
                rows: body.length,
                columns: header.length || (rows[0]?.length ?? 0),
                header: header.length > 0 ? header : undefined,
                bytes_in: inputBytes,
                elapsed_ms: Date.now() - start,
                filePath: params.filePath,
              }
              return done({
                title: `csv info: ${meta.rows} rows × ${meta.columns} cols`,
                metadata: meta,
                output: [
                  `rows: ${meta.rows}`,
                  `columns: ${meta.columns}`,
                  header.length > 0 ? `header: ${header.join(", ")}` : "header: (none)",
                ].join("\n"),
              })
            }

            // parse
            let result: unknown
            if (hasHeader) {
              result = limited.map((r) => {
                const obj: Record<string, string> = {}
                for (let i = 0; i < header.length; i++) {
                  obj[header[i]!] = r[i] ?? ""
                }
                return obj
              })
            } else {
              result = limited
            }
            const serialized = JSON.stringify(result, null, 2)
            if (outputPath) {
              yield* Effect.promise(() => writeFile(outputPath!, serialized + "\n", "utf8"))
              const after = yield* Effect.promise(() => fsStat(outputPath!).then((s) => Number(s.size)))
              return done({
                title: `csv parse → ${outputPath} (${body.length} rows)`,
                metadata: {
                  action,
                  rows: body.length,
                  columns: header.length || (rows[0]?.length ?? 0),
                  truncated,
                  header: header.length > 0 ? header : undefined,
                  bytes_in: inputBytes,
                  bytes_out: after,
                  elapsed_ms: Date.now() - start,
                  output_path: outputPath,
                  filePath: params.filePath,
                },
                output: `wrote ${after} bytes to ${outputPath}`,
              })
            }
            return done({
              title: `csv parse: ${body.length} rows${truncated ? " (limited)" : ""}`,
              metadata: {
                action,
                rows: body.length,
                columns: header.length || (rows[0]?.length ?? 0),
                truncated,
                header: header.length > 0 ? header : undefined,
                bytes_in: inputBytes,
                elapsed_ms: Date.now() - start,
                filePath: params.filePath,
              },
              output: truncate(serialized),
            })
          }

          // generate
          let parsed: unknown
          try {
            parsed = JSON.parse(inputText!)
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err)
            throw new Error(`csv.generate: input must be JSON: ${msg}`)
          }
          if (!Array.isArray(parsed)) {
            throw new Error("csv.generate: input JSON must be an array")
          }
          const { text, header } = generateCsv(parsed, {
            delimiter,
            quote,
            has_header: params.has_header,
          })
          if (outputPath) {
            yield* Effect.promise(() => writeFile(outputPath!, text, "utf8"))
            const after = yield* Effect.promise(() => fsStat(outputPath!).then((s) => Number(s.size)))
            return done({
              title: `csv generate → ${outputPath} (${parsed.length} rows)`,
              metadata: {
                action,
                rows: parsed.length,
                columns: header.length,
                header: header.length > 0 ? header : undefined,
                bytes_in: inputBytes,
                bytes_out: after,
                elapsed_ms: Date.now() - start,
                output_path: outputPath,
              },
              output: `wrote ${after} bytes to ${outputPath}`,
            })
          }
          return done({
            title: `csv generate: ${parsed.length} rows`,
            metadata: {
              action,
              rows: parsed.length,
              columns: header.length,
              header: header.length > 0 ? header : undefined,
              bytes_in: inputBytes,
              elapsed_ms: Date.now() - start,
            },
            output: truncate(text),
          })
        }),
    }
  }),
)

export const __testing = {
  parseCsv,
  generateCsv,
  escapeField,
}
