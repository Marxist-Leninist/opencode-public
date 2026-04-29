import { Effect, Schema } from "effect"
import { readFile, writeFile } from "node:fs/promises"
import * as path from "node:path"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Instance } from "../project/instance"
import { assertExternalDirectoryEffect } from "./external-directory"
import DESCRIPTION from "./html.txt"
import * as Tool from "./tool"

const ACTIONS = [
  "to_text",
  "links",
  "images",
  "scripts",
  "stylesheets",
  "meta",
  "headings",
  "forms",
  "find",
] as const
const FORMATS = ["text", "json"] as const
const MAX_INPUT_BYTES = 16 * 1024 * 1024
const MAX_OUTPUT_CHARS = 16_000
const INLINE_SCRIPT_PREVIEW = 200

export const Parameters = Schema.Struct({
  action: Schema.Literals(ACTIONS).annotate({
    description:
      "to_text/links/images/scripts/stylesheets/meta/headings/forms/find. find requires tag/id/class.",
  }),
  content: Schema.optional(Schema.String).annotate({
    description: "Inline HTML. Required if filePath is not given.",
  }),
  filePath: Schema.optional(Schema.String).annotate({
    description: "Read HTML from this file. Absolute or project-relative.",
  }),
  output_path: Schema.optional(Schema.String).annotate({
    description: "Write result to this file instead of returning inline.",
  }),
  tag: Schema.optional(Schema.String).annotate({
    description: "For find: filter by tag name (e.g. 'div').",
  }),
  id: Schema.optional(Schema.String).annotate({
    description: "For find: filter by element id.",
  }),
  class: Schema.optional(Schema.String).annotate({
    description: "For find: filter by class name (single class).",
  }),
  same_host_only: Schema.optional(Schema.Boolean).annotate({
    description: "For links: drop cross-host URLs. Requires base_url. Default false.",
  }),
  base_url: Schema.optional(Schema.String).annotate({
    description: "Resolve relative URLs against this absolute URL.",
  }),
  format: Schema.optional(Schema.Literals(FORMATS)).annotate({
    description: "'text' (default) or 'json'.",
  }),
  include_inline_scripts: Schema.optional(Schema.Boolean).annotate({
    description: "For scripts: include inline <script> previews. Default true.",
  }),
})

type Params = Schema.Schema.Type<typeof Parameters>
type Action = (typeof ACTIONS)[number]
type FormatMode = (typeof FORMATS)[number]

type LinkRef = { text: string; href: string; line: number; resolved?: string }
type ImageRef = { alt: string; src: string; line: number; resolved?: string }
type ScriptRef = { src?: string; inline?: string; line: number; resolved?: string }
type StylesheetRef = { href: string; line: number; resolved?: string }
type MetaRef = { name?: string; property?: string; http_equiv?: string; charset?: string; content?: string; line: number }
type HeadingRef = { level: number; text: string; line: number }
type FormControl = { tag: "input" | "select" | "textarea" | "button"; name?: string; type?: string; value?: string }
type FormRef = { action?: string; method?: string; enctype?: string; line: number; controls: FormControl[] }
type FindMatch = { tag: string; id?: string; class?: string; text: string; outerPreview: string; line: number }

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

function truncate(s: string, max = MAX_OUTPUT_CHARS): string {
  if (s.length <= max) return s
  return s.slice(0, max) + `\n... [truncated ${s.length - max} chars]`
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  copy: "©",
  reg: "®",
  trade: "™",
}

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (m, ent) => {
    if (ent.startsWith("#x")) {
      const code = parseInt(ent.slice(2), 16)
      return Number.isFinite(code) ? String.fromCodePoint(code) : m
    }
    if (ent.startsWith("#")) {
      const code = parseInt(ent.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : m
    }
    if (ent in NAMED_ENTITIES) return NAMED_ENTITIES[ent]!
    return m
  })
}

function lineOffsets(html: string): number[] {
  const offsets = [0]
  for (let i = 0; i < html.length; i++) {
    if (html.charCodeAt(i) === 10) offsets.push(i + 1)
  }
  offsets.push(html.length + 1)
  return offsets
}

function lineOf(offsets: number[], idx: number): number {
  let lo = 0
  let hi = offsets.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (offsets[mid]! <= idx && idx < offsets[mid + 1]!) return mid + 1
    if (offsets[mid]! > idx) hi = mid
    else lo = mid + 1
  }
  return lo + 1
}

