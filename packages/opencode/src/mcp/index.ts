import { dynamicTool, generateText, type Tool, jsonSchema, type JSONSchema7 } from "ai"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js"
import {
  CallToolResultSchema,
  type Tool as MCPToolDef,
  ToolListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js"
import { Config } from "../config"
import { ConfigMCP } from "../config/mcp"
import { Provider } from "../provider"
import { Log } from "../util"
import { NamedError } from "@opencode-ai/core/util/error"
import z from "zod/v4"
import { Installation } from "../installation"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { withTimeout } from "@/util/timeout"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { McpOAuthProvider } from "./oauth-provider"
import { McpOAuthCallback } from "./oauth-callback"
import { McpAuth } from "./auth"
import { BusEvent } from "../bus/bus-event"
import { Bus } from "@/bus"
import { TuiEvent } from "@/cli/cmd/tui/event"
import open from "open"
import { Effect, Exit, Layer, Option, Context, Schema, Stream } from "effect"
import { EffectBridge } from "@/effect"
import { InstanceState } from "@/effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { zod as effectZod } from "@/util/effect-zod"
import { withStatics } from "@/util/schema"

const log = Log.create({ service: "mcp" })
const DEFAULT_TIMEOUT = 30_000

export const Resource = Schema.Struct({
  name: Schema.String,
  uri: Schema.String,
  description: Schema.optional(Schema.String),
  mimeType: Schema.optional(Schema.String),
  client: Schema.String,
})
  .annotate({ identifier: "McpResource" })
  .pipe(withStatics((s) => ({ zod: effectZod(s) })))
export type Resource = Schema.Schema.Type<typeof Resource>

export const ToolsChanged = BusEvent.define(
  "mcp.tools.changed",
  Schema.Struct({
    server: Schema.String,
  }),
)

export const BrowserOpenFailed = BusEvent.define(
  "mcp.browser.open.failed",
  Schema.Struct({
    mcpName: Schema.String,
    url: Schema.String,
  }),
)

export const Failed = NamedError.create(
  "MCPFailed",
  z.object({
    name: z.string(),
  }),
)

type MCPClient = Client

const StatusConnected = Schema.Struct({ status: Schema.Literal("connected") }).annotate({
  identifier: "MCPStatusConnected",
})
const StatusDisabled = Schema.Struct({ status: Schema.Literal("disabled") }).annotate({
  identifier: "MCPStatusDisabled",
})
const StatusFailed = Schema.Struct({ status: Schema.Literal("failed"), error: Schema.String }).annotate({
  identifier: "MCPStatusFailed",
})
const StatusNeedsAuth = Schema.Struct({ status: Schema.Literal("needs_auth") }).annotate({
  identifier: "MCPStatusNeedsAuth",
})
const StatusNeedsClientRegistration = Schema.Struct({
  status: Schema.Literal("needs_client_registration"),
  error: Schema.String,
}).annotate({ identifier: "MCPStatusNeedsClientRegistration" })

export const Status = Schema.Union([
  StatusConnected,
  StatusDisabled,
  StatusFailed,
  StatusNeedsAuth,
  StatusNeedsClientRegistration,
])
  .annotate({ identifier: "MCPStatus", discriminator: "status" })
  .pipe(withStatics((s) => ({ zod: effectZod(s) })))
export type Status = Schema.Schema.Type<typeof Status>

// Store transports for OAuth servers to allow finishing auth
type TransportWithAuth = StreamableHTTPClientTransport | SSEClientTransport
const pendingOAuthTransports = new Map<string, TransportWithAuth>()

// Prompt cache types
type PromptInfo = Awaited<ReturnType<MCPClient["listPrompts"]>>["prompts"][number]
type ResourceInfo = Awaited<ReturnType<MCPClient["listResources"]>>["resources"][number]
type McpEntry = NonNullable<Config.Info["mcp"]>[string]

function isMcpConfigured(entry: McpEntry): entry is ConfigMCP.Info {
  return typeof entry === "object" && entry !== null && "type" in entry
}

const sanitize = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, "_")
const DEFERRED_SEARCH_TOOL = "mcp_search"
const DEFERRED_LOAD_TOOL = "mcp_load"
const DEFAULT_DEFERRED_SEARCH_LIMIT = 20
const MAX_DEFERRED_SEARCH_LIMIT = 50
const DEFAULT_DEFERRED_SEARCH_MODE: DeferredSearchMode = "smart"

type DeferredSearchMode = "standard" | "smart" | "augment"

const SEARCH_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "for",
  "from",
  "get",
  "i",
  "in",
  "is",
  "me",
  "need",
  "of",
  "on",
  "please",
  "the",
  "this",
  "to",
  "tool",
  "use",
  "want",
  "what",
  "with",
])

const SMART_SEARCH_ALIASES: Record<string, string[]> = {
  api: ["key", "token", "credential", "secret", "memory_secrets", "vault"],
  balance: ["budget", "cost", "spend", "billing"],
  chat: ["message", "dm", "channel", "roster", "claim"],
  cook: ["microwave", "food", "heat", "frozen", "cook"],
  cooking: ["microwave", "food", "heat", "frozen", "cook"],
  credential: ["secret", "key", "token", "vault", "memory_secrets"],
  error: ["logs", "status", "health", "cluster"],
  food: ["microwave", "cook", "frozen", "heat"],
  gpu: ["vast", "job", "instance"],
  health: ["status", "mcp", "cluster", "service"],
  key: ["secret", "token", "credential", "vault", "memory_secrets"],
  keys: ["secret", "token", "credential", "vault", "memory_secrets"],
  log: ["logs", "journal", "status"],
  logs: ["journal", "status", "cluster"],
  meal: ["microwave", "cook", "food", "heat"],
  memory: ["slot", "slots", "tag", "tags", "outline", "search"],
  model: ["llm", "provider", "route"],
  money: ["budget", "cost", "spend", "balance"],
  oven: ["microwave", "cook", "heat", "food"],
  password: ["secret", "key", "token", "credential", "vault"],
  ping: ["status", "health"],
  price: ["budget", "cost", "spend"],
  secret: ["key", "token", "credential", "vault", "memory_secrets"],
  secrets: ["key", "token", "credential", "vault", "memory_secrets"],
  server: ["status", "health", "mcp", "cluster"],
  service: ["status", "health", "logs"],
  sms: ["text", "message", "phone"],
  spend: ["budget", "cost", "balance"],
  status: ["health", "mcp", "cluster", "service"],
  tag: ["tags", "memory", "slot"],
  tags: ["tag", "memory", "slot"],
  token: ["secret", "key", "credential", "vault", "memory_secrets"],
  tokens: ["secret", "key", "credential", "vault", "memory_secrets"],
  vault: ["secret", "key", "token", "credential"],
}

