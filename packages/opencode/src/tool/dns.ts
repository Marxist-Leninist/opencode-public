import { Effect, Schema } from "effect"
import { Resolver } from "node:dns/promises"
import DESCRIPTION from "./dns.txt"
import * as Tool from "./tool"

const ACTIONS = ["lookup", "reverse", "resolve_all"] as const
const TYPES = [
  "A",
  "AAAA",
  "CNAME",
  "MX",
  "TXT",
  "NS",
  "PTR",
  "SOA",
  "SRV",
  "NAPTR",
  "CAA",
  "ANY",
] as const

const ALL_TYPES_FOR_BUNDLE = ["A", "AAAA", "MX", "TXT", "NS", "CNAME", "SOA", "CAA"] as const

export const Parameters = Schema.Struct({
  action: Schema.Literals(ACTIONS).annotate({ description: ACTIONS.join(" | ") }),
  host: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(255))).annotate({
    description: "Hostname (lookup / resolve_all).",
  }),
  ip: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(45))).annotate({
    description: "IPv4 or IPv6 address (reverse).",
  }),
  type: Schema.optional(Schema.Literals(TYPES)).annotate({
    description: "DNS record type (lookup). Default A.",
  }),
  servers: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "Optional resolver IPs (e.g. ['1.1.1.1','8.8.8.8']). Per-query Resolver instance, does not affect global config.",
  }),
  timeout_ms: Schema.optional(
    Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(100), Schema.isLessThanOrEqualTo(60_000)),
  ).annotate({ description: "Per-query timeout. Default 5000." }),
  tries: Schema.optional(
    Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(10)),
  ).annotate({ description: "Resolver retry count. Default 4." }),
})

type Params = Schema.Schema.Type<typeof Parameters>
type Action = (typeof ACTIONS)[number]
type DnsType = (typeof TYPES)[number]

type Metadata = {
  action: Action
  host?: string
  ip?: string
  type?: DnsType
  records?: unknown
  by_type?: Record<string, unknown>
  elapsed_ms: number
  servers?: string[]
}

const done = (result: Tool.ExecuteResult<Metadata>) => result

function makeResolver(opts: { servers?: readonly string[]; timeout_ms?: number; tries?: number }) {
  const r = new Resolver({
    timeout: opts.timeout_ms ?? 5_000,
    tries: opts.tries ?? 4,
  })
  if (opts.servers && opts.servers.length > 0) {
    r.setServers([...opts.servers])
  }
  return r
}

function sortMx<T extends { priority: number; exchange: string }>(arr: T[]): T[] {
  return [...arr].sort((a, b) => a.priority - b.priority || a.exchange.localeCompare(b.exchange))
}

function sortSrv<
  T extends { priority: number; weight: number; port: number; name: string },
>(arr: T[]): T[] {
  return [...arr].sort((a, b) => a.priority - b.priority || b.weight - a.weight || a.name.localeCompare(b.name))
}

function formatRecords(type: DnsType, records: unknown): string {
  if (records === null || records === undefined) return "(no records)"
  if (Array.isArray(records)) {
    if (records.length === 0) return "(no records)"
    if (type === "MX") {
      return (records as Array<{ priority: number; exchange: string }>)
        .map((r) => `${r.priority}\t${r.exchange}`)
        .join("\n")
    }
    if (type === "SRV") {
      return (records as Array<{ priority: number; weight: number; port: number; name: string }>)
        .map((r) => `${r.priority}\t${r.weight}\t${r.port}\t${r.name}`)
        .join("\n")
    }
    if (type === "NAPTR") {
      return (
        records as Array<{
          order: number
          preference: number
          flags: string
          service: string
          regexp: string
          replacement: string
        }>
      )
        .map((r) => `${r.order}\t${r.preference}\t${r.flags}\t${r.service}\t${r.regexp}\t${r.replacement}`)
        .join("\n")
    }
    if (type === "CAA") {
      return (records as Array<Record<string, unknown>>)
        .map((r) => {
          const tag = r.issue
            ? `issue ${JSON.stringify(r.issue)}`
            : r.issuewild
              ? `issuewild ${JSON.stringify(r.issuewild)}`
              : r.iodef
                ? `iodef ${JSON.stringify(r.iodef)}`
                : Object.entries(r)
                    .filter(([k]) => k !== "critical")
                    .map(([k, v]) => `${k} ${JSON.stringify(v)}`)
                    .join(" ")
          return `${r.critical ?? 0} ${tag}`
        })
        .join("\n")
    }
    return (records as unknown[]).map((r) => (typeof r === "string" ? r : JSON.stringify(r))).join("\n")
  }
  return JSON.stringify(records, null, 2)
}

