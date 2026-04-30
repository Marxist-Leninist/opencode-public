import { describe, expect, test } from "bun:test"
import { Effect, Exit, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Agent } from "../../src/agent/agent"
import { MessageID, SessionID } from "../../src/session/schema"
import { Tool } from "../../src/tool"
import { DnsTool, __testing } from "../../src/tool/dns"
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

describe("tool.dns helpers", () => {
  test("sortMx by priority then exchange", () => {
    const sorted = __testing.sortMx([
      { priority: 20, exchange: "b.example.net." },
      { priority: 10, exchange: "a.example.net." },
      { priority: 10, exchange: "z.example.net." },
    ])
    expect(sorted[0]?.exchange).toBe("a.example.net.")
    expect(sorted[1]?.exchange).toBe("z.example.net.")
    expect(sorted[2]?.exchange).toBe("b.example.net.")
  })

  test("sortSrv by priority asc, weight desc", () => {
    const sorted = __testing.sortSrv([
      { priority: 10, weight: 50, port: 5061, name: "z.example.com." },
      { priority: 10, weight: 90, port: 5060, name: "a.example.com." },
      { priority: 5, weight: 10, port: 5060, name: "b.example.com." },
    ])
    expect(sorted[0]?.priority).toBe(5)
    expect(sorted[1]?.weight).toBe(90)
    expect(sorted[2]?.weight).toBe(50)
  })

  test("formatRecords: A list", () => {
    expect(__testing.formatRecords("A", ["1.1.1.1", "8.8.8.8"])).toBe("1.1.1.1\n8.8.8.8")
    expect(__testing.formatRecords("A", [])).toBe("(no records)")
  })

  test("formatRecords: MX records", () => {
    const out = __testing.formatRecords("MX", [
      { priority: 10, exchange: "mx1." },
      { priority: 20, exchange: "mx2." },
    ])
    expect(out).toBe("10\tmx1.\n20\tmx2.")
  })

  test("formatRecords: SRV records", () => {
    const out = __testing.formatRecords("SRV", [
      { priority: 5, weight: 10, port: 443, name: "srv.example." },
    ])
    expect(out).toBe("5\t10\t443\tsrv.example.")
  })

  test("makeResolver respects servers override", () => {
    const r = __testing.makeResolver({ servers: ["1.1.1.1", "8.8.8.8"], timeout_ms: 2000, tries: 2 })
    expect(r.getServers()).toEqual(["1.1.1.1", "8.8.8.8"])
  })
})

describe("tool.dns tool", () => {
  it.live("asks dns permission before resolver lookup", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const calls: Array<Parameters<Tool.Context["ask"]>[0]> = []
        const toolInfo = yield* DnsTool
        const tool = yield* toolInfo.init()
        const exit = yield* Effect.exit(
          tool.execute(
            { action: "lookup", host: "example.com", type: "TXT", timeout_ms: 1000 },
            {
              ...baseCtx,
              ask: (input) =>
                Effect.sync(() => {
                  calls.push(input)
                  throw new Error("permission probe")
                }),
            },
          ),
        )

        expect(Exit.isFailure(exit)).toBe(true)
        expect(calls).toHaveLength(1)
        expect(calls[0]!.permission).toBe("dns")
        expect(calls[0]!.patterns).toEqual(["lookup TXT example.com"])
        expect(calls[0]!.metadata.action).toBe("lookup")
      }),
    ),
  )

  it.live("asks dns permission before reverse lookup", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const calls: Array<Parameters<Tool.Context["ask"]>[0]> = []
        const toolInfo = yield* DnsTool
        const tool = yield* toolInfo.init()
        const exit = yield* Effect.exit(
          tool.execute(
            { action: "reverse", ip: "8.8.8.8", timeout_ms: 1000 },
            {
              ...baseCtx,
              ask: (input) =>
                Effect.sync(() => {
                  calls.push(input)
                  throw new Error("permission probe")
                }),
            },
          ),
        )

        expect(Exit.isFailure(exit)).toBe(true)
        expect(calls).toHaveLength(1)
        expect(calls[0]!.permission).toBe("dns")
        expect(calls[0]!.patterns).toEqual(["reverse 8.8.8.8"])
      }),
    ),
  )
})
