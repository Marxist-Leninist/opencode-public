import { Effect, Schema } from "effect"
import { readFile, writeFile } from "node:fs/promises"
import * as path from "node:path"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Instance } from "../project/instance"
import { assertExternalDirectoryEffect } from "./external-directory"
import DESCRIPTION from "./markdown.txt"
import * as Tool from "./tool"

const ACTIONS = [
  "outline",
  "headings",
  "links",
  "images",
  "code_blocks",
  "table_of_contents",
  "to_plain",
  "extract_section",
  "stats",
] as const
const FORMATS = ["text", "json"] as const
const MAX_INPUT_BYTES = 8 * 1024 * 1024
const MAX_OUTPUT_CHARS = 16_000

export const Parameters = Schema.Struct({
  action: Schema.Literals(ACTIONS).annotate({
    description:
      "outline/headings, links, images, code_blocks, table_of_contents, to_plain, extract_section (needs slug or heading_text), stats.",
  }),
  content: Schema.optional(Schema.String).annotate({
    description: "Inline Markdown text. Required if filePath is not given.",
  }),
  filePath: Schema.optional(Schema.String).annotate({
    description: "Read Markdown from this file. Absolute or project-relative.",
  }),
  output_path: Schema.optional(Schema.String).annotate({
    description: "Write the result to this file instead of returning inline.",
  }),
  slug: Schema.optional(Schema.String).annotate({
    description: "Kebab-case slug for extract_section.",
  }),
  heading_text: Schema.optional(Schema.String).annotate({
    description: "Heading text (exact match, case-insensitive) for extract_section.",
  }),
  include_line_numbers: Schema.optional(Schema.Boolean).annotate({
    description: "Include 1-based line numbers in structured outputs. Default true.",
  }),
  format: Schema.optional(Schema.Literals(FORMATS)).annotate({
    description: "'text' (default) or 'json' for machine-readable output.",
  }),
})

type Params = Schema.Schema.Type<typeof Parameters>
type Action = (typeof ACTIONS)[number]
type FormatMode = (typeof FORMATS)[number]

type Heading = { level: number; text: string; slug: string; line: number }
type LinkRef = { text: string; href: string; title?: string; line: number }
type ImageRef = { alt: string; src: string; title?: string; line: number }
type CodeBlock = { language: string; content: string; line: number }

type Metadata = {
  action: Action
  filePath?: string
  output_path?: string
  bytes_in?: number
  bytes_out?: number
  count?: number
  elapsed_ms?: number
}

const done = (result: Tool.ExecuteResult<Metadata>) => result

function truncate(s: string): string {
  if (s.length <= MAX_OUTPUT_CHARS) return s
  return s.slice(0, MAX_OUTPUT_CHARS) + `\n... [truncated ${s.length - MAX_OUTPUT_CHARS} chars]`
}

// Strip combining diacritical marks (U+0300–U+036F) so headings like
// "Café résumé" → "cafe-resume". Using \u escapes keeps the source ASCII-only.
const COMBINING_DIACRITICS_RE = /[̀-ͯ]/g

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFKD")
    .replace(COMBINING_DIACRITICS_RE, "")
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
}

type LineKind =
  | { kind: "heading"; level: number; text: string; line: number }
  | { kind: "code_fence"; language: string; line: number; fenceLen: number; fenceChar: "`" | "~"; content: string[]; endLine?: number }
  | { kind: "text"; raw: string; line: number }

