import { afterAll, beforeAll, describe, expect } from "bun:test"
import { Effect, Exit, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Agent } from "../../src/agent/agent"
import { MessageID, SessionID } from "../../src/session/schema"
import { Tool } from "../../src/tool"
import { GraphQLTool, __testing as GT } from "../../src/tool/graphql"
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

describe("tool.graphql (unit)", () => {
  it.live("redacts sensitive headers when enabled", () =>
    Effect.sync(() => {
      const out = GT.redactHeaders({ Authorization: "Bearer s3cret", "X-Trace": "abc" }, true)
      expect(out.Authorization).toBe("[redacted]")
      expect(out["X-Trace"]).toBe("abc")
    }),
  )

  it.live("does not redact when disabled", () =>
    Effect.sync(() => {
      const out = GT.redactHeaders({ Authorization: "Bearer s3cret" }, false)
      expect(out.Authorization).toBe("Bearer s3cret")
    }),
  )

  it.live("buildGetUrl encodes query, variables, operationName", () =>
    Effect.sync(() => {
      const url = GT.buildGetUrl(
        "https://api.example.com/graphql",
        "query { user { name } }",
        { name: "octocat" },
        "GetUser",
      )
      const u = new URL(url)
      expect(u.searchParams.get("query")).toBe("query { user { name } }")
      expect(u.searchParams.get("variables")).toBe('{"name":"octocat"}')
      expect(u.searchParams.get("operationName")).toBe("GetUser")
    }),
  )

  it.live("shouldRetry on 5xx and transport errors only", () =>
    Effect.sync(() => {
      expect(GT.shouldRetry({ bytes: 0, text: "", truncated: false, error: "ECONNRESET" })).toBe(true)
      expect(GT.shouldRetry({ bytes: 0, text: "", truncated: false, status: 500 })).toBe(true)
      expect(GT.shouldRetry({ bytes: 0, text: "", truncated: false, status: 503 })).toBe(true)
      expect(GT.shouldRetry({ bytes: 0, text: "", truncated: false, status: 200 })).toBe(false)
      expect(GT.shouldRetry({ bytes: 0, text: "", truncated: false, status: 401 })).toBe(false)
      expect(GT.shouldRetry({ bytes: 0, text: "", truncated: false, status: 429 })).toBe(false)
    }),
  )
})

// ---------------------------------------------------------------------------
// Integration tests against a local Bun server
// ---------------------------------------------------------------------------

let server: ReturnType<typeof Bun.serve> | undefined
let baseUrl = ""
let attemptCounter = 0

