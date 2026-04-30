import { Effect, Schema } from "effect"
import DESCRIPTION from "./humanize.txt"
import * as Tool from "./tool"

const ACTIONS = [
  "bytes_format",
  "bytes_parse",
  "duration_format",
  "duration_parse",
  "number_format",
  "number_parse",
  "ordinal",
  "pluralize",
  "relative_time",
  "slug",
] as const
const STYLES = ["iec", "si"] as const

export const Parameters = Schema.Struct({
  action: Schema.Literals(ACTIONS).annotate({ description: ACTIONS.join(" | ") }),
  n: Schema.optional(Schema.Number).annotate({
    description:
      "Numeric input. bytes_format=byte count, duration_format=ms, number_format=any number, ordinal=integer, relative_time=ms delta (positive=past).",
  }),
  value: Schema.optional(Schema.String).annotate({
    description: "String input for bytes_parse / duration_parse / number_parse.",
  }),
  style: Schema.optional(Schema.Literals(STYLES)).annotate({
    description: "iec (1024-based, KiB/MiB) or si (1000-based, kB/MB). Default iec.",
  }),
  decimals: Schema.optional(
    Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(10)),
  ).annotate({
    description: "Fraction digits for bytes_format / number_format. Default 2 (bytes), 0 (number).",
  }),
  compact: Schema.optional(Schema.Boolean).annotate({
    description: "For number_format: produce 1.2K / 3.4M / 5.6B instead of grouped digits.",
  }),
  locale: Schema.optional(Schema.String).annotate({
    description: "BCP-47 tag for number_format. Default en-US.",
  }),
  text: Schema.optional(Schema.String).annotate({ description: "Input text for slug action." }),
  noun: Schema.optional(Schema.String).annotate({ description: "Singular noun for pluralize." }),
  plural: Schema.optional(Schema.String).annotate({ description: "Irregular plural form." }),
  count: Schema.optional(Schema.Number).annotate({ description: "Count for pluralize." }),
  max_length: Schema.optional(
    Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(200)),
  ).annotate({
    description: "Max length for slug action. Default 80.",
  }),
})

type Params = Schema.Schema.Type<typeof Parameters>
type Action = (typeof ACTIONS)[number]
type Style = (typeof STYLES)[number]

type Metadata = {
  action: Action
  formatted?: string
  parsed?: number
  bytes?: number
  ms?: number
  unit?: string
  detail?: string
}

const done = (result: Tool.ExecuteResult<Metadata>) => result

// ---------- byte sizes ----------

const IEC_UNITS = ["B", "KiB", "MiB", "GiB", "TiB", "PiB", "EiB"] as const
const SI_UNITS = ["B", "kB", "MB", "GB", "TB", "PB", "EB"] as const

export function formatBytes(n: number, style: Style = "iec", decimals = 2): string {
  if (!Number.isFinite(n)) return String(n)
  const negative = n < 0
  const abs = Math.abs(n)
  const base = style === "iec" ? 1024 : 1000
  const units = style === "iec" ? IEC_UNITS : SI_UNITS
  if (abs < base) {
    return `${negative ? "-" : ""}${abs} ${units[0]}`
  }
  let i = Math.floor(Math.log(abs) / Math.log(base))
  if (i >= units.length) i = units.length - 1
  const v = abs / Math.pow(base, i)
  return `${negative ? "-" : ""}${trimDecimal(v, decimals)} ${units[i]}`
}

function trimDecimal(v: number, decimals: number): string {
  if (decimals <= 0) return String(Math.round(v))
  // Show up to `decimals` digits but trim trailing zeros / trailing dot.
  return v
    .toFixed(decimals)
    .replace(/\.?0+$/, "")
}

const BYTE_UNIT_MAP: Record<string, number> = {
  // binary first so "1K" → 1024 to match shell convention.
  b: 1,
  byte: 1,
  bytes: 1,
  k: 1024,
  kb: 1024,
  kib: 1024,
  m: 1024 ** 2,
  mb: 1024 ** 2,
  mib: 1024 ** 2,
  g: 1024 ** 3,
  gb: 1024 ** 3,
  gib: 1024 ** 3,
  t: 1024 ** 4,
  tb: 1024 ** 4,
  tib: 1024 ** 4,
  p: 1024 ** 5,
  pb: 1024 ** 5,
  pib: 1024 ** 5,
  e: 1024 ** 6,
  eb: 1024 ** 6,
  eib: 1024 ** 6,
}

