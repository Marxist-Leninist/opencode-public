import { Effect, Schema } from "effect"
import DESCRIPTION from "./primes.txt"
import * as Tool from "./tool"

const ACTIONS = [
  "is_prime",
  "next_prime",
  "prev_prime",
  "factorize",
  "n_primes",
  "nth_prime",
  "primes_between",
  "gcd",
  "lcm",
  "divisors",
  "totient",
  "coprime",
] as const

const NumOrStr = Schema.Union([Schema.Number, Schema.String])

export const Parameters = Schema.Struct({
  action: Schema.Literals(ACTIONS).annotate({ description: ACTIONS.join(" | ") }),
  value: Schema.optional(NumOrStr).annotate({
    description:
      "Non-negative integer or numeric string (for values > 2^53). Required for is_prime/next_prime/prev_prime/factorize/nth_prime/divisors/totient.",
  }),
  n: Schema.optional(Schema.Number).annotate({
    description: "Count for n_primes (cap 10000) or rank for nth_prime (cap 100000).",
  }),
  a: Schema.optional(NumOrStr).annotate({ description: "Range start (inclusive) for primes_between." }),
  b: Schema.optional(NumOrStr).annotate({ description: "Range end (inclusive) for primes_between." }),
  values: Schema.optional(Schema.Array(NumOrStr)).annotate({
    description: "Two or more values for gcd/lcm/coprime.",
  }),
  other: Schema.optional(NumOrStr).annotate({
    description: "Convenience second value for binary gcd/lcm.",
  }),
})

type Params = Schema.Schema.Type<typeof Parameters>
type Action = (typeof ACTIONS)[number]

type Metadata = {
  action: Action
  ok?: boolean
  result?: string | string[]
  factors?: Array<{ prime: string; exponent: number }>
  composite_factor?: string
  count?: number
  primes?: string[]
  divisors?: string[]
  values?: string[]
}

const done = (result: Tool.ExecuteResult<Metadata>) => result

// ---------- big int helpers ----------

function toBig(v: number | string | bigint): bigint {
  if (typeof v === "bigint") return v
  if (typeof v === "number") {
    if (!Number.isInteger(v)) throw new Error(`primes: expected integer, got ${v}`)
    return BigInt(v)
  }
  // string
  const t = v.trim()
  if (!/^-?\d+$/.test(t)) throw new Error(`primes: not a valid integer string '${v}'`)
  return BigInt(t)
}

function bigAbs(n: bigint): bigint {
  return n < 0n ? -n : n
}

function bigGcd(a: bigint, b: bigint): bigint {
  a = bigAbs(a)
  b = bigAbs(b)
  while (b !== 0n) {
    const t = b
    b = a % b
    a = t
  }
  return a
}

function bigLcm(a: bigint, b: bigint): bigint {
  if (a === 0n || b === 0n) return 0n
  return bigAbs(a / bigGcd(a, b)) * bigAbs(b)
}

// Modular exponentiation for BigInt: (b^e) mod m
function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  if (mod === 1n) return 0n
  let result = 1n
  base = ((base % mod) + mod) % mod
  while (exp > 0n) {
    if ((exp & 1n) === 1n) result = (result * base) % mod
    exp >>= 1n
    base = (base * base) % mod
  }
  return result
}

// Deterministic Miller-Rabin for n < 3,317,044,064,679,887,385,961,981.
// Witness set per Sorenson & Webster 2015. Sufficient for any 64-bit and 80-bit value.
const MR_WITNESSES = [2n, 3n, 5n, 7n, 11n, 13n, 17n, 19n, 23n, 29n, 31n, 37n]

export function isPrime(n: bigint): boolean {
  if (n < 2n) return false
  if (n < 4n) return true
  if ((n & 1n) === 0n) return false
  // Quick small-prime trial division.
  for (const sp of [3n, 5n, 7n, 11n, 13n, 17n, 19n, 23n, 29n, 31n, 37n]) {
    if (n === sp) return true
    if (n % sp === 0n) return false
  }
  // Miller-Rabin
  let d = n - 1n
  let s = 0n
  while ((d & 1n) === 0n) {
    d >>= 1n
    s += 1n
  }
  witness: for (const a of MR_WITNESSES) {
    if (a % n === 0n) continue
    let x = modPow(a, d, n)
    if (x === 1n || x === n - 1n) continue witness
    for (let r = 0n; r < s - 1n; r++) {
      x = (x * x) % n
      if (x === n - 1n) continue witness
    }
    return false
  }
  return true
}

