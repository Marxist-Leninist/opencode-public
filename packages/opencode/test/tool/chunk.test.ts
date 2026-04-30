import { describe, expect, test } from "bun:test"
import { __testing } from "../../src/tool/chunk"

const { chunkChars, chunkLines, chunkWords, chunkTokens, chunkParagraphs, chunkBytes, countAll, estimateTokens } = __testing

describe("tool.chunk chars", () => {
  test("exact split with no overlap", () => {
    const out = chunkChars("abcdefghij", 4, 0, false, 100)
    expect(out.length).toBe(3)
    expect(out.map((c) => c.text)).toEqual(["abcd", "efgh", "ij"])
    expect(out[0].start).toBe(0)
    expect(out[0].end).toBe(4)
    expect(out[2].length).toBe(2)
  })
  test("overlap repeats characters", () => {
    const out = chunkChars("abcdefghij", 4, 2, false, 100)
    expect(out[0].text).toBe("abcd")
    expect(out[1].text).toBe("cdef")
    expect(out[2].text).toBe("efgh")
  })
  test("overlap >= size throws", () => {
    expect(() => chunkChars("abcdef", 4, 4, false, 100)).toThrow(/overlap/)
  })
  test("limit caps chunks", () => {
    const out = chunkChars("a".repeat(100), 10, 0, false, 3)
    expect(out.length).toBe(3)
  })
  test("trim removes whitespace per chunk", () => {
    // 8 chars / size=4 -> ["  ab", "cd  "] -> trimmed ["ab", "cd"]
    const out = chunkChars("  abcd  ", 4, 0, true, 100)
    expect(out[0].text).toBe("ab")
    expect(out[1].text).toBe("cd")
  })
})

describe("tool.chunk lines", () => {
  test("groups N lines per chunk and keeps separators", () => {
    const text = "a\nb\nc\nd\ne"
    const out = chunkLines(text, 2, 0, true, false, 100)
    expect(out.length).toBe(3)
    expect(out[0].text).toBe("a\nb\n")
    expect(out[1].text).toBe("c\nd\n")
    expect(out[2].text).toBe("e")
  })
  test("keep_separator=false drops EOLs", () => {
    const out = chunkLines("a\nb\nc", 2, 0, false, false, 100)
    expect(out[0].text).toBe("a\nb")
  })
})

describe("tool.chunk words", () => {
  test("counts whitespace-separated words", () => {
    const out = chunkWords("foo bar baz qux quux", 2, 0, false, 100)
    expect(out.length).toBe(3)
    expect(out[0].text).toBe("foo bar")
    expect(out[1].text).toBe("baz qux")
    expect(out[2].text).toBe("quux")
  })
  test("overlap shares words", () => {
    const out = chunkWords("a b c d e f", 3, 1, false, 100)
    expect(out[0].text).toBe("a b c")
    expect(out[1].text).toBe("c d e")
    expect(out[2].text).toBe("e f")
  })
})

describe("tool.chunk paragraphs", () => {
  test("splits on blank lines", () => {
    const text = "p1 line1\np1 line2\n\np2\n\np3"
    const out = chunkParagraphs(text, 1, 0, true, false, 100)
    expect(out.length).toBe(3)
    expect(out[0].text.startsWith("p1")).toBe(true)
    expect(out[1].text.startsWith("p2")).toBe(true)
    expect(out[2].text.startsWith("p3")).toBe(true)
  })
  test("size>1 groups paragraphs", () => {
    const text = "a\n\nb\n\nc\n\nd"
    const out = chunkParagraphs(text, 2, 0, true, false, 100)
    expect(out.length).toBe(2)
    expect(out[0].text.includes("a")).toBe(true)
    expect(out[0].text.includes("b")).toBe(true)
  })
})

describe("tool.chunk bytes", () => {
  test("never breaks a multi-byte codepoint", () => {
    // Uses escaped e-acute and o-umlaut so the source stays ASCII while exercising multi-byte UTF-8.
    const s = "h\u00e9llo w\u00f6rld"
    const out = chunkBytes(s, 4, 0, false, 100)
    // Every chunk decoded must round-trip via UTF-8 with no replacement chars.
    for (const c of out) expect(c.text.includes("\uFFFD")).toBe(false)
    // Reassembling the chunks reproduces the original text.
    expect(out.map((c) => c.text).join("")).toBe(s)
  })
  test("single-byte chunks still keep multi-byte codepoints whole", () => {
    const out = chunkBytes("\u20acx", 1, 0, false, 100)
    expect(out.map((c) => c.text)).toEqual(["\u20ac", "x"])
    for (const c of out) expect(c.text.includes("\uFFFD")).toBe(false)
  })
})

describe("tool.chunk tokens", () => {
  test("approx token sizing produces reasonable chunks", () => {
    const text = "one two three four five six seven eight nine ten"
    const out = chunkTokens(text, 5, 0, false, 100)
    expect(out.length).toBeGreaterThan(0)
    // Concatenating with spaces should reconstruct close to the input
    expect(out.map((c) => c.text).join(" ")).toContain("one")
    expect(out.map((c) => c.text).join(" ")).toContain("ten")
  })
})

describe("tool.chunk count + estimateTokens", () => {
  test("countAll reports each metric", () => {
    const text = "hello world\nfoo bar\n\nsecond paragraph here"
    const c = countAll(text)
    expect(c.chars).toBe(text.length)
    expect(c.lines).toBe(4)
    expect(c.words).toBe(7)
    expect(c.paragraphs).toBe(2)
    expect(c.bytes_utf8).toBe(new TextEncoder().encode(text).length)
    expect(c.tokens_est).toBeGreaterThan(0)
  })
  test("estimateTokens grows with input length", () => {
    expect(estimateTokens("a")).toBeGreaterThan(0)
    expect(estimateTokens("a".repeat(40))).toBeGreaterThan(estimateTokens("a"))
  })
  test("empty input gives zero counts", () => {
    const c = countAll("")
    expect(c.chars).toBe(0)
    expect(c.lines).toBe(0)
    expect(c.words).toBe(0)
    expect(c.paragraphs).toBe(0)
  })
})
