import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Agent } from "../../src/agent/agent"
import { MessageID, SessionID } from "../../src/session/schema"
import { Tool } from "../../src/tool"
import { LuhnTool, __testing } from "../../src/tool/luhn"
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

describe("tool.luhn helpers", () => {
  test("Luhn validation: known credit card numbers", () => {
    // Visa test number
    expect(__testing.luhnValid("4111111111111111")).toBe(true)
    // Mastercard test number
    expect(__testing.luhnValid("5555555555554444")).toBe(true)
    // Amex test number
    expect(__testing.luhnValid("378282246310005")).toBe(true)
    // Discover test number
    expect(__testing.luhnValid("6011111111111117")).toBe(true)
    // Failing
    expect(__testing.luhnValid("4111111111111112")).toBe(false)
    expect(__testing.luhnValid("0")).toBe(false)
  })

  test("Luhn check digit", () => {
    expect(__testing.luhnCheckDigit("411111111111111")).toBe("1")
    expect(__testing.luhnCheckDigit("555555555555444")).toBe("4")
  })

  test("EAN-13 check digit + validate", () => {
    // ISBN 9780201310054 -> check digit 4
    expect(__testing.gs1CheckDigit("978020131005")).toBe("4")
    expect(__testing.gs1Valid("9780201310054")).toBe(true)
    expect(__testing.gs1Valid("9780201310050")).toBe(false)
  })

  test("UPC-A check digit", () => {
    // 03600029145 -> check digit 2 (Coca-Cola example)
    expect(__testing.gs1CheckDigit("03600029145")).toBe("2")
    expect(__testing.gs1Valid("036000291452")).toBe(true)
  })

  test("ISBN-10 with X check char", () => {
    expect(__testing.isbn10Valid("097522980X")).toBe(true)
    expect(__testing.isbn10Valid("0306406152")).toBe(true)
    expect(__testing.isbn10Valid("0306406150")).toBe(false)
    expect(__testing.isbn10CheckChar("097522980")).toBe("X")
  })

  test("IBAN: GB rearrangement and mod-97", () => {
    // GB82 WEST 1234 5698 7654 32 - canonical example
    expect(__testing.ibanValid("GB82WEST12345698765432")).toBe(true)
    expect(__testing.ibanValid("GB82 WEST 1234 5698 7654 32")).toBe(true)
    expect(__testing.ibanValid("GB82WEST12345698765433")).toBe(false)
    // DE89 3704 0044 0532 0130 00
    expect(__testing.ibanValid("DE89370400440532013000")).toBe(true)
  })

  test("ISIN: validate Apple US0378331005", () => {
    expect(__testing.isinValid("US0378331005")).toBe(true)
    expect(__testing.isinValid("US0378331006")).toBe(false)
    expect(__testing.isinCheckDigit("US037833100")).toBe("5")
  })

  test("Card brand detection", () => {
    expect(__testing.detectCardBrand("4111111111111111")).toBe("Visa")
    expect(__testing.detectCardBrand("5555555555554444")).toBe("Mastercard")
    expect(__testing.detectCardBrand("378282246310005")).toBe("Amex")
    expect(__testing.detectCardBrand("6011111111111117")).toBe("Discover")
  })

  test("Auto-infer scheme", () => {
    expect(__testing.inferScheme("4111111111111111")).toBe("creditcard")
    expect(__testing.inferScheme("9780201310054")).toBe("isbn13")
    expect(__testing.inferScheme("036000291452")).toBe("upca")
    expect(__testing.inferScheme("GB82WEST12345698765432")).toBe("iban")
    expect(__testing.inferScheme("US0378331005")).toBe("isin")
  })
})

describe("tool.luhn tool", () => {
  it.live("validate visa", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const ti = yield* LuhnTool
        const tool = yield* ti.init()
        const r = yield* tool.execute({ action: "validate", value: "4111111111111111" }, baseCtx)
        expect(r.metadata.ok).toBe(true)
        expect(r.metadata.scheme).toBe("creditcard")
        expect(r.metadata.brand).toBe("Visa")
        expect(r.output).toBe("true")
      }),
    ),
  )

  it.live("info iban", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const ti = yield* LuhnTool
        const tool = yield* ti.init()
        const r = yield* tool.execute(
          { action: "info", value: "GB82 WEST 1234 5698 7654 32" },
          baseCtx,
        )
        expect(r.metadata.ok).toBe(true)
        expect(r.metadata.scheme).toBe("iban")
        expect(r.metadata.country).toBe("GB")
      }),
    ),
  )

  it.live("complete iban from country+BBAN with 00 placeholder", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const ti = yield* LuhnTool
        const tool = yield* ti.init()
        // Pass GB + BBAN with no check digits; tool should compute "82".
        const r = yield* tool.execute(
          { action: "complete", value: "GBWEST12345698765432", scheme: "iban" },
          baseCtx,
        )
        expect(r.output).toBe("GB82WEST12345698765432")
      }),
    ),
  )
})