function mcpToolKey(clientName: string, toolName: string) {
  return sanitize(clientName) + "_" + sanitize(toolName)
}

function isMcpDeferred(entry: ConfigMCP.Info | undefined, cfg: Config.Info) {
  return entry?.defer ?? cfg.experimental?.defer_mcp_tools ?? false
}

function configuredDeferredSearchMode(cfg: Config.Info): DeferredSearchMode {
  const mode = cfg.experimental?.defer_mcp_tools_search?.mode
  if (mode === "standard" || mode === "smart" || mode === "augment") return mode
  return DEFAULT_DEFERRED_SEARCH_MODE
}

function readSearchMode(value: unknown, cfg: Config.Info): DeferredSearchMode {
  if (value === "standard" || value === "smart" || value === "augment") return value
  return configuredDeferredSearchMode(cfg)
}

function textToolResult(text: string) {
  return {
    content: [{ type: "text" as const, text }],
  }
}

function jsonToolResult(value: unknown) {
  return textToolResult(JSON.stringify(value, null, 2))
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function readLimit(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_DEFERRED_SEARCH_LIMIT
  return Math.max(1, Math.min(Math.floor(value), MAX_DEFERRED_SEARCH_LIMIT))
}

function searchTokens(value: string | undefined) {
  if (!value) return []
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_./:-]+/g, " ")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0 && !SEARCH_STOP_WORDS.has(token))
}

function expandSmartTokens(tokens: string[]) {
  const result = new Set<string>()
  for (const token of tokens) {
    result.add(token)
    if (token.endsWith("s") && token.length > 3) result.add(token.slice(0, -1))
    if (token.endsWith("ing") && token.length > 5) result.add(token.slice(0, -3))
    for (const alias of SMART_SEARCH_ALIASES[token] ?? []) {
      for (const item of searchTokens(alias)) {
        result.add(item)
      }
    }
  }
  return Array.from(result)
}

function containsTerm(haystack: string, terms: Set<string>, term: string) {
  return terms.has(term) || haystack.includes(term)
}

type DeferredToolMatch = {
  server: string
  name: string
  tool: string
  description: string
  loaded: boolean
  score: number
}

export function searchDeferredToolDefinitions(input: {
  defs: Record<string, MCPToolDef[]>
  selected: Record<string, Set<string>>
  servers: string[]
  query?: string
  server?: string
  limit?: number
  mode?: "standard" | "smart"
}) {
  const mode = input.mode ?? DEFAULT_DEFERRED_SEARCH_MODE
  const tokens = searchTokens(input.query)
  const expandedTokens = mode === "smart" ? expandSmartTokens(tokens) : tokens
  const serverFilter = input.server?.toLowerCase()
  const limit = Math.max(1, Math.min(input.limit ?? DEFAULT_DEFERRED_SEARCH_LIMIT, MAX_DEFERRED_SEARCH_LIMIT))
  const matches: DeferredToolMatch[] = []

  for (const server of input.servers) {
    if (serverFilter && server.toLowerCase() !== serverFilter && sanitize(server).toLowerCase() !== serverFilter) {
      continue
    }

    for (const mcpTool of input.defs[server] ?? []) {
      const description = mcpTool.description ?? ""
      const tool = mcpToolKey(server, mcpTool.name)
      const nameTerms = new Set(searchTokens(mcpTool.name))
      const serverTerms = new Set(searchTokens(server))
      const descriptionTerms = new Set(searchTokens(description))
      const haystack = `${server} ${mcpTool.name} ${description}`.toLowerCase()

      if (tokens.length) {
        if (mode === "standard" && !tokens.every((token) => haystack.includes(token))) continue
        if (mode === "smart" && !expandedTokens.some((token) => containsTerm(haystack, nameTerms, token))) {
          const matchedServer = expandedTokens.some((token) => containsTerm(server.toLowerCase(), serverTerms, token))
          const matchedDescription = expandedTokens.some((token) =>
            containsTerm(description.toLowerCase(), descriptionTerms, token),
          )
          if (!matchedServer && !matchedDescription) continue
        }
      }

      let score = 0
      if (tokens.length) {
        const normalizedQuery = tokens.join(" ")
        const normalizedName = searchTokens(mcpTool.name).join(" ")
        if (normalizedName === normalizedQuery) score += 100
        else if (normalizedName.includes(normalizedQuery)) score += 50

        for (const token of tokens) {
          if (nameTerms.has(token)) score += 20
          else if (mcpTool.name.toLowerCase().includes(token)) score += 10
          if (serverTerms.has(token)) score += 6
          if (descriptionTerms.has(token)) score += 3
        }

        if (mode === "smart") {
          for (const token of expandedTokens) {
            if (tokens.includes(token)) continue
            if (nameTerms.has(token)) score += 8
            else if (mcpTool.name.toLowerCase().includes(token)) score += 5
            if (descriptionTerms.has(token)) score += 2
          }
        }
      }

      matches.push({
        server,
        name: mcpTool.name,
        tool,
        description,
        loaded: input.selected[server]?.has(mcpTool.name) ?? false,
        score,
      })
    }
  }

  return matches
    .sort((a, b) => b.score - a.score || a.server.localeCompare(b.server) || a.name.localeCompare(b.name))
    .slice(0, limit)
    .map(({ score: _score, ...match }) => match)
}

function findDeferredTool(input: {
  defs: Record<string, MCPToolDef[]>
  servers: string[]
  server?: string
  name?: string
  tool?: string
}) {
  const requestedServer = input.server?.toLowerCase()
  const requestedName = input.name?.toLowerCase()
  const requestedTool = input.tool?.toLowerCase()

  for (const server of input.servers) {
    if (
      requestedServer &&
      server.toLowerCase() !== requestedServer &&
      sanitize(server).toLowerCase() !== requestedServer
    ) {
      continue
    }

    for (const mcpTool of input.defs[server] ?? []) {
      const key = mcpToolKey(server, mcpTool.name)
      const name = mcpTool.name.toLowerCase()
      if (requestedTool && key.toLowerCase() !== requestedTool) continue
      if (requestedName && name !== requestedName && sanitize(mcpTool.name).toLowerCase() !== requestedName) continue
      if (!requestedTool && !requestedName) continue
      return { server, tool: mcpTool, key }
    }
  }
}

