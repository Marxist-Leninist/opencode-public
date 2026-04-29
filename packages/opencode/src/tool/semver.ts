import { Effect, Schema } from "effect"
import DESCRIPTION from "./semver.txt"
import * as Tool from "./tool"

const ACTIONS = [
  "parse",
  "compare",
  "eq",
  "neq",
  "lt",
  "lte",
  "gt",
  "gte",
  "inc",
  "satisfies",
  "max_satisfying",
  "min_satisfying",
  "sort",
  "valid",
  "coerce",
] as const
const RELEASES = ["major", "minor", "patch", "premajor", "preminor", "prepatch", "prerelease"] as const

export const Parameters = Schema.Struct({
  action: Schema.Literals(ACTIONS).annotate({
    description: ACTIONS.join(" | "),
  }),
  value: Schema.optional(Schema.String).annotate({ description: "Version string (parse/inc/satisfies/valid/coerce)." }),
  a: Schema.optional(Schema.String).annotate({ description: "Left version (compare/eq/lt/...)." }),
  b: Schema.optional(Schema.String).annotate({ description: "Right version (compare/eq/lt/...)." }),
  range: Schema.optional(Schema.String).annotate({
    description: "npm-style range (satisfies/max_satisfying/min_satisfying).",
  }),
  release: Schema.optional(Schema.Literals(RELEASES)).annotate({ description: "inc bump kind. Default patch." }),
  prerelease: Schema.optional(Schema.String).annotate({ description: "Prerelease tag for inc. Default 'pre'." }),
  versions: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "Versions list for sort/min_satisfying/max_satisfying.",
  }),
  desc: Schema.optional(Schema.Boolean).annotate({ description: "Sort descending." }),
  loose: Schema.optional(Schema.Boolean).annotate({ description: "Accept loose forms (default true)." }),
})

type Params = Schema.Schema.Type<typeof Parameters>
type Action = (typeof ACTIONS)[number]
type Release = (typeof RELEASES)[number]

export type SemVer = {
  major: number
  minor: number
  patch: number
  prerelease: Array<string | number>
  build: string[]
  raw: string
}

type Metadata = {
  action: Action
  result?: unknown
  parsed?: SemVer
  count?: number
}

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/

const stripV = (v: string) => (v.startsWith("v") || v.startsWith("V") ? v.slice(1) : v).trim()

export function parse(version: string, loose = true): SemVer | null {
  let raw = version.trim()
  if (loose) raw = stripV(raw)
  // Loose: allow "1" or "1.2" by padding
  if (loose) {
    const bare = raw.replace(/[+-].*$/, "")
    const tail = raw.slice(bare.length)
    const parts = bare.split(".")
    if (parts.length === 1 && /^\d+$/.test(parts[0]!)) raw = `${parts[0]}.0.0${tail}`
    else if (parts.length === 2 && parts.every((p) => /^\d+$/.test(p))) raw = `${parts[0]}.${parts[1]}.0${tail}`
  }
  const m = SEMVER_RE.exec(raw)
  if (!m) return null
  const [, ma, mi, pa, pre, build] = m
  return {
    major: Number(ma),
    minor: Number(mi),
    patch: Number(pa),
    prerelease: pre
      ? pre.split(".").map((id) => (/^\d+$/.test(id) ? Number(id) : id))
      : [],
    build: build ? build.split(".") : [],
    raw,
  }
}

export function valid(version: string, loose = true): boolean {
  return parse(version, loose) !== null
}

function compareIdentifier(a: string | number, b: string | number): number {
  const aNum = typeof a === "number"
  const bNum = typeof b === "number"
  if (aNum && bNum) return (a as number) - (b as number)
  if (aNum) return -1
  if (bNum) return 1
  return (a as string).localeCompare(b as string)
}

export function compare(a: string, b: string, loose = true): number {
  const pa = parse(a, loose)
  const pb = parse(b, loose)
  if (!pa) throw new Error(`semver: invalid version '${a}'`)
  if (!pb) throw new Error(`semver: invalid version '${b}'`)
  if (pa.major !== pb.major) return Math.sign(pa.major - pb.major)
  if (pa.minor !== pb.minor) return Math.sign(pa.minor - pb.minor)
  if (pa.patch !== pb.patch) return Math.sign(pa.patch - pb.patch)
  // Prerelease handling
  if (pa.prerelease.length === 0 && pb.prerelease.length === 0) return 0
  if (pa.prerelease.length === 0) return 1
  if (pb.prerelease.length === 0) return -1
  const len = Math.max(pa.prerelease.length, pb.prerelease.length)
  for (let i = 0; i < len; i++) {
    const ai = pa.prerelease[i]
    const bi = pb.prerelease[i]
    if (ai === undefined) return -1
    if (bi === undefined) return 1
    const cmp = compareIdentifier(ai, bi)
    if (cmp !== 0) return Math.sign(cmp)
  }
  return 0
}

