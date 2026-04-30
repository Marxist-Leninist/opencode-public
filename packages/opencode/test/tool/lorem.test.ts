import { describe, expect, test } from "bun:test"
import { __testing } from "../../src/tool/lorem"

const {
  generateWords,
  generateSentence,
  generateSentences,
  generateParagraphs,
  generateBytes,
  generateSlug,
  generateTitle,
  mulberry32,
  CANONICAL_OPENING,
} = __testing

describe("tool.lorem deterministic", () => {
  test("seed gives reproducible output", () => {
    const a = generateWords(20, mulberry32(42))
    const b = generateWords(20, mulberry32(42))
    expect(a).toEqual(b)
  })

  test("different seeds give different output (high probability)", () => {
    const a = generateWords(20, mulberry32(1))
    const b = generateWords(20, mulberry32(2))
    expect(a).not.toEqual(b)
  })
})

describe("tool.lorem words", () => {
  test("count is exact", () => {
    expect(generateWords(0, mulberry32(1))).toEqual([])
    expect(generateWords(7, mulberry32(1)).length).toBe(7)
    expect(generateWords(2000, mulberry32(1)).length).toBe(2000)
  })
  test("cap enforced", () => {
    expect(() => generateWords(2001, mulberry32(1))).toThrow(/cap is 2000/)
    expect(() => generateWords(-1, mulberry32(1))).toThrow()
    expect(() => generateWords(1.5, mulberry32(1))).toThrow()
  })
  test("words are ASCII lowercase from vocab", () => {
    const w = generateWords(50, mulberry32(7))
    for (const x of w) expect(/^[a-z]+$/.test(x)).toBe(true)
  })
})

describe("tool.lorem sentences", () => {
  test("first sentence is canonical when requested", () => {
    const arr = generateSentences(3, mulberry32(1), { minW: 4, maxW: 12, canonical: true })
    expect(arr[0]).toBe(CANONICAL_OPENING)
    expect(arr.length).toBe(3)
    for (const s of arr) {
      expect(s.endsWith(".")).toBe(true)
      expect(s[0]).toBe(s[0].toUpperCase())
    }
  })
  test("canonical=false uses random first", () => {
    const arr = generateSentences(1, mulberry32(1), { minW: 4, maxW: 12, canonical: false })
    expect(arr[0]).not.toBe(CANONICAL_OPENING)
  })
  test("respects min/max words per sentence", () => {
    const arr = generateSentences(20, mulberry32(99), { minW: 3, maxW: 5, canonical: false })
    for (const s of arr) {
      const words = s.replace(/[.,]/g, "").trim().split(/\s+/)
      expect(words.length).toBeGreaterThanOrEqual(3)
      expect(words.length).toBeLessThanOrEqual(5)
    }
  })
})

describe("tool.lorem paragraphs/bytes/slug/title", () => {
  test("paragraphs separated by '\\n\\n'", () => {
    const out = generateParagraphs(3, mulberry32(1), {
      minW: 4,
      maxW: 8,
      minS: 2,
      maxS: 3,
      canonical: false,
      sep: "\n\n",
    })
    const parts = out.split(/\n\n/)
    expect(parts.length).toBe(3)
  })

  test("bytes target is upper bound", () => {
    const out = generateBytes(200, mulberry32(1))
    expect(out.length).toBeLessThanOrEqual(200)
    // It should be close to the target (within a single word's worth)
    expect(out.length).toBeGreaterThan(150)
  })

  test("slug uses hyphens, not spaces", () => {
    const s = generateSlug(5, mulberry32(1))
    expect(s.includes("-")).toBe(true)
    expect(s.includes(" ")).toBe(false)
    expect(s.split("-").length).toBe(5)
  })

  test("title capitalizes appropriately", () => {
    const t = generateTitle(5, mulberry32(1))
    const words = t.split(" ")
    expect(words.length).toBe(5)
    // First and last words must be capitalized.
    expect(words[0][0]).toBe(words[0][0].toUpperCase())
    expect(words[words.length - 1][0]).toBe(words[words.length - 1][0].toUpperCase())
  })
})

describe("tool.lorem caps", () => {
  test("paragraphs cap", () => {
    expect(() =>
      generateParagraphs(101, mulberry32(1), {
        minW: 4,
        maxW: 8,
        minS: 2,
        maxS: 3,
        canonical: false,
        sep: "\n\n",
      }),
    ).toThrow(/cap is 100/)
  })
  test("sentences cap", () => {
    expect(() => generateSentences(501, mulberry32(1), { minW: 4, maxW: 12, canonical: false })).toThrow(/cap is 500/)
  })
  test("bytes cap", () => {
    expect(() => generateBytes(200_001, mulberry32(1))).toThrow(/cap is 200000/)
  })
  test("slug cap", () => {
    expect(() => generateSlug(13, mulberry32(1))).toThrow(/cap is 12/)
  })
  test("title cap", () => {
    expect(() => generateTitle(13, mulberry32(1))).toThrow(/cap is 12/)
  })
})

describe("tool.lorem generateSentence", () => {
  test("respects bounds and ends with period", () => {
    const s = generateSentence(mulberry32(123), 4, 8)
    expect(s.endsWith(".")).toBe(true)
    const words = s.replace(/[.,]/g, "").trim().split(/\s+/)
    expect(words.length).toBeGreaterThanOrEqual(4)
    expect(words.length).toBeLessThanOrEqual(8)
  })
})
