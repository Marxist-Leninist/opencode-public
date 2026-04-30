import { Effect, Schema } from "effect"
import * as path from "node:path"
import { readFile } from "node:fs/promises"
import { Instance } from "../project/instance"
import { assertExternalDirectoryEffect } from "./external-directory"
import DESCRIPTION from "./ical.txt"
import * as Tool from "./tool"

const ACTIONS = ["parse", "build", "info"] as const

export const Parameters = Schema.Struct({
  action: Schema.Literals(ACTIONS).annotate({
    description:
      "What to do: 'parse' (decode ICS text into events), 'build' (encode events into ICS text), 'info' (quick header summary of an ICS blob).",
  }),
  text: Schema.optional(Schema.String.check(Schema.isMaxLength(2_097_152))).annotate({
    description: "ICS text content for parse/info. Up to 2 MB. Mutually exclusive with file.",
  }),
  file: Schema.optional(Schema.String).annotate({
    description: "Path to an .ics file for parse/info. Absolute preferred; relative resolves from project dir.",
  }),
  events: Schema.optional(
    Schema.Array(
      Schema.Struct({
        uid: Schema.optional(Schema.String).annotate({
          description: "RFC 5545 UID. If omitted, a deterministic uid based on summary+dtstart is generated.",
        }),
        summary: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1000)).annotate({
          description: "Event title.",
        }),
        dtstart: Schema.String.annotate({
          description:
            "Start date-time. Accepted: ISO 8601 ('2026-04-30T09:00:00Z'), RFC 5545 ('20260430T090000Z'), or all-day 'YYYY-MM-DD' (becomes VALUE=DATE).",
        }),
        dtend: Schema.optional(Schema.String).annotate({
          description: "End date-time. Same formats as dtstart.",
        }),
        duration_minutes: Schema.optional(
          Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(60_000_000)),
        ).annotate({
          description: "Alternative to dtend. Adds DURATION:PT<N>M.",
        }),
        description: Schema.optional(Schema.String.check(Schema.isMaxLength(8192))).annotate({
          description: "DESCRIPTION text. Newlines kept as-is, escaped per RFC 5545.",
        }),
        location: Schema.optional(Schema.String.check(Schema.isMaxLength(2048))).annotate({
          description: "LOCATION text.",
        }),
        organizer: Schema.optional(
          Schema.Struct({
            email: Schema.String.check(Schema.isMinLength(3), Schema.isMaxLength(320)),
            cn: Schema.optional(Schema.String.check(Schema.isMaxLength(255))),
          }),
        ).annotate({
          description: "ORGANIZER (optional).",
        }),
        attendees: Schema.optional(
          Schema.Array(
            Schema.Struct({
              email: Schema.String.check(Schema.isMinLength(3), Schema.isMaxLength(320)),
              cn: Schema.optional(Schema.String.check(Schema.isMaxLength(255))),
              role: Schema.optional(Schema.Literals(["CHAIR", "REQ-PARTICIPANT", "OPT-PARTICIPANT", "NON-PARTICIPANT"])),
              partstat: Schema.optional(
                Schema.Literals(["NEEDS-ACTION", "ACCEPTED", "DECLINED", "TENTATIVE", "DELEGATED"]),
              ),
              rsvp: Schema.optional(Schema.Boolean),
            }),
          ),
        ).annotate({
          description: "List of ATTENDEEs.",
        }),
        status: Schema.optional(Schema.Literals(["TENTATIVE", "CONFIRMED", "CANCELLED"])).annotate({
          description: "STATUS property.",
        }),
        url: Schema.optional(Schema.String.check(Schema.isMaxLength(2048))).annotate({
          description: "URL property.",
        }),
        rrule: Schema.optional(Schema.String.check(Schema.isMaxLength(1024))).annotate({
          description: "Raw RRULE value (e.g. 'FREQ=WEEKLY;BYDAY=MO,WE;COUNT=10').",
        }),
        categories: Schema.optional(Schema.Array(Schema.String.check(Schema.isMaxLength(255)))).annotate({
          description: "CATEGORIES list.",
        }),
      }),
    ),
  ).annotate({
    description: "Events for action='build'. At least one entry required.",
  }),
  prodid: Schema.optional(Schema.String.check(Schema.isMaxLength(255))).annotate({
    description: "Calendar PRODID for build. Default '-//SG OpenCode//ical tool//EN'.",
  }),
  calname: Schema.optional(Schema.String.check(Schema.isMaxLength(255))).annotate({
    description: "X-WR-CALNAME for build (optional).",
  }),
  method: Schema.optional(Schema.Literals(["PUBLISH", "REQUEST", "REPLY", "CANCEL", "REFRESH"])).annotate({
    description: "METHOD property for build (optional). Use REQUEST for invites.",
  }),
})

