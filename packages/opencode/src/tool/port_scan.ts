import { Effect, Schema } from "effect"
import { createConnection } from "node:net"
import DESCRIPTION from "./port_scan.txt"
import * as Tool from "./tool"

const PRESETS = ["top10", "top100", "web", "dev"] as const

export const Parameters = Schema.Struct({
  host: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(255)).annotate({
    description: "Hostname or IP to scan.",
  }),
  ports: Schema.optional(Schema.Array(Schema.Number)).annotate({
    description: "Explicit list of ports to scan.",
  }),
  range: Schema.optional(Schema.String.check(Schema.isMaxLength(2048))).annotate({
    description: "Range string like '1-1024' or '22,80,443,1000-1024'. Combined with `ports`.",
  }),
  preset: Schema.optional(Schema.Literals(PRESETS)).annotate({
    description: "Predefined set: top10 | top100 | web | dev.",
  }),
  timeout_ms: Schema.optional(
    Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(100), Schema.isLessThanOrEqualTo(60_000)),
  ).annotate({ description: "Per-port timeout. Default 1500." }),
  concurrency: Schema.optional(
    Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(1024)),
  ).annotate({ description: "Max simultaneous probes. Default 64." }),
  include_closed: Schema.optional(Schema.Boolean).annotate({
    description: "Include closed ports in textual output. metadata.closed always present.",
  }),
  service_names: Schema.optional(Schema.Boolean).annotate({
    description: "Annotate well-known ports. Default true.",
  }),
})

type Params = Schema.Schema.Type<typeof Parameters>

type OpenPort = { port: number; service?: string; latency_ms: number }
type ClosedPort = number
type ErroredPort = { port: number; error: string }

type Metadata = {
  host: string
  scanned_count: number
  open: OpenPort[]
  closed: ClosedPort[]
  errored: ErroredPort[]
  total_ms: number
}

const done = (result: Tool.ExecuteResult<Metadata>) => result

const TOP10_PORTS = [22, 80, 443, 3306, 3389, 5432, 5900, 8080, 8443, 27017]

const TOP100_PORTS = [
  7, 9, 13, 21, 22, 23, 25, 26, 37, 53, 67, 68, 69, 79, 80, 88, 110, 111, 113, 119, 123, 135, 137, 138, 139, 143, 161,
  179, 199, 389, 427, 443, 444, 445, 465, 500, 514, 515, 543, 544, 548, 554, 587, 631, 636, 646, 873, 902, 989, 990,
  993, 995, 1025, 1026, 1027, 1028, 1029, 1080, 1433, 1521, 1723, 1900, 2049, 2082, 2083, 2086, 2087, 2222, 2375, 2376,
  3000, 3128, 3268, 3306, 3389, 3690, 4000, 4040, 4444, 5000, 5432, 5601, 5672, 5900, 5984, 6379, 7001, 8000, 8008,
  8080, 8081, 8088, 8443, 8888, 9000, 9042, 9092, 9200, 9418, 11211, 27017,
]

const WEB_PORTS = [80, 443, 8080, 8443, 3000, 3001, 4000, 4200, 5000, 5173, 7070, 8000, 8008, 8081, 8888, 9000, 9090]
const DEV_PORTS = [3000, 3001, 4000, 4200, 5000, 5173, 5432, 6379, 8000, 8080, 9000, 11434, 27017]

