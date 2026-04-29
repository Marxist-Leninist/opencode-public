import { Effect, Schema } from "effect"
import DESCRIPTION from "./unicode.txt"
import * as Tool from "./tool"

const ACTIONS = [
  "info",
  "codepoints",
  "escape",
  "unescape",
  "normalize",
  "from_codepoints",
  "to_codepoints",
  "width",
  "strip_invisible",
  "is_confusable",
  "count",
] as const

const FORMS = ["NFC", "NFD", "NFKC", "NFKD"] as const

export const Parameters = Schema.Struct({
  action: Schema.Literals(ACTIONS).annotate({ description: ACTIONS.join(" | ") }),
  value: Schema.optional(Schema.String).annotate({ description: "Input string." }),
  a: Schema.optional(Schema.String).annotate({ description: "First operand for is_confusable." }),
  b: Schema.optional(Schema.String).annotate({ description: "Second operand for is_confusable." }),
  codepoints: Schema.optional(Schema.Array(Schema.Number)).annotate({ description: "Codepoints array." }),
  form: Schema.optional(Schema.Literals(FORMS)).annotate({ description: "Normalization form (default NFC)." }),
  radix: Schema.optional(Schema.Number).annotate({ description: "Radix for codepoint hex (default 16)." }),
})

type Params = Schema.Schema.Type<typeof Parameters>

type Metadata = {
  action: (typeof ACTIONS)[number]
  result?: unknown
}

// ---------- Invisible chars ----------
const INVISIBLE_CODEPOINTS = new Set<number>([
  0x00ad, // soft hyphen
  0x180e, // mongolian vowel separator
  0x200b, 0x200c, 0x200d, 0x200e, 0x200f, // ZWSP/ZWNJ/ZWJ/LRM/RLM
  0x202a, 0x202b, 0x202c, 0x202d, 0x202e, // LRE/RLE/PDF/LRO/RLO
  0x2060, 0x2061, 0x2062, 0x2063, 0x2064, // word-joiner / function app
  0x2066, 0x2067, 0x2068, 0x2069, // LRI/RLI/FSI/PDI
  0xfeff, // BOM / ZWNBSP
])

// ---------- Confusables (compact subset) ----------
const CONFUSABLES_MAP: Record<string, string> = {
  // Cyrillic look-alikes -> Latin
  "а": "a", "А": "A", "е": "e", "Е": "E", "о": "o", "О": "O", "р": "p", "Р": "P", "с": "c", "С": "C",
  "у": "y", "У": "Y", "х": "x", "Х": "X", "ѕ": "s", "і": "i", "І": "I", "ј": "j", "Ј": "J",
  "ӏ": "l", "ԛ": "q", "ԝ": "w",
  // Greek -> Latin
  "Α": "A", "Β": "B", "Ε": "E", "Ζ": "Z", "Η": "H", "Ι": "I", "Κ": "K", "Μ": "M", "Ν": "N",
  "Ο": "O", "Ρ": "P", "Τ": "T", "Υ": "Y", "Χ": "X",
  // Fullwidth digits
  "０": "0", "１": "1", "２": "2", "３": "3", "４": "4", "５": "5", "６": "6", "７": "7", "８": "8", "９": "9",
  // Fullwidth Latin
  "Ａ": "A", "Ｂ": "B", "Ｃ": "C", "Ｄ": "D", "Ｅ": "E", "Ｆ": "F", "Ｇ": "G", "Ｈ": "H", "Ｉ": "I",
  "Ｊ": "J", "Ｋ": "K", "Ｌ": "L", "Ｍ": "M", "Ｎ": "N", "Ｏ": "O", "Ｐ": "P", "Ｑ": "Q", "Ｒ": "R",
  "Ｓ": "S", "Ｔ": "T", "Ｕ": "U", "Ｖ": "V", "Ｗ": "W", "Ｘ": "X", "Ｙ": "Y", "Ｚ": "Z",
  // Common dashes / quotes -> ASCII
  "‐": "-", "‑": "-", "‒": "-", "–": "-", "—": "-", "―": "-", "−": "-",
  "‘": "'", "’": "'", "‛": "'", "“": '"', "”": '"', "„": '"', "‟": '"', "«": '"', "»": '"',
  "‹": "<", "›": ">",
}