type Params = Schema.Schema.Type<typeof Parameters>
type Action = (typeof ACTIONS)[number]

type ParsedProperty = {
  name: string
  params: Record<string, string>
  value: string
}

type ParsedComponent = {
  type: string
  properties: ParsedProperty[]
  components: ParsedComponent[]
}

type ParsedEvent = {
  uid?: string
  summary?: string
  dtstart?: string
  dtstart_date?: boolean
  dtend?: string
  dtend_date?: boolean
  duration?: string
  description?: string
  location?: string
  organizer?: string
  organizer_cn?: string
  attendees: { email: string; cn?: string; role?: string; partstat?: string; rsvp?: boolean }[]
  status?: string
  url?: string
  rrule?: string
  categories?: string[]
  created?: string
  last_modified?: string
  sequence?: number
}

type Metadata = {
  action: Action
  prodid?: string
  calname?: string
  method?: string
  events_in?: number
  events_out?: number
  bytes_out?: number
  bytes_in?: number
  warnings?: string[]
}

const done = (result: Tool.ExecuteResult<Metadata>) => result

// --- ICS parsing -----------------------------------------------------------

function unfoldLines(text: string): string[] {
  const out: string[] = []
  // RFC 5545: a line starting with SPACE or TAB continues the previous one.
  const raw = text.replace(/\r\n/g, "\n").split("\n")
  for (const line of raw) {
    if ((line.startsWith(" ") || line.startsWith("\t")) && out.length > 0) {
      out[out.length - 1] += line.slice(1)
    } else {
      out.push(line)
    }
  }
  return out.filter((l) => l.length > 0)
}

function unescapeText(value: string): string {
  return value
    .replace(/\\N/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\")
}

function parseProperty(line: string): ParsedProperty {
  // Property = NAME[;PARAM=value;...]:VALUE
  // Params can contain quoted strings with colons inside, so walk char-by-char.
  let i = 0
  let inQuotes = false
  for (; i < line.length; i++) {
    const c = line[i]
    if (c === '"') inQuotes = !inQuotes
    else if (c === ":" && !inQuotes) break
  }
  const head = line.slice(0, i)
  const value = line.slice(i + 1)
  const segments = head.split(";")
  const name = segments[0].toUpperCase()
  const params: Record<string, string> = {}
  for (let j = 1; j < segments.length; j++) {
    const eq = segments[j].indexOf("=")
    if (eq <= 0) continue
    const k = segments[j].slice(0, eq).toUpperCase()
    let v = segments[j].slice(eq + 1)
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1)
    params[k] = v
  }
  return { name, params, value }
}

function parseComponents(lines: string[]): ParsedComponent[] {
  const stack: ParsedComponent[] = []
  const top: ParsedComponent[] = []
  for (const line of lines) {
    const prop = parseProperty(line)
    if (prop.name === "BEGIN") {
      const comp: ParsedComponent = { type: prop.value.toUpperCase(), properties: [], components: [] }
      if (stack.length === 0) top.push(comp)
      else stack[stack.length - 1].components.push(comp)
      stack.push(comp)
    } else if (prop.name === "END") {
      stack.pop()
    } else if (stack.length > 0) {
      stack[stack.length - 1].properties.push(prop)
    }
  }
  return top
}

function getProp(comp: ParsedComponent, name: string): ParsedProperty | undefined {
  return comp.properties.find((p) => p.name === name)
}

function getProps(comp: ParsedComponent, name: string): ParsedProperty[] {
  return comp.properties.filter((p) => p.name === name)
}

function isDateOnly(prop: ParsedProperty): boolean {
  return (prop.params.VALUE ?? "").toUpperCase() === "DATE"
}

function parseAttendee(prop: ParsedProperty) {
  const raw = prop.value
  const lower = raw.toLowerCase()
  const email = lower.startsWith("mailto:") ? raw.slice(7) : raw
  return {
    email,
    cn: prop.params.CN,
    role: prop.params.ROLE,
    partstat: prop.params.PARTSTAT,
    rsvp: prop.params.RSVP ? prop.params.RSVP.toUpperCase() === "TRUE" : undefined,
  }
}