function stripBlocks(html: string, tags: string[]): string {
  let out = html
  for (const tag of tags) {
    const re = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}>`, "gi")
    out = out.replace(re, " ")
    // Self-closing or unclosed
    const reOpen = new RegExp(`<${tag}\\b[^>]*/>`, "gi")
    out = out.replace(reOpen, " ")
  }
  return out
}

export function htmlToText(html: string): string {
  let s = stripBlocks(html, ["script", "style", "noscript"])
  // Replace common block-level closers/openers with newlines.
  s = s.replace(/<\s*br\s*\/?>/gi, "\n")
  s = s.replace(/<\/(p|div|h[1-6]|li|tr|article|section|header|footer|nav|table|blockquote|pre)\s*>/gi, "\n")
  s = s.replace(/<\s*li\b[^>]*>/gi, "\n- ")
  // Strip remaining tags.
  s = s.replace(/<[^>]+>/g, "")
  s = decodeEntities(s)
  // Collapse whitespace, but preserve line structure.
  s = s.replace(/[\t ]+/g, " ")
  s = s.replace(/ ?\n ?/g, "\n")
  s = s.replace(/\n{3,}/g, "\n\n")
  return s.trim()
}

function attrMap(raw: string): Record<string, string> {
  const out: Record<string, string> = {}
  const re = /([a-zA-Z_:][\w:.-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'`<>=]+)))?/g
  let m: RegExpExecArray | null
  while ((m = re.exec(raw))) {
    const key = m[1]!.toLowerCase()
    const val = m[2] ?? m[3] ?? m[4] ?? ""
    out[key] = decodeEntities(val)
  }
  return out
}

function resolveUrl(href: string, base?: string): string | undefined {
  if (!base) return undefined
  try {
    return new URL(href, base).toString()
  } catch {
    return undefined
  }
}

function sameHost(href: string, base: string): boolean {
  try {
    const a = new URL(href, base)
    const b = new URL(base)
    return a.host === b.host
  } catch {
    return false
  }
}

const TAG_PROPERTY_RE = /<\s*([a-zA-Z][\w:-]*)\b([^>]*)>/g

export function extractLinks(
  html: string,
  opts: { baseUrl?: string; sameHostOnly?: boolean } = {},
): LinkRef[] {
  const offsets = lineOffsets(html)
  const out: LinkRef[] = []
  const re = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html))) {
    const attrs = attrMap(m[1] ?? "")
    const href = attrs.href
    if (!href) continue
    if (opts.sameHostOnly && opts.baseUrl && !sameHost(href, opts.baseUrl)) continue
    const text = decodeEntities((m[2] ?? "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim())
    const line = lineOf(offsets, m.index)
    out.push({ text, href, line, resolved: resolveUrl(href, opts.baseUrl) })
  }
  return out
}

export function extractImages(html: string, opts: { baseUrl?: string } = {}): ImageRef[] {
  const offsets = lineOffsets(html)
  const out: ImageRef[] = []
  const re = /<img\b([^>]*)\/?\s*>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html))) {
    const attrs = attrMap(m[1] ?? "")
    const src = attrs.src
    if (!src) continue
    out.push({
      alt: attrs.alt ?? "",
      src,
      line: lineOf(offsets, m.index),
      resolved: resolveUrl(src, opts.baseUrl),
    })
  }
  return out
}

export function extractScripts(
  html: string,
  opts: { baseUrl?: string; includeInline?: boolean } = {},
): ScriptRef[] {
  const offsets = lineOffsets(html)
  const out: ScriptRef[] = []
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html))) {
    const attrs = attrMap(m[1] ?? "")
    const line = lineOf(offsets, m.index)
    if (attrs.src) {
      out.push({ src: attrs.src, line, resolved: resolveUrl(attrs.src, opts.baseUrl) })
      continue
    }
    if (opts.includeInline === false) continue
    const inline = (m[2] ?? "").trim()
    if (inline.length === 0) continue
    out.push({ inline: inline.slice(0, INLINE_SCRIPT_PREVIEW), line })
  }
  return out
}

export function extractStylesheets(html: string, opts: { baseUrl?: string } = {}): StylesheetRef[] {
  const offsets = lineOffsets(html)
  const out: StylesheetRef[] = []
  const re = /<link\b([^>]*)\/?\s*>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html))) {
    const attrs = attrMap(m[1] ?? "")
    if ((attrs.rel ?? "").toLowerCase().split(/\s+/).includes("stylesheet") && attrs.href) {
      out.push({
        href: attrs.href,
        line: lineOf(offsets, m.index),
        resolved: resolveUrl(attrs.href, opts.baseUrl),
      })
    }
  }
  return out
}

