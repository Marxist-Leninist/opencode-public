import { Effect, Schema } from "effect"
import DESCRIPTION from "./cidr.txt"
import * as Tool from "./tool"

const ACTIONS = [
  "parse",
  "validate",
  "expand",
  "compress",
  "to_int",
  "from_int",
  "contains",
  "overlaps",
  "range",
  "count",
  "subnets",
  "supernet",
  "summarize",
  "is_private",
  "is_public",
  "family",
] as const

const FAMILIES = ["ipv4", "ipv6"] as const
const VALIDATE_KINDS = ["ip", "ip_or_cidr", "cidr"] as const

export const Parameters = Schema.Struct({
  action: Schema.Literals(ACTIONS).annotate({ description: ACTIONS.join(" | ") }),
  value: Schema.optional(Schema.String).annotate({ description: "IP, CIDR, integer string, or expanded form (action-dependent)." }),
  target: Schema.optional(Schema.String).annotate({ description: "IP or CIDR target for contains/overlaps." }),
  new_prefix: Schema.optional(Schema.Number).annotate({ description: "New prefix length for subnets/supernet." }),
  list: Schema.optional(Schema.Array(Schema.String)).annotate({ description: "List of CIDRs (summarize)." }),
  family: Schema.optional(Schema.Literals(FAMILIES)).annotate({ description: "ipv4 | ipv6 (from_int)." }),
  kind: Schema.optional(Schema.Literals(VALIDATE_KINDS)).annotate({ description: "ip | ip_or_cidr | cidr (validate)." }),
})

type Params = Schema.Schema.Type<typeof Parameters>
type Action = (typeof ACTIONS)[number]

type Metadata = {
  action: Action
  result?: unknown
}

// ---------- IPv4 helpers ----------

function parseIPv4(s: string): bigint | null {
  const m = s.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/)
  if (!m) return null
  let n = 0n
  for (let i = 1; i <= 4; i++) {
    const o = Number(m[i])
    if (!Number.isFinite(o) || o < 0 || o > 255) return null
    n = (n << 8n) | BigInt(o)
  }
  return n
}

function ipv4ToString(n: bigint): string {
  return [(n >> 24n) & 0xffn, (n >> 16n) & 0xffn, (n >> 8n) & 0xffn, n & 0xffn].join(".")
}

// ---------- IPv6 helpers ----------

function parseIPv6(s: string): bigint | null {
  // Reject obvious junk
  if (!/^[0-9a-fA-F:.]+$/.test(s)) return null
  // Split off optional embedded IPv4 trailing dotted-quad
  const ipv4Match = s.match(/^(.*:)((?:\d+\.){3}\d+)$/)
  let head = s
  let tail4: number[] | null = null
  if (ipv4Match) {
    const v4 = parseIPv4(ipv4Match[2]!)
    if (v4 === null) return null
    tail4 = [Number((v4 >> 24n) & 0xffn), Number((v4 >> 16n) & 0xffn), Number((v4 >> 8n) & 0xffn), Number(v4 & 0xffn)]
    head = ipv4Match[1]! + "0:0"
  }
  if (head.indexOf(":::") !== -1) return null
  const dblIdx = head.indexOf("::")
  let groups: string[]
  if (dblIdx >= 0) {
    if (head.indexOf("::", dblIdx + 1) !== -1) return null
    const left = head.slice(0, dblIdx)
    const right = head.slice(dblIdx + 2)
    const leftParts = left === "" ? [] : left.split(":")
    const rightParts = right === "" ? [] : right.split(":")
    const total = 8
    const fillCount = total - leftParts.length - rightParts.length
    if (fillCount < 0) return null
    groups = [...leftParts, ...Array(fillCount).fill("0"), ...rightParts]
  } else {
    groups = head.split(":")
  }
  if (tail4) {
    // Replace last two synthetic groups with the IPv4 bytes
    if (groups.length !== 8) return null
    const high = ((tail4[0]! << 8) | tail4[1]!).toString(16)
    const low = ((tail4[2]! << 8) | tail4[3]!).toString(16)
    groups[6] = high
    groups[7] = low
  }
  if (groups.length !== 8) return null
  let n = 0n
  for (const g of groups) {
    if (g.length === 0 || g.length > 4 || !/^[0-9a-fA-F]+$/.test(g)) return null
    const v = parseInt(g, 16)
    if (!Number.isFinite(v) || v < 0 || v > 0xffff) return null
    n = (n << 16n) | BigInt(v)
  }
  return n
}