function applyConfusables(s: string): string {
  let out = ""
  for (const ch of s) out += CONFUSABLES_MAP[ch] ?? ch
  return out
}

// ---------- Categories ----------
function categoryOf(cp: number): string {
  // Highly compact lookup using ranges. Falls back to "Cn" (unassigned).
  // ASCII fast path
  if (cp < 0x80) {
    if (cp >= 0x30 && cp <= 0x39) return "Nd"
    if (cp >= 0x41 && cp <= 0x5a) return "Lu"
    if (cp >= 0x61 && cp <= 0x7a) return "Ll"
    if (cp === 0x20) return "Zs"
    if (cp < 0x20 || cp === 0x7f) return "Cc"
    if (cp === 0x5f) return "Pc"
    if (cp === 0x24 || cp === 0x2b || cp === 0x3c || cp === 0x3d || cp === 0x3e || cp === 0x7c || cp === 0x7e || cp === 0x5e || cp === 0x60) return "Sm"
    if ([0x21, 0x22, 0x23, 0x25, 0x26, 0x27, 0x2a, 0x2c, 0x2e, 0x2f, 0x3a, 0x3b, 0x3f, 0x40, 0x5c].includes(cp)) return "Po"
    if ([0x28, 0x5b, 0x7b].includes(cp)) return "Ps"
    if ([0x29, 0x5d, 0x7d].includes(cp)) return "Pe"
    if (cp === 0x2d) return "Pd"
    return "Po"
  }
  if (INVISIBLE_CODEPOINTS.has(cp)) return "Cf"
  // BMP general buckets (heuristic)
  if (cp >= 0x80 && cp <= 0xff) {
    if (cp === 0xa0) return "Zs"
    if (cp >= 0xc0 && cp <= 0xde && cp !== 0xd7) return "Lu"
    if (cp >= 0xdf && cp <= 0xff && cp !== 0xf7) return "Ll"
  }
  // CJK
  if (cp >= 0x4e00 && cp <= 0x9fff) return "Lo"
  if (cp >= 0x3040 && cp <= 0x309f) return "Lo" // Hiragana
  if (cp >= 0x30a0 && cp <= 0x30ff) return "Lo" // Katakana
  if (cp >= 0xac00 && cp <= 0xd7af) return "Lo" // Hangul syllables
  // Cyrillic
  if (cp >= 0x0400 && cp <= 0x04ff) {
    if (cp <= 0x040f || (cp >= 0x0410 && cp <= 0x042f) || (cp >= 0x0460 && cp <= 0x047f && cp % 2 === 0)) return "Lu"
    return "Ll"
  }
  // Greek
  if (cp >= 0x0370 && cp <= 0x03ff) {
    if (cp >= 0x0391 && cp <= 0x03a9) return "Lu"
    if (cp >= 0x03b1 && cp <= 0x03c9) return "Ll"
  }
  // Emoji ranges -> So
  if (
    (cp >= 0x1f300 && cp <= 0x1faff) ||
    (cp >= 0x2600 && cp <= 0x26ff) ||
    (cp >= 0x2700 && cp <= 0x27bf)
  )
    return "So"
  // Combining marks
  if (cp >= 0x0300 && cp <= 0x036f) return "Mn"
  return "Lo"
}