function parseEvent(comp: ParsedComponent): ParsedEvent {
  const dtstart = getProp(comp, "DTSTART")
  const dtend = getProp(comp, "DTEND")
  const dur = getProp(comp, "DURATION")
  const summary = getProp(comp, "SUMMARY")
  const desc = getProp(comp, "DESCRIPTION")
  const loc = getProp(comp, "LOCATION")
  const uid = getProp(comp, "UID")
  const status = getProp(comp, "STATUS")
  const url = getProp(comp, "URL")
  const rrule = getProp(comp, "RRULE")
  const cats = getProp(comp, "CATEGORIES")
  const created = getProp(comp, "CREATED")
  const lastmod = getProp(comp, "LAST-MODIFIED")
  const seq = getProp(comp, "SEQUENCE")
  const organizer = getProp(comp, "ORGANIZER")

  const attendees = getProps(comp, "ATTENDEE").map(parseAttendee)

  let organizerEmail: string | undefined
  let organizerCn: string | undefined
  if (organizer) {
    const lower = organizer.value.toLowerCase()
    organizerEmail = lower.startsWith("mailto:") ? organizer.value.slice(7) : organizer.value
    organizerCn = organizer.params.CN
  }

  return {
    uid: uid?.value,
    summary: summary ? unescapeText(summary.value) : undefined,
    dtstart: dtstart?.value,
    dtstart_date: dtstart ? isDateOnly(dtstart) : undefined,
    dtend: dtend?.value,
    dtend_date: dtend ? isDateOnly(dtend) : undefined,
    duration: dur?.value,
    description: desc ? unescapeText(desc.value) : undefined,
    location: loc ? unescapeText(loc.value) : undefined,
    organizer: organizerEmail,
    organizer_cn: organizerCn,
    attendees,
    status: status?.value,
    url: url?.value,
    rrule: rrule?.value,
    categories: cats ? cats.value.split(",").map((s) => s.trim()).filter(Boolean) : undefined,
    created: created?.value,
    last_modified: lastmod?.value,
    sequence: seq ? Number(seq.value) : undefined,
  }
}

function parseCalendar(text: string): {
  prodid?: string
  calname?: string
  method?: string
  version?: string
  events: ParsedEvent[]
  warnings: string[]
} {
  const warnings: string[] = []
  const lines = unfoldLines(text)
  const components = parseComponents(lines)
  const cal = components.find((c) => c.type === "VCALENDAR")
  if (!cal) {
    warnings.push("no VCALENDAR component found")
    return { events: [], warnings }
  }
  const prodid = getProp(cal, "PRODID")?.value
  const calname = getProp(cal, "X-WR-CALNAME")?.value
  const method = getProp(cal, "METHOD")?.value
  const version = getProp(cal, "VERSION")?.value
  const events = cal.components.filter((c) => c.type === "VEVENT").map(parseEvent)
  return { prodid, calname, method, version, events, warnings }
}

// --- ICS building ----------------------------------------------------------

const TEXT_ESCAPE_MAP: Record<string, string> = {
  "\\": "\\\\",
  ";": "\\;",
  ",": "\\,",
  "\n": "\\n",
}

function escapeText(value: string): string {
  return value.replace(/[\\;,\n]/g, (c) => TEXT_ESCAPE_MAP[c])
}

function foldLine(line: string): string {
  // RFC 5545 line folding: max 75 octets per line. Continuation lines start with a single space,
  // which itself counts toward the 75-octet budget on the continuation line.
  const enc = new TextEncoder()
  if (enc.encode(line).length <= 75) return line
  const chunks: string[] = []
  let buf = ""
  let bytes = 0
  let isFirst = true
  // Walk by code point so we never split a multi-byte UTF-8 sequence.
  for (const ch of line) {
    const chBytes = enc.encode(ch).length
    const limit = isFirst ? 75 : 74 // continuation reserves 1 octet for the leading space
    if (bytes + chBytes > limit) {
      chunks.push(buf)
      buf = ""
      bytes = 0
      isFirst = false
    }
    buf += ch
    bytes += chBytes
  }
  if (buf) chunks.push(buf)
  return chunks.map((c, i) => (i === 0 ? c : " " + c)).join("\r\n")
}

