import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Agent } from "../../src/agent/agent"
import { MessageID, SessionID } from "../../src/session/schema"
import { Tool } from "../../src/tool"
import { PathTool, __testing } from "../../src/tool/path"
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

describe("tool.path helpers", () => {
  test("commonPrefix finds longest shared dir", () => {
    expect(__testing.commonPrefix(["a/b/c.txt", "a/b/d.txt"], "/")).toBe("a/b")
    expect(__testing.commonPrefix(["a/b/c", "x/y/z"], "/")).toBe("")
    expect(__testing.commonPrefix(["a/b/c", "a/b/c"], "/")).toBe("a/b/c")
    expect(__testing.commonPrefix([], "/")).toBe("")
  })
})

describe("tool.path tool", () => {
  it.live("parse posix path", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* PathTool
        const tool = yield* toolInfo.init()
        const r = yield* tool.execute({ action: "parse", value: "/foo/bar.tar.gz", flavor: "posix" }, baseCtx)
        expect((r.metadata.result as any).base).toBe("bar.tar.gz")
        expect((r.metadata.result as any).ext).toBe(".gz")
        expect((r.metadata.result as any).dir).toBe("/foo")
      }),
    ),
  )
  it.live("join posix", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* PathTool
        const tool = yield* toolInfo.init()
        const r = yield* tool.execute({ action: "join", parts: ["a", "b", "c.txt"], flavor: "posix" }, baseCtx)
        expect(r.metadata.result).toBe("a/b/c.txt")
      }),
    ),
  )
  it.live("relative posix", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* PathTool
        const tool = yield* toolInfo.init()
        const r = yield* tool.execute(
          { action: "relative", from: "/a/b", to: "/a/c/d", flavor: "posix" },
          baseCtx,
        )
        expect(r.metadata.result).toBe("../c/d")
      }),
    ),
  )
  it.live("basename strips ext", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* PathTool
        const tool = yield* toolInfo.init()
        const r = yield* tool.execute(
          { action: "basename", value: "/foo/bar.tar.gz", ext: ".gz", flavor: "posix" },
          baseCtx,
        )
        expect(r.metadata.result).toBe("bar.tar")
      }),
    ),
  )
  it.live("normalize collapses .. and .", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* PathTool
        const tool = yield* toolInfo.init()
        const r = yield* tool.execute({ action: "normalize", value: "/a/b/../c/./d", flavor: "posix" }, baseCtx)
        expect(r.metadata.result).toBe("/a/c/d")
      }),
    ),
  )
  it.live("to_posix and to_windows convert separators", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* PathTool
        const tool = yield* toolInfo.init()
        const p = yield* tool.execute({ action: "to_posix", value: "C:\\Users\\me\\f" }, baseCtx)
        expect(p.metadata.result).toBe("C:/Users/me/f")
        const w = yield* tool.execute({ action: "to_windows", value: "/usr/local/bin" }, baseCtx)
        expect(w.metadata.result).toBe("\\usr\\local\\bin")
      }),
    ),
  )
  it.live("is_absolute", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* PathTool
        const tool = yield* toolInfo.init()
        const yes = yield* tool.execute({ action: "is_absolute", value: "/abs", flavor: "posix" }, baseCtx)
        expect(yes.metadata.result).toBe(true)
        const no = yield* tool.execute({ action: "is_absolute", value: "rel/path", flavor: "posix" }, baseCtx)
        expect(no.metadata.result).toBe(false)
      }),
    ),
  )
  it.live("split posix", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* PathTool
        const tool = yield* toolInfo.init()
        const r = yield* tool.execute({ action: "split", value: "a/b/c", flavor: "posix" }, baseCtx)
        expect(r.metadata.result).toEqual(["a", "b", "c"])
      }),
    ),
  )
  it.live("common_prefix", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* PathTool
        const tool = yield* toolInfo.init()
        const r = yield* tool.execute(
          { action: "common_prefix", parts: ["src/a/x.ts", "src/a/y.ts", "src/b/z.ts"], flavor: "posix" },
          baseCtx,
        )
        expect(r.metadata.result).toBe("src")
      }),
    ),
  )
})
