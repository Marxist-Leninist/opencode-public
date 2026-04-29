import { Effect, Schema } from "effect"
import DESCRIPTION from "./regex.txt"
import * as Tool from "./tool"

const ACTIONS = ["test", "match", "match_all", "replace", "replace_all", "split", "extract"] as const
const ALLOWED_FLAGS = new Set(["i", "m", "s", "g", "u", "y", "d"])
const MAX_VALUE_BYTES = 16 * 1024 * 1024 // 16 MiB
const MAX_PATTERN_LEN = 8192
const DEFAULT_LIMIT = 1000
const MAX_LIMIT = 100_000

export const Parameters = Schema.Struct({
  action: Schema.Literals(ACTIONS).annotate({
    description:
      "test (boolean), match (first), match_all (every match), replace (first), replace_all (all), split, extract (capture groups only).",
  }),
  pattern: Schema.String.check(Schema.isMinLength(1)).annotate({
    description: "Regex source — without surrounding slashes. Pass flags separately.",
  }),
  value: Schema.String.annotate({
    description: "Input string to operate on.",
  }),
  flags: Schema.optional(Schema.String).annotate({
    description:
      "Regex flags: any combination of i, m, s, g, u, y, d. Duplicates de-duplicated. 'g' is auto-added when needed.",
  }),
  replacement: Schema.optional(Schema.String).annotate({
    description:
      "Replacement string for replace/replace_all. Supports $1, $&, $<name> backreferences.",
  }),
  limit: Schema.optional(
    Schema.Number.check(Schema.isInt())
      .check(Schema.isGreaterThanOrEqualTo(1))
      .check(Schema.isLessThanOrEqualTo(MAX_LIMIT)),
  ).annotate({
    description: `Max items returned for match_all/extract/split. Default ${DEFAULT_LIMIT}.`,
  }),
  group: Schema.optional(Schema.Union([Schema.String, Schema.Number])).annotate({
    description: "For extract: capture group name or 1-based index. Default returns all groups joined.",
  }),
})

type Params = Schema.Schema.Type<typeof Parameters>
type Action = (typeof ACTIONS)[number]

type MatchEntry = {
  match: string
  index: number
  groups: (string | undefined)[]
  named_groups: Record<string, string | undefined>
}

type Metadata = {
  action: Action
  pattern: string
  flags: string
  count: number
  result_kind: "boolean" | "string" | "matches" | "parts"
  matched?: boolean
  matches?: MatchEntry[]
  replaced?: string
  parts?: string[]
  truncated_results?: boolean
}

export function normalizeFlags(input: string | undefined, action: Action): string {
  const seen = new Set<string>()
  for (const ch of input ?? "") {
    if (!ALLOWED_FLAGS.has(ch)) throw new Error(`regex: invalid flag '${ch}'. Allowed: ${[...ALLOWED_FLAGS].join("")}`)
    seen.add(ch)
  }
  if (action === "match_all" || action === "replace_all" || action === "extract") seen.add("g")
  return [...seen].join("")
}

export function compile(pattern: string, flags: string): RegExp {
  if (pattern.length > MAX_PATTERN_LEN) throw new Error(`regex: pattern exceeds ${MAX_PATTERN_LEN} chars`)
  try {
    return new RegExp(pattern, flags)
  } catch (err) {
    throw new Error(`regex: invalid pattern: ${err instanceof Error ? err.message : String(err)}`)
  }
}

function toEntry(m: RegExpExecArray): MatchEntry {
  const groups: (string | undefined)[] = []
  for (let i = 1; i < m.length; i++) groups.push(m[i])
  const namedSrc = m.groups ?? {}
  const named: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(namedSrc)) named[k] = v
  return {
    match: m[0]!,
    index: m.index,
    groups,
    named_groups: named,
  }
}

function execAll(re: RegExp, value: string, limit: number): { matches: MatchEntry[]; truncated: boolean } {
  const out: MatchEntry[] = []
  let truncated = false
  let m: RegExpExecArray | null
  // Defensive: if user passes a non-global RegExp here we still cap, but
  // exec will return null after the first match. We always upgrade to global
  // before calling this for global-required actions.
  const wasGlobal = re.flags.includes("g")
  if (!wasGlobal) {
    const first = re.exec(value)
    if (first) out.push(toEntry(first))
    return { matches: out, truncated: false }
  }
  re.lastIndex = 0
  while ((m = re.exec(value)) !== null) {
    if (out.length >= limit) {
      truncated = true
      break
    }
    out.push(toEntry(m))
    // Avoid infinite loop on zero-length matches.
    if (m.index === re.lastIndex) re.lastIndex++
  }
  return { matches: out, truncated }
}

