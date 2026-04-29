import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Agent } from "../../src/agent/agent"
import { MessageID, SessionID } from "../../src/session/schema"
import { Tool } from "../../src/tool"
import { EncodeTool, __testing } from "../../src/tool/encode"
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

describe("tool.encode helpers", () => {
  test("base64url round-trips", () => {
    const raw = Buffer.from("hello world?\n")
    const enc = __testing.base64UrlEncode(raw)
    expect(enc).not.toContain("=")
    expect(enc).not.toContain("/")
    expect(enc).not.toContain("+")
    const dec = __testing.base64UrlDecode(enc)
    expect(dec.equals(raw)).toBe(true)
  })

  test("decodeJwt parses header and payload", () => {
    // Header: {"alg":"HS256","typ":"JWT"}
    // Payload: {"sub":"alice","iat":1700000000}
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9." +
      "eyJzdWIiOiJhbGljZSIsImlhdCI6MTcwMDAwMDAwMH0." +
      "abc123sig"
    const parts = __testing.decodeJwt(jwt)
    expect(parts.header).toEqual({ alg: "HS256", typ: "JWT" })
    expect(parts.payload).toEqual({ sub: "alice", iat: 1700000000 })
    expect(parts.signature).toBe("abc123sig")
  })

  test("decodeJwt rejects malformed input", () => {
    expect(() => __testing.decodeJwt("not.a.jwt")).toThrow()
    expect(() => __testing.decodeJwt("only.two")).toThrow()
  })

  test("encodeFormat hex is lowercase", () => {
    expect(__testing.encodeFormat(Buffer.from([0xde, 0xad, 0xbe, 0xef]), "hex")).toBe("deadbeef")
  })
})

describe("tool.encode tool", () => {
  it.live("encodes utf8 to base64", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* EncodeTool
        const tool = yield* toolInfo.init()
        const result = yield* tool.execute(
          { action: "encode", format: "base64", value: "hello" },
          baseCtx,
        )
        expect(result.metadata.result).toBe("aGVsbG8=")
        expect(result.metadata.input_bytes).toBe(5)
      }),
    ),
  )

  it.live("decodes base64 back to utf8", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* EncodeTool
        const tool = yield* toolInfo.init()
        const result = yield* tool.execute(
          { action: "decode", format: "base64", value: "aGVsbG8=" },
          baseCtx,
        )
        expect(result.metadata.result).toBe("hello")
        expect(result.metadata.output_bytes).toBe(5)
      }),
    ),
  )

  it.live("converts hex input to base64 output", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* EncodeTool
        const tool = yield* toolInfo.init()
        const result = yield* tool.execute(
          { action: "encode", format: "base64", value: "deadbeef", input_encoding: "hex" },
          baseCtx,
        )
        // 0xdeadbeef base64 → 3q2+7w==
        expect(result.metadata.result).toBe("3q2+7w==")
      }),
    ),
  )

  it.live("URL-encodes a value", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* EncodeTool
        const tool = yield* toolInfo.init()
        const result = yield* tool.execute(
          { action: "encode", format: "url", value: "a b&c=d" },
          baseCtx,
        )
        expect(result.metadata.result).toBe("a%20b%26c%3Dd")
      }),
    ),
  )

  it.live("decodes a JWT and returns parsed parts", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* EncodeTool
        const tool = yield* toolInfo.init()
        const jwt =
          "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9." +
          "eyJzdWIiOiJhbGljZSIsImlhdCI6MTcwMDAwMDAwMH0." +
          "abc123sig"
        const result = yield* tool.execute({ action: "decode", format: "jwt", value: jwt }, baseCtx)
        expect((result.metadata.jwt?.header as any)?.alg).toBe("HS256")
        expect((result.metadata.jwt?.payload as any)?.sub).toBe("alice")
        expect(result.metadata.jwt?.signature).toBe("abc123sig")
      }),
    ),
  )

  it.live("rejects encode with format=jwt", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* EncodeTool
        const tool = yield* toolInfo.init()
        const exit = yield* Effect.exit(
          tool.execute({ action: "encode", format: "jwt", value: "x" }, baseCtx),
        )
        expect(exit._tag).toBe("Failure")
      }),
    ),
  )
})
