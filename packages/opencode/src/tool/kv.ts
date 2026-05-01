import { Effect, Schema } from "effect"
import { mkdir, readFile, rename, stat as fsStat, unlink, writeFile } from "node:fs/promises"
import * as path from "node:path"
import * as os from "node:os"
import { Global } from "@opencode-ai/core/global"
import DESCRIPTION from "./kv.txt"
import * as Tool from "./tool"

const ACTIONS = ["get", "set", "delete", "list", "keys", "incr", "touch", "pop", "clear", "info"] as const
type Action = (typeof ACTIONS)[number]

const MAX_KEY_LEN = 256
const MAX_NS_LEN = 64
const MAX_VALUE_BYTES = 1_048_576
const MAX_TTL_SECONDS = 31_536_000
const DEFAULT_LIST_LIMIT = 100
const MAX_LIST_LIMIT = 1000
const KEY_RE = /^[A-Za-z0-9_\-.:/]+$/
const NS_RE = /^[A-Za-z0-9_\-.:]+$/
const DEFAULT_NAMESPACE = "default"

export const Parameters = Schema.Struct({
  action: Schema.Literals(ACTIONS).annotate({
    description: ACTIONS.join(" | "),
  }),
  key: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(MAX_KEY_LEN))).annotate({
    description: `Key. ASCII letters/digits/_-.:/ only. Up to ${MAX_KEY_LEN} chars.`,
  }),
  value: Schema.optional(Schema.Unknown).annotate({
    description: `JSON value (string, number, boolean, null, array, or object). Serialised size capped at ${MAX_VALUE_BYTES} bytes.`,
  }),
  namespace: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(MAX_NS_LEN))).annotate({
    description: `Logical bucket. ASCII letters/digits/_-.: only. Default '${DEFAULT_NAMESPACE}'.`,
  }),
  ttl_seconds: Schema.optional(
    Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(MAX_TTL_SECONDS)),
  ).annotate({
    description: `Auto-expire after this many seconds. Range 1 - ${MAX_TTL_SECONDS}.`,
  }),
  expires_at: Schema.optional(Schema.String.check(Schema.isMinLength(1))).annotate({
    description: "Absolute expiry as ISO-8601. Mutually exclusive with ttl_seconds.",
  }),
  delta: Schema.optional(Schema.Number.check(Schema.isInt())).annotate({
    description: "Integer delta for incr. Negative allowed. Default 1.",
  }),
  prefix: Schema.optional(Schema.String.check(Schema.isMaxLength(MAX_KEY_LEN))).annotate({
    description: "Filter keys starting with this prefix (list/keys).",
  }),
  limit: Schema.optional(
    Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(MAX_LIST_LIMIT)),
  ).annotate({
    description: `Max entries for list/keys. Default ${DEFAULT_LIST_LIMIT}, max ${MAX_LIST_LIMIT}.`,
  }),
  include_expired: Schema.optional(Schema.Boolean).annotate({
    description: "Also report expired entries (list/keys/info). Default false.",
  }),
  confirm: Schema.optional(Schema.Boolean).annotate({
    description: "Required true to clear.",
  }),
  all_namespaces: Schema.optional(Schema.Boolean).annotate({
    description: "list/keys/info/clear: span every namespace. Default false.",
  }),
})

type Params = Schema.Schema.Type<typeof Parameters>

type Entry = {
  // unix ms
  created_at: number
  // unix ms
  updated_at: number
  // unix ms; undefined = no expiry
  expires_at?: number
  value: unknown
}

type Store = {
  // namespace -> key -> entry
  ns: Record<string, Record<string, Entry>>
  // schema version for forward compat
  v: 1
}

type EntryView = {
  namespace: string
  key: string
  value?: unknown
  expires_at?: string
  created_at?: string
  updated_at?: string
  expired?: boolean
}

type Metadata = {
  action: Action
  namespace?: string
  key?: string
  value?: unknown
  previous_value?: unknown
  found?: boolean
  created?: boolean
  deleted?: boolean
  touched?: boolean
  removed?: number
  entries?: EntryView[]
  keys?: string[]
  total?: number
  truncated?: boolean
  total_entries?: number
  namespaces?: string[]
  bytes_on_disk?: number
  path?: string
  expires_at?: string
}

const done = (result: Tool.ExecuteResult<Metadata>) => result

// ----------------------------------------------------------------------------
// validation helpers
// ----------------------------------------------------------------------------

const validateKey = (key: string | undefined): string => {
  if (!key) throw new Error("kv: 'key' is required for this action")
  if (key.length > MAX_KEY_LEN) throw new Error(`kv: key exceeds ${MAX_KEY_LEN} chars`)
  if (!KEY_RE.test(key)) throw new Error("kv: key must be ASCII letters/digits or _-.:/")
  return key
}

