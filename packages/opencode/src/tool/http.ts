import { Effect, Schema } from "effect"
import DESCRIPTION from "./http.txt"
import * as Tool from "./tool"

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const
const BODY_TYPES = ["auto", "json", "text", "form", "raw_base64"] as const
const PARSE_MODES = ["auto", "text", "json", "raw_base64"] as const

const DEFAULT_TIMEOUT_MS = 30_000
const MAX_TIMEOUT_MS = 600_000
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024
const ABS_MAX_BYTES = 256 * 1024 * 1024

const DEFAULT_ACCEPT_STATUS = [200, 201, 202, 204, 205, 206] as const

const AuthBearer = Schema.Struct({
  type: Schema.Literal("bearer"),
  token: Schema.String.check(Schema.isMinLength(1)),
})
const AuthBasic = Schema.Struct({
  type: Schema.Literal("basic"),
  username: Schema.String,
  password: Schema.String,
})

export const Parameters = Schema.Struct({
  method: Schema.String.annotate({
    description:
      "HTTP method. One of GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS. Case-insensitive.",
  }),
  url: Schema.String.check(Schema.isMinLength(8)).annotate({
    description: "Full http(s) URL.",
  }),
  query: Schema.optional(Schema.Record(Schema.String, Schema.String)).annotate({
    description: "Optional query parameters merged into the URL.",
  }),
  headers: Schema.optional(Schema.Record(Schema.String, Schema.String)).annotate({
    description: "Optional request headers.",
  }),
  body: Schema.optional(Schema.Unknown).annotate({
    description:
      "Optional request body. String is sent as-is (text or pre-encoded). Non-string is JSON-stringified when body_type is 'auto' or 'json'.",
  }),
  body_type: Schema.optional(Schema.Literals(BODY_TYPES)).annotate({
    description:
      "How to encode the body. Default 'auto'. 'form' url-encodes an object record. 'raw_base64' decodes a base64 string into bytes.",
  }),
  auth: Schema.optional(Schema.Union([AuthBearer, AuthBasic])).annotate({
    description:
      "Optional auth: { type:'bearer', token } adds Authorization: Bearer …; { type:'basic', username, password } adds basic auth.",
  }),
  timeout_ms: Schema.optional(
    Schema.Number.check(Schema.isInt())
      .check(Schema.isGreaterThanOrEqualTo(1))
      .check(Schema.isLessThanOrEqualTo(MAX_TIMEOUT_MS)),
  ).annotate({
    description: `Request timeout in ms. Default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS}.`,
  }),
  follow_redirects: Schema.optional(Schema.Boolean).annotate({
    description: "Follow 3xx redirects. Default true.",
  }),
  max_response_bytes: Schema.optional(
    Schema.Number.check(Schema.isInt())
      .check(Schema.isGreaterThanOrEqualTo(1))
      .check(Schema.isLessThanOrEqualTo(ABS_MAX_BYTES)),
  ).annotate({
    description: `Cap on response body bytes. Default ${DEFAULT_MAX_BYTES} (5 MiB).`,
  }),
  parse_response: Schema.optional(Schema.Literals(PARSE_MODES)).annotate({
    description:
      "How to render the response body. 'auto' (default), 'text', 'json' (force JSON.parse), 'raw_base64'.",
  }),
  accept_status: Schema.optional(Schema.Array(Schema.Number)).annotate({
    description:
      "List of accepted HTTP status codes. Default [200,201,202,204,205,206]. Throws on a non-accepted status.",
  }),
})

type Params = Schema.Schema.Type<typeof Parameters>
type Method = (typeof METHODS)[number]
type BodyType = (typeof BODY_TYPES)[number]
type ParseMode = (typeof PARSE_MODES)[number]

type Metadata = {
  method: Method
  url: string
  final_url: string
  status: number
  status_text: string
  response_headers: Record<string, string>
  request_headers: Record<string, string>
  elapsed_ms: number
  response_bytes: number
  parsed_as: ParseMode
  truncated_response: boolean
  redirected: boolean
  body_type: BodyType
}

const REDACT_KEYS = new Set(["authorization", "proxy-authorization", "cookie"])

function sanitizeHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers)) {
    out[k] = REDACT_KEYS.has(k.toLowerCase()) ? "<redacted>" : v
  }
  return out
}

function normalizeMethod(input: string): Method {
  const upper = input.trim().toUpperCase()
  if (!(METHODS as readonly string[]).includes(upper)) {
    throw new Error(`http: invalid method '${input}'. Allowed: ${METHODS.join(", ")}`)
  }
  return upper as Method
}

