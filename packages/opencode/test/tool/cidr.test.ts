import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Agent } from "../../src/agent/agent"
import { MessageID, SessionID } from "../../src/session/schema"
import { Tool } from "../../src/tool"
import { CidrTool, __testing } from "../../src/tool/cidr"
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

describe("tool.cidr helpers", () => {
  test("parseIP IPv4", () => {
    expect(__testing.parseIP("192.168.1.1")?.family).toBe("ipv4")
    expect(__testing.parseIP("256.1.1.1")).toBeNull()
    expect(__testing.parseIP("not-an-ip")).toBeNull()
  })
  test("parseIP IPv6", () => {
    const a = __testing.parseIP("::1")
    expect(a?.family).toBe("ipv6")
    expect(a?.n).toBe(1n)
    expect(__testing.parseIP("2001:db8::1")?.family).toBe("ipv6")
    expect(__testing.parseIP("::ffff:192.168.1.1")?.family).toBe("ipv6")
    expect(__testing.parseIP("fe80::1")?.family).toBe("ipv6")
    expect(__testing.parseIP("2001::db8::1")).toBeNull()
  })
  test("ipv6 expand & compress round-trip", () => {
    const ip = __testing.parseIP("2001:db8:0:0:0:0:0:1")!
    expect(__testing.ipv6Expand(ip.n)).toBe("2001:0db8:0000:0000:0000:0000:0000:0001")
    expect(__testing.ipv6Compress(ip.n)).toBe("2001:db8::1")
  })
  test("parseCIDR", () => {
    const c = __testing.parseCIDR("192.168.1.0/24")!
    expect(c.prefix).toBe(24)
    expect(__testing.parseCIDR("192.168.1.0/33")).toBeNull()
    expect(__testing.parseCIDR("::1/128")?.prefix).toBe(128)
  })
  test("network/broadcast/total/usable", () => {
    const c = __testing.parseCIDR("10.0.0.5/24")!
    expect(__testing.ipToString({ family: "ipv4", n: __testing.networkAddr(c) })).toBe("10.0.0.0")
    expect(__testing.ipToString({ family: "ipv4", n: __testing.broadcastAddr(c) })).toBe("10.0.0.255")
    expect(__testing.totalHosts(c)).toBe(256n)
    expect(__testing.usableHosts(c)).toBe(254n)
    const p2p = __testing.parseCIDR("10.0.0.0/31")!
    expect(__testing.usableHosts(p2p)).toBe(2n)
  })
  test("split subnets", () => {
    const c = __testing.parseCIDR("10.0.0.0/24")!
    const subs = __testing.splitSubnets(c, 26)
    expect(subs).toEqual(["10.0.0.0/26", "10.0.0.64/26", "10.0.0.128/26", "10.0.0.192/26"])
  })
  test("summarize coalesces & emits aggregates", () => {
    const r = __testing.summarizeCIDRs([
      __testing.parseCIDR("10.0.0.0/25")!,
      __testing.parseCIDR("10.0.0.128/25")!,
    ])
    expect(r).toEqual(["10.0.0.0/24"])
    const r2 = __testing.summarizeCIDRs([
      __testing.parseCIDR("10.0.0.0/24")!,
      __testing.parseCIDR("10.0.2.0/24")!,
    ])
    expect(r2).toEqual(["10.0.0.0/24", "10.0.2.0/24"])
  })
  test("scope classification", () => {
    expect(__testing.ipv4Scope(__testing.parseIP("10.0.0.1")!.n)).toBe("private (RFC1918)")
    expect(__testing.ipv4Scope(__testing.parseIP("8.8.8.8")!.n)).toBe("public")
    expect(__testing.ipv4Scope(__testing.parseIP("127.0.0.1")!.n)).toBe("loopback")
    expect(__testing.ipv6Scope(__testing.parseIP("fe80::1")!.n)).toBe("link-local")
    expect(__testing.ipv6Scope(__testing.parseIP("fc00::1")!.n)).toBe("unique-local (ULA)")
    expect(__testing.ipv6Scope(__testing.parseIP("ff02::1")!.n)).toBe("multicast")
    expect(__testing.ipv6Scope(__testing.parseIP("2606:4700::1")!.n)).toBe("public (global unicast)")
  })
})