const validateNamespace = (ns: string | undefined): string => {
  const v = ns ?? DEFAULT_NAMESPACE
  if (v.length > MAX_NS_LEN) throw new Error(`kv: namespace exceeds ${MAX_NS_LEN} chars`)
  if (!NS_RE.test(v)) throw new Error("kv: namespace must be ASCII letters/digits or _-.:")
  return v
}

const computeExpiry = (params: Params, now: number): number | undefined => {
  if (params.ttl_seconds !== undefined && params.expires_at !== undefined) {
    throw new Error("kv: ttl_seconds and expires_at are mutually exclusive")
  }
  if (params.ttl_seconds !== undefined) {
    return now + params.ttl_seconds * 1000
  }
  if (params.expires_at !== undefined) {
    const t = Date.parse(params.expires_at)
    if (Number.isNaN(t)) throw new Error(`kv: expires_at is not a valid ISO-8601 timestamp: '${params.expires_at}'`)
    if (t <= now) throw new Error(`kv: expires_at '${params.expires_at}' is in the past`)
    return t
  }
  return undefined
}

const measure = (value: unknown): number => Buffer.byteLength(JSON.stringify(value) ?? "null", "utf8")

const cloneValue = <T,>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T))

const isExpired = (entry: Entry, now: number) => entry.expires_at !== undefined && entry.expires_at <= now

const isoOrUndef = (ms: number | undefined) => (ms === undefined ? undefined : new Date(ms).toISOString())

// ----------------------------------------------------------------------------
// storage
// ----------------------------------------------------------------------------

let inProcessLock: Promise<unknown> = Promise.resolve()

const withLock = <T,>(fn: () => Promise<T>): Promise<T> => {
  const next = inProcessLock.then(fn, fn)
  // swallow next's reject so the chain keeps working
  inProcessLock = next.catch(() => {})
  return next
}

const storePath = (override?: string): string => {
  const env = process.env.OPENCODE_KV_PATH
  if (override) return override
  if (env && env.length > 0) return env
  return path.join(Global.Path.state, "kv.json")
}

const ensureDir = async (file: string) => {
  await mkdir(path.dirname(file), { recursive: true })
}

const readStore = async (file: string): Promise<Store> => {
  try {
    const raw = await readFile(file, "utf8")
    if (raw.trim().length === 0) return emptyStore()
    const parsed = JSON.parse(raw) as Partial<Store>
    if (!parsed || typeof parsed !== "object" || !parsed.ns || typeof parsed.ns !== "object") return emptyStore()
    // best-effort sanitise
    const ns: Record<string, Record<string, Entry>> = {}
    for (const [k, v] of Object.entries(parsed.ns)) {
      if (!v || typeof v !== "object") continue
      ns[k] = v as Record<string, Entry>
    }
    return { ns, v: 1 }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return emptyStore()
    throw err
  }
}

const emptyStore = (): Store => ({ ns: {}, v: 1 })

const writeStore = async (file: string, store: Store) => {
  await ensureDir(file)
  const tmp = path.join(path.dirname(file), `.kv.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`)
  const data = JSON.stringify(store)
  await writeFile(tmp, data, "utf8")
  try {
    await rename(tmp, file)
  } catch (err) {
    // Windows rename across collisions retries: best-effort cleanup of tmp.
    await unlink(tmp).catch(() => {})
    throw err
  }
}

const compactExpired = (store: Store, now: number) => {
  for (const [ns, bucket] of Object.entries(store.ns)) {
    for (const [key, entry] of Object.entries(bucket)) {
      if (isExpired(entry, now)) delete bucket[key]
    }
    if (Object.keys(bucket).length === 0) delete store.ns[ns]
  }
}

// ----------------------------------------------------------------------------
// actions
// ----------------------------------------------------------------------------

type ActionInput = { params: Params; file: string; now: number }

const actGet = async ({ params, file, now }: ActionInput): Promise<Tool.ExecuteResult<Metadata>> => {
  const key = validateKey(params.key)
  const ns = validateNamespace(params.namespace)
  return withLock(async () => {
    const store = await readStore(file)
    const entry = store.ns[ns]?.[key]
    if (!entry || isExpired(entry, now)) {
      return done({
        title: `kv.get ${ns}/${key}: missing`,
        metadata: { action: "get", namespace: ns, key, found: false, value: null },
        output: "null",
      })
    }
    const value = cloneValue(entry.value)
    return done({
      title: `kv.get ${ns}/${key}: ok`,
      metadata: {
        action: "get",
        namespace: ns,
        key,
        found: true,
        value,
        expires_at: isoOrUndef(entry.expires_at),
      },
      output: typeof value === "string" ? value : JSON.stringify(value),
    })
  })
}

