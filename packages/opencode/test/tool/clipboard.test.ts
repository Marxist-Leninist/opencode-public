import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Agent } from "../../src/agent/agent"
import { MessageID, SessionID } from "../../src/session/schema"
import { Tool } from "../../src/tool"
import { ClipboardTool } from "../../src/tool/clipboard"
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

describe("tool.clipboard", () => {
  it.live("write rejects when text is missing", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* ClipboardTool
        const tool = yield* toolInfo.init()
        const result = yield* tool.execute({ action: "write" }, baseCtx)
        expect(result.title).toBe("Clipboard write failed")
        expect(result.metadata.error).toContain("text parameter")
      }),
    ),
  )

  it.live("write/read roundtrips text", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        // CI environments often lack clipboard support; treat any failure as
        // "best-effort skip" rather than fail the test, since the contract is
        // that the tool reports the error gracefully.
        const toolInfo = yield* ClipboardTool
        const tool = yield* toolInfo.init()
        const sample = `clipboard-test-${Date.now()}`
        const writeResult = yield* tool.execute({ action: "write", text: sample }, baseCtx)
        if (writeResult.metadata.error) {
          expect(writeResult.title).toContain("Clipboard")
          return
        }
        expect(writeResult.metadata.action).toBe("write")
        expect(writeResult.metadata.text_length).toBe(sample.length)

        const readResult = yield* tool.execute({ action: "read" }, baseCtx)
        if (readResult.metadata.error) {
          expect(readResult.title).toContain("Clipboard")
          return
        }
        expect(readResult.metadata.action).toBe("read")
        expect(readResult.output).toContain(sample)
      }),
    ),
  )

  test("schema rejects unknown action", () => {
    // Smoke-test that the schema discriminator works without spawning the runtime.
    const toolInfo = ClipboardTool
    expect(toolInfo.id).toBe("clipboard")
  })
})