export function extractMeta(html: string): MetaRef[] {
  const offsets = lineOffsets(html)
  const out: MetaRef[] = []
  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)
  if (titleMatch) {
    out.push({
      name: "title",
      content: decodeEntities(titleMatch[1] ?? "").trim(),
      line: lineOf(offsets, titleMatch.index),
    })
  }
  const re = /<meta\b([^>]*)\/?\s*>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html))) {
    const attrs = attrMap(m[1] ?? "")
    out.push({
      name: attrs.name,
      property: attrs.property,
      http_equiv: attrs["http-equiv"],
      charset: attrs.charset,
      content: attrs.content,
      line: lineOf(offsets, m.index),
    })
  }
  return out
}

export function extractHeadings(html: string): HeadingRef[] {
  const offsets = lineOffsets(html)
  const out: HeadingRef[] = []
  const cleaned = stripBlocks(html, ["script", "style", "noscript"])
  const re = /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(cleaned))) {
    const level = Number(m[1])
    const text = decodeEntities((m[2] ?? "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim())
    if (text.length === 0) continue
    out.push({ level, text, line: lineOf(offsets, m.index) })
  }
  return out
}

export function extractForms(html: string): FormRef[] {
  const offsets = lineOffsets(html)
  const out: FormRef[] = []
  const re = /<form\b([^>]*)>([\s\S]*?)<\/form>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html))) {
    const attrs = attrMap(m[1] ?? "")
    const body = m[2] ?? ""
    const controls: FormControl[] = []
    const childRe = /<(input|select|textarea|button)\b([^>]*)\/?\s*>/gi
    let c: RegExpExecArray | null
    while ((c = childRe.exec(body))) {
      const ctag = (c[1] ?? "").toLowerCase() as FormControl["tag"]
      const cattrs = attrMap(c[2] ?? "")
      controls.push({
        tag: ctag,
        name: cattrs.name,
        type: cattrs.type,
        value: cattrs.value,
      })
    }
    out.push({
      action: attrs.action,
      method: attrs.method,
      enctype: attrs.enctype,
      line: lineOf(offsets, m.index),
      controls,
    })
  }
  return out
}

export function findElements(
  html: string,
  filter: { tag?: string; id?: string; class?: string },
): FindMatch[] {
  const offsets = lineOffsets(html)
  const out: FindMatch[] = []
  TAG_PROPERTY_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = TAG_PROPERTY_RE.exec(html))) {
    const tag = (m[1] ?? "").toLowerCase()
    if (filter.tag && tag !== filter.tag.toLowerCase()) continue
    const attrs = attrMap(m[2] ?? "")
    if (filter.id && attrs.id !== filter.id) continue
    if (filter.class) {
      const classes = (attrs.class ?? "").split(/\s+/).filter(Boolean)
      if (!classes.includes(filter.class)) continue
    }
    // Try to capture inner text by scanning for matching close tag at the same depth.
    const closeRe = new RegExp(`</${tag}\\s*>`, "gi")
    closeRe.lastIndex = m.index + m[0].length
    const close = closeRe.exec(html)
    let outer: string
    let inner: string
    if (close) {
      outer = html.slice(m.index, close.index + close[0].length)
      inner = html.slice(m.index + m[0].length, close.index)
    } else {
      outer = m[0]
      inner = ""
    }
    const text = decodeEntities(inner.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim())
    out.push({
      tag,
      id: attrs.id,
      class: attrs.class,
      text,
      outerPreview: outer.length > 200 ? outer.slice(0, 200) + "…" : outer,
      line: lineOf(offsets, m.index),
    })
  }
  return out
}

async function loadInput(params: Params): Promise<{ source: string; filePath?: string; bytes_in: number }> {
  if (params.content !== undefined && params.content !== null) {
    return { source: params.content, bytes_in: Buffer.byteLength(params.content, "utf8") }
  }
  if (!params.filePath) throw new Error("html: provide either 'content' or 'filePath'")
  const target = path.isAbsolute(params.filePath)
    ? params.filePath
    : path.resolve(Instance.directory, params.filePath)
  const buf = await readFile(target)
  if (buf.length > MAX_INPUT_BYTES) {
    throw new Error(`html: file too large (${buf.length} bytes > ${MAX_INPUT_BYTES})`)
  }
  return { source: buf.toString("utf8"), filePath: target, bytes_in: buf.length }
}

