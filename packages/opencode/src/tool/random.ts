import { Effect, Schema } from "effect"
import { randomBytes, randomInt, randomUUID } from "node:crypto"
import DESCRIPTION from "./random.txt"
import * as Tool from "./tool"

const ACTIONS = ["int", "float", "bytes", "string", "password", "pick", "shuffle", "bool", "uuid"] as const
const OUTPUT_ENCODINGS = ["hex", "base64", "base64url"] as const

const MAX_BULK = 10_000
const MAX_LENGTH = 4096
const MAX_BYTES = 1024 * 1024 // 1 MiB

const ALPHABETS: Record<string, string> = {
  alphanumeric: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789",
  alpha: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz",
  numeric: "0123456789",
  lower: "abcdefghijklmnopqrstuvwxyz",
  upper: "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
  hex: "0123456789abcdef",
  urlsafe: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_",
}

// Confusable characters dropped from `password` when `avoid_ambiguous` is true.
const AMBIGUOUS = new Set("0OoIl1|`'\";:.,<>{}[]()")

export const Parameters = Schema.Struct({
  action: Schema.Literals(ACTIONS).annotate({
    description: "int, float, bytes, string, password, pick, shuffle, bool, uuid.",
  }),
  count: Schema.optional(Schema.Number.check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(1))).annotate({
    description: "Number of values to generate (default 1).",
  }),
  length: Schema.optional(Schema.Number.check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(1))).annotate({
    description: "Length for string/password/bytes.",
  }),
  min: Schema.optional(Schema.Number).annotate({ description: "Lower bound for int/float." }),
  max: Schema.optional(Schema.Number).annotate({ description: "Upper bound for int/float (int inclusive, float exclusive)." }),
  alphabet: Schema.optional(Schema.String).annotate({
    description: "Alphabet for action='string'. Preset name or explicit characters.",
  }),
  lowercase: Schema.optional(Schema.Boolean).annotate({ description: "password: include lowercase. Default true." }),
  uppercase: Schema.optional(Schema.Boolean).annotate({ description: "password: include uppercase. Default true." }),
  digits: Schema.optional(Schema.Boolean).annotate({ description: "password: include digits. Default true." }),
  symbols: Schema.optional(Schema.Boolean).annotate({ description: "password: include symbols. Default true." }),
  avoid_ambiguous: Schema.optional(Schema.Boolean).annotate({
    description: "password: drop confusable chars. Default true.",
  }),
  output_encoding: Schema.optional(Schema.Literals(OUTPUT_ENCODINGS)).annotate({
    description: "Encoding for bytes. Default 'hex'.",
  }),
  choices: Schema.optional(Schema.Array(Schema.Unknown)).annotate({
    description: "Source array for pick/shuffle.",
  }),
  weights: Schema.optional(Schema.Array(Schema.Number)).annotate({
    description: "Optional weights for pick (same length as choices). Implies sampling-with-replacement.",
  }),
  unique: Schema.optional(Schema.Boolean).annotate({
    description: "pick: choose without replacement (default true).",
  }),
})

type Params = Schema.Schema.Type<typeof Parameters>
type Action = (typeof ACTIONS)[number]
type OutputEncoding = (typeof OUTPUT_ENCODINGS)[number]

type Metadata = {
  action: Action
  value?: unknown
  values?: unknown[]
  count?: number
  length?: number
  encoding?: OutputEncoding
}

const done = (result: Tool.ExecuteResult<Metadata>) => result

function base64UrlEncode(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "")
}

function encodeBytes(buf: Buffer, enc: OutputEncoding): string {
  if (enc === "hex") return buf.toString("hex")
  if (enc === "base64") return buf.toString("base64")
  if (enc === "base64url") return base64UrlEncode(buf)
  throw new Error(`random: unknown output_encoding '${enc}'`)
}

export function randomFloat(): number {
  // 53 random bits → uniform in [0, 1).
  const buf = randomBytes(7)
  const hi = (buf[0]! << 16) + (buf[1]! << 8) + buf[2]! // 24 bits
  const lo = (buf[3]! << 16) + (buf[4]! << 8) + buf[5]! // 24 bits, but we only use 21 to fit 53
  // Use 53 bits = 32 (hi << 8 | byte 6) + 21 from `lo`.
  const a = ((hi & 0xffffff) * 0x10000 + ((buf[3]! << 8) | buf[4]!)) // 24 + 16 = 40 bits
  const b = ((buf[5]! << 8) | buf[6]!) & 0x1fff // 13 bits → total 53
  return (a * 0x2000 + b) / 0x20000000000000
}

function randomFloatInRange(min: number, max: number): number {
  return min + (max - min) * randomFloat()
}

