import { Effect, Schema } from "effect"
import DESCRIPTION from "./lorem.txt"
import * as Tool from "./tool"

const ACTIONS = ["words", "sentences", "paragraphs", "bytes", "slug", "title"] as const

export const Parameters = Schema.Struct({
  action: Schema.Literals(ACTIONS).annotate({ description: ACTIONS.join(" | ") }),
  n: Schema.optional(Schema.Number).annotate({
    description: "Count argument; meaning depends on action (words/sentences/paragraphs/bytes/slug words/title words).",
  }),
  seed: Schema.optional(Schema.Number).annotate({
    description: "Integer seed for deterministic output. When unset, output uses Math.random().",
  }),
  start_with_lorem: Schema.optional(Schema.Boolean).annotate({
    description: "If true (default), sentences/paragraphs begin with the canonical 'Lorem ipsum...' opening sentence.",
  }),
  min_words_per_sentence: Schema.optional(Schema.Number).annotate({
    description: "Lower bound for words/sentence (default 4).",
  }),
  max_words_per_sentence: Schema.optional(Schema.Number).annotate({
    description: "Upper bound for words/sentence (default 12).",
  }),
  min_sentences_per_paragraph: Schema.optional(Schema.Number).annotate({
    description: "Lower bound for sentences/paragraph (default 3).",
  }),
  max_sentences_per_paragraph: Schema.optional(Schema.Number).annotate({
    description: "Upper bound for sentences/paragraph (default 7).",
  }),
  paragraph_sep: Schema.optional(Schema.String).annotate({
    description: "Separator between paragraphs (default '\\n\\n').",
  }),
})

type Params = Schema.Schema.Type<typeof Parameters>
type Action = (typeof ACTIONS)[number]

type Metadata = {
  action: Action
  word_count?: number
  byte_count?: number
  sentence_count?: number
  paragraph_count?: number
}

const done = (result: Tool.ExecuteResult<Metadata>) => result

// Curated lorem-ipsum word list. Roughly 250 words, all-lowercase, ASCII.
const WORDS = `lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua enim ad minim veniam quis nostrud exercitation ullamco laboris nisi aliquip ex ea commodo consequat duis aute irure in reprehenderit voluptate velit esse cillum eu fugiat nulla pariatur excepteur sint occaecat cupidatat non proident sunt culpa qui officia deserunt mollit anim id est laborum at vero eos accusamus iusto odio dignissimos ducimus blanditiis praesentium voluptatum deleniti atque corrupti quos dolores quas molestias excepturi obcaecati cupiditate provident similique mollitia animi laborum dolorum fuga harum quidem rerum facilis expedita distinctio nam libero tempore cum soluta nobis eligendi optio cumque impedit minus quod maxime placeat facere possimus omnis voluptas assumenda repellendus temporibus autem quibusdam debitis necessitatibus saepe eveniet ut et voluptates repudiandae sint molestiae recusandae itaque earum rerum hic tenetur a sapiente delectus reiciendis voluptatibus maiores alias perferendis doloribus asperiores repellat neque porro quisquam dolorem suscipit quaerat magnam veritatis eaque ipsa architecto beatae vitae dicta sunt explicabo nemo enim ipsam quia voluptas aspernatur aut odit consequuntur magni totam rem aperiam unde omnis iste natus error fugit accusantium doloremque laudantium consequatur quia nesciunt porro voluptatem sequi adipisci numquam eius modi tempora incidunt magnam aliquam quaerat`
  .split(/\s+/)
  .filter(Boolean)

const CANONICAL_OPENING = "Lorem ipsum dolor sit amet, consectetur adipiscing elit."

