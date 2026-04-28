import { test, expect, mock, beforeEach } from "bun:test"
import { Effect } from "effect"
import type { MCP as MCPNS } from "../../src/mcp/index"

interface MockClientState {
  tools: Array<{ name: string; description?: string; inputSchema: object }>
  notificationHandlers: Map<unknown, (...args: any[]) => any>
  closed: boolean
  callToolCalls: Array<{ name: string; arguments?: Record<string, unknown> }>
  // If set, the next callTool invocation throws this error instead of returning a result.
  failNext?: Error
  // If true, every callTool throws.
  alwaysFail?: boolean
}

const clientStates = new Map<string, MockClientState>()
let lastCreatedClientName: string | undefined

function getOrCreateClientState(name?: string): MockClientState {
  const key = name ?? "default"
  let state = clientStates.get(key)
  if (!state) {
    state = {
      tools: [],
      notificationHandlers: new Map(),
      closed: false,
      callToolCalls: [],
    }
    clientStates.set(key, state)
  }
  return state
}

class MockStdioTransport {
  stderr: null = null
  pid = 12345
  // oxlint-disable-next-line no-useless-constructor
  constructor(_opts: any) {}
  async start() {}
  async close() {}
}

class MockStreamableHTTP {
  // oxlint-disable-next-line no-useless-constructor
  constructor(_url: URL, _opts?: any) {}
  async start() {}
  async close() {}
  async finishAuth() {}
}

class MockSSE {
  // oxlint-disable-next-line no-useless-constructor
  constructor(_url: URL, _opts?: any) {}
  async start() {}
  async close() {}
}

void mock.module("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: MockStdioTransport,
}))

void mock.module("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: MockStreamableHTTP,
}))

void mock.module("@modelcontextprotocol/sdk/client/sse.js", () => ({
  SSEClientTransport: MockSSE,
}))

void mock.module("@modelcontextprotocol/sdk/client/auth.js", () => ({
  UnauthorizedError: class extends Error {
    constructor() {
      super("Unauthorized")
    }
  },
}))

void mock.module("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class MockClient {
    _state!: MockClientState
    transport: any
    // oxlint-disable-next-line no-useless-constructor
    constructor(_opts: any) {}

    async connect(transport: { start: () => Promise<void> }) {
      this.transport = transport
      await transport.start()
      this._state = getOrCreateClientState(lastCreatedClientName)
    }

    setNotificationHandler(schema: unknown, handler: (...args: any[]) => any) {
      this._state?.notificationHandlers.set(schema, handler)
    }

    async listTools() {
      return { tools: this._state?.tools ?? [] }
    }

    async listPrompts() {
      return { prompts: [] }
    }

    async listResources() {
      return { resources: [] }
    }

    async callTool(req: { name: string; arguments?: Record<string, unknown> }) {
      this._state?.callToolCalls.push(req)
      if (this._state?.alwaysFail) {
        throw new Error(`mock client always fails`)
      }
      if (this._state?.failNext) {
        const err = this._state.failNext
        this._state.failNext = undefined
        throw err
      }
      return { content: [{ type: "text", text: `called ${req.name}` }] }
    }

    async close() {
      if (this._state) this._state.closed = true
    }
  },
}))

beforeEach(() => {
  clientStates.clear()
  lastCreatedClientName = undefined
})

const { MCP } = await import("../../src/mcp/index")
const { Instance } = await import("../../src/project/instance")
const { tmpdir } = await import("../fixture/fixture")

function withInstance(
  config: Record<string, unknown>,
  fn: (mcp: MCPNS.Interface) => Effect.Effect<void, unknown, never>,
  experimental?: Record<string, unknown>,
) {
  return async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          `${dir}/opencode.json`,
          JSON.stringify({
            $schema: "https://opencode.ai/config.json",
            mcp: config,
            ...(experimental ? { experimental } : {}),
          }),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await Effect.runPromise(MCP.Service.use(fn).pipe(Effect.provide(MCP.defaultLayer)))
        await Instance.dispose()
      },
    })
  }
}

