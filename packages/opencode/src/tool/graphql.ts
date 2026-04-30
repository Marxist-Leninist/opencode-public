import { Effect, Schema } from "effect"
import DESCRIPTION from "./graphql.txt"
import * as Tool from "./tool"

const DEFAULT_TIMEOUT_MS = 30_000
const MAX_TIMEOUT_MS = 600_000
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024
const ABS_MAX_BYTES = 64 * 1024 * 1024
const DEFAULT_MAX_RETRIES = 0
const MAX_RETRIES = 5
const DEFAULT_RETRY_DELAY_MS = 250
const MAX_RETRY_DELAY_MS = 30_000

export const Parameters = Schema.Struct({
  url: Schema.String.check(Schema.isMinLength(8)).annotate({
    description: "GraphQL endpoint URL (http or https).",
  }),
  query: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(524_288)).annotate({
    description:
      "GraphQL document. Can be a query, mutation, or subscription text. Up to 512 KB. Subscriptions are not streamed — use a websocket client for that.",
  }),
  variables: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)).annotate({
    description: "Optional variables map ({ name: value }). Sent as JSON in the request body.",
  }),
  operation_name: Schema.optional(Schema.String.check(Schema.isMaxLength(255))).annotate({
    description:
      "Optional operationName. Required when the query contains multiple named operations and you need to pick one.",
  }),
  headers: Schema.optional(Schema.Record(Schema.String, Schema.String)).annotate({
    description: "Optional headers (e.g. Content-Type override). Authorization is set via auth_bearer.",
  }),
  auth_bearer: Schema.optional(Schema.String.check(Schema.isMinLength(1))).annotate({
    description: "Optional bearer token; sent as 'Authorization: Bearer <token>'. Mutually exclusive with headers.Authorization.",
  }),
  method: Schema.optional(Schema.Literals(["POST", "GET"])).annotate({
    description:
      "HTTP method. Default POST (the GraphQL spec mandate). 'GET' encodes query+variables+operationName as query string; works with public, query-only endpoints.",
  }),
  timeout_ms: Schema.optional(
    Schema.Number.check(Schema.isInt())
      .check(Schema.isGreaterThanOrEqualTo(1))
      .check(Schema.isLessThanOrEqualTo(MAX_TIMEOUT_MS)),
  ).annotate({
    description: `Request timeout in milliseconds. Default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS}.`,
  }),
  max_bytes: Schema.optional(
    Schema.Number.check(Schema.isInt())
      .check(Schema.isGreaterThanOrEqualTo(1024))
      .check(Schema.isLessThanOrEqualTo(ABS_MAX_BYTES)),
  ).annotate({
    description: `Maximum response body size in bytes. Default ${DEFAULT_MAX_BYTES}, max ${ABS_MAX_BYTES}.`,
  }),
  max_retries: Schema.optional(
    Schema.Number.check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(0)).check(Schema.isLessThanOrEqualTo(MAX_RETRIES)),
  ).annotate({
    description: `Number of retry attempts on transport error or 5xx. Default ${DEFAULT_MAX_RETRIES} (no retry). Max ${MAX_RETRIES}.`,
  }),
  retry_delay_ms: Schema.optional(
    Schema.Number.check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(1)).check(Schema.isLessThanOrEqualTo(MAX_RETRY_DELAY_MS)),
  ).annotate({
    description: `Base delay between retries in ms (exponential backoff applied). Default ${DEFAULT_RETRY_DELAY_MS}.`,
  }),
  fail_on_graphql_errors: Schema.optional(Schema.Boolean).annotate({
    description:
      "When true (default), a non-empty 'errors' array in the GraphQL response makes the tool report ok=false. Set false to inspect partial results that came back alongside errors.",
  }),
  redact_headers: Schema.optional(Schema.Boolean).annotate({
    description:
      "When true (default), Authorization/Cookie/X-API-* headers are redacted in the metadata for logging safety. Set false only when you really need them surfaced.",
  }),
})

type Params = Schema.Schema.Type<typeof Parameters>

type GraphQLError = {
  message: string
  path?: (string | number)[]
  locations?: { line: number; column: number }[]
  extensions?: Record<string, unknown>
}