function buildAlphabet(spec: string | undefined): string {
  if (!spec) return ALPHABETS.alphanumeric!
  if (spec in ALPHABETS) return ALPHABETS[spec]!
  if (spec.length === 0) throw new Error("random: alphabet cannot be empty")
  return spec
}

export function randomStringFromAlphabet(alphabet: string, length: number): string {
  if (alphabet.length < 2) throw new Error("random: alphabet must have ≥2 characters")
  if (length < 1 || length > MAX_LENGTH) throw new Error(`random: length must be 1..${MAX_LENGTH}`)
  // Rejection sampling for unbiased indexing into alphabet.
  const a = alphabet
  const n = a.length
  const limit = Math.floor(256 / n) * n
  const out: string[] = []
  while (out.length < length) {
    const need = (length - out.length) * 2
    const buf = randomBytes(Math.max(need, 16))
    for (let i = 0; i < buf.length && out.length < length; i++) {
      const v = buf[i]!
      if (v < limit) out.push(a[v % n]!)
    }
  }
  return out.join("")
}

export function generatePassword(opts: {
  length: number
  lowercase: boolean
  uppercase: boolean
  digits: boolean
  symbols: boolean
  avoid_ambiguous: boolean
}): string {
  const classes: string[] = []
  if (opts.lowercase) classes.push(ALPHABETS.lower!)
  if (opts.uppercase) classes.push(ALPHABETS.upper!)
  if (opts.digits) classes.push(ALPHABETS.numeric!)
  if (opts.symbols) classes.push("!@#$%^&*+=-_?<>")
  if (classes.length === 0) throw new Error("random: password requires at least one character class")
  const trimmed = opts.avoid_ambiguous
    ? classes.map((c) =>
        c
          .split("")
          .filter((ch) => !AMBIGUOUS.has(ch))
          .join(""),
      )
    : classes
  // After trimming, if any class became empty, drop it; we'll then verify there is still ≥1 class.
  const usable = trimmed.filter((c) => c.length > 0)
  if (usable.length === 0) throw new Error("random: avoid_ambiguous removed all characters")
  const all = usable.join("")
  if (opts.length < usable.length) {
    throw new Error(`random: password length ${opts.length} cannot satisfy ${usable.length} character classes`)
  }
  for (let attempt = 0; attempt < 32; attempt++) {
    const candidate = randomStringFromAlphabet(all, opts.length)
    let ok = true
    for (const cls of usable) {
      if (![...candidate].some((ch) => cls.includes(ch))) {
        ok = false
        break
      }
    }
    if (ok) return candidate
  }
  throw new Error("random: failed to satisfy character-class constraints in 32 attempts")
}

export function pickWithoutReplacement<T>(choices: readonly T[], count: number): T[] {
  if (count > choices.length) throw new Error(`random: cannot pick ${count} unique from ${choices.length}`)
  // Fisher-Yates partial.
  const a = [...choices]
  for (let i = 0; i < count; i++) {
    const j = i + randomInt(0, a.length - i)
    const tmp = a[i]!
    a[i] = a[j]!
    a[j] = tmp
  }
  return a.slice(0, count)
}

export function pickWithReplacement<T>(choices: readonly T[], count: number, weights?: readonly number[]): T[] {
  const out: T[] = []
  if (weights && weights.length !== choices.length) {
    throw new Error("random: weights length must match choices length")
  }
  if (weights) {
    let total = 0
    for (const w of weights) {
      if (!Number.isFinite(w) || w < 0) throw new Error("random: weights must be non-negative finite numbers")
      total += w
    }
    if (total <= 0) throw new Error("random: weights sum must be > 0")
    const cumulative: number[] = []
    let acc = 0
    for (const w of weights) {
      acc += w
      cumulative.push(acc)
    }
    for (let i = 0; i < count; i++) {
      const r = randomFloat() * total
      // Linear scan; choices arrays in practice are small.
      let idx = cumulative.findIndex((c) => r < c)
      if (idx < 0) idx = choices.length - 1
      out.push(choices[idx]!)
    }
    return out
  }
  for (let i = 0; i < count; i++) out.push(choices[randomInt(0, choices.length)]!)
  return out
}

export function shuffle<T>(choices: readonly T[]): T[] {
  const a = [...choices]
  for (let i = a.length - 1; i > 0; i--) {
    const j = randomInt(0, i + 1)
    const tmp = a[i]!
    a[i] = a[j]!
    a[j] = tmp
  }
  return a
}