async function execTool(tool: any, args: unknown) {
  expect(tool).toBeDefined()
  expect(typeof tool.execute).toBe("function")
  return tool.execute(args, { toolCallId: "test", messages: [], abortSignal: undefined as any })
}

function parseJsonResult(result: any): any {
  const text = result?.content?.[0]?.text
  expect(typeof text).toBe("string")
  return JSON.parse(text)
}

// --- Pure unit tests for searchDeferredToolDefinitions ---

test("searchDeferredToolDefinitions ranks exact tool name matches highest", () => {
  const defs = {
    big: [
      { name: "create_issue", description: "Create a GitHub issue", inputSchema: { type: "object" } },
      { name: "delete_issue", description: "Delete a GitHub issue", inputSchema: { type: "object" } },
      { name: "list_repos", description: "List repos", inputSchema: { type: "object" } },
    ],
  }
  const matches = MCP.searchDeferredToolDefinitions({
    defs: defs as any,
    selected: {},
    servers: ["big"],
    query: "create_issue",
  })
  expect(matches[0].name).toBe("create_issue")
  expect(matches[0].tool).toBe("big_create_issue")
  expect(matches[0].loaded).toBe(false)
})

test("searchDeferredToolDefinitions filters by server name", () => {
  const defs = {
    a: [{ name: "ping", description: "", inputSchema: { type: "object" } }],
    b: [{ name: "ping", description: "", inputSchema: { type: "object" } }],
  }
  const matches = MCP.searchDeferredToolDefinitions({
    defs: defs as any,
    selected: {},
    servers: ["a", "b"],
    server: "b",
  })
  expect(matches).toHaveLength(1)
  expect(matches[0].server).toBe("b")
})

test("searchDeferredToolDefinitions caps results at the requested limit", () => {
  const defs = {
    big: Array.from({ length: 30 }, (_, i) => ({
      name: `tool_${i}`,
      description: "",
      inputSchema: { type: "object" },
    })),
  }
  const matches = MCP.searchDeferredToolDefinitions({
    defs: defs as any,
    selected: {},
    servers: ["big"],
    limit: 5,
  })
  expect(matches).toHaveLength(5)
})

test("searchDeferredToolDefinitions reports loaded flag from selected sets", () => {
  const defs = {
    big: [
      { name: "alpha", description: "", inputSchema: { type: "object" } },
      { name: "beta", description: "", inputSchema: { type: "object" } },
    ],
  }
  const matches = MCP.searchDeferredToolDefinitions({
    defs: defs as any,
    selected: { big: new Set(["alpha"]) },
    servers: ["big"],
    query: "alpha",
  })
  expect(matches).toHaveLength(1)
  expect(matches[0].loaded).toBe(true)
})

test("searchDeferredToolDefinitions dedupes SG1 and SG2 mirror tools", () => {
  const defs = {
    sg1: [{ name: "memory_search", description: "Search memory", inputSchema: { type: "object" } }],
    sg2: [{ name: "memory_search", description: "Search memory", inputSchema: { type: "object" } }],
  }
  const matches = MCP.searchDeferredToolDefinitions({
    defs: defs as any,
    selected: {},
    servers: ["sg1", "sg2"],
    query: "memory",
    limit: 5,
  })
  expect(matches).toHaveLength(1)
  expect(matches[0].tool).toBe("sg2_memory_search")
})

test("searchDeferredToolDefinitions enforces +required tokens", () => {
  const defs = {
    big: [
      { name: "memory_tags", description: "Memory tags", inputSchema: { type: "object" } },
      { name: "vault_tags", description: "Vault tags", inputSchema: { type: "object" } },
    ],
  }
  const matches = MCP.searchDeferredToolDefinitions({
    defs: defs as any,
    selected: {},
    servers: ["big"],
    query: "tags",
    required: ["memory"],
  })
  expect(matches).toHaveLength(1)
  expect(matches[0].name).toBe("memory_tags")
})

// --- Pure unit tests for parseDeferredSearchQuery ---

test("parseDeferredSearchQuery extracts select: ids", () => {
  const parsed = MCP.parseDeferredSearchQuery("select:srv_one,srv_two")
  expect(parsed.select).toEqual(["srv_one", "srv_two"])
  expect(parsed.required).toEqual([])
  expect(parsed.query).toBeUndefined()
})

