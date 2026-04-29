import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Agent } from "../../src/agent/agent"
import { MessageID, SessionID } from "../../src/session/schema"
import { Tool } from "../../src/tool"
import { MimeTool, __testing } from "../../src/tool/mime"
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

describe("tool.mime helpers", () => {
  test("extension to mime", () => {
    expect(__testing.extensionMime(".png")).toBe("image/png")
    expect(__testing.extensionMime("foo.bar/something.JSON")).toBe("application/json")
    expect(__testing.extensionMime("svg")).toBe("image/svg+xml")
    expect(__testing.extensionMime("noextfile")).toBe("application/octet-stream")
  })
  test("extensions for mime", () => {
    const exts = __testing.extensionsFor("image/jpeg")
    expect(exts).toContain("jpg")
    expect(exts).toContain("jpeg")
  })
  test("sniff PNG signature", () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
    expect(__testing.sniffMime(png)).toBe("image/png")
  })
  test("sniff PDF signature", () => {
    const pdf = Buffer.from("%PDF-1.4\n", "ascii")
    expect(__testing.sniffMime(pdf)).toBe("application/pdf")
  })
  test("sniff zip signature", () => {
    const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0])
    expect(__testing.sniffMime(zip)).toBe("application/zip")
  })
  test("sniff returns null on unknown", () => {
    const buf = Buffer.from("hello world", "utf8")
    expect(__testing.sniffMime(buf)).toBeNull()
  })
  test("isBinary distinguishes text from binary", () => {
    expect(__testing.isBinary(Buffer.from("hello world\n", "utf8"))).toBe(false)
    expect(__testing.isBinary(Buffer.from([0x00, 0x01, 0x02, 0x03]))).toBe(true)
  })
})

describe("tool.mime tool", () => {
  it.live("from_extension", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const ti = yield* MimeTool
        const tool = yield* ti.init()
        const r = yield* tool.execute({ action: "from_extension", value: "test.png" }, baseCtx)
        expect(r.output).toBe("image/png")
      }),
    ),
  )
  it.live("from_bytes detects PNG", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const ti = yield* MimeTool
        const tool = yield* ti.init()
        const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]).toString("base64")
        const r = yield* tool.execute({ action: "from_bytes", value: png }, baseCtx)
        expect(r.output).toBe("image/png")
      }),
    ),
  )
  it.live("extensions_for", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const ti = yield* MimeTool
        const tool = yield* ti.init()
        const r = yield* tool.execute({ action: "extensions_for", mime: "image/png" }, baseCtx)
        expect(r.output).toContain("png")
      }),
    ),
  )
})
