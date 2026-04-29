import { Effect, Schema } from "effect"
import { randomBytes, randomUUID } from "node:crypto"
import DESCRIPTION from "./uuid.txt"
import * as Tool from "./tool"

const ACTIONS = ["v4", "v7", "validate", "parse", "nil", "urn"] as const
const FORMATS = ["canonical", "upper", "compact", "urn"] as const
const MAX_COUNT = 1000

export const Parameters = Schema.Struct({
  action: Schema.Literals(ACTIONS).annotate({
    description: "v4 (random), v7 (time-ordered), validate, parse, nil, or urn.",
  }),
  value: Schema.optional(Schema.String).annotate({
    description: "UUID string for validate/parse/urn.",
  }),
  count: Schema.optional(
    Schema.Number.check(Schema.isInt())
      .check(Schema.isGreaterThanOrEqualTo(1))
      .check(Schema.isLessThanOrEqualTo(MAX_COUNT)),
  ).annotate({
    description: `Number of UUIDs to generate. Default 1, max ${MAX_COUNT}.`,
  }),
  format: Schema.optional(Schema.Literals(FORMATS)).annotate({
    description: "Output format for generation: canonical (default), upper, compact, urn.",
  }),
})

type Params = Schema.Schema.Type<typeof Parameters>
type Action = (typeof ACTIONS)[number]
type Format = (typeof FORMATS)[number]

type ParsedInfo = {
  valid: boolean
  canonical?: string
  version?: number | null
  variant?: string
  timestamp_ms?: number
  reason?: string
}

type Metadata = {
  action: Action
  count: number
  format?: Format
  uuids?: string[]
  parsed?: ParsedInfo
  valid?: boolean
}

