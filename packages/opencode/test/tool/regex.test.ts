import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Agent } from "../../src/agent/agent"
import { MessageID, SessionID } from "../../src/session/schema"
import { Tool } from "../../src/tool"
import { RegexTool, __testing } from "../../src/tool/regex"
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

describe("tool.regex helpers", () => {
  test("normalizeFlags dedupes and adds g where required", () => {
    expect(__testing.normalizeFlags("ii", "test")).toBe("i")
    expect(__testing.normalizeFlags("im", "match_all").includes("g")).toBe(true)
    expect(__testing.normalizeFlags("im", "replace_all").includes("g")).toBe(true)
    expect(__testing.normalizeFlags("im", "extract").includes("g")).toBe(true)
  })

  test("normalizeFlags rejects unknown flags", () => {
    expect(() => __testing.normalizeFlags("z", "test")).toThrow()
  })

  test("compile rejects too-long patterns", () => {
    const big = "a".repeat(20_000)
    expect(() => __testing.compile(big, "")).toThrow()
  })

  test("execAll caps results at limit", () => {
    const re = new RegExp("a", "g")
    const { matches, truncated } = __testing.execAll(re, "aaaaaa", 3)
    expect(matches.length).toBe(3)
    expect(truncated).toBe(true)
  })
})

describe("tool.regex tool", () => {
  it.live("test action returns boolean", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* RegexTool
        const tool = yield* toolInfo.init()
        const result = yield* tool.execute(
          { action: "test", pattern: "^foo", value: "foobar" },
          baseCtx,
        )
        expect(result.metadata.matched).toBe(true)
        expect(result.output).toBe("true")
      }),
    ),
  )

  it.live("match returns first occurrence with groups", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* RegexTool
        const tool = yield* toolInfo.init()
        const result = yield* tool.execute(
          {
            action: "match",
            pattern: "(?<scheme>https?)://(?<host>[^/]+)",
            value: "fetch http://example.com/path now",
          },
          baseCtx,
        )
        const m = result.metadata.matches![0]!
        expect(m.match).toBe("http://example.com")
        expect(m.named_groups.scheme).toBe("http")
        expect(m.named_groups.host).toBe("example.com")
      }),
    ),
  )

  it.live("match_all returns every email", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* RegexTool
        const tool = yield* toolInfo.init()
        const result = yield* tool.execute(
          {
            action: "match_all",
            pattern: "[\\w.-]+@[\\w.-]+\\.[\\w]{2,}",
            value: "send to alice@x.com and bob@y.io please",
          },
          baseCtx,
        )
        expect(result.metadata.count).toBe(2)
        expect(result.metadata.matches?.[0]?.match).toBe("alice@x.com")
        expect(result.metadata.matches?.[1]?.match).toBe("bob@y.io")
      }),
    ),
  )

  it.live("replace_all replaces every occurrence", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* RegexTool
        const tool = yield* toolInfo.init()
        const result = yield* tool.execute(
          { action: "replace_all", pattern: "\\bfoo\\b", value: "foo bar foo baz", replacement: "FOO" },
          baseCtx,
        )
        expect(result.output).toBe("FOO bar FOO baz")
        expect(result.metadata.count).toBe(2)
      }),
    ),
  )

  it.live("replace honours $1 backref", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* RegexTool
        const tool = yield* toolInfo.init()
        const result = yield* tool.execute(
          { action: "replace", pattern: "(\\d+)", value: "version 42 here", replacement: "[$1]" },
          baseCtx,
        )
        expect(result.output).toBe("version [42] here")
      }),
    ),
  )

  it.live("split returns parts", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* RegexTool
        const tool = yield* toolInfo.init()
        const result = yield* tool.execute(
          { action: "split", pattern: "\\s*,\\s*", value: "a, b,c , d" },
          baseCtx,
        )
        expect(result.metadata.parts).toEqual(["a", "b", "c", "d"])
      }),
    ),
  )

  it.live("extract returns captured groups", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* RegexTool
        const tool = yield* toolInfo.init()
        const result = yield* tool.execute(
          { action: "extract", pattern: "v(\\d+\\.\\d+\\.\\d+)", value: "release-v1.2.3 and v9.0.0", group: 1 },
          baseCtx,
        )
        expect(result.metadata.parts).toEqual(["1.2.3", "9.0.0"])
      }),
    ),
  )

  it.live("invalid pattern surfaces a clean error", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* RegexTool
        const tool = yield* toolInfo.init()
        const exit = yield* Effect.exit(
          tool.execute({ action: "test", pattern: "(unbalanced", value: "x" }, baseCtx),
        )
        expect(exit._tag).toBe("Failure")
      }),
    ),
  )

  it.live("replace without replacement throws", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* RegexTool
        const tool = yield* toolInfo.init()
        const exit = yield* Effect.exit(
          tool.execute({ action: "replace", pattern: "x", value: "x" }, baseCtx),
        )
        expect(exit._tag).toBe("Failure")
      }),
    ),
  )
})
