import { Effect, Schema } from "effect"
import DESCRIPTION from "./cron.txt"
import * as Tool from "./tool"

const MAX_COUNT = 50
const DEFAULT_COUNT = 5
// Hard ceiling so a malformed expression with a sparse match cannot run forever.
const MAX_ITERATIONS = 366 * 24 * 60 * 8 // ~8 years of minute slots

export const Parameters = Schema.Struct({
  expression: Schema.String.check(Schema.isMinLength(1)).annotate({
    description:
      "Standard 5-field Unix cron expression: 'minute hour day-of-month month day-of-week'. Supports *, ranges (1-5), lists (1,3,5), step (*/15), month names (jan-dec), weekday names (mon-sun, sun=0=7), and macros (@yearly, @monthly, @weekly, @daily, @hourly).",
  }),
  count: Schema.optional(
    Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(MAX_COUNT)),
  ).annotate({
    description: `How many upcoming fire times to compute. Range 1-${MAX_COUNT}. Default ${DEFAULT_COUNT}.`,
  }),
  from: Schema.optional(Schema.String).annotate({
    description: "Optional ISO-8601 anchor (e.g. '2026-04-29T12:00:00Z'). Default is now.",
  }),
  timezone: Schema.optional(Schema.String).annotate({
    description:
      "Optional IANA timezone (e.g. 'Europe/London'). The cron expression is interpreted in this timezone. Default is the host local timezone.",
  }),
})

type Params = Schema.Schema.Type<typeof Parameters>

type Field = Set<number>

type ParsedCron = {
  minute: Field
  hour: Field
  dayOfMonth: Field
  month: Field
  dayOfWeek: Field
  // Whether dayOfMonth and dayOfWeek were both restricted in the original expression
  // (controls Vixie cron OR semantics).
  domRestricted: boolean
  dowRestricted: boolean
  normalized: string
}

type Metadata = {
  valid: boolean
  expression: string
  normalized?: string
  count?: number
  from?: string
  timezone: string
  next?: string[]
  error?: string
  iterations?: number
}

const done = (result: Tool.ExecuteResult<Metadata>) => result

const MACROS: Record<string, string> = {
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *",
}

const MONTH_NAMES: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
}

const WEEKDAY_NAMES: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
}

type FieldSpec = {
  min: number
  max: number
  names?: Record<string, number>
}

const FIELD_SPECS: Record<"minute" | "hour" | "dayOfMonth" | "month" | "dayOfWeek", FieldSpec> = {
  minute: { min: 0, max: 59 },
  hour: { min: 0, max: 23 },
  dayOfMonth: { min: 1, max: 31 },
  month: { min: 1, max: 12, names: MONTH_NAMES },
  dayOfWeek: { min: 0, max: 7, names: WEEKDAY_NAMES }, // 0 and 7 both Sunday
}

function parseFieldToken(token: string, spec: FieldSpec, original: string): number {
  const lower = token.toLowerCase()
  if (spec.names && spec.names[lower] !== undefined) return spec.names[lower]!
  if (!/^-?\d+$/.test(token)) {
    throw new Error(`cron: invalid token '${token}' in '${original}'`)
  }
  const n = Number(token)
  if (n < spec.min || n > spec.max) {
    throw new Error(`cron: value ${n} out of range ${spec.min}-${spec.max} in '${original}'`)
  }
  return n
}

