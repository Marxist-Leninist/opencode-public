import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Agent } from "../../src/agent/agent"
import { MessageID, SessionID } from "../../src/session/schema"
import { Tool } from "../../src/tool"
import { OtpTool, __testing } from "../../src/tool/otp"
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

// RFC 4226 §5.4 — test vectors with secret "12345678901234567890" (ASCII).
const HOTP_SECRET_ASCII = "12345678901234567890"
const HOTP_SECRET_B32 = __testing.encodeBase32(Buffer.from(HOTP_SECRET_ASCII, "utf8")) // GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ
const HOTP_VECTORS: Array<{ counter: number; expected: string }> = [
  { counter: 0, expected: "755224" },
  { counter: 1, expected: "287082" },
  { counter: 2, expected: "359152" },
  { counter: 3, expected: "969429" },
  { counter: 4, expected: "338314" },
  { counter: 5, expected: "254676" },
  { counter: 6, expected: "287922" },
  { counter: 7, expected: "162583" },
  { counter: 8, expected: "399871" },
  { counter: 9, expected: "520489" },
]

// RFC 6238 Appendix B — TOTP (SHA1) vectors with the same secret.
const TOTP_SECRET_B32 = HOTP_SECRET_B32
const TOTP_VECTORS_SHA1: Array<{ time: number; expected: string }> = [
  { time: 59, expected: "94287082" },
  { time: 1111111109, expected: "07081804" },
  { time: 1111111111, expected: "14050471" },
  { time: 1234567890, expected: "89005924" },
  { time: 2000000000, expected: "69279037" },
]

describe("tool.otp helpers", () => {
  test("base32 round-trip", () => {
    const data = Buffer.from("hello world!", "utf8")
    const enc = __testing.encodeBase32(data)
    const dec = __testing.decodeBase32(enc)
    expect(Buffer.compare(dec, data)).toBe(0)
  })

  test("base32 ignores whitespace and padding", () => {
    const a = __testing.decodeBase32("JBSWY3DP")
    const b = __testing.decodeBase32("JBSW Y3DP")
    const c = __testing.decodeBase32("JBSW-Y3DP")
    const d = __testing.decodeBase32("jbswy3dp")
    expect(a.equals(b)).toBe(true)
    expect(a.equals(c)).toBe(true)
    expect(a.equals(d)).toBe(true)
  })

  test("RFC 4226 HOTP vectors (SHA1, 6 digits)", () => {
    const secret = Buffer.from(HOTP_SECRET_ASCII, "utf8")
    for (const { counter, expected } of HOTP_VECTORS) {
      const got = __testing.hotp({ secret, counter, algorithm: "SHA1", digits: 6 })
      expect({ counter, got }).toEqual({ counter, got: expected })
    }
  })

  test("RFC 6238 TOTP vectors (SHA1, 8 digits, 30s)", () => {
    const secret = Buffer.from(HOTP_SECRET_ASCII, "utf8")
    for (const { time, expected } of TOTP_VECTORS_SHA1) {
      const ctr = __testing.totpCounter(time, 30)
      const got = __testing.hotp({ secret, counter: ctr, algorithm: "SHA1", digits: 8 })
      expect({ time, got }).toEqual({ time, got: expected })
    }
  })

  test("parse otpauth URI with issuer in label", () => {
    const uri = `otpauth://totp/Example:alice@example.com?secret=${HOTP_SECRET_B32}&issuer=Example&period=30&digits=6`
    const p = __testing.parseOtpAuth(uri)
    expect(p.type).toBe("totp")
    expect(p.issuer).toBe("Example")
    expect(p.account).toBe("alice@example.com")
    expect(p.secret).toBe(HOTP_SECRET_B32)
    expect(p.digits).toBe(6)
    expect(p.period_s).toBe(30)
  })

  test("parse otpauth URI with HOTP counter", () => {
    const uri = `otpauth://hotp/Acme:bob?secret=${HOTP_SECRET_B32}&counter=42`
    const p = __testing.parseOtpAuth(uri)
    expect(p.type).toBe("hotp")
    expect(p.counter).toBe(42)
  })

  test("parse otpauth URI validates numeric options", () => {
    expect(() => __testing.parseOtpAuth(`otpauth://totp/Acme:bob?secret=${HOTP_SECRET_B32}&digits=11`)).toThrow(
      "digits must be <= 10",
    )
    expect(() => __testing.parseOtpAuth(`otpauth://hotp/Acme:bob?secret=${HOTP_SECRET_B32}&counter=-1`)).toThrow(
      "counter must be an integer",
    )
  })

  test("make_uri then parse_uri round-trip", () => {
    const uri = __testing.makeOtpAuthUri({
      type: "totp",
      account: "alice@example.com",
      issuer: "Example",
      secret: HOTP_SECRET_B32,
      algorithm: "SHA256",
      digits: 8,
      period_s: 60,
    })
    const p = __testing.parseOtpAuth(uri)
    expect(p.account).toBe("alice@example.com")
    expect(p.issuer).toBe("Example")
    expect(p.secret).toBe(HOTP_SECRET_B32)
    expect(p.algorithm).toBe("SHA256")
    expect(p.digits).toBe(8)
    expect(p.period_s).toBe(60)
  })

  test("make_uri can build HOTP provisioning URI", () => {
    const uri = __testing.makeOtpAuthUri({
      type: "hotp",
      account: "bob@example.com",
      issuer: "Acme",
      secret: HOTP_SECRET_B32,
      counter: 42,
    })
    const p = __testing.parseOtpAuth(uri)
    expect(p.type).toBe("hotp")
    expect(p.account).toBe("bob@example.com")
    expect(p.issuer).toBe("Acme")
    expect(p.counter).toBe(42)
  })
})

