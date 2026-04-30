import { describe, expect } from "bun:test"
import * as fs from "fs/promises"
import * as nodePath from "path"
import { Cause, Effect, Exit, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Agent } from "../../src/agent/agent"
import { MessageID, SessionID } from "../../src/session/schema"
import { Tool } from "../../src/tool"
import { WaitTool } from "../../src/tool/wait"
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

const shellArg = (value: string) => JSON.stringify(value)
const bunEval = (script: string, args: string[] = []) =>
  [shellArg(process.execPath), "-e", shellArg(script), ...args.map(shellArg)].join(" ")

describe("tool.wait", () => {
  it.live("waits in the same tool execution", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const updates: Array<{ title?: string }> = []
        const toolInfo = yield* WaitTool
        const tool = yield* toolInfo.init()
        const result = yield* tool.execute(
          { seconds: 1, reason: "test delay" },
          {
            ...baseCtx,
            metadata: (input) =>
              Effect.sync(() => {
                updates.push(input)
              }),
          },
        )

        expect(updates[0]?.title).toBe("wait 1s - test delay")
        expect(result.metadata.mode).toBe("fixed")
        expect(result.metadata.aborted).toBe(false)
        expect(result.output).toContain("test delay")
      }),
    ),
  )

  it.live("returns when aborted", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), 20)
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            clearTimeout(timer)
          }),
        )

        const toolInfo = yield* WaitTool
        const tool = yield* toolInfo.init()
        const result = yield* tool.execute(
          { seconds: 3600, reason: "test cancel" },
          { ...baseCtx, abort: controller.signal },
        )

        expect(result.metadata.mode).toBe("fixed")
        expect(result.metadata.aborted).toBe(true)
        expect(result.output).toContain("Wait cancelled")
      }),
    ),
  )

  it.live("respects custom file polling and stability windows", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const target = nodePath.join(dir, "download.bin")
        yield* Effect.promise(() => fs.writeFile(target, Buffer.alloc(8)))

        const toolInfo = yield* WaitTool
        const tool = yield* toolInfo.init()
        const result = yield* tool.execute(
          {
            seconds: 1,
            reason: "fast file check",
            until_file: "download.bin",
            poll_interval_ms: 100,
            stable_ms: 100,
          },
          baseCtx,
        )

        expect(result.metadata.mode).toBe("until_file")
        expect(result.metadata.ready).toBe(true)
        expect(result.metadata.poll_interval_ms).toBe(100)
        expect(result.metadata.stable_ms).toBe(100)
        expect(result.metadata.elapsed_seconds ?? 999).toBeLessThan(1)
      }),
    ),
  )

  it.live("returns early when a cancel sentinel appears", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const cancelPath = nodePath.join(dir, "stop.wait")
        const timer = setTimeout(() => {
          void fs.writeFile(cancelPath, "stop")
        }, 150)
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            clearTimeout(timer)
          }),
        )

        const toolInfo = yield* WaitTool
        const tool = yield* toolInfo.init()
        const result = yield* tool.execute(
          {
            seconds: 3,
            reason: "sentinel cancel",
            poll_interval_ms: 100,
            cancel_if_file: "stop.wait",
          },
          baseCtx,
        )

        expect(result.metadata.mode).toBe("fixed")
        expect(result.metadata.aborted).toBe(false)
        expect(result.metadata.cancelled_by_file).toBe(true)
        expect(result.output).toContain("sentinel file")
      }),
    ),
  )

  it.live("returns early when until_url succeeds", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const server = Bun.serve({ port: 0, fetch: () => new Response("ok", { status: 200 }) })
        yield* Effect.addFinalizer(() =>
          Effect.promise(async () => {
            await server.stop(true)
          }),
        )
        const url = `http://127.0.0.1:${server.port}/`

        const toolInfo = yield* WaitTool
        const tool = yield* toolInfo.init()
        const result = yield* tool.execute(
          {
            seconds: 3,
            reason: "service health",
            until_url: url,
            poll_interval_ms: 100,
          },
          baseCtx,
        )

        expect(result.metadata.mode).toBe("until_url")
        expect(result.metadata.ready).toBe(true)
        expect(result.metadata.url_status).toBe(200)
        expect(result.metadata.elapsed_seconds ?? 999).toBeLessThan(2)
      }),
    ),
  )

  it.live("times out when until_url never returns the expected status", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const server = Bun.serve({ port: 0, fetch: () => new Response("nope", { status: 503 }) })
        yield* Effect.addFinalizer(() =>
          Effect.promise(async () => {
            await server.stop(true)
          }),
        )
        const url = `http://127.0.0.1:${server.port}/`

        const toolInfo = yield* WaitTool
        const tool = yield* toolInfo.init()
        const result = yield* tool.execute(
          {
            seconds: 1,
            reason: "expect 200",
            until_url: url,
            poll_interval_ms: 100,
          },
          baseCtx,
        )

        expect(result.metadata.mode).toBe("until_url")
        expect(result.metadata.ready).toBeFalsy()
        expect(result.metadata.timed_out).toBe(true)
        expect(result.metadata.url_status).toBe(503)
      }),
    ),
  )

  it.live("returns early when until_pid_exit process is gone", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* WaitTool
        const tool = yield* toolInfo.init()
        // Pick a pid extremely unlikely to be alive on a test runner.
        const result = yield* tool.execute(
          {
            seconds: 2,
            reason: "absent pid",
            until_pid_exit: 2_147_483_640,
            poll_interval_ms: 100,
          },
          baseCtx,
        )

        expect(result.metadata.mode).toBe("until_pid_exit")
        expect(result.metadata.exited).toBe(true)
        expect(result.metadata.elapsed_seconds ?? 999).toBeLessThan(1)
      }),
    ),
  )

  it.live("returns early when until_text pattern matches", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const target = nodePath.join(dir, "build.log")
        yield* Effect.promise(() => fs.writeFile(target, "starting...\n"))
        const timer = setTimeout(() => {
          void fs.appendFile(target, "BUILD SUCCESSFUL in 2s\n").catch(() => undefined)
        }, 200)
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            clearTimeout(timer)
          }),
        )

        const toolInfo = yield* WaitTool
        const tool = yield* toolInfo.init()
        const result = yield* tool.execute(
          {
            seconds: 3,
            reason: "wait for build success",
            until_text: "build.log",
            until_text_pattern: "BUILD SUCCESSFUL",
            poll_interval_ms: 100,
          },
          baseCtx,
        )

        expect(result.metadata.mode).toBe("until_text")
        expect(result.metadata.matched).toBe(true)
        expect(result.metadata.match).toContain("BUILD SUCCESSFUL")
        expect(result.metadata.elapsed_seconds ?? 999).toBeLessThan(2)
      }),
    ),
  )

  it.live("times out when until_text pattern never matches", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const target = nodePath.join(dir, "noisy.log")
        yield* Effect.promise(() => fs.writeFile(target, "irrelevant chatter\n"))

        const toolInfo = yield* WaitTool
        const tool = yield* toolInfo.init()
        const result = yield* tool.execute(
          {
            seconds: 1,
            reason: "expect missing pattern",
            until_text: "noisy.log",
            until_text_pattern: "BUILD FAILED",
            poll_interval_ms: 100,
          },
          baseCtx,
        )

        expect(result.metadata.mode).toBe("until_text")
        expect(result.metadata.matched).toBeFalsy()
        expect(result.metadata.timed_out).toBe(true)
      }),
    ),
  )

  it.live("rejects until_text without until_text_pattern", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* WaitTool
        const tool = yield* toolInfo.init()
        const exit = yield* Effect.exit(
          tool.execute(
            {
              seconds: 2,
              reason: "incomplete params",
              until_text: "any.log",
              poll_interval_ms: 100,
            },
            baseCtx,
          ),
        )
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(Cause.pretty(exit.cause)).toContain("until_text_pattern")
        }
      }),
    ),
  )

  it.live("returns early when until_port becomes reachable", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const server = Bun.serve({ port: 0, fetch: () => new Response("hi", { status: 200 }) })
        yield* Effect.addFinalizer(() =>
          Effect.promise(async () => {
            await server.stop(true)
          }),
        )

        const toolInfo = yield* WaitTool
        const tool = yield* toolInfo.init()
        const result = yield* tool.execute(
          {
            seconds: 5,
            reason: "wait for tcp port",
            until_port: server.port,
            until_port_host: "127.0.0.1",
            poll_interval_ms: 100,
          },
          baseCtx,
        )

        expect(result.metadata.mode).toBe("until_port")
        expect(result.metadata.port_open).toBe(true)
        expect(result.metadata.port).toBe(server.port)
        expect(result.metadata.elapsed_seconds ?? 999).toBeLessThan(2)
      }),
    ),
  )

  it.live("returns early when until_command exits with the expected code", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* WaitTool
        const tool = yield* toolInfo.init()
        const result = yield* tool.execute(
          {
            seconds: 5,
            reason: "wait for command success",
            until_command: process.platform === "win32" ? "cmd /c exit 0" : "true",
            poll_interval_ms: 200,
            until_command_timeout_ms: 5000,
          },
          baseCtx,
        )

        expect(result.metadata.mode).toBe("until_command")
        expect(result.metadata.ready).toBe(true)
        expect(result.metadata.command_exit_code).toBe(0)
        expect(result.metadata.elapsed_seconds ?? 999).toBeLessThan(2)
      }),
    ),
  )

  it.live("matches a non-zero expected exit code", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* WaitTool
        const tool = yield* toolInfo.init()
        const result = yield* tool.execute(
          {
            seconds: 5,
            reason: "wait for command failure",
            until_command: process.platform === "win32" ? "cmd /c exit 7" : "exit 7",
            until_command_exit_code: 7,
            poll_interval_ms: 200,
            until_command_timeout_ms: 5000,
          },
          baseCtx,
        )

        expect(result.metadata.mode).toBe("until_command")
        expect(result.metadata.ready).toBe(true)
        expect(result.metadata.command_exit_code).toBe(7)
        expect(result.metadata.command_expected_exit_code).toBe(7)
      }),
    ),
  )

  it.live("times out when until_command never matches the expected exit code", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* WaitTool
        const tool = yield* toolInfo.init()
        const result = yield* tool.execute(
          {
            seconds: 1,
            reason: "expect mismatched exit",
            until_command: process.platform === "win32" ? "cmd /c exit 1" : "false",
            until_command_exit_code: 0,
            poll_interval_ms: 200,
            until_command_timeout_ms: 5000,
          },
          baseCtx,
        )

        expect(result.metadata.mode).toBe("until_command")
        expect(result.metadata.ready).toBeFalsy()
        expect(result.metadata.timed_out).toBe(true)
        expect(result.metadata.command_exit_code).toBe(1)
      }),
    ),
  )

  it.live("asks bash permission before running until_command", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const marker = nodePath.join(dir, "marker.txt")
        const toolInfo = yield* WaitTool
        const tool = yield* toolInfo.init()
        const calls: Array<Parameters<Tool.Context["ask"]>[0]> = []
        const exit = yield* Effect.exit(
          tool.execute(
            {
              seconds: 5,
              reason: "permission gate command wait",
              until_command: bunEval("require('fs').writeFileSync(process.argv[1], 'ran')", [marker]),
              poll_interval_ms: 200,
              until_command_timeout_ms: 5000,
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

        const markerExists = yield* Effect.promise(() =>
          fs.access(marker).then(
            () => true,
            () => false,
          ),
        )

        expect(Exit.isFailure(exit)).toBe(true)
        expect(markerExists).toBe(false)
        expect(calls).toHaveLength(1)
        expect(calls[0]!.permission).toBe("bash")
        expect(calls[0]!.metadata.source).toBe("wait.until_command")
      }),
    ),
  )

  it.live("keeps the command output tail in metadata", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* WaitTool
        const tool = yield* toolInfo.init()
        const result = yield* tool.execute(
          {
            seconds: 5,
            reason: "capture command tail",
            until_command: bunEval("process.stdout.write('head\\n' + 'x'.repeat(6000) + '\\ntail-marker\\n')"),
            poll_interval_ms: 200,
            until_command_timeout_ms: 5000,
          },
          baseCtx,
        )

        expect(result.metadata.mode).toBe("until_command")
        expect(result.metadata.ready).toBe(true)
        expect(result.metadata.command_output_tail).toContain("tail-marker")
      }),
    ),
  )

  it.live("times out when until_port never opens", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        // Pick a high port nothing should be listening on. We avoid binding so
        // it stays closed throughout the test.
        const closedPort = 1
        const toolInfo = yield* WaitTool
        const tool = yield* toolInfo.init()
        const result = yield* tool.execute(
          {
            seconds: 1,
            reason: "expect closed port",
            until_port: closedPort,
            until_port_host: "127.0.0.1",
            poll_interval_ms: 100,
          },
          baseCtx,
        )

        expect(result.metadata.mode).toBe("until_port")
        expect(result.metadata.port_open).toBeFalsy()
        expect(result.metadata.timed_out).toBe(true)
        expect(typeof result.metadata.port_last_error).toBe("string")
      }),
    ),
  )
})
