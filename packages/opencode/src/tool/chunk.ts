import { Effect, Schema } from "effect"
import DESCRIPTION from "./chunk.txt"
import * as Tool from "./tool"

const ACTIONS = ["chars", "lines", "words", "tokens", "paragraphs", "bytes", "count"] as const

export const Parameters = Schema.Struct({
  action: Schema.Literals(ACTIONS).annotate({ description: ACTIONS.join(" | ") }),
  text: Schema.String.check(Schema.isMaxLength(5_000_000)).annotate({
    description: "Input text. Cap 5,000,000 chars.",
  }),
  size: Schema.optional(Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1))).annotate({
    description: "Chunk size in the unit chosen by action. Required for actions other than 'count'.",
  }),
  overlap: Schema.optional(Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))).annotate({
    description: "Overlap in the same unit. Must be < size. Default 0.",
  }),
  keep_separator: Schema.optional(Schema.Boolean).annotate({
    description: "For lines/paragraphs: include the original separator at chunk boundaries. Default true.",
  }),
  trim: Schema.optional(Schema.Boolean).annotate({
    description: "Trim whitespace from each chunk. Default false.",
  }),
  limit: Schema.optional(
    Schema.Number.check(Schema.isInt())
      .check(Schema.isGreaterThanOrEqualTo(1))
      .check(Schema.isLessThanOrEqualTo(100_000)),
  ).annotate({
    description: "Maximum number of chunks to return. Default 10000.",
  }),
})

type Params = Schema.Schema.Type<typeof Parameters>
type Action = (typeof ACTIONS)[number]

type ChunkOut = { index: number; start: number; end: number; length: number; text: string }

type Metadata = {
  action: Action
  unit?: Action
  size?: number
  overlap?: number
  total_length?: number
  chunk_count?: number
  truncated?: boolean
  chars?: number
  lines?: number
  words?: number
  tokens_est?: number
  paragraphs?: number
  bytes_utf8?: number
}

const done = (result: Tool.ExecuteResult<Metadata>) => result

const CAPS: Record<Exclude<Action, "count">, number> = {
  chars: 200_000,
  lines: 10_000,
  words: 50_000,
  tokens: 200_000,
  paragraphs: 1_000,
  bytes: 1_000_000,
}

function clampSize(action: Exclude<Action, "count">, size: number): number {
  const cap = CAPS[action]
  if (size > cap) throw new Error(`chunk.${action}: size cap is ${cap}`)
  return size
}

function maybeTrim(s: string, trim: boolean): string {
  return trim ? s.trim() : s
}

function chunkChars(text: string, size: number, overlap: number, trim: boolean, limit: number): ChunkOut[] {
  if (overlap >= size) throw new Error("chunk: overlap must be < size")
  const out: ChunkOut[] = []
  let i = 0
  let idx = 0
  while (i < text.length) {
    const end = Math.min(text.length, i + size)
    const slice = maybeTrim(text.slice(i, end), trim)
    out.push({ index: idx, start: i, end, length: slice.length, text: slice })
    idx++
    if (out.length >= limit) break
    if (end >= text.length) break
    i = end - overlap
  }
  return out
}

function chunkLines(
  text: string,
  size: number,
  overlap: number,
  keepSep: boolean,
  trim: boolean,
  limit: number,
): ChunkOut[] {
  if (overlap >= size) throw new Error("chunk: overlap must be < size")
  // Split keeping line breaks attached to the lines so we can rebuild verbatim.
  const lines: { text: string; sep: string }[] = []
  let cursor = 0
  while (cursor < text.length) {
    const m = /\r\n|\n|\r/.exec(text.slice(cursor))
    if (!m) {
      lines.push({ text: text.slice(cursor), sep: "" })
      break
    }
    const lineEnd = cursor + m.index
    lines.push({ text: text.slice(cursor, lineEnd), sep: m[0] })
    cursor = lineEnd + m[0].length
  }
  const out: ChunkOut[] = []
  let i = 0
  let idx = 0
  while (i < lines.length) {
    const end = Math.min(lines.length, i + size)
    const seg = lines.slice(i, end)
    const reconstructed = seg
      .map((l, j) => {
        if (keepSep) return l.text + l.sep
        // Drop separator unless it's the final line of the file (no sep)
        return l.text
      })
      .join(keepSep ? "" : "\n")
    const start = lineCharOffset(text, lines, i)
    const endChar = lineCharOffset(text, lines, end)
    const sliceText = maybeTrim(reconstructed, trim)
    out.push({ index: idx, start, end: endChar, length: end - i, text: sliceText })
    idx++
    if (out.length >= limit) break
    if (end >= lines.length) break
    i = end - overlap
  }
  return out
}

function lineCharOffset(text: string, lines: { text: string; sep: string }[], lineIndex: number): number {
  let off = 0
  for (let k = 0; k < lineIndex && k < lines.length; k++) off += lines[k].text.length + lines[k].sep.length
  return Math.min(off, text.length)
}

