import { Effect, Schema } from "effect"
import { createHash } from "node:crypto"
import DESCRIPTION from "./mask.txt"
import * as Tool from "./tool"

const ACTIONS = ["redact", "detect", "count"] as const
const MODES = ["placeholder", "partial", "hash", "delete"] as const

const KINDS = [
  "email",
  "phone",
  "ipv4",
  "ipv6",
  "mac",
  "url",
  "credit_card",
  "ssn",
  "jwt",
  "bearer",
  "aws_access_key",
  "github_token",
  "slack_token",
  "gcp_api_key",
  "private_key_pem",
  "password_query",
] as const
type Kind = (typeof KINDS)[number] | string

export const Parameters = Schema.Struct({
  action: Schema.Literals(ACTIONS).annotate({ description: ACTIONS.join(" | ") }),
  text: Schema.String.check(Schema.isMaxLength(2_000_000)).annotate({
    description: "Input text (UTF-8). Cap 2,000,000 chars.",
  }),
  kinds: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "Limit detection to this list of kinds. Default: all built-in kinds + any `custom` entries.",
  }),
  exclude: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "Kinds to exclude from detection. Applied after `kinds`.",
  }),
  mode: Schema.optional(Schema.Literals(MODES)).annotate({
    description: "How to redact. placeholder | partial | hash | delete. action=redact only. Default placeholder.",
  }),
  custom: Schema.optional(
    Schema.Array(
      Schema.Struct({
        name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
        regex: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2_000)),
        flags: Schema.optional(Schema.String.check(Schema.isMaxLength(8))),
      }),
    ),
  ).annotate({
    description: "Optional custom detectors. Each {name, regex[, flags]}. Flags must be from the JS set 'gimsuy'.",
  }),
  limit: Schema.optional(
    Schema.Number.check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(1)).check(Schema.isLessThanOrEqualTo(10_000)),
  ).annotate({
    description: "Cap on number of detect entries returned. Default 1000.",
  }),
})

type Params = Schema.Schema.Type<typeof Parameters>
type Action = (typeof ACTIONS)[number]
type Mode = (typeof MODES)[number]

type Match = { kind: Kind; value: string; start: number; end: number }

type Metadata = {
  action: Action
  mode?: Mode
  total?: number
  by_kind?: Record<string, number>
  truncated?: boolean
}

const done = (result: Tool.ExecuteResult<Metadata>) => result

// --- credit card brand detection (mirrors luhn tool) ---
const CARD_PREFIXES = [
  /^4/, // Visa
  /^(5[1-5]|2(2[2-9]|[3-6]\d|7[01]|720))/, // Mastercard
  /^3[47]/, // Amex
  /^(6011|65|64[4-9]|622)/, // Discover
  /^(36|30[0-5]|3095|38|39)/, // Diners
  /^35(2[89]|[3-8]\d)/, // JCB
  /^62/, // UnionPay
]

function luhnValid(digits: string): boolean {
  if (digits.length < 13 || digits.length > 19) return false
  if (!/^\d+$/.test(digits)) return false
  let sum = 0
  let alt = false
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48
    if (alt) {
      n *= 2
      if (n > 9) n -= 9
    }
    sum += n
    alt = !alt
  }
  return sum % 10 === 0
}

function looksLikeCard(raw: string): boolean {
  const digits = raw.replace(/[\s-]/g, "")
  if (!CARD_PREFIXES.some((re) => re.test(digits))) return false
  return luhnValid(digits)
}

// --- built-in detectors ---
type Detector = { kind: string; pattern: RegExp; validate?: (raw: string) => boolean }

