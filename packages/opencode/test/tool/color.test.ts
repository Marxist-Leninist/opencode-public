import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Agent } from "../../src/agent/agent"
import { MessageID, SessionID } from "../../src/session/schema"
import { Tool } from "../../src/tool"
import { ColorTool, __testing } from "../../src/tool/color"
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

describe("tool.color helpers", () => {
  test("parse named, hex short, hex long", () => {
    expect(__testing.parseColor("red")).toEqual({ r: 255, g: 0, b: 0, a: 1 })
    expect(__testing.parseColor("#fff")).toEqual({ r: 255, g: 255, b: 255, a: 1 })
    expect(__testing.parseColor("#FF8800")).toEqual({ r: 255, g: 136, b: 0, a: 1 })
  })
  test("parse hex with alpha", () => {
    const c = __testing.parseColor("#80808080")
    expect(c.r).toBe(128)
    expect(c.a).toBeCloseTo(0.5, 2)
  })
  test("parse rgb / rgba", () => {
    expect(__testing.parseColor("rgb(255, 128, 0)")).toEqual({ r: 255, g: 128, b: 0, a: 1 })
    const c = __testing.parseColor("rgba(0, 0, 0, 0.5)")
    expect(c.a).toBe(0.5)
  })
  test("parse hsl roundtrip", () => {
    const c = __testing.parseColor("hsl(0, 100%, 50%)")
    expect(c.r).toBe(255)
    expect(c.g).toBe(0)
    expect(c.b).toBe(0)
  })
  test("hex roundtrip", () => {
    expect(__testing.toHex({ r: 255, g: 136, b: 0, a: 1 })).toBe("#FF8800")
  })
  test("contrast: black/white = 21:1", () => {
    const ratio = __testing.contrastRatio(
      __testing.parseColor("#000"),
      __testing.parseColor("#fff"),
    )
    expect(ratio).toBeCloseTo(21, 0)
  })
  test("luminance bounds", () => {
    expect(__testing.relativeLuminance(__testing.parseColor("#000"))).toBe(0)
    expect(__testing.relativeLuminance(__testing.parseColor("#fff"))).toBeCloseTo(1, 5)
  })
  test("hsl <-> rgb roundtrip", () => {
    const orig = { r: 100, g: 150, b: 200, a: 1 }
    const back = __testing.hslToRgb(__testing.rgbToHsl(orig))
    expect(Math.abs(back.r - orig.r)).toBeLessThanOrEqual(1)
    expect(Math.abs(back.g - orig.g)).toBeLessThanOrEqual(1)
    expect(Math.abs(back.b - orig.b)).toBeLessThanOrEqual(1)
  })
})

describe("tool.color tool", () => {
  it.live("to_hex from named", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const ti = yield* ColorTool
        const tool = yield* ti.init()
        const r = yield* tool.execute({ action: "to_hex", value: "tomato" }, baseCtx)
        expect(r.output).toBe("#FF6347")
      }),
    ),
  )
  it.live("contrast black/white", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const ti = yield* ColorTool
        const tool = yield* ti.init()
        const r = yield* tool.execute({ action: "contrast", a: "#000", b: "#fff" }, baseCtx)
        const obj = JSON.parse(r.output)
        expect(obj.ratio).toBeCloseTo(21, 0)
        expect(obj.AAA_normal).toBe(true)
      }),
    ),
  )
  it.live("mix red + blue at 0.5", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const ti = yield* ColorTool
        const tool = yield* ti.init()
        const r = yield* tool.execute({ action: "mix", a: "red", b: "blue", amount: 0.5 }, baseCtx)
        expect(r.output).toBe("#800080")
      }),
    ),
  )
  it.live("random with seed is deterministic", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const ti = yield* ColorTool
        const tool = yield* ti.init()
        const r1 = yield* tool.execute({ action: "random", seed: "abc" }, baseCtx)
        const r2 = yield* tool.execute({ action: "random", seed: "abc" }, baseCtx)
        expect(r1.output).toBe(r2.output)
      }),
    ),
  )
})