export const RegexTool = Tool.define(
  "regex",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Params, _ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          if (Buffer.byteLength(params.value, "utf8") > MAX_VALUE_BYTES) {
            throw new Error(`regex: value exceeds ${MAX_VALUE_BYTES} bytes`)
          }
          const action = params.action
          const flags = normalizeFlags(params.flags, action)
          const re = compile(params.pattern, flags)
          const limit = params.limit ?? DEFAULT_LIMIT

          if (action === "test") {
            const matched = re.test(params.value)
            // RegExp.test on a /g/ regex moves lastIndex. Reset it so subsequent reuse is sane.
            re.lastIndex = 0
            const meta: Metadata = {
              action,
              pattern: params.pattern,
              flags,
              count: matched ? 1 : 0,
              result_kind: "boolean",
              matched,
            }
            return { title: matched ? "regex.test: match" : "regex.test: no match", metadata: meta, output: String(matched) }
          }

          if (action === "match") {
            const m = re.exec(params.value)
            const entry = m ? toEntry(m) : null
            const meta: Metadata = {
              action,
              pattern: params.pattern,
              flags,
              count: entry ? 1 : 0,
              result_kind: "matches",
              matches: entry ? [entry] : [],
            }
            return {
              title: entry ? `regex.match: '${truncate(entry.match, 40)}' @${entry.index}` : "regex.match: no match",
              metadata: meta,
              output: entry ? JSON.stringify(entry, null, 2) : "(no match)",
            }
          }

          if (action === "match_all") {
            const { matches, truncated } = execAll(re, params.value, limit)
            const meta: Metadata = {
              action,
              pattern: params.pattern,
              flags,
              count: matches.length,
              result_kind: "matches",
              matches,
              truncated_results: truncated || undefined,
            }
            return {
              title: `regex.match_all: ${matches.length}${truncated ? "+" : ""} match${matches.length === 1 ? "" : "es"}`,
              metadata: meta,
              output: JSON.stringify(matches, null, 2),
            }
          }

          if (action === "replace" || action === "replace_all") {
            if (params.replacement === undefined) {
              throw new Error(`regex: action '${action}' requires 'replacement'`)
            }
            const replaced = params.value.replace(re, params.replacement)
            // Count replacements separately so we can report it accurately.
            const counterFlags = action === "replace_all" ? flags : (flags + "g").split("").filter((c, i, a) => a.indexOf(c) === i).join("")
            const counter = compile(params.pattern, counterFlags)
            let count = 0
            counter.lastIndex = 0
            // For 'replace' (non-global), count is at most 1.
            if (action === "replace") {
              count = counter.exec(params.value) ? 1 : 0
            } else {
              while (counter.exec(params.value) !== null) {
                count++
                if (counter.lastIndex === 0) break // safety
              }
            }
            const meta: Metadata = {
              action,
              pattern: params.pattern,
              flags,
              count,
              result_kind: "string",
              replaced,
            }
            return {
              title: `regex.${action}: ${count} replacement${count === 1 ? "" : "s"}`,
              metadata: meta,
              output: replaced,
            }
          }

          if (action === "split") {
            const parts = params.value.split(re).slice(0, limit)
            const meta: Metadata = {
              action,
              pattern: params.pattern,
              flags,
              count: parts.length,
              result_kind: "parts",
              parts,
            }
            return {
              title: `regex.split: ${parts.length} parts`,
              metadata: meta,
              output: JSON.stringify(parts, null, 2),
            }
          }

          if (action === "extract") {
            const { matches, truncated } = execAll(re, params.value, limit)
            const extracted: string[] = []
            for (const m of matches) {
              if (params.group !== undefined) {
                if (typeof params.group === "number") {
                  const idx = params.group
                  if (idx < 1) throw new Error("regex: extract group index must be >= 1")
                  const v = m.groups[idx - 1]
                  if (v !== undefined) extracted.push(v)
                } else {
                  const v = m.named_groups[params.group]
                  if (v !== undefined) extracted.push(v)
                }
              } else {
                // No group: join all positional groups, fallback to whole match if no groups.
                if (m.groups.length === 0) extracted.push(m.match)
                else extracted.push(m.groups.filter((g): g is string => g !== undefined).join(""))
              }
            }
            const meta: Metadata = {
              action,
              pattern: params.pattern,
              flags,
              count: extracted.length,
              result_kind: "parts",
              parts: extracted,
              truncated_results: truncated || undefined,
            }
            return {
              title: `regex.extract: ${extracted.length}${truncated ? "+" : ""} item${extracted.length === 1 ? "" : "s"}`,
              metadata: meta,
              output: extracted.length === 0 ? "(no extractions)" : extracted.join("\n"),
            }
          }

          throw new Error(`regex: unsupported action '${action}'`)
        }),
    }
  }),
)

function truncate(s: string, n: number): string {
  if (s.length <= n) return s
  return s.slice(0, n - 1) + "…"
}

export const __testing = {
  normalizeFlags,
  compile,
  execAll,
}