const DETECTORS: Detector[] = [
  // PEM-encoded private key blocks come first because they contain newlines/structure other patterns might tear apart.
  {
    kind: "private_key_pem",
    pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]+?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
  },
  {
    kind: "jwt",
    // header.payload.signature, all base64url, signature segment must have content.
    pattern: /\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  },
  {
    kind: "github_token",
    pattern: /\bgh[poursa]_[A-Za-z0-9]{20,255}\b/g,
  },
  {
    kind: "slack_token",
    pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  },
  {
    kind: "aws_access_key",
    pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  },
  {
    kind: "gcp_api_key",
    pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g,
  },
  {
    kind: "bearer",
    // capture the token portion only, after the literal "Bearer "
    pattern: /(?:^|\s)Bearer\s+([A-Za-z0-9._~+/=-]{12,})/g,
  },
  {
    kind: "password_query",
    // ?password=foo or &pwd=foo - capture value
    pattern: /(?:[?&](?:password|passwd|pwd))=([^&\s"']{3,})/gi,
  },
  {
    kind: "url",
    pattern: /\bhttps?:\/\/[^\s<>"'`]+/g,
  },
  {
    kind: "email",
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+\b/g,
  },
  {
    kind: "ipv6",
    // very-permissive IPv6: 2-8 hex groups separated by colons, must contain at least one colon and be 6+ chars.
    pattern:
      /\b(?:[0-9a-fA-F]{1,4}:){2,7}[0-9a-fA-F]{1,4}\b|\b(?:[0-9a-fA-F]{1,4}:){1,7}:|\b::(?:[0-9a-fA-F]{1,4}:){0,6}[0-9a-fA-F]{1,4}\b/g,
  },
  {
    kind: "ipv4",
    pattern:
      /\b(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}\b/g,
  },
  {
    kind: "mac",
    pattern: /\b(?:[0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}\b/g,
  },
  {
    kind: "credit_card",
    pattern: /\b(?:\d[ -]?){12,18}\d\b/g,
    validate: looksLikeCard,
  },
  {
    kind: "ssn",
    pattern: /\b(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/g,
  },
  {
    kind: "phone",
    // E.164 with optional grouping. Must contain >= 7 digits total, allow common separators.
    // Anchored with non-digit boundaries so we don't grab IDs inside longer digit runs.
    pattern:
      /(?<![0-9])(?:\+?\d{1,3}[\s.-]?)?(?:\(\d{1,4}\)[\s.-]?)?\d{2,4}[\s.-]\d{2,4}(?:[\s.-]\d{2,4})?(?![0-9])/g,
    validate: (raw: string) => {
      const digits = raw.replace(/\D/g, "")
      return digits.length >= 7 && digits.length <= 15
    },
  },
]

const KIND_ORDER = new Map(DETECTORS.map((d, i) => [d.kind as string, i]))

function compileCustom(custom: ReadonlyArray<{ name: string; regex: string; flags?: string }>): Detector[] {
  const out: Detector[] = []
  for (const c of custom) {
    if (c.flags && !/^[gimsuy]+$/.test(c.flags)) {
      throw new Error(`mask.custom: bad flags '${c.flags}' for ${c.name} (allowed: g,i,m,s,u,y)`)
    }
    const flags = c.flags && c.flags.includes("g") ? c.flags : (c.flags ?? "") + "g"
    let re: RegExp
    try {
      re = new RegExp(c.regex, flags)
    } catch (e) {
      throw new Error(`mask.custom[${c.name}]: invalid regex (${(e as Error).message})`)
    }
    out.push({ kind: c.name as Kind, pattern: re })
  }
  return out
}

function findMatches(
  text: string,
  detectors: Detector[],
  enabled: Set<string>,
): Match[] {
  const found: Match[] = []
  for (const det of detectors) {
    if (!enabled.has(det.kind)) continue
    // Always reset before reuse - patterns are shared across calls.
    det.pattern.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = det.pattern.exec(text)) !== null) {
      // Pattern may have a capture group that is the actual value (e.g. bearer / password_query).
      // When group 1 exists, narrow the match span to the capture so the literal "Bearer " stays in the text.
      const captured = m[1]
      let value = m[0]
      let start = m.index
      let end = start + value.length
      if (captured !== undefined && captured.length > 0) {
        const groupIdx = m[0].lastIndexOf(captured)
        if (groupIdx >= 0) {
          start = m.index + groupIdx
          end = start + captured.length
          value = captured
        }
      }
      if (value.length === 0) {
        // Defensive: avoid infinite loops on zero-width matches.
        det.pattern.lastIndex = end + 1
        continue
      }
      if (det.validate && !det.validate(value)) continue
      found.push({ kind: det.kind as Kind, value, start, end })
    }
  }
  // Resolve overlaps: prefer the detector with smaller index (earlier in DETECTORS = stronger), then earlier start, then longer.
  found.sort((a, b) => {
    const oa = KIND_ORDER.get(String(a.kind)) ?? 999
    const ob = KIND_ORDER.get(String(b.kind)) ?? 999
    if (oa !== ob) return oa - ob
    if (a.start !== b.start) return a.start - b.start
    return b.end - a.end // longer first
  })
  const resolved: Match[] = []
  for (const m of found) {
    if (resolved.some((existing) => m.start < existing.end && existing.start < m.end)) continue
    resolved.push(m)
  }
  return resolved.sort((a, b) => a.start - b.start)
}

function placeholderFor(kind: Kind, value: string, mode: Mode): string {
  switch (mode) {
    case "placeholder":
      return `[REDACTED:${kind}]`
    case "delete":
      return ""
    case "partial": {
      if (value.length <= 4) return "*".repeat(value.length)
      return value.slice(0, 2) + "*".repeat(value.length - 4) + value.slice(-2)
    }
    case "hash": {
      const h = createHash("sha256").update(value).digest("hex").slice(0, 8)
      return `${kind}-${h}`
    }
  }
}

function applyMatches(text: string, matches: Match[], mode: Mode): string {
  if (matches.length === 0) return text
  const sorted = matches.slice().sort((a, b) => a.start - b.start)
  const out: string[] = []
  let cursor = 0
  for (const m of sorted) {
    if (m.start < cursor) continue
    out.push(text.slice(cursor, m.start))
    out.push(placeholderFor(m.kind, m.value, mode))
    cursor = m.end
  }
  out.push(text.slice(cursor))
  return out.join("")
}

function summarize(matches: Match[]): { total: number; by_kind: Record<string, number> } {
  const by_kind: Record<string, number> = {}
  for (const m of matches) by_kind[String(m.kind)] = (by_kind[String(m.kind)] ?? 0) + 1
  return { total: matches.length, by_kind }
}

function buildEnabled(params: Params, customNames: string[]): Set<string> {
  const allBuiltins = KINDS as readonly string[]
  const all = new Set<string>([...allBuiltins, ...customNames])
  if (params.kinds && params.kinds.length > 0) {
    const allowed = new Set<string>(params.kinds.map(String))
    for (const k of [...all]) if (!allowed.has(k)) all.delete(k)
  }
  if (params.exclude && params.exclude.length > 0) {
    for (const k of params.exclude) all.delete(String(k))
  }
  return all
}

export const MaskTool = Tool.define(
  "mask",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Params, _ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const action: Action = params.action
          const mode: Mode = params.mode ?? "placeholder"
          const limit = params.limit ?? 1_000
          const customDetectors = params.custom ? compileCustom(params.custom) : []
          const customNames = customDetectors.map((d) => String(d.kind))
          const enabled = buildEnabled(params, customNames)
          const detectors: Detector[] = [...DETECTORS, ...customDetectors]

          const matches = findMatches(params.text, detectors, enabled)

          if (action === "count") {
            const s = summarize(matches)
            return done({
              title: `mask.count: ${s.total}`,
              metadata: { action, total: s.total, by_kind: s.by_kind },
              output: JSON.stringify({ total: s.total, by_kind: s.by_kind }, null, 2),
            })
          }

          if (action === "detect") {
            const truncated = matches.length > limit
            const slice = truncated ? matches.slice(0, limit) : matches
            const s = summarize(matches)
            return done({
              title: `mask.detect: ${s.total}${truncated ? ` (truncated to ${limit})` : ""}`,
              metadata: { action, total: s.total, by_kind: s.by_kind, truncated },
              output: JSON.stringify(slice, null, 2),
            })
          }

          // redact
          const redacted = applyMatches(params.text, matches, mode)
          const s = summarize(matches)
          return done({
            title: `mask.redact ${mode}: ${s.total}`,
            metadata: { action, mode, total: s.total, by_kind: s.by_kind },
            output: redacted,
          })
        }),
    }
  }),
)

export const __testing = {
  findMatches,
  applyMatches,
  placeholderFor,
  buildEnabled,
  compileCustom,
  summarize,
  DETECTORS,
  KINDS,
  luhnValid,
  looksLikeCard,
}
