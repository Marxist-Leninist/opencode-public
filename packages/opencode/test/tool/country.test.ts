import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Agent } from "../../src/agent/agent"
import { MessageID, SessionID } from "../../src/session/schema"
import { Tool } from "../../src/tool"
import {
  CountryTool,
  __testing,
  isValidCode,
  listCountries,
  lookupCountry,
} from "../../src/tool/country"
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

describe("tool.country helpers", () => {
  test("flagFromAlpha2 builds regional indicator pair", () => {
    expect(__testing.flagFromAlpha2("US")).toBe("\u{1F1FA}\u{1F1F8}")
    expect(__testing.flagFromAlpha2("GB")).toBe("\u{1F1EC}\u{1F1E7}")
    expect(__testing.flagFromAlpha2("xx")).toBe("")
  })

  test("alpha2FromFlag round-trips", () => {
    expect(__testing.alpha2FromFlag("\u{1F1FA}\u{1F1F8}")).toBe("US")
    expect(__testing.alpha2FromFlag("\u{1F1EB}\u{1F1F7}")).toBe("FR")
    expect(__testing.alpha2FromFlag("US")).toBeUndefined()
    expect(__testing.alpha2FromFlag("\u{1F1FA}")).toBeUndefined()
  })

  test("normalize strips diacritics and casing", () => {
    expect(__testing.normalize("C\u00f4te d'Ivoire")).toBe("cote d'ivoire")
    expect(__testing.normalize("  T\u00fcrkiye  ")).toBe("turkiye")
  })

  test("ROWS contains expected staples and unique codes", () => {
    const idx = __testing.index()
    expect(idx.byAlpha2.has("US")).toBe(true)
    expect(idx.byAlpha2.has("DE")).toBe(true)
    expect(idx.byAlpha3.has("USA")).toBe(true)
    expect(idx.byAlpha3.has("DEU")).toBe(true)
    expect(idx.byNumeric.get("840")?.alpha2).toBe("US")
    expect(idx.countries.length).toBeGreaterThanOrEqual(240)
    // Ensure no duplicate alpha-2 codes.
    const codes = new Set(idx.countries.map((c) => c.alpha2))
    expect(codes.size).toBe(idx.countries.length)
  })

  test("lookupCountry resolves via alpha2/alpha3/numeric/name/flag/alias", () => {
    expect(lookupCountry("us")?.name).toBe("United States")
    expect(lookupCountry("USA")?.numeric).toBe("840")
    expect(lookupCountry("840")?.alpha2).toBe("US")
    expect(lookupCountry("United States")?.alpha2).toBe("US")
    expect(lookupCountry("\u{1F1EB}\u{1F1F7}")?.alpha2).toBe("FR")
    expect(lookupCountry("uk")?.alpha2).toBe("GB")
    expect(lookupCountry("c\u00f4te d'ivoire")?.alpha2).toBe("CI")
  })

  test("lookupCountry prefers shorter prefix match for ambiguous queries", () => {
    // Both KP and KR start with "korea,"; the shorter official name wins
    // ("Korea, Republic of" is shorter than "Korea, Democratic People's...").
    expect(lookupCountry("korea")?.alpha2).toBe("KR")
    expect(lookupCountry("korea, democratic")?.alpha2).toBe("KP")
    expect(lookupCountry("korea, republic")?.alpha2).toBe("KR")
    expect(lookupCountry("south korea")?.alpha2).toBe("KR")
    expect(lookupCountry("north korea")?.alpha2).toBe("KP")
  })

  test("lookupCountry returns undefined for clearly invalid queries", () => {
    expect(lookupCountry("zzz country")).toBeUndefined()
    expect(lookupCountry("")).toBeUndefined()
  })

  test("isValidCode honours code_kind filter", () => {
    expect(isValidCode("US", "alpha2").ok).toBe(true)
    expect(isValidCode("US", "alpha3").ok).toBe(false)
    expect(isValidCode("USA", "alpha3").ok).toBe(true)
    expect(isValidCode("USA", "numeric").ok).toBe(false)
    expect(isValidCode("840", "numeric").ok).toBe(true)
    expect(isValidCode("840", "any").matched?.alpha2).toBe("US")
    expect(isValidCode("XX", "any").ok).toBe(false)
  })

  test("listCountries filters by region and subregion", () => {
    const europe = listCountries({ region: "Europe" })
    expect(europe.length).toBeGreaterThan(20)
    expect(europe.every((c) => c.region === "Europe")).toBe(true)

    const nordic = listCountries({ region: "Europe", subregion: "Northern Europe" })
    expect(nordic.some((c) => c.alpha2 === "SE")).toBe(true)
    expect(nordic.every((c) => c.subregion === "Northern Europe")).toBe(true)
  })
})

describe("tool.country tool", () => {
  it.live("lookup returns matched country", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* CountryTool
        const tool = yield* toolInfo.init()
        const result = yield* tool.execute({ action: "lookup", query: "Germany" }, baseCtx)
        expect(result.metadata.matched?.alpha2).toBe("DE")
        expect(result.metadata.matched?.flag).toBe("\u{1F1E9}\u{1F1EA}")
        expect(result.output).toContain("Germany")
      }),
    ),
  )

  it.live("validate rejects mismatched code_kind", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* CountryTool
        const tool = yield* toolInfo.init()
        const ok = yield* tool.execute({ action: "validate", query: "USA", code_kind: "alpha3" }, baseCtx)
        expect(ok.metadata.ok).toBe(true)
        const bad = yield* tool.execute({ action: "validate", query: "USA", code_kind: "alpha2" }, baseCtx)
        expect(bad.metadata.ok).toBe(false)
      }),
    ),
  )

  it.live("list applies region filter and limit", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* CountryTool
        const tool = yield* toolInfo.init()
        const result = yield* tool.execute(
          { action: "list", region: "Oceania", limit: 5 },
          baseCtx,
        )
        expect(result.metadata.matches).toBeLessThanOrEqual(5)
        expect(result.metadata.countries?.every((c) => c.region === "Oceania")).toBe(true)
        expect((result.metadata.total ?? 0) >= (result.metadata.matches ?? 0)).toBe(true)
      }),
    ),
  )

  it.live("info reports total country count", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* CountryTool
        const tool = yield* toolInfo.init()
        const result = yield* tool.execute({ action: "info" }, baseCtx)
        expect(result.metadata.total).toBeGreaterThan(0)
        expect(result.output).toContain("ISO 3166-1")
      }),
    ),
  )

  it.live("lookup surfaces no-match output without throwing", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* CountryTool
        const tool = yield* toolInfo.init()
        const result = yield* tool.execute({ action: "lookup", query: "zzz nowhere" }, baseCtx)
        expect(result.metadata.matches).toBe(0)
        expect(result.output).toContain("No country matched")
      }),
    ),
  )
})