export function format(v: SemVer): string {
  let s = `${v.major}.${v.minor}.${v.patch}`
  if (v.prerelease.length) s += `-${v.prerelease.join(".")}`
  if (v.build.length) s += `+${v.build.join(".")}`
  return s
}

export function inc(version: string, release: Release, prereleaseId = "pre", loose = true): string {
  const v = parse(version, loose)
  if (!v) throw new Error(`semver: invalid version '${version}'`)
  const out: SemVer = { ...v, prerelease: [...v.prerelease], build: [] }
  switch (release) {
    case "major":
      out.major = v.prerelease.length && v.minor === 0 && v.patch === 0 ? v.major : v.major + 1
      out.minor = 0
      out.patch = 0
      out.prerelease = []
      break
    case "minor":
      out.minor = v.prerelease.length && v.patch === 0 ? v.minor : v.minor + 1
      out.patch = 0
      out.prerelease = []
      break
    case "patch":
      out.patch = v.prerelease.length ? v.patch : v.patch + 1
      out.prerelease = []
      break
    case "premajor":
      out.major = v.major + 1
      out.minor = 0
      out.patch = 0
      out.prerelease = [prereleaseId, 0]
      break
    case "preminor":
      out.minor = v.minor + 1
      out.patch = 0
      out.prerelease = [prereleaseId, 0]
      break
    case "prepatch":
      out.patch = v.patch + 1
      out.prerelease = [prereleaseId, 0]
      break
    case "prerelease": {
      if (v.prerelease.length === 0) {
        out.patch = v.patch + 1
        out.prerelease = [prereleaseId, 0]
      } else {
        // Bump trailing number, or append ".0".
        const last = out.prerelease[out.prerelease.length - 1]
        if (typeof last === "number") {
          out.prerelease[out.prerelease.length - 1] = last + 1
        } else if (out.prerelease[0] !== prereleaseId && prereleaseId !== "pre") {
          out.prerelease = [prereleaseId, 0]
        } else {
          out.prerelease.push(0)
        }
      }
      break
    }
  }
  return format(out)
}

// ---------- Range parsing ----------
type Comparator = { op: "<" | "<=" | ">" | ">=" | "="; v: SemVer }

function parseComparator(token: string, loose: boolean): Comparator | null {
  let t = token.trim()
  if (!t) return null
  if (t === "*" || t === "x" || t === "X" || t === "") {
    return { op: ">=", v: { major: 0, minor: 0, patch: 0, prerelease: [], build: [], raw: "0.0.0" } }
  }
  let op: "<" | "<=" | ">" | ">=" | "=" = "="
  if (t.startsWith("<=")) {
    op = "<="
    t = t.slice(2)
  } else if (t.startsWith(">=")) {
    op = ">="
    t = t.slice(2)
  } else if (t.startsWith("<")) {
    op = "<"
    t = t.slice(1)
  } else if (t.startsWith(">")) {
    op = ">"
    t = t.slice(1)
  } else if (t.startsWith("=")) {
    op = "="
    t = t.slice(1)
  }
  const v = parse(t.trim(), loose)
  if (!v) return null
  return { op, v }
}

