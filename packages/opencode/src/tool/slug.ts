import { Effect, Schema } from "effect"
import DESCRIPTION from "./slug.txt"
import * as Tool from "./tool"

const ACTIONS = ["slugify", "unslugify", "breadcrumb", "info"] as const

const MAX_INPUT_LEN = 65_536
const MAX_LENGTH_CAP = 4096

export const Parameters = Schema.Struct({
  action: Schema.Literals(ACTIONS).annotate({ description: ACTIONS.join(" | ") }),
  text: Schema.String.check(Schema.isMinLength(0), Schema.isMaxLength(MAX_INPUT_LEN)).annotate({
    description: "Input text. For slugify/info: arbitrary string. For unslugify: a slug. For breadcrumb: a path-like string (slash, backslash, '>' or '|' separators).",
  }),
  separator: Schema.optional(Schema.String.check(Schema.isMaxLength(8))).annotate({
    description: "Separator between words. Default '-'. Use '_' for snake_case or '' to concatenate.",
  }),
  max_length: Schema.optional(
    Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(MAX_LENGTH_CAP)),
  ).annotate({
    description: "Optional max length for the slug. Truncates without splitting a separator.",
  }),
  preserve_case: Schema.optional(Schema.Boolean).annotate({
    description: "When true, keep the original casing. Default false.",
  }),
  allow_dot: Schema.optional(Schema.Boolean).annotate({
    description: "When true, '.' passes through (useful for filename slugs). Default false.",
  }),
  allow_slash: Schema.optional(Schema.Boolean).annotate({
    description: "When true, '/' passes through (breadcrumb mode sets this automatically). Default false for slugify.",
  }),
  transliterate: Schema.optional(Schema.Boolean).annotate({
    description: "Transliterate Latin diacritics to ASCII (é→e, ß→ss, æ→ae). Default true.",
  }),
  emoji: Schema.optional(Schema.Boolean).annotate({
    description: "Replace common emoji with their short names (🚀 → 'rocket'). Default false.",
  }),
})

type Params = Schema.Schema.Type<typeof Parameters>
type Action = (typeof ACTIONS)[number]

type Metadata = {
  action: Action
  slug?: string
  segments?: string[]
  separator?: string
  length?: number
  truncated?: boolean
  replaced?: number
}

const done = (result: Tool.ExecuteResult<Metadata>) => result

// ---------- transliteration map ----------

// Pragmatic Latin / common-symbol map. Keys are single characters that should
// be replaced by the value before normalisation. Characters not in this map
// fall through to the NFKD decomposition path which handles most diacritics.
const TRANSLIT: Record<string, string> = {
  ß: "ss",
  æ: "ae",
  Æ: "AE",
  œ: "oe",
  Œ: "OE",
  ø: "o",
  Ø: "O",
  ł: "l",
  Ł: "L",
  đ: "d",
  Đ: "D",
  ð: "d",
  Ð: "D",
  þ: "th",
  Þ: "TH",
  ª: "a",
  º: "o",
  "&": " and ",
  "@": " at ",
  "%": " percent ",
  "#": " hash ",
  "+": " plus ",
  "©": "(c)",
  "®": "(r)",
  "™": "(tm)",
  "€": " euro ",
  "£": " pound ",
  "¥": " yen ",
  $: " dollar ",
  "·": ".",
  "•": ".",
  "“": '"',
  "”": '"',
  "‘": "'",
  "’": "'",
  "–": "-",
  "—": "-",
  "…": "...",
}