export const HtmlTool = Tool.define(
  "html",
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Params, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const action = params.action
          const fmt: FormatMode = params.format ?? "text"
          const includeInline = params.include_inline_scripts ?? true

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
            if (!info) throw new Error(`html: file not found: ${loaded.filePath}`)
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
          const html = loaded.source
          let title = ""
          let outputText = ""
          let count = 0

          if (action === "to_text") {
            outputText = htmlToText(html)
            count = outputText.length
            title = `html to_text: ${count} chars`
          } else if (action === "links") {
            const items = extractLinks(html, {
              baseUrl: params.base_url,
              sameHostOnly: params.same_host_only,
            })
            count = items.length
            outputText =
              fmt === "json"
                ? JSON.stringify(items, null, 2)
                : items
                    .map((l) => `${l.text || "(no text)"} -> ${l.resolved ?? l.href} (line ${l.line})`)
                    .join("\n")
            title = `html links: ${count}`
          } else if (action === "images") {
            const items = extractImages(html, { baseUrl: params.base_url })
            count = items.length
            outputText =
              fmt === "json"
                ? JSON.stringify(items, null, 2)
                : items
                    .map((i) => `${i.alt || "(no alt)"} -> ${i.resolved ?? i.src} (line ${i.line})`)
                    .join("\n")
            title = `html images: ${count}`
          } else if (action === "scripts") {
            const items = extractScripts(html, {
              baseUrl: params.base_url,
              includeInline: includeInline,
            })
            count = items.length
            outputText =
              fmt === "json"
                ? JSON.stringify(items, null, 2)
                : items
                    .map((s) =>
                      s.src
                        ? `external: ${s.resolved ?? s.src} (line ${s.line})`
                        : `inline: ${(s.inline ?? "").slice(0, 80).replace(/\n/g, " ")} (line ${s.line})`,
                    )
                    .join("\n")
            title = `html scripts: ${count}`
          } else if (action === "stylesheets") {
            const items = extractStylesheets(html, { baseUrl: params.base_url })
            count = items.length
            outputText =
              fmt === "json"
                ? JSON.stringify(items, null, 2)
                : items.map((s) => `${s.resolved ?? s.href} (line ${s.line})`).join("\n")
            title = `html stylesheets: ${count}`
          } else if (action === "meta") {
            const items = extractMeta(html)
            count = items.length
            outputText =
              fmt === "json"
                ? JSON.stringify(items, null, 2)
                : items
                    .map((m) => {
                      const k = m.name ?? m.property ?? m.http_equiv ?? m.charset ?? "?"
                      return `${k} = ${m.content ?? ""} (line ${m.line})`
                    })
                    .join("\n")
            title = `html meta: ${count}`
          } else if (action === "headings") {
            const items = extractHeadings(html)
            count = items.length
            outputText =
              fmt === "json"
                ? JSON.stringify(items, null, 2)
                : items.map((h) => `${"  ".repeat(h.level - 1)}h${h.level}: ${h.text} (line ${h.line})`).join("\n")
            title = `html headings: ${count}`
          } else if (action === "forms") {
            const items = extractForms(html)
            count = items.length
            outputText =
              fmt === "json"
                ? JSON.stringify(items, null, 2)
                : items
                    .map(
                      (f) =>
                        `<form action=${f.action ?? ""} method=${f.method ?? "GET"}> (line ${f.line})\n${f.controls
                          .map((c) => `  - ${c.tag}${c.type ? `[${c.type}]` : ""}${c.name ? ` name=${c.name}` : ""}`)
                          .join("\n")}`,
                    )
                    .join("\n\n")
            title = `html forms: ${count}`
          } else if (action === "find") {
            if (!params.tag && !params.id && !params.class) {
              throw new Error("html: find requires at least one of tag/id/class")
            }
            const items = findElements(html, { tag: params.tag, id: params.id, class: params.class })
            count = items.length
            outputText =
              fmt === "json"
                ? JSON.stringify(items, null, 2)
                : items
                    .map(
                      (e) =>
                        `<${e.tag}${e.id ? ` id=${e.id}` : ""}${e.class ? ` class=${e.class}` : ""}> (line ${e.line})\n  text: ${e.text.slice(0, 200)}\n  outer: ${e.outerPreview}`,
                    )
                    .join("\n\n")
            title = `html find: ${count}`
          } else {
            throw new Error(`html: unsupported action '${action}'`)
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
  decodeEntities,
  htmlToText,
  attrMap,
  extractLinks,
  extractImages,
  extractScripts,
  extractStylesheets,
  extractMeta,
  extractHeadings,
  extractForms,
  findElements,
  resolveUrl,
}
