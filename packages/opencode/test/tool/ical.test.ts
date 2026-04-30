import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import path from "path"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Agent } from "../../src/agent/agent"
import { MessageID, SessionID } from "../../src/session/schema"
import { Tool } from "../../src/tool"
import { ICalTool, __testing as IT } from "../../src/tool/ical"
import { Truncate } from "../../src/tool"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  Layer.mergeAll(CrossSpawnSpawner.defaultLayer, AppFileSystem.defaultLayer, Truncate.defaultLayer, Agent.defaultLayer),
)

const baseCtx: Tool.Context = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make(""),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

const SAMPLE_ICS = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "PRODID:-//Example//Sample//EN",
  "METHOD:REQUEST",
  "X-WR-CALNAME:My Cal",
  "BEGIN:VEVENT",
  "UID:abc-123@example.com",
  "DTSTAMP:20260430T120000Z",
  "DTSTART:20260501T150000Z",
  "DTEND:20260501T160000Z",
  "SUMMARY:Quick sync; with semicolon",
  "DESCRIPTION:Line one\\nLine two",
  "LOCATION:Conf Room A",
  "ORGANIZER;CN=Boss:mailto:boss@example.com",
  "ATTENDEE;CN=Sam;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:sam@example.com",
  "STATUS:CONFIRMED",
  "END:VEVENT",
  "END:VCALENDAR",
  "",
].join("\r\n")

describe("tool.ical (unit)", () => {
  it.live("unfolds RFC 5545 line continuations (leading WS dropped)", () =>
    Effect.sync(() => {
      // Per RFC 5545: CRLF + (SP|HTAB) is removed entirely when unfolding.
      const text = "SUMMARY:Hello\r\n World\r\nDTSTART:20260501T090000Z\r\n"
      const lines = IT.unfoldLines(text)
      expect(lines[0]).toBe("SUMMARY:HelloWorld")
      expect(lines[1]).toBe("DTSTART:20260501T090000Z")
    }),
  )

  it.live("parses property params correctly", () =>
    Effect.sync(() => {
      const p = IT.parseProperty(`ATTENDEE;CN="Sam, Smith";RSVP=TRUE:mailto:sam@x.com`)
      expect(p.name).toBe("ATTENDEE")
      expect(p.params.CN).toBe("Sam, Smith")
      expect(p.params.RSVP).toBe("TRUE")
      expect(p.value).toBe("mailto:sam@x.com")
    }),
  )

  it.live("escapes / unescapes TEXT round-trip", () =>
    Effect.sync(() => {
      const original = "comma,semi;back\\slash\nline"
      const escaped = IT.escapeText(original)
      expect(escaped).toBe(`comma\\,semi\\;back\\\\slash\\nline`)
      expect(IT.unescapeText(escaped)).toBe(original)
    }),
  )

  it.live("normalizes ISO dates to RFC 5545", () =>
    Effect.sync(() => {
      const r1 = IT.normalizeDate("2026-05-01T15:00:00Z")
      expect(r1.value).toBe("20260501T150000Z")
      expect(r1.isDate).toBe(false)
      const r2 = IT.normalizeDate("2026-05-01")
      expect(r2.value).toBe("20260501")
      expect(r2.isDate).toBe(true)
      const r3 = IT.normalizeDate("20260501T150000Z")
      expect(r3.value).toBe("20260501T150000Z")
      expect(r3.isDate).toBe(false)
    }),
  )

  it.live("rejects bad date inputs", () =>
    Effect.sync(() => {
      expect(() => IT.normalizeDate("nope-not-a-date")).toThrow(/cannot parse/)
    }),
  )

  it.live("folds long lines at 75 octets with leading space continuation", () =>
    Effect.sync(() => {
      const longSummary = "X".repeat(200)
      const folded = IT.foldLine(`SUMMARY:${longSummary}`)
      const parts = folded.split("\r\n")
      expect(parts.length).toBeGreaterThan(1)
      // Continuation lines start with a single space
      for (let i = 1; i < parts.length; i++) {
        expect(parts[i].startsWith(" ")).toBe(true)
      }
      // No segment exceeds 75 bytes
      for (const p of parts) {
        expect(Buffer.byteLength(p, "utf8")).toBeLessThanOrEqual(75)
      }
    }),
  )

  it.live("parses a sample VEVENT cleanly", () =>
    Effect.sync(() => {
      const cal = IT.parseCalendar(SAMPLE_ICS)
      expect(cal.events.length).toBe(1)
      const ev = cal.events[0]
      expect(ev.uid).toBe("abc-123@example.com")
      expect(ev.summary).toBe("Quick sync; with semicolon")
      expect(ev.description).toBe("Line one\nLine two")
      expect(ev.organizer).toBe("boss@example.com")
      expect(ev.organizer_cn).toBe("Boss")
      expect(ev.attendees.length).toBe(1)
      expect(ev.attendees[0].email).toBe("sam@example.com")
      expect(ev.attendees[0].rsvp).toBe(true)
      expect(ev.status).toBe("CONFIRMED")
    }),
  )

  it.live("deterministic UID is stable across runs", () =>
    Effect.sync(() => {
      const a = IT.deterministicUid("Hello", "20260501T150000Z")
      const b = IT.deterministicUid("Hello", "20260501T150000Z")
      expect(a).toBe(b)
      const c = IT.deterministicUid("Hello", "20260501T160000Z")
      expect(c).not.toBe(a)
    }),
  )

  it.live("buildCalendar produces parseable output (round-trip)", () =>
    Effect.sync(() => {
      const built = IT.buildCalendar({
        action: "build",
        events: [
          {
            summary: "Quick, sync",
            dtstart: "2026-05-01T15:00:00Z",
            duration_minutes: 30,
            description: "Topic A\nTopic B",
            location: "Office",
            attendees: [{ email: "sam@x.com", role: "REQ-PARTICIPANT", rsvp: true, cn: "Sam Smith" }],
            organizer: { email: "me@x.com", cn: "Me" },
            categories: ["Work", "Sync"],
          },
        ],
        method: "REQUEST",
      })
      expect(built.events).toBe(1)
      expect(built.text).toContain("BEGIN:VCALENDAR")
      expect(built.text).toContain("METHOD:REQUEST")
      expect(built.text).toContain("DURATION:PT30M")
      expect(built.text).toContain("SUMMARY:Quick\\, sync")
      expect(built.text).toContain("ATTENDEE;CN=Sam Smith;ROLE=REQ-PARTICIPANT;RSVP=TRUE:mailto:sam@x.com")

      const parsed = IT.parseCalendar(built.text)
      expect(parsed.events.length).toBe(1)
      expect(parsed.events[0].summary).toBe("Quick, sync")
      expect(parsed.events[0].location).toBe("Office")
      expect(parsed.events[0].duration).toBe("PT30M")
      expect(parsed.events[0].attendees[0].email).toBe("sam@x.com")
      expect(parsed.events[0].categories).toEqual(["Work", "Sync"])
    }),
  )
})