const EMOJI_MAP: Record<string, string> = {
  "🚀": "rocket",
  "🔥": "fire",
  "⭐": "star",
  "✨": "sparkles",
  "💡": "bulb",
  "❤": "heart",
  "❤️": "heart",
  "💔": "broken-heart",
  "🎉": "party",
  "🎊": "confetti",
  "✅": "check",
  "✔": "check",
  "✔️": "check",
  "❌": "x",
  "⚠": "warning",
  "⚠️": "warning",
  "🐛": "bug",
  "🔒": "lock",
  "🔑": "key",
  "🌍": "earth",
  "🌎": "earth",
  "🌏": "earth",
  "📦": "package",
  "🚧": "construction",
  "🛠": "tools",
  "🛠️": "tools",
  "🧪": "test",
  "💻": "laptop",
  "📝": "memo",
  "📚": "books",
  "📷": "camera",
  "📸": "camera",
  "🎵": "music",
  "🎶": "music",
  "👍": "thumbs-up",
  "👎": "thumbs-down",
  "😀": "grinning",
  "😄": "smile",
  "😅": "sweat-smile",
  "😂": "joy",
  "🤣": "rofl",
  "😍": "heart-eyes",
  "🤔": "thinking",
  "😎": "cool",
  "🤖": "robot",
  "👻": "ghost",
  "💀": "skull",
  "🐳": "whale",
  "🐍": "snake",
  "🐙": "octopus",
  "☕": "coffee",
  "🍵": "tea",
  "🍕": "pizza",
}

function applyEmoji(s: string): { text: string; replaced: number } {
  let replaced = 0
  let out = s
  for (const [emoji, name] of Object.entries(EMOJI_MAP)) {
    if (out.includes(emoji)) {
      const count = out.split(emoji).length - 1
      out = out.split(emoji).join(` ${name} `)
      replaced += count
    }
  }
  return { text: out, replaced }
}