const actSet = async ({ params, file, now }: ActionInput): Promise<Tool.ExecuteResult<Metadata>> => {
  const key = validateKey(params.key)
  const ns = validateNamespace(params.namespace)
  if (params.value === undefined) throw new Error("kv: 'value' is required for action='set'")
  const valueBytes = measure(params.value)
  if (valueBytes > MAX_VALUE_BYTES) throw new Error(`kv: serialised value exceeds ${MAX_VALUE_BYTES} bytes (got ${valueBytes})`)
  const expires = computeExpiry(params, now)
  return withLock(async () => {
    const store = await readStore(file)
    const bucket = (store.ns[ns] ??= {})
    const previous = bucket[key]
    const previousValue = previous && !isExpired(previous, now) ? cloneValue(previous.value) : null
    const created = !previous || isExpired(previous, now)
    bucket[key] = {
      created_at: created ? now : previous!.created_at,
      updated_at: now,
      expires_at: expires,
      value: cloneValue(params.value),
    }
    await writeStore(file, store)
    return done({
      title: `kv.set ${ns}/${key}: ${created ? "created" : "updated"}`,
      metadata: {
        action: "set",
        namespace: ns,
        key,
        created,
        previous_value: previousValue,
        expires_at: isoOrUndef(expires),
      },
      output: created ? `created ${ns}/${key}` : `updated ${ns}/${key}`,
    })
  })
}

const actDelete = async ({ params, file }: ActionInput): Promise<Tool.ExecuteResult<Metadata>> => {
  const key = validateKey(params.key)
  const ns = validateNamespace(params.namespace)
  return withLock(async () => {
    const store = await readStore(file)
    const bucket = store.ns[ns]
    const existed = !!bucket && Object.prototype.hasOwnProperty.call(bucket, key)
    if (existed) {
      delete bucket![key]
      if (Object.keys(bucket!).length === 0) delete store.ns[ns]
      await writeStore(file, store)
    }
    return done({
      title: `kv.delete ${ns}/${key}: ${existed ? "ok" : "absent"}`,
      metadata: { action: "delete", namespace: ns, key, deleted: existed },
      output: existed ? `deleted ${ns}/${key}` : `${ns}/${key} not present`,
    })
  })
}

const actIncr = async ({ params, file, now }: ActionInput): Promise<Tool.ExecuteResult<Metadata>> => {
  const key = validateKey(params.key)
  const ns = validateNamespace(params.namespace)
  const delta = params.delta ?? 1
  if (!Number.isInteger(delta)) throw new Error("kv: delta must be an integer")
  const expires = computeExpiry(params, now)
  return withLock(async () => {
    const store = await readStore(file)
    const bucket = (store.ns[ns] ??= {})
    const previous = bucket[key]
    const previousValid = previous && !isExpired(previous, now) ? previous : undefined
    const previousValue = previousValid ? previousValid.value : null
    if (previousValid && (typeof previousValid.value !== "number" || !Number.isFinite(previousValid.value))) {
      throw new Error(`kv: existing value at ${ns}/${key} is not a number, cannot incr`)
    }
    const baseline = (previousValid?.value as number | undefined) ?? 0
    const next = baseline + delta
    bucket[key] = {
      created_at: previousValid?.created_at ?? now,
      updated_at: now,
      expires_at: expires ?? previousValid?.expires_at,
      value: next,
    }
    await writeStore(file, store)
    return done({
      title: `kv.incr ${ns}/${key} ${delta >= 0 ? "+" : ""}${delta} = ${next}`,
      metadata: {
        action: "incr",
        namespace: ns,
        key,
        value: next,
        previous_value: previousValue,
        expires_at: isoOrUndef(bucket[key]!.expires_at),
      },
      output: String(next),
    })
  })
}

const actTouch = async ({ params, file, now }: ActionInput): Promise<Tool.ExecuteResult<Metadata>> => {
  const key = validateKey(params.key)
  const ns = validateNamespace(params.namespace)
  const expires = computeExpiry(params, now)
  return withLock(async () => {
    const store = await readStore(file)
    const entry = store.ns[ns]?.[key]
    if (!entry || isExpired(entry, now)) {
      return done({
        title: `kv.touch ${ns}/${key}: missing`,
        metadata: { action: "touch", namespace: ns, key, touched: false },
        output: `${ns}/${key} not present`,
      })
    }
    entry.updated_at = now
    if (expires !== undefined) entry.expires_at = expires
    else if (params.ttl_seconds === undefined && params.expires_at === undefined) entry.expires_at = undefined
    await writeStore(file, store)
    return done({
      title: `kv.touch ${ns}/${key}: ok`,
      metadata: {
        action: "touch",
        namespace: ns,
        key,
        touched: true,
        expires_at: isoOrUndef(entry.expires_at),
      },
      output: `touched ${ns}/${key}`,
    })
  })
}

