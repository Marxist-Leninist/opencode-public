import { describe, expect, test } from "bun:test"
import { __testing } from "../../src/tool/stats"

const { parseValues, summary, quantile, histogram, correlation, zscore, normalize, top } = __testing

describe("tool.stats parseValues", () => {
  test("accepts values array", () => {
    const r = parseValues({ action: "summary", values: [1, 2, 3] } as any)
    expect(r.values).toEqual([1, 2, 3])
    expect(r.skipped).toBe(0)
  })
  test("accepts whitespace/comma/newline values_text and skips garbage", () => {
    const r = parseValues({ action: "summary", values_text: "1, 2 3\n4\nfoo 5" } as any)
    expect(r.values).toEqual([1, 2, 3, 4, 5])
    expect(r.skipped).toBe(1)
  })
  test("rejects passing both", () => {
    expect(() => parseValues({ action: "summary", values: [1], values_text: "1" } as any)).toThrow(/either/)
  })
  test("rejects passing neither", () => {
    expect(() => parseValues({ action: "summary" } as any)).toThrow(/provide/)
  })
})

describe("tool.stats summary", () => {
  test("constant series has zero variance", () => {
    const s = summary([5, 5, 5, 5])!
    expect(s.count).toBe(4)
    expect(s.mean).toBe(5)
    expect(s.variance).toBe(0)
    expect(s.stddev).toBe(0)
    expect(s.min).toBe(5)
    expect(s.max).toBe(5)
  })
  test("known sample stddev for [2,4,4,4,5,5,7,9]", () => {
    const s = summary([2, 4, 4, 4, 5, 5, 7, 9])!
    // The textbook population stddev is 2; sample is sqrt(32/7) ~ 2.138
    expect(s.mean).toBe(5)
    expect(s.stddev).toBeGreaterThan(2.13)
    expect(s.stddev).toBeLessThan(2.14)
  })
  test("median uses linear interpolation for even counts", () => {
    const s = summary([1, 2, 3, 4])!
    expect(s.median).toBe(2.5)
  })
  test("geometric_mean / harmonic_mean require all positive", () => {
    const s = summary([1, 2, 4])!
    expect(s.geometric_mean).toBeCloseTo(2, 5)
    expect(s.harmonic_mean).toBeCloseTo(12 / 7, 5)
    const s2 = summary([1, 0, 4])!
    expect(s2.geometric_mean).toBeNull()
    expect(s2.harmonic_mean).toBeNull()
  })
  test("returns null for empty", () => {
    expect(summary([])).toBeNull()
  })
  test("skewness null when n<3", () => {
    const s = summary([1, 2])!
    expect(s.skewness).toBeNull()
    expect(s.kurtosis_excess).toBeNull()
  })
})

describe("tool.stats quantile", () => {
  test("0/0.5/1 give min/median/max", () => {
    const sorted = [1, 2, 3, 4, 5]
    expect(quantile(sorted, 0)).toBe(1)
    expect(quantile(sorted, 0.5)).toBe(3)
    expect(quantile(sorted, 1)).toBe(5)
  })
  test("interpolates between values", () => {
    expect(quantile([0, 100], 0.5)).toBe(50)
  })
})

describe("tool.stats histogram", () => {
  test("equal-width bins span [min,max]", () => {
    const h = histogram([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 5)
    expect(h.bins.length).toBe(5)
    expect(h.bins[0].lower).toBe(0)
    expect(h.bins[h.bins.length - 1].upper).toBe(9)
    const total = h.bins.reduce((s, b) => s + b.count, 0)
    expect(total).toBe(10)
  })
  test("constant input puts everything in bin 0", () => {
    const h = histogram([3, 3, 3], 4)
    expect(h.bins[0].count).toBe(3)
    expect(h.bins.slice(1).every((b) => b.count === 0)).toBe(true)
  })
})

describe("tool.stats correlation", () => {
  test("perfect positive linear", () => {
    expect(correlation([1, 2, 3], [2, 4, 6])).toBeCloseTo(1, 6)
  })
  test("perfect negative linear", () => {
    expect(correlation([1, 2, 3], [6, 4, 2])).toBeCloseTo(-1, 6)
  })
  test("uncorrelated constant -> null", () => {
    expect(correlation([1, 2, 3], [5, 5, 5])).toBeNull()
  })
  test("length mismatch throws", () => {
    expect(() => correlation([1, 2], [1])).toThrow(/length/)
  })
})

describe("tool.stats zscore + normalize + top", () => {
  test("zscore mean ~ 0", () => {
    const z = zscore([1, 2, 3, 4, 5])
    const meanZ = z.reduce((s, x) => s + x, 0) / z.length
    expect(Math.abs(meanZ)).toBeLessThan(1e-10)
  })
  test("normalize maps to [0,1]", () => {
    const n = normalize([10, 20, 30])
    expect(n[0]).toBe(0)
    expect(n[2]).toBe(1)
    expect(n[1]).toBe(0.5)
  })
  test("normalize on constant returns zeros", () => {
    expect(normalize([5, 5, 5])).toEqual([0, 0, 0])
  })
  test("top descending by default", () => {
    expect(top([3, 1, 4, 1, 5, 9, 2, 6], 3, false)).toEqual([9, 6, 5])
  })
  test("top bottom=true ascending", () => {
    expect(top([3, 1, 4, 1, 5, 9, 2, 6], 3, true)).toEqual([1, 1, 2])
  })
})
