import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Agent } from "../../src/agent/agent"
import { MessageID, SessionID } from "../../src/session/schema"
import { Tool } from "../../src/tool"
import { YamlTool } from "../../src/tool/yaml"
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

describe("tool.yaml tool", () => {
  it.live("parses YAML to JSON", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* YamlTool
        const tool = yield* toolInfo.init()
        const result = yield* tool.execute(
          {
            action: "parse",
            content: "name: hello\nitems:\n  - 1\n  - 2\nnested:\n  key: value\n",
          },
          baseCtx,
        )
        const parsed = JSON.parse(result.output)
        expect(parsed).toEqual({ name: "hello", items: [1, 2], nested: { key: "value" } })
      }),
    ),
  )

  it.live("stringifies JSON to YAML and round-trips", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* YamlTool
        const tool = yield* toolInfo.init()
        const value = { service: { port: 8080, host: "localhost" }, tags: ["a", "b"] }
        const enc = yield* tool.execute(
          { action: "stringify", content: JSON.stringify(value) },
          baseCtx,
        )
        // Round-trip through parse to confirm semantic equivalence
        const dec = yield* tool.execute({ action: "parse", content: enc.output }, baseCtx)
        const back = JSON.parse(dec.output)
        expect(back).toEqual(value)
      }),
    ),
  )

  it.live("from_json is alias of stringify", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* YamlTool
        const tool = yield* toolInfo.init()
        const a = yield* tool.execute({ action: "stringify", content: '{"x":1}' }, baseCtx)
        const b = yield* tool.execute({ action: "from_json", content: '{"x":1}' }, baseCtx)
        expect(a.output).toBe(b.output)
      }),
    ),
  )

  it.live("rejects invalid JSON for stringify", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* YamlTool
        const tool = yield* toolInfo.init()
        const exit = yield* Effect.exit(
          tool.execute({ action: "stringify", content: "{not: valid json}" }, baseCtx),
        )
        expect(exit._tag).toBe("Failure")
      }),
    ),
  )
})