const SI_BYTE_UNIT_MAP: Record<string, number> = {
  b: 1,
  byte: 1,
  bytes: 1,
  k: 1000,
  kb: 1000,
  m: 1000 ** 2,
  mb: 1000 ** 2,
  g: 1000 ** 3,
  gb: 1000 ** 3,
  t: 1000 ** 4,
  tb: 1000 ** 4,
  p: 1000 ** 5,
  pb: 1000 ** 5,
  e: 1000 ** 6,
  eb: 1000 ** 6,
}

export function parseBytes(input: string, style: Style = "iec"): number {
  const cleaned = input.trim().replace(/[, ]+/g, "")
  const m = /^(-?\d+(?:\.\d+)?)([a-zA-Z]*)$/.exec(cleaned)
  if (!m) throw new Error(`humanize.bytes_parse: cannot parse '${input}'`)
  const num = parseFloat(m[1])
  const unit = m[2].toLowerCase()
  if (!unit) return Math.round(num)
  const map = unit.endsWith("ib") || style === "iec" ? BYTE_UNIT_MAP : SI_BYTE_UNIT_MAP
  const factor = map[unit]
  if (factor === undefined) throw new Error(`humanize.bytes_parse: unknown unit '${m[2]}'`)
  return Math.round(num * factor)
}

// ---------- durations ----------

const MS_UNIT = 1
const SEC_UNIT = 1000
const MIN_UNIT = 60 * SEC_UNIT
const HOUR_UNIT = 60 * MIN_UNIT
const DAY_UNIT = 24 * HOUR_UNIT
const WEEK_UNIT = 7 * DAY_UNIT

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms)) return String(ms)
  if (ms === 0) return "0s"
  const negative = ms < 0
  let rest = Math.abs(ms)
  if (rest < SEC_UNIT) {
    return `${negative ? "-" : ""}${trimDecimal(rest, 0)} ms`
  }
  const parts: string[] = []
  const w = Math.floor(rest / WEEK_UNIT)
  if (w) parts.push(`${w}w`)
  rest -= w * WEEK_UNIT
  const d = Math.floor(rest / DAY_UNIT)
  if (d) parts.push(`${d}d`)
  rest -= d * DAY_UNIT
  const h = Math.floor(rest / HOUR_UNIT)
  if (h) parts.push(`${h}h`)
  rest -= h * HOUR_UNIT
  const mn = Math.floor(rest / MIN_UNIT)
  if (mn) parts.push(`${mn}m`)
  rest -= mn * MIN_UNIT
  const s = Math.floor(rest / SEC_UNIT)
  if (s || parts.length === 0) parts.push(`${s}s`)
  return `${negative ? "-" : ""}${parts.join(" ")}`
}

const DURATION_UNITS: Record<string, number> = {
  ms: MS_UNIT,
  millisecond: MS_UNIT,
  milliseconds: MS_UNIT,
  s: SEC_UNIT,
  sec: SEC_UNIT,
  secs: SEC_UNIT,
  second: SEC_UNIT,
  seconds: SEC_UNIT,
  m: MIN_UNIT,
  min: MIN_UNIT,
  mins: MIN_UNIT,
  minute: MIN_UNIT,
  minutes: MIN_UNIT,
  h: HOUR_UNIT,
  hr: HOUR_UNIT,
  hrs: HOUR_UNIT,
  hour: HOUR_UNIT,
  hours: HOUR_UNIT,
  d: DAY_UNIT,
  day: DAY_UNIT,
  days: DAY_UNIT,
  w: WEEK_UNIT,
  wk: WEEK_UNIT,
  week: WEEK_UNIT,
  weeks: WEEK_UNIT,
}

