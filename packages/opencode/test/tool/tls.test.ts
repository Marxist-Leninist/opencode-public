import { describe, expect, test } from "bun:test"
import { Effect, Exit, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Agent } from "../../src/agent/agent"
import { MessageID, SessionID } from "../../src/session/schema"
import { Tool } from "../../src/tool"
import { TlsTool, __testing } from "../../src/tool/tls"
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

describe("tool.tls helpers", () => {
  test("parseSan normalizes IP Address entries", () => {
    expect(__testing.parseSan("DNS:example.com, DNS:*.example.com, IP Address:127.0.0.1")).toEqual([
      "DNS:example.com",
      "DNS:*.example.com",
      "IP:127.0.0.1",
    ])
  })

  test("hostnameMatches handles exact, wildcard, and nested wildcard misses", () => {
    expect(__testing.hostnameMatches("example.com", ["DNS:example.com"]).matched).toBe(true)
    expect(__testing.hostnameMatches("api.example.com", ["DNS:*.example.com"]).matched).toBe(true)
    expect(__testing.hostnameMatches("deep.api.example.com", ["DNS:*.example.com"]).matched).toBe(false)
    expect(__testing.hostnameMatches("127.0.0.1", ["IP:127.0.0.1"]).matched).toBe(true)
  })
})

describe("tool.tls tool", () => {
  it.live("asks tls permission before opening a socket", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const calls: Array<Parameters<Tool.Context["ask"]>[0]> = []
        const toolInfo = yield* TlsTool
        const tool = yield* toolInfo.init()
        const exit = yield* Effect.exit(
          tool.execute(
            { action: "inspect", host: "example.com", timeout_ms: 1000 },
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
        expect(calls[0]!.permission).toBe("tls")
        expect(calls[0]!.patterns).toEqual(["inspect example.com:443"])
        expect(calls[0]!.metadata.servername).toBe("example.com")
      }),
    ),
  )
})