function ipv6Groups(n: bigint): string[] {
  const out: string[] = []
  for (let i = 7; i >= 0; i--) {
    const v = Number((n >> BigInt(i * 16)) & 0xffffn)
    out.push(v.toString(16))
  }
  return out
}

function ipv6Expand(n: bigint): string {
  return ipv6Groups(n)
    .map((g) => g.padStart(4, "0"))
    .join(":")
}

function ipv6Compress(n: bigint): string {
  const groups = ipv6Groups(n)
  // RFC 5952: longest run of consecutive zeros (>= 2) gets `::`. On ties, leftmost.
  let bestStart = -1
  let bestLen = 0
  let curStart = -1
  let curLen = 0
  for (let i = 0; i < groups.length; i++) {
    if (groups[i] === "0") {
      if (curStart === -1) curStart = i
      curLen++
      if (curLen > bestLen) {
        bestLen = curLen
        bestStart = curStart
      }
    } else {
      curStart = -1
      curLen = 0
    }
  }
  if (bestLen < 2) return groups.join(":")
  const left = groups.slice(0, bestStart).join(":")
  const right = groups.slice(bestStart + bestLen).join(":")
  return `${left}::${right}`
}

// ---------- Parsing IP or CIDR ----------

type ParsedIP = { family: "ipv4" | "ipv6"; n: bigint }
type ParsedCIDR = ParsedIP & { prefix: number }

function parseIP(s: string): ParsedIP | null {
  const v4 = parseIPv4(s)
  if (v4 !== null) return { family: "ipv4", n: v4 }
  const v6 = parseIPv6(s)
  if (v6 !== null) return { family: "ipv6", n: v6 }
  return null
}

function parseCIDR(s: string, defaultPrefix?: { ipv4: number; ipv6: number }): ParsedCIDR | null {
  const slash = s.indexOf("/")
  let ipPart: string
  let prefixStr: string | null
  if (slash >= 0) {
    ipPart = s.slice(0, slash)
    prefixStr = s.slice(slash + 1)
  } else {
    ipPart = s
    prefixStr = null
  }
  const ip = parseIP(ipPart)
  if (!ip) return null
  const max = ip.family === "ipv4" ? 32 : 128
  let prefix: number
  if (prefixStr === null) {
    if (defaultPrefix) prefix = ip.family === "ipv4" ? defaultPrefix.ipv4 : defaultPrefix.ipv6
    else return null
  } else {
    if (!/^\d+$/.test(prefixStr)) return null
    prefix = Number(prefixStr)
    if (!Number.isFinite(prefix) || prefix < 0 || prefix > max) return null
  }
  return { ...ip, prefix }
}

function ipToString(ip: ParsedIP): string {
  return ip.family === "ipv4" ? ipv4ToString(ip.n) : ipv6Compress(ip.n)
}

function maskBigInt(prefix: number, family: "ipv4" | "ipv6"): bigint {
  const total = family === "ipv4" ? 32 : 128
  if (prefix === 0) return 0n
  return (((1n << BigInt(prefix)) - 1n) << BigInt(total - prefix)) & ((1n << BigInt(total)) - 1n)
}

function networkAddr(c: ParsedCIDR): bigint {
  return c.n & maskBigInt(c.prefix, c.family)
}

function broadcastAddr(c: ParsedCIDR): bigint {
  const total = c.family === "ipv4" ? 32 : 128
  const hostBits = total - c.prefix
  return networkAddr(c) | ((1n << BigInt(hostBits)) - 1n)
}

