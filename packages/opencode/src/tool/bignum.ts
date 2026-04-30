import { Effect, Schema } from "effect"
import { randomBytes } from "node:crypto"
import DESCRIPTION from "./bignum.txt"
import * as Tool from "./tool"

const ACTIONS = [
  "add",
  "sub",
  "mul",
  "div",
  "mod",
  "pow",
  "gcd",
  "lcm",
  "modpow",
  "modinv",
  "factorial",
  "isprime",
  "nextprime",
  "prevprime",
  "factor",
  "gcd_ext",
  "bitlen",
  "to_base",
  "from_base",
] as const

const MAX_OPERAND_LEN = 8192
const MAX_POW_EXP = 1024
const MAX_FACTORIAL_N = 5000
const FACTOR_TIME_BUDGET_MS = 10_000
const POLLARD_RHO_MAX_ITERS = 5_000

export const Parameters = Schema.Struct({
  action: Schema.Literals(ACTIONS).annotate({ description: ACTIONS.join(" | ") }),
  a: Schema.optional(Schema.String.check(Schema.isMaxLength(MAX_OPERAND_LEN))).annotate({
    description: "First operand. Decimal, 0x hex, 0o octal, 0b binary. Negative with leading '-'.",
  }),
  b: Schema.optional(Schema.String.check(Schema.isMaxLength(MAX_OPERAND_LEN))).annotate({
    description: "Second operand for binary ops, gcd_ext, modpow exponent.",
  }),
  m: Schema.optional(Schema.String.check(Schema.isMaxLength(MAX_OPERAND_LEN))).annotate({
    description: "Modulus for modpow / modinv. Must be > 0.",
  }),
  n: Schema.optional(
    Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(MAX_FACTORIAL_N)),
  ).annotate({
    description: `Non-negative integer 0..${MAX_FACTORIAL_N}. Used by factorial.`,
  }),
  base: Schema.optional(
    Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(2), Schema.isLessThanOrEqualTo(36)),
  ).annotate({
    description: "Base 2..36 for to_base / from_base.",
  }),
})

type Params = Schema.Schema.Type<typeof Parameters>
type Action = (typeof ACTIONS)[number]

type Metadata = {
  action: Action
  result?: string
  result_bits?: number
  base?: number
  factors?: Array<{ p: string; e: number }>
  prime?: boolean
  witnesses?: string[]
  iters?: number
  partial?: boolean
  x?: string
  y?: string
  g?: string
}

const done = (result: Tool.ExecuteResult<Metadata>) => result

// ---------- helpers ----------

function parseBig(s: string | undefined, name: string): bigint {
  if (s === undefined) throw new Error(`bignum: missing operand '${name}'`)
  const trimmed = s.trim()
  if (!trimmed) throw new Error(`bignum: empty operand '${name}'`)
  let neg = false
  let body = trimmed
  if (body.startsWith("-")) {
    neg = true
    body = body.slice(1)
  } else if (body.startsWith("+")) {
    body = body.slice(1)
  }
  if (!body.length) throw new Error(`bignum: '${name}' has no digits after sign`)
  let v: bigint
  try {
    if (body.startsWith("0x") || body.startsWith("0X")) v = BigInt(body)
    else if (body.startsWith("0o") || body.startsWith("0O")) v = BigInt(body)
    else if (body.startsWith("0b") || body.startsWith("0B")) v = BigInt(body)
    else v = BigInt(body)
  } catch (err: any) {
    throw new Error(`bignum: '${name}' not parseable as integer: ${err?.message ?? err}`)
  }
  return neg ? -v : v
}

function abs(x: bigint): bigint {
  return x < 0n ? -x : x
}

function gcd(a: bigint, b: bigint): bigint {
  let x = abs(a)
  let y = abs(b)
  while (y) {
    const t = y
    y = x % y
    x = t
  }
  return x
}

function lcm(a: bigint, b: bigint): bigint {
  if (a === 0n || b === 0n) return 0n
  return abs(a / gcd(a, b) * b)
}

// Returns [g, x, y] such that a*x + b*y = g.
function gcdExt(a: bigint, b: bigint): { g: bigint; x: bigint; y: bigint } {
  if (b === 0n) return { g: a, x: 1n, y: 0n }
  const r = gcdExt(b, a % b)
  return { g: r.g, x: r.y, y: r.x - (a / b) * r.y }
}

