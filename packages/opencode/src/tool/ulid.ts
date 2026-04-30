import { Effect, Schema } from "effect"
import { randomBytes } from "node:crypto"
import DESCRIPTION from "./ulid.txt"
import * as Tool from "./tool"

const ACTIONS = ["generate", "parse", "validate", "from_uuid", "to_uuid"] as const

export const Parameters = Schema.Struct({
  action: Schema.Literals(ACTIONS).annotate({
    description: ACTIONS.join(" | "),
  }),
  value: Schema.optional(Schema.String).annotate({
    description: "Input ULID for parse/validate/to_uuid; UUID string for from_uuid.",
  }),
  count: Schema.optional(
    Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(1000)),
  ).annotate({
    description: "Number of ULIDs to generate. Default 1, max 1000.",
  }),
  seed: Schema.optional(Schema.Number.check(Schema.isInt())).annotate({
    description: "Optional integer seed for deterministic generation (mulberry32).",
  }),
  time_ms: Schema.optional(
    Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(0xffffffffffff)),
  ).annotate({
    description: "Override the embedded timestamp (unix ms). Default Date.now(). 0 .. 2^48-1.",
  }),
  monotonic: Schema.optional(Schema.Boolean).annotate({
    description:
      "When generating multiple ULIDs at the same millisecond, ensure they are lexicographically increasing. Default true.",
  }),
})

type Params = Schema.Schema.Type<typeof Parameters>
type Action = (typeof ACTIONS)[number]

type ParsedInfo = {
  valid: boolean
  canonical?: string
  timestamp_ms?: number
  timestamp_iso?: string
  random_b32?: string
  random_hex?: string
  raw_hex?: string
  uuid?: string
  reason?: string
}

type Metadata = {
  action: Action
  count?: number
  ulids?: string[]
  parsed?: ParsedInfo
  valid?: boolean
}

// Crockford base32 (no I/L/O/U). Always uppercase on encode.
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
// Accepts the canonical Crockford alphabet plus I/L (decode as 1) and O (decode as 0).
// U is excluded by the Crockford spec to avoid offensive words.
const ULID_RE = /^[0-9A-TV-Za-tv-z]{26}$/
const UUID_RE = /^[0-9a-fA-F]{8}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{12}$/

function decodeChar(ch: string): number {
  // Crockford normalises I/L -> 1, O -> 0 on decode. Lowercase allowed.
  const c = ch.toUpperCase()
  if (c === "I" || c === "L") return 1
  if (c === "O") return 0
  const idx = ALPHABET.indexOf(c)
  if (idx === -1) throw new Error(`ulid: invalid character '${ch}'`)
  return idx
}