type Metadata = {
  url: string
  method: "POST" | "GET"
  status?: number
  ok: boolean
  duration_ms: number
  attempts: number
  bytes: number
  truncated: boolean
  has_data: boolean
  has_errors: boolean
  error_count?: number
  error_messages?: string[]
  operation_name?: string
  variable_keys?: string[]
  request_headers?: Record<string, string>
  fail_on_graphql_errors: boolean
}

const done = (result: Tool.ExecuteResult<Metadata>) => result

const REDACT_HEADERS = new Set(["authorization", "cookie", "set-cookie", "x-api-key", "x-api-token"])

function redactHeaders(headers: Record<string, string>, on: boolean): Record<string, string> {
  if (!on) return { ...headers }
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers)) {
    out[k] = REDACT_HEADERS.has(k.toLowerCase()) ? "[redacted]" : v
  }
  return out
}

function buildGetUrl(url: string, query: string, variables?: Record<string, unknown>, operationName?: string): string {
  const u = new URL(url)
  u.searchParams.set("query", query)
  if (variables) u.searchParams.set("variables", JSON.stringify(variables))
  if (operationName) u.searchParams.set("operationName", operationName)
  return u.toString()
}

async function readCappedBody(res: Response, maxBytes: number): Promise<{ bytes: number; text: string; truncated: boolean }> {
  if (!res.body) {
    const text = await res.text().catch(() => "")
    const bytes = Buffer.byteLength(text, "utf8")
    return { bytes, text: bytes > maxBytes ? text.slice(0, maxBytes) : text, truncated: bytes > maxBytes }
  }
  const chunks: Uint8Array[] = []
  let total = 0
  const reader = res.body.getReader()
  let truncated = false
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      if (!value) continue
      total += value.byteLength
      if (total > maxBytes) {
        const remaining = maxBytes - (total - value.byteLength)
        if (remaining > 0) chunks.push(value.subarray(0, remaining))
        truncated = true
        try {
          await reader.cancel()
        } catch {
          /* noop */
        }
        break
      }
      chunks.push(value)
    }
  } finally {
    try {
      reader.releaseLock()
    } catch {
      /* noop */
    }
  }
  const text = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8")
  return { bytes: total, text, truncated }
}

type RoundtripResult = {
  status?: number
  bytes: number
  text: string
  truncated: boolean
  error?: string
}

async function roundtrip(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  maxBytes: number,
  signal: AbortSignal,
): Promise<RoundtripResult> {
  const ac = new AbortController()
  const onAbort = () => ac.abort()
  signal.addEventListener("abort", onAbort, { once: true })
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const res = await fetch(url, { ...init, signal: ac.signal })
    const body = await readCappedBody(res, maxBytes)
    return { status: res.status, bytes: body.bytes, text: body.text, truncated: body.truncated }
  } catch (err: any) {
    return { bytes: 0, text: "", truncated: false, error: err?.message ?? String(err) }
  } finally {
    clearTimeout(timer)
    signal.removeEventListener("abort", onAbort)
  }
}

