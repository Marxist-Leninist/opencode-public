import { Effect, Schema } from "effect"
import DESCRIPTION from "./luhn.txt"
import * as Tool from "./tool"

const ACTIONS = ["validate", "compute_check_digit", "complete", "info"] as const
const SCHEMES = [
  "auto",
  "luhn",
  "creditcard",
  "imei",
  "imeisv",
  "iban",
  "isin",
  "ean13",
  "ean8",
  "upca",
  "isbn10",
  "isbn13",
  "gtin14",
] as const

export const Parameters = Schema.Struct({
  action: Schema.Literals(ACTIONS).annotate({ description: ACTIONS.join(" | ") }),
  value: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)).annotate({
    description: "Identifier to validate / complete (whitespace/dashes ignored where natural).",
  }),
  scheme: Schema.optional(Schema.Literals(SCHEMES)).annotate({
    description: "Scheme to use. Default 'auto'.",
  }),
})

type Params = Schema.Schema.Type<typeof Parameters>
type Action = (typeof ACTIONS)[number]
type Scheme = (typeof SCHEMES)[number]

type Metadata = {
  action: Action
  scheme: Exclude<Scheme, "auto">
  ok?: boolean
  check_digit?: string
  completed?: string
  detail?: string
  brand?: string
  country?: string
  prefix?: string
  length?: number
}

const done = (result: Tool.ExecuteResult<Metadata>) => result

// ---------- helpers ----------

function digitsOnly(s: string): string {
  return s.replace(/[\s-]/g, "")
}

function isAllDigits(s: string): boolean {
  return /^[0-9]+$/.test(s)
}

function luhnSum(digits: string): number {
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
  return sum
}

function luhnValid(digits: string): boolean {
  if (digits.length < 2) return false
  if (!isAllDigits(digits)) return false
  return luhnSum(digits) % 10 === 0
}

function luhnCheckDigit(prefix: string): string {
  if (!isAllDigits(prefix)) throw new Error("luhn: input must be digits only")
  // The check digit is whatever makes the trailing total mod 10 == 0.
  // Compute as if check digit were 0, then derive.
  const sum = luhnSum(prefix + "0")
  const cd = (10 - (sum % 10)) % 10
  return String(cd)
}

// EAN/UPC-style mod-10 weight 1/3 alternation, evaluated right-to-left.
function gs1CheckDigit(prefix: string): string {
  if (!isAllDigits(prefix)) throw new Error("gs1: digits only")
  let sum = 0
  for (let i = 0; i < prefix.length; i++) {
    const d = prefix.charCodeAt(prefix.length - 1 - i) - 48
    sum += d * (i % 2 === 0 ? 3 : 1)
  }
  const cd = (10 - (sum % 10)) % 10
  return String(cd)
}

function gs1Valid(value: string): boolean {
  if (!isAllDigits(value) || value.length < 2) return false
  return gs1CheckDigit(value.slice(0, -1)) === value.slice(-1)
}

function isbn10CheckChar(prefix: string): string {
  if (prefix.length !== 9 || !isAllDigits(prefix)) throw new Error("isbn10: prefix must be 9 digits")
  let sum = 0
  for (let i = 0; i < 9; i++) sum += (prefix.charCodeAt(i) - 48) * (10 - i)
  const r = (11 - (sum % 11)) % 11
  return r === 10 ? "X" : String(r)
}

function isbn10Valid(value: string): boolean {
  const v = value.toUpperCase()
  if (v.length !== 10) return false
  if (!/^[0-9]{9}[0-9X]$/.test(v)) return false
  return isbn10CheckChar(v.slice(0, 9)) === v[9]
}

function ibanRearrange(s: string): string {
  // Move first 4 chars to end and convert letters A=10..Z=35.
  const moved = s.slice(4) + s.slice(0, 4)
  let out = ""
  for (let i = 0; i < moved.length; i++) {
    const c = moved.charCodeAt(i)
    if (c >= 48 && c <= 57) out += String.fromCharCode(c)
    else if (c >= 65 && c <= 90) out += String(c - 55)
    else throw new Error(`iban: unexpected character "${moved[i]}"`)
  }
  return out
}