function scriptOf(cp: number): string {
  if (cp < 0x80) return "Latin"
  if (cp >= 0x0370 && cp <= 0x03ff) return "Greek"
  if (cp >= 0x0400 && cp <= 0x04ff) return "Cyrillic"
  if (cp >= 0x0590 && cp <= 0x05ff) return "Hebrew"
  if (cp >= 0x0600 && cp <= 0x06ff) return "Arabic"
  if (cp >= 0x0900 && cp <= 0x097f) return "Devanagari"
  if (cp >= 0x0e00 && cp <= 0x0e7f) return "Thai"
  if (cp >= 0x3040 && cp <= 0x309f) return "Hiragana"
  if (cp >= 0x30a0 && cp <= 0x30ff) return "Katakana"
  if (cp >= 0xac00 && cp <= 0xd7af) return "Hangul"
  if (cp >= 0x4e00 && cp <= 0x9fff) return "Han"
  if (cp >= 0x3400 && cp <= 0x4dbf) return "Han"
  if (cp >= 0x20000 && cp <= 0x2a6df) return "Han"
  if ((cp >= 0x1f300 && cp <= 0x1faff) || (cp >= 0x2600 && cp <= 0x27bf)) return "Common"
  if (cp >= 0x0080 && cp <= 0x024f) return "Latin"
  return "Common"
}

function widthOf(cp: number): 0 | 1 | 2 {
  if (cp === 0) return 0
  if (cp < 0x20) return 0
  if (INVISIBLE_CODEPOINTS.has(cp)) return 0
  if (cp >= 0x0300 && cp <= 0x036f) return 0
  // East Asian Wide / Fullwidth — heuristic
  if (cp >= 0x1100 && cp <= 0x115f) return 2 // Hangul Jamo init
  if (cp >= 0x2e80 && cp <= 0x303e) return 2
  if (cp >= 0x3041 && cp <= 0x33ff) return 2
  if (cp >= 0x3400 && cp <= 0x4dbf) return 2
  if (cp >= 0x4e00 && cp <= 0x9fff) return 2
  if (cp >= 0xa000 && cp <= 0xa4cf) return 2
  if (cp >= 0xac00 && cp <= 0xd7a3) return 2
  if (cp >= 0xf900 && cp <= 0xfaff) return 2
  if (cp >= 0xfe30 && cp <= 0xfe4f) return 2
  if (cp >= 0xff00 && cp <= 0xff60) return 2
  if (cp >= 0xffe0 && cp <= 0xffe6) return 2
  if (cp >= 0x1f300 && cp <= 0x1faff) return 2 // Emoji block (extended)
  if (cp >= 0x20000 && cp <= 0x2fffd) return 2
  return 1
}

function nameOf(cp: number): string {
  // best-effort short name
  if (cp >= 0x30 && cp <= 0x39) return `DIGIT ${String.fromCodePoint(cp)}`
  if (cp >= 0x41 && cp <= 0x5a) return `LATIN CAPITAL LETTER ${String.fromCodePoint(cp)}`
  if (cp >= 0x61 && cp <= 0x7a) return `LATIN SMALL LETTER ${String.fromCodePoint(cp - 32)}`
  if (cp === 0x20) return "SPACE"
  if (cp === 0x09) return "TAB"
  if (cp === 0x0a) return "LINE FEED"
  if (cp === 0x0d) return "CARRIAGE RETURN"
  if (cp === 0x00) return "NULL"
  return `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`
}

export function unicodeInfo(s: string) {
  const codepoints: number[] = []
  for (const ch of s) codepoints.push(ch.codePointAt(0)!)
  const has_non_ascii = codepoints.some((c) => c > 0x7f)
  const has_surrogates = /[\uD800-\uDFFF]/.test(s)
  const has_combining = codepoints.some((c) => c >= 0x0300 && c <= 0x036f)
  const has_invisible = codepoints.some((c) => INVISIBLE_CODEPOINTS.has(c))
  const has_rtl = codepoints.some((c) => (c >= 0x0590 && c <= 0x08ff) || (c >= 0xfb1d && c <= 0xfdff))
  const has_emoji = codepoints.some((c) => (c >= 0x1f300 && c <= 0x1faff) || (c >= 0x2600 && c <= 0x27bf))
  return {
    length: s.length,
    byte_length: Buffer.byteLength(s, "utf8"),
    codepoint_count: codepoints.length,
    has_non_ascii,
    has_surrogates,
    has_combining,
    has_invisible,
    has_rtl,
    has_emoji,
  }
}

