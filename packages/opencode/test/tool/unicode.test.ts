import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Agent } from "../../src/agent/agent"
import { MessageID, SessionID } from "../../src/session/schema"
import { Tool } from "../../src/tool"
import { UnicodeTool, __testing } from "../../src/tool/unicode"
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

describe("tool.unicode helpers", () => {
  test("info detects emoji and combining", () => {
    const r1 = __testing.unicodeInfo("café 🚀")
    expect(r1.has_non_ascii).toBe(true)
    expect(r1.has_emoji).toBe(true)
    const r2 = __testing.unicodeInfo("hello")
    expect(r2.has_non_ascii).toBe(false)
    expect(r2.has_emoji).toBe(false)
  })
  test("escape and unescape roundtrip", () => {
    const orig = "Hello\nWorld 🚀 — café"
    const esc = __testing.escapeJs(orig)
    expect(esc).not.toBe(orig)
    expect(esc).toContain("\\n")
    expect(__testing.unescapeJs(esc)).toBe(orig)
  })
  test("strip invisible removes ZWSP", () => {
    const s = "Hello​World"
    expect(s.length).toBe(11)
    expect(__testing.stripInvisible(s)).toBe("HelloWorld")
  })
  test("is_confusable detects Cyrillic homoglyph", () => {
    expect(__testing.isConfusable("Paypal", "Pаypal")).toBe(true) // second has Cyrillic а
    expect(__testing.isConfusable("foo", "bar")).toBe(false)
    expect(__testing.isConfusable("foo", "foo")).toBe(false)
  })
  test("totalWidth: emoji = 2, ascii = 1, ZWSP = 0", () => {
    expect(__testing.totalWidth("a")).toBe(1)
    expect(__testing.totalWidth("🚀")).toBe(2)
    expect(__testing.totalWidth("a​b")).toBe(2)
  })
  test("listCodepoints returns categories and scripts", () => {
    const r = __testing.listCodepoints("Aа1")
    expect(r[0]!.script).toBe("Latin")
    expect(r[1]!.script).toBe("Cyrillic")
    expect(r[2]!.category).toBe("Nd")
  })
})

describe("tool.unicode tool", () => {
  it.live("normalize NFD splits accents", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const ti = yield* UnicodeTool
        const tool = yield* ti.init()
        const r = yield* tool.execute({ action: "normalize", value: "café", form: "NFD" }, baseCtx)
        expect(r.output.length).toBeGreaterThan("café".length)
      }),
    ),
  )
  it.live("info via tool", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const ti = yield* UnicodeTool
        const tool = yield* ti.init()
        const r = yield* tool.execute({ action: "info", value: "café 🚀" }, baseCtx)
        const obj = JSON.parse(r.output)
        expect(obj.has_emoji).toBe(true)
        expect(obj.has_non_ascii).toBe(true)
      }),
    ),
  )
  it.live("is_confusable via tool", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const ti = yield* UnicodeTool
        const tool = yield* ti.init()
        const r = yield* tool.execute({ action: "is_confusable", a: "Paypal", b: "Pаypal" }, baseCtx)
        const obj = JSON.parse(r.output)
        expect(obj.confusable).toBe(true)
      }),
    ),
  )
})