export function tokenize(md: string): LineKind[] {
  const lines = md.split(/\r?\n/)
  const tokens: LineKind[] = []
  let i = 0
  while (i < lines.length) {
    const raw = lines[i]!
    const fence = /^( {0,3})(`{3,}|~{3,})\s*([^\s`~]+)?/.exec(raw)
    if (fence) {
      const fenceChar = fence[2]!.startsWith("`") ? "`" : "~"
      const fenceLen = fence[2]!.length
      const language = fence[3] ?? ""
      const startLine = i + 1
      const content: string[] = []
      i++
      while (i < lines.length) {
        const closing = new RegExp(`^( {0,3})${fenceChar === "`" ? "`" : "~"}{${fenceLen},}\\s*$`).exec(lines[i]!)
        if (closing) {
          tokens.push({
            kind: "code_fence",
            language,
            line: startLine,
            fenceLen,
            fenceChar,
            content,
            endLine: i + 1,
          })
          i++
          break
        }
        content.push(lines[i]!)
        i++
        if (i === lines.length) {
          // Unterminated; close gracefully.
          tokens.push({
            kind: "code_fence",
            language,
            line: startLine,
            fenceLen,
            fenceChar,
            content,
            endLine: i,
          })
        }
      }
      continue
    }
    const atx = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(raw)
    if (atx) {
      tokens.push({ kind: "heading", level: atx[1]!.length, text: atx[2]!.trim(), line: i + 1 })
      i++
      continue
    }
    // Setext heading: a non-empty line followed by ===… or ---… of length >= 1
    if (i + 1 < lines.length) {
      const next = lines[i + 1]!
      const setext = /^( {0,3})(=+|-+)\s*$/.exec(next)
      if (setext && raw.trim().length > 0 && !/^[#>*+-]/.test(raw.trim()[0]!)) {
        const level = setext[2]!.startsWith("=") ? 1 : 2
        tokens.push({ kind: "heading", level, text: raw.trim(), line: i + 1 })
        i += 2
        continue
      }
    }
    tokens.push({ kind: "text", raw, line: i + 1 })
    i++
  }
  return tokens
}

export function extractHeadings(md: string): Heading[] {
  const tokens = tokenize(md)
  const seen = new Map<string, number>()
  const out: Heading[] = []
  for (const t of tokens) {
    if (t.kind !== "heading") continue
    let slug = slugify(t.text)
    if (!slug) slug = `section-${t.line}`
    const n = (seen.get(slug) ?? 0) + 1
    seen.set(slug, n)
    if (n > 1) slug = `${slug}-${n - 1}`
    out.push({ level: t.level, text: t.text, slug, line: t.line })
  }
  return out
}

const LINK_RE = /(!?)\[([^\]]*)\]\(\s*<?([^>\s)]+)>?(?:\s+["']([^"']*)["'])?\s*\)/g

export function extractLinks(md: string): { links: LinkRef[]; images: ImageRef[] } {
  const lines = md.split(/\r?\n/)
  const links: LinkRef[] = []
  const images: ImageRef[] = []
  // Compute line offsets so we can map a global index back to a 1-based line number.
  const offsets: number[] = [0]
  for (let i = 0; i < lines.length; i++) {
    offsets.push(offsets[i]! + lines[i]!.length + 1)
  }
  function lineOf(absIdx: number): number {
    let lo = 0
    let hi = offsets.length - 1
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (offsets[mid]! <= absIdx && absIdx < offsets[mid + 1]!) return mid + 1
      if (offsets[mid]! > absIdx) hi = mid
      else lo = mid + 1
    }
    return lo + 1
  }
  // Skip code fences when scanning.
  const tokens = tokenize(md)
  const codeRanges: [number, number][] = []
  for (const t of tokens) {
    if (t.kind === "code_fence") codeRanges.push([t.line, t.endLine ?? t.line])
  }
  function inCode(line: number): boolean {
    for (const [a, b] of codeRanges) if (line >= a && line <= b) return true
    return false
  }
  LINK_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = LINK_RE.exec(md))) {
    const isImage = m[1] === "!"
    const text = m[2] ?? ""
    const href = m[3] ?? ""
    const title = m[4]
    const line = lineOf(m.index)
    if (inCode(line)) continue
    if (isImage) images.push({ alt: text, src: href, title, line })
    else links.push({ text, href, title, line })
  }
  return { links, images }
}

export function extractCodeBlocks(md: string): CodeBlock[] {
  const tokens = tokenize(md)
  const out: CodeBlock[] = []
  for (const t of tokens) {
    if (t.kind === "code_fence") {
      out.push({ language: t.language, content: t.content.join("\n"), line: t.line })
    }
  }
  return out
}