// Expand sugar: ^1.2.3 -> >=1.2.3 <2.0.0; ~1.2.3 -> >=1.2.3 <1.3.0; 1.x -> >=1.0.0 <2.0.0; "1.2 - 2.3" -> >=1.2.0 <=2.3.0
function expandSet(set: string, loose: boolean): Comparator[] {
  // hyphen range
  const hyphen = /^([^\s]+)\s+-\s+([^\s]+)$/.exec(set.trim())
  if (hyphen) {
    const lo = parse(hyphen[1]!, loose)
    const hi = parse(hyphen[2]!, loose)
    if (!lo || !hi) return []
    return [
      { op: ">=", v: lo },
      { op: "<=", v: hi },
    ]
  }
  const out: Comparator[] = []
  for (const tokRaw of set.trim().split(/\s+/)) {
    if (!tokRaw) continue
    let tok = tokRaw
    // Wildcard tokens
    if (/^[~^=]?[*xX]$/.test(tok) || tok === "*") {
      out.push({ op: ">=", v: { major: 0, minor: 0, patch: 0, prerelease: [], build: [], raw: "0.0.0" } })
      continue
    }
    if (tok.startsWith("^") || tok.startsWith("~")) {
      const op = tok[0]
      const rest = tok.slice(1)
      const v = parse(rest, true)
      if (!v) return []
      if (op === "^") {
        // ^0.0.x -> >=0.0.x <0.0.(x+1) ; ^0.x.y -> >=0.x.y <0.(x+1).0 ; else >=x.y.z <(x+1).0.0
        out.push({ op: ">=", v })
        if (v.major !== 0) {
          out.push({
            op: "<",
            v: { major: v.major + 1, minor: 0, patch: 0, prerelease: [], build: [], raw: `${v.major + 1}.0.0` },
          })
        } else if (v.minor !== 0) {
          out.push({
            op: "<",
            v: {
              major: 0,
              minor: v.minor + 1,
              patch: 0,
              prerelease: [],
              build: [],
              raw: `0.${v.minor + 1}.0`,
            },
          })
        } else {
          out.push({
            op: "<",
            v: {
              major: 0,
              minor: 0,
              patch: v.patch + 1,
              prerelease: [],
              build: [],
              raw: `0.0.${v.patch + 1}`,
            },
          })
        }
      } else {
        // ~1.2.3 -> >=1.2.3 <1.3.0; ~1.2 -> >=1.2.0 <1.3.0; ~1 -> >=1.0.0 <2.0.0
        out.push({ op: ">=", v })
        const parts = rest.replace(/^v/i, "").split(/[-+]/, 1)[0]!.split(".")
        if (parts.length >= 2) {
          out.push({
            op: "<",
            v: {
              major: v.major,
              minor: v.minor + 1,
              patch: 0,
              prerelease: [],
              build: [],
              raw: `${v.major}.${v.minor + 1}.0`,
            },
          })
        } else {
          out.push({
            op: "<",
            v: { major: v.major + 1, minor: 0, patch: 0, prerelease: [], build: [], raw: `${v.major + 1}.0.0` },
          })
        }
      }
      continue
    }
    // x-range: 1.x or 1.2.x or 1.* etc.
    const xMatch = /^(\d+)(?:\.(\d+|x|X|\*))?(?:\.(\d+|x|X|\*))?$/.exec(tok)
    if (xMatch) {
      const ma = Number(xMatch[1])
      const mi = xMatch[2]
      const pa = xMatch[3]
      if (mi === undefined || mi === "x" || mi === "X" || mi === "*") {
        out.push({ op: ">=", v: { major: ma, minor: 0, patch: 0, prerelease: [], build: [], raw: `${ma}.0.0` } })
        out.push({
          op: "<",
          v: { major: ma + 1, minor: 0, patch: 0, prerelease: [], build: [], raw: `${ma + 1}.0.0` },
        })
        continue
      }
      const miN = Number(mi)
      if (pa === undefined || pa === "x" || pa === "X" || pa === "*") {
        out.push({
          op: ">=",
          v: { major: ma, minor: miN, patch: 0, prerelease: [], build: [], raw: `${ma}.${miN}.0` },
        })
        out.push({
          op: "<",
          v: { major: ma, minor: miN + 1, patch: 0, prerelease: [], build: [], raw: `${ma}.${miN + 1}.0` },
        })
        continue
      }
      // pa is a number — fall through to comparator parser
    }
    const cmp = parseComparator(tok, loose)
    if (cmp) out.push(cmp)
  }
  return out
}

function comparatorOk(target: SemVer, c: Comparator): boolean {
  const cmp = compareSemVer(target, c.v)
  if (c.op === "=") return cmp === 0
  if (c.op === "<") return cmp < 0
  if (c.op === "<=") return cmp <= 0
  if (c.op === ">") return cmp > 0
  if (c.op === ">=") return cmp >= 0
  return false
}

function compareSemVer(a: SemVer, b: SemVer): number {
  return compare(format(a), format(b))
}

export function satisfies(version: string, range: string, loose = true): boolean {
  const v = parse(version, loose)
  if (!v) return false
  // Splits on '||' for OR groups; spaces within = AND
  const groups = range.split("||")
  for (const g of groups) {
    const set = expandSet(g, loose)
    if (set.length === 0) continue
    if (set.every((c) => comparatorOk(v, c))) return true
  }
  return false
}

export function maxSatisfying(versions: readonly string[], range: string, loose = true): string | null {
  let best: string | null = null
  for (const ver of versions) {
    if (!satisfies(ver, range, loose)) continue
    if (best === null || compare(ver, best, loose) > 0) best = ver
  }
  return best
}

