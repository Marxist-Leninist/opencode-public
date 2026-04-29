import { Effect, Schema } from "effect"
import DESCRIPTION from "./encode.txt"
import * as Tool from "./tool"

const ACTIONS = ["encode", "decode"] as const
const FORMATS = ["base64", "base64url", "base32", "base32hex", "hex", "url", "jwt"] as const
const INPUT_ENCODINGS = ["utf8", "hex", "base64"] as const
const OUTPUT_ENCODINGS = ["utf8", "hex", "base64"] as const

const MAX_INPUT_BYTES = 8 * 1024 * 1024 // 8 MiB cap on raw text input — comfortable for tokens, JWTs, and small payloads.

export const Parameters = Schema.Struct({
  action: Schema.Literals(ACTIONS).annotate({
    description: "'encode' to convert bytes to a textual format, or 'decode' to interpret formatted text back to bytes.",
  }),
  format: Schema.Literals(FORMATS).annotate({
    description:
      "'base64' (with padding), 'base64url' (URL-safe, no padding), 'base32' (RFC 4648 with padding — TOTP/AWS), 'base32hex' (RFC 4648 extended-hex), 'hex', 'url' (percent-encoding for URL components), or 'jwt' (decode-only — parses header/payload/signature).",
  }),
  value: Schema.String.check(Schema.isMinLength(1)).annotate({
    description: "The string to encode or decode. Whitespace/newlines around the value are trimmed automatically.",
  }),
  input_encoding: Schema.optional(Schema.Literals(INPUT_ENCODINGS)).annotate({
    description: "For 'encode': how to interpret the input bytes. Default 'utf8'. 'hex' or 'base64' supports round-trips.",
  }),
  output_encoding: Schema.optional(Schema.Literals(OUTPUT_ENCODINGS)).annotate({
    description: "For 'decode': how to render the decoded bytes. Default 'utf8'. Use 'hex' or 'base64' for binary data.",
  }),
})

type Params = Schema.Schema.Type<typeof Parameters>
type Action = (typeof ACTIONS)[number]
type Format = (typeof FORMATS)[number]
type InputEncoding = (typeof INPUT_ENCODINGS)[number]
type OutputEncoding = (typeof OUTPUT_ENCODINGS)[number]

type JwtParts = {
  header: unknown
  payload: unknown
  signature: string
}

type Metadata = {
  action: Action
  format: Format
  input_encoding?: InputEncoding
  output_encoding?: OutputEncoding
  input_bytes: number
  output_bytes: number
  result: string
  jwt?: JwtParts
}

const done = (result: Tool.ExecuteResult<Metadata>) => result

function inputToBuffer(value: string, encoding: InputEncoding): Buffer {
  if (encoding === "utf8") return Buffer.from(value, "utf8")
  if (encoding === "hex") {
    const cleaned = value.replace(/[^0-9a-fA-F]/g, "")
    if (cleaned.length % 2 !== 0) throw new Error("encode: hex input has odd length")
    return Buffer.from(cleaned, "hex")
  }
  if (encoding === "base64") return Buffer.from(value, "base64")
  throw new Error(`encode: unknown input_encoding '${encoding}'`)
}

function bufferToOutput(buf: Buffer, encoding: OutputEncoding): string {
  if (encoding === "utf8") {
    // Buffer.toString('utf8') replaces invalid sequences with U+FFFD silently;
    // surface that as part of the output rather than failing.
    return buf.toString("utf8")
  }
  if (encoding === "hex") return buf.toString("hex")
  if (encoding === "base64") return buf.toString("base64")
  throw new Error(`encode: unknown output_encoding '${encoding}'`)
}

function base64UrlEncode(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "")
}

function base64UrlDecode(value: string): Buffer {
  const trimmed = value.trim().replace(/-/g, "+").replace(/_/g, "/")
  // Restore padding so Buffer accepts it.
  const padded = trimmed + "=".repeat((4 - (trimmed.length % 4)) % 4)
  return Buffer.from(padded, "base64")
}

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567" // RFC 4648 §6
const BASE32HEX_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUV" // RFC 4648 §7

function base32EncodeWith(buf: Buffer, alphabet: string): string {
  const len = buf.length
  if (len === 0) return ""
  let out = ""
  let bits = 0
  let value = 0
  for (let i = 0; i < len; i++) {
    value = (value << 8) | buf[i]!
    bits += 8
    while (bits >= 5) {
      bits -= 5
      out += alphabet[(value >>> bits) & 0x1f]
    }
  }
  if (bits > 0) {
    out += alphabet[(value << (5 - bits)) & 0x1f]
  }
  // Pad to multiple of 8 chars.
  while (out.length % 8 !== 0) out += "="
  return out
}

function base32DecodeWith(value: string, alphabet: string): Buffer {
  // Strip padding and whitespace; uppercase for case-insensitivity.
  const cleaned = value.trim().replace(/=+$/g, "").replace(/\s+/g, "").toUpperCase()
  if (cleaned.length === 0) return Buffer.alloc(0)
  const out: number[] = []
  let bits = 0
  let buffer = 0
  const upperAlphabet = alphabet.toUpperCase()
  for (const ch of cleaned) {
    const idx = upperAlphabet.indexOf(ch)
    if (idx < 0) throw new Error(`encode: invalid base32 character '${ch}'`)
    buffer = (buffer << 5) | idx
    bits += 5
    if (bits >= 8) {
      bits -= 8
      out.push((buffer >>> bits) & 0xff)
    }
  }
  return Buffer.from(out)
}

