import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Agent } from "../../src/agent/agent"
import { MessageID, SessionID } from "../../src/session/schema"
import { Tool } from "../../src/tool"
import { DiffTool, __testing } from "../../src/tool/diff"
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

describe("tool.diff helpers", () => {
  test("countLines counts terminated and partial lines", () => {
    expect(__testing.countLines("")).toBe(0)
    expect(__testing.countLines("abc")).toBe(1)
    expect(__testing.countLines("abc\n")).toBe(1)
    expect(__testing.countLines("abc\ndef")).toBe(2)
    expect(__testing.countLines("abc\ndef\n")).toBe(2)
  })
})

describe("tool.diff tool", () => {
  it.live("reports identical when inputs match", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* DiffTool
        const tool = yield* toolInfo.init()
        const r = yield* tool.execute({ a: "same\n", b: "same\n" }, baseCtx)
        expect(r.metadata.identical).toBe(true)
        expect(r.metadata.added_lines).toBe(0)
        expect(r.metadata.removed_lines).toBe(0)
      }),
    ),
  )

  it.live("unified format produces a parseable patch", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* DiffTool
        const tool = yield* toolInfo.init()
        const r = yield* tool.execute(
          { format: "unified", a: "one\ntwo\nthree\n", b: "one\nTWO\nthree\n", label_a: "old", label_b: "new" },
          baseCtx,
        )
        expect(r.output).toContain("--- old")
        expect(r.output).toContain("+++ new")
        expect(r.output).toContain("-two")
        expect(r.output).toContain("+TWO")
        expect(r.metadata.added_lines).toBe(1)
        expect(r.metadata.removed_lines).toBe(1)
      }),
    ),
  )

  it.live("stat format outputs counts", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* DiffTool
        const tool = yield* toolInfo.init()
        const r = yield* tool.execute(
          { format: "stat", a: "a\nb\nc\n", b: "a\nB\nc\nd\n" },
          baseCtx,
        )
        expect(r.output).toMatch(/^\+\d+ -\d+ =\d+/)
        expect(r.metadata.added_lines).toBe(2)
        expect(r.metadata.removed_lines).toBe(1)
      }),
    ),
  )

  it.live("words format uses inline markers", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* DiffTool
        const tool = yield* toolInfo.init()
        const r = yield* tool.execute(
          { format: "words", a: "the quick brown fox", b: "the slow brown dog" },
          baseCtx,
        )
        expect(r.output).toContain("[-quick-]")
        expect(r.output).toContain("{+slow+}")
      }),
    ),
  )

  it.live("requires sides", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* DiffTool
        const tool = yield* toolInfo.init()
        const exit = yield* Effect.exit(tool.execute({ b: "only b" }, baseCtx))
        expect(exit._tag).toBe("Failure")
      }),
    ),
  )
})