function chunkWords(text: string, size: number, overlap: number, trim: boolean, limit: number): ChunkOut[] {
  if (overlap >= size) throw new Error("chunk: overlap must be < size")
  // Match each word + the whitespace that follows so we can reconstruct.
  const tokens: { word: string; trailing: string; start: number }[] = []
  const re = /(\S+)(\s*)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    tokens.push({ word: m[1], trailing: m[2], start: m.index })
  }
  const out: ChunkOut[] = []
  let i = 0
  let idx = 0
  while (i < tokens.length) {
    const end = Math.min(tokens.length, i + size)
    const seg = tokens.slice(i, end)
    const start = seg[0].start
    const last = seg[seg.length - 1]
    const sliceEndChar = last.start + last.word.length
    const reconstructed = seg.map((t, j) => (j === seg.length - 1 ? t.word : t.word + t.trailing)).join("")
    out.push({
      index: idx,
      start,
      end: sliceEndChar,
      length: end - i,
      text: maybeTrim(reconstructed, trim),
    })
    idx++
    if (out.length >= limit) break
    if (end >= tokens.length) break
    i = end - overlap
  }
  return out
}

function estimateTokens(s: string): number {
  if (s.length === 0) return 0
  const charsEst = Math.ceil(s.length / 4)
  const words = s.match(/\S+/g)
  const wordsEst = Math.ceil((words?.length ?? 0) * 0.75)
  return Math.max(charsEst, wordsEst, 1)
}

function chunkTokens(text: string, size: number, overlap: number, trim: boolean, limit: number): ChunkOut[] {
  // Build a plausible char-budget per chunk: ~4 chars/token. Allow growth if word boundaries push us over slightly.
  if (overlap >= size) throw new Error("chunk: overlap must be < size")
  const charBudget = Math.max(4, size * 4)
  const charOverlap = Math.max(0, overlap * 4)
  const re = /(\S+)(\s*)/g
  const tokens: { word: string; trailing: string; start: number; end: number }[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const start = m.index
    const end = start + m[1].length + m[2].length
    tokens.push({ word: m[1], trailing: m[2], start, end })
  }
  if (tokens.length === 0) {
    return text.length > 0
      ? [{ index: 0, start: 0, end: text.length, length: estimateTokens(text), text: maybeTrim(text, trim) }]
      : []
  }
  const out: ChunkOut[] = []
  let i = 0
  let idx = 0
  while (i < tokens.length) {
    let chars = 0
    let j = i
    while (j < tokens.length && chars + tokens[j].word.length + (j > i ? tokens[j - 1].trailing.length : 0) <= charBudget) {
      chars += tokens[j].word.length + (j > i ? tokens[j - 1].trailing.length : 0)
      j++
    }
    if (j === i) j = i + 1 // Always advance even on a single oversized word.
    const seg = tokens.slice(i, j)
    const start = seg[0].start
    const last = seg[seg.length - 1]
    const endChar = last.start + last.word.length
    const reconstructed = seg.map((t, k) => (k === seg.length - 1 ? t.word : t.word + t.trailing)).join("")
    const tokensEst = estimateTokens(reconstructed)
    out.push({ index: idx, start, end: endChar, length: tokensEst, text: maybeTrim(reconstructed, trim) })
    idx++
    if (out.length >= limit) break
    if (j >= tokens.length) break
    // Move back by ~charOverlap chars worth of words.
    let back = 0
    let bi = j
    while (bi > i + 1 && back < charOverlap) {
      bi--
      back += tokens[bi].word.length + (bi < tokens.length - 1 ? tokens[bi].trailing.length : 0)
    }
    i = bi
  }
  return out
}

function chunkParagraphs(
  text: string,
  size: number,
  overlap: number,
  keepSep: boolean,
  trim: boolean,
  limit: number,
): ChunkOut[] {
  if (overlap >= size) throw new Error("chunk: overlap must be < size")
  // Paragraphs = runs separated by blank lines.
  const paragraphs: { text: string; sep: string; start: number }[] = []
  const re = /([\s\S]*?)(\n[ \t]*\n+|$)/g
  let m: RegExpExecArray | null
  let cursor = 0
  while (cursor < text.length && (m = re.exec(text)) !== null) {
    if (m.index < cursor) break
    const body = m[1]
    const sep = m[2]
    const start = m.index
    if (body.length === 0 && sep.length === 0) break
    paragraphs.push({ text: body, sep, start })
    cursor = re.lastIndex
    if (sep.length === 0) break
  }
  const out: ChunkOut[] = []
  let i = 0
  let idx = 0
  while (i < paragraphs.length) {
    const end = Math.min(paragraphs.length, i + size)
    const seg = paragraphs.slice(i, end)
    const start = seg[0].start
    const last = seg[seg.length - 1]
    const endChar = last.start + last.text.length + last.sep.length
    const joined = seg
      .map((p, k) => (k === seg.length - 1 ? p.text + (keepSep ? p.sep : "") : p.text + (keepSep ? p.sep : "\n\n")))
      .join("")
    out.push({ index: idx, start, end: endChar, length: end - i, text: maybeTrim(joined, trim) })
    idx++
    if (out.length >= limit) break
    if (end >= paragraphs.length) break
    i = end - overlap
  }
  return out
}

