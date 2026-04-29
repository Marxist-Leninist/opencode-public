import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Agent } from "../../src/agent/agent"
import { MessageID, SessionID } from "../../src/session/schema"
import { Tool } from "../../src/tool"
import { TextTool, __testing } from "../../src/tool/text"
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

describe("tool.text helpers", () => {
  test("toCase produces expected forms", () => {
    expect(__testing.toCase("Hello World - Foo Bar", "snake")).toBe("hello_world_foo_bar")
    expect(__testing.toCase("Hello World - Foo Bar", "kebab")).toBe("hello-world-foo-bar")
    expect(__testing.toCase("Hello World - Foo Bar", "camel")).toBe("helloWorldFooBar")
    expect(__testing.toCase("Hello World - Foo Bar", "pascal")).toBe("HelloWorldFooBar")
    expect(__testing.toCase("hello world", "title")).toBe("Hello World")
    expect(__testing.toCase("Hello World - Foo Bar", "constant")).toBe("HELLO_WORLD_FOO_BAR")
    expect(__testing.toCase("ABC", "lower")).toBe("abc")
  })

  test("slugify handles accents and weird input", () => {
    expect(__testing.slugify("Café résumé naïve")).toBe("cafe-resume-naive")
    expect(__testing.slugify("  multiple   spaces  ")).toBe("multiple-spaces")
    expect(__testing.slugify("punctuation!@#")).toBe("punctuation")
    expect(__testing.slugify("")).toBe("")
  })

  test("slugify respects custom separator", () => {
    expect(__testing.slugify("hello world", "_")).toBe("hello_world")
  })

  test("normalize collapses runs of whitespace", () => {
    expect(__testing.normalize("  hello   world\r\n  next   line\n")).toBe("hello world\nnext line")
  })

  test("counts produces character/byte/word/line counts", () => {
    const c = __testing.counts("abc\nlonger line\n")
    expect(c.characters).toBe(16)
    expect(c.lines).toBe(2)
    expect(c.words).toBe(3)
    expect(c.bytes).toBe(16)
  })
})

describe("tool.text tool", () => {
  it.live("count action returns metadata.count", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* TextTool
        const tool = yield* toolInfo.init()
        const r = yield* tool.execute({ action: "count", content: "alpha beta\ngamma\n" }, baseCtx)
        expect(r.metadata.count?.words).toBe(3)
        expect(r.metadata.count?.lines).toBe(2)
      }),
    ),
  )

  it.live("case snake works", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* TextTool
        const tool = yield* toolInfo.init()
        const r = yield* tool.execute(
          { action: "case", mode: "snake", content: "Hello, World" },
          baseCtx,
        )
        expect(r.output).toBe("hello_world")
      }),
    ),
  )

  it.live("lines: head/tail/grep filter", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* TextTool
        const tool = yield* toolInfo.init()
        const head = yield* tool.execute(
          { action: "lines", content: "1\n2\n3\n4\n5", head: 2 },
          baseCtx,
        )
        expect(head.output).toBe("1\n2")
        const tail = yield* tool.execute(
          { action: "lines", content: "1\n2\n3\n4\n5", tail: 2 },
          baseCtx,
        )
        expect(tail.output).toBe("4\n5")
        const grep = yield* tool.execute(
          { action: "lines", content: "info: ok\nerror: bad\nwarn: meh", grep: "error" },
          baseCtx,
        )
        expect(grep.output).toBe("error: bad")
      }),
    ),
  )

  it.live("dedupe preserves first occurrence", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* TextTool
        const tool = yield* toolInfo.init()
        const r = yield* tool.execute(
          { action: "dedupe", content: "a\nb\na\nc\nb\n" },
          baseCtx,
        )
        expect(r.output).toBe("a\nb\nc\n")
      }),
    ),
  )

  it.live("sort numeric desc", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* TextTool
        const tool = yield* toolInfo.init()
        const r = yield* tool.execute(
          { action: "sort", content: "10\n2\n30", numeric: true, desc: true },
          baseCtx,
        )
        expect(r.output).toBe("30\n10\n2")
      }),
    ),
  )

  it.live("slugify default", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* TextTool
        const tool = yield* toolInfo.init()
        const r = yield* tool.execute({ action: "slugify", content: "Hello, World!" }, baseCtx)
        expect(r.output).toBe("hello-world")
      }),
    ),
  )
})
