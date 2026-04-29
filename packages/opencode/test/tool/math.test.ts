import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Agent } from "../../src/agent/agent"
import { MessageID, SessionID } from "../../src/session/schema"
import { Tool } from "../../src/tool"
import { MathTool, __testing } from "../../src/tool/math"
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

describe("tool.math helpers", () => {
  test("standard precedence", () => {
    expect(__testing.evaluate("2 + 3 * 4")).toBe(14)
    expect(__testing.evaluate("(2 + 3) * 4")).toBe(20)
    expect(__testing.evaluate("2 ^ 10")).toBe(1024)
    expect(__testing.evaluate("2 ** 10")).toBe(1024)
    expect(__testing.evaluate("2 ^ 3 ^ 2")).toBe(512) // right-associative
  })

  test("unary and modulo", () => {
    expect(__testing.evaluate("-2 + 3")).toBe(1)
    expect(__testing.evaluate("10 % 3")).toBe(1)
    expect(__testing.evaluate("--3")).toBe(3)
  })

  test("constants", () => {
    expect(__testing.evaluate("pi")).toBeCloseTo(Math.PI)
    expect(__testing.evaluate("tau")).toBeCloseTo(Math.PI * 2)
    expect(__testing.evaluate("e")).toBeCloseTo(Math.E)
  })

  test("functions", () => {
    expect(__testing.evaluate("abs(-7)")).toBe(7)
    expect(__testing.evaluate("max(1, 2, 3)")).toBe(3)
    expect(__testing.evaluate("min(1, 2, 3)")).toBe(1)
    expect(__testing.evaluate("hypot(3, 4)")).toBe(5)
    expect(__testing.evaluate("sqrt(16)")).toBe(4)
    expect(__testing.evaluate("clamp(15, 0, 10)")).toBe(10)
    expect(__testing.evaluate("clamp(-5, 0, 10)")).toBe(0)
    expect(__testing.evaluate("pow(2, 8)")).toBe(256)
    expect(__testing.evaluate("log10(1000)")).toBeCloseTo(3)
  })

  test("trig identity", () => {
    const v = __testing.evaluate("sin(pi/4)^2 + cos(pi/4)^2")
    expect(v).toBeCloseTo(1, 10)
  })

  test("variables", () => {
    expect(__testing.evaluate("price * (1 + tax) - discount", { price: 100, tax: 0.2, discount: 5 })).toBeCloseTo(115)
  })

  test("gcd/lcm/factorial", () => {
    expect(__testing.gcd(12, 18)).toBe(6)
    expect(__testing.lcm(4, 6)).toBe(12)
    expect(__testing.factorial(5)).toBe(120)
    expect(__testing.factorial(0)).toBe(1)
  })

  test("number literals tolerate underscores", () => {
    expect(__testing.evaluate("1_000_000 + 1")).toBe(1_000_001)
  })

  test("syntax errors", () => {
    expect(() => __testing.evaluate("2 +")).toThrow()
    expect(() => __testing.evaluate("(1 + 2")).toThrow()
    expect(() => __testing.evaluate("foo()")).toThrow()
  })

  test("unknown identifier errors", () => {
    expect(() => __testing.evaluate("unknownvar + 1")).toThrow(/unknown/i)
  })

  test("reduce works", () => {
    expect(__testing.reduce("sum", [1, 2, 3, 4])).toBe(10)
    expect(__testing.reduce("mean", [1, 2, 3, 4])).toBe(2.5)
    expect(__testing.reduce("median", [1, 2, 3, 4])).toBe(2.5)
    expect(__testing.reduce("median", [1, 2, 3, 4, 5])).toBe(3)
    expect(__testing.reduce("min", [3, 1, 2])).toBe(1)
    expect(__testing.reduce("max", [3, 1, 2])).toBe(3)
    expect(__testing.reduce("product", [2, 3, 4])).toBe(24)
    expect(__testing.reduce("count", [1, 2, 3])).toBe(3)
  })

  test("reduce stddev", () => {
    // Population std dev of {2,4,4,4,5,5,7,9} = 2.
    expect(__testing.reduce("stddev", [2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(2)
  })

  test("precision rounding", () => {
    expect(__testing.applyPrecision(Math.PI, 4)).toBeCloseTo(3.1416)
  })
})

describe("tool.math tool", () => {
  it.live("eval works via tool", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* MathTool
        const tool = yield* toolInfo.init()
        const r = yield* tool.execute({ action: "eval", expression: "2 + 3 * 4" }, baseCtx)
        expect(r.metadata.value).toBe(14)
      }),
    ),
  )

  it.live("eval with vars and precision", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* MathTool
        const tool = yield* toolInfo.init()
        const r = yield* tool.execute(
          { action: "eval", expression: "log10(x)", vars: { x: 1024 }, precision: 4 },
          baseCtx,
        )
        expect(r.metadata.value).toBeCloseTo(3.0103, 4)
      }),
    ),
  )

  it.live("reduce via tool", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* MathTool
        const tool = yield* toolInfo.init()
        const r = yield* tool.execute({ action: "reduce", reducer: "mean", values: [1, 2, 3, 4] }, baseCtx)
        expect(r.metadata.value).toBe(2.5)
        expect(r.metadata.count).toBe(4)
      }),
    ),
  )

  it.live("eval surfaces parse errors", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* MathTool
        const tool = yield* toolInfo.init()
        const exit = yield* Effect.exit(tool.execute({ action: "eval", expression: "foo()" }, baseCtx))
        expect(exit._tag).toBe("Failure")
      }),
    ),
  )
})