const actPop = async ({ params, file, now }: ActionInput): Promise<Tool.ExecuteResult<Metadata>> => {
  const key = validateKey(params.key)
  const ns = validateNamespace(params.namespace)
  return withLock(async () => {
    const store = await readStore(file)
    const entry = store.ns[ns]?.[key]
    if (!entry || isExpired(entry, now)) {
      // Still clean up an expired marker if present.
      if (entry && store.ns[ns]) {
        delete store.ns[ns]![key]
        if (Object.keys(store.ns[ns]!).length === 0) delete store.ns[ns]
        await writeStore(file, store)
      }
      return done({
        title: `kv.pop ${ns}/${key}: missing`,
        metadata: { action: "pop", namespace: ns, key, found: false, value: null, deleted: !!entry },
        output: "null",
      })
    }
    const value = cloneValue(entry.value)
    delete store.ns[ns]![key]
    if (Object.keys(store.ns[ns]!).length === 0) delete store.ns[ns]
    await writeStore(file, store)
    return done({
      title: `kv.pop ${ns}/${key}: ok`,
      metadata: { action: "pop", namespace: ns, key, found: true, value, deleted: true },
      output: typeof value === "string" ? value : JSON.stringify(value),
    })
  })
}

type ListSelection = { namespace: string; key: string; entry: Entry }

const collect = (
  store: Store,
  opts: { namespace?: string; allNamespaces: boolean; prefix?: string; includeExpired: boolean; now: number },
): ListSelection[] => {
  const out: ListSelection[] = []
  const namespaces = opts.allNamespaces ? Object.keys(store.ns) : opts.namespace ? [opts.namespace] : []
  for (const ns of namespaces) {
    const bucket = store.ns[ns]
    if (!bucket) continue
    for (const [key, entry] of Object.entries(bucket)) {
      if (opts.prefix && !key.startsWith(opts.prefix)) continue
      if (!opts.includeExpired && isExpired(entry, opts.now)) continue
      out.push({ namespace: ns, key, entry })
    }
  }
  out.sort((a, b) => {
    const ak = `${a.namespace}/${a.key}`
    const bk = `${b.namespace}/${b.key}`
    return ak < bk ? -1 : ak > bk ? 1 : 0
  })
  return out
}

const actList = async ({ params, file, now }: ActionInput): Promise<Tool.ExecuteResult<Metadata>> => {
  const ns = params.all_namespaces ? undefined : validateNamespace(params.namespace)
  const limit = params.limit ?? DEFAULT_LIST_LIMIT
  return withLock(async () => {
    const store = await readStore(file)
    const all = collect(store, {
      namespace: ns,
      allNamespaces: !!params.all_namespaces,
      prefix: params.prefix,
      includeExpired: !!params.include_expired,
      now,
    })
    const truncated = all.length > limit
    const slice = all.slice(0, limit)
    const entries: EntryView[] = slice.map(({ namespace, key, entry }) => ({
      namespace,
      key,
      value: cloneValue(entry.value),
      expires_at: isoOrUndef(entry.expires_at),
      created_at: isoOrUndef(entry.created_at),
      updated_at: isoOrUndef(entry.updated_at),
      expired: isExpired(entry, now) ? true : undefined,
    }))
    return done({
      title: `kv.list: ${entries.length}${truncated ? ` of ${all.length}` : ""}`,
      metadata: {
        action: "list",
        namespace: ns,
        entries,
        total: all.length,
        truncated,
      },
      output: entries.length === 0 ? "(no entries)" : entries.map((e) => `${e.namespace}/${e.key}`).join("\n"),
    })
  })
}