describe("tool.ical (integration)", () => {
  it.live("parse from text returns event JSON", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* ICalTool
        const tool = yield* toolInfo.init()
        const result = yield* tool.execute({ action: "parse", text: SAMPLE_ICS }, baseCtx)
        expect(result.metadata.action).toBe("parse")
        expect(result.metadata.events_in).toBe(1)
        const payload = JSON.parse(result.output)
        expect(payload.events[0].uid).toBe("abc-123@example.com")
      }),
    ),
  )

  it.live("info from file path", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const file = path.join(dir, "sample.ics")
        yield* Effect.promise(() => Bun.write(file, SAMPLE_ICS))
        const toolInfo = yield* ICalTool
        const tool = yield* toolInfo.init()
        const result = yield* tool.execute({ action: "info", file }, baseCtx)
        expect(result.metadata.action).toBe("info")
        expect(result.metadata.events_in).toBe(1)
        expect(result.output).toContain("prodid: -//Example//Sample//EN")
        expect(result.output).toContain("method: REQUEST")
        expect(result.output).toContain("calname: My Cal")
      }),
    ),
  )

  it.live("build emits a complete VCALENDAR", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* ICalTool
        const tool = yield* toolInfo.init()
        const result = yield* tool.execute(
          {
            action: "build",
            events: [{ summary: "Lunch", dtstart: "2026-05-02", duration_minutes: 60 }],
          },
          baseCtx,
        )
        expect(result.metadata.action).toBe("build")
        expect(result.metadata.events_out).toBe(1)
        expect(result.output).toContain("BEGIN:VCALENDAR")
        expect(result.output).toContain("END:VCALENDAR")
        expect(result.output).toContain("DTSTART;VALUE=DATE:20260502")
        expect(result.output).toContain("DURATION:PT60M")
        expect(result.output).toContain("SUMMARY:Lunch")
      }),
    ),
  )

  it.live("rejects build without events", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* ICalTool
        const tool = yield* toolInfo.init()
        const result = yield* Effect.exit(tool.execute({ action: "build", events: [] }, baseCtx))
        expect(result._tag).toBe("Failure")
      }),
    ),
  )
})