function parseAugmentedSearchTools(text: string) {
  const stripped = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
  const candidates = [stripped]
  const start = stripped.indexOf("{")
  const end = stripped.lastIndexOf("}")
  if (start >= 0 && end > start) candidates.push(stripped.slice(start, end + 1))

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as { tools?: unknown }
      if (!Array.isArray(parsed.tools)) continue
      return parsed.tools.flatMap((item) => {
        if (typeof item === "string") return [item]
        if (item && typeof item === "object" && typeof (item as { tool?: unknown }).tool === "string") {
          return [(item as { tool: string }).tool]
        }
        return []
      })
    } catch {}
  }
  return []
}

// Convert MCP tool definition to AI SDK Tool type
function convertMcpTool(mcpTool: MCPToolDef, client: MCPClient, timeout?: number): Tool {
  const inputSchema = mcpTool.inputSchema

  // Spread first, then override type to ensure it's always "object"
  const schema: JSONSchema7 = {
    ...(inputSchema as JSONSchema7),
    type: "object",
    properties: (inputSchema.properties ?? {}) as JSONSchema7["properties"],
    additionalProperties: false,
  }

  return dynamicTool({
    description: mcpTool.description ?? "",
    inputSchema: jsonSchema(schema),
    execute: async (args: unknown) => {
      return client.callTool(
        {
          name: mcpTool.name,
          arguments: (args || {}) as Record<string, unknown>,
        },
        CallToolResultSchema,
        {
          resetTimeoutOnProgress: true,
          timeout,
        },
      )
    },
  })
}

function defs(key: string, client: MCPClient, timeout?: number) {
  return Effect.tryPromise({
    try: () => withTimeout(client.listTools(), timeout ?? DEFAULT_TIMEOUT),
    catch: (err) => (err instanceof Error ? err : new Error(String(err))),
  }).pipe(
    Effect.map((result) => result.tools),
    Effect.catch((err) => {
      log.error("failed to get tools from client", { key, error: err })
      return Effect.succeed(undefined)
    }),
  )
}

function fetchFromClient<T extends { name: string }>(
  clientName: string,
  client: Client,
  listFn: (c: Client) => Promise<T[]>,
  label: string,
) {
  return Effect.tryPromise({
    try: () => listFn(client),
    catch: (e: any) => {
      log.error(`failed to get ${label}`, { clientName, error: e.message })
      return e
    },
  }).pipe(
    Effect.map((items) => {
      const out: Record<string, T & { client: string }> = {}
      const sanitizedClient = sanitize(clientName)
      for (const item of items) {
        out[sanitizedClient + ":" + sanitize(item.name)] = { ...item, client: clientName }
      }
      return out
    }),
    Effect.orElseSucceed(() => undefined),
  )
}

interface CreateResult {
  mcpClient?: MCPClient
  status: Status
  defs?: MCPToolDef[]
}

interface AuthResult {
  authorizationUrl: string
  oauthState: string
  client?: MCPClient
}

// --- Effect Service ---

interface State {
  status: Record<string, Status>
  clients: Record<string, MCPClient>
  defs: Record<string, MCPToolDef[]>
  selected: Record<string, Set<string>>
}

export interface Interface {
  readonly status: () => Effect.Effect<Record<string, Status>>
  readonly clients: () => Effect.Effect<Record<string, MCPClient>>
  readonly tools: () => Effect.Effect<Record<string, Tool>>
  readonly prompts: () => Effect.Effect<Record<string, PromptInfo & { client: string }>>
  readonly resources: () => Effect.Effect<Record<string, ResourceInfo & { client: string }>>
  readonly add: (name: string, mcp: ConfigMCP.Info) => Effect.Effect<{ status: Record<string, Status> | Status }>
  readonly connect: (name: string) => Effect.Effect<void>
  readonly disconnect: (name: string) => Effect.Effect<void>
  readonly getPrompt: (
    clientName: string,
    name: string,
    args?: Record<string, string>,
  ) => Effect.Effect<Awaited<ReturnType<MCPClient["getPrompt"]>> | undefined>
  readonly readResource: (
    clientName: string,
    resourceUri: string,
  ) => Effect.Effect<Awaited<ReturnType<MCPClient["readResource"]>> | undefined>
  readonly startAuth: (mcpName: string) => Effect.Effect<{ authorizationUrl: string; oauthState: string }>
  readonly authenticate: (mcpName: string) => Effect.Effect<Status>
  readonly finishAuth: (mcpName: string, authorizationCode: string) => Effect.Effect<Status>
  readonly removeAuth: (mcpName: string) => Effect.Effect<void>
  readonly supportsOAuth: (mcpName: string) => Effect.Effect<boolean>
  readonly hasStoredTokens: (mcpName: string) => Effect.Effect<boolean>
  readonly getAuthStatus: (mcpName: string) => Effect.Effect<AuthStatus>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/MCP") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const auth = yield* McpAuth.Service
    const bus = yield* Bus.Service
    const provider = yield* Effect.serviceOption(Provider.Service)
    const bridge = yield* EffectBridge.make()

    type Transport = StdioClientTransport | StreamableHTTPClientTransport | SSEClientTransport

    /**
     * Connect a client via the given transport with resource safety:
     * on failure the transport is closed; on success the caller owns it.
     */
    const connectTransport = (transport: Transport, timeout: number) =>
      Effect.acquireUseRelease(
        Effect.succeed(transport),
        (t) =>
          Effect.tryPromise({
            try: () => {
              const client = new Client({ name: "opencode", version: InstallationVersion })
              return withTimeout(client.connect(t), timeout).then(() => client)
            },
            catch: (e) => (e instanceof Error ? e : new Error(String(e))),
          }),
        (t, exit) => (Exit.isFailure(exit) ? Effect.tryPromise(() => t.close()).pipe(Effect.ignore) : Effect.void),
      )

    const DISABLED_RESULT: CreateResult = { status: { status: "disabled" } }

