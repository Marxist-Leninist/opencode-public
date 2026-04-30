import { Effect, Schema } from "effect"
import DESCRIPTION from "./tabulate.txt"
import * as Tool from "./tool"

const ACTIONS = ["format", "transpose", "parse_markdown", "summary"] as const
const FORMATS = ["ascii", "markdown", "tsv", "csv"] as const
const ALIGNS = ["left", "right", "center"] as const

export const Parameters = Schema.Struct({
  action: Schema.Literals(ACTIONS).annotate({ description: ACTIONS.join(" | ") }),
  rows: Schema.optional(Schema.Array(Schema.Unknown)).annotate({
    description: "Row data: array of objects, or array of arrays.",
  }),
  columns: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "Explicit column order/selection. Defaults to keys of first row object.",
  }),
  format: Schema.optional(Schema.Literals(FORMATS)).annotate({
    description: "Output format. Default ascii.",
  }),
  align: Schema.optional(Schema.Union([Schema.Literals(ALIGNS), Schema.Array(Schema.Literals(ALIGNS))])).annotate({
    description: "Cell alignment. Single value or per-column array.",
  }),
  max_col_width: Schema.optional(
    Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(4), Schema.isLessThanOrEqualTo(500)),
  ).annotate({
    description: "Truncate cell values longer than this; trailing '…' added.",
  }),
  headers: Schema.optional(Schema.Boolean).annotate({
    description: "Include header row. Default true.",
  }),
  null_as: Schema.optional(Schema.String).annotate({
    description: "String shown for null/undefined cells. Default empty.",
  }),
  text: Schema.optional(Schema.String).annotate({
    description: "Markdown source for parse_markdown action.",
  }),
})

type Params = Schema.Schema.Type<typeof Parameters>
type Action = (typeof ACTIONS)[number]
type Format = (typeof FORMATS)[number]
type Align = (typeof ALIGNS)[number]

type Metadata = {
  action: Action
  rows?: number
  columns?: string[]
  format?: Format
  parsed?: { columns: string[]; rows: Array<Record<string, string>> }
  summary?: Record<string, ColumnSummary>
}

type ColumnSummary = {
  count: number
  nulls: number
  distinct: number
  numeric: boolean
  min?: number
  max?: number
  mean?: number
}

const done = (result: Tool.ExecuteResult<Metadata>) => result

// ---------- normalization ----------

function deriveColumns(rows: ReadonlyArray<unknown>): string[] {
  if (rows.length === 0) return []
  const seen = new Set<string>()
  const ordered: string[] = []
  for (const r of rows) {
    if (r && typeof r === "object" && !Array.isArray(r)) {
      for (const k of Object.keys(r as Record<string, unknown>)) {
        if (!seen.has(k)) {
          seen.add(k)
          ordered.push(k)
        }
      }
    }
  }
  if (ordered.length > 0) return ordered
  // Array-of-arrays: synthesize col_0..col_n based on max length.
  let maxLen = 0
  for (const r of rows) if (Array.isArray(r) && r.length > maxLen) maxLen = r.length
  return Array.from({ length: maxLen }, (_, i) => `col_${i}`)
}

function rowToCells(
  row: unknown,
  columns: ReadonlyArray<string>,
  nullAs: string,
): string[] {
  if (row === null || row === undefined) return columns.map(() => nullAs)
  if (Array.isArray(row)) {
    return columns.map((_, i) => formatCell(row[i], nullAs))
  }
  if (typeof row === "object") {
    const obj = row as Record<string, unknown>
    return columns.map((c) => formatCell(obj[c], nullAs))
  }
  // Scalar row → put into first cell, blank rest.
  return columns.map((_, i) => (i === 0 ? formatCell(row, nullAs) : nullAs))
}