test("parseDeferredSearchQuery extracts +required tokens", () => {
  const parsed = MCP.parseDeferredSearchQuery("+memory tags labels")
  expect(parsed.select).toEqual([])
  expect(parsed.required).toEqual(["memory"])
  expect(parsed.query).toBe("tags labels")
})

test("parseDeferredSearchQuery handles mixed forms", () => {
  const parsed = MCP.parseDeferredSearchQuery("+memory +tags select:srv_one labels")
  expect(parsed.select).toEqual(["srv_one"])
  expect(parsed.required).toEqual(["memory", "tags"])
  expect(parsed.query).toBe("labels")
})

test("parseDeferredSearchQuery handles empty input", () => {
  const empty = MCP.parseDeferredSearchQuery(undefined)
  expect(empty.select).toEqual([])
  expect(empty.required).toEqual([])
  expect(empty.query).toBeUndefined()
})

// --- Integration tests via the live MCP layer ---

test(
  "deferred server only exposes mcp_search until matches are auto-loaded",
  withInstance(
    {
      "big-server": {
        type: "local",
        command: ["echo", "test"],
        defer: true,
      },
    },
    (mcp) =>
      Effect.gen(function* () {
        lastCreatedClientName = "big-server"
        const state = getOrCreateClientState("big-server")
        state.tools = [
          { name: "create_issue", description: "Create an issue", inputSchema: { type: "object", properties: {} } },
          { name: "delete_issue", description: "Delete an issue", inputSchema: { type: "object", properties: {} } },
          { name: "list_repos", description: "List repos", inputSchema: { type: "object", properties: {} } },
        ]

        const addResult = yield* mcp.add("big-server", {
          type: "local",
          command: ["echo", "test"],
          defer: true,
        })
        expect((addResult.status as any)["big-server"]?.status ?? (addResult.status as any).status).toBe("connected")

        const toolsBefore = yield* mcp.tools()
        // Only the search tool; no separate mcp_load.
        expect(Object.keys(toolsBefore).sort()).toEqual(["mcp_search"])

        const search = (toolsBefore as any).mcp_search
        const searchResult = yield* Effect.tryPromise(() => execTool(search, { query: "create", limit: 1 }))
        const parsed = parseJsonResult(searchResult)
        expect(parsed.loaded).toEqual(["big-server_create_issue"])
        expect(parsed.matches[0].tool).toBe("big-server_create_issue")

        const toolsAfter = yield* mcp.tools()
        const afterKeys = Object.keys(toolsAfter).sort()
        expect(afterKeys).toContain("mcp_search")
        expect(afterKeys).toContain("big-server_create_issue")
        expect(afterKeys).not.toContain("big-server_delete_issue")
      }),
  ),
)

test(
  "mcp_search treats SG1 and SG2 as mirror endpoints",
  withInstance(
    {
      sg1: {
        type: "local",
        command: ["echo", "test"],
        defer: true,
      },
      sg2: {
        type: "local",
        command: ["echo", "test"],
        defer: true,
      },
    },
    (mcp) =>
      Effect.gen(function* () {
        lastCreatedClientName = "sg1"
        getOrCreateClientState("sg1").tools = [
          { name: "memory_search", description: "Search memory", inputSchema: { type: "object", properties: {} } },
        ]
        yield* mcp.add("sg1", { type: "local", command: ["echo", "test"], defer: true })

        lastCreatedClientName = "sg2"
        getOrCreateClientState("sg2").tools = [
          { name: "memory_search", description: "Search memory", inputSchema: { type: "object", properties: {} } },
        ]
        yield* mcp.add("sg2", { type: "local", command: ["echo", "test"], defer: true })

        const toolsBefore = yield* mcp.tools()
        const search = (toolsBefore as any).mcp_search
        const result = yield* Effect.tryPromise(() => execTool(search, { query: "memory", limit: 5 }))
        const parsed = parseJsonResult(result)
        expect(parsed.loaded).toEqual(["sg2_memory_search"])
        expect(parsed.matches).toHaveLength(1)

        const toolsAfter = yield* mcp.tools()
        expect((toolsAfter as any).sg2_memory_search).toBeDefined()
        expect((toolsAfter as any).sg1_memory_search).toBeUndefined()
      }),
  ),
)