describe("tool.cidr tool", () => {
  it.live("parse returns full record", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* CidrTool
        const tool = yield* toolInfo.init()
        const r = yield* tool.execute({ action: "parse", value: "192.168.1.0/24" }, baseCtx)
        const m = r.metadata.result as any
        expect(m.family).toBe("ipv4")
        expect(m.network).toBe("192.168.1.0")
        expect(m.broadcast).toBe("192.168.1.255")
        expect(m.first_host).toBe("192.168.1.1")
        expect(m.last_host).toBe("192.168.1.254")
        expect(m.usable_hosts).toBe("254")
      }),
    ),
  )
  it.live("contains", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* CidrTool
        const tool = yield* toolInfo.init()
        const r = yield* tool.execute(
          { action: "contains", value: "10.0.0.0/8", target: "10.1.2.3" },
          baseCtx,
        )
        expect(r.metadata.result).toBe(true)
        const r2 = yield* tool.execute(
          { action: "contains", value: "10.0.0.0/8", target: "11.1.2.3" },
          baseCtx,
        )
        expect(r2.metadata.result).toBe(false)
      }),
    ),
  )
  it.live("overlaps", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* CidrTool
        const tool = yield* toolInfo.init()
        const r = yield* tool.execute(
          { action: "overlaps", value: "10.0.0.0/24", target: "10.0.0.128/25" },
          baseCtx,
        )
        expect(r.metadata.result).toBe(true)
      }),
    ),
  )
  it.live("subnets enumerates correctly", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* CidrTool
        const tool = yield* toolInfo.init()
        const r = yield* tool.execute({ action: "subnets", value: "10.0.0.0/24", new_prefix: 26 }, baseCtx)
        expect((r.metadata.result as string[]).length).toBe(4)
      }),
    ),
  )
  it.live("supernet", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* CidrTool
        const tool = yield* toolInfo.init()
        const r = yield* tool.execute({ action: "supernet", value: "10.0.1.0/24", new_prefix: 16 }, baseCtx)
        expect(r.metadata.result).toBe("10.0.0.0/16")
      }),
    ),
  )
  it.live("is_private/is_public", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* CidrTool
        const tool = yield* toolInfo.init()
        const a = yield* tool.execute({ action: "is_private", value: "10.0.0.5" }, baseCtx)
        expect((a.metadata.result as any).result).toBe(true)
        const b = yield* tool.execute({ action: "is_public", value: "8.8.8.8" }, baseCtx)
        expect((b.metadata.result as any).result).toBe(true)
      }),
    ),
  )
  it.live("expand/compress IPv6", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* CidrTool
        const tool = yield* toolInfo.init()
        const ex = yield* tool.execute({ action: "expand", value: "2001:db8::1" }, baseCtx)
        expect(ex.metadata.result).toBe("2001:0db8:0000:0000:0000:0000:0000:0001")
        const cm = yield* tool.execute(
          { action: "compress", value: "2001:0db8:0000:0000:0000:0000:0000:0001" },
          baseCtx,
        )
        expect(cm.metadata.result).toBe("2001:db8::1")
      }),
    ),
  )
  it.live("from_int/to_int round-trip", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* CidrTool
        const tool = yield* toolInfo.init()
        const a = yield* tool.execute({ action: "to_int", value: "1.2.3.4" }, baseCtx)
        expect(a.metadata.result).toBe(String((1 << 24) | (2 << 16) | (3 << 8) | 4))
        const b = yield* tool.execute(
          { action: "from_int", value: a.metadata.result as string, family: "ipv4" },
          baseCtx,
        )
        expect(b.metadata.result).toBe("1.2.3.4")
      }),
    ),
  )
  it.live("validate", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* CidrTool
        const tool = yield* toolInfo.init()
        const a = yield* tool.execute({ action: "validate", value: "10.0.0.1", kind: "ip" }, baseCtx)
        expect(a.metadata.result).toBe(true)
        const b = yield* tool.execute({ action: "validate", value: "10.0.0.1/24", kind: "cidr" }, baseCtx)
        expect(b.metadata.result).toBe(true)
        const c = yield* tool.execute({ action: "validate", value: "10.0.0.1", kind: "cidr" }, baseCtx)
        expect(c.metadata.result).toBe(false)
      }),
    ),
  )
})
