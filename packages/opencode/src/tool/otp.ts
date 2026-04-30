import { Effect, Schema } from "effect"
import { createHmac, timingSafeEqual } from "node:crypto"
import DESCRIPTION from "./otp.txt"
import * as Tool from "./tool"

const ACTIONS = ["totp", "hotp", "verify_totp", "verify_hotp", "parse_uri", "make_uri"] as const
const ALGORITHMS = ["SHA1", "SHA256", "SHA512"] as const
const TYPES = ["totp", "hotp"] as const

export const Parameters = Schema.Struct({
  action: Schema.Literals(ACTIONS).annotate({ description: ACTIONS.join(" | ") }),
  type: Schema.optional(Schema.Literals(TYPES)).annotate({ description: "URI type for make_uri. Default totp." }),
  secret: Schema.optional(Schema.String).annotate({ description: "Base32 secret." }),
  algorithm: Schema.optional(Schema.Literals(ALGORITHMS)).annotate({
    description: "HMAC algorithm. Default SHA1.",
  }),
  digits: Schema.optional(
    Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(6), Schema.isLessThanOrEqualTo(10)),
  ).annotate({ description: "Code length 6-10. Default 6." }),
  period_s: Schema.optional(
    Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(3600)),
  ).annotate({ description: "TOTP step seconds. Default 30." }),
  at_unix_s: Schema.optional(Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))).annotate({
    description: "Compute TOTP at this unix time instead of now.",
  }),
  counter: Schema.optional(Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))).annotate({
    description: "HOTP counter.",
  }),
  look_ahead: Schema.optional(
    Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(10000)),
  ).annotate({ description: "verify_hotp scan range. Default 10." }),
  window: Schema.optional(
    Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(60)),
  ).annotate({ description: "verify_totp leeway in steps. Default 1." }),
  code: Schema.optional(Schema.String).annotate({ description: "OTP to verify." }),
  uri: Schema.optional(Schema.String).annotate({ description: "otpauth:// URI." }),
  issuer: Schema.optional(Schema.String).annotate({ description: "Issuer for make_uri." }),
  account: Schema.optional(Schema.String).annotate({ description: "Account for make_uri." }),
})

type Params = Schema.Schema.Type<typeof Parameters>
type Action = (typeof ACTIONS)[number]
type Algorithm = (typeof ALGORITHMS)[number]
type OtpType = (typeof TYPES)[number]

type Metadata = {
  action: Action
  code?: string
  counter?: number
  algorithm?: Algorithm
  digits?: number
  period_s?: number
  secret_bits?: number
  valid?: boolean
  matched_counter?: number
  drift_steps?: number
  type?: OtpType
  secret?: string
  issuer?: string
  account?: string
  uri?: string
}

const done = (result: Tool.ExecuteResult<Metadata>) => result

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
const BASE32_LOOKUP: Record<string, number> = (() => {
  const m: Record<string, number> = {}
  for (let i = 0; i < BASE32_ALPHABET.length; i++) m[BASE32_ALPHABET[i]] = i
  return m
})()

export function decodeBase32(secret: string): Buffer {
  const cleaned = secret.replace(/[\s-]/g, "").replace(/=+$/g, "").toUpperCase()
  if (cleaned.length === 0) throw new Error("otp: empty secret")
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const ch of cleaned) {
    const v = BASE32_LOOKUP[ch]
    if (v === undefined) throw new Error(`otp: invalid base32 character '${ch}'`)
    value = (value << 5) | v
    bits += 5
    if (bits >= 8) {
      bits -= 8
      out.push((value >>> bits) & 0xff)
    }
  }
  return Buffer.from(out)
}

export function encodeBase32(buf: Buffer): string {
  let bits = 0
  let value = 0
  let out = ""
  for (const b of buf) {
    value = (value << 8) | b
    bits += 8
    while (bits >= 5) {
      bits -= 5
      out += BASE32_ALPHABET[(value >>> bits) & 0x1f]
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 0x1f]
  return out
}

function counterToBuffer(counter: number): Buffer {
  // HOTP counter is 8 bytes big-endian. Use BigInt to be safe past 2^32.
  const buf = Buffer.alloc(8)
  buf.writeBigUInt64BE(BigInt(counter))
  return buf
}

const HASH_FOR_ALG: Record<Algorithm, string> = {
  SHA1: "sha1",
  SHA256: "sha256",
  SHA512: "sha512",
}

export function hotp(opts: {
  secret: Buffer
  counter: number
  algorithm: Algorithm
  digits: number
}): string {
  const { secret, counter, algorithm, digits } = opts
  const mac = createHmac(HASH_FOR_ALG[algorithm], secret).update(counterToBuffer(counter)).digest()
  const offset = mac[mac.length - 1] & 0x0f
  const code =
    ((mac[offset] & 0x7f) << 24) |
    ((mac[offset + 1] & 0xff) << 16) |
    ((mac[offset + 2] & 0xff) << 8) |
    (mac[offset + 3] & 0xff)
  const mod = Math.pow(10, digits)
  return (code % mod).toString().padStart(digits, "0")
}

export function totpCounter(unixSeconds: number, periodSeconds: number): number {
  return Math.floor(unixSeconds / periodSeconds)
}

function timingSafeStringEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  return timingSafeEqual(new Uint8Array(ab), new Uint8Array(bb))
}