function bigMod97(numStr: string): number {
  let rem = 0
  for (let i = 0; i < numStr.length; i++) {
    rem = (rem * 10 + (numStr.charCodeAt(i) - 48)) % 97
  }
  return rem
}

function ibanValid(value: string): boolean {
  const s = value.replace(/\s/g, "").toUpperCase()
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{1,30}$/.test(s)) return false
  try {
    return bigMod97(ibanRearrange(s)) === 1
  } catch {
    return false
  }
}

function ibanCountry(value: string): string | undefined {
  const s = value.replace(/\s/g, "").toUpperCase()
  return s.length >= 2 ? s.slice(0, 2) : undefined
}

const ISIN_LETTER = (c: string): string => {
  const code = c.charCodeAt(0)
  if (code >= 48 && code <= 57) return c
  if (code >= 65 && code <= 90) return String(code - 55)
  throw new Error(`isin: invalid char "${c}"`)
}

function isinDigitsExpand(s: string): string {
  let out = ""
  for (const ch of s) out += ISIN_LETTER(ch)
  return out
}

function isinLuhnSum(numStr: string): number {
  let sum = 0
  // Per ISO 6166, we double from rightmost (so traverse R->L same as Luhn,
  // but we have to read as one continuous expanded digit string).
  let alt = false
  for (let i = numStr.length - 1; i >= 0; i--) {
    let n = numStr.charCodeAt(i) - 48
    if (alt) {
      n *= 2
      if (n > 9) n -= 9
    }
    sum += n
    alt = !alt
  }
  return sum
}

function isinValid(value: string): boolean {
  const s = value.toUpperCase().replace(/\s/g, "")
  if (!/^[A-Z]{2}[A-Z0-9]{9}\d$/.test(s)) return false
  try {
    const expanded = isinDigitsExpand(s)
    return isinLuhnSum(expanded) % 10 === 0
  } catch {
    return false
  }
}

function isinCheckDigit(prefix: string): string {
  if (prefix.length !== 11) throw new Error("isin: prefix must be 11 chars")
  const expanded = isinDigitsExpand(prefix.toUpperCase())
  // Derive check by trying 0..9
  for (let d = 0; d <= 9; d++) {
    if (isinLuhnSum(expanded + String(d)) % 10 === 0) return String(d)
  }
  throw new Error("isin: failed to compute check digit")
}

const CARD_BRANDS: Array<{
  brand: string
  pattern: RegExp
  lengths: number[]
}> = [
  { brand: "Visa", pattern: /^4/, lengths: [13, 16, 19] },
  { brand: "Mastercard", pattern: /^(5[1-5]|2(2[2-9]|[3-6]\d|7[01]|720))/, lengths: [16] },
  { brand: "Amex", pattern: /^3[47]/, lengths: [15] },
  { brand: "Discover", pattern: /^(6011|65|64[4-9]|622)/, lengths: [16, 17, 18, 19] },
  { brand: "Diners", pattern: /^(36|30[0-5]|3095|38|39)/, lengths: [14, 15, 16, 17, 18, 19] },
  { brand: "JCB", pattern: /^35(2[89]|[3-8]\d)/, lengths: [16, 17, 18, 19] },
  { brand: "UnionPay", pattern: /^62/, lengths: [16, 17, 18, 19] },
]

function detectCardBrand(digits: string): string | undefined {
  for (const b of CARD_BRANDS) {
    if (b.pattern.test(digits) && b.lengths.includes(digits.length)) return b.brand
  }
  return undefined
}

