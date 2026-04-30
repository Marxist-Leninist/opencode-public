import { Effect, Schema } from "effect"
import { connect, type ConnectionOptions, type DetailedPeerCertificate, type PeerCertificate, type TLSSocket } from "node:tls"
import { isIP } from "node:net"
import DESCRIPTION from "./tls.txt"
import * as Tool from "./tool"

const ACTIONS = ["inspect", "chain", "expiry"] as const
const TLS_VERSIONS = ["TLSv1", "TLSv1.1", "TLSv1.2", "TLSv1.3"] as const

export const Parameters = Schema.Struct({
  action: Schema.Literals(ACTIONS).annotate({ description: ACTIONS.join(" | ") }),
  host: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(255)).annotate({
    description: "Hostname or IP to connect to.",
  }),
  port: Schema.optional(
    Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(65535)),
  ).annotate({ description: "TCP port. Default 443." }),
  servername: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(255))).annotate({
    description: "SNI value. Default = host (omitted when host is a literal IP).",
  }),
  timeout_ms: Schema.optional(
    Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(100), Schema.isLessThanOrEqualTo(60_000)),
  ).annotate({ description: "Connection timeout. Default 8000." }),
  min_version: Schema.optional(Schema.Literals(TLS_VERSIONS)).annotate({
    description: "Min TLS version.",
  }),
  max_version: Schema.optional(Schema.Literals(TLS_VERSIONS)).annotate({
    description: "Max TLS version.",
  }),
  alpn_protocols: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "ALPN list to advertise (e.g. ['h2','http/1.1']).",
  }),
  reject_unauthorized: Schema.optional(Schema.Boolean).annotate({
    description: "Default true. When false, broken/self-signed certs still report.",
  }),
  ca: Schema.optional(Schema.String).annotate({
    description: "Optional PEM trust anchor(s) to override the default CA bundle.",
  }),
})

type Params = Schema.Schema.Type<typeof Parameters>
type Action = (typeof ACTIONS)[number]

type CertSummary = {
  subject: Record<string, string>
  issuer: Record<string, string>
  valid_from: string
  valid_to: string
  days_until_expiry: number
  expired: boolean
  not_yet_valid: boolean
  serial_number?: string
  fingerprint_sha256?: string
  subject_alt_names?: string[]
  key?: { type: string; bits?: number; curve?: string }
  signature_algorithm?: string
}

type Metadata = {
  action: Action
  host: string
  port: number
  servername?: string
  protocol?: string | null
  cipher?: ReturnType<TLSSocket["getCipher"]> | null
  alpn_protocol?: string | false | null
  session_reused?: boolean
  authorized?: boolean
  authorization_error?: string
  certificate?: CertSummary
  chain?: CertSummary[]
  hostname_match?: { matched: boolean; matched_san?: string; reason?: string }
  elapsed_ms: number
}

const done = (result: Tool.ExecuteResult<Metadata>) => result

function parseSubject(raw: string | { [k: string]: string | string[] } | undefined): Record<string, string> {
  if (!raw) return {}
  if (typeof raw === "string") {
    const out: Record<string, string> = {}
    for (const part of raw.split(",")) {
      const idx = part.indexOf("=")
      if (idx <= 0) continue
      out[part.slice(0, idx).trim()] = part.slice(idx + 1).trim()
    }
    return out
  }
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw)) out[k] = Array.isArray(v) ? v.join(", ") : v
  return out
}

function parseSan(raw: string | undefined): string[] {
  if (!raw) return []
  // Node returns "DNS:foo, DNS:*.bar, IP Address:1.2.3.4, URI:https://x"
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => s.replace(/^IP Address:/i, "IP:"))
}

export function summarizeCert(cert: PeerCertificate): CertSummary {
  const now = Date.now()
  const validFrom = new Date(cert.valid_from)
  const validTo = new Date(cert.valid_to)
  const days = Math.floor((validTo.getTime() - now) / (1000 * 60 * 60 * 24))
  const sans = parseSan((cert as unknown as { subjectaltname?: string }).subjectaltname)
  const pub = (cert as unknown as { pubkey?: Buffer; bits?: number; asn1Curve?: string; nistCurve?: string }) ?? {}
  let key: CertSummary["key"]
  if (pub.bits) {
    key = { type: pub.nistCurve || pub.asn1Curve ? "EC" : "RSA", bits: pub.bits }
    if (pub.nistCurve) key.curve = pub.nistCurve
    else if (pub.asn1Curve) key.curve = pub.asn1Curve
  }
  return {
    subject: parseSubject(cert.subject as unknown as Record<string, string | string[]>),
    issuer: parseSubject(cert.issuer as unknown as Record<string, string | string[]>),
    valid_from: validFrom.toISOString(),
    valid_to: validTo.toISOString(),
    days_until_expiry: days,
    expired: validTo.getTime() < now,
    not_yet_valid: validFrom.getTime() > now,
    serial_number: (cert as unknown as { serialNumber?: string }).serialNumber,
    fingerprint_sha256: (cert as unknown as { fingerprint256?: string }).fingerprint256,
    subject_alt_names: sans,
    key,
    signature_algorithm: (cert as unknown as { asn1Algorithm?: string; sigalg?: string }).asn1Algorithm
      ?? (cert as unknown as { sigalg?: string }).sigalg,
  }
}