export const RandomTool = Tool.define(
  "random",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Params, _ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const action = params.action
          const count = params.count ?? 1
          if (count > MAX_BULK) throw new Error(`random: count exceeds ${MAX_BULK}`)

          if (action === "int") {
            const min = params.min !== undefined ? Math.trunc(params.min) : 0
            const max = params.max !== undefined ? Math.trunc(params.max) : 100
            if (min > max) throw new Error(`random: min ${min} > max ${max}`)
            if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max)) {
              throw new Error("random: int bounds must be safe integers")
            }
            // randomInt's range is [min, max). We want inclusive max.
            const values: number[] = []
            for (let i = 0; i < count; i++) values.push(randomInt(min, max + 1))
            return done({
              title: `random.int: ${count}`,
              metadata: { action, values, value: count === 1 ? values[0] : undefined, count },
              output: values.join("\n"),
            })
          }

          if (action === "float") {
            const min = params.min ?? 0
            const max = params.max ?? 1
            if (min >= max) throw new Error(`random: min ${min} must be < max ${max}`)
            const values: number[] = []
            for (let i = 0; i < count; i++) values.push(randomFloatInRange(min, max))
            return done({
              title: `random.float: ${count}`,
              metadata: { action, values, value: count === 1 ? values[0] : undefined, count },
              output: values.join("\n"),
            })
          }

          if (action === "bool") {
            const values: boolean[] = []
            for (let i = 0; i < count; i++) values.push(randomInt(0, 2) === 1)
            return done({
              title: `random.bool: ${count}`,
              metadata: { action, values, value: count === 1 ? values[0] : undefined, count },
              output: values.join("\n"),
            })
          }

          if (action === "bytes") {
            const length = params.length ?? 32
            if (length > MAX_BYTES) throw new Error(`random: bytes length exceeds ${MAX_BYTES}`)
            const enc: OutputEncoding = params.output_encoding ?? "hex"
            const values: string[] = []
            for (let i = 0; i < count; i++) values.push(encodeBytes(randomBytes(length), enc))
            return done({
              title: `random.bytes: ${length}B${count > 1 ? ` × ${count}` : ""}`,
              metadata: { action, values, value: count === 1 ? values[0] : undefined, count, length, encoding: enc },
              output: values.join("\n"),
            })
          }

          if (action === "string") {
            const length = params.length ?? 16
            const alphabet = buildAlphabet(params.alphabet)
            const values: string[] = []
            for (let i = 0; i < count; i++) values.push(randomStringFromAlphabet(alphabet, length))
            return done({
              title: `random.string: len=${length}${count > 1 ? ` × ${count}` : ""}`,
              metadata: { action, values, value: count === 1 ? values[0] : undefined, count, length },
              output: values.join("\n"),
            })
          }

          if (action === "password") {
            const length = params.length ?? 16
            const opts = {
              length,
              lowercase: params.lowercase !== false,
              uppercase: params.uppercase !== false,
              digits: params.digits !== false,
              symbols: params.symbols !== false,
              avoid_ambiguous: params.avoid_ambiguous !== false,
            }
            const values: string[] = []
            for (let i = 0; i < count; i++) values.push(generatePassword(opts))
            return done({
              title: `random.password: len=${length}${count > 1 ? ` × ${count}` : ""}`,
              metadata: { action, values, value: count === 1 ? values[0] : undefined, count, length },
              output: values.join("\n"),
            })
          }

          if (action === "pick") {
            if (!params.choices || params.choices.length === 0) {
              throw new Error("random: 'choices' required and non-empty")
            }
            const unique = params.unique !== false && !params.weights
            const picked = unique
              ? pickWithoutReplacement(params.choices, count)
              : pickWithReplacement(params.choices, count, params.weights)
            return done({
              title: `random.pick: ${picked.length}/${params.choices.length}`,
              metadata: { action, values: picked, value: count === 1 ? picked[0] : undefined, count: picked.length },
              output: picked.map((v) => (typeof v === "string" ? v : JSON.stringify(v))).join("\n"),
            })
          }

          if (action === "shuffle") {
            if (!params.choices) throw new Error("random: 'choices' required")
            const out = shuffle(params.choices)
            return done({
              title: `random.shuffle: ${out.length} item(s)`,
              metadata: { action, values: out, count: out.length },
              output: out.map((v) => (typeof v === "string" ? v : JSON.stringify(v))).join("\n"),
            })
          }

          if (action === "uuid") {
            const values: string[] = []
            for (let i = 0; i < count; i++) values.push(randomUUID())
            return done({
              title: `random.uuid: ${count}`,
              metadata: { action, values, value: count === 1 ? values[0] : undefined, count },
              output: values.join("\n"),
            })
          }

          throw new Error(`random: unsupported action '${action}'`)
        }),
    }
  }),
)

export const __testing = {
  randomFloat,
  randomStringFromAlphabet,
  generatePassword,
  pickWithoutReplacement,
  pickWithReplacement,
  shuffle,
  buildAlphabet,
  encodeBytes,
}