export function nextPrime(n: bigint): bigint {
  if (n < 2n) return 2n
  let c = n + 1n
  if (c === 2n) return 2n
  if ((c & 1n) === 0n) c += 1n
  while (!isPrime(c)) c += 2n
  return c
}

export function prevPrime(n: bigint): bigint {
  if (n <= 2n) throw new Error("primes.prev_prime: no prime < 2")
  if (n === 3n) return 2n
  let c = n - 1n
  if ((c & 1n) === 0n) c -= 1n
  while (c > 1n && !isPrime(c)) c -= 2n
  if (c <= 1n) throw new Error("primes.prev_prime: nothing below n is prime")
  return c
}

// Pollard's rho for big factors.
function pollardRho(n: bigint): bigint {
  if (n % 2n === 0n) return 2n
  while (true) {
    let x = 2n + (BigInt(Math.floor(Math.random() * 1_000_000)) % (n - 2n))
    let y = x
    const c = 1n + (BigInt(Math.floor(Math.random() * 1_000_000)) % (n - 1n))
    let d = 1n
    while (d === 1n) {
      x = (x * x + c) % n
      y = (y * y + c) % n
      y = (y * y + c) % n
      d = bigGcd(x > y ? x - y : y - x, n)
    }
    if (d !== n) return d
  }
}

export function factorize(n: bigint): Array<{ prime: bigint; exponent: number }> {
  if (n < 2n) throw new Error("primes.factorize: requires n >= 2")
  const out: Array<{ prime: bigint; exponent: number }> = []
  // Trial-divide small primes up to 1e6 sieve range. We pick 1e5 for speed.
  let m = n
  for (const p of [2n, 3n, 5n, 7n, 11n, 13n, 17n, 19n, 23n, 29n, 31n, 37n, 41n, 43n, 47n]) {
    if (m % p === 0n) {
      let e = 0
      while (m % p === 0n) {
        m /= p
        e++
      }
      out.push({ prime: p, exponent: e })
    }
  }
  // Continue with odd trial up to ~1e6
  let d = 49n
  const trialLimit = 1_000_000n
  while (d <= trialLimit && d * d <= m) {
    if (m % d === 0n) {
      let e = 0
      while (m % d === 0n) {
        m /= d
        e++
      }
      out.push({ prime: d, exponent: e })
    }
    d += 2n
  }
  if (m === 1n) {
    // done
  } else if (isPrime(m)) {
    out.push({ prime: m, exponent: 1 })
  } else {
    // Pollard's rho to split, recurse.
    const stack = [m]
    while (stack.length) {
      const cur = stack.pop()!
      if (cur === 1n) continue
      if (isPrime(cur)) {
        // Merge into out
        const existing = out.find((f) => f.prime === cur)
        if (existing) existing.exponent += 1
        else out.push({ prime: cur, exponent: 1 })
        continue
      }
      const f = pollardRho(cur)
      stack.push(f, cur / f)
    }
    out.sort((a, b) => (a.prime < b.prime ? -1 : a.prime > b.prime ? 1 : 0))
    // Merge again in case rho produced duplicates separately
    const merged: Array<{ prime: bigint; exponent: number }> = []
    for (const f of out) {
      const tail = merged[merged.length - 1]
      if (tail && tail.prime === f.prime) tail.exponent += f.exponent
      else merged.push({ ...f })
    }
    return merged
  }
  return out
}

export function nPrimes(count: number): bigint[] {
  if (count < 0 || !Number.isInteger(count)) throw new Error("primes.n_primes: count must be a non-negative integer")
  if (count > 10000) throw new Error("primes.n_primes: count cap is 10000")
  if (count === 0) return []
  // Upper bound for nth prime (Rosser): n*(ln n + ln ln n) for n >= 6.
  let upper: number
  if (count < 6) upper = 12
  else upper = Math.ceil(count * (Math.log(count) + Math.log(Math.log(count))) + 10)
  const sieve = new Uint8Array(upper + 1)
  for (let i = 2; i * i <= upper; i++) {
    if (!sieve[i]) {
      for (let j = i * i; j <= upper; j += i) sieve[j] = 1
    }
  }
  const out: bigint[] = []
  for (let i = 2; i <= upper && out.length < count; i++) {
    if (!sieve[i]) out.push(BigInt(i))
  }
  return out
}