function parseIntegerParam(
  params: URLSearchParams,
  key: string,
  opts: { defaultValue?: number; min?: number; max?: number },
): number | undefined {
  const raw = params.get(key)
  if (raw === null) return opts.defaultValue
  if (!/^\d+$/.test(raw)) throw new Error(`otp.parse_uri: ${key} must be an integer`)
  const value = Number(raw)
  if (!Number.isSafeInteger(value)) throw new Error(`otp.parse_uri: ${key} is too large`)
  if (opts.min !== undefined && value < opts.min) throw new Error(`otp.parse_uri: ${key} must be >= ${opts.min}`)
  if (opts.max !== undefined && value > opts.max) throw new Error(`otp.parse_uri: ${key} must be <= ${opts.max}`)
  return value
}

export function parseOtpAuth(uri: string): {
  type: OtpType
  account: string
  issuer?: string
  secret: string
  algorithm: Algorithm
  digits: number
  period_s?: number
  counter?: number
} {
  if (!uri.startsWith("otpauth://")) throw new Error("otp.parse_uri: must start with otpauth://")
  // Manual parse: URL doesn't always handle the path label well.
  const stripped = uri.slice("otpauth://".length)
  const slashIdx = stripped.indexOf("/")
  if (slashIdx < 0) throw new Error("otp.parse_uri: missing type")
  const typeRaw = stripped.slice(0, slashIdx).toLowerCase()
  if (!TYPES.includes(typeRaw as OtpType)) {
    throw new Error(`otp.parse_uri: unsupported type ${typeRaw}`)
  }
  const type = typeRaw as OtpType
  const after = stripped.slice(slashIdx + 1)
  const qIdx = after.indexOf("?")
  const labelEnc = qIdx < 0 ? after : after.slice(0, qIdx)
  const label = decodeURIComponent(labelEnc)
  const queryStr = qIdx < 0 ? "" : after.slice(qIdx + 1)
  const params = new URLSearchParams(queryStr)
  let issuerFromLabel: string | undefined
  let account = label
  const colon = label.indexOf(":")
  if (colon > 0) {
    issuerFromLabel = label.slice(0, colon).trim()
    account = label.slice(colon + 1).trim()
  }
  const issuer = issuerFromLabel ?? params.get("issuer") ?? undefined
  const secret = params.get("secret")
  if (!secret) throw new Error("otp.parse_uri: missing secret")
  const algorithm = ((params.get("algorithm") ?? "SHA1").toUpperCase() as Algorithm) || "SHA1"
  if (!ALGORITHMS.includes(algorithm)) throw new Error(`otp.parse_uri: unsupported algorithm ${algorithm}`)
  const digits = parseIntegerParam(params, "digits", { defaultValue: 6, min: 6, max: 10 })!
  const period_s =
    type === "totp"
      ? parseIntegerParam(params, "period", { defaultValue: 30, min: 1, max: 3600 })
      : params.has("period")
        ? parseIntegerParam(params, "period", { min: 1, max: 3600 })
        : undefined
  const counter =
    type === "hotp"
      ? parseIntegerParam(params, "counter", { defaultValue: 0, min: 0, max: Number.MAX_SAFE_INTEGER })
      : params.has("counter")
        ? parseIntegerParam(params, "counter", { min: 0, max: Number.MAX_SAFE_INTEGER })
        : undefined
  return { type, account, issuer, secret, algorithm, digits, period_s, counter }
}

export function makeOtpAuthUri(opts: {
  type?: OtpType
  account: string
  secret: string
  issuer?: string
  algorithm?: Algorithm
  digits?: number
  period_s?: number
  counter?: number
}): string {
  const type = opts.type ?? "totp"
  const account = opts.account
  const issuer = opts.issuer
  const labelRaw = issuer ? `${issuer}:${account}` : account
  const label = encodeURIComponent(labelRaw)
  const params = new URLSearchParams()
  // Strip whitespace/dashes from secret, base32 expects clean input.
  params.set("secret", opts.secret.replace(/[\s-]/g, "").toUpperCase())
  if (issuer) params.set("issuer", issuer)
  if (opts.algorithm && opts.algorithm !== "SHA1") params.set("algorithm", opts.algorithm)
  if (opts.digits && opts.digits !== 6) params.set("digits", String(opts.digits))
  if (type === "totp" && opts.period_s && opts.period_s !== 30) {
    params.set("period", String(opts.period_s))
  }
  if (type === "hotp") {
    params.set("counter", String(opts.counter ?? 0))
  }
  return `otpauth://${type}/${label}?${params.toString()}`
}