function applyTranslit(s: string): string {
  let out = ""
  for (const ch of s) out += TRANSLIT[ch] ?? ch
  // Decompose accented characters and strip combining marks.
  out = out.normalize("NFKD").replace(/[̀-ͯ]/g, "")
  return out
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function collapseSeparators(s: string, sep: string): string {
  if (!sep) return s
  const re = new RegExp(`${escapeRegex(sep)}{2,}`, "g")
  let out = s.replace(re, sep)
  // Trim leading/trailing separators.
  while (sep && out.startsWith(sep)) out = out.slice(sep.length)
  while (sep && out.endsWith(sep)) out = out.slice(0, -sep.length)
  return out
}

function truncateAtSeparator(s: string, sep: string, maxLen: number): { text: string; truncated: boolean } {
  if (s.length <= maxLen) return { text: s, truncated: false }
  if (!sep) return { text: s.slice(0, maxLen), truncated: true }
  const cut = s.slice(0, maxLen)
  const lastSep = cut.lastIndexOf(sep)
  if (lastSep <= 0) return { text: cut, truncated: true }
  return { text: cut.slice(0, lastSep), truncated: true }
}

function buildKeepSet(opts: {
  separator: string
  allowDot: boolean
  allowSlash: boolean
}) {
  // Always keep [a-zA-Z0-9] and the separator chars themselves.
  const extra: string[] = []
  if (opts.allowDot) extra.push("\\.")
  if (opts.allowSlash) extra.push("/")
  const sepChars = [...opts.separator].map(escapeRegex)
  const allowed = new Set<string>([
    ...sepChars,
    ...extra,
  ])
  // Build a regex of allowed extras in addition to alphanumerics.
  const extraClass = [...allowed].join("")
  return new RegExp(`[^a-zA-Z0-9${extraClass}]+`, "g")
}

export function slugify(
  input: string,
  opts: {
    separator?: string
    max_length?: number
    preserve_case?: boolean
    allow_dot?: boolean
    allow_slash?: boolean
    transliterate?: boolean
    emoji?: boolean
  } = {},
): { slug: string; truncated: boolean; replaced: number } {
  const separator = opts.separator ?? "-"
  const allowDot = !!opts.allow_dot
  const allowSlash = !!opts.allow_slash
  const transliterate = opts.transliterate ?? true
  const emoji = !!opts.emoji

  let text = input
  let replaced = 0

  if (emoji) {
    const r = applyEmoji(text)
    text = r.text
    replaced += r.replaced
  }

  if (transliterate) text = applyTranslit(text)

  // Drop remaining non-ASCII so we don't surprise users with weird codepoints.
  text = text.replace(/[^\x00-\x7F]/g, "")

  if (!opts.preserve_case) text = text.toLowerCase()

  const drop = buildKeepSet({ separator, allowDot, allowSlash })
  text = text.replace(drop, separator)

  text = collapseSeparators(text, separator)

  let truncated = false
  if (opts.max_length !== undefined) {
    const r = truncateAtSeparator(text, separator, opts.max_length)
    text = collapseSeparators(r.text, separator)
    truncated = r.truncated
  }

  return { slug: text, truncated, replaced }
}

function unslugify(s: string, opts: { separator?: string } = {}): string {
  const sep = opts.separator ?? "-"
  if (!sep) return s
  // Replace all separator runs with a space, then title-case.
  const cleaned = s.split(new RegExp(`${escapeRegex(sep)}+`)).filter(Boolean).join(" ")
  return cleaned.replace(/\b\w/g, (c) => c.toUpperCase())
}

function breadcrumb(s: string, opts: Parameters<typeof slugify>[1] = {}): string[] {
  // Common nested separators: '/', '\\', ' > ', '>', '|', '»'
  const parts = s.split(/\s*(?:>|»|\|)\s*|[\\/]+/g)
  const segs = parts.map((p) => slugify(p, { ...opts, allow_slash: false }).slug).filter(Boolean)
  return segs
}

// ---------- tool ----------

export const SlugTool = Tool.define(
  "slug",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Params, _ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const action = params.action
          const sep = params.separator ?? "-"

          if (action === "slugify") {
            const { slug, truncated, replaced } = slugify(params.text, {
              separator: sep,
              max_length: params.max_length,
              preserve_case: params.preserve_case,
              allow_dot: params.allow_dot,
              allow_slash: params.allow_slash,
              transliterate: params.transliterate,
              emoji: params.emoji,
            })
            return done({
              title: `slug: ${slug.slice(0, 60)}${slug.length > 60 ? "..." : ""}`,
              metadata: {
                action,
                slug,
                separator: sep,
                length: slug.length,
                truncated,
                replaced,
              },
              output: slug,
            })
          }

          if (action === "unslugify") {
            const out = unslugify(params.text, { separator: sep })
            return done({
              title: `unslug: ${out.slice(0, 60)}${out.length > 60 ? "..." : ""}`,
              metadata: { action, slug: out, separator: sep, length: out.length },
              output: out,
            })
          }

          if (action === "breadcrumb") {
            const segs = breadcrumb(params.text, {
              separator: sep,
              max_length: params.max_length,
              preserve_case: params.preserve_case,
              transliterate: params.transliterate,
              emoji: params.emoji,
              allow_dot: params.allow_dot,
            })
            const joined = segs.join("/")
            return done({
              title: `breadcrumb: ${joined.slice(0, 60)}${joined.length > 60 ? "..." : ""}`,
              metadata: {
                action,
                slug: joined,
                segments: segs,
                separator: sep,
                length: joined.length,
              },
              output: joined,
            })
          }

          if (action === "info") {
            const { slug, truncated, replaced } = slugify(params.text, {
              separator: sep,
              max_length: params.max_length,
              preserve_case: params.preserve_case,
              allow_dot: params.allow_dot,
              allow_slash: params.allow_slash,
              transliterate: params.transliterate,
              emoji: params.emoji,
            })
            const segments = sep ? slug.split(sep).filter(Boolean) : [slug].filter(Boolean)
            const lines = [
              `slug:       ${slug}`,
              `length:     ${slug.length}`,
              `segments:   ${segments.length}`,
              `separator:  '${sep}'`,
              `truncated:  ${truncated}`,
              `replaced:   ${replaced}`,
            ]
            return done({
              title: `slug.info: ${slug.length} chars / ${segments.length} segs`,
              metadata: {
                action,
                slug,
                segments,
                separator: sep,
                length: slug.length,
                truncated,
                replaced,
              },
              output: lines.join("\n"),
            })
          }

          throw new Error(`slug: unknown action ${action satisfies never}`)
        }),
    }
  }),
)

export const __testing = {
  slugify,
  unslugify,
  breadcrumb,
  applyTranslit,
  applyEmoji,
  collapseSeparators,
  truncateAtSeparator,
}