export function listCodepoints(s: string, radix = 16) {
  const out: Array<{ char: string; codepoint: number; hex: string; name: string; category: string; script: string; width: number }> = []
  for (const ch of s) {
    const cp = ch.codePointAt(0)!
    out.push({
      char: ch,
      codepoint: cp,
      hex: cp.toString(radix).toUpperCase(),
      name: nameOf(cp),
      category: categoryOf(cp),
      script: scriptOf(cp),
      width: widthOf(cp),
    })
  }
  return out
}

export function escapeJs(s: string): string {
  let out = ""
  for (const ch of s) {
    const cp = ch.codePointAt(0)!
    if (cp === 0x09) out += "\\t"
    else if (cp === 0x0a) out += "\\n"
    else if (cp === 0x0d) out += "\\r"
    else if (cp === 0x5c) out += "\\\\"
    else if (cp === 0x22) out += '\\"'
    else if (cp >= 0x20 && cp < 0x7f) out += ch
    else if (cp <= 0xffff) out += `\\u${cp.toString(16).padStart(4, "0")}`
    else out += `\\u{${cp.toString(16)}}`
  }
  return out
}

export function unescapeJs(s: string): string {
  let out = ""
  let i = 0
  while (i < s.length) {
    if (s[i] !== "\\") {
      out += s[i++]
      continue
    }
    i++
    const c = s[i++]
    if (c === "n") out += "\n"
    else if (c === "t") out += "\t"
    else if (c === "r") out += "\r"
    else if (c === "b") out += "\b"
    else if (c === "f") out += "\f"
    else if (c === "0") out += "\0"
    else if (c === "\\") out += "\\"
    else if (c === '"') out += '"'
    else if (c === "'") out += "'"
    else if (c === "x") {
      const hex = s.slice(i, i + 2)
      i += 2
      out += String.fromCharCode(parseInt(hex, 16))
    } else if (c === "u") {
      if (s[i] === "{") {
        const end = s.indexOf("}", i)
        const hex = s.slice(i + 1, end)
        i = end + 1
        out += String.fromCodePoint(parseInt(hex, 16))
      } else {
        const hex = s.slice(i, i + 4)
        i += 4
        out += String.fromCodePoint(parseInt(hex, 16))
      }
    } else {
      out += c
    }
  }
  return out
}

export function totalWidth(s: string): number {
  let w = 0
  for (const ch of s) w += widthOf(ch.codePointAt(0)!)
  return w
}

export function stripInvisible(s: string): string {
  let out = ""
  for (const ch of s) {
    const cp = ch.codePointAt(0)!
    if (!INVISIBLE_CODEPOINTS.has(cp)) out += ch
  }
  return out
}

export function isConfusable(a: string, b: string): boolean {
  if (a === b) return false
  return applyConfusables(a.normalize("NFKC")) === applyConfusables(b.normalize("NFKC"))
}

const done = (result: Tool.ExecuteResult<Metadata>) => result