function chainFromDetailed(leaf: DetailedPeerCertificate, max = 16): CertSummary[] {
  const out: CertSummary[] = []
  let cur: DetailedPeerCertificate | undefined = leaf
  const seen = new Set<string>()
  while (cur && out.length < max) {
    const fp = (cur as unknown as { fingerprint256?: string }).fingerprint256 ?? JSON.stringify(cur.subject)
    if (seen.has(fp)) break
    seen.add(fp)
    out.push(summarizeCert(cur))
    const issuer = cur.issuerCertificate as DetailedPeerCertificate | undefined
    if (!issuer || issuer === cur) break
    cur = issuer
  }
  return out
}

export function hostnameMatches(name: string, sans: string[], cn?: string): { matched: boolean; matched_san?: string; reason?: string } {
  if (!name) return { matched: false, reason: "no servername" }
  const candidates = sans.length > 0 ? sans : cn ? [`DNS:${cn}`] : []
  if (candidates.length === 0) return { matched: false, reason: "no SAN or CN" }
  const isIp = isIP(name) !== 0
  for (const entry of candidates) {
    const idx = entry.indexOf(":")
    if (idx <= 0) continue
    const kind = entry.slice(0, idx).trim().toUpperCase()
    const value = entry.slice(idx + 1).trim()
    if (isIp && kind === "IP") {
      if (value === name) return { matched: true, matched_san: entry }
      continue
    }
    if (!isIp && kind === "DNS") {
      if (matchesDnsName(name, value)) return { matched: true, matched_san: entry }
    }
  }
  return { matched: false, reason: `no SAN matches ${name}` }
}

function matchesDnsName(name: string, pattern: string): boolean {
  const n = name.toLowerCase()
  const p = pattern.toLowerCase()
  if (p === n) return true
  // Wildcard only allowed in leftmost label, only one wildcard, must not match a dot.
  if (!p.startsWith("*.")) return false
  const suffix = p.slice(1) // ".example.com"
  if (!n.endsWith(suffix)) return false
  const head = n.slice(0, n.length - suffix.length)
  if (head.length === 0) return false
  if (head.includes(".")) return false
  return true
}

function tlsConnect(opts: ConnectionOptions, timeoutMs: number): Promise<TLSSocket> {
  return new Promise<TLSSocket>((resolve, reject) => {
    let settled = false
    const sock = connect(opts, () => {
      if (settled) return
      settled = true
      resolve(sock)
    })
    sock.setTimeout(timeoutMs, () => {
      if (settled) return
      settled = true
      sock.destroy()
      reject(new Error(`tls: connect timeout after ${timeoutMs}ms`))
    })
    sock.once("error", (err: Error) => {
      if (settled) return
      settled = true
      reject(err)
    })
  })
}