function inferScheme(value: string): Exclude<Scheme, "auto"> {
  const compact = value.replace(/[\s-]/g, "").toUpperCase()
  // ISIN is exactly 12 characters; check it before IBAN (which is variable length).
  if (compact.length === 12 && /^[A-Z]{2}[A-Z0-9]{9}\d$/.test(compact)) return "isin"
  if (/^[A-Z]{2}\d{2}[A-Z0-9]+$/.test(compact)) return "iban"
  if (isAllDigits(compact)) {
    if (compact.length === 14) return "gtin14"
    if (compact.length === 13) {
      // Could be EAN-13 or ISBN-13
      if (compact.startsWith("978") || compact.startsWith("979")) return "isbn13"
      return "ean13"
    }
    if (compact.length === 12) return "upca"
    if (compact.length === 8) return "ean8"
    if (compact.length === 15) return "imei"
    if (compact.length === 16) {
      // Could be IMEISV (16) or a 16-digit credit card. Brand match wins.
      if (detectCardBrand(compact)) return "creditcard"
      return "imeisv"
    }
    if (compact.length === 10 || compact.length === 11) {
      // Plausibly ISBN-10 (no X) or generic Luhn
      return "luhn"
    }
    if (detectCardBrand(compact)) return "creditcard"
    return "luhn"
  }
  if (/^[0-9]{9}[0-9X]$/.test(compact)) return "isbn10"
  return "luhn"
}

function validateAuto(scheme: Exclude<Scheme, "auto">, raw: string): { ok: boolean; detail: string; extra?: Record<string, unknown> } {
  switch (scheme) {
    case "luhn": {
      const d = digitsOnly(raw)
      return { ok: luhnValid(d), detail: `mod-10 Luhn over ${d.length} digits` }
    }
    case "creditcard": {
      const d = digitsOnly(raw)
      const brand = detectCardBrand(d)
      const ok = luhnValid(d) && brand !== undefined
      return {
        ok,
        detail: brand ? `Luhn-valid ${brand} card (${d.length} digits)` : `${d.length} digits, no recognized brand`,
        extra: { brand },
      }
    }
    case "imei": {
      const d = digitsOnly(raw)
      return { ok: d.length === 15 && luhnValid(d), detail: `IMEI 15-digit Luhn` }
    }
    case "imeisv": {
      const d = digitsOnly(raw)
      return { ok: d.length === 16 && isAllDigits(d), detail: `IMEISV: 16 digits (no checksum)` }
    }
    case "iban": {
      const ok = ibanValid(raw)
      const country = ibanCountry(raw)
      return { ok, detail: `IBAN mod-97 (${country ?? "?"})`, extra: { country } }
    }
    case "isin": {
      return { ok: isinValid(raw), detail: `ISIN expanded-Luhn` }
    }
    case "ean13": {
      const d = digitsOnly(raw)
      return { ok: d.length === 13 && gs1Valid(d), detail: `EAN-13 GS1 mod-10`, extra: { prefix: d.slice(0, 3) } }
    }
    case "upca": {
      const d = digitsOnly(raw)
      return { ok: d.length === 12 && gs1Valid(d), detail: `UPC-A GS1 mod-10` }
    }
    case "ean8": {
      const d = digitsOnly(raw)
      return { ok: d.length === 8 && gs1Valid(d), detail: `EAN-8 GS1 mod-10` }
    }
    case "isbn10": {
      return { ok: isbn10Valid(raw.replace(/[\s-]/g, "")), detail: `ISBN-10 mod-11` }
    }
    case "isbn13": {
      const d = digitsOnly(raw)
      const ok = d.length === 13 && (d.startsWith("978") || d.startsWith("979")) && gs1Valid(d)
      return { ok, detail: `ISBN-13 GS1 mod-10 with 978/979 prefix` }
    }
    case "gtin14": {
      const d = digitsOnly(raw)
      return { ok: d.length === 14 && gs1Valid(d), detail: `GTIN-14 GS1 mod-10` }
    }
  }
}

