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
})