export function parseDuration(input: string): number {
  const cleaned = input.trim()
  if (!cleaned) throw new Error("humanize.duration_parse: empty input")
  const negative = cleaned.startsWith("-")
  const body = negative ? cleaned.slice(1) : cleaned
  // Pure number → assume ms.
  if (/^\d+(?:\.\d+)?$/.test(body)) {
    return Math.round((negative ? -1 : 1) * parseFloat(body))
  }
  // Find groups of <number><unit>.
  const groups = body.match(/(\d+(?:\.\d+)?)\s*([a-zA-Z]+)/g)
  if (!groups || groups.length === 0)
    throw new Error(`humanize.duration_parse: cannot parse '${input}'`)
  // Verify nothing other than groups + whitespace+ between them.
  const remainder = body.replace(/(\d+(?:\.\d+)?)\s*([a-zA-Z]+)/g, "").trim()
  if (remainder) throw new Error(`humanize.duration_parse: unexpected content '${remainder}'`)
  let total = 0
  for (const g of groups) {
    const m = /^(\d+(?:\.\d+)?)\s*([a-zA-Z]+)$/.exec(g)!
    const num = parseFloat(m[1])
    const unit = m[2].toLowerCase()
    const factor = DURATION_UNITS[unit]
    if (factor === undefined) throw new Error(`humanize.duration_parse: unknown unit '${m[2]}'`)
    total += num * factor
  }
  return Math.round((negative ? -1 : 1) * total)
}

// ---------- numbers ----------

