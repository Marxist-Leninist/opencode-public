import { describe, expect, test } from "bun:test"
import {
  chatSearchQueryTerms,
  clampChatSearchIndex,
  moveChatSearchIndex,
  parseChatSearchModelSelection,
  splitChatSearchHighlight,
} from "./dialog-chat-search-utils"

describe("chat search dialog helpers", () => {
  test("normalizes query terms used for snippet highlights", () => {
    expect(chatSearchQueryTerms(" hi  SG2 x ")).toEqual(["hi", "sg2"])
  })

  test("does not highlight common stop words in longer queries", () => {
    expect(chatSearchQueryTerms("what are you doing")).toEqual(["doing"])
  })

  test("splits highlighted snippets without treating query text as regex", () => {
    expect(splitChatSearchHighlight("Use C++ and sg1/sg2 safely", "c++ sg1/sg2")).toEqual([
      { text: "Use ", match: false },
      { text: "C++", match: true },
      { text: " and ", match: false },
      { text: "sg1/sg2", match: true },
      { text: " safely", match: false },
    ])
  })

  test("clamps keyboard selection to available results", () => {
    expect(clampChatSearchIndex(5, 2)).toBe(1)
    expect(moveChatSearchIndex(0, 2, -1)).toBe(0)
    expect(moveChatSearchIndex(0, 2, 1)).toBe(1)
    expect(moveChatSearchIndex(1, 2, 1)).toBe(1)
    expect(moveChatSearchIndex(10, 0, -1)).toBe(0)
  })

  test("keeps provider separate from slash-containing model IDs", () => {
    expect(parseChatSearchModelSelection("openrouter/openrouter/auto@preset/latency")).toEqual({
      providerID: "openrouter",
      modelID: "openrouter/auto@preset/latency",
    })
    expect(parseChatSearchModelSelection("missing-model")).toBeUndefined()
  })
})
