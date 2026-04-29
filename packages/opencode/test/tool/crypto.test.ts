import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Agent } from "../../src/agent/agent"
import { MessageID, SessionID } from "../../src/session/schema"
import { Tool } from "../../src/tool"
import { CryptoTool, __testing } from "../../src/tool/crypto"
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

describe("tool.crypto helpers", () => {
  test("timingSafeStringEqual matches and mismatches", () => {
    expect(__testing.timingSafeStringEqual("abc", "abc")).toBe(true)
    expect(__testing.timingSafeStringEqual("abc", "abd")).toBe(false)
    expect(__testing.timingSafeStringEqual("abc", "abcd")).toBe(false)
  })
  test("detectAndDecodeDigest accepts hex/base64/base64url", () => {
    expect(__testing.detectAndDecodeDigest("deadbeef").toString("hex")).toBe("deadbeef")
    const b64 = Buffer.from("hello").toString("base64")
    expect(__testing.detectAndDecodeDigest(b64).toString("utf8")).toBe("hello")
    const b64url = Buffer.from([0xff, 0xfe]).toString("base64url")
    expect(__testing.detectAndDecodeDigest(b64url).toString("hex")).toBe("fffe")
  })
  test("KEY_SIZE and IV_SIZE are right", () => {
    expect(__testing.KEY_SIZE["aes-256-gcm"]).toBe(32)
    expect(__testing.KEY_SIZE["aes-128-gcm"]).toBe(16)
    expect(__testing.IV_SIZE["aes-256-gcm"]).toBe(12)
    expect(__testing.IV_SIZE["aes-256-cbc"]).toBe(16)
  })
})

describe("tool.crypto tool", () => {
  it.live("HMAC-SHA256 produces a known digest", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* CryptoTool
        const tool = yield* toolInfo.init()
        const result = yield* tool.execute(
          {
            action: "hmac",
            value: "The quick brown fox jumps over the lazy dog",
            key: "key",
            hmac_algo: "sha256",
          },
          baseCtx,
        )
        expect(result.metadata.digest).toBe(
          "f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8",
        )
      }),
    ),
  )

  it.live("HMAC verifies expected match in constant time", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* CryptoTool
        const tool = yield* toolInfo.init()
        const result = yield* tool.execute(
          {
            action: "hmac",
            value: "abc",
            key: "secret",
            hmac_algo: "sha256",
            expected: "9946dad4e00e913fc8be8e5d3f7e110a4a9e832f83fb09c345285d78638d8a0e",
          },
          baseCtx,
        )
        expect(result.metadata.matches).toBe(true)
      }),
    ),
  )

  it.live("HMAC verifies expected mismatch", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* CryptoTool
        const tool = yield* toolInfo.init()
        const result = yield* tool.execute(
          {
            action: "hmac",
            value: "abc",
            key: "secret",
            hmac_algo: "sha256",
            expected: "deadbeef",
          },
          baseCtx,
        )
        expect(result.metadata.matches).toBe(false)
      }),
    ),
  )

  it.live("AES-256-GCM encrypts and decrypts round-trip", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* CryptoTool
        const tool = yield* toolInfo.init()
        const keyResult = yield* tool.execute(
          { action: "gen_key", cipher: "aes-256-gcm", output_encoding: "base64" },
          baseCtx,
        )
        const key = keyResult.metadata.key as string
        const enc = yield* tool.execute(
          {
            action: "encrypt",
            value: "secret payload",
            key,
            key_encoding: "base64",
            cipher: "aes-256-gcm",
            output_encoding: "base64",
          },
          baseCtx,
        )
        expect(enc.metadata.ciphertext).toBeDefined()
        expect(enc.metadata.iv).toBeDefined()
        expect(enc.metadata.tag).toBeDefined()
        const dec = yield* tool.execute(
          {
            action: "decrypt",
            value: enc.metadata.ciphertext as string,
            value_encoding: "base64",
            key,
            key_encoding: "base64",
            cipher: "aes-256-gcm",
            iv: enc.metadata.iv as string,
            tag: enc.metadata.tag as string,
          },
          baseCtx,
        )
        expect(dec.metadata.plaintext).toBe("secret payload")
      }),
    ),
  )

  it.live("AES-128-CBC encrypts and decrypts", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* CryptoTool
        const tool = yield* toolInfo.init()
        const keyResult = yield* tool.execute(
          { action: "gen_key", cipher: "aes-128-cbc", output_encoding: "hex" },
          baseCtx,
        )
        const key = keyResult.metadata.key as string
        const enc = yield* tool.execute(
          {
            action: "encrypt",
            value: "hello cbc",
            key,
            key_encoding: "hex",
            cipher: "aes-128-cbc",
            output_encoding: "hex",
          },
          baseCtx,
        )
        const dec = yield* tool.execute(
          {
            action: "decrypt",
            value: enc.metadata.ciphertext as string,
            value_encoding: "hex",
            key,
            key_encoding: "hex",
            cipher: "aes-128-cbc",
            iv: enc.metadata.iv as string,
          },
          baseCtx,
        )
        expect(dec.metadata.plaintext).toBe("hello cbc")
      }),
    ),
  )

  it.live("equal action timing-safe match/mismatch", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* CryptoTool
        const tool = yield* toolInfo.init()
        const same = yield* tool.execute({ action: "equal", value: "abc", value2: "abc" }, baseCtx)
        expect(same.metadata.matches).toBe(true)
        const diff = yield* tool.execute({ action: "equal", value: "abc", value2: "abd" }, baseCtx)
        expect(diff.metadata.matches).toBe(false)
      }),
    ),
  )

  it.live("gen_key returns the right number of bytes", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* CryptoTool
        const tool = yield* toolInfo.init()
        const k = yield* tool.execute({ action: "gen_key", length: 16, output_encoding: "hex" }, baseCtx)
        expect((k.metadata.key as string).length).toBe(32)
        expect(k.metadata.bytes).toBe(16)
      }),
    ),
  )

  it.live("AES-GCM tag tampering fails decrypt", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* CryptoTool
        const tool = yield* toolInfo.init()
        const keyResult = yield* tool.execute(
          { action: "gen_key", cipher: "aes-256-gcm", output_encoding: "hex" },
          baseCtx,
        )
        const key = keyResult.metadata.key as string
        const enc = yield* tool.execute(
          {
            action: "encrypt",
            value: "secret",
            key,
            key_encoding: "hex",
            cipher: "aes-256-gcm",
            output_encoding: "hex",
          },
          baseCtx,
        )
        const tag = enc.metadata.tag as string
        // Flip a bit in the tag.
        const tampered = (parseInt(tag.slice(0, 2), 16) ^ 0xff).toString(16).padStart(2, "0") + tag.slice(2)
        const exit = yield* Effect.exit(
          tool.execute(
            {
              action: "decrypt",
              value: enc.metadata.ciphertext as string,
              value_encoding: "hex",
              key,
              key_encoding: "hex",
              cipher: "aes-256-gcm",
              iv: enc.metadata.iv as string,
              tag: tampered,
            },
            baseCtx,
          ),
        )
        expect(exit._tag).toBe("Failure")
      }),
    ),
  )
})