export function formatNumber(
  n: number,
  opts: { locale?: string; decimals?: number; compact?: boolean } = {},
): string {
  if (!Number.isFinite(n)) return String(n)
  const decimals = opts.decimals ?? 0
  const locale = opts.locale ?? "en-US"
  if (opts.compact) {
    return new Intl.NumberFormat(locale, {
      notation: "compact",
      maximumFractionDigits: decimals === 0 ? 1 : decimals,
    }).format(n)
  }
  return new Intl.NumberFormat(locale, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(n)
}

export function parseNumber(input: string): number {
  const cleaned = input.trim().replace(/[\s,_]/g, "")
  // Handle compact suffixes like 1.2K, 3M, 4.5B, 6T.
  const suffixMatch = /^(-?\d+(?:\.\d+)?)([kmbtKMBT])$/.exec(cleaned)
  if (suffixMatch) {
    const num = parseFloat(suffixMatch[1])
    const suffix = suffixMatch[2].toLowerCase()
    const mult = suffix === "k" ? 1e3 : suffix === "m" ? 1e6 : suffix === "b" ? 1e9 : 1e12
    return num * mult
  }
  const num = Number(cleaned)
  if (!Number.isFinite(num)) throw new Error(`humanize.number_parse: cannot parse '${input}'`)
  return num
}

// ---------- ordinal / pluralize ----------

export function ordinal(n: number): string {
  if (!Number.isFinite(n)) return String(n)
  const abs = Math.abs(Math.trunc(n))
  const lastTwo = abs % 100
  const last = abs % 10
  let suffix = "th"
  if (lastTwo < 11 || lastTwo > 13) {
    if (last === 1) suffix = "st"
    else if (last === 2) suffix = "nd"
    else if (last === 3) suffix = "rd"
  }
  return `${Math.trunc(n)}${suffix}`
}

export function pluralize(noun: string, count: number, plural?: string): string {
  if (count === 1 || count === -1) return `${count} ${noun}`
  const form = plural ?? `${noun}s`
  return `${count} ${form}`
}

// ---------- relative time ----------

export function relativeTime(deltaMs: number): string {
  if (!Number.isFinite(deltaMs)) return String(deltaMs)
  const past = deltaMs > 0
  const abs = Math.abs(deltaMs)
  if (abs < 1000) return past ? "just now" : "just now"
  const tiers: Array<{ unit: string; ms: number }> = [
    { unit: "year", ms: 365 * DAY_UNIT },
    { unit: "month", ms: 30 * DAY_UNIT },
    { unit: "week", ms: WEEK_UNIT },
    { unit: "day", ms: DAY_UNIT },
    { unit: "hour", ms: HOUR_UNIT },
    { unit: "minute", ms: MIN_UNIT },
    { unit: "second", ms: SEC_UNIT },
  ]
  for (const t of tiers) {
    if (abs >= t.ms) {
      const v = Math.floor(abs / t.ms)
      const unit = `${t.unit}${v === 1 ? "" : "s"}`
      return past ? `${v} ${unit} ago` : `in ${v} ${unit}`
    }
  }
  return past ? "just now" : "just now"
}

// ---------- slug ----------

export function slug(input: string, maxLength = 80): string {
  // NFKD splits accented letters into base + combining mark; \p{Mn} drops the mark.
  const normalized = input.normalize("NFKD").replace(/\p{Mn}/gu, "")
  const lowered = normalized.toLowerCase()
  const replaced = lowered.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
  return replaced.slice(0, maxLength).replace(/-+$/g, "")
}

// ---------- tool definition ----------

export const HumanizeTool = Tool.define(
  "humanize",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Params, _ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const action = params.action
          const style: Style = params.style ?? "iec"

          if (action === "bytes_format") {
            if (params.n === undefined) throw new Error("humanize.bytes_format: requires `n`")
            const decimals = params.decimals ?? 2
            const formatted = formatBytes(params.n, style, decimals)
            return done({
              title: `humanize.bytes_format: ${formatted}`,
              metadata: { action, formatted, bytes: params.n },
              output: formatted,
            })
          }

          if (action === "bytes_parse") {
            if (!params.value) throw new Error("humanize.bytes_parse: requires `value`")
            const bytes = parseBytes(params.value, style)
            return done({
              title: `humanize.bytes_parse: ${bytes}`,
              metadata: { action, parsed: bytes, bytes },
              output: String(bytes),
            })
          }

          if (action === "duration_format") {
            if (params.n === undefined) throw new Error("humanize.duration_format: requires `n`")
            const formatted = formatDuration(params.n)
            return done({
              title: `humanize.duration_format: ${formatted}`,
              metadata: { action, formatted, ms: params.n },
              output: formatted,
            })
          }

          if (action === "duration_parse") {
            if (!params.value) throw new Error("humanize.duration_parse: requires `value`")
            const ms = parseDuration(params.value)
            return done({
              title: `humanize.duration_parse: ${ms}ms`,
              metadata: { action, parsed: ms, ms },
              output: String(ms),
            })
          }

          if (action === "number_format") {
            if (params.n === undefined) throw new Error("humanize.number_format: requires `n`")
            const formatted = formatNumber(params.n, {
              decimals: params.decimals,
              locale: params.locale,
              compact: params.compact,
            })
            return done({
              title: `humanize.number_format: ${formatted}`,
              metadata: { action, formatted },
              output: formatted,
            })
          }

          if (action === "number_parse") {
            if (!params.value) throw new Error("humanize.number_parse: requires `value`")
            const parsed = parseNumber(params.value)
            return done({
              title: `humanize.number_parse: ${parsed}`,
              metadata: { action, parsed },
              output: String(parsed),
            })
          }

          if (action === "ordinal") {
            if (params.n === undefined) throw new Error("humanize.ordinal: requires `n`")
            const formatted = ordinal(params.n)
            return done({
              title: `humanize.ordinal: ${formatted}`,
              metadata: { action, formatted },
              output: formatted,
            })
          }

          if (action === "pluralize") {
            if (!params.noun) throw new Error("humanize.pluralize: requires `noun`")
            if (params.count === undefined) throw new Error("humanize.pluralize: requires `count`")
            const formatted = pluralize(params.noun, params.count, params.plural)
            return done({
              title: `humanize.pluralize: ${formatted}`,
              metadata: { action, formatted },
              output: formatted,
            })
          }

          if (action === "relative_time") {
            if (params.n === undefined) throw new Error("humanize.relative_time: requires `n`")
            const formatted = relativeTime(params.n)
            return done({
              title: `humanize.relative_time: ${formatted}`,
              metadata: { action, formatted, ms: params.n },
              output: formatted,
            })
          }

          if (action === "slug") {
            if (!params.text) throw new Error("humanize.slug: requires `text`")
            const formatted = slug(params.text, params.max_length ?? 80)
            return done({
              title: `humanize.slug: ${formatted}`,
              metadata: { action, formatted },
              output: formatted,
            })
          }

          throw new Error(`humanize: unknown action '${action satisfies never}'`)
        }),
    }
  }),
)

export const __testing = {
  formatBytes,
  parseBytes,
  formatDuration,
  parseDuration,
  formatNumber,
  parseNumber,
  ordinal,
  pluralize,
  relativeTime,
  slug,
}
