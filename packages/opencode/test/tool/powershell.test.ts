import { describe, expect, test } from "bun:test"
import { Effect, Exit, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Agent } from "../../src/agent/agent"
import { MessageID, SessionID } from "../../src/session/schema"
import { Tool } from "../../src/tool"
import { PowerShellTool, __testing as PSTesting } from "../../src/tool/powershell"
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

const noAbort = AbortSignal.any([])

async function detectExecutable(): Promise<string | null> {
  for (const exe of ["pwsh", "powershell"]) {
    if (await PSTesting.checkExecutable(exe, noAbort)) return exe
  }
  return null
}

describe("tool.powershell", () => {
  it.live("asks powershell permission before resolving an executable", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const calls: Array<Parameters<Tool.Context["ask"]>[0]> = []
        const toolInfo = yield* PowerShellTool
        const tool = yield* toolInfo.init()
        const command = "Write-Output 'permission-probe'"
        const exit = yield* Effect.exit(
          tool.execute(
            {
              command,
              description: "permission check",
              workdir: dir,
            },
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
        expect(calls[0]!.permission).toBe("powershell")
        expect(calls[0]!.patterns).toEqual([command])
        expect(calls[0]!.always).toEqual([command])
        expect(calls[0]!.metadata).toMatchObject({
          description: "permission check",
          workdir: dir,
          preferred: "auto",
        })
      }),
    ),
  )

  it.live("runs a trivial Write-Output command", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const exe = yield* Effect.promise(() => detectExecutable())
        if (!exe) {
          // Skip when no PowerShell is on PATH (CI without pwsh)
          return
        }
        const toolInfo = yield* PowerShellTool
        const tool = yield* toolInfo.init()
        const result = yield* tool.execute(
          {
            command: "Write-Output 'hello-from-ps'",
            description: "trivial echo",
            workdir: dir,
          },
          baseCtx,
        )
        expect(result.metadata.exit_code).toBe(0)
        expect(result.metadata.ok).toBe(true)
        expect(result.output).toContain("hello-from-ps")
        expect(result.metadata.executable).toBe(exe)
      }),
    ),
  )

  it.live("returns the workdir as cwd", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const exe = yield* Effect.promise(() => detectExecutable())
        if (!exe) return
        const toolInfo = yield* PowerShellTool
        const tool = yield* toolInfo.init()
        const result = yield* tool.execute(
          {
            command: "(Get-Location).Path",
            description: "report cwd",
            workdir: dir,
          },
          baseCtx,
        )
        expect(result.metadata.exit_code).toBe(0)
        // PS resolves the directory; on Windows path separators differ, so just check the dir name shows up
        const tail = dir.replace(/[\/\\]+$/g, "").split(/[\/\\]/).pop()!
        expect(result.output).toContain(tail)
      }),
    ),
  )

  it.live("propagates non-zero exit codes as ok=false", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const exe = yield* Effect.promise(() => detectExecutable())
        if (!exe) return
        const toolInfo = yield* PowerShellTool
        const tool = yield* toolInfo.init()
        const result = yield* tool.execute(
          {
            command: "exit 7",
            description: "non-zero exit",
            workdir: dir,
          },
          baseCtx,
        )
        expect(result.metadata.exit_code).toBe(7)
        expect(result.metadata.ok).toBe(false)
      }),
    ),
  )

  it.live("ignore_exit_code makes a non-zero exit ok=true", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const exe = yield* Effect.promise(() => detectExecutable())
        if (!exe) return
        const toolInfo = yield* PowerShellTool
        const tool = yield* toolInfo.init()
        const result = yield* tool.execute(
          {
            command: "exit 3",
            description: "non-zero ignored",
            workdir: dir,
            ignore_exit_code: true,
          },
          baseCtx,
        )
        expect(result.metadata.exit_code).toBe(3)
        expect(result.metadata.ok).toBe(true)
      }),
    ),
  )

  it.live("captures stderr separately from stdout", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const exe = yield* Effect.promise(() => detectExecutable())
        if (!exe) return
        const toolInfo = yield* PowerShellTool
        const tool = yield* toolInfo.init()
        const result = yield* tool.execute(
          {
            command: "[Console]::Error.WriteLine('boom-marker'); Write-Output 'after'",
            description: "stderr capture",
            workdir: dir,
          },
          baseCtx,
        )
        expect(result.metadata.exit_code).toBe(0)
        // stderr_bytes > 0 proves stderr was captured separately
        expect(result.metadata.stderr_bytes).toBeGreaterThan(0)
        expect(result.output).toContain("boom-marker")
        expect(result.output).toContain("after")
      }),
    ),
  )

  it.live("times out and reports timed_out=true", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const exe = yield* Effect.promise(() => detectExecutable())
        if (!exe) return
        const toolInfo = yield* PowerShellTool
        const tool = yield* toolInfo.init()
        const result = yield* tool.execute(
          {
            command: "Start-Sleep -Seconds 5",
            description: "force timeout",
            workdir: dir,
            timeout_ms: 800,
          },
          baseCtx,
        )
        expect(result.metadata.timed_out).toBe(true)
        expect(result.metadata.ok).toBe(false)
      }),
    ),
  )

  it.live("auto preference picks pwsh or powershell", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const exe = yield* Effect.promise(() => detectExecutable())
        if (!exe) return
        const toolInfo = yield* PowerShellTool
        const tool = yield* toolInfo.init()
        const result = yield* tool.execute(
          {
            command: "Write-Output ok",
            description: "auto picks something",
            workdir: dir,
            prefer: "auto",
          },
          baseCtx,
        )
        expect(["pwsh", "powershell"]).toContain(result.metadata.executable)
        expect(result.metadata.preferred).toBe("auto")
      }),
    ),
  )

  test("runScript times out Windows PowerShell without surfacing kill errors", async () => {
    if (process.platform !== "win32") return

    const result = await PSTesting.runScript(
      "powershell.exe",
      "Start-Sleep -Seconds 30",
      process.cwd(),
      100,
      1024,
      new AbortController().signal,
    )

    expect(result.timedOut).toBe(true)
    expect(result.exitCode).not.toBe(0)
  }, 15_000)
})
