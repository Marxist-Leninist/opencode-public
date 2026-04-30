import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Agent } from "../../src/agent/agent"
import { MessageID, SessionID } from "../../src/session/schema"
import { Tool } from "../../src/tool"
import { KdfTool, __testing } from "../../src/tool/kdf"
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

describe("tool.kdf helpers", () => {
  test("isPow2 boundary cases", () => {
    expect(__testing.isPow2(1024)).toBe(true)
    expect(__testing.isPow2(1)).toBe(true)
    expect(__testing.isPow2(3)).toBe(false)
    expect(__testing.isPow2(0)).toBe(false)
    expect(__testing.isPow2(1023)).toBe(false)
  })

  test("decodeSalt auto: hex vs utf8", () => {
    const a = __testing.decodeSalt("deadbeef", "auto")
    expect(a.toString("hex")).toBe("deadbeef")
    const b = __testing.decodeSalt("salt", "auto") // not hex
    expect(b.toString("utf8")).toBe("salt")
  })

  test("PBKDF2 sha256 known vector", async () => {
    // RFC 6070 vector: P="password" S="salt" c=1 dkLen=20 ->
    // 0c60c80f961f0e71f3a9b524af6012062fe037a6
    const out = await __testing.derivePbkdf2(
      Buffer.from("password"),
      Buffer.from("salt"),
      1,
      20,
      "sha1",
    )
    expect(out.toString("hex")).toBe("0c60c80f961f0e71f3a9b524af6012062fe037a6")
  })

  test("encode/parse PBKDF2 PHC string round-trip", () => {
    const salt = Buffer.from("0123456789abcdef", "utf8")
    const key = Buffer.from("0102030405060708090a0b0c0d0e0f10", "hex")
    const phc = __testing.encodeHashPbkdf2("sha256", 100000, salt, key)
    expect(phc.startsWith("pbkdf2-sha256$i=100000,k=16$")).toBe(true)
    const parsed = __testing.parseHashString(phc)
    expect(parsed.algo).toBe("pbkdf2")
    if (parsed.algo === "pbkdf2") {
      expect(parsed.iterations).toBe(100000)
      expect(parsed.digest).toBe("sha256")
      expect(parsed.salt.equals(salt)).toBe(true)
      expect(parsed.key.equals(key)).toBe(true)
    }
  })
})

describe("tool.kdf tool", () => {
  it.live("derive pbkdf2 deterministic", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const ti = yield* KdfTool
        const tool = yield* ti.init()
        const a = yield* tool.execute(
          {
            action: "derive",
            algo: "pbkdf2",
            password: "hunter2",
            salt: "deadbeef",
            salt_encoding: "hex",
            iterations: 1000,
            digest: "sha256",
            key_length: 32,
          },
          baseCtx,
        )
        const b = yield* tool.execute(
          {
            action: "derive",
            algo: "pbkdf2",
            password: "hunter2",
            salt: "deadbeef",
            salt_encoding: "hex",
            iterations: 1000,
            digest: "sha256",
            key_length: 32,
          },
          baseCtx,
        )
        expect(a.output).toBe(b.output)
        expect(a.output.length).toBe(64) // 32 bytes hex
      }),
    ),
  )

  it.live("hash + verify pbkdf2 round-trip", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const ti = yield* KdfTool
        const tool = yield* ti.init()
        const h = yield* tool.execute(
          {
            action: "hash",
            algo: "pbkdf2",
            password: "correct horse battery staple",
            iterations: 1000,
            digest: "sha256",
            key_length: 32,
          },
          baseCtx,
        )
        expect(h.output.startsWith("pbkdf2-sha256$i=1000,k=32$")).toBe(true)
        const ok = yield* tool.execute(
          {
            action: "verify",
            password: "correct horse battery staple",
            hash: h.output,
          },
          baseCtx,
        )
        expect(ok.metadata.match).toBe(true)
        const bad = yield* tool.execute(
          {
            action: "verify",
            password: "wrong",
            hash: h.output,
          },
          baseCtx,
        )
        expect(bad.metadata.match).toBe(false)
      }),
    ),
  )

  it.live("hash + verify scrypt round-trip", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const ti = yield* KdfTool
        const tool = yield* ti.init()
        const h = yield* tool.execute(
          {
            action: "hash",
            algo: "scrypt",
            password: "trousersnake",
            N: 1024,
            r: 8,
            p: 1,
            key_length: 32,
          },
          baseCtx,
        )
        expect(h.output.startsWith("scrypt$N=1024,r=8,p=1,k=32$")).toBe(true)
        const ok = yield* tool.execute(
          {
            action: "verify",
            password: "trousersnake",
            hash: h.output,
          },
          baseCtx,
        )
        expect(ok.metadata.match).toBe(true)
      }),
    ),
  )
})