function chunkBytes(text: string, size: number, overlap: number, trim: boolean, limit: number): ChunkOut[] {
  if (overlap >= size) throw new Error("chunk: overlap must be < size")
  const enc = new TextEncoder()
  const dec = new TextDecoder("utf-8", { fatal: false })
  const bytes = enc.encode(text)
  const out: ChunkOut[] = []
  let i = 0
  let idx = 0
  const isContinuation = (byte: number) => (byte & 0xc0) === 0x80
  while (i < bytes.length) {
    let end = Math.min(bytes.length, i + size)
    // Backtrack to a codepoint boundary: bytes 0x80..0xBF are continuation bytes.
    while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--
    if (end === i) {
      // If size is smaller than the current codepoint, include the whole codepoint instead of emitting
      // an empty chunk or a replacement character.
      end = Math.min(bytes.length, i + 1)
      while (end < bytes.length && isContinuation(bytes[end])) end++
    }
    const sliceBytes = bytes.subarray(i, end)
    const decoded = dec.decode(sliceBytes)
    const trimmed = maybeTrim(decoded, trim)
    // Char offsets are tricky here: decode the prefix to know where this chunk starts in chars.
    const startChar = dec.decode(bytes.subarray(0, i)).length
    const endChar = startChar + decoded.length
    out.push({ index: idx, start: startChar, end: endChar, length: sliceBytes.length, text: trimmed })
    idx++
    if (out.length >= limit) break
    if (end >= bytes.length) break
    i = Math.max(end - overlap, i + 1)
    while (i < bytes.length && isContinuation(bytes[i])) i++
  }
  return out
}

function countAll(text: string): {
  chars: number
  lines: number
  words: number
  tokens_est: number
  paragraphs: number
  bytes_utf8: number
} {
  const chars = text.length
  // line count = number of line breaks + 1, except for empty input which is 0.
  const lines = chars === 0 ? 0 : (text.match(/\n/g)?.length ?? 0) + 1
  const words = (text.match(/\S+/g) ?? []).length
  const tokens_est = estimateTokens(text)
  // paragraphs separated by 1+ blank lines
  const paragraphs = chars === 0 ? 0 : text.split(/\n[ \t]*\n+/).filter((p) => p.trim().length > 0).length
  const bytes_utf8 = new TextEncoder().encode(text).length
  return { chars, lines, words, tokens_est, paragraphs, bytes_utf8 }
}

export const ChunkTool = Tool.define(
  "chunk",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Params, _ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const action = params.action
          const trim = params.trim ?? false
          const keepSep = params.keep_separator ?? true
          const limit = params.limit ?? 10_000

          if (action === "count") {
            const c = countAll(params.text)
            const out = [
              `chars: ${c.chars}`,
              `lines: ${c.lines}`,
              `words: ${c.words}`,
              `tokens_est: ${c.tokens_est}`,
              `paragraphs: ${c.paragraphs}`,
              `bytes_utf8: ${c.bytes_utf8}`,
            ].join("\n")
            return done({
              title: `chunk.count chars=${c.chars} tokens~${c.tokens_est}`,
              metadata: { action, ...c },
              output: out,
            })
          }

          if (params.size === undefined) {
            throw new Error(`chunk.${action}: size is required`)
          }
          const size = clampSize(action, params.size)
          const overlap = params.overlap ?? 0

          let chunks: ChunkOut[]
          let totalLen: number
          switch (action) {
            case "chars":
              chunks = chunkChars(params.text, size, overlap, trim, limit)
              totalLen = params.text.length
              break
            case "lines":
              chunks = chunkLines(params.text, size, overlap, keepSep, trim, limit)
              totalLen = countAll(params.text).lines
              break
            case "words":
              chunks = chunkWords(params.text, size, overlap, trim, limit)
              totalLen = countAll(params.text).words
              break
            case "tokens":
              chunks = chunkTokens(params.text, size, overlap, trim, limit)
              totalLen = countAll(params.text).tokens_est
              break
            case "paragraphs":
              chunks = chunkParagraphs(params.text, size, overlap, keepSep, trim, limit)
              totalLen = countAll(params.text).paragraphs
              break
            case "bytes":
              chunks = chunkBytes(params.text, size, overlap, trim, limit)
              totalLen = new TextEncoder().encode(params.text).length
              break
            default:
              throw new Error(`chunk: unknown action ${action satisfies never}`)
          }

          const truncated = chunks.length >= limit && totalLen > 0 && chunks[chunks.length - 1]?.end < params.text.length
          return done({
            title: `chunk.${action} ${chunks.length} chunks (size=${size}, overlap=${overlap})`,
            metadata: {
              action,
              unit: action,
              size,
              overlap,
              total_length: totalLen,
              chunk_count: chunks.length,
              truncated,
            },
            output: JSON.stringify(chunks, null, 2),
          })
        }),
    }
  }),
)

export const __testing = {
  chunkChars,
  chunkLines,
  chunkWords,
  chunkTokens,
  chunkParagraphs,
  chunkBytes,
  countAll,
  estimateTokens,
}
