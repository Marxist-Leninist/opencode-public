import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Agent } from "../../src/agent/agent"
import { MessageID, SessionID } from "../../src/session/schema"
import { Tool } from "../../src/tool"
import { RandomTool, __testing } from "../../src/tool/random"
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

describe("tool.random helpers", () => {
  test("randomFloat in [0,1)", () => {
    for (let i = 0; i < 200; i++) {
      const v = __testing.randomFloat()
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
    }
  })

  test("string uses entire alphabet over many samples", () => {
    const alphabet = "ABCD"
    const seen = new Set<string>()
    for (let i = 0; i < 50; i++) {
      const s = __testing.randomStringFromAlphabet(alphabet, 16)
      for (const ch of s) seen.add(ch)
    }
    expect(seen.size).toBe(4)
  })

  test("password contains required classes", () => {
    for (let i = 0; i < 30; i++) {
      const pw = __testing.generatePassword({
        length: 16,
        lowercase: true,
        uppercase: true,
        digits: true,
        symbols: true,
        avoid_ambiguous: true,
      })
      expect(/[a-z]/.test(pw)).toBe(true)
      expect(/[A-Z]/.test(pw)).toBe(true)
      expect(/[0-9]/.test(pw)).toBe(true)
      expect(/[!@#$%^&*+=\-_?<>]/.test(pw)).toBe(true)
      expect(pw.length).toBe(16)
    }
  })

  test("password without symbols/digits", () => {
    const pw = __testing.generatePassword({
      length: 12,
      lowercase: true,
      uppercase: true,
      digits: false,
      symbols: false,
      avoid_ambiguous: true,
    })
    expect(/[0-9]/.test(pw)).toBe(false)
    expect(/[a-z]/.test(pw)).toBe(true)
    expect(/[A-Z]/.test(pw)).toBe(true)
  })

  test("password requires at least one class", () => {
    expect(() =>
      __testing.generatePassword({
        length: 8,
        lowercase: false,
        uppercase: false,
        digits: false,
        symbols: false,
        avoid_ambiguous: true,
      }),
    ).toThrow()
  })

  test("pickWithoutReplacement returns distinct items", () => {
    const choices = [1, 2, 3, 4, 5, 6, 7, 8]
    for (let i = 0; i < 20; i++) {
      const picked = __testing.pickWithoutReplacement(choices, 4)
      expect(new Set(picked).size).toBe(4)
    }
  })

  test("pickWithoutReplacement errors when count > pool", () => {
    expect(() => __testing.pickWithoutReplacement([1, 2], 5)).toThrow()
  })

  test("pickWithReplacement weighted distribution heavily favors weighted item", () => {
    const choices = ["a", "b", "c"]
    const weights = [1, 1, 100]
    const picks = __testing.pickWithReplacement(choices, 1000, weights)
    const cCount = picks.filter((x) => x === "c").length
    expect(cCount).toBeGreaterThan(800)
  })

  test("shuffle preserves elements", () => {
    const input = [1, 2, 3, 4, 5, 6, 7, 8]
    const shuffled = __testing.shuffle(input)
    expect([...shuffled].sort()).toEqual([...input].sort())
    expect(shuffled.length).toBe(input.length)
  })

  test("buildAlphabet preset and custom", () => {
    expect(__testing.buildAlphabet("hex").length).toBe(16)
    expect(__testing.buildAlphabet("XYZ")).toBe("XYZ")
    expect(__testing.buildAlphabet(undefined).length).toBeGreaterThan(50)
  })

  test("encodeBytes formats", () => {
    const b = Buffer.from([0xde, 0xad, 0xbe, 0xef])
    expect(__testing.encodeBytes(b, "hex")).toBe("deadbeef")
    expect(__testing.encodeBytes(b, "base64")).toBe(b.toString("base64"))
    expect(__testing.encodeBytes(b, "base64url")).toBe(b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, ""))
  })
})

describe("tool.random tool", () => {
  it.live("int respects bounds", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* RandomTool
        const tool = yield* toolInfo.init()
        const r = yield* tool.execute({ action: "int", min: 1, max: 6, count: 100 }, baseCtx)
        const values = r.metadata.values as number[]
        expect(values.length).toBe(100)
        for (const v of values) {
          expect(v).toBeGreaterThanOrEqual(1)
          expect(v).toBeLessThanOrEqual(6)
        }
      }),
    ),
  )

  it.live("bytes hex returns proper length", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* RandomTool
        const tool = yield* toolInfo.init()
        const r = yield* tool.execute({ action: "bytes", length: 16, output_encoding: "hex" }, baseCtx)
        expect(typeof r.metadata.value).toBe("string")
        expect((r.metadata.value as string).length).toBe(32)
        expect(/^[0-9a-f]+$/.test(r.metadata.value as string)).toBe(true)
      }),
    ),
  )

  it.live("string with preset alphabet", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* RandomTool
        const tool = yield* toolInfo.init()
        const r = yield* tool.execute({ action: "string", length: 24, alphabet: "urlsafe" }, baseCtx)
        expect((r.metadata.value as string).length).toBe(24)
        expect(/^[A-Za-z0-9_-]+$/.test(r.metadata.value as string)).toBe(true)
      }),
    ),
  )

  it.live("password basics", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* RandomTool
        const tool = yield* toolInfo.init()
        const r = yield* tool.execute({ action: "password", length: 20 }, baseCtx)
        expect((r.metadata.value as string).length).toBe(20)
      }),
    ),
  )

  it.live("pick returns N unique items", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* RandomTool
        const tool = yield* toolInfo.init()
        const r = yield* tool.execute({ action: "pick", choices: ["a", "b", "c", "d"], count: 3 }, baseCtx)
        const values = r.metadata.values as string[]
        expect(values.length).toBe(3)
        expect(new Set(values).size).toBe(3)
      }),
    ),
  )

  it.live("shuffle returns same length", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* RandomTool
        const tool = yield* toolInfo.init()
        const r = yield* tool.execute({ action: "shuffle", choices: [1, 2, 3, 4, 5] }, baseCtx)
        expect(r.metadata.count).toBe(5)
      }),
    ),
  )

  it.live("uuid produces canonical v4", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* RandomTool
        const tool = yield* toolInfo.init()
        const r = yield* tool.execute({ action: "uuid", count: 3 }, baseCtx)
        const values = r.metadata.values as string[]
        expect(values.length).toBe(3)
        for (const v of values) {
          expect(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v)).toBe(true)
        }
      }),
    ),
  )
})