    const connectRemote = Effect.fn("MCP.connectRemote")(function* (
      key: string,
      mcp: ConfigMCP.Info & { type: "remote" },
    ) {
      const oauthDisabled = mcp.oauth === false
      const oauthConfig = typeof mcp.oauth === "object" ? mcp.oauth : undefined
      let authProvider: McpOAuthProvider | undefined

      if (!oauthDisabled) {
        authProvider = new McpOAuthProvider(
          key,
          mcp.url,
          {
            clientId: oauthConfig?.clientId,
            clientSecret: oauthConfig?.clientSecret,
            scope: oauthConfig?.scope,
            redirectUri: oauthConfig?.redirectUri,
          },
          {
            onRedirect: async (url) => {
              log.info("oauth redirect requested", { key, url: url.toString() })
            },
          },
          auth,
        )
      }

      const transports: Array<{ name: string; transport: TransportWithAuth }> = [
        {
          name: "StreamableHTTP",
          transport: new StreamableHTTPClientTransport(new URL(mcp.url), {
            authProvider,
            requestInit: mcp.headers ? { headers: mcp.headers } : undefined,
          }),
        },
        {
          name: "SSE",
          transport: new SSEClientTransport(new URL(mcp.url), {
            authProvider,
            requestInit: mcp.headers ? { headers: mcp.headers } : undefined,
          }),
        },
      ]

      const connectTimeout = mcp.timeout ?? DEFAULT_TIMEOUT
      let lastStatus: Status | undefined

      for (const { name, transport } of transports) {
        const result = yield* connectTransport(transport, connectTimeout).pipe(
          Effect.map((client) => ({ client, transportName: name })),
          Effect.catch((error) => {
            const lastError = error instanceof Error ? error : new Error(String(error))
            const isAuthError =
              error instanceof UnauthorizedError || (authProvider && lastError.message.includes("OAuth"))

            if (isAuthError) {
              log.info("mcp server requires authentication", { key, transport: name })

              if (lastError.message.includes("registration") || lastError.message.includes("client_id")) {
                lastStatus = {
                  status: "needs_client_registration" as const,
                  error: "Server does not support dynamic client registration. Please provide clientId in config.",
                }
                return bus
                  .publish(TuiEvent.ToastShow, {
                    title: "MCP Authentication Required",
                    message: `Server "${key}" requires a pre-registered client ID. Add clientId to your config.`,
                    variant: "warning",
                    duration: 8000,
                  })
                  .pipe(Effect.ignore, Effect.as(undefined))
              } else {
                pendingOAuthTransports.set(key, transport)
                lastStatus = { status: "needs_auth" as const }
                return bus
                  .publish(TuiEvent.ToastShow, {
                    title: "MCP Authentication Required",
                    message: `Server "${key}" requires authentication. Run: opencode mcp auth ${key}`,
                    variant: "warning",
                    duration: 8000,
                  })
                  .pipe(Effect.ignore, Effect.as(undefined))
              }
            }

            log.debug("transport connection failed", {
              key,
              transport: name,
              url: mcp.url,
              error: lastError.message,
            })
            lastStatus = { status: "failed" as const, error: lastError.message }
            return Effect.succeed(undefined)
          }),
        )
        if (result) {
          log.info("connected", { key, transport: result.transportName })
          return { client: result.client as MCPClient | undefined, status: { status: "connected" } as Status }
        }
        // If this was an auth error, stop trying other transports
        if (lastStatus?.status === "needs_auth" || lastStatus?.status === "needs_client_registration") break
      }

      return {
        client: undefined as MCPClient | undefined,
        status: (lastStatus ?? { status: "failed", error: "Unknown error" }) as Status,
      }
    })

    const connectLocal = Effect.fn("MCP.connectLocal")(function* (
      key: string,
      mcp: ConfigMCP.Info & { type: "local" },
    ) {
      const [cmd, ...args] = mcp.command
      const cwd = yield* InstanceState.directory
      const transport = new StdioClientTransport({
        stderr: "pipe",
        command: cmd,
        args,
        cwd,
        env: {
          ...process.env,
          ...(cmd === "opencode" ? { BUN_BE_BUN: "1" } : {}),
          ...mcp.environment,
        },
      })
      transport.stderr?.on("data", (chunk: Buffer) => {
        log.info(`mcp stderr: ${chunk.toString()}`, { key })
      })

      const connectTimeout = mcp.timeout ?? DEFAULT_TIMEOUT
      return yield* connectTransport(transport, connectTimeout).pipe(
        Effect.map((client): { client: MCPClient | undefined; status: Status } => ({
          client,
          status: { status: "connected" },
        })),
        Effect.catch((error): Effect.Effect<{ client: MCPClient | undefined; status: Status }> => {
          const msg = error instanceof Error ? error.message : String(error)
          log.error("local mcp startup failed", { key, command: mcp.command, cwd, error: msg })
          return Effect.succeed({ client: undefined, status: { status: "failed", error: msg } })
        }),
      )
    })

    const create = Effect.fn("MCP.create")(function* (key: string, mcp: ConfigMCP.Info) {
      if (mcp.enabled === false) {
        log.info("mcp server disabled", { key })
        return DISABLED_RESULT
      }

      log.info("found", { key, type: mcp.type })

      const { client: mcpClient, status } =
        mcp.type === "remote"
          ? yield* connectRemote(key, mcp as ConfigMCP.Info & { type: "remote" })
          : yield* connectLocal(key, mcp as ConfigMCP.Info & { type: "local" })

      if (!mcpClient) {
        return { status } satisfies CreateResult
      }

      const listed = yield* defs(key, mcpClient, mcp.timeout)
      if (!listed) {
        yield* Effect.tryPromise(() => mcpClient.close()).pipe(Effect.ignore)
        return { status: { status: "failed", error: "Failed to get tools" } } satisfies CreateResult
      }

      log.info("create() successfully created client", { key, toolCount: listed.length })
      return { mcpClient, status, defs: listed } satisfies CreateResult
    })
    const cfgSvc = yield* Config.Service