// Mulberry32 deterministic PRNG (matches the seed style used elsewhere in SG tools).
export function mulberry32(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function makeRandomFn(seed?: number): () => Uint8Array {
  if (seed === undefined) {
    return () => Uint8Array.from(randomBytes(10))
  }
  const rng = mulberry32(seed)
  return () => {
    const out = new Uint8Array(10)
    for (let i = 0; i < 10; i++) out[i] = Math.floor(rng() * 256) & 0xff
    return out
  }
}

function encodeTime(ms: number): string {
  // 48 bits -> 10 base32 chars (each = 5 bits, 10*5=50 bits, top 2 bits are zero).
  if (ms < 0 || ms > 0xffffffffffff) throw new Error("ulid: time_ms out of range")
  let v = BigInt(ms)
  let out = ""
  for (let i = 0; i < 10; i++) {
    const idx = Number(v & 0x1fn)
    out = ALPHABET[idx]! + out
    v >>= 5n
  }
  return out
}

function encodeRandom(bytes: Uint8Array): string {
  // 80 bits -> 16 base32 chars. Treat the 10 bytes as a big-endian 80-bit integer.
  if (bytes.length !== 10) throw new Error("ulid: random must be 10 bytes")
  let v = 0n
  for (let i = 0; i < 10; i++) v = (v << 8n) | BigInt(bytes[i]!)
  let out = ""
  for (let i = 0; i < 16; i++) {
    const idx = Number(v & 0x1fn)
    out = ALPHABET[idx]! + out
    v >>= 5n
  }
  return out
}

export function encodeUlid(timeMs: number, random: Uint8Array): string {
  return encodeTime(timeMs) + encodeRandom(random)
}

export function decodeUlid(s: string): { time_ms: number; random: Uint8Array } {
  const trimmed = s.trim()
  if (!ULID_RE.test(trimmed)) throw new Error("ulid: not a 26-char Crockford-base32 string")
  let timeBig = 0n
  for (let i = 0; i < 10; i++) timeBig = (timeBig << 5n) | BigInt(decodeChar(trimmed[i]!))
  if (timeBig > 0xffffffffffffn) throw new Error("ulid: timestamp overflow (> 2^48-1)")
  let randBig = 0n
  for (let i = 10; i < 26; i++) randBig = (randBig << 5n) | BigInt(decodeChar(trimmed[i]!))
  // randBig now uses 80 bits.
  const random = new Uint8Array(10)
  let v = randBig
  for (let i = 9; i >= 0; i--) {
    random[i] = Number(v & 0xffn)
    v >>= 8n
  }
  return { time_ms: Number(timeBig), random }
}

export function isValidUlid(s: string): boolean {
  try {
    decodeUlid(s)
    return true
  } catch {
    return false
  }
}

// Increment the random part by 1 (big-endian). Returns true on overflow.
function incrementRandom(random: Uint8Array): boolean {
  for (let i = random.length - 1; i >= 0; i--) {
    if (random[i] === 0xff) {
      random[i] = 0
    } else {
      random[i] = random[i]! + 1
      return false
    }
  }
  return true // overflow - all bytes were 0xff and rolled to 0
}

export function generateUlids(opts: {
  count?: number
  time_ms?: number
  seed?: number
  monotonic?: boolean
}): string[] {
  const count = opts.count ?? 1
  const monotonic = opts.monotonic ?? true
  const rand = makeRandomFn(opts.seed)
  const out: string[] = []
  let lastMs: number | undefined
  let lastRandom: Uint8Array | undefined
  for (let i = 0; i < count; i++) {
    const t = opts.time_ms ?? Date.now()
    let r: Uint8Array
    if (monotonic && lastMs !== undefined && lastRandom !== undefined && t === lastMs) {
      r = new Uint8Array(lastRandom)
      const overflowed = incrementRandom(r)
      if (overflowed) {
        // 80-bit space exhausted within the same ms; bump time by 1ms and re-randomise.
        r = rand()
        out.push(encodeUlid(t + 1, r))
        lastMs = t + 1
        lastRandom = r
        continue
      }
    } else {
      r = rand()
    }
    out.push(encodeUlid(t, r))
    lastMs = t
    lastRandom = r
  }
  return out
}

export function ulidToUuid(s: string): string {
  const { time_ms, random } = decodeUlid(s)
  const buf = Buffer.alloc(16)
  buf[0] = (time_ms / 0x10000000000) & 0xff
  buf[1] = (time_ms / 0x100000000) & 0xff
  buf[2] = (time_ms >>> 24) & 0xff
  buf[3] = (time_ms >>> 16) & 0xff
  buf[4] = (time_ms >>> 8) & 0xff
  buf[5] = time_ms & 0xff
  for (let i = 0; i < 10; i++) buf[6 + i] = random[i]!
  const hex = buf.toString("hex")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

export function uuidToUlid(s: string): string {
  const trimmed = s.trim()
  if (!UUID_RE.test(trimmed)) throw new Error("ulid: not a UUID-shaped string")
  const hex = trimmed.replace(/-/g, "").toLowerCase()
  if (hex.length !== 32) throw new Error("ulid: UUID must be 32 hex chars")
  const buf = Buffer.from(hex, "hex")
  const time_ms =
    buf[0]! * 0x10000000000 + buf[1]! * 0x100000000 + buf[2]! * 0x1000000 + buf[3]! * 0x10000 + buf[4]! * 0x100 + buf[5]!
  const random = Uint8Array.from(buf.subarray(6, 16))
  return encodeUlid(time_ms, random)
}

export function parseUlid(s: string): ParsedInfo {
  try {
    const { time_ms, random } = decodeUlid(s)
    const canonical = encodeUlid(time_ms, random)
    const randomHex = Buffer.from(random).toString("hex")
    const buf = Buffer.alloc(16)
    buf[0] = (time_ms / 0x10000000000) & 0xff
    buf[1] = (time_ms / 0x100000000) & 0xff
    buf[2] = (time_ms >>> 24) & 0xff
    buf[3] = (time_ms >>> 16) & 0xff
    buf[4] = (time_ms >>> 8) & 0xff
    buf[5] = time_ms & 0xff
    for (let i = 0; i < 10; i++) buf[6 + i] = random[i]!
    return {
      valid: true,
      canonical,
      timestamp_ms: time_ms,
      timestamp_iso: new Date(time_ms).toISOString(),
      random_b32: encodeRandom(random),
      random_hex: randomHex,
      raw_hex: buf.toString("hex"),
      uuid: ulidToUuid(canonical),
    }
  } catch (err: unknown) {
    return { valid: false, reason: (err as Error).message }
  }
}

export const UlidTool = Tool.define(
  "ulid",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Params, _ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const action = params.action

          if (action === "generate") {
            const count = params.count ?? 1
            const ulids = generateUlids({
              count,
              time_ms: params.time_ms,
              seed: params.seed,
              monotonic: params.monotonic,
            })
            const meta: Metadata = { action, count, ulids }
            return {
              title: `ulid.generate ${count}`,
              metadata: meta,
              output: ulids.join("\n"),
            }
          }

          if (action === "parse") {
            if (params.value === undefined) throw new Error("ulid: parse requires 'value'")
            const parsed = parseUlid(params.value.trim())
            const meta: Metadata = { action, parsed, valid: parsed.valid }
            const lines = parsed.valid
              ? [
                  `valid:        true`,
                  `canonical:    ${parsed.canonical}`,
                  `timestamp_ms: ${parsed.timestamp_ms}`,
                  `timestamp:    ${parsed.timestamp_iso}`,
                  `random_b32:   ${parsed.random_b32}`,
                  `random_hex:   ${parsed.random_hex}`,
                  `uuid:         ${parsed.uuid}`,
                ]
              : [`valid:  false`, `reason: ${parsed.reason}`]
            return {
              title: parsed.valid ? `ulid.parse: ${parsed.timestamp_iso}` : "ulid.parse: invalid",
              metadata: meta,
              output: lines.join("\n"),
            }
          }

          if (action === "validate") {
            if (params.value === undefined) throw new Error("ulid: validate requires 'value'")
            const valid = isValidUlid(params.value.trim())
            const meta: Metadata = { action, valid, count: valid ? 1 : 0 }
            return {
              title: valid ? "ulid.validate: valid" : "ulid.validate: invalid",
              metadata: meta,
              output: String(valid),
            }
          }

          if (action === "from_uuid") {
            if (params.value === undefined) throw new Error("ulid: from_uuid requires 'value'")
            const out = uuidToUlid(params.value.trim())
            const meta: Metadata = { action, count: 1, ulids: [out] }
            return { title: `ulid.from_uuid: ${out}`, metadata: meta, output: out }
          }

          if (action === "to_uuid") {
            if (params.value === undefined) throw new Error("ulid: to_uuid requires 'value'")
            const out = ulidToUuid(params.value.trim())
            const meta: Metadata = { action, count: 1, ulids: [out] }
            return { title: `ulid.to_uuid: ${out}`, metadata: meta, output: out }
          }

          throw new Error(`ulid: unknown action ${action satisfies never}`)
        }),
    }
  }),
)

export const __testing = {
  ALPHABET,
  ULID_RE,
  encodeTime,
  encodeRandom,
  encodeUlid,
  decodeUlid,
  isValidUlid,
  generateUlids,
  parseUlid,
  ulidToUuid,
  uuidToUlid,
  incrementRandom,
  mulberry32,
}