function totalHosts(c: ParsedCIDR): bigint {
  const total = c.family === "ipv4" ? 32 : 128
  return 1n << BigInt(total - c.prefix)
}

function usableHosts(c: ParsedCIDR): bigint {
  const total = totalHosts(c)
  if (c.family === "ipv4") {
    if (c.prefix === 32) return 1n
    if (c.prefix === 31) return 2n // RFC 3021 point-to-point
    return total - 2n
  }
  // IPv6: traditionally all addresses usable; /127 commonly point-to-point.
  if (c.prefix === 128) return 1n
  return total
}

// ---------- Privacy / scope ----------

function ipv4Scope(n: bigint): string {
  const cidrs: { net: bigint; prefix: number; label: string }[] = [
    { net: parseIPv4("10.0.0.0")!, prefix: 8, label: "private (RFC1918)" },
    { net: parseIPv4("172.16.0.0")!, prefix: 12, label: "private (RFC1918)" },
    { net: parseIPv4("192.168.0.0")!, prefix: 16, label: "private (RFC1918)" },
    { net: parseIPv4("127.0.0.0")!, prefix: 8, label: "loopback" },
    { net: parseIPv4("169.254.0.0")!, prefix: 16, label: "link-local" },
    { net: parseIPv4("100.64.0.0")!, prefix: 10, label: "shared (CGNAT)" },
    { net: parseIPv4("224.0.0.0")!, prefix: 4, label: "multicast" },
    { net: parseIPv4("240.0.0.0")!, prefix: 4, label: "reserved" },
    { net: parseIPv4("0.0.0.0")!, prefix: 8, label: "this network" },
  ]
  for (const c of cidrs) {
    const mask = maskBigInt(c.prefix, "ipv4")
    if ((n & mask) === (c.net & mask)) return c.label
  }
  return "public"
}

function ipv6Scope(n: bigint): string {
  if (n === 0n) return "unspecified"
  if (n === 1n) return "loopback"
  // fe80::/10 link-local
  if ((n >> 118n) === 0x3fan) return "link-local"
  // fc00::/7 unique local
  if ((n >> 121n) === 0x7en) return "unique-local (ULA)"
  // ff00::/8 multicast
  if ((n >> 120n) === 0xffn) return "multicast"
  return "public (global unicast)"
}

// ---------- Subnets / supernet / summarize ----------

function splitSubnets(c: ParsedCIDR, newPrefix: number): string[] {
  if (newPrefix < c.prefix) throw new Error(`new_prefix (${newPrefix}) < current prefix (${c.prefix})`)
  const max = c.family === "ipv4" ? 32 : 128
  if (newPrefix > max) throw new Error(`new_prefix exceeds family max (${max})`)
  const count = 1n << BigInt(newPrefix - c.prefix)
  if (count > 65536n) throw new Error(`refusing to enumerate ${count} subnets (cap 65536)`)
  const step = 1n << BigInt(max - newPrefix)
  const start = networkAddr(c)
  const out: string[] = []
  for (let i = 0n; i < count; i++) {
    const sub: ParsedCIDR = { family: c.family, n: start + i * step, prefix: newPrefix }
    out.push(`${ipToString(sub)}/${newPrefix}`)
  }
  return out
}

function computeSupernet(c: ParsedCIDR, newPrefix: number): ParsedCIDR {
  if (newPrefix > c.prefix) throw new Error(`new_prefix (${newPrefix}) > current prefix (${c.prefix})`)
  if (newPrefix < 0) throw new Error("new_prefix must be >= 0")
  return { family: c.family, n: c.n & maskBigInt(newPrefix, c.family), prefix: newPrefix }
}

