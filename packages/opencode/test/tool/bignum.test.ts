import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Agent } from "../../src/agent/agent"
import { MessageID, SessionID } from "../../src/session/schema"
import { Tool } from "../../src/tool"
import { BignumTool, __testing } from "../../src/tool/bignum"
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

describe("tool.bignum helpers", () => {
  test("parseBig accepts decimal, hex, octal, binary, signed", () => {
    expect(__testing.parseBig("42", "a")).toBe(42n)
    expect(__testing.parseBig("-7", "a")).toBe(-7n)
    expect(__testing.parseBig("0xff", "a")).toBe(255n)
    expect(__testing.parseBig("0o17", "a")).toBe(15n)
    expect(__testing.parseBig("0b1010", "a")).toBe(10n)
    expect(() => __testing.parseBig("abc", "a")).toThrow()
    expect(() => __testing.parseBig("", "a")).toThrow()
  })

  test("gcd / lcm basics", () => {
    expect(__testing.gcd(48n, 18n)).toBe(6n)
    expect(__testing.gcd(0n, 7n)).toBe(7n)
    expect(__testing.gcd(-12n, 8n)).toBe(4n)
    expect(__testing.lcm(4n, 6n)).toBe(12n)
    expect(__testing.lcm(0n, 5n)).toBe(0n)
  })

  test("gcdExt satisfies a*x + b*y = g", () => {
    const cases = [
      [240n, 46n],
      [123456789n, 987654321n],
      [-15n, 25n],
    ] as const
    for (const [a, b] of cases) {
      const r = __testing.gcdExt(a, b)
      expect(a * r.x + b * r.y).toBe(r.g)
    }
  })

  test("modpow matches naive when small", () => {
    // 7^11 mod 13 = ?  7^11 = 1977326743. 1977326743 % 13 = 2.
    expect(__testing.modpow(7n, 11n, 13n)).toBe(2n)
    // identity: a^0 mod m = 1
    expect(__testing.modpow(123n, 0n, 7n)).toBe(1n)
    // mod 1 always 0
    expect(__testing.modpow(5n, 100n, 1n)).toBe(0n)
    // RSA-style large exponent
    expect(__testing.modpow(2n, 1000n, 1009n)).toBeGreaterThanOrEqual(0n)
  })

  test("modinv produces a true inverse", () => {
    const a = 17n
    const m = 1000000007n
    const inv = __testing.modinv(a, m)
    expect((a * inv) % m).toBe(1n)
    expect(() => __testing.modinv(6n, 9n)).toThrow() // gcd(6,9)=3
  })

  test("factorial small cases", () => {
    expect(__testing.factorial(0)).toBe(1n)
    expect(__testing.factorial(1)).toBe(1n)
    expect(__testing.factorial(5)).toBe(120n)
    expect(__testing.factorial(10)).toBe(3628800n)
    // 20! is a known constant
    expect(__testing.factorial(20)).toBe(2432902008176640000n)
  })

  test("bitlen", () => {
    expect(__testing.bitlen(0n)).toBe(0)
    expect(__testing.bitlen(1n)).toBe(1)
    expect(__testing.bitlen(255n)).toBe(8)
    expect(__testing.bitlen(256n)).toBe(9)
    expect(__testing.bitlen(-1024n)).toBe(11)
  })

  test("isprime: small cases and known primes", () => {
    expect(__testing.isprime(2n).prime).toBe(true)
    expect(__testing.isprime(3n).prime).toBe(true)
    expect(__testing.isprime(4n).prime).toBe(false)
    expect(__testing.isprime(1n).prime).toBe(false)
    expect(__testing.isprime(-7n).prime).toBe(false)
    // Mersenne prime 2^61 - 1
    expect(__testing.isprime(2305843009213693951n).prime).toBe(true)
    // Carmichael number 561 = 3 * 11 * 17 - must NOT be reported prime
    expect(__testing.isprime(561n).prime).toBe(false)
    // 1729 = 7 * 13 * 19 (Carmichael)
    expect(__testing.isprime(1729n).prime).toBe(false)
  })

  test("nextprime / prevprime", () => {
    expect(__testing.nextprime(13n)).toBe(17n)
    expect(__testing.nextprime(0n)).toBe(2n)
    expect(__testing.nextprime(2n)).toBe(3n)
    expect(__testing.prevprime(17n)).toBe(13n)
    expect(__testing.prevprime(3n)).toBe(2n)
    expect(() => __testing.prevprime(2n)).toThrow()
  })

  test("factor: small composites", () => {
    const f1 = __testing.factor(60n)
    expect(f1.factors).toEqual([
      { p: 2n, e: 2 },
      { p: 3n, e: 1 },
      { p: 5n, e: 1 },
    ])
    const f2 = __testing.factor(600851475143n)
    // 600851475143 = 71 * 839 * 1471 * 6857
    const ps = f2.factors.map((f) => f.p)
    expect(ps).toContain(71n)
    expect(ps).toContain(839n)
    expect(ps).toContain(1471n)
    expect(ps).toContain(6857n)
    // multiplications match
    let prod = 1n
    for (const f of f2.factors) {
      let p = f.p
      for (let i = 0; i < f.e; i++) prod *= p
    }
    expect(prod).toBe(600851475143n)
  })

  test("toBase / fromBase round trip", () => {
    const n = 1234567890n
    expect(__testing.toBase(n, 16)).toBe("499602d2")
    expect(__testing.fromBase("499602d2", 16)).toBe(n)
    expect(__testing.fromBase("-499602d2", 16)).toBe(-n)
    expect(__testing.toBase(255n, 2)).toBe("11111111")
    expect(__testing.fromBase("11111111", 2)).toBe(255n)
  })

  test("toBase rejects out-of-range bases", () => {
    expect(() => __testing.toBase(1n, 1)).toThrow()
    expect(() => __testing.toBase(1n, 37)).toThrow()
    expect(() => __testing.fromBase("z", 35)).toThrow() // z=35 not in base 35
  })
})

describe("tool.bignum tool", () => {
  it.live("modpow result available in metadata", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* BignumTool
        const tool = yield* toolInfo.init()
        const r = yield* tool.execute({ action: "modpow", a: "7", b: "11", m: "13" }, baseCtx)
        expect(r.metadata.result).toBe("2")
      }),
    ),
  )

  it.live("factor produces factors metadata", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* BignumTool
        const tool = yield* toolInfo.init()
        const r = yield* tool.execute({ action: "factor", a: "60" }, baseCtx)
        expect(r.metadata.factors).toEqual([
          { p: "2", e: 2 },
          { p: "3", e: 1 },
          { p: "5", e: 1 },
        ])
      }),
    ),
  )

  it.live("isprime returns boolean", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* BignumTool
        const tool = yield* toolInfo.init()
        const r = yield* tool.execute({ action: "isprime", a: "97" }, baseCtx)
        expect(r.metadata.prime).toBe(true)
      }),
    ),
  )

  it.live("from_base/to_base via tool", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* BignumTool
        const tool = yield* toolInfo.init()
        const r = yield* tool.execute({ action: "to_base", a: "255", base: 16 }, baseCtx)
        expect(r.metadata.result).toBe("ff")
        const back = yield* tool.execute({ action: "from_base", a: "ff", base: 16 }, baseCtx)
        expect(back.metadata.result).toBe("255")
      }),
    ),
  )
})
