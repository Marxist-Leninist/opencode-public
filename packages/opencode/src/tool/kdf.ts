import { Effect, Schema } from "effect"
import { pbkdf2, randomBytes, scrypt, timingSafeEqual } from "node:crypto"
import { promisify } from "node:util"
import DESCRIPTION from "./kdf.txt"
import * as Tool from "./tool"

const pbkdf2Async = promisify(pbkdf2)
const scryptAsync = promisify(scrypt) as (
  password: Buffer | string,
  salt: Buffer | string,
  keylen: number,
  options?: { N?: number; r?: number; p?: number; maxmem?: number },
) => Promise<Buffer>

const ACTIONS = ["derive", "hash", "verify"] as const
const ALGOS = ["pbkdf2", "scrypt"] as const
const DIGESTS = ["sha256", "sha512", "sha1", "sha384", "sha224"] as const
const PASSWORD_ENCODINGS = ["utf8", "hex", "base64", "base64url"] as const
const SALT_ENCODINGS = ["utf8", "hex", "base64", "base64url", "auto"] as const
const OUTPUT_ENCODINGS = ["hex", "base64", "base64url"] as const

const MAX_KEYLEN = 1024
const MAX_PBKDF2_ITER = 10_000_000
const DEFAULT_PBKDF2_ITER = 100_000
const DEFAULT_SCRYPT_N = 16_384
const DEFAULT_SCRYPT_R = 8
const DEFAULT_SCRYPT_P = 1
const DEFAULT_SCRYPT_MAXMEM = 64 * 1024 * 1024
const SCRYPT_MAX_N = 1 << 22
const SCRYPT_MAX_R = 64
const SCRYPT_MAX_P = 16

export const Parameters = Schema.Struct({
  action: Schema.Literals(ACTIONS).annotate({ description: "derive | hash | verify" }),
  algo: Schema.optional(Schema.Literals(ALGOS)).annotate({
    description: "Algorithm. Default pbkdf2.",
  }),
  password: Schema.optional(Schema.String).annotate({
    description: "Password to derive from / verify.",
  }),
  password_encoding: Schema.optional(Schema.Literals(PASSWORD_ENCODINGS)).annotate({
    description: "Encoding of password. Default utf8.",
  }),
  salt: Schema.optional(Schema.String).annotate({
    description: "Salt. For derive default empty (rare); for hash, auto-generated when omitted.",
  }),
  salt_encoding: Schema.optional(Schema.Literals(SALT_ENCODINGS)).annotate({
    description: "Encoding of salt. Default auto (hex if all-hex 8+ chars, else utf8).",
  }),
  key_length: Schema.optional(
    Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(MAX_KEYLEN)),
  ).annotate({ description: `Output key length in bytes. Default 32. Max ${MAX_KEYLEN}.` }),
  output_encoding: Schema.optional(Schema.Literals(OUTPUT_ENCODINGS)).annotate({
    description: "Output encoding for derive. Default hex.",
  }),
  iterations: Schema.optional(
    Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(MAX_PBKDF2_ITER)),
  ).annotate({ description: `PBKDF2 iterations. Default ${DEFAULT_PBKDF2_ITER}.` }),
  digest: Schema.optional(Schema.Literals(DIGESTS)).annotate({
    description: "PBKDF2 digest. Default sha256.",
  }),
  N: Schema.optional(
    Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(2), Schema.isLessThanOrEqualTo(SCRYPT_MAX_N)),
  ).annotate({ description: `scrypt N (CPU/memory cost). Power of 2. Default ${DEFAULT_SCRYPT_N}.` }),
  r: Schema.optional(
    Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(SCRYPT_MAX_R)),
  ).annotate({ description: `scrypt r (block size). Default ${DEFAULT_SCRYPT_R}.` }),
  p: Schema.optional(
    Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(SCRYPT_MAX_P)),
  ).annotate({ description: `scrypt parallelism. Default ${DEFAULT_SCRYPT_P}.` }),
  maxmem: Schema.optional(
    Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1024 * 1024)),
  ).annotate({
    description: `scrypt maxmem in bytes. Default ${DEFAULT_SCRYPT_MAXMEM}.`,
  }),
  hash: Schema.optional(Schema.String).annotate({
    description: "PHC hash string (verify input).",
  }),
})

type Params = Schema.Schema.Type<typeof Parameters>
type Action = (typeof ACTIONS)[number]
type Algo = (typeof ALGOS)[number]
type Digest = (typeof DIGESTS)[number]

type Metadata = {
  action: Action
  algo?: Algo
  match?: boolean
  digest?: Digest
  iterations?: number
  N?: number
  r?: number
  p?: number
  key_length?: number
  salt?: string
  hash_string?: string
  ms?: number
}