// Mulberry32 PRNG: deterministic, fast, good distribution for 32-bit seeds.
function mulberry32(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function makeRng(seed?: number): () => number {
  if (seed === undefined) return Math.random
  if (!Number.isFinite(seed)) throw new Error("lorem: seed must be finite")
  return mulberry32(Math.trunc(seed))
}

function pick<T>(arr: readonly T[], rng: () => number): T {
  return arr[Math.floor(rng() * arr.length)]
}

function intRange(rng: () => number, lo: number, hi: number): number {
  if (hi < lo) [lo, hi] = [hi, lo]
  return lo + Math.floor(rng() * (hi - lo + 1))
}

function capitalize(s: string): string {
  if (!s) return s
  return s[0].toUpperCase() + s.slice(1)
}

function generateWords(n: number, rng: () => number): string[] {
  if (n < 0 || !Number.isInteger(n)) throw new Error("lorem.words: n must be a non-negative integer")
  if (n > 2000) throw new Error("lorem.words: cap is 2000")
  const out: string[] = []
  for (let i = 0; i < n; i++) out.push(pick(WORDS, rng))
  return out
}

function generateSentence(rng: () => number, minW: number, maxW: number): string {
  const len = intRange(rng, minW, maxW)
  const words = generateWords(len, rng)
  // Insert occasional commas for naturalness when length >= 7.
  if (len >= 7 && rng() < 0.5) {
    const commaAt = intRange(rng, 2, len - 3)
    words[commaAt] = words[commaAt] + ","
  }
  return capitalize(words.join(" ")) + "."
}

function generateSentences(n: number, rng: () => number, opts: { minW: number; maxW: number; canonical: boolean }): string[] {
  if (n < 0 || !Number.isInteger(n)) throw new Error("lorem.sentences: n must be a non-negative integer")
  if (n > 500) throw new Error("lorem.sentences: cap is 500")
  if (opts.minW < 1) throw new Error("lorem: min_words_per_sentence must be >= 1")
  if (opts.maxW < opts.minW) throw new Error("lorem: max_words_per_sentence must be >= min_words_per_sentence")
  if (opts.maxW > 100) throw new Error("lorem: max_words_per_sentence cap is 100")
  const out: string[] = []
  for (let i = 0; i < n; i++) {
    if (i === 0 && opts.canonical) out.push(CANONICAL_OPENING)
    else out.push(generateSentence(rng, opts.minW, opts.maxW))
  }
  return out
}

function generateParagraphs(
  n: number,
  rng: () => number,
  opts: { minW: number; maxW: number; minS: number; maxS: number; canonical: boolean; sep: string },
): string {
  if (n < 0 || !Number.isInteger(n)) throw new Error("lorem.paragraphs: n must be a non-negative integer")
  if (n > 100) throw new Error("lorem.paragraphs: cap is 100")
  if (opts.minS < 1) throw new Error("lorem: min_sentences_per_paragraph must be >= 1")
  if (opts.maxS < opts.minS) throw new Error("lorem: max_sentences_per_paragraph must be >= min_sentences_per_paragraph")
  if (opts.maxS > 100) throw new Error("lorem: max_sentences_per_paragraph cap is 100")
  const paras: string[] = []
  for (let i = 0; i < n; i++) {
    const sCount = intRange(rng, opts.minS, opts.maxS)
    const isFirst = i === 0
    const sentences = generateSentences(sCount, rng, {
      minW: opts.minW,
      maxW: opts.maxW,
      canonical: isFirst && opts.canonical,
    })
    paras.push(sentences.join(" "))
  }
  return paras.join(opts.sep)
}

function generateBytes(target: number, rng: () => number): string {
  if (target < 0 || !Number.isInteger(target)) throw new Error("lorem.bytes: n must be a non-negative integer")
  if (target > 200_000) throw new Error("lorem.bytes: cap is 200000")
  const parts: string[] = []
  let bytes = 0
  while (bytes < target) {
    const w = pick(WORDS, rng)
    const len = w.length + (parts.length ? 1 : 0) // +1 for joining space
    if (bytes + len > target) break
    parts.push(w)
    bytes += len
  }
  return parts.join(" ")
}

function generateSlug(n: number, rng: () => number): string {
  if (n < 1 || !Number.isInteger(n)) throw new Error("lorem.slug: n must be a positive integer")
  if (n > 12) throw new Error("lorem.slug: cap is 12")
  return generateWords(n, rng).join("-")
}

function generateTitle(n: number, rng: () => number): string {
  if (n < 1 || !Number.isInteger(n)) throw new Error("lorem.title: n must be a positive integer")
  if (n > 12) throw new Error("lorem.title: cap is 12")
  // Capitalize each word; common short words stay lowercase except first/last.
  const small = new Set(["of", "and", "in", "on", "the", "a", "an", "to", "for", "or", "at", "by"])
  const words = generateWords(n, rng).map((w) => w.toLowerCase())
  return words
    .map((w, i) => {
      if (i === 0 || i === words.length - 1) return capitalize(w)
      return small.has(w) ? w : capitalize(w)
    })
    .join(" ")
}

export const LoremTool = Tool.define(
  "lorem",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Params, _ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const action = params.action
          const rng = makeRng(params.seed)
          const canonical = params.start_with_lorem ?? true
          const minW = params.min_words_per_sentence ?? 4
          const maxW = params.max_words_per_sentence ?? 12
          const minS = params.min_sentences_per_paragraph ?? 3
          const maxS = params.max_sentences_per_paragraph ?? 7
          const sep = params.paragraph_sep ?? "\n\n"

          if (action === "words") {
            const n = params.n ?? 50
            const arr = generateWords(n, rng)
            const out = arr.join(" ")
            return done({
              title: `lorem.words ${n}`,
              metadata: { action, word_count: arr.length, byte_count: out.length },
              output: out,
            })
          }

          if (action === "sentences") {
            const n = params.n ?? 5
            const arr = generateSentences(n, rng, { minW, maxW, canonical })
            const out = arr.join(" ")
            return done({
              title: `lorem.sentences ${n}`,
              metadata: { action, sentence_count: arr.length, byte_count: out.length },
              output: out,
            })
          }

          if (action === "paragraphs") {
            const n = params.n ?? 3
            const out = generateParagraphs(n, rng, { minW, maxW, minS, maxS, canonical, sep })
            return done({
              title: `lorem.paragraphs ${n}`,
              metadata: { action, paragraph_count: n, byte_count: out.length },
              output: out,
            })
          }

          if (action === "bytes") {
            const n = params.n ?? 1024
            const out = generateBytes(n, rng)
            return done({
              title: `lorem.bytes ${out.length}/${n}`,
              metadata: { action, byte_count: out.length, word_count: out ? out.split(/\s+/).length : 0 },
              output: out,
            })
          }

          if (action === "slug") {
            const n = params.n ?? 4
            const out = generateSlug(n, rng)
            return done({
              title: `lorem.slug ${n}`,
              metadata: { action, word_count: n, byte_count: out.length },
              output: out,
            })
          }

          if (action === "title") {
            const n = params.n ?? 5
            const out = generateTitle(n, rng)
            return done({
              title: `lorem.title ${n}`,
              metadata: { action, word_count: n, byte_count: out.length },
              output: out,
            })
          }

          throw new Error(`lorem: unknown action ${action satisfies never}`)
        }),
    }
  }),
)

export const __testing = {
  generateWords,
  generateSentence,
  generateSentences,
  generateParagraphs,
  generateBytes,
  generateSlug,
  generateTitle,
  mulberry32,
  WORDS,
  CANONICAL_OPENING,
}
