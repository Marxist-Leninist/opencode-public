import { describe, expect, test } from "bun:test"
import { __testing } from "../../src/tool/primes"

const { isPrime, nextPrime, prevPrime, factorize, nPrimes, nthPrime, primesBetween, totient, divisors, bigGcd, bigLcm } =
  __testing

describe("tool.primes is_prime", () => {
  test("small known primes", () => {
    for (const p of [2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 97, 101, 8191]) {
      expect(isPrime(BigInt(p))).toBe(true)
    }
  })
  test("small composites", () => {
    for (const c of [0, 1, 4, 6, 8, 9, 10, 15, 21, 25, 27, 49, 100, 121, 1000, 8192]) {
      expect(isPrime(BigInt(c))).toBe(false)
    }
  })
  test("Mersenne and Carmichael", () => {
    expect(isPrime(2n ** 61n - 1n)).toBe(true) // Mersenne prime
    expect(isPrime(561n)).toBe(false) // 561 = 3*11*17 (Carmichael)
    expect(isPrime(41041n)).toBe(false) // 7*11*13*41 (Carmichael)
    expect(isPrime(2n ** 32n - 5n)).toBe(true) // 4294967291 prime
    expect(isPrime(2n ** 64n - 59n)).toBe(true) // common 64-bit prime
  })
})

describe("tool.primes neighbours", () => {
  test("next_prime", () => {
    expect(nextPrime(0n)).toBe(2n)
    expect(nextPrime(1n)).toBe(2n)
    expect(nextPrime(2n)).toBe(3n)
    expect(nextPrime(10n)).toBe(11n)
    expect(nextPrime(100n)).toBe(101n)
    expect(nextPrime(7919n)).toBe(7927n) // 1000th and 1001st primes
  })
  test("prev_prime", () => {
    expect(prevPrime(3n)).toBe(2n)
    expect(prevPrime(11n)).toBe(7n)
    expect(prevPrime(100n)).toBe(97n)
    expect(() => prevPrime(2n)).toThrow()
    expect(() => prevPrime(1n)).toThrow()
  })
})

describe("tool.primes factorize", () => {
  test("small numbers", () => {
    expect(factorize(2n)).toEqual([{ prime: 2n, exponent: 1 }])
    expect(factorize(12n)).toEqual([
      { prime: 2n, exponent: 2 },
      { prime: 3n, exponent: 1 },
    ])
    expect(factorize(360n)).toEqual([
      { prime: 2n, exponent: 3 },
      { prime: 3n, exponent: 2 },
      { prime: 5n, exponent: 1 },
    ])
    expect(factorize(1000000n)).toEqual([
      { prime: 2n, exponent: 6 },
      { prime: 5n, exponent: 6 },
    ])
  })
  test("primes factor as themselves", () => {
    expect(factorize(7919n)).toEqual([{ prime: 7919n, exponent: 1 }])
  })
  test("medium semiprimes via Pollard", () => {
    // 4294967311 = nextPrime(2^32). Use product of 2 medium primes.
    // 1000003 * 1000033 = 1000036000099
    const f = factorize(1000003n * 1000033n)
    expect(f).toEqual([
      { prime: 1000003n, exponent: 1 },
      { prime: 1000033n, exponent: 1 },
    ])
  })
})

describe("tool.primes generation", () => {
  test("n_primes first 10", () => {
    expect(nPrimes(10).map((b) => Number(b))).toEqual([2, 3, 5, 7, 11, 13, 17, 19, 23, 29])
  })
  test("nth_prime 100, 1000", () => {
    expect(nthPrime(100)).toBe(541n)
    expect(nthPrime(1000)).toBe(7919n)
  })
  test("primes_between segmented sieve", () => {
    const list = primesBetween(100n, 200n).map((b) => Number(b))
    expect(list).toEqual([
      101, 103, 107, 109, 113, 127, 131, 137, 139, 149, 151, 157, 163, 167, 173, 179, 181, 191, 193, 197, 199,
    ])
  })
  test("primes_between large segment edge", () => {
    const list = primesBetween(999900n, 1000000n).map((b) => Number(b))
    expect(list).toContain(999983)
    expect(list).toContain(999979)
  })
})

describe("tool.primes gcd/lcm/totient/divisors", () => {
  test("gcd", () => {
    expect(bigGcd(12n, 18n)).toBe(6n)
    expect(bigGcd(7n, 13n)).toBe(1n)
    expect(bigGcd(0n, 5n)).toBe(5n)
  })
  test("lcm", () => {
    expect(bigLcm(4n, 6n)).toBe(12n)
    expect(bigLcm(5n, 7n)).toBe(35n)
    expect(bigLcm(0n, 5n)).toBe(0n)
  })
  test("totient", () => {
    expect(totient(1n)).toBe(1n)
    expect(totient(9n)).toBe(6n)
    expect(totient(10n)).toBe(4n)
    expect(totient(36n)).toBe(12n)
  })
  test("divisors", () => {
    expect(divisors(1n).map((d) => Number(d))).toEqual([1])
    expect(divisors(12n).map((d) => Number(d))).toEqual([1, 2, 3, 4, 6, 12])
    expect(divisors(36n).map((d) => Number(d))).toEqual([1, 2, 3, 4, 6, 9, 12, 18, 36])
  })
})