// Build CIDR aggregates by sweeping a sorted, range-coalesced set, then emitting greedy power-of-two blocks.
function summarizeCIDRs(cidrs: ParsedCIDR[]): string[] {
  if (cidrs.length === 0) return []
  const family = cidrs[0]!.family
  if (cidrs.some((c) => c.family !== family)) throw new Error("summarize: mixing ipv4 and ipv6 CIDRs is not supported")
  const max = family === "ipv4" ? 32 : 128
  const ranges = cidrs
    .map((c) => ({ lo: networkAddr(c), hi: broadcastAddr(c) }))
    .sort((a, b) => (a.lo < b.lo ? -1 : a.lo > b.lo ? 1 : 0))
  const merged: { lo: bigint; hi: bigint }[] = []
  for (const r of ranges) {
    const last = merged[merged.length - 1]
    if (last && r.lo <= last.hi + 1n) {
      if (r.hi > last.hi) last.hi = r.hi
    } else merged.push({ ...r })
  }
  const out: string[] = []
  for (const r of merged) {
    let lo = r.lo
    while (lo <= r.hi) {
      // Largest aligned block starting at lo that fits in [lo..r.hi]
      let bits = max
      for (let b = 1; b <= max; b++) {
        const blockSize = 1n << BigInt(b)
        if (lo % blockSize !== 0n) break
        if (lo + blockSize - 1n > r.hi) break
        bits = max - b
      }
      out.push(`${ipToString({ family, n: lo })}/${bits}`)
      lo += 1n << BigInt(max - bits)
    }
  }
  return out
}

// ---------- Tool ----------

const done = (result: Tool.ExecuteResult<Metadata>) => result