describe("tool.otp tool", () => {
  it.live("totp matches RFC 6238 vector at fixed time", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const ti = yield* OtpTool
        const tool = yield* ti.init()
        const r = yield* tool.execute(
          {
            action: "totp",
            secret: HOTP_SECRET_B32,
            algorithm: "SHA1",
            digits: 8,
            period_s: 30,
            at_unix_s: 59,
          },
          baseCtx,
        )
        expect(r.metadata.code).toBe("94287082")
      }),
    ),
  )

  it.live("hotp matches RFC 4226 vector counter=3", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const ti = yield* OtpTool
        const tool = yield* ti.init()
        const r = yield* tool.execute(
          {
            action: "hotp",
            secret: HOTP_SECRET_B32,
            counter: 3,
            algorithm: "SHA1",
            digits: 6,
          },
          baseCtx,
        )
        expect(r.metadata.code).toBe("969429")
      }),
    ),
  )

  it.live("verify_totp accepts code within window", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const ti = yield* OtpTool
        const tool = yield* ti.init()
        // Code is for time=59 step=30, window 1 covers ±30s.
        const r = yield* tool.execute(
          {
            action: "verify_totp",
            secret: HOTP_SECRET_B32,
            code: "94287082",
            algorithm: "SHA1",
            digits: 8,
            period_s: 30,
            at_unix_s: 89,
            window: 1,
          },
          baseCtx,
        )
        expect(r.metadata.valid).toBe(true)
        expect(r.metadata.drift_steps).toBe(-1)
      }),
    ),
  )

  it.live("verify_totp rejects outside window", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const ti = yield* OtpTool
        const tool = yield* ti.init()
        const r = yield* tool.execute(
          {
            action: "verify_totp",
            secret: HOTP_SECRET_B32,
            code: "94287082",
            algorithm: "SHA1",
            digits: 8,
            period_s: 30,
            at_unix_s: 60_000,
            window: 1,
          },
          baseCtx,
        )
        expect(r.metadata.valid).toBe(false)
      }),
    ),
  )

  it.live("verify_hotp finds matching counter via look_ahead", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const ti = yield* OtpTool
        const tool = yield* ti.init()
        const r = yield* tool.execute(
          {
            action: "verify_hotp",
            secret: HOTP_SECRET_B32,
            code: "338314",
            counter: 0,
            look_ahead: 10,
          },
          baseCtx,
        )
        expect(r.metadata.valid).toBe(true)
        expect(r.metadata.matched_counter).toBe(4)
      }),
    ),
  )

  it.live("parse_uri then verify_totp using parsed secret", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const ti = yield* OtpTool
        const tool = yield* ti.init()
        const uri = `otpauth://totp/Example:alice?secret=${HOTP_SECRET_B32}&issuer=Example&digits=8&period=30`
        const parsed = yield* tool.execute({ action: "parse_uri", uri }, baseCtx)
        expect(parsed.metadata.type).toBe("totp")
        expect(parsed.metadata.secret).toBe(HOTP_SECRET_B32)
        const r = yield* tool.execute(
          {
            action: "totp",
            secret: parsed.metadata.secret!,
            algorithm: "SHA1",
            digits: parsed.metadata.digits!,
            period_s: parsed.metadata.period_s!,
            at_unix_s: 59,
          },
          baseCtx,
        )
        expect(r.metadata.code).toBe("94287082")
      }),
    ),
  )

  it.live("make_uri emits HOTP provisioning URI with counter", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const ti = yield* OtpTool
        const tool = yield* ti.init()
        const r = yield* tool.execute(
          {
            action: "make_uri",
            type: "hotp",
            secret: HOTP_SECRET_B32,
            issuer: "Acme",
            account: "bob@example.com",
            counter: 7,
          },
          baseCtx,
        )
        const parsed = __testing.parseOtpAuth(r.metadata.uri!)
        expect(parsed.type).toBe("hotp")
        expect(parsed.counter).toBe(7)
      }),
    ),
  )
})
