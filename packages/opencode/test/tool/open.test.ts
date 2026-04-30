import { describe, expect, test } from "bun:test"
import * as fs from "fs/promises"
import * as nodePath from "path"
import { Cause, Effect, Exit, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Agent } from "../../src/agent/agent"
import { MessageID, SessionID } from "../../src/session/schema"
import { Tool } from "../../src/tool"
import { OpenTool, __testing } from "../../src/tool/open"
import { Truncate } from "../../src/tool"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const { classifyTarget, platformLauncher } = __testing

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

describe("tool.open helpers", () => {
  test("classifyTarget recognises http(s)/file URLs", () => {
    const httpResult = classifyTarget("https://example.com/path")
    expect(httpResult.kind).toBe("url")

    const fileResult = classifyTarget("file:///C:/foo/bar.txt")
    expect(fileResult.kind).toBe("url")

    const ftpResult = classifyTarget("ftp://example.com/file.bin")
    expect(ftpResult.kind).toBe("url")
  })

  test("classifyTarget treats Windows drive letters as paths", () => {
    const r = classifyTarget("C:\\Users\\foo\\bar.txt")
    expect(r.kind).toBe("path")
  })

  test("classifyTarget treats relative paths as paths", () => {
    const r = classifyTarget("./build/report.html")
    expect(r.kind).toBe("path")
  })

  test("platformLauncher uses cmd.exe start on Windows for URLs", () => {
    const r = platformLauncher("https://example.com", false, "url", "win32")
    expect(r.cmd.toLowerCase().endsWith("cmd.exe") || r.cmd === "cmd.exe").toBe(true)
    expect(r.args[0]).toBe("/c")
    expect(r.args[1]).toBe("start")
    expect(r.args[2]).toBe("")
    expect(r.args[3]).toBe("https://example.com")
  })

  test("platformLauncher uses explorer /select for reveal+file on Windows", () => {
    const r = platformLauncher("C:\\foo\\bar.txt", true, "file", "win32")
    expect(r.cmd).toBe("explorer.exe")
    expect(r.args[0]).toBe("/select,C:\\foo\\bar.txt")
  })

  test("platformLauncher uses open -R on macOS reveal", () => {
    const r = platformLauncher("/tmp/file.bin", true, "file", "darwin")
    expect(r.cmd).toBe("open")
    expect(r.args).toEqual(["-R", "/tmp/file.bin"])
  })

  test("platformLauncher uses xdg-open on linux", () => {
    const r = platformLauncher("/tmp/file.bin", false, "file", "linux")
    expect(r.cmd).toBe("xdg-open")
    expect(r.args).toEqual(["/tmp/file.bin"])
  })
})

describe("tool.open", () => {
  it.live("rejects unsupported URL schemes", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* OpenTool
        const tool = yield* toolInfo.init()
        const exit = yield* Effect.exit(tool.execute({ target: "javascript:alert(1)" }, baseCtx))
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(Cause.pretty(exit.cause)).toContain("scheme")
        }
      }),
    ),
  )

  it.live("rejects nonexistent local paths", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* OpenTool
        const tool = yield* toolInfo.init()
        const exit = yield* Effect.exit(
          tool.execute({ target: "definitely-not-a-real-file-xyz.txt" }, baseCtx),
        )
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(Cause.pretty(exit.cause)).toContain("does not exist")
        }
      }),
    ),
  )

  it.live("classifies a real local file as kind=file", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const target = nodePath.join(dir, "report.txt")
        yield* Effect.promise(() => fs.writeFile(target, "hello"))

        // We can't reliably actually open a file in CI without spawning a GUI app,
        // so we exercise the classification + resolution path and accept either
        // delivered=true (test runner is interactive) or delivered=false with a
        // sensible kind/resolved metadata payload.
        const toolInfo = yield* OpenTool
        const tool = yield* toolInfo.init()
        const result = yield* tool.execute({ target: "report.txt" }, baseCtx)

        expect(result.metadata.kind).toBe("file")
        expect(typeof result.metadata.resolved).toBe("string")
        expect(result.metadata.resolved!.endsWith("report.txt")).toBe(true)
      }),
    ),
  )

  it.live("asks open permission before launching a local target", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const target = nodePath.join(dir, "report.txt")
        yield* Effect.promise(() => fs.writeFile(target, "hello"))
        const calls: Array<Parameters<Tool.Context["ask"]>[0]> = []

        const toolInfo = yield* OpenTool
        const tool = yield* toolInfo.init()
        const exit = yield* Effect.exit(
          tool.execute(
            { target: "report.txt" },
            {
              ...baseCtx,
              ask: (input) =>
                Effect.sync(() => {
                  calls.push(input)
                  throw new Error("permission probe")
                }),
            },
          ),
        )

        expect(Exit.isFailure(exit)).toBe(true)
        expect(calls).toHaveLength(1)
        expect(calls[0]!.permission).toBe("open")
        expect(calls[0]!.patterns).toEqual([target])
      }),
    ),
  )
})