export function minSatisfying(versions: readonly string[], range: string, loose = true): string | null {
  let best: string | null = null
  for (const ver of versions) {
    if (!satisfies(ver, range, loose)) continue
    if (best === null || compare(ver, best, loose) < 0) best = ver
  }
  return best
}

export function sortVersions(versions: readonly string[], desc = false, loose = true): string[] {
  const arr = [...versions]
  arr.sort((a, b) => compare(a, b, loose))
  if (desc) arr.reverse()
  return arr
}

export function coerce(input: string): string | null {
  // Find the first "x[.y[.z]]" pattern in the string.
  const m = /(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(input)
  if (!m) return null
  return `${m[1]}.${m[2] ?? "0"}.${m[3] ?? "0"}`
}

const done = (result: Tool.ExecuteResult<Metadata>) => result

export const SemverTool = Tool.define(
  "semver",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Params, _ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const action = params.action
          const loose = params.loose !== false

          if (action === "parse") {
            if (!params.value) throw new Error("semver.parse: requires `value`")
            const p = parse(params.value, loose)
            if (!p) throw new Error(`semver.parse: invalid version '${params.value}'`)
            return done({
              title: `semver.parse: ${format(p)}`,
              metadata: { action, parsed: p },
              output: JSON.stringify(p, null, 2),
            })
          }

          if (action === "valid") {
            if (!params.value) throw new Error("semver.valid: requires `value`")
            const v = valid(params.value, loose)
            return done({
              title: `semver.valid: ${v}`,
              metadata: { action, result: v },
              output: String(v),
            })
          }

          if (action === "coerce") {
            if (!params.value) throw new Error("semver.coerce: requires `value`")
            const c = coerce(params.value)
            return done({
              title: `semver.coerce: ${c ?? "(no version found)"}`,
              metadata: { action, result: c },
              output: c ?? "",
            })
          }

          if (action === "compare" || action === "eq" || action === "neq" || action === "lt" || action === "lte" || action === "gt" || action === "gte") {
            if (!params.a || !params.b) throw new Error(`semver.${action}: requires \`a\` and \`b\``)
            const cmp = compare(params.a, params.b, loose)
            let result: number | boolean = cmp
            if (action === "eq") result = cmp === 0
            else if (action === "neq") result = cmp !== 0
            else if (action === "lt") result = cmp < 0
            else if (action === "lte") result = cmp <= 0
            else if (action === "gt") result = cmp > 0
            else if (action === "gte") result = cmp >= 0
            return done({
              title: `semver.${action}: ${result}`,
              metadata: { action, result },
              output: String(result),
            })
          }

          if (action === "inc") {
            if (!params.value) throw new Error("semver.inc: requires `value`")
            const release: Release = params.release ?? "patch"
            const next = inc(params.value, release, params.prerelease ?? "pre", loose)
            return done({
              title: `semver.inc.${release}: ${params.value} → ${next}`,
              metadata: { action, result: next },
              output: next,
            })
          }

          if (action === "satisfies") {
            if (!params.value || !params.range) throw new Error("semver.satisfies: requires `value` and `range`")
            const ok = satisfies(params.value, params.range, loose)
            return done({
              title: `semver.satisfies: ${ok}`,
              metadata: { action, result: ok },
              output: String(ok),
            })
          }

          if (action === "max_satisfying" || action === "min_satisfying") {
            if (!params.versions || !params.range) throw new Error(`semver.${action}: requires versions and range`)
            const fn = action === "max_satisfying" ? maxSatisfying : minSatisfying
            const result = fn(params.versions, params.range, loose)
            return done({
              title: `semver.${action}: ${result ?? "(none)"}`,
              metadata: { action, result, count: params.versions.length },
              output: result ?? "",
            })
          }

          if (action === "sort") {
            if (!params.versions) throw new Error("semver.sort: requires `versions`")
            const sorted = sortVersions(params.versions, params.desc === true, loose)
            return done({
              title: `semver.sort: ${sorted.length}${params.desc ? " desc" : " asc"}`,
              metadata: { action, result: sorted, count: sorted.length },
              output: sorted.join("\n"),
            })
          }

          throw new Error(`semver: unknown action '${action}'`)
        }),
    }
  }),
)

export const __testing = {
  parse,
  format,
  compare,
  satisfies,
  maxSatisfying,
  minSatisfying,
  sortVersions,
  inc,
  coerce,
  valid,
  expandSet,
  parseComparator,
}