function formatCell(v: unknown, nullAs: string): string {
  if (v === null || v === undefined) return nullAs
  if (typeof v === "string") return v
  if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint") return String(v)
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

function truncate(s: string, max: number | undefined): string {
  if (!max || s.length <= max) return s
  if (max <= 1) return "…"
  return s.slice(0, max - 1) + "…"
}

function isNumericLike(s: string): boolean {
  if (s === "") return false
  const n = Number(s.replace(/,/g, ""))
  return Number.isFinite(n)
}

function detectAlignments(
  cellsByRow: ReadonlyArray<ReadonlyArray<string>>,
  columns: ReadonlyArray<string>,
  override: Align | ReadonlyArray<Align> | undefined,
): Align[] {
  if (typeof override === "string") return columns.map(() => override)
  if (Array.isArray(override) && override.length === columns.length) {
    return [...override]
  }
  // Auto-detect per-column.
  return columns.map((_, i) => {
    let allNumeric = cellsByRow.length > 0
    for (const row of cellsByRow) {
      const cell = row[i] ?? ""
      if (cell === "") continue
      if (!isNumericLike(cell)) {
        allNumeric = false
        break
      }
    }
    return allNumeric ? "right" : "left"
  })
}

// ---------- formatting ----------

function pad(text: string, width: number, align: Align): string {
  if (text.length >= width) return text
  const diff = width - text.length
  if (align === "right") return " ".repeat(diff) + text
  if (align === "center") {
    const l = Math.floor(diff / 2)
    return " ".repeat(l) + text + " ".repeat(diff - l)
  }
  return text + " ".repeat(diff)
}

function formatAscii(
  columns: string[],
  cells: string[][],
  align: Align[],
  showHeaders: boolean,
): string {
  const widths = columns.map((c, i) =>
    Math.max(c.length, ...cells.map((row) => (row[i] ?? "").length)),
  )
  const sep = "+" + widths.map((w) => "-".repeat(w + 2)).join("+") + "+"
  const lines: string[] = []
  lines.push(sep)
  if (showHeaders) {
    lines.push(
      "| " +
        columns.map((c, i) => pad(c, widths[i], "left")).join(" | ") +
        " |",
    )
    lines.push(sep)
  }
  for (const row of cells) {
    lines.push(
      "| " +
        columns.map((_, i) => pad(row[i] ?? "", widths[i], align[i])).join(" | ") +
        " |",
    )
  }
  lines.push(sep)
  return lines.join("\n")
}

function formatMarkdown(
  columns: string[],
  cells: string[][],
  align: Align[],
  showHeaders: boolean,
): string {
  const widths = columns.map((c, i) =>
    Math.max(c.length, ...cells.map((row) => (row[i] ?? "").length), 3),
  )
  const lines: string[] = []
  if (showHeaders) {
    lines.push(
      "| " +
        columns.map((c, i) => pad(c, widths[i], "left")).join(" | ") +
        " |",
    )
    lines.push(
      "|" +
        align
          .map((a, i) => {
            const dashes = "-".repeat(Math.max(3, widths[i]))
            if (a === "right") return dashes.slice(0, -1) + ":"
            if (a === "center") return ":" + dashes.slice(0, -2) + ":"
            return dashes
          })
          .map((s) => ` ${s} `)
          .join("|") +
        "|",
    )
  }
  for (const row of cells) {
    lines.push(
      "| " +
        columns.map((_, i) => pad(row[i] ?? "", widths[i], align[i])).join(" | ") +
        " |",
    )
  }
  return lines.join("\n")
}

function formatDelimited(columns: string[], cells: string[][], delim: string, showHeaders: boolean): string {
  const escape = (v: string) => {
    if (delim === "," && /[",\r\n]/.test(v)) return `"${v.replace(/"/g, '""')}"`
    if (delim === "\t" && /[\t\r\n]/.test(v)) return v.replace(/[\t\r\n]+/g, " ")
    return v
  }
  const lines: string[] = []
  if (showHeaders) lines.push(columns.map(escape).join(delim))
  for (const row of cells) lines.push(columns.map((_, i) => escape(row[i] ?? "")).join(delim))
  return lines.join("\n")
}

export function tabulate(
  rows: ReadonlyArray<unknown>,
  opts: {
    columns?: ReadonlyArray<string>
    format?: Format
    align?: Align | ReadonlyArray<Align>
    max_col_width?: number
    headers?: boolean
    null_as?: string
  } = {},
): { output: string; columns: string[] } {
  const columns = opts.columns ? [...opts.columns] : deriveColumns(rows)
  const nullAs = opts.null_as ?? ""
  const cells = rows.map((r) =>
    rowToCells(r, columns, nullAs).map((c) => truncate(c, opts.max_col_width)),
  )
  const showHeaders = opts.headers !== false
  const format: Format = opts.format ?? "ascii"
  const align = detectAlignments(cells, columns, opts.align)

  if (format === "ascii") return { output: formatAscii(columns, cells, align, showHeaders), columns }
  if (format === "markdown") return { output: formatMarkdown(columns, cells, align, showHeaders), columns }
  if (format === "tsv") return { output: formatDelimited(columns, cells, "\t", showHeaders), columns }
  if (format === "csv") return { output: formatDelimited(columns, cells, ",", showHeaders), columns }
  throw new Error(`tabulate: unknown format '${format}'`)
}

// ---------- transpose ----------

export function transposeRows(rows: ReadonlyArray<unknown>): Array<Record<string, unknown>> {
  const columns = deriveColumns(rows)
  if (columns.length === 0) return []
  const result: Array<Record<string, unknown>> = []
  for (const col of columns) {
    const out: Record<string, unknown> = { _column: col }
    rows.forEach((r, i) => {
      const cell = (() => {
        if (Array.isArray(r)) return r[columns.indexOf(col)]
        if (r && typeof r === "object") return (r as Record<string, unknown>)[col]
        return undefined
      })()
      out[`row_${i}`] = cell
    })
    result.push(out)
  }
  return result
}

// ---------- parse markdown ----------

export function parseMarkdownTable(text: string): { columns: string[]; rows: Array<Record<string, string>> } {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith("|"))
  if (lines.length < 2) throw new Error("tabulate.parse_markdown: need a header line and a separator line")
  const splitRow = (line: string): string[] => {
    // Drop leading/trailing | and split, allowing escaped \|.
    const trimmed = line.replace(/^\|/, "").replace(/\|$/, "")
    return trimmed.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"))
  }
  const headers = splitRow(lines[0])
  const sep = splitRow(lines[1])
  const sepOk = sep.length === headers.length && sep.every((s) => /^:?-{2,}:?$/.test(s))
  if (!sepOk) throw new Error("tabulate.parse_markdown: bad separator row")
  const rows: Array<Record<string, string>> = []
  for (let i = 2; i < lines.length; i++) {
    const cells = splitRow(lines[i])
    const row: Record<string, string> = {}
    for (let j = 0; j < headers.length; j++) row[headers[j]] = cells[j] ?? ""
    rows.push(row)
  }
  return { columns: headers, rows }
}

// ---------- summary ----------

export function summaryStats(
  rows: ReadonlyArray<unknown>,
  columns?: ReadonlyArray<string>,
): Record<string, ColumnSummary> {
  const cols = columns ? [...columns] : deriveColumns(rows)
  const result: Record<string, ColumnSummary> = {}
  for (const col of cols) {
    let count = 0
    let nulls = 0
    const distinct = new Set<string>()
    let numeric = true
    let sum = 0
    let min = Number.POSITIVE_INFINITY
    let max = Number.NEGATIVE_INFINITY
    let numericCount = 0
    for (const r of rows) {
      let v: unknown
      if (Array.isArray(r)) v = r[cols.indexOf(col)]
      else if (r && typeof r === "object") v = (r as Record<string, unknown>)[col]
      else v = undefined
      count++
      if (v === null || v === undefined || v === "") {
        nulls++
        continue
      }
      distinct.add(typeof v === "string" ? v : JSON.stringify(v))
      if (typeof v === "number" && Number.isFinite(v)) {
        sum += v
        numericCount++
        if (v < min) min = v
        if (v > max) max = v
      } else if (typeof v === "string" && isNumericLike(v)) {
        const n = Number(v.replace(/,/g, ""))
        sum += n
        numericCount++
        if (n < min) min = n
        if (n > max) max = n
      } else {
        numeric = false
      }
    }
    const summary: ColumnSummary = {
      count,
      nulls,
      distinct: distinct.size,
      numeric: numeric && numericCount > 0,
    }
    if (summary.numeric) {
      summary.min = min
      summary.max = max
      summary.mean = numericCount > 0 ? sum / numericCount : 0
    }
    result[col] = summary
  }
  return result
}

// ---------- tool ----------

export const TabulateTool = Tool.define(
  "tabulate",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Params, _ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const action = params.action

          if (action === "format") {
            if (!params.rows) throw new Error("tabulate.format: requires `rows`")
            const r = tabulate(params.rows, {
              columns: params.columns,
              format: params.format,
              align: params.align as Align | ReadonlyArray<Align> | undefined,
              max_col_width: params.max_col_width,
              headers: params.headers,
              null_as: params.null_as,
            })
            return done({
              title: `tabulate.format: ${params.rows.length} row${params.rows.length === 1 ? "" : "s"}`,
              metadata: { action, rows: params.rows.length, columns: r.columns, format: params.format ?? "ascii" },
              output: r.output,
            })
          }

          if (action === "transpose") {
            if (!params.rows) throw new Error("tabulate.transpose: requires `rows`")
            const transposed = transposeRows(params.rows)
            return done({
              title: `tabulate.transpose: ${transposed.length} row${transposed.length === 1 ? "" : "s"}`,
              metadata: { action, rows: transposed.length },
              output: JSON.stringify(transposed, null, 2),
            })
          }

          if (action === "parse_markdown") {
            if (!params.text) throw new Error("tabulate.parse_markdown: requires `text`")
            const parsed = parseMarkdownTable(params.text)
            return done({
              title: `tabulate.parse_markdown: ${parsed.rows.length} row${parsed.rows.length === 1 ? "" : "s"}`,
              metadata: { action, parsed, columns: parsed.columns, rows: parsed.rows.length },
              output: JSON.stringify(parsed, null, 2),
            })
          }

          if (action === "summary") {
            if (!params.rows) throw new Error("tabulate.summary: requires `rows`")
            const summary = summaryStats(params.rows, params.columns)
            return done({
              title: `tabulate.summary: ${Object.keys(summary).length} columns`,
              metadata: { action, summary, columns: Object.keys(summary), rows: params.rows.length },
              output: JSON.stringify(summary, null, 2),
            })
          }

          throw new Error(`tabulate: unknown action '${action satisfies never}'`)
        }),
    }
  }),
)

export const __testing = {
  deriveColumns,
  rowToCells,
  truncate,
  isNumericLike,
  detectAlignments,
  tabulate,
  transposeRows,
  parseMarkdownTable,
  summaryStats,
}