function nowUtcStamp(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, "0")
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
  )
}

function looksLikeRfc5545(value: string): boolean {
  return /^\d{8}T\d{6}Z?$/.test(value) || /^\d{8}$/.test(value)
}

function normalizeDate(input: string): { value: string; isDate: boolean } {
  const trimmed = input.trim()
  // YYYY-MM-DD => DATE
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return { value: trimmed.replace(/-/g, ""), isDate: true }
  }
  if (looksLikeRfc5545(trimmed)) {
    if (/^\d{8}$/.test(trimmed)) return { value: trimmed, isDate: true }
    return { value: trimmed, isDate: false }
  }
  // Treat anything else as ISO 8601; coerce to UTC RFC 5545.
  const d = new Date(trimmed)
  if (Number.isNaN(d.getTime())) {
    throw new Error(`ical: cannot parse date '${input}'. Use ISO 8601 or RFC 5545.`)
  }
  const pad = (n: number) => String(n).padStart(2, "0")
  return {
    value:
      `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
      `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`,
    isDate: false,
  }
}

function deterministicUid(summary: string, dtstartValue: string): string {
  // Crockford-ish base32 of a hash made from summary+dtstart.
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (const ch of `${summary}|${dtstartValue}`) {
    h1 = Math.imul(h1 ^ ch.charCodeAt(0), 2654435761) >>> 0
    h2 = Math.imul(h2 ^ ch.charCodeAt(0), 1597334677) >>> 0
  }
  return `${h1.toString(36)}-${h2.toString(36)}@sg-opencode-ical`
}

type BuildEvent = NonNullable<Params["events"]>[number]

function buildEvent(ev: BuildEvent, dtstamp: string, warnings: string[]): string[] {
  const lines: string[] = []
  lines.push("BEGIN:VEVENT")
  lines.push(`DTSTAMP:${dtstamp}`)

  const start = normalizeDate(ev.dtstart)
  const uid = ev.uid ?? deterministicUid(ev.summary, start.value)
  lines.push(`UID:${uid}`)
  if (start.isDate) lines.push(`DTSTART;VALUE=DATE:${start.value}`)
  else lines.push(`DTSTART:${start.value}`)

  if (ev.dtend && ev.duration_minutes !== undefined) {
    warnings.push(`event '${ev.summary}': both dtend and duration_minutes set; using dtend`)
  }

  if (ev.dtend) {
    const end = normalizeDate(ev.dtend)
    if (end.isDate) lines.push(`DTEND;VALUE=DATE:${end.value}`)
    else lines.push(`DTEND:${end.value}`)
  } else if (ev.duration_minutes !== undefined) {
    lines.push(`DURATION:PT${Math.trunc(ev.duration_minutes)}M`)
  }

  lines.push(`SUMMARY:${escapeText(ev.summary)}`)
  if (ev.description) lines.push(`DESCRIPTION:${escapeText(ev.description)}`)
  if (ev.location) lines.push(`LOCATION:${escapeText(ev.location)}`)
  if (ev.url) lines.push(`URL:${ev.url}`)
  if (ev.status) lines.push(`STATUS:${ev.status}`)
  if (ev.rrule) lines.push(`RRULE:${ev.rrule}`)
  if (ev.categories?.length) lines.push(`CATEGORIES:${ev.categories.map(escapeText).join(",")}`)
  if (ev.organizer) {
    const params = ev.organizer.cn ? `;CN=${ev.organizer.cn.replace(/[\r\n]/g, " ")}` : ""
    lines.push(`ORGANIZER${params}:mailto:${ev.organizer.email}`)
  }
  if (ev.attendees?.length) {
    for (const a of ev.attendees) {
      const params: string[] = []
      if (a.cn) params.push(`CN=${a.cn.replace(/[\r\n]/g, " ")}`)
      if (a.role) params.push(`ROLE=${a.role}`)
      if (a.partstat) params.push(`PARTSTAT=${a.partstat}`)
      if (a.rsvp !== undefined) params.push(`RSVP=${a.rsvp ? "TRUE" : "FALSE"}`)
      const tail = params.length ? ";" + params.join(";") : ""
      lines.push(`ATTENDEE${tail}:mailto:${a.email}`)
    }
  }
  lines.push("END:VEVENT")
  return lines
}

function buildCalendar(params: Params): { text: string; warnings: string[]; events: number } {
  const warnings: string[] = []
  if (!params.events?.length) throw new Error("ical build: 'events' must contain at least one entry.")
  const dtstamp = nowUtcStamp()
  const lines: string[] = []
  lines.push("BEGIN:VCALENDAR")
  lines.push("VERSION:2.0")
  lines.push(`PRODID:${params.prodid ?? "-//SG OpenCode//ical tool//EN"}`)
  lines.push("CALSCALE:GREGORIAN")
  if (params.method) lines.push(`METHOD:${params.method}`)
  if (params.calname) lines.push(`X-WR-CALNAME:${escapeText(params.calname)}`)
  for (const ev of params.events) {
    lines.push(...buildEvent(ev, dtstamp, warnings))
  }
  lines.push("END:VCALENDAR")
  const folded = lines.map(foldLine).join("\r\n")
  return { text: folded + "\r\n", warnings, events: params.events.length }
}

// --- IO --------------------------------------------------------------------

async function loadText(params: Params): Promise<string> {
  const hasText = typeof params.text === "string" && params.text.length > 0
  const hasFile = typeof params.file === "string" && params.file.length > 0
  if (hasText && hasFile) throw new Error("ical: pass exactly one of text or file, not both.")
  if (!hasText && !hasFile) throw new Error("ical: pass either text or file for parse/info.")
  if (hasText) return params.text!
  const target = path.isAbsolute(params.file!) ? params.file! : path.resolve(Instance.directory, params.file!)
  return await readFile(target, "utf8")
}

export const ICalTool = Tool.define(
  "ical",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Params, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const action = params.action

          if (action === "build") {
            if (!params.events?.length) throw new Error("ical build: 'events' must contain at least one entry.")
            const built = buildCalendar(params)
            const meta: Metadata = {
              action: "build",
              prodid: params.prodid ?? "-//SG OpenCode//ical tool//EN",
              calname: params.calname,
              method: params.method,
              events_out: built.events,
              bytes_out: Buffer.byteLength(built.text, "utf8"),
              warnings: built.warnings.length ? built.warnings : undefined,
            }
            return done({
              title: `ical build: ${built.events} event${built.events === 1 ? "" : "s"}`,
              metadata: meta,
              output: built.text,
            })
          }

          if (params.file) {
            const target = path.isAbsolute(params.file)
              ? params.file
              : path.resolve(Instance.directory, params.file)
            yield* assertExternalDirectoryEffect(ctx, target, { kind: "file" })
          }
          const text = yield* Effect.promise(() => loadText(params))
          const cal = parseCalendar(text)

          if (action === "info") {
            const meta: Metadata = {
              action: "info",
              prodid: cal.prodid,
              calname: cal.calname,
              method: cal.method,
              events_in: cal.events.length,
              bytes_in: Buffer.byteLength(text, "utf8"),
              warnings: cal.warnings.length ? cal.warnings : undefined,
            }
            const lines = [
              `prodid: ${cal.prodid ?? "(none)"}`,
              `version: ${cal.version ?? "(unknown)"}`,
              `calname: ${cal.calname ?? "(none)"}`,
              `method: ${cal.method ?? "(none)"}`,
              `events: ${cal.events.length}`,
            ]
            if (cal.warnings.length) lines.push(`warnings: ${cal.warnings.join("; ")}`)
            return done({
              title: `ical info: ${cal.events.length} event${cal.events.length === 1 ? "" : "s"}`,
              metadata: meta,
              output: lines.join("\n"),
            })
          }

          // parse
          const meta: Metadata = {
            action: "parse",
            prodid: cal.prodid,
            calname: cal.calname,
            method: cal.method,
            events_in: cal.events.length,
            bytes_in: Buffer.byteLength(text, "utf8"),
            warnings: cal.warnings.length ? cal.warnings : undefined,
          }
          const payload = {
            prodid: cal.prodid,
            calname: cal.calname,
            method: cal.method,
            version: cal.version,
            events: cal.events,
          }
          return done({
            title: `ical parse: ${cal.events.length} event${cal.events.length === 1 ? "" : "s"}`,
            metadata: meta,
            output: JSON.stringify(payload, null, 2),
          })
        }),
    }
  }),
)

export const __testing = {
  unfoldLines,
  unescapeText,
  parseProperty,
  parseComponents,
  parseCalendar,
  escapeText,
  foldLine,
  normalizeDate,
  buildCalendar,
  deterministicUid,
}