function appendQuery(url: string, query?: Record<string, string>): string {
  if (!query || Object.keys(query).length === 0) return url
  const u = new URL(url)
  for (const [k, v] of Object.entries(query)) {
    u.searchParams.append(k, v)
  }
  return u.toString()
}

function encodeForm(value: unknown): string {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const params = new URLSearchParams()
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v == null) continue
      params.append(k, String(v))
    }
    return params.toString()
  }
  if (typeof value === "string") return value
  throw new Error("http: body_type='form' requires an object body or a pre-encoded string")
}

function buildBody(
  body: unknown,
  bodyType: BodyType,
  headers: Record<string, string>,
): { body: BodyInit | null; appliedType: BodyType } {
  if (body === undefined || body === null) return { body: null, appliedType: bodyType }

  const ct = "content-type"
  const hasContentType = Object.keys(headers).some((k) => k.toLowerCase() === ct)

  if (bodyType === "raw_base64") {
    if (typeof body !== "string") throw new Error("http: body_type='raw_base64' requires a base64 string body")
    const buf = Buffer.from(body, "base64")
    return { body: buf, appliedType: "raw_base64" }
  }

  if (bodyType === "form") {
    const encoded = encodeForm(body)
    if (!hasContentType) headers["Content-Type"] = "application/x-www-form-urlencoded"
    return { body: encoded, appliedType: "form" }
  }

  if (bodyType === "json") {
    const json = typeof body === "string" ? body : JSON.stringify(body)
    if (!hasContentType) headers["Content-Type"] = "application/json"
    return { body: json, appliedType: "json" }
  }

  if (bodyType === "text") {
    if (typeof body !== "string") throw new Error("http: body_type='text' requires a string body")
    return { body, appliedType: "text" }
  }

  // auto
  if (typeof body === "string") return { body, appliedType: "text" }
  const json = JSON.stringify(body)
  if (!hasContentType) headers["Content-Type"] = "application/json"
  return { body: json, appliedType: "json" }
}

function applyAuth(headers: Record<string, string>, auth: Params["auth"]): void {
  if (!auth) return
  const hasAuth = Object.keys(headers).some((k) => k.toLowerCase() === "authorization")
  if (hasAuth) return
  if (auth.type === "bearer") {
    headers["Authorization"] = `Bearer ${auth.token}`
    return
  }
  if (auth.type === "basic") {
    const token = Buffer.from(`${auth.username}:${auth.password}`, "utf8").toString("base64")
    headers["Authorization"] = `Basic ${token}`
    return
  }
}

function statusAccepted(status: number, accept: ReadonlyArray<number>): boolean {
  if (accept.length === 0) return status >= 200 && status < 300
  if (accept.length === 2 && accept[0]! <= accept[1]!) {
    // Treat a 2-element list as a [min, max] range when both bounds are valid status codes.
    const [lo, hi] = accept
    if (lo! <= status && status <= hi!) return true
  }
  return accept.includes(status)
}

function looksLikeJson(contentType: string | null): boolean {
  if (!contentType) return false
  const lower = contentType.toLowerCase()
  return lower.includes("application/json") || lower.includes("+json") || lower.includes("text/json")
}

