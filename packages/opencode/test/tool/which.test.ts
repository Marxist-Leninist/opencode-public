import { describe, expect } from "bun:test"
import * as fs from "fs/promises"
import * as path from "path"
import { Effect, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Agent } from "../../src/agent/agent"
import { MessageID, SessionID } from "../../src/session/schema"
import { Tool } from "../../src/tool"
import { WhichTool, __testing as whichTesting } from "../../src/tool/which"
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

const isWindows = process.platform === "win32"

async function makeExecutable(file: string) {
  if (isWindows) {
    // On Windows just having the right extension is enough.
    await fs.writeFile(file, "@echo off\necho ok\n", "utf8")
  } else {
    await fs.writeFile(file, "#!/bin/sh\necho ok\n", "utf8")
    await fs.chmod(file, 0o755)
  }
}

describe("tool.which", () => {
  it.live("rejects names with path separators", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* WhichTool
        const tool = yield* toolInfo.init()
        const exit = yield* Effect.exit(
          tool.execute({ action: "find", name: isWindows ? "C:\\bad" : "bad/name" }, baseCtx),
        )
        expect(exit._tag).toBe("Failure")
      }),
    ),
  )

  it.live("find returns the first match in a path_override", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const filename = isWindows ? "ocwhichtest1.cmd" : "ocwhichtest1"
        const exec = path.join(dir, filename)
        yield* Effect.promise(() => makeExecutable(exec))

        const toolInfo = yield* WhichTool
        const tool = yield* toolInfo.init()
        const result = yield* tool.execute(
          {
            action: "find",
            name: isWindows ? "ocwhichtest1" : "ocwhichtest1",
            path_override: dir,
          },
          baseCtx,
        )
        expect(result.metadata.found).toBe(true)
        expect(result.metadata.matches.length).toBe(1)
        expect(result.metadata.matches[0]!.path.toLowerCase()).toBe(exec.toLowerCase())
      }),
    ),
  )

  it.live("find returns not-found when name is absent", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const toolInfo = yield* WhichTool
        const tool = yield* toolInfo.init()
        const result = yield* tool.execute(
          { action: "find", name: "definitelynotreal_xyz123", path_override: dir },
          baseCtx,
        )
        expect(result.metadata.found).toBe(false)
        expect(result.metadata.matches.length).toBe(0)
        expect(result.output).toContain("not found in PATH")
      }),
    ),
  )

  it.live("all enumerates every match across multiple dirs", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const dir2 = path.join(dir, "second")
        yield* Effect.promise(() => fs.mkdir(dir2))
        const filename = isWindows ? "ocwhichall.cmd" : "ocwhichall"
        const a = path.join(dir, filename)
        const b = path.join(dir2, filename)
        yield* Effect.promise(() => makeExecutable(a))
        yield* Effect.promise(() => makeExecutable(b))

        const sep = isWindows ? ";" : ":"
        const toolInfo = yield* WhichTool
        const tool = yield* toolInfo.init()
        const result = yield* tool.execute(
          {
            action: "all",
            name: "ocwhichall",
            path_override: `${dir}${sep}${dir2}`,
          },
          baseCtx,
        )
        expect(result.metadata.found).toBe(true)
        expect(result.metadata.matches.length).toBe(2)
        expect(result.metadata.matches[0]!.path.toLowerCase()).toBe(a.toLowerCase())
        expect(result.metadata.matches[1]!.path.toLowerCase()).toBe(b.toLowerCase())
      }),
    ),
  )

  it.live("has returns boolean only", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const filename = isWindows ? "ocwhichhas.cmd" : "ocwhichhas"
        const exec = path.join(dir, filename)
        yield* Effect.promise(() => makeExecutable(exec))

        const toolInfo = yield* WhichTool
        const tool = yield* toolInfo.init()
        const got = yield* tool.execute(
          { action: "has", name: "ocwhichhas", path_override: dir },
          baseCtx,
        )
        const missing = yield* tool.execute(
          { action: "has", name: "ocwhichmissing", path_override: dir },
          baseCtx,
        )
        expect(got.output).toBe("true")
        expect(missing.output).toBe("false")
      }),
    ),
  )

  it.live("extra_paths are searched after the resolved PATH", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const dir2 = path.join(dir, "extra")
        yield* Effect.promise(() => fs.mkdir(dir2))
        const filename = isWindows ? "ocwhichextra.cmd" : "ocwhichextra"
        const exec = path.join(dir2, filename)
        yield* Effect.promise(() => makeExecutable(exec))

        const toolInfo = yield* WhichTool
        const tool = yield* toolInfo.init()
        const result = yield* tool.execute(
          {
            action: "find",
            name: "ocwhichextra",
            path_override: dir, // empty of matches
            extra_paths: [dir2],
          },
          baseCtx,
        )
        expect(result.metadata.found).toBe(true)
        expect(result.metadata.matches[0]!.path.toLowerCase()).toBe(exec.toLowerCase())
      }),
    ),
  )
})

describe("tool.which helpers", () => {
  it.live("nameHasSeparator rejects path-like names", () =>
    Effect.sync(() => {
      expect(whichTesting.nameHasSeparator("git")).toBe(false)
      expect(whichTesting.nameHasSeparator("a/b")).toBe(true)
      expect(whichTesting.nameHasSeparator("a\\b")).toBe(true)
    }),
  )

  it.live("splitPath handles platform separator", () =>
    Effect.sync(() => {
      const sep = process.platform === "win32" ? ";" : ":"
      expect(whichTesting.splitPath(`a${sep}b${sep}c`)).toEqual(["a", "b", "c"])
      expect(whichTesting.splitPath(``)).toEqual([])
    }),
  )
})