export function decodeJwt(value: string): JwtParts {
  const trimmed = value.trim()
  const parts = trimmed.split(".")
  if (parts.length !== 3) {
    throw new Error(`encode: jwt expects three '.'-separated segments, got ${parts.length}`)
  }
  const [headerSeg, payloadSeg, signature] = parts as [string, string, string]
  let header: unknown
  let payload: unknown
  try {
    header = JSON.parse(base64UrlDecode(headerSeg).toString("utf8"))
  } catch (err) {
    throw new Error(`encode: jwt header is not valid JSON: ${err instanceof Error ? err.message : String(err)}`)
  }
  try {
    payload = JSON.parse(base64UrlDecode(payloadSeg).toString("utf8"))
  } catch (err) {
    throw new Error(`encode: jwt payload is not valid JSON: ${err instanceof Error ? err.message : String(err)}`)
  }
  return { header, payload, signature }
}

export function encodeFormat(buf: Buffer, format: Format): string {
  if (format === "base64") return buf.toString("base64")
  if (format === "base64url") return base64UrlEncode(buf)
  if (format === "base32") return base32EncodeWith(buf, BASE32_ALPHABET)
  if (format === "base32hex") return base32EncodeWith(buf, BASE32HEX_ALPHABET)
  if (format === "hex") return buf.toString("hex")
  if (format === "url") return encodeURIComponent(buf.toString("utf8"))
  throw new Error(`encode: cannot encode to format '${format}'`)
}

export function decodeFormat(value: string, format: Format): Buffer {
  const trimmed = value.trim()
  if (format === "base64") return Buffer.from(trimmed, "base64")
  if (format === "base64url") return base64UrlDecode(trimmed)
  if (format === "base32") return base32DecodeWith(trimmed, BASE32_ALPHABET)
  if (format === "base32hex") return base32DecodeWith(trimmed, BASE32HEX_ALPHABET)
  if (format === "hex") {
    const cleaned = trimmed.replace(/[^0-9a-fA-F]/g, "")
    if (cleaned.length % 2 !== 0) throw new Error("encode: hex input has odd length")
    return Buffer.from(cleaned, "hex")
  }
  if (format === "url") return Buffer.from(decodeURIComponent(trimmed), "utf8")
  throw new Error(`encode: cannot decode format '${format}' (use action='decode' with format='jwt' for JWTs)`)
}

export const EncodeTool = Tool.define(
  "encode",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Params, _ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const value = params.value
          if (Buffer.byteLength(value, "utf8") > MAX_INPUT_BYTES) {
            throw new Error(`encode: input larger than ${MAX_INPUT_BYTES} bytes`)
          }
          const action = params.action
          const format = params.format

          if (format === "jwt") {
            if (action !== "decode") throw new Error("encode: format 'jwt' only supports action='decode'")
            const jwt = decodeJwt(value)
            const result = JSON.stringify({ header: jwt.header, payload: jwt.payload, signature: jwt.signature }, null, 2)
            const meta: Metadata = {
              action,
              format,
              input_bytes: Buffer.byteLength(value, "utf8"),
              output_bytes: Buffer.byteLength(result, "utf8"),
              result,
              jwt,
            }
            return done({
              title: "jwt: decoded",
              metadata: meta,
              output: [
                "Decoded JWT (signature NOT verified):",
                "Header:",
                JSON.stringify(jwt.header, null, 2),
                "Payload:",
                JSON.stringify(jwt.payload, null, 2),
                `Signature (base64url): ${jwt.signature}`,
              ].join("\n"),
            })
          }

          if (action === "encode") {
            const inputEncoding: InputEncoding = params.input_encoding ?? "utf8"
            const buf = inputToBuffer(value, inputEncoding)
            const out = encodeFormat(buf, format)
            const meta: Metadata = {
              action,
              format,
              input_encoding: inputEncoding,
              input_bytes: buf.byteLength,
              output_bytes: Buffer.byteLength(out, "utf8"),
              result: out,
            }
            return done({
              title: `encode ${format}: ${out.slice(0, 32)}${out.length > 32 ? "…" : ""}`,
              metadata: meta,
              output: out,
            })
          }

          // action === "decode"
          const outputEncoding: OutputEncoding = params.output_encoding ?? "utf8"
          const buf = decodeFormat(value, format)
          const out = bufferToOutput(buf, outputEncoding)
          const meta: Metadata = {
            action,
            format,
            output_encoding: outputEncoding,
            input_bytes: Buffer.byteLength(value, "utf8"),
            output_bytes: buf.byteLength,
            result: out,
          }
          return done({
            title: `decode ${format}: ${buf.byteLength} bytes`,
            metadata: meta,
            output: out,
          })
        }),
    }
  }),
)

export const __testing = {
  decodeJwt,
  encodeFormat,
  decodeFormat,
  base64UrlEncode,
  base64UrlDecode,
  base32EncodeWith,
  base32DecodeWith,
  BASE32_ALPHABET,
  BASE32HEX_ALPHABET,
}