const actKeys = async ({ params, file, now }: ActionInput): Promise<Tool.ExecuteResult<Metadata>> => {
  const ns = params.all_namespaces ? undefined : validateNamespace(params.namespace)
  const limit = params.limit ?? DEFAULT_LIST_LIMIT
  return withLock(async () => {
    const store = await readStore(file)
    const all = collect(store, {
      namespace: ns,
      allNamespaces: !!params.all_namespaces,
      prefix: params.prefix,
      includeExpired: !!params.include_expired,
      now,
    })
    const truncated = all.length > limit
    const slice = all.slice(0, limit)
    const keys = slice.map(({ namespace, key }) => (params.all_namespaces ? `${namespace}/${key}` : key))
    return done({
      title: `kv.keys: ${keys.length}${truncated ? ` of ${all.length}` : ""}`,
      metadata: {
        action: "keys",
        namespace: ns,
        keys,
        total: all.length,
        truncated,
      },
      output: keys.length === 0 ? "(none)" : keys.join("\n"),
    })
  })
}

const actClear = async ({ params, file }: ActionInput): Promise<Tool.ExecuteResult<Metadata>> => {
  if (!params.confirm) throw new Error("kv: clear requires confirm=true")
  return withLock(async () => {
    const store = await readStore(file)
    let removed = 0
    if (params.all_namespaces) {
      for (const bucket of Object.values(store.ns)) removed += Object.keys(bucket).length
      store.ns = {}
    } else {
      const ns = validateNamespace(params.namespace)
      const bucket = store.ns[ns]
      if (bucket) {
        removed = Object.keys(bucket).length
        delete store.ns[ns]
      }
    }
    await writeStore(file, store)
    return done({
      title: `kv.clear: ${removed}`,
      metadata: {
        action: "clear",
        namespace: params.all_namespaces ? undefined : params.namespace ?? DEFAULT_NAMESPACE,
        removed,
      },
      output: `removed ${removed} entries`,
    })
  })
}

const actInfo = async ({ params, file, now }: ActionInput): Promise<Tool.ExecuteResult<Metadata>> => {
  return withLock(async () => {
    const store = await readStore(file)
    let total = 0
    const namespaces = Object.keys(store.ns).sort()
    for (const ns of namespaces) {
      for (const entry of Object.values(store.ns[ns]!)) {
        if (params.include_expired || !isExpired(entry, now)) total += 1
      }
    }
    let bytes = 0
    try {
      bytes = (await fsStat(file)).size
    } catch {
      bytes = 0
    }
    return done({
      title: `kv.info: ${total} entries, ${namespaces.length} namespaces`,
      metadata: {
        action: "info",
        namespaces,
        total_entries: total,
        bytes_on_disk: bytes,
        path: file,
      },
      output: [
        `path:        ${file}`,
        `namespaces:  ${namespaces.length === 0 ? "(none)" : namespaces.join(", ")}`,
        `total:       ${total}`,
        `bytes:       ${bytes}`,
      ].join("\n"),
    })
  })
}

// ----------------------------------------------------------------------------
// dispatch
// ----------------------------------------------------------------------------

const dispatch = (params: Params, options?: { file?: string; now?: number }): Promise<Tool.ExecuteResult<Metadata>> => {
  const file = options?.file ?? storePath()
  const now = options?.now ?? Date.now()
  const input: ActionInput = { params, file, now }
  switch (params.action) {
    case "get":
      return actGet(input)
    case "set":
      return actSet(input)
    case "delete":
      return actDelete(input)
    case "list":
      return actList(input)
    case "keys":
      return actKeys(input)
    case "incr":
      return actIncr(input)
    case "touch":
      return actTouch(input)
    case "pop":
      return actPop(input)
    case "clear":
      return actClear(input)
    case "info":
      return actInfo(input)
    default:
      throw new Error(`kv: unknown action ${params.action satisfies never}`)
  }
}

export const KvTool = Tool.define(
  "kv",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Params, _ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          return yield* Effect.promise(() => dispatch(params))
        }),
    }
  }),
)

export const __testing = {
  storePath,
  emptyStore,
  computeExpiry,
  isExpired,
  cloneValue,
  collect,
  validateKey,
  validateNamespace,
  measure,
  // expose the internal driver so tests can pump it through arbitrary store paths
  drive: async (params: Params, override?: string, nowOverride?: number) => {
    const file = storePath(override)
    const now = nowOverride ?? Date.now()
    return dispatch({ ...params }, { file, now }).then((r) => ({ result: r, file, now }))
  },
  readStore,
  writeStore,
  compactExpired,
}

// Used by tests to pin a specific store path without setting an env var globally.
export const setStorePathForTesting = (override: string | undefined) => {
  if (override === undefined) delete process.env.OPENCODE_KV_PATH
  else process.env.OPENCODE_KV_PATH = override
}

// Convenience for tests / future tools that want to share a tmp dir.
export const tmpStorePath = (suffix = "") =>
  path.join(os.tmpdir(), `opencode-kv-test-${process.pid}-${Date.now()}${suffix}.json`)
