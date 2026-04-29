import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Agent } from "../../src/agent/agent"
import { MessageID, SessionID } from "../../src/session/schema"
import { Tool } from "../../src/tool"
import { UrlTool, __testing } from "../../src/tool/url"
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

describe("tool.url helpers", () => {
  test("toParts breaks down URL", () => {
    const u = new URL("https://user:pw@api.example.com:8443/v1/users?role=admin&active=1#top")
    const p = __testing.toParts(u)
    expect(p.protocol).toBe("https")
    expect(p.hostname).toBe("api.example.com")
    expect(p.port).toBe("8443")
    expect(p.pathname).toBe("/v1/users")
    expect(p.searchParams.role).toBe("admin")
    expect(p.searchParams.active).toBe("1")
    expect(p.hash).toBe("#top")
    expect(p.username).toBe("user")
    expect(p.password).toBe("pw")
  })

  test("normalize lowercases scheme/host, drops default ports, sorts params", () => {
    const out = __testing.normalize("HTTPS://EXAMPLE.com:443/Path/?b=2&a=1")
    expect(out).toBe("https://example.com/Path/?a=1&b=2")
  })

  test("normalize preserves non-default port", () => {
    const out = __testing.normalize("https://example.com:8443/")
    expect(out).toBe("https://example.com:8443/")
  })

  test("normalize keeps stable order of duplicate keys", () => {
    const out = __testing.normalize("https://example.com/?a=1&b=2&a=3")
    expect(out).toBe("https://example.com/?a=1&a=3&b=2")
  })

  test("buildUrl assembles parts", () => {
    const out = __testing.buildUrl({
      protocol: "https",
      host: "example.com",
      path: "/x",
      query: { q: "hi", n: 2 },
    })
    expect(out.startsWith("https://example.com/x?")).toBe(true)
    const u = new URL(out)
    expect(u.searchParams.get("q")).toBe("hi")
    expect(u.searchParams.get("n")).toBe("2")
  })

  test("buildUrl with port and fragment", () => {
    const out = __testing.buildUrl({
      protocol: "http",
      hostname: "h",
      port: 8080,
      pathname: "/a",
      fragment: "section",
    })
    expect(out).toBe("http://h:8080/a#section")
  })
})

describe("tool.url tool", () => {
  it.live("parse returns parts", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* UrlTool
        const tool = yield* toolInfo.init()
        const r = yield* tool.execute(
          { action: "parse", value: "https://api.example.com/v1/users?role=admin&active=1#top" },
          baseCtx,
        )
        expect(r.metadata.parts?.hostname).toBe("api.example.com")
        expect(r.metadata.parts?.searchParams.role).toBe("admin")
      }),
    ),
  )

  it.live("set_query adds and removes keys", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* UrlTool
        const tool = yield* toolInfo.init()
        const r = yield* tool.execute(
          { action: "set_query", value: "https://example.com/?a=1", params: { b: "2", a: null } },
          baseCtx,
        )
        const u = new URL(r.metadata.url!)
        expect(u.searchParams.get("a")).toBe(null)
        expect(u.searchParams.get("b")).toBe("2")
      }),
    ),
  )

  it.live("get_query returns repeated values as arrays", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* UrlTool
        const tool = yield* toolInfo.init()
        const r = yield* tool.execute(
          { action: "get_query", value: "https://e.com/?a=1&b=2&a=3", keys: ["a", "b", "missing"] },
          baseCtx,
        )
        expect(r.metadata.values?.a).toEqual(["1", "3"])
        expect(r.metadata.values?.b).toEqual(["2"])
        expect(r.metadata.values?.missing).toEqual([])
      }),
    ),
  )

  it.live("remove_query strips keys", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* UrlTool
        const tool = yield* toolInfo.init()
        const r = yield* tool.execute(
          { action: "remove_query", value: "https://e.com/?a=1&b=2&c=3", keys: ["a", "c"] },
          baseCtx,
        )
        const u = new URL(r.metadata.url!)
        expect(u.searchParams.get("a")).toBe(null)
        expect(u.searchParams.get("b")).toBe("2")
        expect(u.searchParams.get("c")).toBe(null)
      }),
    ),
  )

  it.live("normalize via tool", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* UrlTool
        const tool = yield* toolInfo.init()
        const r = yield* tool.execute(
          { action: "normalize", value: "HTTPS://Example.com:443/Path/?b=2&a=1" },
          baseCtx,
        )
        expect(r.metadata.url).toBe("https://example.com/Path/?a=1&b=2")
      }),
    ),
  )

  it.live("join resolves relative", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* UrlTool
        const tool = yield* toolInfo.init()
        const r = yield* tool.execute(
          { action: "join", base: "https://example.com/foo/bar", value: "../baz" },
          baseCtx,
        )
        expect(r.metadata.url).toBe("https://example.com/baz")
      }),
    ),
  )

  it.live("encode and decode round-trip", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* UrlTool
        const tool = yield* toolInfo.init()
        const enc = yield* tool.execute({ action: "encode", value: "a b&c=d" }, baseCtx)
        expect(enc.metadata.value).toBe("a%20b%26c%3Dd")
        const dec = yield* tool.execute({ action: "decode", value: enc.metadata.value as string }, baseCtx)
        expect(dec.metadata.value).toBe("a b&c=d")
      }),
    ),
  )

  it.live("build via tool", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* UrlTool
        const tool = yield* toolInfo.init()
        const r = yield* tool.execute(
          {
            action: "build",
            parts: { protocol: "https", host: "example.com", path: "/users", query: { id: 7, name: "alice bob" } },
          },
          baseCtx,
        )
        const u = new URL(r.metadata.url!)
        expect(u.hostname).toBe("example.com")
        expect(u.searchParams.get("id")).toBe("7")
        expect(u.searchParams.get("name")).toBe("alice bob")
      }),
    ),
  )
})
