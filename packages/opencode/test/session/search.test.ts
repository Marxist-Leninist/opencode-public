import { describe, expect, test } from "bun:test"
import { SessionSearch } from "../../src/session/search"

describe("SessionSearch", () => {
  test("scores exact chat matches ahead of unrelated text", () => {
    const query = "nvidia driver"
    const terms = SessionSearch.terms(query)

    expect(SessionSearch.scoreText(query, terms, "Installed the NVIDIA driver successfully")).toBeGreaterThan(
      SessionSearch.scoreText(query, terms, "Installed a package successfully"),
    )
  })

  test("builds a bounded snippet near the matching term", () => {
    const query = "ring model"
    const terms = SessionSearch.terms(query)
    const snippet = SessionSearch.snippet(
      "The private SG fork added search support. Later the Ring model adapter was repaired for chat use.",
      query,
      terms,
    )

    expect(snippet).toContain("Ring model")
    expect(snippet.length).toBeLessThanOrEqual(300)
  })

  test("parses semantic AI search JSON from prose", () => {
    const parsed = SessionSearch.parseSemanticResult(
      'Use this: {"answer":"Found scheduler notes","sessionIDs":["a","missing","a","b"]}',
      new Set(["a", "b"]),
    )

    expect(parsed).toEqual({
      answer: "Found scheduler notes",
      sessionIDs: ["a", "b"],
    })
  })

  test("skips invalid brace blocks before semantic AI search JSON", () => {
    const parsed = SessionSearch.parseSemanticResult(
      'not json {answer: nope} then {"answer":"Use the second object","sessionIDs":["b"]}',
      new Set(["b"]),
    )

    expect(parsed).toEqual({
      answer: "Use the second object",
      sessionIDs: ["b"],
    })
  })

  test("falls back to plain answer when semantic AI search JSON is absent", () => {
    const parsed = SessionSearch.parseSemanticResult("No strong matches in the provided previews.", new Set(["a"]))

    expect(parsed).toEqual({
      answer: "No strong matches in the provided previews.",
      sessionIDs: [],
    })
  })
})