const done = (result: Tool.ExecuteResult<Metadata>) => result

function isPow2(n: number) {
  return n > 0 && (n & (n - 1)) === 0
}

function decodePassword(s: string, enc: (typeof PASSWORD_ENCODINGS)[number]): Buffer {
  return Buffer.from(s, enc)
}

function decodeSalt(s: string, enc: (typeof SALT_ENCODINGS)[number]): Buffer {
  if (enc === "auto") {
    // hex if all-hex and length is 8+ even (typical of stored salts)
    if (s.length >= 8 && s.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(s)) {
      return Buffer.from(s, "hex")
    }
    return Buffer.from(s, "utf8")
  }
  return Buffer.from(s, enc)
}

function encOut(buf: Buffer, enc: (typeof OUTPUT_ENCODINGS)[number]): string {
  return buf.toString(enc)
}

function b64url(buf: Buffer): string {
  return buf.toString("base64url")
}

function fromB64url(s: string): Buffer {
  return Buffer.from(s, "base64url")
}

async function derivePbkdf2(
  password: Buffer,
  salt: Buffer,
  iterations: number,
  keylen: number,
  digest: Digest,
): Promise<Buffer> {
  return await pbkdf2Async(password, salt, iterations, keylen, digest)
}

async function deriveScrypt(
  password: Buffer,
  salt: Buffer,
  keylen: number,
  N: number,
  r: number,
  p: number,
  maxmem: number,
): Promise<Buffer> {
  return await scryptAsync(password, salt, keylen, { N, r, p, maxmem })
}

function encodeHashPbkdf2(digest: Digest, iterations: number, salt: Buffer, key: Buffer): string {
  return `pbkdf2-${digest}$i=${iterations},k=${key.length}$${b64url(salt)}$${b64url(key)}`
}

function encodeHashScrypt(N: number, r: number, p: number, salt: Buffer, key: Buffer): string {
  return `scrypt$N=${N},r=${r},p=${p},k=${key.length}$${b64url(salt)}$${b64url(key)}`
}

type ParsedHash =
  | { algo: "pbkdf2"; digest: Digest; iterations: number; key_length: number; salt: Buffer; key: Buffer }
  | { algo: "scrypt"; N: number; r: number; p: number; key_length: number; salt: Buffer; key: Buffer }

function parseHashString(s: string): ParsedHash {
  const parts = s.split("$")
  if (parts.length !== 4) throw new Error(`kdf: malformed hash string (expected 4 segments, got ${parts.length})`)
  const [head, paramStr, saltB64, keyB64] = parts as [string, string, string, string]
  const salt = fromB64url(saltB64)
  const key = fromB64url(keyB64)
  const params = Object.fromEntries(
    paramStr.split(",").map((kv) => {
      const [k, v] = kv.split("=")
      return [k!, v!]
    }),
  )
  if (head.startsWith("pbkdf2-")) {
    const digest = head.slice("pbkdf2-".length) as Digest
    if (!DIGESTS.includes(digest)) throw new Error(`kdf: unknown pbkdf2 digest "${digest}"`)
    const iterations = Number(params.i)
    const klen = Number(params.k)
    if (!Number.isFinite(iterations) || iterations <= 0) throw new Error("kdf: invalid pbkdf2 iterations")
    if (!Number.isFinite(klen) || klen <= 0 || klen !== key.length)
      throw new Error("kdf: invalid pbkdf2 key length / mismatch")
    return { algo: "pbkdf2", digest, iterations, key_length: klen, salt, key }
  }
  if (head === "scrypt") {
    const N = Number(params.N)
    const r = Number(params.r)
    const p = Number(params.p)
    const klen = Number(params.k)
    if (!Number.isFinite(N) || !isPow2(N)) throw new Error("kdf: scrypt N must be a power of 2")
    if (!Number.isFinite(r) || r < 1) throw new Error("kdf: invalid scrypt r")
    if (!Number.isFinite(p) || p < 1) throw new Error("kdf: invalid scrypt p")
    if (!Number.isFinite(klen) || klen <= 0 || klen !== key.length)
      throw new Error("kdf: invalid scrypt key length / mismatch")
    return { algo: "scrypt", N, r, p, key_length: klen, salt, key }
  }
  throw new Error(`kdf: unknown algorithm header "${head}"`)
}

