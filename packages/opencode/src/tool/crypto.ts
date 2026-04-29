import { Effect, Schema } from "effect"
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto"
import DESCRIPTION from "./crypto.txt"
import * as Tool from "./tool"

const ACTIONS = ["hmac", "encrypt", "decrypt", "gen_key", "equal"] as const
const HMAC_ALGOS = ["sha256", "sha512", "sha1", "sha384", "md5"] as const
const CIPHERS = ["aes-256-gcm", "aes-128-gcm", "aes-256-cbc", "aes-128-cbc"] as const
const VALUE_ENCODINGS = ["utf8", "hex", "base64", "base64url"] as const
const KEY_ENCODINGS = ["utf8", "hex", "base64", "base64url"] as const
const IV_ENCODINGS = ["hex", "base64", "base64url"] as const
const TAG_ENCODINGS = ["hex", "base64", "base64url"] as const
const OUTPUT_ENCODINGS = ["hex", "base64", "base64url", "utf8"] as const

const MAX_VALUE_BYTES = 64 * 1024 * 1024 // 64 MiB
const MAX_KEY_LENGTH = 4096

export const Parameters = Schema.Struct({
  action: Schema.Literals(ACTIONS).annotate({
    description: "hmac | encrypt | decrypt | gen_key | equal",
  }),
  value: Schema.optional(Schema.String).annotate({
    description: "Plaintext for hmac/encrypt, ciphertext for decrypt, left side for equal.",
  }),
  value2: Schema.optional(Schema.String).annotate({
    description: "Right side for equal.",
  }),
  value_encoding: Schema.optional(Schema.Literals(VALUE_ENCODINGS)).annotate({
    description: "How to interpret value/value2. Default utf8.",
  }),
  output_encoding: Schema.optional(Schema.Literals(OUTPUT_ENCODINGS)).annotate({
    description: "Output encoding. Default hex. utf8 only valid for decrypt result.",
  }),
  key: Schema.optional(Schema.String).annotate({
    description: "HMAC secret or AES key, in key_encoding.",
  }),
  key_encoding: Schema.optional(Schema.Literals(KEY_ENCODINGS)).annotate({
    description: "Encoding of `key`. Default utf8.",
  }),
  hmac_algo: Schema.optional(Schema.Literals(HMAC_ALGOS)).annotate({
    description: "HMAC algorithm. Default sha256.",
  }),
  cipher: Schema.optional(Schema.Literals(CIPHERS)).annotate({
    description: "AES cipher. Default aes-256-gcm.",
  }),
  iv: Schema.optional(Schema.String).annotate({
    description: "IV/nonce for AES (12B GCM, 16B CBC). If omitted on encrypt, generated randomly.",
  }),
  iv_encoding: Schema.optional(Schema.Literals(IV_ENCODINGS)).annotate({
    description: "Encoding of `iv`. Default hex.",
  }),
  tag: Schema.optional(Schema.String).annotate({
    description: "GCM auth tag (required to decrypt aes-*-gcm).",
  }),
  tag_encoding: Schema.optional(Schema.Literals(TAG_ENCODINGS)).annotate({
    description: "Encoding of `tag`. Default hex.",
  }),
  aad: Schema.optional(Schema.String).annotate({
    description: "Optional GCM associated data. Uses value_encoding.",
  }),
  length: Schema.optional(
    Schema.Number.check(Schema.isInt())
      .check(Schema.isGreaterThanOrEqualTo(1))
      .check(Schema.isLessThanOrEqualTo(MAX_KEY_LENGTH)),
  ).annotate({
    description: `Bytes for gen_key when cipher omitted. Default 32. Max ${MAX_KEY_LENGTH}.`,
  }),
  expected: Schema.optional(Schema.String).annotate({
    description: "Expected HMAC digest (hex/base64/base64url, auto-detected). Triggers timing-safe compare.",
  }),
})