export function nthPrime(n: number): bigint {
  if (n < 1 || !Number.isInteger(n)) throw new Error("primes.nth_prime: n must be a positive integer")
  if (n > 100000) throw new Error("primes.nth_prime: cap is 100000")
  const list = nPrimes(n)
  return list[n - 1]
}

export function primesBetween(a: bigint, b: bigint): bigint[] {
  if (a > b) [a, b] = [b, a]
  if (a < 2n) a = 2n
  const span = b - a
  if (span > 10_000_000n) throw new Error("primes.primes_between: span cap is 10^7")
  // Segmented sieve.
  const lo = a
  const hi = b
  const sqrtHi = bigSqrt(hi) + 1n
  const smallSieveLimit = Number(sqrtHi)
  const small = new Uint8Array(smallSieveLimit + 1)
  for (let i = 2; i * i <= smallSieveLimit; i++) {
    if (!small[i]) {
      for (let j = i * i; j <= smallSieveLimit; j += i) small[j] = 1
    }
  }
  const smallPrimes: number[] = []
  for (let i = 2; i <= smallSieveLimit; i++) if (!small[i]) smallPrimes.push(i)
  const size = Number(hi - lo + 1n)
  const seg = new Uint8Array(size)
  for (const p of smallPrimes) {
    const pBig = BigInt(p)
    let start = ((lo + pBig - 1n) / pBig) * pBig
    if (start === pBig) start = pBig * pBig // skip the prime itself if in range
    if (start < pBig * pBig) start = pBig * pBig
    if (start < lo) start += pBig
    for (let k = start; k <= hi; k += pBig) {
      seg[Number(k - lo)] = 1
    }
  }
  const out: bigint[] = []
  for (let i = 0; i < size; i++) {
    const v = lo + BigInt(i)
    if (v < 2n) continue
    if (!seg[i]) out.push(v)
    if (out.length >= 100000) break
  }
  return out
}

function bigSqrt(n: bigint): bigint {
  if (n < 0n) throw new Error("bigSqrt: negative")
  if (n < 2n) return n
  let x = n
  let y = (x + 1n) >> 1n
  while (y < x) {
    x = y
    y = (x + n / x) >> 1n
  }
  return x
}

export function totient(n: bigint): bigint {
  if (n < 1n) throw new Error("primes.totient: n must be >= 1")
  if (n === 1n) return 1n
  const factors = factorize(n)
  let result = n
  for (const f of factors) {
    result = (result / f.prime) * (f.prime - 1n)
  }
  return result
}

export function divisors(n: bigint): bigint[] {
  if (n < 1n) throw new Error("primes.divisors: n must be >= 1")
  if (n > 10n ** 14n) throw new Error("primes.divisors: cap is 10^14")
  const out: bigint[] = []
  for (let i = 1n; i * i <= n; i++) {
    if (n % i === 0n) {
      out.push(i)
      if (i !== n / i) out.push(n / i)
    }
  }
  out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  return out
}

