import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Agent } from "../../src/agent/agent"
import { MessageID, SessionID } from "../../src/session/schema"
import { Tool } from "../../src/tool"
import { CronTool, __testing } from "../../src/tool/cron"
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

describe("tool.cron.parseCron", () => {
  test("parses standard 5-field expression", () => {
    const p = __testing.parseCron("*/15 * * * *")
    expect(Array.from(p.minute).sort((a, b) => a - b)).toEqual([0, 15, 30, 45])
    expect(p.hour.size).toBe(24)
    expect(p.normalized).toBe("*/15 * * * *")
  })

  test("expands @hourly macro", () => {
    const p = __testing.parseCron("@hourly")
    expect(Array.from(p.minute)).toEqual([0])
    expect(p.hour.size).toBe(24)
    expect(p.normalized).toBe("0 * * * *")
  })

  test("parses month names and weekday ranges", () => {
    const p = __testing.parseCron("0 9 * jan-mar mon-fri")
    expect(Array.from(p.month).sort((a, b) => a - b)).toEqual([1, 2, 3])
    expect(Array.from(p.dayOfWeek).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5])
  })

  test("folds DOW=7 to 0 (Sunday)", () => {
    const p = __testing.parseCron("0 0 * * 7")
    expect(p.dayOfWeek.has(0)).toBe(true)
    expect(p.dayOfWeek.has(7)).toBe(false)
  })

  test("rejects expression with wrong field count", () => {
    expect(() => __testing.parseCron("0 0 * *")).toThrow()
    expect(() => __testing.parseCron("0 0 * * * *")).toThrow()
  })

  test("rejects out-of-range values", () => {
    expect(() => __testing.parseCron("0 24 * * *")).toThrow()
    expect(() => __testing.parseCron("60 * * * *")).toThrow()
  })

  test("rejects unknown macros", () => {
    expect(() => __testing.parseCron("@never")).toThrow()
  })

  test("parses step on a single number as N..max/step", () => {
    const p = __testing.parseCron("0 0/6 * * *")
    expect(Array.from(p.hour).sort((a, b) => a - b)).toEqual([0, 6, 12, 18])
  })
})

describe("tool.cron.nextFireTimes", () => {
  test("computes hourly fires in UTC", () => {
    const p = __testing.parseCron("@hourly")
    const anchor = new Date("2026-04-29T10:30:00Z")
    const { next } = __testing.nextFireTimes(p, anchor, "UTC", 3)
    expect(next.length).toBe(3)
    expect(next[0]!.toISOString()).toBe("2026-04-29T11:00:00.000Z")
    expect(next[1]!.toISOString()).toBe("2026-04-29T12:00:00.000Z")
    expect(next[2]!.toISOString()).toBe("2026-04-29T13:00:00.000Z")
  })

  test("daily 9am London produces correct UTC fires", () => {
    const p = __testing.parseCron("0 9 * * *")
    const anchor = new Date("2026-04-29T07:00:00Z")
    const { next } = __testing.nextFireTimes(p, anchor, "Europe/London", 1)
    // April 29 2026: London is BST (UTC+1), so 09:00 BST = 08:00 UTC.
    expect(next[0]!.toISOString()).toBe("2026-04-29T08:00:00.000Z")
  })

  test("weekday range fires on weekdays only", () => {
    const p = __testing.parseCron("0 9 * * mon-fri")
    // Anchor: Saturday 2026-04-25 12:00 UTC. Next fire should be Monday 2026-04-27 09:00 UTC.
    const anchor = new Date("2026-04-25T12:00:00Z")
    const { next } = __testing.nextFireTimes(p, anchor, "UTC", 1)
    expect(next[0]!.toISOString()).toBe("2026-04-27T09:00:00.000Z")
  })

  test("Vixie cron OR semantics: dom=1 dow=mon", () => {
    const p = __testing.parseCron("0 0 1 * mon")
    // Anchor: 2026-04-29. Next fire should be a Monday OR the 1st.
    // 2026-05-01 is a Friday → date hits the 1st; 2026-05-04 is a Monday → date hits dow.
    const anchor = new Date("2026-04-29T00:00:00Z")
    const { next } = __testing.nextFireTimes(p, anchor, "UTC", 2)
    expect(next.length).toBe(2)
    expect(next[0]!.toISOString()).toBe("2026-05-01T00:00:00.000Z")
    expect(next[1]!.toISOString()).toBe("2026-05-04T00:00:00.000Z")
  })
})

describe("tool.cron tool", () => {
  it.live("returns next fire times for a valid expression", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* CronTool
        const tool = yield* toolInfo.init()
        const result = yield* tool.execute(
          {
            expression: "@hourly",
            from: "2026-04-29T10:30:00Z",
            count: 2,
            timezone: "UTC",
          },
          baseCtx,
        )
        expect(result.metadata.valid).toBe(true)
        expect(result.metadata.normalized).toBe("0 * * * *")
        expect(result.metadata.next).toEqual([
          "2026-04-29T11:00:00Z",
          "2026-04-29T12:00:00Z",
        ])
      }),
    ),
  )

  it.live("returns valid=false on invalid expression instead of throwing", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* CronTool
        const tool = yield* toolInfo.init()
        const result = yield* tool.execute(
          { expression: "60 99 * * *" },
          baseCtx,
        )
        expect(result.metadata.valid).toBe(false)
        expect(result.metadata.error).toBeDefined()
      }),
    ),
  )

  it.live("rejects malformed 'from' anchor", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* CronTool
        const tool = yield* toolInfo.init()
        const result = yield* tool.execute(
          { expression: "@hourly", from: "not-a-date" },
          baseCtx,
        )
        expect(result.metadata.valid).toBe(false)
        expect(result.metadata.error).toContain("from")
      }),
    ),
  )
})