type Params = Schema.Schema.Type<typeof Parameters>
type Action = (typeof ACTIONS)[number]
type HmacAlgo = (typeof HMAC_ALGOS)[number]
type Cipher = (typeof CIPHERS)[number]
type ValueEncoding = (typeof VALUE_ENCODINGS)[number]
type KeyEncoding = (typeof KEY_ENCODINGS)[number]
type IvEncoding = (typeof IV_ENCODINGS)[number]
type TagEncoding = (typeof TAG_ENCODINGS)[number]
type OutputEncoding = (typeof OUTPUT_ENCODINGS)[number]

type Metadata = {
  action: Action
  algorithm?: HmacAlgo | Cipher
  digest?: string
  ciphertext?: string
  iv?: string
  tag?: string
  key?: string
  plaintext?: string
  matches?: boolean
  bytes?: number
}

const KEY_SIZE: Record<Cipher, number> = {
  "aes-256-gcm": 32,
  "aes-128-gcm": 16,
  "aes-256-cbc": 32,
  "aes-128-cbc": 16,
}
const IV_SIZE: Record<Cipher, number> = {
  "aes-256-gcm": 12,
  "aes-128-gcm": 12,
  "aes-256-cbc": 16,
  "aes-128-cbc": 16,
}
const isGcm = (c: Cipher) => c.endsWith("gcm")

function decodeValue(value: string, enc: ValueEncoding): Buffer {
  if (enc === "utf8") return Buffer.from(value, "utf8")
  if (enc === "hex") return Buffer.from(value.replace(/[^0-9a-fA-F]/g, ""), "hex")
  if (enc === "base64") return Buffer.from(value, "base64")
  if (enc === "base64url") return Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64")
  throw new Error(`crypto: unknown value_encoding '${enc}'`)
}

function decodeKey(key: string, enc: KeyEncoding): Buffer {
  return decodeValue(key, enc)
}

function decodeIv(iv: string, enc: IvEncoding): Buffer {
  return decodeValue(iv, enc as ValueEncoding)
}

function decodeTag(tag: string, enc: TagEncoding): Buffer {
  return decodeValue(tag, enc as ValueEncoding)
}

function encodeOutput(buf: Buffer, enc: OutputEncoding): string {
  if (enc === "utf8") return buf.toString("utf8")
  if (enc === "hex") return buf.toString("hex")
  if (enc === "base64") return buf.toString("base64")
  if (enc === "base64url") {
    return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "")
  }
  throw new Error(`crypto: unknown output_encoding '${enc}'`)
}

function detectAndDecodeDigest(s: string): Buffer {
  const trimmed = s.trim()
  // hex if it's only hex chars and even length
  if (/^[0-9a-fA-F]+$/.test(trimmed) && trimmed.length % 2 === 0) {
    return Buffer.from(trimmed, "hex")
  }
  // base64url
  if (/^[A-Za-z0-9_-]+$/.test(trimmed)) {
    return Buffer.from(trimmed.replace(/-/g, "+").replace(/_/g, "/"), "base64")
  }
  // assume base64
  return Buffer.from(trimmed, "base64")
}

export function timingSafeStringEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8")
  const bufB = Buffer.from(b, "utf8")
  if (bufA.length !== bufB.length) {
    // Still call timingSafeEqual on equal-length buffers to avoid early return.
    const max = Math.max(bufA.length, bufB.length)
    const padA = Buffer.alloc(max)
    const padB = Buffer.alloc(max)
    bufA.copy(padA)
    bufB.copy(padB)
    timingSafeEqual(padA, padB)
    return false
  }
  return timingSafeEqual(bufA, bufB)
}

const done = (result: Tool.ExecuteResult<Metadata>) => result

