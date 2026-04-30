import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Agent } from "../../src/agent/agent"
import { MessageID, SessionID } from "../../src/session/schema"
import { Tool } from "../../src/tool"
import { HumanizeTool, __testing } from "../../src/tool/humanize"
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

describe("tool.humanize helpers", () => {
  test("bytes_format iec", () => {
    expect(__testing.formatBytes(0, "iec")).toBe("0 B")
    expect(__testing.formatBytes(1023, "iec")).toBe("1023 B")
    expect(__testing.formatBytes(1024, "iec")).toBe("1 KiB")
    expect(__testing.formatBytes(1536, "iec", 2)).toBe("1.5 KiB")
    expect(__testing.formatBytes(1024 * 1024, "iec")).toBe("1 MiB")
    expect(__testing.formatBytes(1024 ** 3, "iec")).toBe("1 GiB")
    expect(__testing.formatBytes(-2048, "iec")).toBe("-2 KiB")
  })

  test("bytes_format si", () => {
    expect(__testing.formatBytes(1000, "si")).toBe("1 kB")
    expect(__testing.formatBytes(1500, "si", 2)).toBe("1.5 kB")
    expect(__testing.formatBytes(1_000_000, "si")).toBe("1 MB")
  })

  test("bytes_parse", () => {
    expect(__testing.parseBytes("1024")).toBe(1024)
    expect(__testing.parseBytes("1 KiB")).toBe(1024)
    expect(__testing.parseBytes("1KB")).toBe(1024) // shell convention
    expect(__testing.parseBytes("1.5GiB")).toBe(Math.round(1.5 * 1024 ** 3))
    expect(__testing.parseBytes("2 MB", "si")).toBe(2_000_000)
    expect(() => __testing.parseBytes("not a size")).toThrow()
  })

  test("duration_format", () => {
    expect(__testing.formatDuration(0)).toBe("0s")
    expect(__testing.formatDuration(500)).toBe("500 ms")
    expect(__testing.formatDuration(1000)).toBe("1s")
    expect(__testing.formatDuration(60_000)).toBe("1m")
    expect(__testing.formatDuration(90_061_000)).toBe("1d 1h 1m 1s")
    expect(__testing.formatDuration(-5000)).toBe("-5s")
  })

  test("duration_parse", () => {
    expect(__testing.parseDuration("0")).toBe(0)
    expect(__testing.parseDuration("1500")).toBe(1500)
    expect(__testing.parseDuration("1500ms")).toBe(1500)
    expect(__testing.parseDuration("1d")).toBe(86_400_000)
    expect(__testing.parseDuration("1h 30m")).toBe(90 * 60 * 1000)
    expect(__testing.parseDuration("1h30m5s")).toBe((60 + 30) * 60 * 1000 + 5000)
    expect(__testing.parseDuration("1.5h")).toBe(Math.round(1.5 * 3600 * 1000))
    expect(__testing.parseDuration("-30s")).toBe(-30_000)
    expect(() => __testing.parseDuration("garbage")).toThrow()
  })

  test("number_format / parse", () => {
    expect(__testing.formatNumber(1234567)).toBe("1,234,567")
    expect(__testing.formatNumber(1234567, { compact: true })).toMatch(/1\.2M|1M/)
    expect(__testing.formatNumber(1234.5, { decimals: 2 })).toBe("1,234.50")
    expect(__testing.parseNumber("1,234,567")).toBe(1234567)
    expect(__testing.parseNumber("1.2K")).toBe(1200)
    expect(__testing.parseNumber("3M")).toBe(3_000_000)
  })

  test("ordinal", () => {
    expect(__testing.ordinal(1)).toBe("1st")
    expect(__testing.ordinal(2)).toBe("2nd")
    expect(__testing.ordinal(3)).toBe("3rd")
    expect(__testing.ordinal(4)).toBe("4th")
    expect(__testing.ordinal(11)).toBe("11th")
    expect(__testing.ordinal(12)).toBe("12th")
    expect(__testing.ordinal(13)).toBe("13th")
    expect(__testing.ordinal(21)).toBe("21st")
    expect(__testing.ordinal(22)).toBe("22nd")
    expect(__testing.ordinal(101)).toBe("101st")
    expect(__testing.ordinal(111)).toBe("111th")
  })

  test("pluralize", () => {
    expect(__testing.pluralize("file", 1)).toBe("1 file")
    expect(__testing.pluralize("file", 2)).toBe("2 files")
    expect(__testing.pluralize("file", 0)).toBe("0 files")
    expect(__testing.pluralize("child", 2, "children")).toBe("2 children")
  })

  test("relative_time", () => {
    expect(__testing.relativeTime(500)).toBe("just now")
    expect(__testing.relativeTime(60_000)).toBe("1 minute ago")
    expect(__testing.relativeTime(120_000)).toBe("2 minutes ago")
    expect(__testing.relativeTime(-3600_000)).toBe("in 1 hour")
    expect(__testing.relativeTime(86400_000)).toBe("1 day ago")
  })

  test("slug", () => {
    expect(__testing.slug("Hello World!")).toBe("hello-world")
    expect(__testing.slug("Crème Brûlée")).toBe("creme-brulee")
    expect(__testing.slug("  Multiple   spaces and -- dashes  ")).toBe("multiple-spaces-and-dashes")
    expect(__testing.slug("a".repeat(120), 10)).toBe("aaaaaaaaaa")
  })
})

describe("tool.humanize tool", () => {
  it.live("bytes_format", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const ti = yield* HumanizeTool
        const tool = yield* ti.init()
        const r = yield* tool.execute({ action: "bytes_format", n: 1536 }, baseCtx)
        expect(r.metadata.action).toBe("bytes_format")
        expect(r.metadata.formatted).toBe("1.5 KiB")
        expect(r.output).toBe("1.5 KiB")
      }),
    ),
  )

  it.live("duration_parse + format roundtrip", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const ti = yield* HumanizeTool
        const tool = yield* ti.init()
        const parsed = yield* tool.execute({ action: "duration_parse", value: "1h 30m" }, baseCtx)
        expect(parsed.metadata.parsed).toBe(90 * 60 * 1000)
        const formatted = yield* tool.execute(
          { action: "duration_format", n: parsed.metadata.parsed! },
          baseCtx,
        )
        expect(formatted.output).toBe("1h 30m")
      }),
    ),
  )

  it.live("ordinal action", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const ti = yield* HumanizeTool
        const tool = yield* ti.init()
        const r = yield* tool.execute({ action: "ordinal", n: 22 }, baseCtx)
        expect(r.output).toBe("22nd")
      }),
    ),
  )
})
