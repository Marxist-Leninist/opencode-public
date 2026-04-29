import { Effect, Schema } from "effect"
import DESCRIPTION from "./env.txt"
import * as Tool from "./tool"

const ACTIONS = ["get", "has", "list", "match"] as const

export const Parameters = Schema.Struct({
  action: Schema.Literals(ACTIONS).annotate({
    description:
      "Action: 'get' (single value), 'has' (boolean only), 'list' (names with optional substring filter), 'match' (regex over names).",
  }),
  name: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256))).annotate({
    description: "Variable name. Required for 'get' and 'has'. Case-sensitive.",
  }),
  name_pattern: Schema.optional(Schema.String.check(Schema.isMaxLength(256))).annotate({
    description: "Optional case-insensitive substring filter on names. Used by 'list'.",
  }),
  pattern: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024))).annotate({
    description:
      "Regex (JavaScript flavour, no surrounding slashes) tested against names. Required for 'match'.",
  }),
  pattern_flags: Schema.optional(Schema.String.check(Schema.isMaxLength(8))).annotate({
    description: "Optional regex flags for 'match'. Defaults to empty (case-sensitive).",
  }),
  include_values: Schema.optional(Schema.Boolean).annotate({
    description: "When true, include values in 'list'/'match' results. Default false.",
  }),
  mask_secrets: Schema.optional(Schema.Boolean).annotate({
    description:
      "When include_values is true, replace values for secret-looking names (key/secret/token/password/auth) with ***. Default true.",
  }),
  limit: Schema.optional(
    Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(1000)),
  ).annotate({
    description: "Cap on entries returned by 'list'/'match'. Default 200, max 1000.",
  }),
})

type Params = Schema.Schema.Type<typeof Parameters>
type Action = (typeof ACTIONS)[number]

type Entry = { name: string; value?: string | null; secret?: boolean }

type Metadata = {
  action: Action
  name?: string
  name_pattern?: string
  pattern?: string
  pattern_flags?: string
  include_values?: boolean
  mask_secrets?: boolean
  limit?: number
  total?: number
  count?: number
  truncated?: boolean
  set?: boolean
  value?: string | null
  entries?: Entry[]
}

const SECRET_RE = /(api[_-]?key|secret|token|password|passwd|auth|credential|client[_-]?secret|private[_-]?key|session)/i

const isSecretName = (name: string) => SECRET_RE.test(name)

const maskValue = (value: string | undefined, name: string, mask: boolean): string | undefined => {
  if (value === undefined) return undefined
  if (!mask) return value
  if (!isSecretName(name)) return value
  if (value.length === 0) return ""
  return "***"
}

const done = (result: Tool.ExecuteResult<Metadata>) => result

function doGet(params: Params): Tool.ExecuteResult<Metadata> {
  if (!params.name) throw new Error("'name' is required for action 'get'")
  const value = process.env[params.name]
  const set = value !== undefined
  return done({
    title: set ? `env get ${params.name} (${value!.length} chars)` : `env get ${params.name} (not set)`,
    metadata: {
      action: "get",
      name: params.name,
      set,
      value: set ? value! : null,
    },
    output: set ? value! : "",
  })
}

function doHas(params: Params): Tool.ExecuteResult<Metadata> {
  if (!params.name) throw new Error("'name' is required for action 'has'")
  const set = process.env[params.name] !== undefined
  return done({
    title: `env has ${params.name}: ${set}`,
    metadata: { action: "has", name: params.name, set },
    output: set ? "true" : "false",
  })
}

function doList(params: Params): Tool.ExecuteResult<Metadata> {
  const includeValues = params.include_values ?? false
  const maskSecrets = params.mask_secrets ?? true
  const limit = params.limit ?? 200
  const filter = params.name_pattern?.toLowerCase()

  const allNames = Object.keys(process.env).sort()
  const filtered = filter ? allNames.filter((n) => n.toLowerCase().includes(filter)) : allNames
  const sliced = filtered.slice(0, limit)
  const truncated = filtered.length > sliced.length

  const entries: Entry[] = sliced.map((name) => {
    const raw = process.env[name]
    const secret = isSecretName(name)
    const entry: Entry = { name }
    if (includeValues) entry.value = maskValue(raw, name, maskSecrets) ?? null
    if (secret) entry.secret = true
    return entry
  })

  const lines = entries.map((e) =>
    includeValues ? `${e.name}=${e.value ?? ""}${e.secret ? "  # secret" : ""}` : e.name + (e.secret ? "  # secret" : ""),
  )
  if (truncated) lines.push(`... ${filtered.length - sliced.length} more (raise limit)`)

  return done({
    title: `env list ${entries.length}/${filtered.length}${filter ? ` matching '${params.name_pattern}'` : ""}`,
    metadata: {
      action: "list",
      name_pattern: params.name_pattern,
      include_values: includeValues,
      mask_secrets: maskSecrets,
      limit,
      total: filtered.length,
      count: entries.length,
      truncated,
      entries,
    },
    output: lines.join("\n"),
  })
}

function doMatch(params: Params): Tool.ExecuteResult<Metadata> {
  if (!params.pattern) throw new Error("'pattern' is required for action 'match'")
  const flags = params.pattern_flags ?? ""
  let re: RegExp
  try {
    re = new RegExp(params.pattern, flags)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`invalid regex /${params.pattern}/${flags}: ${msg}`)
  }
  const includeValues = params.include_values ?? false
  const maskSecrets = params.mask_secrets ?? true
  const limit = params.limit ?? 200

  const allNames = Object.keys(process.env).sort()
  const filtered = allNames.filter((n) => re.test(n))
  const sliced = filtered.slice(0, limit)
  const truncated = filtered.length > sliced.length

  const entries: Entry[] = sliced.map((name) => {
    const raw = process.env[name]
    const secret = isSecretName(name)
    const entry: Entry = { name }
    if (includeValues) entry.value = maskValue(raw, name, maskSecrets) ?? null
    if (secret) entry.secret = true
    return entry
  })

  const lines = entries.map((e) =>
    includeValues ? `${e.name}=${e.value ?? ""}${e.secret ? "  # secret" : ""}` : e.name + (e.secret ? "  # secret" : ""),
  )
  if (truncated) lines.push(`... ${filtered.length - sliced.length} more (raise limit)`)

  return done({
    title: `env match /${params.pattern}/${flags}: ${entries.length}/${filtered.length}`,
    metadata: {
      action: "match",
      pattern: params.pattern,
      pattern_flags: flags,
      include_values: includeValues,
      mask_secrets: maskSecrets,
      limit,
      total: filtered.length,
      count: entries.length,
      truncated,
      entries,
    },
    output: lines.join("\n"),
  })
}

export const EnvTool = Tool.define(
  "env",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Params, _ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          switch (params.action) {
            case "get":
              return doGet(params)
            case "has":
              return doHas(params)
            case "list":
              return doList(params)
            case "match":
              return doMatch(params)
          }
        }),
    }
  }),
)

export const __testing = { isSecretName, maskValue, doGet, doHas, doList, doMatch }
