import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Agent } from "../../src/agent/agent"
import { MessageID, SessionID } from "../../src/session/schema"
import { Tool } from "../../src/tool"
import { UuidTool, __testing } from "../../src/tool/uuid"
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

describe("tool.uuid helpers", () => {
  test("v4 produces valid UUIDs", () => {
    for (let i = 0; i < 10; i++) {
      const id = __testing.v4()
      expect(__testing.isValidUuid(id)).toBe(true)
      const parsed = __testing.parseUuid(id)
      expect(parsed.valid).toBe(true)
      expect(parsed.version).toBe(4)
      expect(parsed.variant).toBe("rfc4122")
    }
  })

  test("v7 timestamp prefix decodes back", () => {
    const fixed = 1_730_000_000_000 // some realistic ms
    const id = __testing.v7(fixed)
    const parsed = __testing.parseUuid(id)
    expect(parsed.valid).toBe(true)
    expect(parsed.version).toBe(7)
    expect(parsed.variant).toBe("rfc4122")
    expect(parsed.timestamp_ms).toBe(fixed)
  })

  test("v7 IDs sort by creation time (lex)", () => {
    const t1 = 1_730_000_000_000
    const t2 = t1 + 1
    const a = __testing.v7(t1)
    const b = __testing.v7(t2)
    expect(a < b).toBe(true)
  })

  test("toCanonical accepts compact and URN forms", () => {
    const canonical = "550e8400-e29b-41d4-a716-446655440000"
    expect(__testing.toCanonical(canonical)).toBe(canonical)
    expect(__testing.toCanonical(canonical.toUpperCase())).toBe(canonical)
    expect(__testing.toCanonical(canonical.replace(/-/g, ""))).toBe(canonical)
    expect(__testing.toCanonical(`urn:uuid:${canonical}`)).toBe(canonical)
    expect(__testing.toCanonical("not a uuid")).toBe(null)
  })

  test("parseUuid recognises the nil UUID", () => {
    const nil = "00000000-0000-0000-0000-000000000000"
    const parsed = __testing.parseUuid(nil)
    expect(parsed.valid).toBe(true)
    expect(parsed.version).toBe(0)
    expect(parsed.variant).toBe("nil")
  })

  test("format produces upper, compact, urn", () => {
    const id = "550e8400-e29b-41d4-a716-446655440000"
    expect(__testing.format(id, "upper")).toBe(id.toUpperCase())
    expect(__testing.format(id, "compact")).toBe(id.replace(/-/g, ""))
    expect(__testing.format(id, "urn")).toBe(`urn:uuid:${id}`)
  })

  test("v4 and v7 generate unique values", () => {
    const ids = new Set<string>()
    for (let i = 0; i < 200; i++) ids.add(__testing.v4())
    for (let i = 0; i < 200; i++) ids.add(__testing.v7())
    expect(ids.size).toBe(400)
  })
})

describe("tool.uuid tool", () => {
  it.live("generates a single v4", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* UuidTool
        const tool = yield* toolInfo.init()
        const result = yield* tool.execute({ action: "v4" }, baseCtx)
        expect(result.metadata.uuids?.length).toBe(1)
        expect(__testing.isValidUuid(result.metadata.uuids![0]!)).toBe(true)
      }),
    ),
  )

  it.live("generates many v7 in canonical order", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* UuidTool
        const tool = yield* toolInfo.init()
        const result = yield* tool.execute({ action: "v7", count: 5 }, baseCtx)
        expect(result.metadata.uuids?.length).toBe(5)
        for (const id of result.metadata.uuids!) {
          expect(__testing.isValidUuid(id)).toBe(true)
        }
      }),
    ),
  )

  it.live("validate returns true for canonical and false for garbage", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* UuidTool
        const tool = yield* toolInfo.init()
        const ok = yield* tool.execute(
          { action: "validate", value: "550e8400-e29b-41d4-a716-446655440000" },
          baseCtx,
        )
        expect(ok.metadata.valid).toBe(true)
        const bad = yield* tool.execute({ action: "validate", value: "not-a-uuid" }, baseCtx)
        expect(bad.metadata.valid).toBe(false)
      }),
    ),
  )

  it.live("parse returns version and timestamp for v7", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* UuidTool
        const tool = yield* toolInfo.init()
        const id = __testing.v7(1_730_000_000_000)
        const result = yield* tool.execute({ action: "parse", value: id }, baseCtx)
        expect(result.metadata.parsed?.version).toBe(7)
        expect(result.metadata.parsed?.timestamp_ms).toBe(1_730_000_000_000)
      }),
    ),
  )

  it.live("urn wraps a canonical UUID", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* UuidTool
        const tool = yield* toolInfo.init()
        const result = yield* tool.execute(
          { action: "urn", value: "550e8400-e29b-41d4-a716-446655440000" },
          baseCtx,
        )
        expect(result.metadata.uuids?.[0]).toBe("urn:uuid:550e8400-e29b-41d4-a716-446655440000")
      }),
    ),
  )

  it.live("compact format strips dashes", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* UuidTool
        const tool = yield* toolInfo.init()
        const result = yield* tool.execute({ action: "v4", format: "compact" }, baseCtx)
        const id = result.metadata.uuids![0]!
        expect(id.includes("-")).toBe(false)
        expect(id.length).toBe(32)
      }),
    ),
  )

  it.live("nil action returns the nil UUID", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* UuidTool
        const tool = yield* toolInfo.init()
        const result = yield* tool.execute({ action: "nil" }, baseCtx)
        expect(result.metadata.uuids?.[0]).toBe("00000000-0000-0000-0000-000000000000")
      }),
    ),
  )
})