export function parseField(input: string, spec: FieldSpec, fieldName: string): { values: Field; restricted: boolean; canonical: string } {
  const trimmed = input.trim()
  if (trimmed === "") throw new Error(`cron: empty ${fieldName} field`)

  // Track whether this field is anything other than a wildcard, for OR semantics.
  const isWildcard = trimmed === "*" || /^\*\/\d+$/.test(trimmed)

  const values = new Set<number>()
  const parts = trimmed.split(",")
  const canonicalParts: string[] = []
  for (const partRaw of parts) {
    const part = partRaw.trim()
    if (!part) throw new Error(`cron: empty list element in ${fieldName} '${input}'`)
    let stepPart = "1"
    let rangePart = part
    const slash = part.indexOf("/")
    if (slash >= 0) {
      rangePart = part.slice(0, slash)
      stepPart = part.slice(slash + 1)
      if (!/^\d+$/.test(stepPart) || Number(stepPart) <= 0) {
        throw new Error(`cron: invalid step '/${stepPart}' in ${fieldName} '${input}'`)
      }
    }
    const step = Number(stepPart)
    let lo: number
    let hi: number
    if (rangePart === "*" || rangePart === "") {
      lo = spec.min
      hi = spec.max
    } else if (rangePart.includes("-")) {
      const dash = rangePart.indexOf("-")
      const a = rangePart.slice(0, dash)
      const b = rangePart.slice(dash + 1)
      lo = parseFieldToken(a, spec, input)
      hi = parseFieldToken(b, spec, input)
      if (hi < lo) throw new Error(`cron: range ${lo}-${hi} reversed in ${fieldName} '${input}'`)
    } else {
      lo = parseFieldToken(rangePart, spec, input)
      hi = lo
      if (slash >= 0) {
        // /n with a single number means "from N stepping by step until max", per Vixie cron.
        hi = spec.max
      }
    }
    for (let v = lo; v <= hi; v += step) {
      values.add(v)
    }
    canonicalParts.push(part.toLowerCase())
  }

  // Fold day-of-week 7 to 0 so set membership is unique.
  if (fieldName === "dayOfWeek" && values.has(7)) {
    values.delete(7)
    values.add(0)
  }

  if (values.size === 0) throw new Error(`cron: ${fieldName} '${input}' matched no values`)

  return { values, restricted: !isWildcard, canonical: canonicalParts.join(",") }
}

export function parseCron(rawInput: string): ParsedCron {
  const input = rawInput.trim()
  if (!input) throw new Error("cron: expression is empty")
  let expr = input
  if (expr.startsWith("@")) {
    const macro = expr.toLowerCase()
    const replaced = MACROS[macro]
    if (!replaced) throw new Error(`cron: unknown macro '${expr}'`)
    expr = replaced
  }
  const fields = expr.split(/\s+/)
  if (fields.length !== 5) {
    throw new Error(`cron: expected 5 fields, got ${fields.length} in '${input}'`)
  }
  const [m, h, dom, mon, dow] = fields as [string, string, string, string, string]
  const minute = parseField(m, FIELD_SPECS.minute, "minute")
  const hour = parseField(h, FIELD_SPECS.hour, "hour")
  const dayOfMonth = parseField(dom, FIELD_SPECS.dayOfMonth, "dayOfMonth")
  const month = parseField(mon, FIELD_SPECS.month, "month")
  const dayOfWeek = parseField(dow, FIELD_SPECS.dayOfWeek, "dayOfWeek")

  const normalized = [minute.canonical, hour.canonical, dayOfMonth.canonical, month.canonical, dayOfWeek.canonical].join(" ")

  return {
    minute: minute.values,
    hour: hour.values,
    dayOfMonth: dayOfMonth.values,
    month: month.values,
    dayOfWeek: dayOfWeek.values,
    domRestricted: dayOfMonth.restricted,
    dowRestricted: dayOfWeek.restricted,
    normalized,
  }
}

// Build a Date that represents the wall-clock instant in the given timezone.
// We use Intl.DateTimeFormat to resolve the timezone-local "now" and then
// iterate minute by minute by converting wall-clock-tz-fields to a UTC instant
// via successive approximation.
function getTzParts(date: Date, tz: string): {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
  weekday: number
} {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "short",
    hour12: false,
  })
  const parts = fmt.formatToParts(date)
  const map: Record<string, string> = {}
  for (const p of parts) map[p.type] = p.value
  const weekdayMap: Record<string, number> = {
    Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
  }
  const hour = Number(map.hour) === 24 ? 0 : Number(map.hour)
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour,
    minute: Number(map.minute),
    second: Number(map.second),
    weekday: weekdayMap[map.weekday ?? "Sun"] ?? 0,
  }
}

function validateTimezone(tz: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz })
  } catch {
    throw new Error(`cron: invalid timezone '${tz}'`)
  }
}

function fieldMatches(parsed: ParsedCron, parts: { month: number; day: number; weekday: number; hour: number; minute: number }): boolean {
  if (!parsed.minute.has(parts.minute)) return false
  if (!parsed.hour.has(parts.hour)) return false
  if (!parsed.month.has(parts.month)) return false
  // Vixie cron OR semantics: when BOTH dayOfMonth and dayOfWeek are restricted,
  // a match on EITHER is sufficient. Otherwise both (or the one that's restricted) must match.
  const domMatch = parsed.dayOfMonth.has(parts.day)
  const dowMatch = parsed.dayOfWeek.has(parts.weekday)
  if (parsed.domRestricted && parsed.dowRestricted) return domMatch || dowMatch
  return domMatch && dowMatch
}

