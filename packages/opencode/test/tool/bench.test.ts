import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Agent } from "../../src/agent/agent"
import { MessageID, SessionID } from "../../src/session/schema"
import { Tool } from "../../src/tool"
import { BenchTool, __testing } from "../../src/tool/bench"
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

describe("tool.bench helpers", () => {
  test("statsOf: computes min/max/median", () => {
    const s = __testing.statsOf([10, 20, 30, 40, 50])
    expect(s.min).toBe(10)
    expect(s.max).toBe(50)
    expect(s.mean).toBe(30)
    expect(s.median).toBe(30)
    expect(s.runs).toBe(5)
    expect(s.successes).toBe(5)
  })
  test("statsOf: even-length median", () => {
    const s = __testing.statsOf([10, 20, 30, 40])
    expect(s.median).toBe(25)
  })
  test("statsOf: empty input", () => {
    const s = __testing.statsOf([])
    expect(s.runs).toBe(0)
    expect(s.mean).toBe(0)
  })
})

describe("tool.bench tool", () => {
  it.live("command bench: simple shell echo", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const ti = yield* BenchTool
        const tool = yield* ti.init()
        const cmd = process.platform === "win32" ? "cmd /c exit 0" : "true"
        const r = yield* tool.execute({ action: "command", command: cmd, runs: 3 }, baseCtx)
        expect(r.metadata.stats?.runs).toBe(3)
        expect(r.metadata.stats?.successes).toBe(3)
        expect(r.output).toContain("median")
      }),
    ),
  )
  it.live("command bench: failing command produces failures", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const ti = yield* BenchTool
        const tool = yield* ti.init()
        const cmd = process.platform === "win32" ? "cmd /c exit 1" : "false"
        const r = yield* tool.execute({ action: "command", command: cmd, runs: 2 }, baseCtx)
        expect(r.metadata.stats?.failures).toBe(2)
      }),
    ),
  )
})