beforeAll(() => {
  attemptCounter = 0
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      // Echo route - returns query/variables/operationName in JSON
      if (url.pathname === "/echo") {
        if (req.method === "GET") {
          return new Response(
            JSON.stringify({
              data: {
                received: {
                  query: url.searchParams.get("query"),
                  variables: url.searchParams.get("variables"),
                  operationName: url.searchParams.get("operationName"),
                },
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          )
        }
        const body = await req.json().catch(() => ({}))
        return new Response(JSON.stringify({ data: { received: body } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      }
      // Errors route - returns a typical GraphQL error envelope with HTTP 200
      if (url.pathname === "/errors") {
        return new Response(
          JSON.stringify({
            data: { partial: true },
            errors: [
              { message: "Field 'foo' was not found", path: ["foo"] },
              { message: "Field 'bar' was not found", path: ["bar"] },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        )
      }
      // Auth-required route - checks Authorization header
      if (url.pathname === "/auth") {
        const auth = req.headers.get("authorization") ?? ""
        if (auth !== "Bearer t0ken") {
          return new Response(JSON.stringify({ errors: [{ message: "unauthorized" }] }), {
            status: 401,
            headers: { "Content-Type": "application/json" },
          })
        }
        return new Response(JSON.stringify({ data: { me: { id: 1 } } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      }
      // Flaky route - 503 first 2 attempts, then 200
      if (url.pathname === "/flaky") {
        attemptCounter++
        if (attemptCounter < 3) {
          return new Response("upstream busy", { status: 503 })
        }
        return new Response(JSON.stringify({ data: { ok: true, attempts: attemptCounter } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      }
      // Garbage route - non-JSON 200
      if (url.pathname === "/garbage") {
        return new Response("<!DOCTYPE html>not json", {
          status: 200,
          headers: { "Content-Type": "text/html" },
        })
      }
      return new Response("not found", { status: 404 })
    },
  })
  baseUrl = `http://127.0.0.1:${server.port}`
})

afterAll(() => {
  server?.stop(true)
})

describe("tool.graphql (integration)", () => {
  it.live("asks graphql permission before sending a request", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const calls: Array<Parameters<Tool.Context["ask"]>[0]> = []
        const toolInfo = yield* GraphQLTool
        const tool = yield* toolInfo.init()
        const exit = yield* Effect.exit(
          tool.execute(
            {
              url: `${baseUrl}/echo`,
              query: "{ ping }",
            },
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
        expect(calls[0]!.permission).toBe("graphql")
        expect(calls[0]!.patterns).toEqual([`POST ${baseUrl}/echo`])
        expect(calls[0]!.always).toEqual([`POST ${baseUrl}/echo`])
      }),
    ),
  )

  it.live("POST echoes back query and variables", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* GraphQLTool
        const tool = yield* toolInfo.init()
        const result = yield* tool.execute(
          {
            url: `${baseUrl}/echo`,
            query: "query Hello($n:String!){ greet(name:$n) }",
            variables: { n: "world" },
            operation_name: "Hello",
          },
          baseCtx,
        )
        expect(result.metadata.ok).toBe(true)
        expect(result.metadata.status).toBe(200)
        expect(result.metadata.has_data).toBe(true)
        expect(result.metadata.has_errors).toBe(false)
        expect(result.output).toContain("Hello")
      }),
    ),
  )

  it.live("GET method packs query into URL", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* GraphQLTool
        const tool = yield* toolInfo.init()
        const result = yield* tool.execute(
          {
            url: `${baseUrl}/echo`,
            query: "{ ping }",
            method: "GET",
          },
          baseCtx,
        )
        expect(result.metadata.method).toBe("GET")
        expect(result.metadata.status).toBe(200)
      }),
    ),
  )

  it.live("graphql errors flip ok=false by default", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* GraphQLTool
        const tool = yield* toolInfo.init()
        const result = yield* tool.execute(
          { url: `${baseUrl}/errors`, query: "{ foo bar }" },
          baseCtx,
        )
        expect(result.metadata.status).toBe(200)
        expect(result.metadata.has_errors).toBe(true)
        expect(result.metadata.error_count).toBe(2)
        expect(result.metadata.ok).toBe(false)
        expect(result.metadata.error_messages?.[0]).toContain("foo")
      }),
    ),
  )

  it.live("fail_on_graphql_errors=false keeps ok=true with partial data", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* GraphQLTool
        const tool = yield* toolInfo.init()
        const result = yield* tool.execute(
          { url: `${baseUrl}/errors`, query: "{ foo bar }", fail_on_graphql_errors: false },
          baseCtx,
        )
        expect(result.metadata.has_errors).toBe(true)
        expect(result.metadata.ok).toBe(true)
        expect(result.metadata.has_data).toBe(true)
      }),
    ),
  )

  it.live("auth_bearer adds Authorization header", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* GraphQLTool
        const tool = yield* toolInfo.init()
        const ok = yield* tool.execute(
          { url: `${baseUrl}/auth`, query: "{ me { id } }", auth_bearer: "t0ken" },
          baseCtx,
        )
        expect(ok.metadata.status).toBe(200)
        expect(ok.metadata.ok).toBe(true)
        // The redacted header should appear as [redacted] in metadata
        expect(ok.metadata.request_headers?.Authorization).toBe("[redacted]")

        const fail = yield* tool.execute(
          { url: `${baseUrl}/auth`, query: "{ me { id } }", auth_bearer: "wrong" },
          baseCtx,
        )
        expect(fail.metadata.status).toBe(401)
        expect(fail.metadata.ok).toBe(false)
      }),
    ),
  )

  it.live("max_retries on 5xx eventually succeeds", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        attemptCounter = 0
        const toolInfo = yield* GraphQLTool
        const tool = yield* toolInfo.init()
        const result = yield* tool.execute(
          {
            url: `${baseUrl}/flaky`,
            query: "{ ok }",
            max_retries: 3,
            retry_delay_ms: 5,
          },
          baseCtx,
        )
        expect(result.metadata.ok).toBe(true)
        expect(result.metadata.attempts).toBeGreaterThanOrEqual(3)
        expect(result.metadata.status).toBe(200)
      }),
    ),
  )

  it.live("non-JSON response surfaces parse error", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* GraphQLTool
        const tool = yield* toolInfo.init()
        const result = yield* tool.execute(
          { url: `${baseUrl}/garbage`, query: "{ x }" },
          baseCtx,
        )
        expect(result.metadata.status).toBe(200)
        expect(result.metadata.ok).toBe(false)
        expect(result.output).toContain("response not JSON")
      }),
    ),
  )
})