async function resolveType(r: Resolver, host: string, type: DnsType): Promise<unknown> {
  switch (type) {
    case "A":
      return [...(await r.resolve4(host))].sort()
    case "AAAA":
      return [...(await r.resolve6(host))].sort()
    case "CNAME":
      return [...(await r.resolveCname(host))].sort()
    case "MX": {
      const mx = await r.resolveMx(host)
      return sortMx(mx)
    }
    case "TXT": {
      const txt = await r.resolveTxt(host)
      // Node returns string[][]; join chunks per RFC 7208.
      return txt.map((arr) => arr.join(""))
    }
    case "NS":
      return [...(await r.resolveNs(host))].sort()
    case "PTR":
      return [...(await r.resolvePtr(host))]
    case "SOA":
      return await r.resolveSoa(host)
    case "SRV": {
      const srv = await r.resolveSrv(host)
      return sortSrv(srv)
    }
    case "NAPTR":
      return await r.resolveNaptr(host)
    case "CAA":
      return await r.resolveCaa(host)
    case "ANY":
      return await r.resolveAny(host)
  }
}

async function resolveAllBundle(
  r: Resolver,
  host: string,
  perTypeTimeout: number,
): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {}
  await Promise.all(
    ALL_TYPES_FOR_BUNDLE.map(async (t) => {
      try {
        const result = await Promise.race([
          resolveType(r, host, t),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`timeout ${perTypeTimeout}ms`)), perTypeTimeout),
          ),
        ])
        out[t] = result
      } catch (e) {
        out[t] = { error: e instanceof Error ? e.message : String(e) }
      }
    }),
  )
  return out
}

export const DnsTool = Tool.define(
  "dns",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Params, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const action = params.action
          const need = (k: keyof Params, label: string) => {
            const v = params[k]
            if (v === undefined || v === null) throw new Error(`dns.${action}: requires \`${label}\``)
          }

          const start = Date.now()
          const r = makeResolver({
            servers: params.servers,
            timeout_ms: params.timeout_ms,
            tries: params.tries,
          })
          const servers = r.getServers()

          if (action === "lookup") {
            need("host", "host")
            const type: DnsType = params.type ?? "A"
            if (type === "PTR") {
              throw new Error(
                "dns.lookup: PTR records are typically queried via the `reverse` action with an `ip` argument",
              )
            }
            yield* ctx.ask({
              permission: "dns",
              patterns: [`lookup ${type} ${params.host}`],
              always: ["*"],
              metadata: { action, host: params.host, type, servers },
            })
            const records = yield* Effect.promise(() => resolveType(r, params.host!, type))
            const elapsed = Date.now() - start
            const text = formatRecords(type, records)
            return done({
              title: `dns.lookup ${type} ${params.host}`,
              metadata: { action, host: params.host, type, records, elapsed_ms: elapsed, servers },
              output: text,
            })
          }

          if (action === "reverse") {
            need("ip", "ip")
            yield* ctx.ask({
              permission: "dns",
              patterns: [`reverse ${params.ip}`],
              always: ["*"],
              metadata: { action, ip: params.ip, servers },
            })
            const records = yield* Effect.promise(() => r.reverse(params.ip!))
            const elapsed = Date.now() - start
            return done({
              title: `dns.reverse ${params.ip}`,
              metadata: {
                action,
                ip: params.ip,
                records,
                elapsed_ms: elapsed,
                servers,
              },
              output: records.length === 0 ? "(no records)" : records.join("\n"),
            })
          }

          if (action === "resolve_all") {
            need("host", "host")
            const perType = Math.max(params.timeout_ms ?? 5_000, 1_000)
            yield* ctx.ask({
              permission: "dns",
              patterns: [`resolve_all ${params.host}`],
              always: ["*"],
              metadata: { action, host: params.host, types: ALL_TYPES_FOR_BUNDLE, servers },
            })
            const by_type = yield* Effect.promise(() => resolveAllBundle(r, params.host!, perType))
            const elapsed = Date.now() - start
            const lines: string[] = []
            for (const t of ALL_TYPES_FOR_BUNDLE) {
              const v = by_type[t]
              if (
                v &&
                typeof v === "object" &&
                !Array.isArray(v) &&
                "error" in (v as Record<string, unknown>)
              ) {
                lines.push(`${t}: error: ${(v as { error: string }).error}`)
              } else {
                const formatted = formatRecords(t as DnsType, v).split("\n").join("\n  ")
                lines.push(`${t}:\n  ${formatted}`)
              }
            }
            return done({
              title: `dns.resolve_all ${params.host}`,
              metadata: { action, host: params.host, by_type, elapsed_ms: elapsed, servers },
              output: lines.join("\n"),
            })
          }

          throw new Error(`dns: unknown action ${action satisfies never}`)
        }),
    }
  }),
)

export const __testing = {
  formatRecords,
  sortMx,
  sortSrv,
  resolveType,
  resolveAllBundle,
  makeResolver,
}
