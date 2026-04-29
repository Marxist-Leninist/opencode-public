import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Agent } from "../../src/agent/agent"
import { MessageID, SessionID } from "../../src/session/schema"
import { Tool } from "../../src/tool"
import { DateTimeTool, __testing } from "../../src/tool/datetime"
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

describe("tool.datetime.parseDuration", () => {
  test("parses simple units", () => {
    expect(__testing.parseDuration("1d")).toBe(86_400_000)
    expect(__testing.parseDuration("2h")).toBe(2 * 3_600_000)
    expect(__testing.parseDuration("30m")).toBe(30 * 60_000)
    expect(__testing.parseDuration("45s")).toBe(45_000)
    expect(__testing.parseDuration("250ms")).toBe(250)
    expect(__testing.parseDuration("1w")).toBe(7 * 86_400_000)
  })

  test("parses compound durations", () => {
    expect(__testing.parseDuration("1d2h30m")).toBe(86_400_000 + 2 * 3_600_000 + 30 * 60_000)
    expect(__testing.parseDuration("7d12h")).toBe(7 * 86_400_000 + 12 * 3_600_000)
  })

  test("supports signed durations", () => {
    expect(__testing.parseDuration("-15m")).toBe(-15 * 60_000)
    expect(__testing.parseDuration("+1h")).toBe(3_600_000)
  })

  test("rejects unknown units and stray text", () => {
    expect(() => __testing.parseDuration("1y")).toThrow()
    expect(() => __testing.parseDuration("foo")).toThrow()
    expect(() => __testing.parseDuration("1d garbage")).toThrow()
  })
})

describe("tool.datetime.parseTimestamp", () => {
  test("parses ISO-8601", () => {
    const d = __testing.parseTimestamp("2026-04-29T12:00:00Z")
    expect(d.toISOString()).toBe("2026-04-29T12:00:00.000Z")
  })

  test("parses unix epoch seconds", () => {
    const d = __testing.parseTimestamp("1714392000") // 2024-04-29T12:00:00Z
    expect(d.getTime()).toBe(1714392000 * 1000)
  })

  test("parses unix epoch millis", () => {
    const d = __testing.parseTimestamp("1714392000000")
    expect(d.getTime()).toBe(1714392000000)
  })

  test("rejects garbage", () => {
    expect(() => __testing.parseTimestamp("not a date")).toThrow()
  })
})

describe("tool.datetime.diff", () => {
  test("computes signed positive diff", () => {
    const a = new Date("2026-04-29T00:00:00Z")
    const b = new Date("2026-04-30T03:30:00Z")
    const d = __testing.diff(a, b)
    expect(d.sign).toBe(1)
    expect(d.days).toBe(1)
    expect(d.hours).toBe(3)
    expect(d.minutes).toBe(30)
    expect(d.humanised).toBe("1d 3h 30m")
  })

  test("computes negative diff", () => {
    const a = new Date("2026-04-29T12:00:00Z")
    const b = new Date("2026-04-29T11:00:00Z")
    const d = __testing.diff(a, b)
    expect(d.sign).toBe(-1)
    expect(d.humanised).toBe("-1h")
  })

  test("zero diff", () => {
    const a = new Date("2026-04-29T12:00:00Z")
    const d = __testing.diff(a, a)
    expect(d.sign).toBe(0)
    expect(d.humanised).toBe("0s")
  })
})

describe("tool.datetime.formatInTimezone", () => {
  test("UTC offset string is Z", () => {
    const f = __testing.formatInTimezone(new Date("2026-04-29T12:00:00Z"), "UTC")
    expect(f.formatted).toBe("2026-04-29T12:00:00Z")
    expect(f.offsetMinutes).toBe(0)
  })

  test("Tokyo offset is +09:00", () => {
    const f = __testing.formatInTimezone(new Date("2026-04-29T12:00:00Z"), "Asia/Tokyo")
    expect(f.formatted).toBe("2026-04-29T21:00:00+09:00")
    expect(f.offsetMinutes).toBe(9 * 60)
  })

  test("New York is -04:00 in April (EDT)", () => {
    const f = __testing.formatInTimezone(new Date("2026-04-29T12:00:00Z"), "America/New_York")
    expect(f.formatted).toBe("2026-04-29T08:00:00-04:00")
    expect(f.offsetMinutes).toBe(-4 * 60)
  })
})

describe("tool.datetime tool", () => {
  it.live("now action returns current time fields", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* DateTimeTool
        const tool = yield* toolInfo.init()
        const result = yield* tool.execute({ action: "now", timezone: "UTC" }, baseCtx)
        expect(typeof result.metadata.iso).toBe("string")
        expect(result.metadata.timezone).toBe("UTC")
        expect(result.metadata.epoch_ms).toBeGreaterThan(1_700_000_000_000)
      }),
    ),
  )

  it.live("add action returns shifted timestamp", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* DateTimeTool
        const tool = yield* toolInfo.init()
        const result = yield* tool.execute(
          { action: "add", value: "2026-04-29T12:00:00Z", duration: "1d2h", timezone: "UTC" },
          baseCtx,
        )
        expect(result.metadata.iso).toBe("2026-04-30T14:00:00.000Z")
        expect(result.metadata.duration_ms).toBe(86_400_000 + 2 * 3_600_000)
      }),
    ),
  )

  it.live("diff action returns breakdown", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* DateTimeTool
        const tool = yield* toolInfo.init()
        const result = yield* tool.execute(
          {
            action: "diff",
            value: "2026-04-29T00:00:00Z",
            value2: "2026-04-30T01:30:00Z",
            timezone: "UTC",
          },
          baseCtx,
        )
        expect(result.metadata.diff?.days).toBe(1)
        expect(result.metadata.diff?.hours).toBe(1)
        expect(result.metadata.diff?.minutes).toBe(30)
        expect(result.metadata.diff?.humanised).toBe("1d 1h 30m")
      }),
    ),
  )

  it.live("format converts UTC instant into requested timezone", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* DateTimeTool
        const tool = yield* toolInfo.init()
        const result = yield* tool.execute(
          { action: "format", value: "2026-04-29T12:00:00Z", timezone: "Asia/Tokyo" },
          baseCtx,
        )
        expect(result.metadata.formatted).toBe("2026-04-29T21:00:00+09:00")
      }),
    ),
  )
})