export function nextFireTimes(parsed: ParsedCron, anchor: Date, timezone: string, count: number): { next: Date[]; iterations: number } {
  validateTimezone(timezone)
  // Round anchor up to the next minute so we don't return the current minute.
  const start = new Date(Math.floor(anchor.getTime() / 60_000) * 60_000 + 60_000)
  const fires: Date[] = []
  let cursor = start.getTime()
  let iterations = 0
  while (fires.length < count && iterations < MAX_ITERATIONS) {
    iterations++
    const date = new Date(cursor)
    const parts = getTzParts(date, timezone)
    if (parts.second === 0 && fieldMatches(parsed, parts)) {
      fires.push(date)
    }
    cursor += 60_000
  }
  return { next: fires, iterations }
}

function formatInTimezone(date: Date, tz: string): string {
  const parts = getTzParts(date, tz)
  const pad = (n: number, w = 2) => String(n).padStart(w, "0")
  // Compute the offset by comparing the timezone wall clock to UTC wall clock for the same instant.
  const utcParts = getTzParts(date, "UTC")
  const tzMinutes = parts.hour * 60 + parts.minute
  const utcMinutes = utcParts.hour * 60 + utcParts.minute
  let offsetMinutes = tzMinutes - utcMinutes
  // Account for date rollover at the boundary.
  const tzDayKey = parts.year * 10000 + parts.month * 100 + parts.day
  const utcDayKey = utcParts.year * 10000 + utcParts.month * 100 + utcParts.day
  if (tzDayKey > utcDayKey) offsetMinutes += 24 * 60
  if (tzDayKey < utcDayKey) offsetMinutes -= 24 * 60
  const sign = offsetMinutes >= 0 ? "+" : "-"
  const abs = Math.abs(offsetMinutes)
  const offH = pad(Math.floor(abs / 60))
  const offM = pad(abs % 60)
  const offsetStr = tz === "UTC" ? "Z" : `${sign}${offH}:${offM}`
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}${offsetStr}`
}

export const CronTool = Tool.define(
  "cron",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Params, _ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const expression = params.expression.trim()
          const count = params.count ?? DEFAULT_COUNT
          const tz = params.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC"
          let anchor: Date
          if (params.from) {
            const t = Date.parse(params.from)
            if (Number.isNaN(t)) {
              return done({
                title: `cron: invalid 'from' anchor`,
                metadata: {
                  valid: false,
                  expression,
                  timezone: tz,
                  error: `cannot parse 'from' as ISO-8601: '${params.from}'`,
                },
                output: `cron: invalid 'from' anchor: '${params.from}' is not a valid ISO-8601 timestamp`,
              })
            }
            anchor = new Date(t)
          } else {
            anchor = new Date()
          }

          let parsed: ParsedCron
          try {
            parsed = parseCron(expression)
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            return done({
              title: `cron: invalid expression`,
              metadata: { valid: false, expression, timezone: tz, error: msg },
              output: `Invalid cron expression: ${msg}`,
            })
          }

          // Validate the timezone before iterating to surface a clean error.
          try {
            validateTimezone(tz)
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            return done({
              title: `cron: invalid timezone`,
              metadata: { valid: false, expression, normalized: parsed.normalized, timezone: tz, error: msg },
              output: msg,
            })
          }

          const { next, iterations } = nextFireTimes(parsed, anchor, tz, count)
          const formatted = next.map((d) => formatInTimezone(d, tz))

          const lines: string[] = [
            `cron expression: ${expression}`,
            `normalized:      ${parsed.normalized}`,
            `timezone:        ${tz}`,
            `anchor:          ${formatInTimezone(anchor, tz)}`,
            `next ${formatted.length} fire times:`,
            ...formatted.map((s, i) => `  ${String(i + 1).padStart(2, " ")}. ${s}`),
          ]
          if (formatted.length < count) {
            lines.push(
              `(stopped after ${iterations} iterations without finding ${count} matches — expression may match very rarely)`,
            )
          }

          return done({
            title: `cron: ${parsed.normalized} (${formatted.length} fire times)`,
            metadata: {
              valid: true,
              expression,
              normalized: parsed.normalized,
              count: formatted.length,
              from: anchor.toISOString(),
              timezone: tz,
              next: formatted,
              iterations,
            },
            output: lines.join("\n"),
          })
        }),
    }
  }),
)

export const __testing = {
  parseField,
  parseCron,
  nextFireTimes,
  formatInTimezone,
  getTzParts,
  MACROS,
}
