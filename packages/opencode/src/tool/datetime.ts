import { Effect, Schema } from "effect"
import DESCRIPTION from "./datetime.txt"
import * as Tool from "./tool"

const ACTIONS = ["now", "parse", "format", "add", "diff"] as const

export const Parameters = Schema.Struct({
  action: Schema.Literals(ACTIONS).annotate({
    description:
      "One of 'now' (current time), 'parse' (parse a value), 'format' (reformat a value in another timezone), 'add' (value + duration), 'diff' (value2 - value).",
  }),
  value: Schema.optional(Schema.String).annotate({
    description:
      "Input timestamp for parse/format/add/diff. Accepts ISO-8601, RFC 2822, or a numeric string in unix-epoch-seconds (1e9..1e10) or unix-epoch-millis (>1e12).",
  }),
  value2: Schema.optional(Schema.String).annotate({
    description: "Second timestamp, required for action='diff'. Same format options as value.",
  }),
  duration: Schema.optional(Schema.String).annotate({
    description:
      "Required for action='add'. Signed compound: '1d', '2h30m', '-15m', '500ms', '7d12h'. Units: ms, s, m, h, d, w.",
  }),
  timezone: Schema.optional(Schema.String).annotate({
    description:
      "IANA timezone for the formatted output (e.g. 'Europe/London'). The instant itself is unchanged. Default is host local.",
  }),
})

type Params = Schema.Schema.Type<typeof Parameters>
type Action = (typeof ACTIONS)[number]

type DiffBreakdown = {
  total_ms: number
  sign: -1 | 0 | 1
  days: number
  hours: number
  minutes: number
  seconds: number
  millis: number
  humanised: string
}

type Metadata = {
  action: Action
  timezone: string
  iso?: string
  epoch_ms?: number
  formatted?: string
  weekday?: string
  utc_offset_minutes?: number
  diff?: DiffBreakdown
  duration_ms?: number
  input?: string
  input2?: string
}

const done = (result: Tool.ExecuteResult<Metadata>) => result

function validateTimezone(tz: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz })
  } catch {
    throw new Error(`datetime: invalid timezone '${tz}'`)
  }
}

export function parseTimestamp(input: string): Date {
  const trimmed = input.trim()
  if (!trimmed) throw new Error("datetime: empty input")
  // Pure numeric — interpret as epoch seconds or millis.
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    const n = Number(trimmed)
    if (!Number.isFinite(n)) throw new Error(`datetime: not finite '${input}'`)
    // Heuristic: |n| > 1e12 → millis, else seconds. (1e12 ms ≈ year 2001.)
    const ms = Math.abs(n) >= 1e12 ? n : n * 1000
    const date = new Date(ms)
    if (Number.isNaN(date.getTime())) throw new Error(`datetime: cannot parse epoch '${input}'`)
    return date
  }
  const t = Date.parse(trimmed)
  if (Number.isNaN(t)) throw new Error(`datetime: cannot parse '${input}' (try ISO-8601, e.g. 2026-04-29T12:00:00Z)`)
  return new Date(t)
}

const DURATION_UNITS_MS: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 7 * 86_400_000,
}

export function parseDuration(input: string): number {
  const trimmed = input.trim()
  if (!trimmed) throw new Error("datetime: empty duration")
  let sign = 1
  let rest = trimmed
  if (rest.startsWith("-")) {
    sign = -1
    rest = rest.slice(1)
  } else if (rest.startsWith("+")) {
    rest = rest.slice(1)
  }
  if (!rest) throw new Error(`datetime: empty duration after sign in '${input}'`)
  // Tokenise: number followed by unit. Support the order ms before m.
  const re = /(\d+)(ms|s|m|h|d|w)/g
  let total = 0
  let cursor = 0
  let match: RegExpExecArray | null
  while ((match = re.exec(rest)) !== null) {
    if (match.index !== cursor) {
      throw new Error(`datetime: unexpected character at offset ${cursor} in duration '${input}'`)
    }
    const n = Number(match[1])
    const unit = match[2]!
    const ms = DURATION_UNITS_MS[unit]
    if (ms === undefined) throw new Error(`datetime: unknown duration unit '${unit}' in '${input}'`)
    total += n * ms
    cursor = re.lastIndex
  }
  if (cursor !== rest.length) {
    throw new Error(`datetime: cannot parse duration '${input}' (expected like '1d2h30m', units ms/s/m/h/d/w)`)
  }
  return total * sign
}

function getTzParts(date: Date, tz: string): {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
  weekday: string
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
  const hour = Number(map.hour) === 24 ? 0 : Number(map.hour)
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour,
    minute: Number(map.minute),
    second: Number(map.second),
    weekday: map.weekday ?? "?",
  }
}

export function formatInTimezone(date: Date, tz: string): { formatted: string; offsetMinutes: number; weekday: string } {
  const parts = getTzParts(date, tz)
  const utcParts = getTzParts(date, "UTC")
  const tzMinutes = parts.hour * 60 + parts.minute
  const utcMinutes = utcParts.hour * 60 + utcParts.minute
  let offsetMinutes = tzMinutes - utcMinutes
  const tzDayKey = parts.year * 10000 + parts.month * 100 + parts.day
  const utcDayKey = utcParts.year * 10000 + utcParts.month * 100 + utcParts.day
  if (tzDayKey > utcDayKey) offsetMinutes += 24 * 60
  if (tzDayKey < utcDayKey) offsetMinutes -= 24 * 60
  const pad = (n: number, w = 2) => String(n).padStart(w, "0")
  const sign = offsetMinutes >= 0 ? "+" : "-"
  const abs = Math.abs(offsetMinutes)
  const offH = pad(Math.floor(abs / 60))
  const offM = pad(abs % 60)
  const offsetStr = tz === "UTC" ? "Z" : `${sign}${offH}:${offM}`
  const formatted = `${parts.year}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}${offsetStr}`
  return { formatted, offsetMinutes, weekday: parts.weekday }
}

