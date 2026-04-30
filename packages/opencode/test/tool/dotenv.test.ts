import { describe, expect, test } from "bun:test"
import { Effect, Exit, Layer } from "effect"
import { writeFile } from "node:fs/promises"
import * as path from "node:path"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Agent } from "../../src/agent/agent"
import { MessageID, SessionID } from "../../src/session/schema"
import { Tool } from "../../src/tool"
import { DotenvTool, __testing } from "../../src/tool/dotenv"
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

describe("tool.dotenv helpers", () => {
  test("parseLines handles comments, quotes, expansion, and duplicates", () => {
    const parsed = __testing.parseLines(
      [
        "# server settings",
        "HOST=localhost",
        "PORT=3000",
        'URL="http://${HOST}:${PORT}"',
        "HOST=override",
        "BROKEN LINE",
      ].join("\n"),
      true,
    )

    expect(parsed.entries.map((item) => item.key)).toEqual(["HOST", "PORT", "URL", "HOST"])
    expect(parsed.entries[2]!.value).toBe("http://localhost:3000")
    expect(parsed.entries[0]!.comment).toBe("server settings")
    expect(parsed.malformed).toEqual([6])
  })

  test("stringifyValues quotes dotenv and shell values safely", () => {
    const dotenv = __testing.stringifyValues({ A: "plain", B: "two words", C: null }, undefined, "dotenv", true)
    expect(dotenv).toContain("A=plain")
    expect(dotenv).toContain('B="two words"')
    expect(dotenv).toContain('C=""')

    const shell = __testing.stringifyValues({ A: "plain", B: "two words" }, undefined, "shell", true)
    expect(shell).toContain("A=plain")
    expect(shell).toContain("B='two words'")
  })

  test("secret-looking names can be identified for redaction", () => {
    expect(__testing.isSecretName("OPENROUTER_API_KEY")).toBe(true)
    expect(__testing.isSecretName("SESSION_COOKIE")).toBe(true)
    expect(__testing.isSecretName("LOG_LEVEL")).toBe(false)
  })
})

describe("tool.dotenv tool", () => {
  it.live("asks read permission before loading a dotenv file", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const file = path.join(dir, ".env.local")
        yield* Effect.promise(() => writeFile(file, "TOKEN=abc123\nMODE=test\n", "utf8"))

        const calls: Array<Parameters<Tool.Context["ask"]>[0]> = []
        const toolInfo = yield* DotenvTool
        const tool = yield* toolInfo.init()
        const exit = yield* Effect.exit(
          tool.execute(
            { action: "info", file },
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
        expect(calls[0]!.permission).toBe("read")
        expect(calls[0]!.patterns).toEqual([file])
        expect(calls[0]!.metadata).toMatchObject({ source: "dotenv", action: "info", file })
      }),
    ),
  )

  it.live("parses inline text with optional secret redaction", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* DotenvTool
        const tool = yield* toolInfo.init()
        const result = yield* tool.execute(
          {
            action: "parse",
            text: "OPENROUTER_API_KEY=abc123\nLOG_LEVEL=debug\n",
            redact_secrets: true,
          },
          baseCtx,
        )

        expect(result.metadata.keys).toBe(2)
        expect(JSON.parse(result.output)).toEqual({
          OPENROUTER_API_KEY: "***",
          LOG_LEVEL: "debug",
        })
      }),
    ),
  )

  it.live("stringifies values without needing file permission", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* DotenvTool
        const tool = yield* toolInfo.init()
        const result = yield* tool.execute(
          {
            action: "stringify",
            values: { LOG_LEVEL: "info", EMPTY: null },
          },
          baseCtx,
        )

        expect(result.metadata.keys).toBe(2)
        expect(result.output).toContain("LOG_LEVEL=info")
        expect(result.output).toContain('EMPTY=""')
      }),
    ),
  )
})
