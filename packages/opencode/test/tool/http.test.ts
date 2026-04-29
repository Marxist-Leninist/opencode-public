import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Agent } from "../../src/agent/agent"
import { MessageID, SessionID } from "../../src/session/schema"
import { Tool } from "../../src/tool"
import { HttpTool, __testing } from "../../src/tool/http"
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

// Minimal local HTTP test server using Bun.serve so we don't depend on the public internet.
let server: ReturnType<typeof Bun.serve> | undefined
let baseUrl = ""

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      if (url.pathname === "/echo") {
        const text = await req.text()
        return new Response(
          JSON.stringify({
            method: req.method,
            url: req.url,
            headers: Object.fromEntries(req.headers.entries()),
            body: text,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        )
      }
      if (url.pathname === "/json") {
        return new Response(JSON.stringify({ ok: true, n: 42 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      }
      if (url.pathname === "/text") {
        return new Response("plain text body", {
          status: 200,
          headers: { "Content-Type": "text/plain" },
        })
      }
      if (url.pathname === "/notfound") {
        return new Response("missing", { status: 404 })
      }
      if (url.pathname === "/binary") {
        const buf = new Uint8Array([0x00, 0x01, 0x02, 0xff])
        return new Response(buf, { status: 200, headers: { "Content-Type": "application/octet-stream" } })
      }
      return new Response("ok", { status: 200 })
    },
  })
  baseUrl = `http://127.0.0.1:${(server as any).port}`
})

afterAll(() => {
  server?.stop(true)
})

describe("tool.http helpers", () => {
  test("normalizeMethod uppercases", () => {
    expect(__testing.normalizeMethod("post")).toBe("POST")
    expect(() => __testing.normalizeMethod("invent")).toThrow()
  })

  test("appendQuery merges params", () => {
    const url = __testing.appendQuery("https://x.com/y?z=1", { a: "b", c: "d" })
    expect(url).toContain("z=1")
    expect(url).toContain("a=b")
    expect(url).toContain("c=d")
  })

  test("encodeForm produces application/x-www-form-urlencoded", () => {
    expect(__testing.encodeForm({ a: "b c", x: "1" })).toBe("a=b+c&x=1")
  })

  test("buildBody json sets Content-Type when missing", () => {
    const headers: Record<string, string> = {}
    const result = __testing.buildBody({ a: 1 }, "json", headers)
    expect(headers["Content-Type"]).toBe("application/json")
    expect(result.body).toBe('{"a":1}')
  })

  test("buildBody preserves explicit Content-Type", () => {
    const headers: Record<string, string> = { "content-type": "application/vnd.api+json" }
    const result = __testing.buildBody({ a: 1 }, "json", headers)
    // Ensure we did not duplicate or override the case-insensitively-existing header.
    expect(headers["content-type"]).toBe("application/vnd.api+json")
    expect(result.body).toBe('{"a":1}')
  })

  test("applyAuth bearer", () => {
    const h: Record<string, string> = {}
    __testing.applyAuth(h, { type: "bearer", token: "abc" })
    expect(h["Authorization"]).toBe("Bearer abc")
  })

  test("applyAuth basic encodes to base64", () => {
    const h: Record<string, string> = {}
    __testing.applyAuth(h, { type: "basic", username: "u", password: "p" })
    expect(h["Authorization"]).toBe("Basic " + Buffer.from("u:p").toString("base64"))
  })

  test("statusAccepted defaults to 2xx", () => {
    expect(__testing.statusAccepted(200, [])).toBe(true)
    expect(__testing.statusAccepted(404, [])).toBe(false)
    expect(__testing.statusAccepted(404, [200, 404])).toBe(true)
    expect(__testing.statusAccepted(401, [100, 999])).toBe(true)
  })

  test("looksLikeJson", () => {
    expect(__testing.looksLikeJson("application/json")).toBe(true)
    expect(__testing.looksLikeJson("application/vnd.api+json; charset=utf-8")).toBe(true)
    expect(__testing.looksLikeJson("text/plain")).toBe(false)
    expect(__testing.looksLikeJson(null)).toBe(false)
  })

  test("sanitizeHeaders redacts auth", () => {
    const out = __testing.sanitizeHeaders({ Authorization: "Bearer x", "X-Foo": "bar" })
    expect(out.Authorization).toBe("<redacted>")
    expect(out["X-Foo"]).toBe("bar")
  })
})