export const PrimesTool = Tool.define(
  "primes",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Params, _ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const action = params.action
          const collectValues = (): bigint[] => {
            const arr: bigint[] = []
            if (params.values) for (const v of params.values) arr.push(toBig(v))
            if (params.value !== undefined) arr.unshift(toBig(params.value))
            if (params.other !== undefined) arr.push(toBig(params.other))
  // Dedupe while preserving order; gcd/lcm don't need dedupe but keep behavior simple.
            return arr
          }

          if (action === "is_prime") {
            if (params.value === undefined) throw new Error("primes.is_prime: 'value' is required")
            const n = toBig(params.value)
            const ok = isPrime(n)
            const meta: Metadata = { action, ok }
            if (!ok && n >= 2n) {
              // Find a small witness factor.
              for (const p of [2n, 3n, 5n, 7n, 11n, 13n, 17n, 19n, 23n, 29n]) {
                if (n !== p && n % p === 0n) {
                  meta.composite_factor = p.toString()
                  break
                }
              }
            }
            return done({
              title: `primes.is_prime ${n}: ${ok}`,
              metadata: meta,
              output: String(ok),
            })
          }

          if (action === "next_prime") {
            if (params.value === undefined) throw new Error("primes.next_prime: 'value' is required")
            const r = nextPrime(toBig(params.value))
            return done({
              title: `primes.next_prime: ${r}`,
              metadata: { action, result: r.toString() },
              output: r.toString(),
            })
          }

          if (action === "prev_prime") {
            if (params.value === undefined) throw new Error("primes.prev_prime: 'value' is required")
            const r = prevPrime(toBig(params.value))
            return done({
              title: `primes.prev_prime: ${r}`,
              metadata: { action, result: r.toString() },
              output: r.toString(),
            })
          }

          if (action === "factorize") {
            if (params.value === undefined) throw new Error("primes.factorize: 'value' is required")
            const n = toBig(params.value)
            const factors = factorize(n)
            const out = factors.map((f) => (f.exponent === 1 ? f.prime.toString() : `${f.prime}^${f.exponent}`)).join(" ")
            return done({
              title: `primes.factorize ${n}`,
              metadata: {
                action,
                factors: factors.map((f) => ({ prime: f.prime.toString(), exponent: f.exponent })),
              },
              output: out,
            })
          }

          if (action === "n_primes") {
            if (params.n === undefined) throw new Error("primes.n_primes: 'n' is required")
            const list = nPrimes(params.n)
            return done({
              title: `primes.n_primes ${params.n}`,
              metadata: { action, count: list.length, primes: list.map((p) => p.toString()) },
              output: list.map((p) => p.toString()).join(" "),
            })
          }

          if (action === "nth_prime") {
            if (params.n === undefined) throw new Error("primes.nth_prime: 'n' is required")
            const r = nthPrime(params.n)
            return done({
              title: `primes.nth_prime ${params.n}: ${r}`,
              metadata: { action, result: r.toString() },
              output: r.toString(),
            })
          }

          if (action === "primes_between") {
            if (params.a === undefined || params.b === undefined)
              throw new Error("primes.primes_between: 'a' and 'b' are required")
            const list = primesBetween(toBig(params.a), toBig(params.b))
            return done({
              title: `primes.primes_between ${params.a}-${params.b}`,
              metadata: { action, count: list.length, primes: list.map((p) => p.toString()) },
              output: list.map((p) => p.toString()).join(" "),
            })
          }

          if (action === "gcd") {
            const arr = collectValues()
            if (arr.length < 2) throw new Error("primes.gcd: provide at least 2 values")
            let g = bigAbs(arr[0])
            for (let i = 1; i < arr.length; i++) g = bigGcd(g, arr[i])
            return done({
              title: `primes.gcd: ${g}`,
              metadata: { action, result: g.toString(), values: arr.map((v) => v.toString()) },
              output: g.toString(),
            })
          }

          if (action === "lcm") {
            const arr = collectValues()
            if (arr.length < 2) throw new Error("primes.lcm: provide at least 2 values")
            let l = bigAbs(arr[0])
            for (let i = 1; i < arr.length; i++) l = bigLcm(l, arr[i])
            return done({
              title: `primes.lcm: ${l}`,
              metadata: { action, result: l.toString(), values: arr.map((v) => v.toString()) },
              output: l.toString(),
            })
          }

          if (action === "divisors") {
            if (params.value === undefined) throw new Error("primes.divisors: 'value' is required")
            const list = divisors(toBig(params.value))
            return done({
              title: `primes.divisors ${params.value}`,
              metadata: { action, count: list.length, divisors: list.map((d) => d.toString()) },
              output: list.map((d) => d.toString()).join(" "),
            })
          }

          if (action === "totient") {
            if (params.value === undefined) throw new Error("primes.totient: 'value' is required")
            const r = totient(toBig(params.value))
            return done({
              title: `primes.totient: ${r}`,
              metadata: { action, result: r.toString() },
              output: r.toString(),
            })
          }

          if (action === "coprime") {
            const arr = collectValues()
            if (arr.length < 2) throw new Error("primes.coprime: provide at least 2 values")
            let ok = true
            outer: for (let i = 0; i < arr.length; i++) {
              for (let j = i + 1; j < arr.length; j++) {
                if (bigGcd(arr[i], arr[j]) !== 1n) {
                  ok = false
                  break outer
                }
              }
            }
            return done({
              title: `primes.coprime: ${ok}`,
              metadata: { action, ok, values: arr.map((v) => v.toString()) },
              output: String(ok),
            })
          }

          throw new Error(`primes: unknown action ${action satisfies never}`)
        }),
    }
  }),
)

export const __testing = {
  isPrime,
  nextPrime,
  prevPrime,
  factorize,
  nPrimes,
  nthPrime,
  primesBetween,
  totient,
  divisors,
  bigGcd,
  bigLcm,
  toBig,
}