const PORT_SERVICES: Record<number, string> = {
  20: "ftp-data",
  21: "ftp",
  22: "ssh",
  23: "telnet",
  25: "smtp",
  53: "dns",
  67: "dhcp-server",
  68: "dhcp-client",
  69: "tftp",
  80: "http",
  88: "kerberos",
  110: "pop3",
  111: "rpcbind",
  119: "nntp",
  123: "ntp",
  135: "msrpc",
  137: "netbios-ns",
  138: "netbios-dgm",
  139: "netbios-ssn",
  143: "imap",
  161: "snmp",
  389: "ldap",
  443: "https",
  445: "smb",
  465: "smtps",
  500: "isakmp",
  514: "syslog",
  587: "submission",
  636: "ldaps",
  873: "rsync",
  902: "vmware",
  989: "ftps-data",
  990: "ftps",
  993: "imaps",
  995: "pop3s",
  1080: "socks",
  1194: "openvpn",
  1433: "mssql",
  1521: "oracle",
  1723: "pptp",
  1883: "mqtt",
  2049: "nfs",
  2082: "cpanel",
  2083: "cpanel-ssl",
  2086: "whm",
  2087: "whm-ssl",
  2222: "directadmin/ssh-alt",
  2375: "docker",
  2376: "docker-tls",
  3000: "http-alt",
  3128: "squid",
  3268: "globalcat-ldap",
  3306: "mysql",
  3389: "rdp",
  3690: "svn",
  4040: "yarn-pkg",
  4200: "ng-serve",
  4369: "epmd",
  4444: "krb524/metasploit",
  5000: "http-alt",
  5060: "sip",
  5061: "sips",
  5173: "vite",
  5222: "xmpp-client",
  5269: "xmpp-server",
  5353: "mdns",
  5432: "postgres",
  5601: "kibana",
  5672: "amqp",
  5900: "vnc",
  5984: "couchdb",
  6379: "redis",
  6443: "kube-apiserver",
  6667: "irc",
  6697: "ircs",
  7001: "weblogic",
  7070: "realserver",
  8000: "http-alt",
  8008: "http-alt",
  8080: "http-proxy",
  8081: "http-alt",
  8086: "influxdb",
  8088: "http-alt",
  8443: "https-alt",
  8888: "http-alt",
  9000: "http-alt",
  9042: "cassandra",
  9090: "prometheus",
  9092: "kafka",
  9200: "elasticsearch",
  9418: "git",
  9999: "abyss",
  11211: "memcached",
  11434: "ollama",
  27017: "mongodb",
  50000: "sap",
}

function presetPorts(preset: (typeof PRESETS)[number]): number[] {
  switch (preset) {
    case "top10":
      return [...TOP10_PORTS]
    case "top100":
      return [...TOP100_PORTS]
    case "web":
      return [...WEB_PORTS]
    case "dev":
      return [...DEV_PORTS]
  }
}

function parseRange(s: string): number[] {
  const out: number[] = []
  for (const part of s.split(",")) {
    const piece = part.trim()
    if (piece === "") continue
    const m = piece.match(/^(\d+)\s*-\s*(\d+)$/)
    if (m) {
      const lo = Number(m[1])
      const hi = Number(m[2])
      if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo < 1 || hi > 65535 || lo > hi) {
        throw new Error(`port_scan: invalid range "${piece}"`)
      }
      for (let i = lo; i <= hi; i++) out.push(i)
    } else {
      const n = Number(piece)
      if (!Number.isFinite(n) || n < 1 || n > 65535) {
        throw new Error(`port_scan: invalid port "${piece}"`)
      }
      out.push(n)
    }
  }
  return out
}

function permissionPattern(host: string, ports: number[]) {
  if (ports.length <= 32) return `${host}:${ports.join(",")}`
  return `${host}:${ports[0]}-${ports[ports.length - 1]} (${ports.length} ports)`
}

