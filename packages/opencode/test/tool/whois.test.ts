import { describe, expect, test } from "bun:test"
import { Effect, Exit, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Agent } from "../../src/agent/agent"
import { MessageID, SessionID } from "../../src/session/schema"
import { Tool } from "../../src/tool"
import { WhoisTool, __testing } from "../../src/tool/whois"
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

describe("tool.whois helpers", () => {
  test("classifyQuery: domain", () => {
    expect(__testing.classifyQuery("example.com")).toEqual({ kind: "domain", value: "example.com" })
    expect(__testing.classifyQuery("https://www.example.com/path?x=1")).toEqual({ kind: "domain", value: "example.com" })
    expect(__testing.classifyQuery("WWW.EXAMPLE.COM")).toEqual({ kind: "domain", value: "example.com" })
  })
  test("classifyQuery: IPs and CIDR", () => {
    expect(__testing.classifyQuery("8.8.8.8")).toEqual({ kind: "ip", value: "8.8.8.8" })
    expect(__testing.classifyQuery("192.0.2.0/24")).toEqual({ kind: "ip", value: "192.0.2.0/24" })
    expect(__testing.classifyQuery("2001:db8::1")).toEqual({ kind: "ip", value: "2001:db8::1" })
  })
  test("classifyQuery: ASN", () => {
    expect(__testing.classifyQuery("AS15169")).toEqual({ kind: "asn", value: "AS15169" })
    expect(__testing.classifyQuery("as15169")).toEqual({ kind: "asn", value: "AS15169" })
    expect(__testing.classifyQuery("15169")).toEqual({ kind: "asn", value: "15169" })
  })
  test("findReferral parses standard hop hints", () => {
    expect(__testing.findReferral("ReferralServer: whois://whois.verisign-grs.com")).toEqual({
      host: "whois.verisign-grs.com",
      port: 43,
    })
    expect(__testing.findReferral("Whois Server: whois.iana.org")).toEqual({ host: "whois.iana.org", port: 43 })
    expect(__testing.findReferral("refer:        whois.arin.net")).toEqual({ host: "whois.arin.net", port: 43 })
    expect(__testing.findReferral("Registrar WHOIS Server: whois.example.com:4343")).toEqual({
      host: "whois.example.com",
      port: 4343,
    })
    expect(__testing.findReferral("nothing here")).toBeNull()
  })
  test("parseSummary picks common keys", () => {
    const raw = [
      "% comment",
      "Domain Name: EXAMPLE.COM",
      "Registrar: ICANN",
      "Name Server: NS1.EXAMPLE.NET",
      "Name Server: NS2.EXAMPLE.NET",
      "Random Field: ignored",
      "Country: US",
      "",
    ].join("\n")
    const parsed = __testing.parseSummary(raw)
    expect(parsed["Domain Name"]).toBe("EXAMPLE.COM")
    expect(parsed["Registrar"]).toBe("ICANN")
    expect(parsed["Name Server"]).toEqual(["NS1.EXAMPLE.NET", "NS2.EXAMPLE.NET"])
    expect(parsed["Country"]).toBe("US")
    expect(parsed["Random Field"]).toBeUndefined()
  })
})

describe("tool.whois tool", () => {
  it.live("asks whois permission before opening a TCP connection", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const calls: Array<Parameters<Tool.Context["ask"]>[0]> = []
        const toolInfo = yield* WhoisTool
        const tool = yield* toolInfo.init()
        const exit = yield* Effect.exit(
          tool.execute(
            { query: "example.com", timeout_ms: 500 },
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
        expect(calls[0]!.permission).toBe("whois")
        expect(calls[0]!.patterns).toEqual(["whois.iana.org:43"])
      }),
    ),
  )
})
