import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Agent } from "../../src/agent/agent"
import { MessageID, SessionID } from "../../src/session/schema"
import { Tool } from "../../src/tool"
import { FuzzyTool, __testing } from "../../src/tool/fuzzy"
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

describe("tool.fuzzy helpers", () => {
  test("levenshtein identity and basic", () => {
    expect(__testing.levenshteinDistance("kitten", "kitten")).toBe(0)
    // Classic kitten/sitting=3
    expect(__testing.levenshteinDistance("kitten", "sitting")).toBe(3)
    expect(__testing.levenshteinDistance("", "abc")).toBe(3)
    expect(__testing.levenshteinDistance("abc", "")).toBe(3)
    expect(__testing.levenshteinDistance("flaw", "lawn")).toBe(2)
  })

  test("damerau handles transpositions", () => {
    expect(__testing.damerauLevenshteinDistance("teh", "the")).toBe(1)
    // Levenshtein would call this 2 (sub+sub), OSA-Damerau treats it as one transposition.
    expect(__testing.levenshteinDistance("teh", "the")).toBe(2)
    // "abcde" -> "abdce" is one transposition under Damerau-Levenshtein.
    expect(__testing.damerauLevenshteinDistance("abcde", "abdce")).toBe(1)
  })

  test("hamming requires equal length", () => {
    expect(__testing.hammingDistance("karolin", "kathrin")).toBe(3)
    expect(__testing.hammingDistance("1011101", "1001001")).toBe(2)
    expect(() => __testing.hammingDistance("abc", "abcd")).toThrow()
  })

  test("jaro / jaro-winkler classic example", () => {
    // From the original Jaro paper / Wikipedia example.
    const j = __testing.jaroSimilarity("MARTHA", "MARHTA")
    expect(j).toBeGreaterThan(0.94)
    expect(j).toBeLessThan(0.945)
    const jw = __testing.jaroWinklerSimilarity("MARTHA", "MARHTA")
    expect(jw).toBeGreaterThan(0.96)
    expect(jw).toBeLessThan(0.965)
  })

  test("jaro identical and disjoint", () => {
    expect(__testing.jaroSimilarity("", "")).toBe(1)
    expect(__testing.jaroSimilarity("abc", "abc")).toBe(1)
    expect(__testing.jaroSimilarity("abc", "xyz")).toBe(0)
  })

  test("longest common subsequence", () => {
    expect(__testing.longestCommonSubsequence("ABCBDAB", "BDCAB")).toHaveLength(4)
    // One canonical LCS is "BDAB"; tool may return "BCAB" (same length).
    expect(__testing.longestCommonSubsequence("AGCAT", "GAC")).toHaveLength(2)
    expect(__testing.longestCommonSubsequence("", "abc")).toBe("")
  })

  test("similarityRatio", () => {
    expect(__testing.similarityRatio("foo", "foo")).toBe(1)
    // 1 - 3/3 = 0
    expect(__testing.similarityRatio("abc", "xyz")).toBe(0)
    expect(__testing.similarityRatio("", "")).toBe(1)
  })

  it.live("levenshtein execute", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const ti = yield* FuzzyTool
        const tool = yield* ti.init()
        const r = yield* tool.execute({ action: "levenshtein", a: "kitten", b: "sitting" }, baseCtx)
        expect(r.metadata.distance).toBe(3)
        expect(r.output).toBe("3")
      }),
    ),
  )

  it.live("jaro_winkler execute", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const ti = yield* FuzzyTool
        const tool = yield* ti.init()
        const r = yield* tool.execute({ action: "jaro_winkler", a: "MARTHA", b: "MARHTA" }, baseCtx)
        expect(typeof r.metadata.score).toBe("number")
        expect(r.metadata.score!).toBeGreaterThan(0.96)
      }),
    ),
  )

  it.live("best_match ranks expected order", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const ti = yield* FuzzyTool
        const tool = yield* ti.init()
        const r = yield* tool.execute(
          {
            action: "best_match",
            value: "checkot",
            candidates: ["checkout", "check", "chocolate", "out", "checkin"],
            limit: 3,
          },
          baseCtx,
        )
        const matches = r.metadata.matches!
        expect(matches[0].value).toBe("checkout")
        expect(matches.length).toBeLessThanOrEqual(3)
      }),
    ),
  )

  it.live("best_match with min_score filters", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const ti = yield* FuzzyTool
        const tool = yield* ti.init()
        const r = yield* tool.execute(
          {
            action: "best_match",
            value: "alpha",
            candidates: ["alphabet", "beta", "gamma", "delta"],
            min_score: 0.7,
            limit: 10,
          },
          baseCtx,
        )
        const matches = r.metadata.matches!
        // Only "alphabet" should pass 0.7 threshold; others share no useful prefix.
        expect(matches.every((m) => m.score >= 0.7)).toBe(true)
        expect(matches[0].value).toBe("alphabet")
      }),
    ),
  )

  it.live("case insensitive by default", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const ti = yield* FuzzyTool
        const tool = yield* ti.init()
        const r = yield* tool.execute({ action: "levenshtein", a: "ABC", b: "abc" }, baseCtx)
        expect(r.metadata.distance).toBe(0)
        const r2 = yield* tool.execute(
          { action: "levenshtein", a: "ABC", b: "abc", case_sensitive: true },
          baseCtx,
        )
        expect(r2.metadata.distance).toBe(3)
      }),
    ),
  )

  it.live("hamming length mismatch errors", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const ti = yield* FuzzyTool
        const tool = yield* ti.init()
        const exit = yield* Effect.exit(tool.execute({ action: "hamming", a: "abc", b: "abcd" }, baseCtx))
        expect(exit._tag).toBe("Failure")
      }),
    ),
  )
})