function probePort(
  host: string,
  port: number,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<{ open: boolean; latency_ms: number; error?: string }> {
  return new Promise((resolve) => {
    const start = Date.now()
    const sock = createConnection({ host, port, allowHalfOpen: false })
    let resolved = false
    const settle = (val: { open: boolean; latency_ms: number; error?: string }) => {
      if (resolved) return
      resolved = true
      try {
        sock.destroy()
      } catch {}
      resolve(val)
    }
    const timer = setTimeout(() => settle({ open: false, latency_ms: Date.now() - start, error: "timeout" }), timeoutMs)
    const onAbort = () => settle({ open: false, latency_ms: Date.now() - start, error: "aborted" })
    if (signal.aborted) {
      clearTimeout(timer)
      return settle({ open: false, latency_ms: 0, error: "aborted" })
    }
    signal.addEventListener("abort", onAbort, { once: true })
    sock.once("connect", () => {
      clearTimeout(timer)
      signal.removeEventListener("abort", onAbort)
      settle({ open: true, latency_ms: Date.now() - start })
    })
    sock.once("error", (e: Error & { code?: string }) => {
      clearTimeout(timer)
      signal.removeEventListener("abort", onAbort)
      const code = e.code ?? "ERR"
      const closedCodes = new Set(["ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH", "EHOSTDOWN"])
      settle({
        open: false,
        latency_ms: Date.now() - start,
        error: closedCodes.has(code) ? "closed" : code,
      })
    })
  })
}

async function runScan(
  host: string,
  ports: number[],
  timeoutMs: number,
  concurrency: number,
  signal: AbortSignal,
): Promise<{ open: OpenPort[]; closed: number[]; errored: ErroredPort[] }> {
  const open: OpenPort[] = []
  const closed: number[] = []
  const errored: ErroredPort[] = []
  let i = 0
  async function worker() {
    while (i < ports.length) {
      if (signal.aborted) return
      const idx = i++
      const port = ports[idx]!
      const r = await probePort(host, port, timeoutMs, signal)
      if (r.open) {
        open.push({ port, service: PORT_SERVICES[port], latency_ms: r.latency_ms })
      } else if (r.error === "closed" || r.error === "timeout") {
        closed.push(port)
      } else if (r.error === "aborted") {
        return
      } else {
        errored.push({ port, error: r.error ?? "unknown" })
      }
    }
  }
  const workers: Promise<void>[] = []
  const w = Math.min(concurrency, ports.length)
  for (let k = 0; k < w; k++) workers.push(worker())
  await Promise.all(workers)
  open.sort((a, b) => a.port - b.port)
  closed.sort((a, b) => a - b)
  errored.sort((a, b) => a.port - b.port)
  return { open, closed, errored }
}

export const PortScanTool = Tool.define(
  "port_scan",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Params, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const set = new Set<number>()
          if (params.preset) for (const p of presetPorts(params.preset)) set.add(p)
          if (params.ports) {
            for (const p of params.ports) {
              if (!Number.isInteger(p) || p < 1 || p > 65535) {
                throw new Error(`port_scan: invalid port ${p}`)
              }
              set.add(p)
            }
          }
          if (params.range) for (const p of parseRange(params.range)) set.add(p)
          if (set.size === 0) throw new Error("port_scan: must provide ports, range, or preset")
          if (set.size > 4096) throw new Error(`port_scan: too many ports (${set.size}); cap is 4096`)

          const ports = [...set].sort((a, b) => a - b)
          const timeout = params.timeout_ms ?? 1_500
          const concurrency = params.concurrency ?? 64
          const showService = params.service_names ?? true

          yield* ctx.ask({
            permission: "port_scan",
            patterns: [permissionPattern(params.host, ports)],
            always: ["*"],
            metadata: {
              host: params.host,
              ports,
              scanned_count: ports.length,
              timeout_ms: timeout,
              concurrency,
            },
          })

          const start = Date.now()
          const { open, closed, errored } = yield* Effect.promise(() =>
            runScan(params.host, ports, timeout, concurrency, ctx.abort),
          )
          const total_ms = Date.now() - start

          const lines: string[] = []
          for (const o of open) {
            lines.push(showService ? `${o.port}\t${o.service ?? ""}\t${o.latency_ms}ms` : `${o.port}\t${o.latency_ms}ms`)
          }
          if (lines.length === 0) lines.push("(no open ports)")
          if (params.include_closed && closed.length > 0) {
            lines.push("")
            lines.push(`closed: ${closed.join(",")}`)
          }
          if (errored.length > 0) {
            lines.push("")
            lines.push(`errored: ${errored.map((e) => `${e.port}=${e.error}`).join(",")}`)
          }

          return done({
            title: `port_scan ${params.host}: ${open.length} open / ${ports.length} probed`,
            metadata: {
              host: params.host,
              scanned_count: ports.length,
              open,
              closed,
              errored,
              total_ms,
            },
            output: lines.join("\n"),
          })
        }),
    }
  }),
)

export const __testing = {
  parseRange,
  presetPorts,
  permissionPattern,
  PORT_SERVICES,
}