export const CryptoTool = Tool.define(
  "crypto",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Params, _ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const action = params.action
          const valueEnc: ValueEncoding = params.value_encoding ?? "utf8"
          const keyEnc: KeyEncoding = params.key_encoding ?? "utf8"
          const ivEnc: IvEncoding = params.iv_encoding ?? "hex"
          const tagEnc: TagEncoding = params.tag_encoding ?? "hex"

          if (action === "hmac") {
            if (params.value === undefined) throw new Error("crypto.hmac: requires `value`")
            if (params.key === undefined) throw new Error("crypto.hmac: requires `key`")
            const valueBuf = decodeValue(params.value, valueEnc)
            if (valueBuf.byteLength > MAX_VALUE_BYTES) {
              throw new Error(`crypto.hmac: value exceeds ${MAX_VALUE_BYTES} bytes`)
            }
            const algo: HmacAlgo = params.hmac_algo ?? "sha256"
            const keyBuf = decodeKey(params.key, keyEnc)
            const digest = createHmac(algo, keyBuf).update(valueBuf).digest()
            const out: OutputEncoding = params.output_encoding ?? "hex"
            const result = encodeOutput(digest, out)
            let matches: boolean | undefined
            if (params.expected !== undefined) {
              const expected = detectAndDecodeDigest(params.expected)
              if (expected.length === digest.length) {
                matches = timingSafeEqual(expected, digest)
              } else {
                // Constant-time fallback
                const max = Math.max(expected.length, digest.length)
                const padA = Buffer.alloc(max)
                const padB = Buffer.alloc(max)
                expected.copy(padA)
                digest.copy(padB)
                timingSafeEqual(padA, padB)
                matches = false
              }
            }
            const verified = matches === true ? " ✓" : matches === false ? " ✗" : ""
            return done({
              title: `crypto.hmac.${algo}: ${result.slice(0, 16)}…${verified}`,
              metadata: { action, algorithm: algo, digest: result, matches, bytes: digest.byteLength },
              output: result,
            })
          }

          if (action === "equal") {
            if (params.value === undefined || params.value2 === undefined) {
              throw new Error("crypto.equal: requires `value` and `value2`")
            }
            const a = decodeValue(params.value, valueEnc)
            const b = decodeValue(params.value2, valueEnc)
            let matches: boolean
            if (a.length === b.length) {
              matches = timingSafeEqual(a, b)
            } else {
              const max = Math.max(a.length, b.length)
              const padA = Buffer.alloc(max)
              const padB = Buffer.alloc(max)
              a.copy(padA)
              b.copy(padB)
              timingSafeEqual(padA, padB)
              matches = false
            }
            return done({
              title: `crypto.equal: ${matches ? "match" : "differ"}`,
              metadata: { action, matches },
              output: String(matches),
            })
          }

          if (action === "gen_key") {
            const cipher = params.cipher
            const length = cipher ? KEY_SIZE[cipher] : (params.length ?? 32)
            const buf = randomBytes(length)
            const out: OutputEncoding = params.output_encoding ?? "hex"
            if (out === "utf8") throw new Error("crypto.gen_key: utf8 output is not safe for random keys; use hex/base64/base64url")
            const key = encodeOutput(buf, out)
            return done({
              title: `crypto.gen_key: ${length}B${cipher ? ` for ${cipher}` : ""}`,
              metadata: { action, key, bytes: length, algorithm: cipher },
              output: key,
            })
          }

          if (action === "encrypt") {
            if (params.value === undefined) throw new Error("crypto.encrypt: requires `value`")
            if (params.key === undefined) throw new Error("crypto.encrypt: requires `key`")
            const cipher: Cipher = params.cipher ?? "aes-256-gcm"
            const keyBuf = decodeKey(params.key, keyEnc)
            if (keyBuf.byteLength !== KEY_SIZE[cipher]) {
              throw new Error(
                `crypto.encrypt: ${cipher} requires a ${KEY_SIZE[cipher]}-byte key, got ${keyBuf.byteLength}`,
              )
            }
            let ivBuf: Buffer
            if (params.iv) {
              ivBuf = decodeIv(params.iv, ivEnc)
              if (ivBuf.byteLength !== IV_SIZE[cipher]) {
                throw new Error(
                  `crypto.encrypt: ${cipher} requires a ${IV_SIZE[cipher]}-byte iv, got ${ivBuf.byteLength}`,
                )
              }
            } else {
              ivBuf = randomBytes(IV_SIZE[cipher])
            }
            const plain = decodeValue(params.value, valueEnc)
            const c = createCipheriv(cipher, keyBuf, ivBuf)
            if (isGcm(cipher) && params.aad) {
              ;(c as any).setAAD(decodeValue(params.aad, valueEnc))
            }
            const ct = Buffer.concat([c.update(plain), c.final()])
            const out: OutputEncoding = params.output_encoding ?? "base64"
            if (out === "utf8") throw new Error("crypto.encrypt: utf8 output not valid for ciphertext; use hex/base64/base64url")
            const ciphertext = encodeOutput(ct, out)
            const ivStr = encodeOutput(ivBuf, ivEnc as OutputEncoding)
            const tag = isGcm(cipher) ? (c as any).getAuthTag() as Buffer : undefined
            const tagStr = tag ? encodeOutput(tag, tagEnc as OutputEncoding) : undefined
            return done({
              title: `crypto.encrypt.${cipher}: ${ct.byteLength}B`,
              metadata: {
                action,
                algorithm: cipher,
                ciphertext,
                iv: ivStr,
                tag: tagStr,
                bytes: ct.byteLength,
              },
              output: [
                `cipher:     ${cipher}`,
                `ciphertext: ${ciphertext}`,
                `iv:         ${ivStr}`,
                tagStr ? `tag:        ${tagStr}` : undefined,
              ]
                .filter(Boolean)
                .join("\n"),
            })
          }

          if (action === "decrypt") {
            if (params.value === undefined) throw new Error("crypto.decrypt: requires `value` (ciphertext)")
            if (params.key === undefined) throw new Error("crypto.decrypt: requires `key`")
            if (params.iv === undefined) throw new Error("crypto.decrypt: requires `iv`")
            const cipher: Cipher = params.cipher ?? "aes-256-gcm"
            const keyBuf = decodeKey(params.key, keyEnc)
            if (keyBuf.byteLength !== KEY_SIZE[cipher]) {
              throw new Error(
                `crypto.decrypt: ${cipher} requires a ${KEY_SIZE[cipher]}-byte key, got ${keyBuf.byteLength}`,
              )
            }
            const ivBuf = decodeIv(params.iv, ivEnc)
            if (ivBuf.byteLength !== IV_SIZE[cipher]) {
              throw new Error(
                `crypto.decrypt: ${cipher} requires a ${IV_SIZE[cipher]}-byte iv, got ${ivBuf.byteLength}`,
              )
            }
            // ciphertext is in value_encoding (default utf8 makes no sense for ciphertext, but we accept the override)
            const ctEnc: ValueEncoding = params.value_encoding ?? "base64"
            const ct = decodeValue(params.value, ctEnc)
            const d = createDecipheriv(cipher, keyBuf, ivBuf)
            if (isGcm(cipher)) {
              if (params.tag === undefined) throw new Error("crypto.decrypt: GCM cipher requires `tag`")
              ;(d as any).setAuthTag(decodeTag(params.tag, tagEnc))
              if (params.aad) (d as any).setAAD(decodeValue(params.aad, valueEnc))
            }
            const plain = Buffer.concat([d.update(ct), d.final()])
            const out: OutputEncoding = params.output_encoding ?? "utf8"
            const plaintext = encodeOutput(plain, out)
            return done({
              title: `crypto.decrypt.${cipher}: ${plain.byteLength}B`,
              metadata: { action, algorithm: cipher, plaintext, bytes: plain.byteLength },
              output: plaintext,
            })
          }

          throw new Error(`crypto: unknown action '${action}'`)
        }),
    }
  }),
)

export const __testing = {
  decodeValue,
  encodeOutput,
  detectAndDecodeDigest,
  timingSafeStringEqual,
  KEY_SIZE,
  IV_SIZE,
}
