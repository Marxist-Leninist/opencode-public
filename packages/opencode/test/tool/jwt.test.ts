import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { generateKeyPairSync } from "node:crypto"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Agent } from "../../src/agent/agent"
import { MessageID, SessionID } from "../../src/session/schema"
import { Tool } from "../../src/tool"
import { JwtTool, __testing } from "../../src/tool/jwt"
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

describe("tool.jwt helpers", () => {
  test("base64url roundtrip", () => {
    const buf = Buffer.from([0xfb, 0xff, 0x00, 0x10, 0x20])
    const enc = __testing.b64urlEncode(buf)
    expect(enc).not.toContain("+")
    expect(enc).not.toContain("/")
    expect(enc).not.toContain("=")
    const dec = __testing.b64urlDecode(enc)
    expect(Buffer.compare(dec, buf)).toBe(0)
  })

  test("decodeSecret encodings", () => {
    expect(__testing.decodeSecret("hello", "utf8").toString("utf8")).toBe("hello")
    expect(__testing.decodeSecret("68656c6c6f", "hex").toString("utf8")).toBe("hello")
    expect(__testing.decodeSecret("aGVsbG8=", "base64").toString("utf8")).toBe("hello")
    expect(__testing.decodeSecret("aGVsbG8", "base64url").toString("utf8")).toBe("hello")
  })

  test("decodeToken splits header/payload/signature", () => {
    // JWT with HS256 and payload {"sub":"x"} but signature dummy.
    const header = __testing.b64urlEncode(Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" }), "utf8"))
    const payload = __testing.b64urlEncode(Buffer.from(JSON.stringify({ sub: "x" }), "utf8"))
    const token = `${header}.${payload}.AAAA`
    const d = __testing.decodeToken(token)
    expect(d.header.alg).toBe("HS256")
    expect((d.payload as Record<string, unknown>).sub).toBe("x")
    expect(d.signature).toBe("AAAA")
    expect(d.signing_input).toBe(`${header}.${payload}`)
  })

  test("decodeToken rejects malformed token", () => {
    expect(() => __testing.decodeToken("not.a.token.even")).toThrow()
    expect(() => __testing.decodeToken("only.two")).toThrow()
  })

  test("ECDSA jose<->DER roundtrip", () => {
    // Build a fake P-256 (R||S) signature with both ints having high bit set.
    const r = Buffer.alloc(32, 0xab)
    const s = Buffer.alloc(32, 0xcd)
    const jose = Buffer.concat([r, s])
    const der = __testing.joseToDer(jose, "ES256")
    const back = __testing.derToJose(der, "ES256")
    expect(Buffer.compare(back, jose)).toBe(0)
  })
})

describe("tool.jwt tool", () => {
  it.live("HS256 sign and verify roundtrip", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const ti = yield* JwtTool
        const tool = yield* ti.init()
        const signed = yield* tool.execute(
          {
            action: "sign",
            algorithm: "HS256",
            secret: "topsecret",
            payload: { user: "alice" },
            expires_in_s: 60,
          },
          baseCtx,
        )
        expect(typeof signed.metadata.token).toBe("string")
        const token = signed.metadata.token!
        const parts = token.split(".")
        expect(parts.length).toBe(3)

        const ok = yield* tool.execute(
          {
            action: "verify",
            token,
            algorithm: "HS256",
            secret: "topsecret",
          },
          baseCtx,
        )
        expect(ok.metadata.valid).toBe(true)
        expect((ok.metadata.payload as Record<string, unknown>)?.user).toBe("alice")
      }),
    ),
  )

  it.live("HS256 verify rejects tampered signature", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const ti = yield* JwtTool
        const tool = yield* ti.init()
        const signed = yield* tool.execute(
          {
            action: "sign",
            algorithm: "HS256",
            secret: "abc",
            payload: { x: 1 },
          },
          baseCtx,
        )
        const token = signed.metadata.token!
        // Flip a byte in payload section.
        const parts = token.split(".")
        const payloadDecoded = JSON.parse(__testing.b64urlDecode(parts[1]).toString("utf8"))
        payloadDecoded.x = 2
        const tamperedPayload = __testing.b64urlEncode(
          Buffer.from(JSON.stringify(payloadDecoded), "utf8"),
        )
        const tampered = `${parts[0]}.${tamperedPayload}.${parts[2]}`
        const r = yield* tool.execute(
          { action: "verify", token: tampered, algorithm: "HS256", secret: "abc" },
          baseCtx,
        )
        expect(r.metadata.valid).toBe(false)
      }),
    ),
  )

  it.live("HS256 expired token rejected", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const ti = yield* JwtTool
        const tool = yield* ti.init()
        const past = Math.floor(Date.now() / 1000) - 600
        const signed = yield* tool.execute(
          {
            action: "sign",
            algorithm: "HS256",
            secret: "k",
            payload: { iat: past, exp: past + 60 },
          },
          baseCtx,
        )
        const r = yield* tool.execute(
          { action: "verify", token: signed.metadata.token!, algorithm: "HS256", secret: "k" },
          baseCtx,
        )
        expect(r.metadata.valid).toBe(false)
        expect(r.metadata.reason).toBe("expired")
      }),
    ),
  )

  it.live("decode does not require secret", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const ti = yield* JwtTool
        const tool = yield* ti.init()
        const signed = yield* tool.execute(
          { action: "sign", algorithm: "HS256", secret: "s", payload: { foo: "bar" } },
          baseCtx,
        )
        const decoded = yield* tool.execute(
          { action: "decode", token: signed.metadata.token! },
          baseCtx,
        )
        expect(decoded.metadata.algorithm).toBe("HS256")
        expect((decoded.metadata.payload as Record<string, unknown>)?.foo).toBe("bar")
        expect(typeof decoded.metadata.signature_b64url).toBe("string")
      }),
    ),
  )

  it.live("RS256 sign and verify with generated keypair", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const ti = yield* JwtTool
        const tool = yield* ti.init()
        const { publicKey, privateKey } = generateKeyPairSync("rsa", {
          modulusLength: 2048,
          publicKeyEncoding: { type: "spki", format: "pem" },
          privateKeyEncoding: { type: "pkcs8", format: "pem" },
        })
        const signed = yield* tool.execute(
          {
            action: "sign",
            algorithm: "RS256",
            private_key: privateKey,
            payload: { sub: "rsa" },
          },
          baseCtx,
        )
        const r = yield* tool.execute(
          {
            action: "verify",
            token: signed.metadata.token!,
            algorithm: "RS256",
            public_key: publicKey,
          },
          baseCtx,
        )
        expect(r.metadata.valid).toBe(true)
      }),
    ),
  )

  it.live("ES256 sign and verify with generated keypair", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const ti = yield* JwtTool
        const tool = yield* ti.init()
        const { publicKey, privateKey } = generateKeyPairSync("ec", {
          namedCurve: "prime256v1",
          publicKeyEncoding: { type: "spki", format: "pem" },
          privateKeyEncoding: { type: "pkcs8", format: "pem" },
        })
        const signed = yield* tool.execute(
          {
            action: "sign",
            algorithm: "ES256",
            private_key: privateKey,
            payload: { sub: "ec" },
          },
          baseCtx,
        )
        const r = yield* tool.execute(
          {
            action: "verify",
            token: signed.metadata.token!,
            algorithm: "ES256",
            public_key: publicKey,
          },
          baseCtx,
        )
        expect(r.metadata.valid).toBe(true)
      }),
    ),
  )

  it.live("verify_claims required match", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const ti = yield* JwtTool
        const tool = yield* ti.init()
        const signed = yield* tool.execute(
          {
            action: "sign",
            algorithm: "HS256",
            secret: "s",
            payload: { iss: "a", aud: "b" },
          },
          baseCtx,
        )
        const ok = yield* tool.execute(
          {
            action: "verify",
            token: signed.metadata.token!,
            algorithm: "HS256",
            secret: "s",
            verify_claims: { iss: "a", aud: "b" },
          },
          baseCtx,
        )
        expect(ok.metadata.valid).toBe(true)
        const bad = yield* tool.execute(
          {
            action: "verify",
            token: signed.metadata.token!,
            algorithm: "HS256",
            secret: "s",
            verify_claims: { iss: "wrong" },
          },
          baseCtx,
        )
        expect(bad.metadata.valid).toBe(false)
      }),
    ),
  )
})