test(
  "mcp_search select falls back across SG mirror endpoints",
  withInstance(
    {
      sg1: {
        type: "local",
        command: ["echo", "test"],
        defer: true,
      },
    },
    (mcp) =>
      Effect.gen(function* () {
        lastCreatedClientName = "sg1"
        getOrCreateClientState("sg1").tools = [
          { name: "memory_search", description: "Search memory", inputSchema: { type: "object", properties: {} } },
        ]
        yield* mcp.add("sg1", { type: "local", command: ["echo", "test"], defer: true })

        const toolsBefore = yield* mcp.tools()
        const search = (toolsBefore as any).mcp_search
        const result = yield* Effect.tryPromise(() => execTool(search, { query: "select:sg2_memory_search" }))
        const parsed = parseJsonResult(result)
        expect(parsed.loaded).toEqual(["sg1_memory_search"])
        expect(parsed.missing).toBeUndefined()

        const toolsAfter = yield* mcp.tools()
        expect((toolsAfter as any).sg1_memory_search).toBeDefined()
      }),
  ),
)

test(
  "experimental.defer_mcp_tools defers servers that don't override defer",
  withInstance(
    {
      auto: {
        type: "local",
        command: ["echo", "test"],
      },
    },
    (mcp) =>
      Effect.gen(function* () {
        lastCreatedClientName = "auto"
        const state = getOrCreateClientState("auto")
        state.tools = [
          { name: "alpha", description: "alpha desc", inputSchema: { type: "object", properties: {} } },
          { name: "beta", description: "beta desc", inputSchema: { type: "object", properties: {} } },
        ]

        yield* mcp.add("auto", { type: "local", command: ["echo", "test"] })

        const tools = yield* mcp.tools()
        expect(Object.keys(tools).sort()).toEqual(["mcp_search"])
      }),
    { defer_mcp_tools: true },
  ),
)

test(
  "non-deferred servers expose all tools normally",
  withInstance(
    {
      eager: {
        type: "local",
        command: ["echo", "test"],
      },
    },
    (mcp) =>
      Effect.gen(function* () {
        lastCreatedClientName = "eager"
        const state = getOrCreateClientState("eager")
        state.tools = [
          { name: "do_thing", description: "does", inputSchema: { type: "object", properties: {} } },
          { name: "do_other", description: "does other", inputSchema: { type: "object", properties: {} } },
        ]

        yield* mcp.add("eager", { type: "local", command: ["echo", "test"] })

        const tools = yield* mcp.tools()
        const keys = Object.keys(tools)
        expect(keys).toContain("eager_do_thing")
        expect(keys).toContain("eager_do_other")
        expect(keys).not.toContain("mcp_search")
      }),
  ),
)

test(
  "mcp_search select: returns missing for unknown ids",
  withInstance(
    {
      svc: {
        type: "local",
        command: ["echo", "test"],
        defer: true,
      },
    },
    (mcp) =>
      Effect.gen(function* () {
        lastCreatedClientName = "svc"
        const state = getOrCreateClientState("svc")
        state.tools = [{ name: "real", description: "", inputSchema: { type: "object", properties: {} } }]

        yield* mcp.add("svc", { type: "local", command: ["echo", "test"], defer: true })

        const tools = yield* mcp.tools()
        const search = (tools as any).mcp_search
        const result = yield* Effect.tryPromise(() => execTool(search, { query: "select:svc_does_not_exist" }))
        const parsed = parseJsonResult(result)
        expect(parsed.loaded).toEqual([])
        expect(parsed.missing).toEqual(["svc_does_not_exist"])
      }),
  ),
)