export function toPlain(md: string): string {
  const tokens = tokenize(md)
  const out: string[] = []
  for (const t of tokens) {
    if (t.kind === "heading") {
      out.push(t.text)
      continue
    }
    if (t.kind === "code_fence") {
      // Preserve raw content; LLMs usually want to read code as code.
      out.push(t.content.join("\n"))
      continue
    }
    let raw = t.raw
    // List markers
    raw = raw.replace(/^(\s*)(?:[-*+]|\d+[.)])\s+/, "$1")
    // Blockquote
    raw = raw.replace(/^(\s*)>\s?/, "$1")
    // Inline formatting
    raw = raw.replace(/`+([^`]+)`+/g, "$1")
    raw = raw.replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    raw = raw.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
    raw = raw.replace(/(\*\*|__)(.*?)\1/g, "$2")
    raw = raw.replace(/(\*|_)(.*?)\1/g, "$2")
    raw = raw.replace(/~~(.*?)~~/g, "$1")
    out.push(raw)
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim()
}

export function tableOfContents(md: string, maxLevel = 3): string {
  const headings = extractHeadings(md).filter((h) => h.level <= maxLevel)
  const minLevel = Math.min(...headings.map((h) => h.level))
  return headings
    .map((h) => {
      const indent = "  ".repeat(Math.max(0, h.level - minLevel))
      return `${indent}- [${h.text}](#${h.slug})`
    })
    .join("\n")
}

export function extractSection(
  md: string,
  match: { slug?: string; heading_text?: string },
): { heading: Heading; body: string } | undefined {
  const headings = extractHeadings(md)
  const norm = (s: string) => s.trim().toLowerCase()
  let idx = -1
  for (let i = 0; i < headings.length; i++) {
    const h = headings[i]!
    if (match.slug && h.slug === match.slug) {
      idx = i
      break
    }
    if (match.heading_text && norm(h.text) === norm(match.heading_text)) {
      idx = i
      break
    }
  }
  if (idx === -1) return undefined
  const start = headings[idx]!
  let endLine = md.split(/\r?\n/).length + 1
  for (let j = idx + 1; j < headings.length; j++) {
    if (headings[j]!.level <= start.level) {
      endLine = headings[j]!.line
      break
    }
  }
  const lines = md.split(/\r?\n/)
  // Body excludes the heading line itself.
  const body = lines.slice(start.line, endLine - 1).join("\n").trim()
  return { heading: start, body }
}

export function stats(md: string): {
  characters: number
  words: number
  lines: number
  headings: number
  links: number
  images: number
  code_blocks: number
} {
  const tokens = tokenize(md)
  const headings = tokens.filter((t) => t.kind === "heading").length
  const code_blocks = tokens.filter((t) => t.kind === "code_fence").length
  const { links, images } = extractLinks(md)
  // Word count: strip code fences and HTML tags first.
  const noFence = md.replace(/```[\s\S]*?```/g, " ").replace(/~~~[\s\S]*?~~~/g, " ")
  const words = noFence.split(/\s+/).filter((s) => /\w/.test(s)).length
  return {
    characters: md.length,
    words,
    lines: md.split(/\r?\n/).length,
    headings,
    links: links.length,
    images: images.length,
    code_blocks,
  }
}

async function loadInput(params: Params): Promise<{ source: string; filePath?: string; bytes_in: number }> {
  if (params.content !== undefined && params.content !== null) {
    return { source: params.content, bytes_in: Buffer.byteLength(params.content, "utf8") }
  }
  if (!params.filePath) throw new Error("markdown: provide either 'content' or 'filePath'")
  const target = path.isAbsolute(params.filePath)
    ? params.filePath
    : path.resolve(Instance.directory, params.filePath)
  const buf = await readFile(target)
  if (buf.length > MAX_INPUT_BYTES) {
    throw new Error(`markdown: file too large (${buf.length} bytes > ${MAX_INPUT_BYTES})`)
  }
  return { source: buf.toString("utf8"), filePath: target, bytes_in: buf.length }
}