export const TlsTool = Tool.define(
  "tls",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Params, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const action = params.action
          const port = params.port ?? 443
          const isLiteralIp = isIP(params.host) !== 0
          const servername = params.servername ?? (isLiteralIp ? undefined : params.host)
          const timeout = params.timeout_ms ?? 8_000

          yield* ctx.ask({
            permission: "tls",
            patterns: [`${action} ${params.host}:${port}`],
            always: ["*"],
            metadata: { action, host: params.host, port, servername },
          })

          const start = Date.now()
          const opts: ConnectionOptions = {
            host: params.host,
            port,
            rejectUnauthorized: params.reject_unauthorized ?? true,
          }
          if (servername) opts.servername = servername
          if (params.alpn_protocols && params.alpn_protocols.length > 0) {
            opts.ALPNProtocols = [...params.alpn_protocols]
          }
          if (params.min_version) opts.minVersion = params.min_version
          if (params.max_version) opts.maxVersion = params.max_version
          if (params.ca) opts.ca = params.ca

          const sock = yield* Effect.promise(() => tlsConnect(opts, timeout))
          try {
            const wantChain = action === "chain"
            const peer = wantChain
              ? sock.getPeerCertificate(true)
              : sock.getPeerCertificate(false)
            const protocol = sock.getProtocol()
            const cipher = sock.getCipher()
            const alpn = (sock as unknown as { alpnProtocol?: string | false }).alpnProtocol ?? null
            const reused = typeof sock.isSessionReused === "function" ? sock.isSessionReused() : false
            const authorized = sock.authorized
            const authError =
              !authorized && (sock as unknown as { authorizationError?: Error | string }).authorizationError
                ? String((sock as unknown as { authorizationError?: Error | string }).authorizationError)
                : undefined

            const leafCert = peer && Object.keys(peer).length > 0 ? summarizeCert(peer) : undefined
            const chain = wantChain && peer && "issuerCertificate" in peer
              ? chainFromDetailed(peer as DetailedPeerCertificate)
              : undefined

            const hostnameMatch = leafCert
              ? hostnameMatches(
                  servername ?? params.host,
                  leafCert.subject_alt_names ?? [],
                  leafCert.subject?.CN,
                )
              : undefined

            const elapsed = Date.now() - start
            const md: Metadata = {
              action,
              host: params.host,
              port,
              servername,
              protocol,
              cipher,
              alpn_protocol: alpn,
              session_reused: reused,
              authorized,
              authorization_error: authError,
              certificate: leafCert,
              chain,
              hostname_match: hostnameMatch,
              elapsed_ms: elapsed,
            }

            const out =
              action === "expiry"
                ? formatExpiry(md)
                : action === "chain"
                  ? formatChain(md)
                  : formatInspect(md)

            return done({
              title: `tls.${action} ${params.host}:${port}`,
              metadata: md,
              output: out,
            })
          } finally {
            try {
              sock.end()
              sock.destroy()
            } catch {}
          }
        }),
    }
  }),
)

function formatInspect(m: Metadata): string {
  const c = m.certificate
  const lines: string[] = [
    `host: ${m.host}:${m.port}${m.servername ? ` (sni=${m.servername})` : ""}`,
    `protocol: ${m.protocol ?? "?"} cipher: ${m.cipher?.name ?? "?"}`,
    `authorized: ${m.authorized}${m.authorization_error ? ` (${m.authorization_error})` : ""}`,
    `alpn: ${m.alpn_protocol ?? "(none)"} reused: ${m.session_reused ?? false}`,
  ]
  if (c) {
    const cn = c.subject?.CN ?? "(no CN)"
    const issuer = c.issuer?.CN ?? c.issuer?.O ?? "(unknown issuer)"
    lines.push(`subject: ${cn} issuer: ${issuer}`)
    lines.push(`valid: ${c.valid_from} -> ${c.valid_to} (${c.days_until_expiry} days)`)
    if (c.fingerprint_sha256) lines.push(`fp_sha256: ${c.fingerprint_sha256}`)
    if (c.signature_algorithm) lines.push(`sig: ${c.signature_algorithm}`)
    if (c.key) lines.push(`key: ${c.key.type}${c.key.bits ? ` ${c.key.bits}` : ""}${c.key.curve ? ` (${c.key.curve})` : ""}`)
    if (c.subject_alt_names && c.subject_alt_names.length > 0) {
      lines.push(`san: ${c.subject_alt_names.join(", ")}`)
    }
  }
  if (m.hostname_match) {
    lines.push(
      `hostname_match: ${m.hostname_match.matched}` +
        (m.hostname_match.matched_san ? ` (${m.hostname_match.matched_san})` : "") +
        (m.hostname_match.reason ? ` - ${m.hostname_match.reason}` : ""),
    )
  }
  lines.push(`elapsed_ms: ${m.elapsed_ms}`)
  return lines.join("\n")
}

function formatChain(m: Metadata): string {
  const head = formatInspect(m)
  if (!m.chain || m.chain.length === 0) return head
  const lines = [head, "", `chain (${m.chain.length}):`]
  m.chain.forEach((c, i) => {
    const cn = c.subject?.CN ?? "(no CN)"
    const issuer = c.issuer?.CN ?? c.issuer?.O ?? "(unknown)"
    lines.push(
      `  [${i}] ${cn} <- ${issuer}` +
        ` valid_to=${c.valid_to}` +
        (c.fingerprint_sha256 ? ` fp=${c.fingerprint_sha256.slice(0, 19)}...` : ""),
    )
  })
  return lines.join("\n")
}

function formatExpiry(m: Metadata): string {
  const c = m.certificate
  if (!c) return "no certificate"
  return [
    `host: ${m.host}:${m.port}`,
    `valid_from: ${c.valid_from}`,
    `valid_to: ${c.valid_to}`,
    `days_until_expiry: ${c.days_until_expiry}`,
    `expired: ${c.expired}`,
    `not_yet_valid: ${c.not_yet_valid}`,
  ].join("\n")
}

export const __testing = {
  parseSubject,
  parseSan,
  summarizeCert,
  hostnameMatches,
  matchesDnsName,
}
