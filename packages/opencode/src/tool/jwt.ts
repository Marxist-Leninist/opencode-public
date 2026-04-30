import { Effect, Schema } from "effect"
import {
  createHmac,
  createPrivateKey,
  createPublicKey,
  createSign,
  createVerify,
  sign as signOneShot,
  verify as verifyOneShot,
  timingSafeEqual,
  type KeyObject,
} from "node:crypto"
import DESCRIPTION from "./jwt.txt"
import * as Tool from "./tool"

const ACTIONS = ["decode", "verify", "sign"] as const
const ALGORITHMS = [
  "HS256",
  "HS384",
  "HS512",
  "RS256",
  "RS384",
  "RS512",
  "PS256",
  "PS384",
  "PS512",
  "ES256",
  "ES384",
  "ES512",
  "EdDSA",
  "none",
] as const
const SECRET_ENCODINGS = ["utf8", "hex", "base64", "base64url"] as const

export const Parameters = Schema.Struct({
  action: Schema.Literals(ACTIONS).annotate({ description: ACTIONS.join(" | ") }),
  token: Schema.optional(Schema.String).annotate({ description: "JWT (decode/verify)." }),
  algorithm: Schema.optional(Schema.Literals(ALGORITHMS)).annotate({ description: "JWT alg." }),
  secret: Schema.optional(Schema.String).annotate({ description: "HMAC secret (sign/verify HS*)." }),
  secret_encoding: Schema.optional(Schema.Literals(SECRET_ENCODINGS)).annotate({
    description: "Encoding of `secret`. Default utf8.",
  }),
  public_key: Schema.optional(Schema.String).annotate({ description: "PEM public key (verify)." }),
  private_key: Schema.optional(Schema.String).annotate({ description: "PEM private key (sign)." }),
  key_passphrase: Schema.optional(Schema.String).annotate({
    description: "Optional passphrase for encrypted private key.",
  }),
  payload: Schema.optional(Schema.Unknown).annotate({ description: "Claim set object (sign)." }),
  header: Schema.optional(Schema.Unknown).annotate({ description: "Header overrides (sign)." }),
  expires_in_s: Schema.optional(
    Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  ).annotate({ description: "Adds exp = iat + N." }),
  not_before_s: Schema.optional(Schema.Number.check(Schema.isInt())).annotate({
    description: "Adds nbf = iat + N (negative backdates).",
  }),
  issuer: Schema.optional(Schema.String).annotate({ description: "Convenience iss claim." }),
  audience: Schema.optional(Schema.String).annotate({ description: "Convenience aud claim." }),
  subject: Schema.optional(Schema.String).annotate({ description: "Convenience sub claim." }),
  clock_tolerance_s: Schema.optional(
    Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  ).annotate({ description: "Leeway for exp/nbf. Default 0." }),
  verify_claims: Schema.optional(
    Schema.Struct({
      iss: Schema.optional(Schema.String),
      aud: Schema.optional(Schema.String),
      sub: Schema.optional(Schema.String),
    }),
  ).annotate({ description: "Required claim values." }),
})

type Params = Schema.Schema.Type<typeof Parameters>
type Action = (typeof ACTIONS)[number]
type Algorithm = (typeof ALGORITHMS)[number]
type SecretEncoding = (typeof SECRET_ENCODINGS)[number]

type Metadata = {
  action: Action
  algorithm?: Algorithm
  header?: Record<string, unknown>
  payload?: Record<string, unknown>
  signature_b64url?: string
  token?: string
  valid?: boolean
  bytes?: number
  reason?: string
  iat_iso?: string
  exp_iso?: string
  nbf_iso?: string
}

const done = (result: Tool.ExecuteResult<Metadata>) => result

