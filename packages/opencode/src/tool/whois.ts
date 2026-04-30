import { Effect, Schema } from "effect"
import * as net from "node:net"
import DESCRIPTION from "./whois.txt"
import * as Tool from "./tool"

export const Parameters = Schema.Struct({
  query: Schema.String.annotate({ description: "Domain, IP, CIDR, URL, or AS number." }),
  server: Schema.optional(Schema.String).annotate({ description: "Whois server hostname (default chosen by query type)." }),
  port: Schema.optional(Schema.Number).annotate({ description: "TCP port (default 43)." }),
  follow_referrals: Schema.optional(Schema.Boolean).annotate({ description: "Follow ReferralServer/Whois Server/refer: hops. Default true." }),
  max_hops: Schema.optional(Schema.Number).annotate({ description: "Max hops including initial. Default 4." }),
  timeout_ms: Schema.optional(Schema.Number).annotate({ description: "Per-hop TCP timeout. Default 8000." }),
  raw_only: Schema.optional(Schema.Boolean).annotate({ description: "If true, skip parsing summary." }),
})

type Params = Schema.Schema.Type<typeof Parameters>

type Hop = {
  server: string
  port: number
  latency_ms: number
  length: number
  error?: string
}

type Metadata = {
  query: string
  hops: Hop[]
  parsed_keys?: number
}