function modpow(base: bigint, exp: bigint, mod: bigint): bigint {
  if (mod <= 0n) throw new Error("bignum: modpow requires modulus > 0")
  if (mod === 1n) return 0n
  let result = 1n
  let b = ((base % mod) + mod) % mod
  let e = exp
  if (e < 0n) {
    // a^-e mod m = (a^-1)^e mod m
    const inv = modinv(b, mod)
    b = inv
    e = -e
  }
  while (e > 0n) {
    if (e & 1n) result = (result * b) % mod
    e >>= 1n
    b = (b * b) % mod
  }
  return result
}

function modinv(a: bigint, m: bigint): bigint {
  if (m <= 0n) throw new Error("bignum: modinv requires modulus > 0")
  const aa = ((a % m) + m) % m
  const { g, x } = gcdExt(aa, m)
  if (g !== 1n) throw new Error(`bignum: modinv undefined - gcd(a, m) = ${g.toString()}`)
  return ((x % m) + m) % m
}

function factorial(n: number): bigint {
  if (n < 0) throw new Error("bignum: factorial of negative undefined")
  // Split-pair multiplication is faster than naive linear, but n<=5000 is fine linearly.
  let acc = 1n
  for (let i = 2; i <= n; i++) acc *= BigInt(i)
  return acc
}

function bitlen(a: bigint): number {
  let v = abs(a)
  if (v === 0n) return 0
  let n = 0
  while (v > 0n) {
    n++
    v >>= 1n
  }
  return n
}

// Witnesses for a Miller-Rabin test that is deterministic up to 3,317,044,064,679,887,385,961,981.
// Source: https://en.wikipedia.org/wiki/Miller%E2%80%93Rabin_primality_test#Testing_against_small_sets_of_bases
const DET_WITNESSES = [2n, 3n, 5n, 7n, 11n, 13n, 17n, 19n, 23n, 29n, 31n, 37n]
const DET_LIMIT = 3_317_044_064_679_887_385_961_981n

function millerRabinRound(n: bigint, d: bigint, r: number, a: bigint): boolean {
  let x = modpow(a, d, n)
  if (x === 1n || x === n - 1n) return true
  for (let i = 0; i < r - 1; i++) {
    x = (x * x) % n
    if (x === n - 1n) return true
  }
  return false
}

function isProbablePrime(n: bigint, witnesses: bigint[]): boolean {
  if (n < 2n) return false
  if (n < 4n) return true
  if ((n & 1n) === 0n) return false
  let d = n - 1n
  let r = 0
  while ((d & 1n) === 0n) {
    d >>= 1n
    r++
  }
  for (const a of witnesses) {
    if (a % n === 0n) continue
    if (!millerRabinRound(n, d, r, a)) return false
  }
  return true
}

function randomBig(min: bigint, max: bigint): bigint {
  // Returns r in [min, max] inclusive. max > min, both nonneg.
  const range = max - min + 1n
  const bits = bitlen(range - 1n)
  const bytes = Math.ceil(bits / 8)
  while (true) {
    const buf = randomBytes(bytes)
    let v = 0n
    for (const byte of buf) v = (v << 8n) | BigInt(byte)
    // Mask off the high bits we don't need.
    const extra = bytes * 8 - bits
    if (extra > 0) v >>= BigInt(extra)
    if (v < range) return min + v
  }
}

function isprime(n: bigint): { prime: boolean; witnesses: string[] } {
  if (n < 2n) return { prime: false, witnesses: [] }
  if (n < DET_LIMIT) {
    return { prime: isProbablePrime(n, DET_WITNESSES), witnesses: DET_WITNESSES.map((w) => w.toString()) }
  }
  const ws: bigint[] = []
  for (let i = 0; i < 32; i++) ws.push(randomBig(2n, n - 2n))
  return { prime: isProbablePrime(n, ws), witnesses: ws.map((w) => w.toString()) }
}

function pollardRho(n: bigint, deadline: number): bigint | undefined {
  if (n % 2n === 0n) return 2n
  let iters = 0
  while (iters < POLLARD_RHO_MAX_ITERS && Date.now() < deadline) {
    const c = randomBig(1n, n - 1n)
    let x = randomBig(2n, n - 1n)
    let y = x
    let d = 1n
    while (d === 1n) {
      iters++
      x = (x * x + c) % n
      y = (y * y + c) % n
      y = (y * y + c) % n
      d = gcd(abs(x - y), n)
      if (Date.now() >= deadline || iters >= POLLARD_RHO_MAX_ITERS) return undefined
    }
    if (d !== n) return d
  }
  return undefined
}

