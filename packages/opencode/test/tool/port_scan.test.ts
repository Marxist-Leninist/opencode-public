import { describe, expect, test } from "bun:test"
import { Effect, Exit, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Agent } from "../../src/agent/agent"
import { MessageID, SessionID } from "../../src/session/schema"
import { Tool } from "../../src/tool"
import { PortScanTool, __testing } from "../../src/tool/port_scan"
import { Truncate } from "../../src/tool"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { createServer } from "node:net"

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

describe("tool.port_scan helpers", () => {
  test("parseRange: single + ranges + commas", () => {
    expect(__testing.parseRange("80")).toEqual([80])
    expect(__testing.parseRange("22,80,443")).toEqual([22, 80, 443])
    expect(__testing.parseRange("1000-1003")).toEqual([1000, 1001, 1002, 1003])
    expect(__testing.parseRange("22, 80,1000-1002")).toEqual([22, 80, 1000, 1001, 1002])
  })
  test("parseRange: rejects invalid", () => {
    expect(() => __testing.parseRange("0-10")).toThrow()
    expect(() => __testing.parseRange("90000")).toThrow()
    expect(() => __testing.parseRange("abc")).toThrow()
  })
  test("preset top10 sane", () => {
    const top = __testing.presetPorts("top10")
    expect(top).toContain(22)
    expect(top).toContain(443)
    expect(top.length).toBe(10)
  })
  test("PORT_SERVICES known ports", () => {
    expect(__testing.PORT_SERVICES[22]).toBe("ssh")
    expect(__testing.PORT_SERVICES[443]).toBe("https")
    expect(__testing.PORT_SERVICES[27017]).toBe("mongodb")
    expect(__testing.PORT_SERVICES[11434]).toBe("ollama")
  })
  test("permissionPattern stays compact for large scans", () => {
    expect(__testing.permissionPattern("example.com", [22, 80, 443])).toBe("example.com:22,80,443")
    expect(__testing.permissionPattern("example.com", Array.from({ length: 40 }, (_, i) => i + 1))).toBe(
      "example.com:1-40 (40 ports)",
    )
  })
})

describe("tool.port_scan tool", () => {
  it.live("asks port_scan permission before opening sockets", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const calls: Array<Parameters<Tool.Context["ask"]>[0]> = []
        const ti = yield* PortScanTool
        const tool = yield* ti.init()
        const exit = yield* Effect.exit(
          tool.execute(
            { host: "127.0.0.1", ports: [22, 443], timeout_ms: 1000 },
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
        expect(calls[0]!.permission).toBe("port_scan")
        expect(calls[0]!.patterns).toEqual(["127.0.0.1:22,443"])
        expect(calls[0]!.metadata.scanned_count).toBe(2)
      }),
    ),
  )

  it.live("detects an open ephemeral port and reports a closed neighbor", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const ti = yield* PortScanTool
        const tool = yield* ti.init()
        // Spin up a temporary listener on a random port.
        const server = createServer()
        const port = yield* Effect.promise<number>(
          () =>
            new Promise((resolve, reject) => {
              server.listen(0, "127.0.0.1", () => {
                const addr = server.address()
                if (typeof addr === "object" && addr) resolve(addr.port)
                else reject(new Error("no address"))
              })
              server.once("error", reject)
            }),
        )
        try {
          const r = yield* tool.execute(
            {
              host: "127.0.0.1",
              ports: [port, 1], // 1 should be closed unless a listener exists
              timeout_ms: 1000,
              concurrency: 4,
              service_names: false,
            },
            baseCtx,
          )
          expect(r.metadata.open.some((o: { port: number }) => o.port === port)).toBe(true)
          expect(r.metadata.scanned_count).toBe(2)
        } finally {
          yield* Effect.promise<void>(
            () => new Promise((resolve) => server.close(() => resolve(undefined))),
          )
        }
      }),
    ),
  )
})
