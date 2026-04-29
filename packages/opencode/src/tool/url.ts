import { Effect, Schema } from "effect"
import DESCRIPTION from "./url.txt"
import * as Tool from "./tool"

const ACTIONS = [
  "parse",
  "build",
  "set_query",
  "remove_query",
  "get_query",
  "normalize",
  "join",
  "encode",
  "decode",
] as const

const MAX_INPUT_LENGTH = 1024 * 1024 // 1 MiB — comfortable for any sane URL.

export const Parameters = Schema.Struct({
  action: Schema.Literals(ACTIONS).annotate({
    description:
      "parse, build, set_query, remove_query, get_query, normalize, join, encode, decode.",
  }),
  value: Schema.optional(Schema.String).annotate({
    description: "The input URL or string. Required for all actions except 'build'.",
  }),
  base: Schema.optional(Schema.String).annotate({
    description: "Absolute base URL for action='join'.",
  }),
  parts: Schema.optional(Schema.Unknown).annotate({
    description:
      "Object of URL parts for action='build'. Recognised keys: protocol, host, hostname, port, path/pathname, query (object), fragment/hash, username, password.",
  }),
  params: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)).annotate({
    description:
      "Map of query params for action='set_query'. Values may be strings, numbers, or null (null removes the key).",
  }),
  keys: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "Array of query-param names for action='remove_query' or action='get_query'.",
  }),
})

type Params = Schema.Schema.Type<typeof Parameters>
type Action = (typeof ACTIONS)[number]

type ParsedParts = {
  href: string
  protocol: string
  host: string
  hostname: string
  port: string
  pathname: string
  search: string
  searchParams: Record<string, string>
  hash: string
  origin: string
  username: string
  password: string
}

type Metadata = {
  action: Action
  url?: string
  value?: string
  values?: Record<string, string[]>
  parts?: ParsedParts
}

const done = (result: Tool.ExecuteResult<Metadata>) => result

function ensureValue(action: Action, value: string | undefined): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`url: action='${action}' requires 'value'`)
  }
  if (value.length > MAX_INPUT_LENGTH) {
    throw new Error(`url: 'value' exceeds ${MAX_INPUT_LENGTH} bytes`)
  }
  return value
}

function parseUrl(input: string, base?: string): URL {
  try {
    return new URL(input, base)
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err)
    throw new Error(`url: cannot parse '${input}': ${why}`)
  }
}

export function toParts(u: URL): ParsedParts {
  const searchParams: Record<string, string> = {}
  for (const [k, v] of u.searchParams.entries()) searchParams[k] = v
  return {
    href: u.href,
    protocol: u.protocol.replace(/:$/, ""),
    host: u.host,
    hostname: u.hostname,
    port: u.port,
    pathname: u.pathname,
    search: u.search,
    searchParams,
    hash: u.hash,
    origin: u.origin,
    username: u.username,
    password: u.password,
  }
}

function setSearchParams(u: URL, params: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(params)) {
    if (v === null || v === undefined) {
      u.searchParams.delete(k)
      continue
    }
    if (typeof v === "string") {
      u.searchParams.set(k, v)
      continue
    }
    if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint") {
      u.searchParams.set(k, String(v))
      continue
    }
    throw new Error(`url: param '${k}' must be string|number|boolean|null, got ${typeof v}`)
  }
}

function removeKeys(u: URL, keys: readonly string[]): void {
  for (const k of keys) u.searchParams.delete(k)
}

function getKeys(u: URL, keys: readonly string[]): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const k of keys) out[k] = u.searchParams.getAll(k)
  return out
}

export function normalize(input: string): string {
  const u = parseUrl(input)
  // Lowercase scheme + host (URL already lowercases hostname).
  const proto = u.protocol.toLowerCase()
  // Drop default ports for http/https.
  if ((proto === "http:" && u.port === "80") || (proto === "https:" && u.port === "443")) {
    u.port = ""
  }
  // Sort query params alphabetically. Stable for repeated keys (preserve order within a key).
  const buckets = new Map<string, string[]>()
  for (const [k, v] of u.searchParams.entries()) {
    const arr = buckets.get(k) ?? []
    arr.push(v)
    buckets.set(k, arr)
  }
  // Rebuild searchParams in sorted-key order.
  // Empty the existing list first.
  for (const k of Array.from(u.searchParams.keys())) u.searchParams.delete(k)
  const sortedKeys = Array.from(buckets.keys()).sort()
  for (const k of sortedKeys) {
    for (const v of buckets.get(k)!) u.searchParams.append(k, v)
  }
  // Drop a trailing `?` if there are no params, and drop a lone `#`.
  let href = u.href
  if (u.search === "" && href.endsWith("?")) href = href.slice(0, -1)
  if (u.hash === "" && href.endsWith("#")) href = href.slice(0, -1)
  return href
}