export const KdfTool = Tool.define(
  "kdf",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Params, _ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const action = params.action
          const algo: Algo = params.algo ?? "pbkdf2"
          const passEnc = params.password_encoding ?? "utf8"
          const saltEnc = params.salt_encoding ?? "auto"
          const outEnc = params.output_encoding ?? "hex"
          const keylen = params.key_length ?? 32

          if (action === "verify") {
            if (!params.hash) throw new Error("kdf.verify: requires `hash`")
            if (!params.password) throw new Error("kdf.verify: requires `password`")
            const parsed = parseHashString(params.hash)
            const pwd = decodePassword(params.password, passEnc)
            const start = Date.now()
            let derived: Buffer
            if (parsed.algo === "pbkdf2") {
              derived = yield* Effect.promise(() =>
                derivePbkdf2(pwd, parsed.salt, parsed.iterations, parsed.key_length, parsed.digest),
              )
            } else {
              const maxmem = params.maxmem ?? Math.max(DEFAULT_SCRYPT_MAXMEM, parsed.N * parsed.r * parsed.p * 128 * 2)
              derived = yield* Effect.promise(() =>
                deriveScrypt(pwd, parsed.salt, parsed.key_length, parsed.N, parsed.r, parsed.p, maxmem),
              )
            }
            const ms = Date.now() - start
            const match = derived.length === parsed.key.length && timingSafeEqual(derived, parsed.key)
            return done({
              title: `kdf.verify ${parsed.algo}: ${match}`,
              metadata: {
                action,
                algo: parsed.algo,
                match,
                digest: parsed.algo === "pbkdf2" ? parsed.digest : undefined,
                iterations: parsed.algo === "pbkdf2" ? parsed.iterations : undefined,
                N: parsed.algo === "scrypt" ? parsed.N : undefined,
                r: parsed.algo === "scrypt" ? parsed.r : undefined,
                p: parsed.algo === "scrypt" ? parsed.p : undefined,
                key_length: parsed.key_length,
                ms,
              },
              output: String(match),
            })
          }

          if (!params.password) throw new Error(`kdf.${action}: requires \`password\``)
          const password = decodePassword(params.password, passEnc)

          let salt: Buffer
          if (params.salt) {
            salt = decodeSalt(params.salt, saltEnc)
          } else {
            if (action === "hash") {
              salt = randomBytes(16)
            } else {
              salt = Buffer.alloc(0)
            }
          }

          if (algo === "pbkdf2") {
            const iterations = params.iterations ?? DEFAULT_PBKDF2_ITER
            const digest: Digest = params.digest ?? "sha256"
            const start = Date.now()
            const key = yield* Effect.promise(() => derivePbkdf2(password, salt, iterations, keylen, digest))
            const ms = Date.now() - start
            if (action === "derive") {
              const out = encOut(key, outEnc)
              return done({
                title: `kdf.derive pbkdf2-${digest} (${ms}ms)`,
                metadata: {
                  action,
                  algo,
                  digest,
                  iterations,
                  key_length: keylen,
                  salt: b64url(salt),
                  ms,
                },
                output: out,
              })
            }
            const phc = encodeHashPbkdf2(digest, iterations, salt, key)
            return done({
              title: `kdf.hash pbkdf2-${digest} (${ms}ms)`,
              metadata: {
                action,
                algo,
                digest,
                iterations,
                key_length: keylen,
                salt: b64url(salt),
                hash_string: phc,
                ms,
              },
              output: phc,
            })
          }

          // scrypt
          const N = params.N ?? DEFAULT_SCRYPT_N
          const r = params.r ?? DEFAULT_SCRYPT_R
          const p = params.p ?? DEFAULT_SCRYPT_P
          if (!isPow2(N)) throw new Error("kdf: scrypt N must be a power of 2")
          const maxmem = params.maxmem ?? Math.max(DEFAULT_SCRYPT_MAXMEM, N * r * p * 128 * 2)
          const start = Date.now()
          const key = yield* Effect.promise(() => deriveScrypt(password, salt, keylen, N, r, p, maxmem))
          const ms = Date.now() - start
          if (action === "derive") {
            const out = encOut(key, outEnc)
            return done({
              title: `kdf.derive scrypt (${ms}ms)`,
              metadata: {
                action,
                algo,
                N,
                r,
                p,
                key_length: keylen,
                salt: b64url(salt),
                ms,
              },
              output: out,
            })
          }
          const phc = encodeHashScrypt(N, r, p, salt, key)
          return done({
            title: `kdf.hash scrypt (${ms}ms)`,
            metadata: {
              action,
              algo,
              N,
              r,
              p,
              key_length: keylen,
              salt: b64url(salt),
              hash_string: phc,
              ms,
            },
            output: phc,
          })
        }),
    }
  }),
)

export const __testing = {
  parseHashString,
  encodeHashPbkdf2,
  encodeHashScrypt,
  derivePbkdf2,
  deriveScrypt,
  decodeSalt,
  isPow2,
}
