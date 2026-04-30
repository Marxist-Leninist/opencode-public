import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Agent } from "../../src/agent/agent"
import { MessageID, SessionID } from "../../src/session/schema"
import { Tool } from "../../src/tool"
import { SlugTool, __testing } from "../../src/tool/slug"
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

describe("tool.slug helpers", () => {
  test("slugify transliterates, lowercases, collapses separators, and counts emoji replacements", () => {
    const result = __testing.slugify("Caf\u00e9 d\u00e9j\u00e0 vu \ud83d\ude80", { emoji: true })
    expect(result.slug).toBe("cafe-deja-vu-rocket")
    expect(result.replaced).toBe(1)
  })

  test("breadcrumb splits common path separators", () => {
    expect(__testing.breadcrumb("Foo > Bar/Baz")).toEqual(["foo", "bar", "baz"])
  })

  test("truncateAtSeparator avoids splitting a segment when possible", () => {
    expect(__testing.truncateAtSeparator("alpha-beta-gamma", "-", 11)).toEqual({
      text: "alpha-beta",
      truncated: true,
    })
  })
})

describe("tool.slug tool", () => {
  it.live("slugify returns slug metadata", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* SlugTool
        const tool = yield* toolInfo.init()
        const result = yield* tool.execute({ action: "slugify", text: "Hello, World!" }, baseCtx)
        expect(result.output).toBe("hello-world")
        expect(result.metadata.slug).toBe("hello-world")
      }),
    ),
  )

  it.live("breadcrumb joins slugified segments with slash", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* SlugTool
        const tool = yield* toolInfo.init()
        const result = yield* tool.execute({ action: "breadcrumb", text: "Foo > Bar/Baz" }, baseCtx)
        expect(result.output).toBe("foo/bar/baz")
        expect(result.metadata.segments).toEqual(["foo", "bar", "baz"])
      }),
    ),
  )
})