    const augmentDeferredMatches = Effect.fn("MCP.augmentDeferredMatches")(function* (input: {
      query?: string
      matches: Array<Omit<DeferredToolMatch, "score">>
      limit: number
      model?: string
    }) {
      if (!input.query || input.matches.length <= 1) {
        return { matches: input.matches.slice(0, input.limit), augmented: false as const }
      }
      if (Option.isNone(provider)) {
        return {
          matches: input.matches.slice(0, input.limit),
          augmented: false as const,
          warning: "Provider service unavailable; used smart search results.",
        }
      }

      return yield* Effect.gen(function* () {
        const cfg = yield* cfgSvc.get()
        const configuredModel = input.model ?? cfg.experimental?.defer_mcp_tools_search?.model
        const modelRef = configuredModel ? Provider.parseModel(configuredModel) : yield* provider.value.defaultModel()
        const model = yield* provider.value.getModel(modelRef.providerID, modelRef.modelID)
        const language = yield* provider.value.getLanguage(model)
        const candidates = input.matches.slice(0, MAX_DEFERRED_SEARCH_LIMIT).map((match, index) => ({
          rank: index + 1,
          tool: match.tool,
          server: match.server,
          name: match.name,
          description: match.description.slice(0, 400),
          loaded: match.loaded,
        }))

        const generated = yield* Effect.tryPromise({
          try: () =>
            generateText({
              model: language,
              temperature: 0,
              maxOutputTokens: 600,
              messages: [
                {
                  role: "system",
                  content:
                    'Rank MCP tools for the user search query. Return JSON only in this exact shape: {"tools":["tool_id"]}. Return only tool ids from the provided candidates, best first. Prefer exact task fit over broad category matches.',
                },
                {
                  role: "user",
                  content: JSON.stringify({
                    instruction: 'Return JSON only, for example {"tools":["server_tool_name"]}.',
                    query: input.query,
                    limit: input.limit,
                    candidates,
                  }),
                },
              ],
            }),
          catch: (error) => error,
        })
        const rankedTools = parseAugmentedSearchTools(generated.text)
        if (rankedTools.length === 0) {
          return {
            matches: input.matches.slice(0, input.limit),
            augmented: false as const,
            warning: "Augment model returned no valid tool ids; used smart search results.",
          }
        }

        const byTool = new Map(input.matches.map((match) => [match.tool, match]))
        const seen = new Set<string>()
        const ranked: Array<Omit<DeferredToolMatch, "score">> = []
        for (const tool of rankedTools) {
          const match = byTool.get(tool)
          if (!match || seen.has(match.tool)) continue
          seen.add(match.tool)
          ranked.push(match)
        }
        for (const match of input.matches) {
          if (ranked.length >= input.limit) break
          if (seen.has(match.tool)) continue
          seen.add(match.tool)
          ranked.push(match)
        }

        return {
          matches: ranked.slice(0, input.limit),
          augmented: true as const,
          model: `${model.providerID}/${model.id}`,
        }
      }).pipe(
        Effect.catch((error) =>
          Effect.succeed({
            matches: input.matches.slice(0, input.limit),
            augmented: false as const,
            warning: String(error),
          }),
        ),
      )
    })

    const descendants = Effect.fnUntraced(
      function* (pid: number) {
        if (process.platform === "win32") return [] as number[]
        const pids: number[] = []
        const queue = [pid]
        while (queue.length > 0) {
          const current = queue.shift()!
          const handle = yield* spawner.spawn(ChildProcess.make("pgrep", ["-P", String(current)], { stdin: "ignore" }))
          const text = yield* Stream.mkString(Stream.decodeText(handle.stdout))
          yield* handle.exitCode
          for (const tok of text.split("\n")) {
            const cpid = parseInt(tok, 10)
            if (!isNaN(cpid) && !pids.includes(cpid)) {
              pids.push(cpid)
              queue.push(cpid)
            }
          }
        }
        return pids
      },
      Effect.scoped,
      Effect.catch(() => Effect.succeed([] as number[])),
    )