test(
  "SG mirror tool falls over to sibling endpoint on call failure",
  withInstance(
    {
      sg1: { type: "local", command: ["echo", "test"], defer: true },
      sg2: { type: "local", command: ["echo", "test"], defer: true },
    },
    (mcp) =>
      Effect.gen(function* () {
        lastCreatedClientName = "sg1"
        const sg1State = getOrCreateClientState("sg1")
        sg1State.tools = [
          { name: "memory_search", description: "Search memory", inputSchema: { type: "object", properties: {} } },
        ]
        yield* mcp.add("sg1", { type: "local", command: ["echo", "test"], defer: true })

        lastCreatedClientName = "sg2"
        const sg2State = getOrCreateClientState("sg2")
        sg2State.tools = [
          { name: "memory_search", description: "Search memory", inputSchema: { type: "object", properties: {} } },
        ]
        yield* mcp.add("sg2", { type: "local", command: ["echo", "test"], defer: true })

        const initial = yield* mcp.tools()
        const search = (initial as any).mcp_search
        yield* Effect.tryPromise(() => execTool(search, { query: "memory", limit: 5 }))

        const tools = yield* mcp.tools()
        const sgTool = (tools as any).sg2_memory_search
        expect(sgTool).toBeDefined()

        // Force sg2 (the preferred mirror) to fail; sg1 should pick up the call.
        sg2State.failNext = new Error("sg2 transient outage")
        const result = yield* Effect.tryPromise(() => execTool(sgTool, { query: "test" }))
        expect(result?.content?.[0]?.text).toBe("called memory_search")
        expect(sg1State.callToolCalls.at(-1)?.name).toBe("memory_search")
        expect(sg2State.callToolCalls.at(-1)?.name).toBe("memory_search")
      }),
  ),
)

test(
  "SG mirror tool propagates the error when every sibling fails",
  withInstance(
    {
      sg1: { type: "local", command: ["echo", "test"], defer: true },
      sg2: { type: "local", command: ["echo", "test"], defer: true },
    },
    (mcp) =>
      Effect.gen(function* () {
        lastCreatedClientName = "sg1"
        const sg1State = getOrCreateClientState("sg1")
        sg1State.tools = [
          { name: "memory_search", description: "Search memory", inputSchema: { type: "object", properties: {} } },
        ]
        yield* mcp.add("sg1", { type: "local", command: ["echo", "test"], defer: true })

        lastCreatedClientName = "sg2"
        const sg2State = getOrCreateClientState("sg2")
        sg2State.tools = [
          { name: "memory_search", description: "Search memory", inputSchema: { type: "object", properties: {} } },
        ]
        yield* mcp.add("sg2", { type: "local", command: ["echo", "test"], defer: true })

        const initial = yield* mcp.tools()
        const search = (initial as any).mcp_search
        yield* Effect.tryPromise(() => execTool(search, { query: "memory", limit: 5 }))

        const tools = yield* mcp.tools()
        const sgTool = (tools as any).sg2_memory_search
        sg1State.alwaysFail = true
        sg2State.alwaysFail = true

        const exit = yield* Effect.tryPromise(() => execTool(sgTool, { query: "test" })).pipe(Effect.exit)
        expect(exit._tag).toBe("Failure")
      }),
  ),
)

test(
  "mcp_search dry_run does not mutate selected state",
  withInstance(
    {
      svc: {
        type: "local",
        command: ["echo", "test"],
        defer: true,
      },
    },
    (mcp) =>
      Effect.gen(function* () {
        lastCreatedClientName = "svc"
        const state = getOrCreateClientState("svc")
        state.tools = [{ name: "alpha", description: "alpha tool", inputSchema: { type: "object", properties: {} } }]

        yield* mcp.add("svc", { type: "local", command: ["echo", "test"], defer: true })

        const tools = yield* mcp.tools()
        const search = (tools as any).mcp_search
        const result = yield* Effect.tryPromise(() => execTool(search, { query: "alpha", dry_run: true }))
        const parsed = parseJsonResult(result)
        expect(parsed.loaded).toEqual([])
        expect(parsed.matches[0].tool).toBe("svc_alpha")
        expect(parsed.dry_run).toBe(true)

        const after = yield* mcp.tools()
        expect((after as any).svc_alpha).toBeUndefined()
      }),
  ),
)