export function b64urlEncode(buf: Buffer): string {
  return buf.toString("base64").replace(/=+$/g, "").replace(/\+/g, "-").replace(/\//g, "_")
}

export function b64urlDecode(str: string): Buffer {
  const pad = str.length % 4 === 0 ? "" : "=".repeat(4 - (str.length % 4))
  return Buffer.from(str.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64")
}

function decodeSecret(secret: string, enc: SecretEncoding): Buffer {
  if (enc === "utf8") return Buffer.from(secret, "utf8")
  if (enc === "hex") return Buffer.from(secret, "hex")
  if (enc === "base64") return Buffer.from(secret, "base64")
  // base64url
  const pad = secret.length % 4 === 0 ? "" : "=".repeat(4 - (secret.length % 4))
  return Buffer.from(secret.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64")
}

const HASH_FOR_ALG: Record<string, string> = {
  HS256: "sha256",
  HS384: "sha384",
  HS512: "sha512",
  RS256: "sha256",
  RS384: "sha384",
  RS512: "sha512",
  PS256: "sha256",
  PS384: "sha384",
  PS512: "sha512",
  ES256: "sha256",
  ES384: "sha384",
  ES512: "sha512",
}

const ECDSA_R_S_BYTES: Record<string, number> = { ES256: 32, ES384: 48, ES512: 66 }

function isHmac(alg: Algorithm): boolean {
  return alg === "HS256" || alg === "HS384" || alg === "HS512"
}

function isPss(alg: Algorithm): boolean {
  return alg === "PS256" || alg === "PS384" || alg === "PS512"
}

function isEcdsa(alg: Algorithm): boolean {
  return alg === "ES256" || alg === "ES384" || alg === "ES512"
}

function isEddsa(alg: Algorithm): boolean {
  return alg === "EdDSA"
}

function isRsaPkcs1(alg: Algorithm): boolean {
  return alg === "RS256" || alg === "RS384" || alg === "RS512"
}

// IEEE P1363 (R||S) -> ASN.1 DER for Node verify.
export function joseToDer(sig: Buffer, alg: Algorithm): Buffer {
  const size = ECDSA_R_S_BYTES[alg]
  if (!size) throw new Error(`jwt: not an ECDSA algorithm: ${alg}`)
  if (sig.byteLength !== size * 2) {
    throw new Error(`jwt: bad ECDSA signature length ${sig.byteLength} for ${alg}`)
  }
  const r = trimLeading(sig.slice(0, size))
  const s = trimLeading(sig.slice(size))
  const rEnc = encodeInteger(r)
  const sEnc = encodeInteger(s)
  const seqLen = rEnc.length + sEnc.length
  return Buffer.concat([Buffer.from([0x30, ...lengthBytes(seqLen)]), rEnc, sEnc])
}

// ASN.1 DER -> IEEE P1363 (R||S) for token output.
export function derToJose(der: Buffer, alg: Algorithm): Buffer {
  const size = ECDSA_R_S_BYTES[alg]
  if (!size) throw new Error(`jwt: not an ECDSA algorithm: ${alg}`)
  let i = 0
  if (der[i++] !== 0x30) throw new Error("jwt: bad DER signature (no SEQUENCE)")
  // skip length
  if (der[i] & 0x80) i += (der[i] & 0x7f) + 1
  else i += 1
  if (der[i++] !== 0x02) throw new Error("jwt: bad DER signature (no INTEGER R)")
  const rLen = der[i++]
  let r = der.slice(i, i + rLen)
  i += rLen
  if (der[i++] !== 0x02) throw new Error("jwt: bad DER signature (no INTEGER S)")
  const sLen = der[i++]
  let s = der.slice(i, i + sLen)
  if (r.length > size) r = r.slice(r.length - size)
  if (s.length > size) s = s.slice(s.length - size)
  const out = Buffer.alloc(size * 2)
  r.copy(out, size - r.length)
  s.copy(out, size * 2 - s.length)
  return out
}

function trimLeading(buf: Buffer): Buffer {
  let i = 0
  while (i < buf.length - 1 && buf[i] === 0) i++
  return buf.slice(i)
}

function encodeInteger(value: Buffer): Buffer {
  // ASN.1 INTEGER: prepend 0x00 if high bit set so it's not interpreted as negative.
  const needsPad = (value[0] & 0x80) !== 0
  const v = needsPad ? Buffer.concat([Buffer.from([0x00]), value]) : value
  return Buffer.concat([Buffer.from([0x02, ...lengthBytes(v.length)]), v])
}

function lengthBytes(len: number): number[] {
  if (len < 0x80) return [len]
  const bytes: number[] = []
  let n = len
  while (n > 0) {
    bytes.unshift(n & 0xff)
    n >>= 8
  }
  return [0x80 | bytes.length, ...bytes]
}

function pssOptions(alg: Algorithm): { saltLength: number } {
  // RFC 7518 Section 3.5: salt length = hash length.
  if (alg === "PS256") return { saltLength: 32 }
  if (alg === "PS384") return { saltLength: 48 }
  if (alg === "PS512") return { saltLength: 64 }
  return { saltLength: 0 }
}

export function decodeToken(token: string): {
  header: Record<string, unknown>
  payload: Record<string, unknown>
  signature: string
  signing_input: string
} {
  const parts = token.split(".")
  if (parts.length !== 3) throw new Error(`jwt.decode: token must have 3 segments, got ${parts.length}`)
  const [h, p, s] = parts
  let header: Record<string, unknown>
  let payload: Record<string, unknown>
  try {
    header = JSON.parse(b64urlDecode(h).toString("utf8"))
  } catch {
    throw new Error("jwt.decode: header is not valid JSON")
  }
  try {
    payload = JSON.parse(b64urlDecode(p).toString("utf8"))
  } catch {
    throw new Error("jwt.decode: payload is not valid JSON")
  }
  return { header, payload, signature: s, signing_input: `${h}.${p}` }
}

function loadPrivateKey(pem: string, passphrase?: string): KeyObject {
  return passphrase ? createPrivateKey({ key: pem, passphrase }) : createPrivateKey(pem)
}

function loadPublicKey(pem: string): KeyObject {
  // Accept either a PUBLIC KEY (SPKI) or a CERTIFICATE.
  return createPublicKey(pem)
}

function isoSec(seconds: number | undefined): string | undefined {
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) return undefined
  return new Date(seconds * 1000).toISOString()
}

function buildClaimMeta(
  header: Record<string, unknown>,
  payload: Record<string, unknown>,
): Pick<Metadata, "iat_iso" | "exp_iso" | "nbf_iso"> {
  return {
    iat_iso: isoSec(payload["iat"] as number | undefined),
    exp_iso: isoSec(payload["exp"] as number | undefined),
    nbf_iso: isoSec(payload["nbf"] as number | undefined),
  }
}

export const JwtTool = Tool.define(
  "jwt",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Params, _ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const action = params.action

          if (action === "decode") {
            if (!params.token) throw new Error("jwt.decode: requires `token`")
            const d = decodeToken(params.token)
            const alg = (d.header["alg"] as Algorithm | undefined) ?? "none"
            const md: Metadata = {
              action,
              algorithm: alg,
              header: d.header,
              payload: d.payload,
              signature_b64url: d.signature,
              ...buildClaimMeta(d.header, d.payload),
            }
            const lines = [
              `alg: ${alg}${d.header["kid"] ? ` kid: ${String(d.header["kid"])}` : ""}`,
              `header: ${JSON.stringify(d.header)}`,
              `payload: ${JSON.stringify(d.payload)}`,
              ...(md.iat_iso ? [`iat: ${md.iat_iso}`] : []),
              ...(md.exp_iso ? [`exp: ${md.exp_iso}`] : []),
              ...(md.nbf_iso ? [`nbf: ${md.nbf_iso}`] : []),
              `sig_bytes: ${b64urlDecode(d.signature).length}`,
            ]
            return done({
              title: `jwt.decode ${alg}`,
              metadata: md,
              output: lines.join("\n"),
            })
          }

          if (action === "verify") {
            if (!params.token) throw new Error("jwt.verify: requires `token`")
            const d = decodeToken(params.token)
            const headerAlg = d.header["alg"] as Algorithm | undefined
            const declaredAlg = params.algorithm ?? headerAlg
            if (!declaredAlg) throw new Error("jwt.verify: token has no alg and none was supplied")
            if (params.algorithm && headerAlg && params.algorithm !== headerAlg) {
              throw new Error(
                `jwt.verify: algorithm mismatch (param=${params.algorithm}, token=${headerAlg})`,
              )
            }
            const sig = b64urlDecode(d.signature)

            let cryptoOk: boolean
            if (declaredAlg === "none") {
              if (sig.length !== 0) throw new Error("jwt.verify: alg=none must have empty signature")
              cryptoOk = true
            } else if (isHmac(declaredAlg)) {
              if (!params.secret) throw new Error(`jwt.verify: ${declaredAlg} requires \`secret\``)
              const secretBuf = decodeSecret(params.secret, params.secret_encoding ?? "utf8")
              const expected = createHmac(HASH_FOR_ALG[declaredAlg], secretBuf)
                .update(d.signing_input)
                .digest()
              cryptoOk =
                expected.length === sig.length &&
                timingSafeEqual(new Uint8Array(expected), new Uint8Array(sig))
            } else if (isEddsa(declaredAlg)) {
              if (!params.public_key) throw new Error("jwt.verify: EdDSA requires `public_key`")
              const pub = loadPublicKey(params.public_key)
              cryptoOk = verifyOneShot(null, Buffer.from(d.signing_input), pub, sig)
            } else if (isEcdsa(declaredAlg)) {
              if (!params.public_key) throw new Error(`jwt.verify: ${declaredAlg} requires \`public_key\``)
              const pub = loadPublicKey(params.public_key)
              const der = joseToDer(sig, declaredAlg)
              const v = createVerify(HASH_FOR_ALG[declaredAlg])
              v.update(d.signing_input)
              cryptoOk = v.verify(pub, der)
            } else if (isPss(declaredAlg)) {
              if (!params.public_key) throw new Error(`jwt.verify: ${declaredAlg} requires \`public_key\``)
              const pub = loadPublicKey(params.public_key)
              const v = createVerify(HASH_FOR_ALG[declaredAlg])
              v.update(d.signing_input)
              cryptoOk = v.verify(
                {
                  key: pub,
                  padding: 6, // RSA_PKCS1_PSS_PADDING
                  saltLength: pssOptions(declaredAlg).saltLength,
                },
                sig,
              )
            } else if (isRsaPkcs1(declaredAlg)) {
              if (!params.public_key) throw new Error(`jwt.verify: ${declaredAlg} requires \`public_key\``)
              const pub = loadPublicKey(params.public_key)
              const v = createVerify(HASH_FOR_ALG[declaredAlg])
              v.update(d.signing_input)
              cryptoOk = v.verify(pub, sig)
            } else {
              throw new Error(`jwt.verify: unsupported algorithm ${declaredAlg}`)
            }

            if (!cryptoOk) {
              return done({
                title: `jwt.verify ${declaredAlg}: invalid`,
                metadata: { action, algorithm: declaredAlg, valid: false, reason: "signature mismatch" },
                output: "valid: false (signature mismatch)",
              })
            }

            // Claim checks.
            const now = Math.floor(Date.now() / 1000)
            const tol = params.clock_tolerance_s ?? 0
            const exp = d.payload["exp"] as number | undefined
            const nbf = d.payload["nbf"] as number | undefined
            if (typeof exp === "number" && now > exp + tol) {
              return done({
                title: `jwt.verify ${declaredAlg}: expired`,
                metadata: { action, algorithm: declaredAlg, valid: false, reason: "expired" },
                output: `valid: false (expired at ${new Date(exp * 1000).toISOString()})`,
              })
            }
            if (typeof nbf === "number" && now + tol < nbf) {
              return done({
                title: `jwt.verify ${declaredAlg}: not yet valid`,
                metadata: { action, algorithm: declaredAlg, valid: false, reason: "not_yet_valid" },
                output: `valid: false (not before ${new Date(nbf * 1000).toISOString()})`,
              })
            }
            if (params.verify_claims) {
              for (const k of ["iss", "aud", "sub"] as const) {
                const want = params.verify_claims[k]
                if (typeof want === "string" && d.payload[k] !== want) {
                  return done({
                    title: `jwt.verify ${declaredAlg}: claim ${k} mismatch`,
                    metadata: { action, algorithm: declaredAlg, valid: false, reason: `${k} mismatch` },
                    output: `valid: false (${k} mismatch)`,
                  })
                }
              }
            }

            const md: Metadata = {
              action,
              algorithm: declaredAlg,
              header: d.header,
              payload: d.payload,
              valid: true,
              ...buildClaimMeta(d.header, d.payload),
            }
            return done({
              title: `jwt.verify ${declaredAlg}: ok`,
              metadata: md,
              output: ["valid: true", `alg: ${declaredAlg}`, `payload: ${JSON.stringify(d.payload)}`].join("\n"),
            })
          }

          if (action === "sign") {
            const alg = params.algorithm ?? "HS256"
            const headerOverride = (params.header && typeof params.header === "object" ? (params.header as Record<string, unknown>) : {}) ?? {}
            const header: Record<string, unknown> = { typ: "JWT", ...headerOverride, alg }
            const basePayload =
              params.payload && typeof params.payload === "object" && !Array.isArray(params.payload)
                ? { ...(params.payload as Record<string, unknown>) }
                : {}
            const now = Math.floor(Date.now() / 1000)
            if (basePayload.iat === undefined) basePayload.iat = now
            if (params.expires_in_s !== undefined) basePayload.exp = (basePayload.iat as number) + params.expires_in_s
            if (params.not_before_s !== undefined) basePayload.nbf = (basePayload.iat as number) + params.not_before_s
            if (params.issuer !== undefined) basePayload.iss = params.issuer
            if (params.audience !== undefined) basePayload.aud = params.audience
            if (params.subject !== undefined) basePayload.sub = params.subject

            const headerB64 = b64urlEncode(Buffer.from(JSON.stringify(header), "utf8"))
            const payloadB64 = b64urlEncode(Buffer.from(JSON.stringify(basePayload), "utf8"))
            const signingInput = `${headerB64}.${payloadB64}`

            let sigBuf: Buffer
            if (alg === "none") {
              sigBuf = Buffer.alloc(0)
            } else if (isHmac(alg)) {
              if (!params.secret) throw new Error(`jwt.sign: ${alg} requires \`secret\``)
              const secretBuf = decodeSecret(params.secret, params.secret_encoding ?? "utf8")
              sigBuf = createHmac(HASH_FOR_ALG[alg], secretBuf).update(signingInput).digest()
            } else if (isEddsa(alg)) {
              if (!params.private_key) throw new Error("jwt.sign: EdDSA requires `private_key`")
              const pk = loadPrivateKey(params.private_key, params.key_passphrase)
              sigBuf = signOneShot(null, Buffer.from(signingInput), pk)
            } else if (isEcdsa(alg)) {
              if (!params.private_key) throw new Error(`jwt.sign: ${alg} requires \`private_key\``)
              const pk = loadPrivateKey(params.private_key, params.key_passphrase)
              const s = createSign(HASH_FOR_ALG[alg])
              s.update(signingInput)
              const der = s.sign(pk)
              sigBuf = derToJose(der, alg)
            } else if (isPss(alg)) {
              if (!params.private_key) throw new Error(`jwt.sign: ${alg} requires \`private_key\``)
              const pk = loadPrivateKey(params.private_key, params.key_passphrase)
              const s = createSign(HASH_FOR_ALG[alg])
              s.update(signingInput)
              sigBuf = s.sign({
                key: pk,
                padding: 6,
                saltLength: pssOptions(alg).saltLength,
              })
            } else if (isRsaPkcs1(alg)) {
              if (!params.private_key) throw new Error(`jwt.sign: ${alg} requires \`private_key\``)
              const pk = loadPrivateKey(params.private_key, params.key_passphrase)
              const s = createSign(HASH_FOR_ALG[alg])
              s.update(signingInput)
              sigBuf = s.sign(pk)
            } else {
              throw new Error(`jwt.sign: unsupported algorithm ${alg}`)
            }

            const sigB64 = b64urlEncode(sigBuf)
            const token = `${signingInput}.${sigB64}`
            const md: Metadata = {
              action,
              algorithm: alg,
              header,
              payload: basePayload,
              signature_b64url: sigB64,
              token,
              bytes: token.length,
              ...buildClaimMeta(header, basePayload),
            }
            return done({
              title: `jwt.sign ${alg}`,
              metadata: md,
              output: token,
            })
          }

          throw new Error(`jwt: unknown action ${action satisfies never}`)
        }),
    }
  }),
)

export const __testing = {
  b64urlEncode,
  b64urlDecode,
  decodeSecret,
  decodeToken,
  joseToDer,
  derToJose,
}