const SMALL_PRIMES: bigint[] = (() => {
  const sieve = new Uint8Array(10_000)
  for (let i = 2; i < 10_000; i++) {
    if (sieve[i]) continue
    for (let j = i * i; j < 10_000; j += i) sieve[j] = 1
  }
  const out: bigint[] = []
  for (let i = 2; i < 10_000; i++) if (!sieve[i]) out.push(BigInt(i))
  return out
})()

function factor(nIn: bigint): { factors: Array<{ p: bigint; e: number }>; partial: boolean; iters: number } {
  if (nIn < 2n) return { factors: [], partial: false, iters: 0 }
  const start = Date.now()
  const deadline = start + FACTOR_TIME_BUDGET_MS
  const factors: Map<string, number> = new Map()
  const add = (p: bigint, e = 1) => {
    const k = p.toString()
    factors.set(k, (factors.get(k) ?? 0) + e)
  }

  let n = nIn
  for (const p of SMALL_PRIMES) {
    if (p * p > n) break
    while (n % p === 0n) {
      add(p)
      n /= p
    }
  }

  let iters = 0
  const stack: bigint[] = []
  if (n > 1n) stack.push(n)
  let partial = false
  while (stack.length) {
    if (Date.now() >= deadline) {
      partial = true
      // record the remainder verbatim as a "composite" factor
      for (const r of stack) add(r)
      break
    }
    const m = stack.pop()!
    if (m === 1n) continue
    const { prime } = isprime(m)
    if (prime) {
      add(m)
      continue
    }
    const d = pollardRho(m, deadline)
    iters++
    if (!d || d === m) {
      // give up on this factor
      partial = true
      add(m)
      continue
    }
    stack.push(d)
    stack.push(m / d)
  }

  const sorted = [...factors.entries()]
    .map(([p, e]) => ({ p: BigInt(p), e }))
    .sort((a, b) => (a.p < b.p ? -1 : a.p > b.p ? 1 : 0))
  return { factors: sorted, partial, iters }
}

function nextprime(a: bigint): bigint {
  if (a < 2n) return 2n
  let n = a + 1n
  if ((n & 1n) === 0n) n += 1n
  while (!isprime(n).prime) n += 2n
  return n
}

function prevprime(a: bigint): bigint {
  if (a <= 2n) throw new Error("bignum: no prime less than 2")
  if (a === 3n) return 2n
  let n = a - 1n
  if (n === 2n) return 2n
  if ((n & 1n) === 0n) n -= 1n
  while (n > 2n && !isprime(n).prime) n -= 2n
  return n
}

function toBase(a: bigint, base: number): string {
  if (base < 2 || base > 36) throw new Error("bignum: base must be 2..36")
  return a.toString(base)
}

function fromBase(s: string, base: number): bigint {
  if (base < 2 || base > 36) throw new Error("bignum: base must be 2..36")
  let neg = false
  let body = s.trim()
  if (body.startsWith("-")) {
    neg = true
    body = body.slice(1)
  } else if (body.startsWith("+")) {
    body = body.slice(1)
  }
  if (!body) throw new Error("bignum: empty input")
  if (!new RegExp(`^[0-9a-z]+$`, "i").test(body)) throw new Error(`bignum: invalid characters for base ${base}`)
  let v = 0n
  const big = BigInt(base)
  for (const ch of body.toLowerCase()) {
    const d = ch >= "0" && ch <= "9" ? ch.charCodeAt(0) - 48 : ch.charCodeAt(0) - 87
    if (d < 0 || d >= base) throw new Error(`bignum: digit '${ch}' out of range for base ${base}`)
    v = v * big + BigInt(d)
  }
  return neg ? -v : v
}

// ---------- tool ----------