export const CidrTool = Tool.define(
  "cidr",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Params, _ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const action = params.action
          const need = (k: keyof Params, label: string) => {
            if (params[k] === undefined || params[k] === null) throw new Error(`cidr.${action}: requires \`${label}\``)
          }

          if (action === "parse") {
            need("value", "value")
            const c = parseCIDR(params.value!, { ipv4: 32, ipv6: 128 })
            if (!c) throw new Error(`cidr.parse: invalid value: ${params.value}`)
            const total = totalHosts(c)
            const usable = usableHosts(c)
            const result = {
              family: c.family,
              version: c.family === "ipv4" ? 4 : 6,
              normalized: `${ipToString(c)}/${c.prefix}`,
              prefix: c.prefix,
              network: ipToString({ family: c.family, n: networkAddr(c) }),
              broadcast: c.family === "ipv4" ? ipToString({ family: "ipv4", n: broadcastAddr(c) }) : undefined,
              first_host:
                c.family === "ipv4" && c.prefix < 31
                  ? ipToString({ family: "ipv4", n: networkAddr(c) + 1n })
                  : ipToString({ family: c.family, n: networkAddr(c) }),
              last_host:
                c.family === "ipv4" && c.prefix < 31
                  ? ipToString({ family: "ipv4", n: broadcastAddr(c) - 1n })
                  : ipToString({ family: c.family, n: broadcastAddr(c) }),
              total_hosts: total.toString(),
              usable_hosts: usable.toString(),
            }
            return done({
              title: `cidr.parse: ${result.normalized}`,
              metadata: { action, result },
              output: JSON.stringify(result, null, 2),
            })
          }

          if (action === "validate") {
            need("value", "value")
            const k = params.kind ?? "ip_or_cidr"
            const v = params.value!
            let ok = false
            if (k === "ip") ok = parseIP(v) !== null
            else if (k === "cidr") ok = v.includes("/") && parseCIDR(v) !== null
            else ok = parseIP(v) !== null || parseCIDR(v) !== null
            return done({
              title: `cidr.validate: ${ok}`,
              metadata: { action, result: ok },
              output: String(ok),
            })
          }

          if (action === "expand") {
            need("value", "value")
            const ip = parseIP(params.value!)
            if (!ip) throw new Error(`cidr.expand: invalid IP: ${params.value}`)
            const result = ip.family === "ipv4" ? ipv4ToString(ip.n) : ipv6Expand(ip.n)
            return done({ title: `cidr.expand: ${result}`, metadata: { action, result }, output: result })
          }

          if (action === "compress") {
            need("value", "value")
            const ip = parseIP(params.value!)
            if (!ip) throw new Error(`cidr.compress: invalid IP: ${params.value}`)
            const result = ip.family === "ipv4" ? ipv4ToString(ip.n) : ipv6Compress(ip.n)
            return done({ title: `cidr.compress: ${result}`, metadata: { action, result }, output: result })
          }

          if (action === "to_int") {
            need("value", "value")
            const ip = parseIP(params.value!)
            if (!ip) throw new Error(`cidr.to_int: invalid IP: ${params.value}`)
            const result = ip.n.toString()
            return done({ title: `cidr.to_int: ${result}`, metadata: { action, result }, output: result })
          }

          if (action === "from_int") {
            need("value", "value")
            const fam = params.family ?? "ipv4"
            const n = BigInt(params.value!)
            const max = fam === "ipv4" ? 32 : 128
            const cap = (1n << BigInt(max)) - 1n
            if (n < 0n || n > cap) throw new Error(`cidr.from_int: value out of range for ${fam}`)
            const result = ipToString({ family: fam, n })
            return done({ title: `cidr.from_int: ${result}`, metadata: { action, result }, output: result })
          }

          if (action === "contains") {
            need("value", "value")
            need("target", "target")
            const c = parseCIDR(params.value!, { ipv4: 32, ipv6: 128 })
            if (!c) throw new Error(`cidr.contains: invalid value CIDR: ${params.value}`)
            const t = parseCIDR(params.target!, { ipv4: 32, ipv6: 128 })
            if (!t) throw new Error(`cidr.contains: invalid target: ${params.target}`)
            if (t.family !== c.family) {
              return done({ title: `cidr.contains: false`, metadata: { action, result: false }, output: "false" })
            }
            const ok = t.prefix >= c.prefix && (t.n & maskBigInt(c.prefix, c.family)) === networkAddr(c)
            return done({ title: `cidr.contains: ${ok}`, metadata: { action, result: ok }, output: String(ok) })
          }

          if (action === "overlaps") {
            need("value", "value")
            need("target", "target")
            const a = parseCIDR(params.value!, { ipv4: 32, ipv6: 128 })
            const b = parseCIDR(params.target!, { ipv4: 32, ipv6: 128 })
            if (!a) throw new Error(`cidr.overlaps: invalid value CIDR: ${params.value}`)
            if (!b) throw new Error(`cidr.overlaps: invalid target CIDR: ${params.target}`)
            if (a.family !== b.family) {
              return done({ title: `cidr.overlaps: false`, metadata: { action, result: false }, output: "false" })
            }
            const aLo = networkAddr(a)
            const aHi = broadcastAddr(a)
            const bLo = networkAddr(b)
            const bHi = broadcastAddr(b)
            const ok = aLo <= bHi && bLo <= aHi
            return done({ title: `cidr.overlaps: ${ok}`, metadata: { action, result: ok }, output: String(ok) })
          }

          if (action === "range" || action === "count") {
            need("value", "value")
            const c = parseCIDR(params.value!, { ipv4: 32, ipv6: 128 })
            if (!c) throw new Error(`cidr.${action}: invalid CIDR: ${params.value}`)
            const total = totalHosts(c)
            const usable = usableHosts(c)
            if (action === "count") {
              const result = { total: total.toString(), usable: usable.toString() }
              return done({
                title: `cidr.count: ${total} total / ${usable} usable`,
                metadata: { action, result },
                output: JSON.stringify(result),
              })
            }
            const network = ipToString({ family: c.family, n: networkAddr(c) })
            const result = {
              network,
              broadcast: c.family === "ipv4" ? ipToString({ family: "ipv4", n: broadcastAddr(c) }) : undefined,
              first: ipToString({
                family: c.family,
                n: c.family === "ipv4" && c.prefix < 31 ? networkAddr(c) + 1n : networkAddr(c),
              }),
              last: ipToString({
                family: c.family,
                n: c.family === "ipv4" && c.prefix < 31 ? broadcastAddr(c) - 1n : broadcastAddr(c),
              }),
              total: total.toString(),
              usable: usable.toString(),
            }
            return done({
              title: `cidr.range: ${network}/${c.prefix}`,
              metadata: { action, result },
              output: JSON.stringify(result, null, 2),
            })
          }

          if (action === "subnets") {
            need("value", "value")
            need("new_prefix", "new_prefix")
            const c = parseCIDR(params.value!, { ipv4: 32, ipv6: 128 })
            if (!c) throw new Error(`cidr.subnets: invalid CIDR: ${params.value}`)
            const subs = splitSubnets(c, params.new_prefix!)
            return done({
              title: `cidr.subnets: ${subs.length} of /${params.new_prefix}`,
              metadata: { action, result: subs },
              output: subs.join("\n"),
            })
          }

          if (action === "supernet") {
            need("value", "value")
            need("new_prefix", "new_prefix")
            const c = parseCIDR(params.value!, { ipv4: 32, ipv6: 128 })
            if (!c) throw new Error(`cidr.supernet: invalid CIDR: ${params.value}`)
            const sup = computeSupernet(c, params.new_prefix!)
            const result = `${ipToString(sup)}/${sup.prefix}`
            return done({ title: `cidr.supernet: ${result}`, metadata: { action, result }, output: result })
          }

          if (action === "summarize") {
            if (!params.list || params.list.length === 0)
              throw new Error("cidr.summarize: requires non-empty `list`")
            const parsed = params.list.map((s) => {
              const c = parseCIDR(s, { ipv4: 32, ipv6: 128 })
              if (!c) throw new Error(`cidr.summarize: invalid CIDR in list: ${s}`)
              return c
            })
            const result = summarizeCIDRs(parsed)
            return done({
              title: `cidr.summarize: ${result.length} aggregate(s)`,
              metadata: { action, result },
              output: result.join("\n"),
            })
          }

          if (action === "is_private" || action === "is_public") {
            need("value", "value")
            const ip = parseIP(params.value!)
            if (!ip) {
              const c = parseCIDR(params.value!)
              if (!c) throw new Error(`cidr.${action}: invalid IP: ${params.value}`)
              const scope = c.family === "ipv4" ? ipv4Scope(networkAddr(c)) : ipv6Scope(networkAddr(c))
              const isPub = scope === "public" || scope === "public (global unicast)"
              const result = action === "is_public" ? isPub : !isPub
              return done({
                title: `cidr.${action}: ${result} (${scope})`,
                metadata: { action, result: { result, scope } },
                output: JSON.stringify({ result, scope }),
              })
            }
            const scope = ip.family === "ipv4" ? ipv4Scope(ip.n) : ipv6Scope(ip.n)
            const isPub = scope === "public" || scope === "public (global unicast)"
            const result = action === "is_public" ? isPub : !isPub
            return done({
              title: `cidr.${action}: ${result} (${scope})`,
              metadata: { action, result: { result, scope } },
              output: JSON.stringify({ result, scope }),
            })
          }

          if (action === "family") {
            need("value", "value")
            const ip = parseIP(params.value!) ?? parseCIDR(params.value!)
            if (!ip) throw new Error(`cidr.family: invalid value: ${params.value}`)
            return done({
              title: `cidr.family: ${ip.family}`,
              metadata: { action, result: ip.family },
              output: ip.family,
            })
          }

          throw new Error(`cidr: unknown action: ${action}`)
        }),
    }
  }),
)

export const __testing = {
  parseIP,
  parseCIDR,
  ipToString,
  ipv6Expand,
  ipv6Compress,
  splitSubnets,
  summarizeCIDRs,
  ipv4Scope,
  ipv6Scope,
  networkAddr,
  broadcastAddr,
  totalHosts,
  usableHosts,
}