const CANONICAL_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/
const COMPACT_RE = /^[0-9a-fA-F]{32}$/
const URN_RE = /^urn:uuid:([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/

export function v4(): string {
  return randomUUID()
}

export function v7(now?: number): string {
  // RFC 9562 v7 layout: 48-bit unix-ms timestamp | 4-bit version | 12-bit random_a | 2-bit variant | 62-bit random_b
  const ms = BigInt(now ?? Date.now())
  const rand = randomBytes(10) // 80 random bits — we'll use 12 + 62 = 74; the rest gets overwritten by version/variant.
  // Bytes 0..5: timestamp_ms (big-endian 48 bits)
  const buf = Buffer.alloc(16)
  buf[0] = Number((ms >> 40n) & 0xffn)
  buf[1] = Number((ms >> 32n) & 0xffn)
  buf[2] = Number((ms >> 24n) & 0xffn)
  buf[3] = Number((ms >> 16n) & 0xffn)
  buf[4] = Number((ms >> 8n) & 0xffn)
  buf[5] = Number(ms & 0xffn)
  // Bytes 6..15: random; then mask in version (0x70) and variant (0x80).
  rand.copy(buf, 6, 0, 10)
  buf[6] = (buf[6]! & 0x0f) | 0x70 // version 7
  buf[8] = (buf[8]! & 0x3f) | 0x80 // RFC 4122 variant
  const hex = buf.toString("hex")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

export function isValidUuid(input: string): boolean {
  return CANONICAL_RE.test(input) || COMPACT_RE.test(input) || URN_RE.test(input)
}

export function toCanonical(input: string): string | null {
  const trimmed = input.trim()
  if (CANONICAL_RE.test(trimmed)) return trimmed.toLowerCase()
  if (COMPACT_RE.test(trimmed)) {
    const t = trimmed.toLowerCase()
    return `${t.slice(0, 8)}-${t.slice(8, 12)}-${t.slice(12, 16)}-${t.slice(16, 20)}-${t.slice(20, 32)}`
  }
  const urn = URN_RE.exec(trimmed)
  if (urn) return urn[1]!.toLowerCase()
  return null
}

export function parseUuid(input: string): ParsedInfo {
  const canonical = toCanonical(input)
  if (!canonical) return { valid: false, reason: "not a UUID-shaped string" }
  const hex = canonical.replace(/-/g, "")
  if (hex.length !== 32) return { valid: false, reason: "wrong length" }
  // Version is the high nibble of byte 6 (the first nibble of hex[12..14]).
  const versionNibble = parseInt(hex[12]!, 16)
  // RFC 4122 variant is high bits of byte 8.
  const variantByte = parseInt(hex.slice(16, 18), 16)
  let variant = "unknown"
  if ((variantByte & 0xc0) === 0x80) variant = "rfc4122"
  else if ((variantByte & 0xe0) === 0xc0) variant = "microsoft"
  else if ((variantByte & 0x80) === 0x00) variant = "ncs"
  else if ((variantByte & 0xe0) === 0xe0) variant = "future"
  const isNil = canonical === "00000000-0000-0000-0000-000000000000"
  if (isNil) {
    return { valid: true, canonical, version: 0, variant: "nil" }
  }
  const out: ParsedInfo = {
    valid: true,
    canonical,
    version: versionNibble,
    variant,
  }
  if (versionNibble === 7) {
    // First 48 bits = unix millis (big-endian).
    const tsHex = hex.slice(0, 12)
    out.timestamp_ms = Number(BigInt("0x" + tsHex))
  }
  return out
}

function format(canonical: string, fmt: Format): string {
  if (fmt === "canonical") return canonical
  if (fmt === "upper") return canonical.toUpperCase()
  if (fmt === "compact") return canonical.replace(/-/g, "")
  if (fmt === "urn") return `urn:uuid:${canonical}`
  return canonical
}

export const UuidTool = Tool.define(
  "uuid",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Params, _ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const action = params.action
          const fmt: Format = params.format ?? "canonical"

          if (action === "v4" || action === "v7" || action === "nil") {
            const count = params.count ?? 1
            const uuids: string[] = []
            for (let i = 0; i < count; i++) {
              const canonical = action === "v4" ? v4() : action === "v7" ? v7() : "00000000-0000-0000-0000-000000000000"
              uuids.push(format(canonical, fmt))
            }
            const meta: Metadata = { action, count, format: fmt, uuids }
            return {
              title: `uuid.${action}: ${count}${count === 1 ? " uuid" : " uuids"}${fmt === "canonical" ? "" : ` (${fmt})`}`,
              metadata: meta,
              output: uuids.join("\n"),
            }
          }

          if (action === "validate") {
            if (params.value === undefined) throw new Error("uuid: validate requires 'value'")
            const valid = isValidUuid(params.value.trim())
            const meta: Metadata = { action, count: valid ? 1 : 0, valid }
            return {
              title: valid ? "uuid.validate: valid" : "uuid.validate: invalid",
              metadata: meta,
              output: String(valid),
            }
          }

          if (action === "parse") {
            if (params.value === undefined) throw new Error("uuid: parse requires 'value'")
            const parsed = parseUuid(params.value.trim())
            const meta: Metadata = { action, count: parsed.valid ? 1 : 0, parsed, valid: parsed.valid }
            const lines = [
              `valid:     ${parsed.valid}`,
              parsed.canonical ? `canonical: ${parsed.canonical}` : undefined,
              parsed.version !== undefined ? `version:   ${parsed.version}` : undefined,
              parsed.variant ? `variant:   ${parsed.variant}` : undefined,
              parsed.timestamp_ms !== undefined
                ? `timestamp: ${parsed.timestamp_ms} ms (${new Date(parsed.timestamp_ms).toISOString()})`
                : undefined,
              parsed.reason ? `reason:    ${parsed.reason}` : undefined,
            ].filter(Boolean)
            return {
              title: parsed.valid
                ? `uuid.parse: v${parsed.version ?? "?"}/${parsed.variant ?? "?"}`
                : "uuid.parse: invalid",
              metadata: meta,
              output: lines.join("\n"),
            }
          }

          if (action === "urn") {
            if (params.value === undefined) throw new Error("uuid: urn requires 'value'")
            const canonical = toCanonical(params.value.trim())
            if (!canonical) throw new Error(`uuid: '${params.value}' is not a UUID`)
            const out = `urn:uuid:${canonical}`
            const meta: Metadata = { action, count: 1, format: "urn", uuids: [out] }
            return { title: `uuid.urn: ${out}`, metadata: meta, output: out }
          }

          throw new Error(`uuid: unsupported action '${action}'`)
        }),
    }
  }),
)

export const __testing = {
  v4,
  v7,
  isValidUuid,
  toCanonical,
  parseUuid,
  format,
}