function shouldRetry(result: RoundtripResult): boolean {
  if (result.error) return true
  if (result.status && result.status >= 500) return true
  return false
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export const GraphQLTool = Tool.define(
  "graphql",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Params, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const method = params.method ?? "POST"
          const timeoutMs = params.timeout_ms ?? DEFAULT_TIMEOUT_MS
          const maxBytes = params.max_bytes ?? DEFAULT_MAX_BYTES
          const maxRetries = params.max_retries ?? DEFAULT_MAX_RETRIES
          const retryDelay = params.retry_delay_ms ?? DEFAULT_RETRY_DELAY_MS
          const failOnGraphQL = params.fail_on_graphql_errors ?? true
          const redact = params.redact_headers ?? true

          // Build merged headers without mutating input
          const headers: Record<string, string> = {
            Accept: "application/json",
            ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
            ...(params.headers ?? {}),
          }
          if (params.auth_bearer && !Object.keys(headers).some((k) => k.toLowerCase() === "authorization")) {
            headers.Authorization = `Bearer ${params.auth_bearer}`
          }

          let url = params.url
          let init: RequestInit
          if (method === "GET") {
            url = buildGetUrl(params.url, params.query, params.variables, params.operation_name)
            init = { method: "GET", headers }
          } else {
            const body = JSON.stringify({
              query: params.query,
              variables: params.variables,
              operationName: params.operation_name,
            })
            init = { method: "POST", headers, body }
          }

          yield* ctx.metadata({
            title: `graphql ${method} ${new URL(params.url).host}`,
            metadata: {
              url: params.url,
              method,
              ok: false,
              duration_ms: 0,
              attempts: 0,
              bytes: 0,
              truncated: false,
              has_data: false,
              has_errors: false,
              operation_name: params.operation_name,
              variable_keys: params.variables ? Object.keys(params.variables) : undefined,
              request_headers: redactHeaders(headers, redact),
              fail_on_graphql_errors: failOnGraphQL,
            },
          })

          const start = Date.now()
          let attempts = 0
          let result: RoundtripResult = { bytes: 0, text: "", truncated: false, error: "no attempt made" }
          for (let attempt = 0; attempt <= maxRetries; attempt++) {
            attempts = attempt + 1
            result = yield* Effect.promise(() => roundtrip(url, init, timeoutMs, maxBytes, ctx.abort))
            if (!shouldRetry(result) || attempt === maxRetries) break
            const wait = retryDelay * 2 ** attempt
            yield* Effect.promise(() => sleep(wait))
          }
          const duration_ms = Date.now() - start

          // Try to parse the body
          let parsed: { data?: unknown; errors?: GraphQLError[]; extensions?: unknown } | undefined
          let parseError: string | undefined
          if (result.text) {
            try {
              parsed = JSON.parse(result.text)
            } catch (err: any) {
              parseError = err?.message ?? "JSON parse error"
            }
          }

          const errors = Array.isArray(parsed?.errors) ? parsed!.errors! : []
          const hasData = parsed !== undefined && parsed.data !== undefined && parsed.data !== null
          const hasErrors = errors.length > 0
          const transportOk = !result.error && !!result.status && result.status >= 200 && result.status < 300
          const ok = transportOk && (failOnGraphQL ? !hasErrors : true) && !parseError

          const meta: Metadata = {
            url: params.url,
            method,
            status: result.status,
            ok,
            duration_ms,
            attempts,
            bytes: result.bytes,
            truncated: result.truncated,
            has_data: hasData,
            has_errors: hasErrors,
            error_count: hasErrors ? errors.length : undefined,
            error_messages: hasErrors ? errors.slice(0, 10).map((e) => e.message ?? "(no message)") : undefined,
            operation_name: params.operation_name,
            variable_keys: params.variables ? Object.keys(params.variables) : undefined,
            request_headers: redactHeaders(headers, redact),
            fail_on_graphql_errors: failOnGraphQL,
          }

          // Build human-readable output
          const lines: string[] = []
          lines.push(
            `${method} ${params.url}${params.operation_name ? ` (${params.operation_name})` : ""} → ${
              result.status ?? "ERR"
            } in ${duration_ms}ms (${attempts} attempt${attempts === 1 ? "" : "s"}, ${result.bytes} bytes${
              result.truncated ? "; truncated" : ""
            })`,
          )
          if (result.error) lines.push(`transport error: ${result.error}`)
          if (parseError) lines.push(`response not JSON: ${parseError}`)
          if (hasErrors) {
            lines.push(`graphql errors (${errors.length}):`)
            for (const e of errors.slice(0, 10)) {
              lines.push(`  - ${e.message ?? "(no message)"}${e.path ? ` (path: ${e.path.join(".")})` : ""}`)
            }
            if (errors.length > 10) lines.push(`  ... ${errors.length - 10} more`)
          }
          if (parsed) {
            lines.push("response:")
            lines.push(JSON.stringify(parsed, null, 2))
          } else if (result.text) {
            lines.push("response (raw):")
            lines.push(result.text)
          }
          const output = lines.join("\n")

          let title: string
          if (!transportOk) title = `graphql transport error → ${result.status ?? "no response"}`
          else if (parseError) title = `graphql parse error: ${params.url}`
          else if (hasErrors) title = `graphql ${errors.length} error${errors.length === 1 ? "" : "s"}: ${params.url}`
          else title = `graphql ok (${duration_ms}ms): ${params.url}${params.operation_name ? ` (${params.operation_name})` : ""}`

          return done({ title, metadata: meta, output })
        }),
    }
  }),
)

export const __testing = { redactHeaders, buildGetUrl, shouldRetry, readCappedBody }