export const UnicodeTool = Tool.define(
  "unicode",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Params, _ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const action = params.action
          const radix = params.radix ?? 16

          if (action === "info") {
            if (params.value === undefined) throw new Error("unicode.info: requires `value`")
            const r = unicodeInfo(params.value)
            return done({
              title: `unicode.info: ${r.codepoint_count} codepoints`,
              metadata: { action, result: r },
              output: JSON.stringify(r, null, 2),
            })
          }

          if (action === "codepoints") {
            if (params.value === undefined) throw new Error("unicode.codepoints: requires `value`")
            const r = listCodepoints(params.value, radix)
            return done({
              title: `unicode.codepoints: ${r.length}`,
              metadata: { action, result: r },
              output: JSON.stringify(r, null, 2),
            })
          }

          if (action === "to_codepoints") {
            if (params.value === undefined) throw new Error("unicode.to_codepoints: requires `value`")
            const r: number[] = []
            for (const ch of params.value) r.push(ch.codePointAt(0)!)
            return done({
              title: `unicode.to_codepoints: ${r.length}`,
              metadata: { action, result: r },
              output: r.map((cp) => "U+" + cp.toString(radix).toUpperCase().padStart(4, "0")).join(" "),
            })
          }

          if (action === "from_codepoints") {
            if (!params.codepoints || params.codepoints.length === 0)
              throw new Error("unicode.from_codepoints: requires `codepoints`")
            const r = String.fromCodePoint(...params.codepoints)
            return done({
              title: `unicode.from_codepoints: ${r.length} chars`,
              metadata: { action, result: r },
              output: r,
            })
          }

          if (action === "escape") {
            if (params.value === undefined) throw new Error("unicode.escape: requires `value`")
            const r = escapeJs(params.value)
            return done({ title: `unicode.escape`, metadata: { action, result: r }, output: r })
          }

          if (action === "unescape") {
            if (params.value === undefined) throw new Error("unicode.unescape: requires `value`")
            const r = unescapeJs(params.value)
            return done({ title: `unicode.unescape`, metadata: { action, result: r }, output: r })
          }

          if (action === "normalize") {
            if (params.value === undefined) throw new Error("unicode.normalize: requires `value`")
            const form = params.form ?? "NFC"
            const r = params.value.normalize(form)
            return done({ title: `unicode.normalize.${form}`, metadata: { action, result: r }, output: r })
          }

          if (action === "width") {
            if (params.value === undefined) throw new Error("unicode.width: requires `value`")
            const r = totalWidth(params.value)
            return done({ title: `unicode.width: ${r}`, metadata: { action, result: r }, output: String(r) })
          }

          if (action === "strip_invisible") {
            if (params.value === undefined) throw new Error("unicode.strip_invisible: requires `value`")
            const r = stripInvisible(params.value)
            return done({
              title: `unicode.strip_invisible: ${params.value.length - r.length} removed`,
              metadata: { action, result: r },
              output: r,
            })
          }

          if (action === "is_confusable") {
            if (params.a === undefined || params.b === undefined)
              throw new Error("unicode.is_confusable: requires `a` and `b`")
            const ok = isConfusable(params.a, params.b)
            const r = {
              confusable: ok,
              normalized_a: applyConfusables(params.a.normalize("NFKC")),
              normalized_b: applyConfusables(params.b.normalize("NFKC")),
            }
            return done({
              title: `unicode.is_confusable: ${ok}`,
              metadata: { action, result: r },
              output: JSON.stringify(r, null, 2),
            })
          }

          if (action === "count") {
            if (params.value === undefined) throw new Error("unicode.count: requires `value`")
            const cps: number[] = []
            for (const ch of params.value) cps.push(ch.codePointAt(0)!)
            const r = {
              chars: params.value.length,
              codepoints: cps.length,
              bytes_utf8: Buffer.byteLength(params.value, "utf8"),
              bytes_utf16: params.value.length * 2,
            }
            return done({
              title: `unicode.count: ${r.codepoints} cp / ${r.bytes_utf8}B utf8`,
              metadata: { action, result: r },
              output: JSON.stringify(r, null, 2),
            })
          }

          throw new Error(`unicode: unknown action '${action}'`)
        }),
    }
  }),
)

export const __testing = {
  unicodeInfo,
  listCodepoints,
  escapeJs,
  unescapeJs,
  totalWidth,
  stripInvisible,
  isConfusable,
  applyConfusables,
}