    function watch(s: State, name: string, client: MCPClient, bridge: EffectBridge.Shape, timeout?: number) {
      client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
        log.info("tools list changed notification received", { server: name })
        if (s.clients[name] !== client || s.status[name]?.status !== "connected") return

        const listed = await bridge.promise(defs(name, client, timeout))
        if (!listed) return
        if (s.clients[name] !== client || s.status[name]?.status !== "connected") return

        s.defs[name] = listed
        const selected = s.selected[name]
        if (selected) {
          const available = new Set(listed.map((tool) => tool.name))
          for (const tool of selected) {
            if (!available.has(tool)) selected.delete(tool)
          }
        }
        await bridge.promise(bus.publish(ToolsChanged, { server: name }).pipe(Effect.ignore))
      })
    }

    const state = yield* InstanceState.make<State>(
      Effect.fn("MCP.state")(function* () {
        const cfg = yield* cfgSvc.get()
        const bridge = yield* EffectBridge.make()
        const config = cfg.mcp ?? {}
        const s: State = {
          status: {},
          clients: {},
          defs: {},
          selected: {},
        }

        yield* Effect.forEach(
          Object.entries(config),
          ([key, mcp]) =>
            Effect.gen(function* () {
              if (!isMcpConfigured(mcp)) {
                log.error("Ignoring MCP config entry without type", { key })
                return
              }

              if (mcp.enabled === false) {
                s.status[key] = { status: "disabled" }
                return
              }

              const result = yield* create(key, mcp).pipe(Effect.catch(() => Effect.void))
              if (!result) return

              s.status[key] = result.status
              if (result.mcpClient) {
                s.clients[key] = result.mcpClient
                s.defs[key] = result.defs!
                watch(s, key, result.mcpClient, bridge, mcp.timeout)
              }
            }),
          { concurrency: "unbounded" },
        )

        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            yield* Effect.forEach(
              Object.values(s.clients),
              (client) =>
                Effect.gen(function* () {
                  const pid = client.transport instanceof StdioClientTransport ? client.transport.pid : null
                  if (typeof pid === "number") {
                    const pids = yield* descendants(pid)
                    for (const dpid of pids) {
                      try {
                        process.kill(dpid, "SIGTERM")
                      } catch {}
                    }
                  }
                  yield* Effect.tryPromise(() => client.close()).pipe(Effect.ignore)
                }),
              { concurrency: "unbounded" },
            )
            pendingOAuthTransports.clear()
          }),
        )

        return s
      }),
    )

    function closeClient(s: State, name: string) {
      const client = s.clients[name]
      delete s.defs[name]
      delete s.selected[name]
      if (!client) return Effect.void
      return Effect.tryPromise(() => client.close()).pipe(Effect.ignore)
    }

    const storeClient = Effect.fnUntraced(function* (
      s: State,
      name: string,
      client: MCPClient,
      listed: MCPToolDef[],
      timeout?: number,
    ) {
      const bridge = yield* EffectBridge.make()
      yield* closeClient(s, name)
      s.status[name] = { status: "connected" }
      s.clients[name] = client
      s.defs[name] = listed
      watch(s, name, client, bridge, timeout)
      return s.status[name]
    })

    const status = Effect.fn("MCP.status")(function* () {
      const s = yield* InstanceState.get(state)

      const cfg = yield* cfgSvc.get()
      const config = cfg.mcp ?? {}
      const result: Record<string, Status> = {}

      for (const [key, mcp] of Object.entries(config)) {
        if (!isMcpConfigured(mcp)) continue
        result[key] = s.status[key] ?? { status: "disabled" }
      }

      return result
    })

    const clients = Effect.fn("MCP.clients")(function* () {
      const s = yield* InstanceState.get(state)
      return s.clients
    })

    const createAndStore = Effect.fn("MCP.createAndStore")(function* (name: string, mcp: ConfigMCP.Info) {
      const s = yield* InstanceState.get(state)
      const result = yield* create(name, mcp)

      s.status[name] = result.status
      if (!result.mcpClient) {
        yield* closeClient(s, name)
        delete s.clients[name]
        return result.status
      }

      return yield* storeClient(s, name, result.mcpClient, result.defs!, mcp.timeout)
    })

    const add = Effect.fn("MCP.add")(function* (name: string, mcp: ConfigMCP.Info) {
      yield* createAndStore(name, mcp)
      const s = yield* InstanceState.get(state)
      return { status: s.status }
    })

    const connect = Effect.fn("MCP.connect")(function* (name: string) {
      const mcp = yield* getMcpConfig(name)
      if (!mcp) {
        log.error("MCP config not found or invalid", { name })
        return
      }
      yield* createAndStore(name, { ...mcp, enabled: true })
    })

    const disconnect = Effect.fn("MCP.disconnect")(function* (name: string) {
      const s = yield* InstanceState.get(state)
      yield* closeClient(s, name)
      delete s.clients[name]
      s.status[name] = { status: "disabled" }
    })

    const tools = Effect.fn("MCP.tools")(function* () {
      const result: Record<string, Tool> = {}
      const s = yield* InstanceState.get(state)

      const cfg = yield* cfgSvc.get()
      const config = cfg.mcp ?? {}
      const defaultTimeout = cfg.experimental?.mcp_timeout
      const deferredServers: string[] = []

      const connectedClients = Object.entries(s.clients).filter(
        ([clientName]) => s.status[clientName]?.status === "connected",
      )

      yield* Effect.forEach(
        connectedClients,
        ([clientName, client]) =>
          Effect.gen(function* () {
            const mcpConfig = config[clientName]
            const entry = mcpConfig && isMcpConfigured(mcpConfig) ? mcpConfig : undefined

            const listed = s.defs[clientName]
            if (!listed) {
              log.warn("missing cached tools for connected server", { clientName })
              return
            }

            const timeout = entry?.timeout ?? defaultTimeout
            if (isMcpDeferred(entry, cfg)) {
              deferredServers.push(clientName)
            }

            const selected = s.selected[clientName] ?? new Set<string>()
            const available = isMcpDeferred(entry, cfg)
              ? listed.filter((mcpTool) => selected.has(mcpTool.name))
              : listed
            for (const mcpTool of available) {
              result[mcpToolKey(clientName, mcpTool.name)] = convertMcpTool(mcpTool, client, timeout)
            }
          }),
        { concurrency: "unbounded" },
      )

      if (deferredServers.length > 0) {
        result[DEFERRED_SEARCH_TOOL] = dynamicTool({
          description:
            "Search deferred MCP server tool catalogs. Use this before loading tools from large MCP servers; it returns compact candidates that can be activated with mcp_load.",
          inputSchema: jsonSchema({
            type: "object",
            properties: {
              query: {
                type: "string",
                description: "Words to search for in MCP server names, tool names, and descriptions.",
              },
              server: {
                type: "string",
                description: "Optional MCP server name to search within.",
              },
              limit: {
                type: "number",
                description: `Maximum number of matches to return, capped at ${MAX_DEFERRED_SEARCH_LIMIT}.`,
              },
              mode: {
                type: "string",
                enum: ["standard", "smart", "augment"],
                description:
                  "Search mode. standard uses strict token matching, smart uses local query expansion and ranking, augment reranks smart matches with an LLM.",
              },
              model: {
                type: "string",
                description:
                  "Optional provider/model id for augment mode, for example `deepseek/deepseek-v4-pro`. Overrides the configured augment model.",
              },
            },
            additionalProperties: false,
          }),
          execute: async (args: unknown) => {
            const input = args && typeof args === "object" ? (args as Record<string, unknown>) : {}
            const mode = readSearchMode(input.mode, cfg)
            const query = readString(input.query)
            const limit = readLimit(input.limit)
            const prefilterLimit =
              mode === "augment" ? Math.max(limit, Math.min(MAX_DEFERRED_SEARCH_LIMIT, limit * 4)) : limit
            let matches = searchDeferredToolDefinitions({
              defs: s.defs,
              selected: s.selected,
              servers: deferredServers,
              query,
              server: readString(input.server),
              limit: prefilterLimit,
              mode: mode === "standard" ? "standard" : "smart",
            })
            const augmentation =
              mode === "augment"
                ? await bridge.promise(
                    augmentDeferredMatches({
                      query,
                      matches,
                      limit,
                      model: readString(input.model),
                    }),
                  )
                : { matches: matches.slice(0, limit), augmented: false as const }
            matches = augmentation.matches
            const augmentationMeta = augmentation as unknown as { model?: string; warning?: string }

            return jsonToolResult({
              matches,
              count: matches.length,
              mode,
              augmented: augmentation.augmented,
              ...(augmentationMeta.model ? { model: augmentationMeta.model } : {}),
              ...(augmentationMeta.warning ? { warning: augmentationMeta.warning } : {}),
              deferredServers,
              next: "Call mcp_load with the `tool` value from a match, or with `server` and `name`.",
            })
          },
        })

        result[DEFERRED_LOAD_TOOL] = dynamicTool({
          description:
            "Activate one or more tools from deferred MCP servers. Loaded tools become available on the next assistant step.",
          inputSchema: jsonSchema({
            type: "object",
            properties: {
              tool: {
                type: "string",
                description: "A tool id returned by mcp_search, for example `github_create_issue`.",
              },
              tools: {
                type: "array",
                items: { type: "string" },
                description: "Multiple tool ids returned by mcp_search.",
              },
              server: {
                type: "string",
                description: "MCP server name. Use with `name` when not passing `tool`.",
              },
              name: {
                type: "string",
                description: "Original MCP tool name. Use with `server` when not passing `tool`.",
              },
            },
            additionalProperties: false,
          }),
          execute: async (args: unknown) => {
            const input = args && typeof args === "object" ? (args as Record<string, unknown>) : {}
            const requested = [
              ...(Array.isArray(input.tools) ? input.tools : [])
                .filter((item): item is string => typeof item === "string")
                .map((item) => item.trim()),
              ...[readString(input.tool)].filter((item): item is string => !!item),
            ].filter((item) => item.length > 0)
            const loaded: Array<{ server: string; name: string; tool: string }> = []
            const missing: string[] = []

            if (requested.length === 0) {
              const found = findDeferredTool({
                defs: s.defs,
                servers: deferredServers,
                server: readString(input.server),
                name: readString(input.name),
              })
              if (found) requested.push(found.key)
              else missing.push([readString(input.server), readString(input.name)].filter(Boolean).join("/") || "tool")
            }

            for (const requestedTool of requested) {
              const found = findDeferredTool({
                defs: s.defs,
                servers: deferredServers,
                tool: requestedTool,
              })
              if (!found) {
                missing.push(requestedTool)
                continue
              }

              s.selected[found.server] ??= new Set<string>()
              s.selected[found.server].add(found.tool.name)
              loaded.push({ server: found.server, name: found.tool.name, tool: found.key })
            }

            return jsonToolResult({
              loaded,
              missing,
              next:
                loaded.length > 0
                  ? "The loaded MCP tools will be available on the next assistant step."
                  : "No tools were loaded. Call mcp_search to find available deferred MCP tools.",
            })
          },
        })
      }

      return result
    })

    function collectFromConnected<T extends { name: string }>(
      s: State,
      listFn: (c: Client) => Promise<T[]>,
      label: string,
    ) {
      return Effect.forEach(
        Object.entries(s.clients).filter(([name]) => s.status[name]?.status === "connected"),
        ([clientName, client]) =>
          fetchFromClient(clientName, client, listFn, label).pipe(Effect.map((items) => Object.entries(items ?? {}))),
        { concurrency: "unbounded" },
      ).pipe(Effect.map((results) => Object.fromEntries<T & { client: string }>(results.flat())))
    }

    const prompts = Effect.fn("MCP.prompts")(function* () {
      const s = yield* InstanceState.get(state)
      return yield* collectFromConnected(s, (c) => c.listPrompts().then((r) => r.prompts), "prompts")
    })

    const resources = Effect.fn("MCP.resources")(function* () {
      const s = yield* InstanceState.get(state)
      return yield* collectFromConnected(s, (c) => c.listResources().then((r) => r.resources), "resources")
    })

    const withClient = Effect.fnUntraced(function* <A>(
      clientName: string,
      fn: (client: MCPClient) => Promise<A>,
      label: string,
      meta?: Record<string, unknown>,
    ) {
      const s = yield* InstanceState.get(state)
      const client = s.clients[clientName]
      if (!client) {
        log.warn(`client not found for ${label}`, { clientName })
        return undefined
      }
      return yield* Effect.tryPromise({
        try: () => fn(client),
        catch: (e: any) => {
          log.error(`failed to ${label}`, { clientName, ...meta, error: e?.message })
          return e
        },
      }).pipe(Effect.orElseSucceed(() => undefined))
    })

    const getPrompt = Effect.fn("MCP.getPrompt")(function* (
      clientName: string,
      name: string,
      args?: Record<string, string>,
    ) {
      return yield* withClient(clientName, (client) => client.getPrompt({ name, arguments: args }), "getPrompt", {
        promptName: name,
      })
    })

    const readResource = Effect.fn("MCP.readResource")(function* (clientName: string, resourceUri: string) {
      return yield* withClient(clientName, (client) => client.readResource({ uri: resourceUri }), "readResource", {
        resourceUri,
      })
    })

    const getMcpConfig = Effect.fnUntraced(function* (mcpName: string) {
      const cfg = yield* cfgSvc.get()
      const mcpConfig = cfg.mcp?.[mcpName]
      if (!mcpConfig || !isMcpConfigured(mcpConfig)) return undefined
      return mcpConfig
    })

    const startAuth = Effect.fn("MCP.startAuth")(function* (mcpName: string) {
      const mcpConfig = yield* getMcpConfig(mcpName)
      if (!mcpConfig) throw new Error(`MCP server ${mcpName} not found or disabled`)
      if (mcpConfig.type !== "remote") throw new Error(`MCP server ${mcpName} is not a remote server`)
      if (mcpConfig.oauth === false) throw new Error(`MCP server ${mcpName} has OAuth explicitly disabled`)

      // OAuth config is optional - if not provided, we'll use auto-discovery
      const oauthConfig = typeof mcpConfig.oauth === "object" ? mcpConfig.oauth : undefined

      // Start the callback server with custom redirectUri if configured
      yield* Effect.promise(() => McpOAuthCallback.ensureRunning(oauthConfig?.redirectUri))

      const oauthState = Array.from(crypto.getRandomValues(new Uint8Array(32)))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("")
      yield* auth.updateOAuthState(mcpName, oauthState)
      let capturedUrl: URL | undefined
      const authProvider = new McpOAuthProvider(
        mcpName,
        mcpConfig.url,
        {
          clientId: oauthConfig?.clientId,
          clientSecret: oauthConfig?.clientSecret,
          scope: oauthConfig?.scope,
          redirectUri: oauthConfig?.redirectUri,
        },
        {
          onRedirect: async (url) => {
            capturedUrl = url
          },
        },
        auth,
      )

      const transport = new StreamableHTTPClientTransport(new URL(mcpConfig.url), { authProvider })

      return yield* Effect.tryPromise({
        try: () => {
          const client = new Client({ name: "opencode", version: InstallationVersion })
          return client
            .connect(transport)
            .then(() => ({ authorizationUrl: "", oauthState, client }) satisfies AuthResult)
        },
        catch: (error) => error,
      }).pipe(
        Effect.catch((error) => {
          if (error instanceof UnauthorizedError && capturedUrl) {
            pendingOAuthTransports.set(mcpName, transport)
            return Effect.succeed({ authorizationUrl: capturedUrl.toString(), oauthState } satisfies AuthResult)
          }
          return Effect.die(error)
        }),
      )
    })

    const authenticate = Effect.fn("MCP.authenticate")(function* (mcpName: string) {
      const result = yield* startAuth(mcpName)
      if (!result.authorizationUrl) {
        const client = "client" in result ? result.client : undefined
        const mcpConfig = yield* getMcpConfig(mcpName)
        if (!mcpConfig) {
          yield* Effect.tryPromise(() => client?.close() ?? Promise.resolve()).pipe(Effect.ignore)
          return { status: "failed", error: "MCP config not found after auth" } as Status
        }

        const listed = client ? yield* defs(mcpName, client, mcpConfig.timeout) : undefined
        if (!client || !listed) {
          yield* Effect.tryPromise(() => client?.close() ?? Promise.resolve()).pipe(Effect.ignore)
          return { status: "failed", error: "Failed to get tools" } as Status
        }

        const s = yield* InstanceState.get(state)
        yield* auth.clearOAuthState(mcpName)
        return yield* storeClient(s, mcpName, client, listed, mcpConfig.timeout)
      }

      log.info("opening browser for oauth", { mcpName, url: result.authorizationUrl, state: result.oauthState })

      const callbackPromise = McpOAuthCallback.waitForCallback(result.oauthState, mcpName)

      yield* Effect.tryPromise(() => open(result.authorizationUrl)).pipe(
        Effect.flatMap((subprocess) =>
          Effect.callback<void, Error>((resume) => {
            const timer = setTimeout(() => resume(Effect.void), 500)
            subprocess.on("error", (err) => {
              clearTimeout(timer)
              resume(Effect.fail(err))
            })
            subprocess.on("exit", (code) => {
              if (code !== null && code !== 0) {
                clearTimeout(timer)
                resume(Effect.fail(new Error(`Browser open failed with exit code ${code}`)))
              }
            })
          }),
        ),
        Effect.catch(() => {
          log.warn("failed to open browser, user must open URL manually", { mcpName })
          return bus.publish(BrowserOpenFailed, { mcpName, url: result.authorizationUrl }).pipe(Effect.ignore)
        }),
      )

      const code = yield* Effect.promise(() => callbackPromise)

      const storedState = yield* auth.getOAuthState(mcpName)
      if (storedState !== result.oauthState) {
        yield* auth.clearOAuthState(mcpName)
        throw new Error("OAuth state mismatch - potential CSRF attack")
      }
      yield* auth.clearOAuthState(mcpName)
      return yield* finishAuth(mcpName, code)
    })

    const finishAuth = Effect.fn("MCP.finishAuth")(function* (mcpName: string, authorizationCode: string) {
      const transport = pendingOAuthTransports.get(mcpName)
      if (!transport) throw new Error(`No pending OAuth flow for MCP server: ${mcpName}`)

      const result = yield* Effect.tryPromise({
        try: () => transport.finishAuth(authorizationCode).then(() => true as const),
        catch: (error) => {
          log.error("failed to finish oauth", { mcpName, error })
          return error
        },
      }).pipe(Effect.option)

      if (Option.isNone(result)) {
        return { status: "failed", error: "OAuth completion failed" } as Status
      }

      yield* auth.clearCodeVerifier(mcpName)
      pendingOAuthTransports.delete(mcpName)

      const mcpConfig = yield* getMcpConfig(mcpName)
      if (!mcpConfig) return { status: "failed", error: "MCP config not found after auth" } as Status

      return yield* createAndStore(mcpName, mcpConfig)
    })

    const removeAuth = Effect.fn("MCP.removeAuth")(function* (mcpName: string) {
      yield* auth.remove(mcpName)
      McpOAuthCallback.cancelPending(mcpName)
      pendingOAuthTransports.delete(mcpName)
      log.info("removed oauth credentials", { mcpName })
    })

    const supportsOAuth = Effect.fn("MCP.supportsOAuth")(function* (mcpName: string) {
      const mcpConfig = yield* getMcpConfig(mcpName)
      if (!mcpConfig) return false
      return mcpConfig.type === "remote" && mcpConfig.oauth !== false
    })

    const hasStoredTokens = Effect.fn("MCP.hasStoredTokens")(function* (mcpName: string) {
      const entry = yield* auth.get(mcpName)
      return !!entry?.tokens
    })

    const getAuthStatus = Effect.fn("MCP.getAuthStatus")(function* (mcpName: string) {
      const entry = yield* auth.get(mcpName)
      if (!entry?.tokens) return "not_authenticated" as AuthStatus
      const expired = yield* auth.isTokenExpired(mcpName)
      return (expired ? "expired" : "authenticated") as AuthStatus
    })

    return Service.of({
      status,
      clients,
      tools,
      prompts,
      resources,
      add,
      connect,
      disconnect,
      getPrompt,
      readResource,
      startAuth,
      authenticate,
      finishAuth,
      removeAuth,
      supportsOAuth,
      hasStoredTokens,
      getAuthStatus,
    })
  }),
)

export type AuthStatus = "authenticated" | "expired" | "not_authenticated"

// --- Per-service runtime ---

export const defaultLayer = layer.pipe(
  Layer.provide(McpAuth.layer),
  Layer.provide(Bus.layer),
  Layer.provide(Config.defaultLayer),
  Layer.provide(CrossSpawnSpawner.defaultLayer),
  Layer.provide(AppFileSystem.defaultLayer),
)

export const defaultLayerWithProvider = layer.pipe(
  Layer.provide(McpAuth.layer),
  Layer.provide(Bus.layer),
  Layer.provide(Config.defaultLayer),
  Layer.provide(Provider.defaultLayer),
  Layer.provide(CrossSpawnSpawner.defaultLayer),
  Layer.provide(AppFileSystem.defaultLayer),
)

export * as MCP from "."