export const MarkdownTool = Tool.define(
  "markdown",
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Params, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const action = params.action
          const fmt: FormatMode = params.format ?? "text"
          const includeLines = params.include_line_numbers ?? true

          const loaded = yield* Effect.promise(() => loadInput(params))
          if (loaded.filePath) {
            yield* ctx.ask({
              permission: "read",
              patterns: [loaded.filePath],
              always: ["*"],
              metadata: { filePath: loaded.filePath, action },
            })
            yield* assertExternalDirectoryEffect(ctx, loaded.filePath, { kind: "file" })
            const info = yield* fs.stat(loaded.filePath).pipe(Effect.catch(() => Effect.succeed(undefined)))
            if (!info) throw new Error(`markdown: file not found: ${loaded.filePath}`)
          }

          let outputPath: string | undefined
          if (params.output_path) {
            outputPath = path.isAbsolute(params.output_path)
              ? params.output_path
              : path.resolve(Instance.directory, params.output_path)
            yield* ctx.ask({
              permission: "write",
              patterns: [outputPath],
              always: ["*"],
              metadata: { output_path: outputPath, action },
            })
            yield* assertExternalDirectoryEffect(ctx, outputPath, { kind: "file" })
          }

          const start = Date.now()
          const md = loaded.source
          let title = ""
          let outputText = ""
          let count = 0

          if (action === "outline" || action === "headings") {
            const items = extractHeadings(md)
            count = items.length
            if (fmt === "json") {
              outputText = JSON.stringify(items, null, 2)
            } else {
              outputText = items
                .map((h) => {
                  const lineSuffix = includeLines ? `:${h.line}` : ""
                  return `${"  ".repeat(Math.max(0, h.level - 1))}${"#".repeat(h.level)} ${h.text}${lineSuffix}`
                })
                .join("\n")
            }
            title = `markdown ${action}: ${items.length}`
          } else if (action === "links") {
            const items = extractLinks(md).links
            count = items.length
            outputText =
              fmt === "json"
                ? JSON.stringify(items, null, 2)
                : items.map((l) => `${l.text} -> ${l.href}${includeLines ? ` (line ${l.line})` : ""}`).join("\n")
            title = `markdown links: ${items.length}`
          } else if (action === "images") {
            const items = extractLinks(md).images
            count = items.length
            outputText =
              fmt === "json"
                ? JSON.stringify(items, null, 2)
                : items.map((i) => `${i.alt || "(no alt)"} -> ${i.src}${includeLines ? ` (line ${i.line})` : ""}`).join("\n")
            title = `markdown images: ${items.length}`
          } else if (action === "code_blocks") {
            const items = extractCodeBlocks(md)
            count = items.length
            outputText =
              fmt === "json"
                ? JSON.stringify(items, null, 2)
                : items
                    .map((c, i) => `--- block ${i + 1} (${c.language || "plain"})${includeLines ? ` line ${c.line}` : ""} ---\n${c.content}`)
                    .join("\n\n")
            title = `markdown code_blocks: ${items.length}`
          } else if (action === "table_of_contents") {
            outputText = tableOfContents(md)
            count = outputText ? outputText.split("\n").length : 0
            title = `markdown toc: ${count} entries`
          } else if (action === "to_plain") {
            outputText = toPlain(md)
            count = outputText.length
            title = `markdown to_plain: ${count} chars`
          } else if (action === "extract_section") {
            if (!params.slug && !params.heading_text) {
              throw new Error("markdown: extract_section requires 'slug' or 'heading_text'")
            }
            const r = extractSection(md, { slug: params.slug, heading_text: params.heading_text })
            if (!r) {
              outputText = "(section not found)"
              title = "markdown extract_section: not found"
            } else {
              outputText = r.body
              count = r.body.length
              title = `markdown extract_section: ${r.heading.text}`
            }
          } else if (action === "stats") {
            const s = stats(md)
            outputText = JSON.stringify(s, null, 2)
            count = s.headings + s.links + s.images + s.code_blocks
            title = `markdown stats: ${s.words} words / ${s.lines} lines`
          } else {
            throw new Error(`markdown: unsupported action '${action}'`)
          }

          const truncatedOut = truncate(outputText)
          let bytes_out: number | undefined
          if (outputPath) {
            yield* Effect.promise(() => writeFile(outputPath!, outputText, "utf8"))
            bytes_out = Buffer.byteLength(outputText, "utf8")
          }

          const elapsed_ms = Date.now() - start
          return done({
            title,
            metadata: {
              action,
              filePath: loaded.filePath,
              output_path: outputPath,
              bytes_in: loaded.bytes_in,
              bytes_out,
              count,
              elapsed_ms,
            },
            output: outputPath ? `wrote ${bytes_out} bytes to ${outputPath}` : truncatedOut,
          })
        }),
    }
  }),
)

export const __testing = {
  slugify,
  tokenize,
  extractHeadings,
  extractLinks,
  extractCodeBlocks,
  toPlain,
  tableOfContents,
  extractSection,
  stats,
}