function classifyQuery(q: string): { kind: "domain" | "ip" | "asn"; value: string } {
  let s = q.trim()
  // Strip URL scheme/path
  const urlM = s.match(/^[a-z][a-z0-9+\-.]*:\/\/([^/?#]+)/i)
  if (urlM) s = urlM[1]!
  s = s.replace(/^www\./i, "")
  s = s.replace(/\/+$/, "")
  // ASN
  if (/^as\s*\d+$/i.test(s) || /^\d+$/.test(s.replace(/^as/i, ""))) {
    return { kind: "asn", value: s.toUpperCase().replace(/\s+/g, "") }
  }
  // IPv4 / IPv6 / CIDR
  if (/^[0-9.]+(\/\d+)?$/.test(s) || /^[0-9a-f:]+(\/\d+)?$/i.test(s)) {
    return { kind: "ip", value: s }
  }
  return { kind: "domain", value: s.toLowerCase() }
}

function pickInitialServer(kind: "domain" | "ip" | "asn", value: string, override?: string): string {
  if (override) return override
  if (kind === "domain") return "whois.iana.org"
  if (kind === "asn") return "whois.iana.org"
  // IP
  return "whois.iana.org"
}

function tcpQuery(host: string, port: number, payload: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const start = Date.now()
    let buf = ""
    let settled = false
    const sock = net.createConnection({ host, port, family: 0 })
    const fail = (e: Error) => {
      if (settled) return
      settled = true
      try { sock.destroy() } catch {}
      reject(e)
    }
    sock.setEncoding("utf8")
    sock.setTimeout(timeoutMs)
    sock.on("connect", () => {
      sock.write(payload)
    })
    sock.on("data", (d) => {
      buf += d.toString()
      // safety cap
      if (buf.length > 1_500_000) {
        try { sock.destroy() } catch {}
      }
    })
    sock.on("end", () => {
      if (settled) return
      settled = true
      resolve(buf)
    })
    sock.on("close", () => {
      if (settled) return
      settled = true
      // Some servers close without sending FIN cleanly; if we got data, treat as ok
      if (buf.length > 0) resolve(buf)
      else reject(new Error(`whois ${host}:${port} closed with no data after ${Date.now() - start}ms`))
    })
    sock.on("timeout", () => fail(new Error(`whois ${host}:${port} timeout after ${timeoutMs}ms`)))
    sock.on("error", (e) => fail(e instanceof Error ? e : new Error(String(e))))
  })
}

function buildPayload(kind: "domain" | "ip" | "asn", value: string, server: string): string {
  if (kind === "asn" && server.includes("whois.arin.net")) return `a ${value}\r\n`
  if (kind === "ip" && server.includes("whois.arin.net")) return `n + ${value}\r\n`
  return `${value}\r\n`
}

const REFERRAL_PATTERNS: RegExp[] = [
  /^\s*ReferralServer:\s*(?:whois:\/\/)?([^\s\r\n]+)/im,
  /^\s*Whois\s+Server:\s*([^\s\r\n]+)/im,
  /^\s*refer:\s*([^\s\r\n]+)/im,
  /^\s*Registrar\s+WHOIS\s+Server:\s*([^\s\r\n]+)/im,
]

function findReferral(raw: string): { host: string; port: number } | null {
  for (const re of REFERRAL_PATTERNS) {
    const m = raw.match(re)
    if (m) {
      let host = m[1]!.trim()
      let port = 43
      const portM = host.match(/^(.+):(\d+)$/)
      if (portM) {
        host = portM[1]!
        port = Number(portM[2])
      }
      return { host: host.replace(/^whois:\/\//, ""), port }
    }
  }
  return null
}

const SUMMARY_KEYS = new Set(
  [
    "Domain Name",
    "Registry Domain ID",
    "Registrar",
    "Registrar URL",
    "Registrar IANA ID",
    "Updated Date",
    "Creation Date",
    "Registry Expiry Date",
    "Registrar Registration Expiration Date",
    "Domain Status",
    "Name Server",
    "DNSSEC",
    "Registrant Organization",
    "Registrant Country",
    "Registrant Email",
    "Admin Email",
    "Tech Email",
    "NetRange",
    "CIDR",
    "NetName",
    "OrgName",
    "Organization",
    "Country",
    "OriginAS",
    "ASNumber",
    "ASName",
    "inetnum",
    "netname",
    "country",
    "descr",
    "owner",
    "ownerid",
    "responsible",
    "origin",
  ].map((k) => k.toLowerCase()),
)

function parseSummary(raw: string): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {}
  for (const line of raw.split(/\r?\n/)) {
    if (!line || line.startsWith("%") || line.startsWith("#")) continue
    const m = line.match(/^\s*([A-Za-z][A-Za-z0-9 ._-]{1,40}):\s*(.+?)\s*$/)
    if (!m) continue
    const key = m[1]!.trim()
    const val = m[2]!.trim()
    if (!val) continue
    const lk = key.toLowerCase()
    if (!SUMMARY_KEYS.has(lk)) continue
    if (out[key] === undefined) out[key] = val
    else if (Array.isArray(out[key])) (out[key] as string[]).push(val)
    else out[key] = [out[key] as string, val]
  }
  return out
}

const done = (result: Tool.ExecuteResult<Metadata>) => result

export const WhoisTool = Tool.define(
  "whois",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Params, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const { kind, value } = classifyQuery(params.query)
          const startServer = pickInitialServer(kind, value, params.server)
          const port = params.port ?? 43
          const followReferrals = params.follow_referrals ?? true
          const maxHops = Math.min(Math.max(params.max_hops ?? 4, 1), 8)
          const timeoutMs = Math.min(Math.max(params.timeout_ms ?? 8000, 500), 60000)

          const hops: Hop[] = []
          const rawParts: string[] = []
          const seen = new Set<string>()
          let nextServer: string | null = startServer
          let nextPort = port

          while (nextServer && hops.length < maxHops) {
            const sigKey = `${nextServer}:${nextPort}`.toLowerCase()
            if (seen.has(sigKey)) break
            seen.add(sigKey)
            yield* ctx.ask({
              permission: "whois",
              patterns: [`${nextServer}:${nextPort}`],
              always: ["*"],
              metadata: { query: value, kind, server: nextServer, port: nextPort, hop: hops.length + 1 },
            })
            const start = Date.now()
            let raw = ""
            let err: string | undefined
            try {
              raw = yield* Effect.promise(() =>
                tcpQuery(nextServer!, nextPort, buildPayload(kind, value, nextServer!), timeoutMs),
              )
            } catch (e: any) {
              err = e?.message ?? String(e)
            }
            hops.push({
              server: nextServer,
              port: nextPort,
              latency_ms: Date.now() - start,
              length: raw.length,
              error: err,
            })
            if (err) break
            rawParts.push(`--- via ${nextServer}:${nextPort} ---\n${raw}`)
            if (!followReferrals) break
            const ref = findReferral(raw)
            if (!ref) break
            nextServer = ref.host
            nextPort = ref.port
          }

          const fullRaw = rawParts.join("\n")
          let summary: Record<string, string | string[]> | undefined
          let parsedKeys = 0
          if (!params.raw_only && fullRaw) {
            summary = parseSummary(fullRaw)
            parsedKeys = Object.keys(summary).length
          }

          const titleSrv = hops[hops.length - 1]?.server ?? startServer
          const result = params.raw_only
            ? { hops, raw: fullRaw }
            : { kind, query: value, hops, summary, raw: fullRaw }

          return done({
            title: `whois: ${value} (${hops.length} hop${hops.length === 1 ? "" : "s"} -> ${titleSrv})`,
            metadata: { query: value, hops, parsed_keys: parsedKeys },
            output: JSON.stringify(result, null, 2),
          })
        }),
    }
  }),
)

export const __testing = {
  classifyQuery,
  findReferral,
  parseSummary,
}
