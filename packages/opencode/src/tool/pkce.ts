import { Effect, Schema } from "effect"
import { createHash, randomBytes } from "node:crypto"
import DESCRIPTION from "./pkce.txt"
import * as Tool from "./tool"

const ACTIONS = ["generate", "challenge", "verify", "info"] as const
const METHODS = ["S256", "plain"] as const

const MIN_VERIFIER_LEN = 43
const MAX_VERIFIER_LEN = 128
const MAX_STATE_LEN = 256
const MAX_NONCE_LEN = 256

export const Parameters = Schema.Struct({
  action: Schema.Literals(ACTIONS).annotate({ description: ACTIONS.join(" | ") }),
  method: Schema.optional(Schema.Literals(METHODS)).annotate({
    description: "PKCE method. 'S256' (default, recommended) or 'plain' (legacy).",
  }),
  length: Schema.optional(
    Schema.Number.check(
      Schema.isInt(),
      Schema.isGreaterThanOrEqualTo(MIN_VERIFIER_LEN),
      Schema.isLessThanOrEqualTo(MAX_VERIFIER_LEN),
    ),
  ).annotate({
    description: `Verifier length, ${MIN_VERIFIER_LEN}..${MAX_VERIFIER_LEN}. Default 64.`,
  }),
  state_length: Schema.optional(
    Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(8), Schema.isLessThanOrEqualTo(MAX_STATE_LEN)),
  ).annotate({
    description: "State length in random bytes (before BASE64URL). Default 16.",
  }),
  nonce: Schema.optional(
    Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(8), Schema.isLessThanOrEqualTo(MAX_NONCE_LEN)),
  ).annotate({
    description: "When set, also generate an OIDC nonce of the given byte length (before BASE64URL).",
  }),
  code_verifier: Schema.optional(Schema.String.check(Schema.isMaxLength(MAX_VERIFIER_LEN))).annotate({
    description: "Explicit verifier for challenge / verify. Must be 43..128 unreserved chars.",
  }),
  code_challenge: Schema.optional(Schema.String.check(Schema.isMaxLength(256))).annotate({
    description: "Stored challenge for verify action.",
  }),
})

type Params = Schema.Schema.Type<typeof Parameters>
type Action = (typeof ACTIONS)[number]
type Method = (typeof METHODS)[number]

type Metadata = {
  action: Action
  method?: Method
  code_verifier?: string
  code_challenge?: string
  code_challenge_method?: Method
  state?: string
  nonce?: string
  length?: number
  match?: boolean
  reason?: string
  entropy_bits?: number
}

const done = (result: Tool.ExecuteResult<Metadata>) => result

// ---------- helpers ----------

// RFC 7636 Section 4.1 verifier alphabet: A-Z, a-z, 0-9, '-', '.', '_', '~'.
const VERIFIER_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~"
const VERIFIER_RE = /^[A-Za-z0-9\-._~]+$/

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function randomVerifier(length: number): string {
  if (length < MIN_VERIFIER_LEN || length > MAX_VERIFIER_LEN)
    throw new Error(`pkce: verifier length must be ${MIN_VERIFIER_LEN}..${MAX_VERIFIER_LEN}`)
  // Rejection sample over a 256-entry table whose size is the largest
  // multiple of |alphabet| <= 256, to avoid modulo bias.
  const alphabet = VERIFIER_ALPHABET
  const usable = 256 - (256 % alphabet.length)
  let out = ""
  while (out.length < length) {
    const buf = randomBytes(length * 2)
    for (let i = 0; i < buf.length && out.length < length; i++) {
      const v = buf[i]!
      if (v < usable) out += alphabet[v % alphabet.length]
    }
  }
  return out
}

function deriveChallenge(verifier: string, method: Method): string {
  if (!VERIFIER_RE.test(verifier))
    throw new Error("pkce: code_verifier contains characters outside the RFC 7636 alphabet (A-Z a-z 0-9 - . _ ~)")
  if (verifier.length < MIN_VERIFIER_LEN || verifier.length > MAX_VERIFIER_LEN)
    throw new Error(`pkce: code_verifier length must be ${MIN_VERIFIER_LEN}..${MAX_VERIFIER_LEN}`)
  if (method === "plain") return verifier
  return base64url(createHash("sha256").update(verifier).digest())
}

function constantTimeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let r = 0
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return r === 0
}

function entropyBitsOfVerifier(length: number): number {
  // ~6 bits per character with the 66-symbol alphabet.
  return Math.floor(length * Math.log2(VERIFIER_ALPHABET.length))
}

// ---------- tool ----------

export const PkceTool = Tool.define(
  "pkce",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Params, _ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const action = params.action
          const method: Method = params.method ?? "S256"

          if (action === "generate") {
            const len = params.length ?? 64
            const verifier = randomVerifier(len)
            const challenge = deriveChallenge(verifier, method)
            const state = base64url(randomBytes(params.state_length ?? 16))
            const nonce = params.nonce ? base64url(randomBytes(params.nonce)) : undefined
            const entropy = entropyBitsOfVerifier(verifier.length)
            const lines = [
              `code_verifier:         ${verifier}`,
              `code_challenge:        ${challenge}`,
              `code_challenge_method: ${method}`,
              `state:                 ${state}`,
              ...(nonce ? [`nonce:                 ${nonce}`] : []),
              `entropy_bits:          ~${entropy}`,
            ]
            return done({
              title: `pkce.generate ${method} (${len} chars, ~${entropy} bits)`,
              metadata: {
                action,
                method,
                code_verifier: verifier,
                code_challenge: challenge,
                code_challenge_method: method,
                state,
                nonce,
                length: verifier.length,
                entropy_bits: entropy,
              },
              output: lines.join("\n"),
            })
          }

          if (action === "challenge") {
            if (!params.code_verifier) throw new Error("pkce: challenge requires 'code_verifier'")
            const challenge = deriveChallenge(params.code_verifier, method)
            return done({
              title: `pkce.challenge ${method}`,
              metadata: {
                action,
                method,
                code_verifier: params.code_verifier,
                code_challenge: challenge,
                code_challenge_method: method,
                length: params.code_verifier.length,
                entropy_bits: entropyBitsOfVerifier(params.code_verifier.length),
              },
              output: challenge,
            })
          }

          if (action === "verify") {
            if (!params.code_verifier) throw new Error("pkce: verify requires 'code_verifier'")
            if (!params.code_challenge) throw new Error("pkce: verify requires 'code_challenge'")
            let derived: string
            try {
              derived = deriveChallenge(params.code_verifier, method)
            } catch (err: any) {
              return done({
                title: `pkce.verify ${method}: invalid verifier`,
                metadata: {
                  action,
                  method,
                  match: false,
                  reason: err?.message ?? "invalid verifier",
                },
                output: `false (${err?.message ?? "invalid verifier"})`,
              })
            }
            const match = constantTimeEq(derived, params.code_challenge)
            return done({
              title: `pkce.verify ${method}: ${match}`,
              metadata: {
                action,
                method,
                match,
                code_verifier: params.code_verifier,
                code_challenge: params.code_challenge,
                code_challenge_method: method,
                reason: match ? "challenge matches derived value" : "challenge does not match",
              },
              output: String(match),
            })
          }

          if (action === "info") {
            const verifier = params.code_verifier
            if (!verifier) throw new Error("pkce: info requires 'code_verifier'")
            const lines = [
              `verifier_length:    ${verifier.length}`,
              `alphabet_ok:        ${VERIFIER_RE.test(verifier)}`,
              `length_ok:          ${verifier.length >= MIN_VERIFIER_LEN && verifier.length <= MAX_VERIFIER_LEN}`,
              `entropy_bits:       ~${entropyBitsOfVerifier(verifier.length)}`,
              `method:             ${method}`,
              `derived_challenge:  ${deriveChallenge(verifier, method)}`,
            ]
            return done({
              title: `pkce.info ${method}`,
              metadata: {
                action,
                method,
                code_verifier: verifier,
                length: verifier.length,
                entropy_bits: entropyBitsOfVerifier(verifier.length),
              },
              output: lines.join("\n"),
            })
          }

          throw new Error(`pkce: unknown action ${action satisfies never}`)
        }),
    }
  }),
)

export const __testing = {
  base64url,
  randomVerifier,
  deriveChallenge,
  constantTimeEq,
  entropyBitsOfVerifier,
  VERIFIER_ALPHABET,
  VERIFIER_RE,
}