function decodeResponseBody(buf: Buffer, parsedAs: ParseMode, contentType: string | null): string {
  if (parsedAs === "raw_base64") return buf.toString("base64")
  if (parsedAs === "json") {
    const text = buf.toString("utf8")
    try {
      const parsed = JSON.parse(text)
      return JSON.stringify(parsed, null, 2)
    } catch (err) {
      throw new Error(`http: parse_response='json' but body is not valid JSON: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  if (parsedAs === "text") return buf.toString("utf8")
  // auto
  if (looksLikeJson(contentType)) {
    const text = buf.toString("utf8")
    try {
      const parsed = JSON.parse(text)
      return JSON.stringify(parsed, null, 2)
    } catch {
      return text
    }
  }
  return buf.toString("utf8")
}

function effectivelyParsedAs(parseMode: ParseMode | undefined, contentType: string | null): ParseMode {
  const mode = parseMode ?? "auto"
  if (mode === "auto") return looksLikeJson(contentType) ? "json" : "text"
  return mode
}

async function readBodyWithCap(
  res: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<{ buf: Buffer; truncated: boolean }> {
  if (!res.body) return { buf: Buffer.alloc(0), truncated: false }
  const reader = res.body.getReader()
  const chunks: Buffer[] = []
  let total = 0
  let truncated = false
  try {
    while (true) {
      if (signal.aborted) throw new Error("http: aborted by caller")
      const { value, done } = await reader.read()
      if (done) break
      const chunk = Buffer.from(value)
      if (total + chunk.byteLength > maxBytes) {
        const room = Math.max(0, maxBytes - total)
        if (room > 0) chunks.push(chunk.subarray(0, room))
        total += room
        truncated = true
        try {
          await reader.cancel()
        } catch {}
        break
      }
      chunks.push(chunk)
      total += chunk.byteLength
    }
  } finally {
    try {
      reader.releaseLock()
    } catch {}
  }
  return { buf: Buffer.concat(chunks, total), truncated }
}

export const HttpTool = Tool.define(
  "http",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Params, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const method = normalizeMethod(params.method)
          const url = appendQuery(params.url, params.query)
          if (!/^https?:\/\//i.test(url)) {
            throw new Error("http: url must start with http:// or https://")
          }

          const timeoutMs = Math.min(params.timeout_ms ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS)
          const maxBytes = Math.min(params.max_response_bytes ?? DEFAULT_MAX_BYTES, ABS_MAX_BYTES)
          const followRedirects = params.follow_redirects ?? true
          const acceptStatus = (params.accept_status as ReadonlyArray<number> | undefined) ?? DEFAULT_ACCEPT_STATUS

          const reqHeaders: Record<string, string> = {}
          for (const [k, v] of Object.entries(params.headers ?? {})) reqHeaders[k] = v
          applyAuth(reqHeaders, params.auth)

          const bodyType: BodyType = params.body_type ?? "auto"
          const hasBody = method !== "GET" && method !== "HEAD" && method !== "OPTIONS" && params.body !== undefined
          const built = hasBody
            ? buildBody(params.body, bodyType, reqHeaders)
            : { body: null as BodyInit | null, appliedType: bodyType }

          // ctx.abort signals user cancellation; merge with our timeout.
          const localCtl = new AbortController()
          const timeoutHandle = setTimeout(() => localCtl.abort(new Error("http: timeout")), timeoutMs)
          const onParentAbort = () => localCtl.abort(new Error("http: aborted"))
          if (ctx.abort.aborted) localCtl.abort(new Error("http: aborted"))
          else ctx.abort.addEventListener("abort", onParentAbort, { once: true })

          const start = Date.now()
          let response: Response
          try {
            response = yield* Effect.promise(() =>
              fetch(url, {
                method,
                headers: reqHeaders,
                body: built.body,
                redirect: followRedirects ? "follow" : "manual",
                signal: localCtl.signal,
              }),
            )
          } finally {
            clearTimeout(timeoutHandle)
            ctx.abort.removeEventListener("abort", onParentAbort)
          }

          const respHeaders: Record<string, string> = {}
          response.headers.forEach((v, k) => {
            respHeaders[k] = v
          })

          const { buf, truncated } = yield* Effect.promise(() => readBodyWithCap(response, maxBytes, localCtl.signal))
          const elapsed = Date.now() - start

          const parsedAs = effectivelyParsedAs(params.parse_response, response.headers.get("content-type"))
          const output = decodeResponseBody(buf, parsedAs, response.headers.get("content-type"))

          const meta: Metadata = {
            method,
            url: params.url,
            final_url: response.url || url,
            status: response.status,
            status_text: response.statusText,
            response_headers: respHeaders,
            request_headers: sanitizeHeaders(reqHeaders),
            elapsed_ms: elapsed,
            response_bytes: buf.byteLength,
            parsed_as: parsedAs,
            truncated_response: truncated,
            redirected: response.redirected,
            body_type: built.appliedType,
          }

          if (!statusAccepted(response.status, acceptStatus)) {
            const preview = output.slice(0, 512)
            throw new Error(
              `http: ${method} ${url} → ${response.status} ${response.statusText} (rejected; accept_status=${JSON.stringify(acceptStatus)}). Body preview: ${preview}`,
            )
          }

          const title = `${method} ${response.status} ${shortUrl(response.url || url)} (${elapsed}ms)`
          return {
            title,
            metadata: meta,
            output,
          }
        }),
    }
  }),
)

function shortUrl(url: string): string {
  try {
    const u = new URL(url)
    const path = u.pathname.length > 40 ? u.pathname.slice(0, 37) + "…" : u.pathname
    return `${u.host}${path}`
  } catch {
    return url.length > 60 ? url.slice(0, 57) + "…" : url
  }
}

export const __testing = {
  appendQuery,
  encodeForm,
  buildBody,
  applyAuth,
  statusAccepted,
  looksLikeJson,
  decodeResponseBody,
  effectivelyParsedAs,
  sanitizeHeaders,
  normalizeMethod,
  shortUrl,
}