function computeCheck(scheme: Exclude<Scheme, "auto">, raw: string): string {
  switch (scheme) {
    case "luhn":
    case "creditcard":
    case "imei":
      return luhnCheckDigit(digitsOnly(raw))
    case "imeisv":
      throw new Error("luhn.compute_check_digit: imeisv has no checksum")
    case "iban": {
      const s = raw.replace(/\s/g, "").toUpperCase()
      if (!/^[A-Z]{2}[A-Z0-9]+$/.test(s)) throw new Error("iban: must start with 2-letter country code")
      // Compute by setting check digits to "00", solving 98 - mod97 = check.
      const probe = s.slice(0, 2) + "00" + s.slice(2)
      const rem = bigMod97(ibanRearrange(probe))
      const check = 98 - rem
      return String(check).padStart(2, "0")
    }
    case "isin":
      return isinCheckDigit(raw.toUpperCase().replace(/\s/g, ""))
    case "ean13":
    case "ean8":
    case "upca":
    case "gtin14":
    case "isbn13":
      return gs1CheckDigit(digitsOnly(raw))
    case "isbn10":
      return isbn10CheckChar(digitsOnly(raw))
  }
}

function completeId(scheme: Exclude<Scheme, "auto">, prefix: string): string {
  if (scheme === "iban") {
    const s = prefix.replace(/\s/g, "").toUpperCase()
    const cd = computeCheck(scheme, s)
    return s.slice(0, 2) + cd + s.slice(2)
  }
  return prefix + computeCheck(scheme, prefix)
}

export const LuhnTool = Tool.define(
  "luhn",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Params, _ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const action = params.action
          const scheme: Exclude<Scheme, "auto"> =
            !params.scheme || params.scheme === "auto" ? inferScheme(params.value) : params.scheme

          if (action === "validate") {
            const v = validateAuto(scheme, params.value)
            return done({
              title: `luhn.validate ${scheme}: ${v.ok}`,
              metadata: { action, scheme, ok: v.ok, detail: v.detail, ...(v.extra ?? {}) },
              output: String(v.ok),
            })
          }

          if (action === "compute_check_digit") {
            const cd = computeCheck(scheme, params.value)
            return done({
              title: `luhn.compute_check_digit ${scheme}: ${cd}`,
              metadata: { action, scheme, check_digit: cd },
              output: cd,
            })
          }

          if (action === "complete") {
            const completed = completeId(scheme, params.value)
            return done({
              title: `luhn.complete ${scheme}`,
              metadata: { action, scheme, completed },
              output: completed,
            })
          }

          if (action === "info") {
            const v = validateAuto(scheme, params.value)
            const compact = params.value.replace(/[\s-]/g, "")
            const meta: Metadata = {
              action,
              scheme,
              ok: v.ok,
              detail: v.detail,
              length: compact.length,
              ...(v.extra ?? {}),
            }
            const lines = [
              `scheme: ${scheme}`,
              `valid: ${v.ok}`,
              `detail: ${v.detail}`,
              `length: ${compact.length}`,
              ...(meta.brand ? [`brand: ${meta.brand}`] : []),
              ...(meta.country ? [`country: ${meta.country}`] : []),
              ...(meta.prefix ? [`prefix: ${meta.prefix}`] : []),
            ]
            return done({
              title: `luhn.info ${scheme}: ${v.ok}`,
              metadata: meta,
              output: lines.join("\n"),
            })
          }

          throw new Error(`luhn: unknown action ${action satisfies never}`)
        }),
    }
  }),
)

export const __testing = {
  luhnSum,
  luhnValid,
  luhnCheckDigit,
  gs1CheckDigit,
  gs1Valid,
  isbn10Valid,
  isbn10CheckChar,
  ibanValid,
  ibanRearrange,
  bigMod97,
  isinValid,
  isinCheckDigit,
  detectCardBrand,
  inferScheme,
  validateAuto,
  computeCheck,
  completeId,
}