export function buildUrl(parts: Record<string, unknown>): string {
  const protocol = String(parts.protocol ?? "https").replace(/:$/, "").toLowerCase()
  const hostname = parts.hostname !== undefined ? String(parts.hostname) : parts.host !== undefined ? String(parts.host).split(":")[0] : undefined
  if (!hostname) throw new Error("url: build requires 'host' or 'hostname'")
  let host = hostname
  const port =
    parts.port !== undefined
      ? String(parts.port)
      : parts.host !== undefined && String(parts.host).includes(":")
        ? String(parts.host).split(":")[1]
        : ""
  if (port) host += `:${port}`
  const pathname = parts.path !== undefined ? String(parts.path) : parts.pathname !== undefined ? String(parts.pathname) : "/"
  const userinfoBits: string[] = []
  if (parts.username !== undefined && parts.username !== "") userinfoBits.push(encodeURIComponent(String(parts.username)))
  if (parts.password !== undefined && parts.password !== "") userinfoBits.push(`:${encodeURIComponent(String(parts.password))}`)
  const userinfo = userinfoBits.length ? userinfoBits.join("") + "@" : ""
  const fragmentRaw = parts.fragment !== undefined ? parts.fragment : parts.hash
  const fragment = fragmentRaw === undefined || fragmentRaw === "" ? "" : "#" + String(fragmentRaw).replace(/^#/, "")
  // Build base then attach query via URL so encoding is consistent.
  const path = pathname.startsWith("/") ? pathname : "/" + pathname
  const base = `${protocol}://${userinfo}${host}${path}`
  const u = new URL(base)
  if (parts.query !== undefined) {
    if (typeof parts.query !== "object" || parts.query === null) {
      throw new Error("url: build 'query' must be an object")
    }
    setSearchParams(u, parts.query as Record<string, unknown>)
  }
  let href = u.href
  if (fragment) href = href + fragment
  return href
}

export const UrlTool = Tool.define(
  "url",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Params, _ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const action = params.action

          if (action === "parse") {
            const v = ensureValue(action, params.value)
            const u = parseUrl(v)
            const parts = toParts(u)
            return done({
              title: `url.parse: ${parts.host}${parts.pathname}`,
              metadata: { action, url: u.href, parts },
              output: JSON.stringify(parts, null, 2),
            })
          }

          if (action === "build") {
            if (!params.parts || typeof params.parts !== "object") {
              throw new Error("url: build requires 'parts' object")
            }
            const href = buildUrl(params.parts as Record<string, unknown>)
            return done({
              title: `url.build: ${href.length > 60 ? href.slice(0, 57) + "…" : href}`,
              metadata: { action, url: href },
              output: href,
            })
          }

          if (action === "normalize") {
            const v = ensureValue(action, params.value)
            const out = normalize(v)
            return done({
              title: `url.normalize`,
              metadata: { action, url: out },
              output: out,
            })
          }

          if (action === "set_query") {
            const v = ensureValue(action, params.value)
            const u = parseUrl(v)
            const p = params.params ?? {}
            setSearchParams(u, p as Record<string, unknown>)
            return done({
              title: `url.set_query: ${Object.keys(p).length} key(s)`,
              metadata: { action, url: u.href, parts: toParts(u) },
              output: u.href,
            })
          }

          if (action === "remove_query") {
            const v = ensureValue(action, params.value)
            const u = parseUrl(v)
            const keys = params.keys ?? []
            removeKeys(u, keys)
            return done({
              title: `url.remove_query: ${keys.length} key(s)`,
              metadata: { action, url: u.href, parts: toParts(u) },
              output: u.href,
            })
          }

          if (action === "get_query") {
            const v = ensureValue(action, params.value)
            const u = parseUrl(v)
            const keys = params.keys ?? []
            const values = getKeys(u, keys)
            const lines = keys.map((k) => `${k} = ${JSON.stringify(values[k])}`)
            return done({
              title: `url.get_query: ${keys.length} key(s)`,
              metadata: { action, values },
              output: lines.join("\n"),
            })
          }

          if (action === "join") {
            const v = ensureValue(action, params.value)
            if (!params.base) throw new Error("url: action='join' requires 'base'")
            const u = parseUrl(v, params.base)
            return done({
              title: `url.join`,
              metadata: { action, url: u.href, parts: toParts(u) },
              output: u.href,
            })
          }

          if (action === "encode") {
            const v = ensureValue(action, params.value)
            const out = encodeURIComponent(v)
            return done({
              title: `url.encode`,
              metadata: { action, value: out },
              output: out,
            })
          }

          if (action === "decode") {
            const v = ensureValue(action, params.value)
            let out: string
            try {
              out = decodeURIComponent(v)
            } catch (err) {
              const why = err instanceof Error ? err.message : String(err)
              throw new Error(`url: decode failed: ${why}`)
            }
            return done({
              title: `url.decode`,
              metadata: { action, value: out },
              output: out,
            })
          }

          throw new Error(`url: unsupported action '${action}'`)
        }),
    }
  }),
)

export const __testing = {
  toParts,
  normalize,
  buildUrl,
}