export function diff(a: Date, b: Date): DiffBreakdown {
  const totalMs = b.getTime() - a.getTime()
  const sign: -1 | 0 | 1 = totalMs === 0 ? 0 : totalMs > 0 ? 1 : -1
  let abs = Math.abs(totalMs)
  const days = Math.floor(abs / 86_400_000); abs -= days * 86_400_000
  const hours = Math.floor(abs / 3_600_000); abs -= hours * 3_600_000
  const minutes = Math.floor(abs / 60_000); abs -= minutes * 60_000
  const seconds = Math.floor(abs / 1000); abs -= seconds * 1000
  const millis = abs
  const parts: string[] = []
  if (days) parts.push(`${days}d`)
  if (hours) parts.push(`${hours}h`)
  if (minutes) parts.push(`${minutes}m`)
  if (seconds) parts.push(`${seconds}s`)
  if (millis && parts.length < 2) parts.push(`${millis}ms`)
  if (parts.length === 0) parts.push("0s")
  const humanised = (sign < 0 ? "-" : "") + parts.join(" ")
  return { total_ms: totalMs, sign, days, hours, minutes, seconds, millis, humanised }
}

export const DateTimeTool = Tool.define(
  "datetime",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Params, _ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const tz = params.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC"
          try {
            validateTimezone(tz)
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            throw new Error(msg)
          }

          const action = params.action
          const meta: Metadata = { action, timezone: tz }

          if (action === "now") {
            const now = new Date()
            const f = formatInTimezone(now, tz)
            meta.iso = now.toISOString()
            meta.epoch_ms = now.getTime()
            meta.formatted = f.formatted
            meta.weekday = f.weekday
            meta.utc_offset_minutes = f.offsetMinutes
            return done({
              title: `now: ${f.formatted} (${tz})`,
              metadata: meta,
              output: [
                `Now in ${tz}: ${f.formatted} (${f.weekday})`,
                `UTC ISO:    ${meta.iso}`,
                `Epoch ms:   ${meta.epoch_ms}`,
                `UTC offset: ${f.offsetMinutes >= 0 ? "+" : "-"}${Math.floor(Math.abs(f.offsetMinutes) / 60)}:${String(Math.abs(f.offsetMinutes) % 60).padStart(2, "0")}`,
              ].join("\n"),
            })
          }

          if (action === "parse" || action === "format") {
            if (!params.value) throw new Error(`datetime: '${action}' requires 'value'`)
            const parsed = parseTimestamp(params.value)
            const f = formatInTimezone(parsed, tz)
            meta.input = params.value
            meta.iso = parsed.toISOString()
            meta.epoch_ms = parsed.getTime()
            meta.formatted = f.formatted
            meta.weekday = f.weekday
            meta.utc_offset_minutes = f.offsetMinutes
            return done({
              title: `${action}: ${f.formatted}`,
              metadata: meta,
              output: [
                `Input:      ${params.value}`,
                `UTC ISO:    ${meta.iso}`,
                `Epoch ms:   ${meta.epoch_ms}`,
                `Formatted:  ${f.formatted} (${f.weekday}, ${tz})`,
              ].join("\n"),
            })
          }

          if (action === "add") {
            if (!params.value) throw new Error("datetime: 'add' requires 'value'")
            if (!params.duration) throw new Error("datetime: 'add' requires 'duration'")
            const base = parseTimestamp(params.value)
            const dur = parseDuration(params.duration)
            const out = new Date(base.getTime() + dur)
            const f = formatInTimezone(out, tz)
            meta.input = params.value
            meta.iso = out.toISOString()
            meta.epoch_ms = out.getTime()
            meta.formatted = f.formatted
            meta.weekday = f.weekday
            meta.utc_offset_minutes = f.offsetMinutes
            meta.duration_ms = dur
            return done({
              title: `add ${params.duration} → ${f.formatted}`,
              metadata: meta,
              output: [
                `Base:        ${params.value}`,
                `Duration:    ${params.duration} (${dur >= 0 ? "+" : ""}${dur} ms)`,
                `Result UTC:  ${meta.iso}`,
                `Result tz:   ${f.formatted} (${f.weekday}, ${tz})`,
              ].join("\n"),
            })
          }

          if (action === "diff") {
            if (!params.value) throw new Error("datetime: 'diff' requires 'value'")
            if (!params.value2) throw new Error("datetime: 'diff' requires 'value2'")
            const a = parseTimestamp(params.value)
            const b = parseTimestamp(params.value2)
            const d = diff(a, b)
            meta.input = params.value
            meta.input2 = params.value2
            meta.iso = b.toISOString()
            meta.epoch_ms = b.getTime()
            meta.diff = d
            return done({
              title: `diff: ${d.humanised}`,
              metadata: meta,
              output: [
                `From: ${params.value}`,
                `To:   ${params.value2}`,
                `Diff: ${d.humanised}  (${d.total_ms} ms, sign=${d.sign > 0 ? "+" : d.sign < 0 ? "-" : "0"})`,
                `      days=${d.days} h=${d.hours} m=${d.minutes} s=${d.seconds} ms=${d.millis}`,
              ].join("\n"),
            })
          }

          throw new Error(`datetime: unsupported action '${action}'`)
        }),
    }
  }),
)

export const __testing = {
  parseTimestamp,
  parseDuration,
  formatInTimezone,
  diff,
}