export const OtpTool = Tool.define(
  "otp",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Params, _ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const action = params.action
          const algorithm: Algorithm = params.algorithm ?? "SHA1"
          const digits = params.digits ?? 6
          const period_s = params.period_s ?? 30

          if (action === "totp") {
            if (!params.secret) throw new Error("otp.totp: requires `secret`")
            const secretBuf = decodeBase32(params.secret)
            const t = params.at_unix_s ?? Math.floor(Date.now() / 1000)
            const ctr = totpCounter(t, period_s)
            const code = hotp({ secret: secretBuf, counter: ctr, algorithm, digits })
            return done({
              title: `otp.totp ${algorithm} ${digits}d`,
              metadata: {
                action,
                code,
                counter: ctr,
                algorithm,
                digits,
                period_s,
                secret_bits: secretBuf.byteLength * 8,
              },
              output: code,
            })
          }

          if (action === "hotp") {
            if (!params.secret) throw new Error("otp.hotp: requires `secret`")
            if (params.counter === undefined) throw new Error("otp.hotp: requires `counter`")
            const secretBuf = decodeBase32(params.secret)
            const code = hotp({ secret: secretBuf, counter: params.counter, algorithm, digits })
            return done({
              title: `otp.hotp@${params.counter}`,
              metadata: {
                action,
                code,
                counter: params.counter,
                algorithm,
                digits,
                secret_bits: secretBuf.byteLength * 8,
              },
              output: code,
            })
          }

          if (action === "verify_totp") {
            if (!params.secret) throw new Error("otp.verify_totp: requires `secret`")
            if (!params.code) throw new Error("otp.verify_totp: requires `code`")
            const secretBuf = decodeBase32(params.secret)
            const t = params.at_unix_s ?? Math.floor(Date.now() / 1000)
            const baseCtr = totpCounter(t, period_s)
            const win = params.window ?? 1
            for (let drift = -win; drift <= win; drift++) {
              const ctr = baseCtr + drift
              if (ctr < 0) continue
              const expected = hotp({ secret: secretBuf, counter: ctr, algorithm, digits })
              if (timingSafeStringEq(expected, params.code)) {
                return done({
                  title: `otp.verify_totp ok drift=${drift}`,
                  metadata: { action, valid: true, matched_counter: ctr, drift_steps: drift, algorithm, digits, period_s },
                  output: `valid: true (drift=${drift} steps)`,
                })
              }
            }
            return done({
              title: `otp.verify_totp invalid`,
              metadata: { action, valid: false, algorithm, digits, period_s },
              output: "valid: false",
            })
          }

          if (action === "verify_hotp") {
            if (!params.secret) throw new Error("otp.verify_hotp: requires `secret`")
            if (!params.code) throw new Error("otp.verify_hotp: requires `code`")
            if (params.counter === undefined) throw new Error("otp.verify_hotp: requires `counter`")
            const secretBuf = decodeBase32(params.secret)
            const range = params.look_ahead ?? 10
            for (let i = 0; i <= range; i++) {
              const expected = hotp({ secret: secretBuf, counter: params.counter + i, algorithm, digits })
              if (timingSafeStringEq(expected, params.code)) {
                return done({
                  title: `otp.verify_hotp ok counter=${params.counter + i}`,
                  metadata: {
                    action,
                    valid: true,
                    matched_counter: params.counter + i,
                    drift_steps: i,
                    algorithm,
                    digits,
                  },
                  output: `valid: true (counter=${params.counter + i})`,
                })
              }
            }
            return done({
              title: `otp.verify_hotp invalid`,
              metadata: { action, valid: false, algorithm, digits },
              output: "valid: false",
            })
          }

          if (action === "parse_uri") {
            if (!params.uri) throw new Error("otp.parse_uri: requires `uri`")
            const parsed = parseOtpAuth(params.uri)
            return done({
              title: `otp.parse_uri ${parsed.type}`,
              metadata: { action, ...parsed },
              output: JSON.stringify(parsed, null, 2),
            })
          }

          if (action === "make_uri") {
            if (!params.secret) throw new Error("otp.make_uri: requires `secret`")
            if (!params.account) throw new Error("otp.make_uri: requires `account`")
            const type = params.type ?? "totp"
            if (type === "hotp" && params.counter === undefined) throw new Error("otp.make_uri hotp: requires `counter`")
            const uri = makeOtpAuthUri({
              type,
              account: params.account,
              secret: params.secret,
              issuer: params.issuer,
              algorithm,
              digits,
              period_s,
              counter: params.counter,
            })
            return done({
              title: `otp.make_uri ${type}`,
              metadata: {
                action,
                uri,
                type,
                account: params.account,
                issuer: params.issuer,
                algorithm,
                digits,
                period_s: type === "totp" ? period_s : undefined,
                counter: type === "hotp" ? params.counter : undefined,
              },
              output: uri,
            })
          }

          throw new Error(`otp: unknown action ${action satisfies never}`)
        }),
    }
  }),
)

export const __testing = {
  decodeBase32,
  encodeBase32,
  counterToBuffer,
  hotp,
  totpCounter,
  parseOtpAuth,
  makeOtpAuthUri,
}