export const BignumTool = Tool.define(
  "bignum",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Params, _ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const action = params.action

          const meta = (extra: Partial<Metadata>): Metadata => ({ action, ...extra })
          const respond = (result: bigint, extra: Partial<Metadata> = {}) =>
            done({
              title: `bignum.${action}: ${result.toString().length > 32 ? result.toString().slice(0, 32) + "..." : result.toString()}`,
              metadata: meta({ result: result.toString(), result_bits: bitlen(result), ...extra }),
              output: result.toString(),
            })

          if (action === "add") return respond(parseBig(params.a, "a") + parseBig(params.b, "b"))
          if (action === "sub") return respond(parseBig(params.a, "a") - parseBig(params.b, "b"))
          if (action === "mul") return respond(parseBig(params.a, "a") * parseBig(params.b, "b"))
          if (action === "div") {
            const b = parseBig(params.b, "b")
            if (b === 0n) throw new Error("bignum: division by zero")
            return respond(parseBig(params.a, "a") / b)
          }
          if (action === "mod") {
            const b = parseBig(params.b, "b")
            if (b === 0n) throw new Error("bignum: mod by zero")
            return respond(parseBig(params.a, "a") % b)
          }
          if (action === "pow") {
            const e = parseBig(params.b, "b")
            if (e < 0n) throw new Error("bignum: pow exponent must be >= 0 (use modpow for negative)")
            if (e > BigInt(MAX_POW_EXP))
              throw new Error(`bignum: pow exponent must be <= ${MAX_POW_EXP} (use modpow for larger)`)
            return respond(parseBig(params.a, "a") ** e)
          }
          if (action === "gcd") return respond(gcd(parseBig(params.a, "a"), parseBig(params.b, "b")))
          if (action === "lcm") return respond(lcm(parseBig(params.a, "a"), parseBig(params.b, "b")))
          if (action === "modpow")
            return respond(modpow(parseBig(params.a, "a"), parseBig(params.b, "b"), parseBig(params.m, "m")))
          if (action === "modinv") return respond(modinv(parseBig(params.a, "a"), parseBig(params.m, "m")))
          if (action === "factorial") {
            const n = params.n ?? -1
            if (n < 0) throw new Error("bignum: factorial requires 'n' >= 0")
            return respond(factorial(n))
          }

          if (action === "isprime") {
            const a = parseBig(params.a, "a")
            const r = isprime(a)
            return done({
              title: `bignum.isprime: ${r.prime}`,
              metadata: meta({ prime: r.prime, witnesses: r.witnesses }),
              output: String(r.prime),
            })
          }
          if (action === "nextprime") return respond(nextprime(parseBig(params.a, "a")), { prime: true })
          if (action === "prevprime") return respond(prevprime(parseBig(params.a, "a")), { prime: true })

          if (action === "factor") {
            const a = parseBig(params.a, "a")
            if (a < 2n) {
              return done({
                title: `bignum.factor: trivial`,
                metadata: meta({ factors: [], partial: false, iters: 0 }),
                output: "(no prime factors)",
              })
            }
            const r = factor(a)
            const factors = r.factors.map((f) => ({ p: f.p.toString(), e: f.e }))
            const lines = factors.map((f) => (f.e === 1 ? f.p : `${f.p}^${f.e}`))
            return done({
              title: `bignum.factor: ${factors.length} factor${factors.length === 1 ? "" : "s"}${r.partial ? " (partial)" : ""}`,
              metadata: meta({ factors, partial: r.partial, iters: r.iters }),
              output: lines.join(" * ") + (r.partial ? "  (partial - Pollard rho budget exhausted)" : ""),
            })
          }

          if (action === "gcd_ext") {
            const a = parseBig(params.a, "a")
            const b = parseBig(params.b, "b")
            const r = gcdExt(a, b)
            return done({
              title: `bignum.gcd_ext: g=${r.g.toString()}`,
              metadata: meta({ g: r.g.toString(), x: r.x.toString(), y: r.y.toString(), result: r.g.toString() }),
              output: `g=${r.g.toString()}\nx=${r.x.toString()}\ny=${r.y.toString()}`,
            })
          }

          if (action === "bitlen") {
            const a = parseBig(params.a, "a")
            const n = bitlen(a)
            return done({
              title: `bignum.bitlen: ${n}`,
              metadata: meta({ result: String(n), result_bits: n }),
              output: String(n),
            })
          }

          if (action === "to_base") {
            const a = parseBig(params.a, "a")
            const base = params.base ?? 10
            const out = toBase(a, base)
            return done({
              title: `bignum.to_base ${base}: ${out.length > 32 ? out.slice(0, 32) + "..." : out}`,
              metadata: meta({ result: out, base }),
              output: out,
            })
          }

          if (action === "from_base") {
            const s = params.a
            if (s === undefined) throw new Error("bignum: from_base requires 'a'")
            const base = params.base ?? 10
            const v = fromBase(s, base)
            return respond(v, { base })
          }

          throw new Error(`bignum: unknown action ${action satisfies never}`)
        }),
    }
  }),
)

export const __testing = {
  parseBig,
  gcd,
  lcm,
  gcdExt,
  modpow,
  modinv,
  factorial,
  bitlen,
  isprime,
  nextprime,
  prevprime,
  factor,
  toBase,
  fromBase,
  randomBig,
}