describe("tool.http tool", () => {
  it.live("GET returns text body", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* HttpTool
        const tool = yield* toolInfo.init()
        const result = yield* tool.execute({ method: "GET", url: `${baseUrl}/text` }, baseCtx)
        expect(result.metadata.status).toBe(200)
        expect(result.output).toBe("plain text body")
        expect(result.metadata.parsed_as).toBe("text")
      }),
    ),
  )

  it.live("GET parses JSON automatically", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* HttpTool
        const tool = yield* toolInfo.init()
        const result = yield* tool.execute({ method: "GET", url: `${baseUrl}/json` }, baseCtx)
        expect(result.metadata.status).toBe(200)
        expect(result.metadata.parsed_as).toBe("json")
        expect(JSON.parse(result.output)).toEqual({ ok: true, n: 42 })
      }),
    ),
  )

  it.live("POST with JSON body sends Content-Type", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* HttpTool
        const tool = yield* toolInfo.init()
        const result = yield* tool.execute(
          { method: "POST", url: `${baseUrl}/echo`, body: { hello: "world" } },
          baseCtx,
        )
        expect(result.metadata.status).toBe(200)
        const echoed = JSON.parse(result.output)
        expect(echoed.method).toBe("POST")
        expect(echoed.headers["content-type"]).toBe("application/json")
        expect(JSON.parse(echoed.body)).toEqual({ hello: "world" })
      }),
    ),
  )

  it.live("POST form encodes object", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* HttpTool
        const tool = yield* toolInfo.init()
        const result = yield* tool.execute(
          {
            method: "POST",
            url: `${baseUrl}/echo`,
            body: { user: "u", pass: "p" },
            body_type: "form",
          },
          baseCtx,
        )
        const echoed = JSON.parse(result.output)
        expect(echoed.headers["content-type"]).toBe("application/x-www-form-urlencoded")
        expect(echoed.body).toBe("user=u&pass=p")
      }),
    ),
  )

  it.live("bearer auth sets Authorization header", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* HttpTool
        const tool = yield* toolInfo.init()
        const result = yield* tool.execute(
          { method: "GET", url: `${baseUrl}/echo`, auth: { type: "bearer", token: "sk-test" } },
          baseCtx,
        )
        const echoed = JSON.parse(result.output)
        expect(echoed.headers.authorization).toBe("Bearer sk-test")
        // The metadata's request_headers echo should redact it.
        expect(result.metadata.request_headers["Authorization"]).toBe("<redacted>")
      }),
    ),
  )

  it.live("query params merged into URL", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* HttpTool
        const tool = yield* toolInfo.init()
        const result = yield* tool.execute(
          { method: "GET", url: `${baseUrl}/echo`, query: { a: "1", b: "two words" } },
          baseCtx,
        )
        const echoed = JSON.parse(result.output)
        expect(echoed.url).toContain("a=1")
        expect(echoed.url).toContain("b=two+words")
      }),
    ),
  )

  it.live("non-2xx status throws by default", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* HttpTool
        const tool = yield* toolInfo.init()
        const exit = yield* Effect.exit(
          tool.execute({ method: "GET", url: `${baseUrl}/notfound` }, baseCtx),
        )
        expect(exit._tag).toBe("Failure")
      }),
    ),
  )

  it.live("accept_status allows 404", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* HttpTool
        const tool = yield* toolInfo.init()
        const result = yield* tool.execute(
          { method: "GET", url: `${baseUrl}/notfound`, accept_status: [200, 404] },
          baseCtx,
        )
        expect(result.metadata.status).toBe(404)
        expect(result.output).toBe("missing")
      }),
    ),
  )

  it.live("raw_base64 returns binary as base64", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* HttpTool
        const tool = yield* toolInfo.init()
        const result = yield* tool.execute(
          { method: "GET", url: `${baseUrl}/binary`, parse_response: "raw_base64" },
          baseCtx,
        )
        expect(result.metadata.response_bytes).toBe(4)
        expect(Buffer.from(result.output, "base64").toString("hex")).toBe("000102ff")
      }),
    ),
  )

  it.live("max_response_bytes truncates body", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* HttpTool
        const tool = yield* toolInfo.init()
        const result = yield* tool.execute(
          {
            method: "GET",
            url: `${baseUrl}/text`,
            max_response_bytes: 4,
            parse_response: "text",
          },
          baseCtx,
        )
        expect(result.metadata.truncated_response).toBe(true)
        expect(result.metadata.response_bytes).toBeLessThanOrEqual(4)
      }),
    ),
  )

  it.live("rejects non-http URL", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* HttpTool
        const tool = yield* toolInfo.init()
        const exit = yield* Effect.exit(
          tool.execute({ method: "GET", url: "ftp://example.com/x" }, baseCtx),
        )
        expect(exit._tag).toBe("Failure")
      }),
    ),
  )
})
