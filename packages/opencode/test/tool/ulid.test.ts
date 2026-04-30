import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Agent } from "../../src/agent/agent"
import { MessageID, SessionID } from "../../src/session/schema"
import { Tool } from "../../src/tool"
import { UlidTool, __testing } from "../../src/tool/ulid"
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

describe("tool.ulid helpers", () => {
  test("generated ULID is 26 chars and validates", () => {
    const ids = __testing.generateUlids({ count: 5, seed: 42 })
    expect(ids.length).toBe(5)
    for (const id of ids) {
      expect(id.length).toBe(26)
      expect(__testing.isValidUlid(id)).toBe(true)
    }
  })

  test("encoded timestamp roundtrips through decode", () => {
    const t = 1_730_000_000_000
    const ids = __testing.generateUlids({ count: 1, time_ms: t, seed: 1 })
    const decoded = __testing.decodeUlid(ids[0]!)
    expect(decoded.time_ms).toBe(t)
  })

  test("monotonic mode produces strictly increasing IDs at the same ms", () => {
    const ids = __testing.generateUlids({ count: 50, time_ms: 1_730_000_000_000, seed: 1, monotonic: true })
    for (let i = 1; i < ids.length; i++) {
      expect(ids[i]! > ids[i - 1]!).toBe(true)
    }
  })

  test("non-monotonic mode does not guarantee ordering at the same ms", () => {
    // We don't assert anti-ordering; we just assert it still produces 50 valid distinct IDs.
    const ids = __testing.generateUlids({ count: 50, time_ms: 1_730_000_000_000, seed: 7, monotonic: false })
    const set = new Set(ids)
    expect(set.size).toBe(50)
    for (const id of ids) expect(__testing.isValidUlid(id)).toBe(true)
  })

  test("generate is deterministic for a fixed seed and time", () => {
    const a = __testing.generateUlids({ count: 4, time_ms: 1_730_000_000_000, seed: 99, monotonic: true })
    const b = __testing.generateUlids({ count: 4, time_ms: 1_730_000_000_000, seed: 99, monotonic: true })
    expect(a).toEqual(b)
  })

  test("isValidUlid rejects garbage", () => {
    expect(__testing.isValidUlid("not a ulid")).toBe(false)
    expect(__testing.isValidUlid("00000000000000000000000000")).toBe(true) // 26 zeroes is valid
    expect(__testing.isValidUlid("U".repeat(26))).toBe(false) // U not in alphabet
  })

  test("Crockford O/L/I are decoded as 0/1/1 on decode", () => {
    const original = __testing.generateUlids({ count: 1, time_ms: 1_730_000_000_000, seed: 1 })[0]!
    // Replace any '0' with 'O' and '1' with 'I' — both should still round-trip.
    const swapped = original.replace(/0/g, "O").replace(/1/g, "I")
    if (swapped !== original) {
      expect(__testing.isValidUlid(swapped)).toBe(true)
      const a = __testing.decodeUlid(original)
      const b = __testing.decodeUlid(swapped)
      expect(a.time_ms).toBe(b.time_ms)
      expect(Buffer.from(a.random).toString("hex")).toBe(Buffer.from(b.random).toString("hex"))
    }
  })

  test("ulidToUuid <-> uuidToUlid roundtrip preserves bits", () => {
    const ulid = __testing.generateUlids({ count: 1, time_ms: 1_730_000_000_000, seed: 1 })[0]!
    const uuid = __testing.ulidToUuid(ulid)
    expect(uuid.length).toBe(36)
    expect(uuid.split("-").length).toBe(5)
    const back = __testing.uuidToUlid(uuid)
    expect(back).toBe(ulid)
  })

  test("incrementRandom carries through bytes correctly", () => {
    const arr = new Uint8Array(10)
    for (let i = 0; i < 10; i++) arr[i] = 0xff
    const overflow = __testing.incrementRandom(arr)
    expect(overflow).toBe(true)
    for (let i = 0; i < 10; i++) expect(arr[i]).toBe(0)
    const arr2 = new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff])
    const overflow2 = __testing.incrementRandom(arr2)
    expect(overflow2).toBe(false)
    expect(arr2[7]).toBe(1)
    expect(arr2[8]).toBe(0)
    expect(arr2[9]).toBe(0)
  })

  test("encodeTime is 10 chars and bounds round-trip", () => {
    expect(__testing.encodeTime(0)).toBe("0000000000")
    // 48 bits of 1 packed left-aligned into 10 base32 chars (50 bits) leaves the
    // top 2 bits zero, which encodes the leading char as '7' (0b00111).
    expect(__testing.encodeTime(0xffffffffffff)).toBe("7ZZZZZZZZZ")
    // Round-trip: encoding then decoding must recover the same time.
    const sample = __testing.generateUlids({ count: 1, time_ms: 0xffffffffffff, seed: 1 })[0]!
    expect(__testing.decodeUlid(sample).time_ms).toBe(0xffffffffffff)
  })

  test("ULIDs sort lexicographically by timestamp", () => {
    const a = __testing.generateUlids({ count: 1, time_ms: 1, seed: 1 })[0]!
    const b = __testing.generateUlids({ count: 1, time_ms: 2, seed: 1 })[0]!
    const c = __testing.generateUlids({ count: 1, time_ms: 3, seed: 1 })[0]!
    expect([c, b, a].toSorted()).toEqual([a, b, c])
  })
})

describe("tool.ulid tool", () => {
  it.live("generate emits N ULIDs", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* UlidTool
        const tool = yield* toolInfo.init()
        const result = yield* tool.execute({ action: "generate", count: 5, seed: 1 }, baseCtx)
        expect(result.metadata.ulids?.length).toBe(5)
        for (const id of result.metadata.ulids!) expect(__testing.isValidUlid(id)).toBe(true)
      }),
    ),
  )

  it.live("parse returns timestamp and random parts", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* UlidTool
        const tool = yield* toolInfo.init()
        const id = __testing.generateUlids({ count: 1, time_ms: 1_730_000_000_000, seed: 1 })[0]!
        const result = yield* tool.execute({ action: "parse", value: id }, baseCtx)
        expect(result.metadata.parsed?.valid).toBe(true)
        expect(result.metadata.parsed?.timestamp_ms).toBe(1_730_000_000_000)
        expect(result.metadata.parsed?.canonical).toBe(id)
      }),
    ),
  )

  it.live("validate distinguishes good and bad strings", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* UlidTool
        const tool = yield* toolInfo.init()
        const ok = yield* tool.execute(
          { action: "validate", value: "01ARYZ6S41TSV4RRFFQ69G5FAV" },
          baseCtx,
        )
        expect(ok.metadata.valid).toBe(true)
        const bad = yield* tool.execute({ action: "validate", value: "not-a-ulid" }, baseCtx)
        expect(bad.metadata.valid).toBe(false)
      }),
    ),
  )

  it.live("from_uuid + to_uuid are inverses", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* UlidTool
        const tool = yield* toolInfo.init()
        const id = __testing.generateUlids({ count: 1, time_ms: 1_730_000_000_000, seed: 9 })[0]!
        const toUuid = yield* tool.execute({ action: "to_uuid", value: id }, baseCtx)
        const back = yield* tool.execute(
          { action: "from_uuid", value: toUuid.metadata.ulids![0]! },
          baseCtx,
        )
        expect(back.metadata.ulids?.[0]).toBe(id)
      }),
    ),
  )
})
