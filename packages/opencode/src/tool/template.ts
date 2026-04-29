import { Effect, Schema } from "effect"
import { readFile, writeFile, stat as fsStat } from "node:fs/promises"
import * as path from "node:path"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Instance } from "../project/instance"
import { assertExternalDirectoryEffect } from "./external-directory"
import DESCRIPTION from "./template.txt"
import * as Tool from "./tool"

const ACTIONS = ["render", "extract"] as const
const ESCAPE_MODES = ["none", "html"] as const
const MAX_TEMPLATE_BYTES = 16 * 1024 * 1024
const MAX_OUTPUT_CHARS = 16_000
const MAX_RENDERED_BYTES = 16 * 1024 * 1024

export const Parameters = Schema.Struct({
  action: Schema.Literals(ACTIONS).annotate({
    description: "render: substitute variables. extract: return the list of variables referenced.",
  }),
  template: Schema.optional(Schema.String).annotate({
    description: "Inline template. Required if `template_path` is not given.",
  }),
  template_path: Schema.optional(Schema.String).annotate({
    description: "Read template from this file. Absolute or relative to project directory.",
  }),
  data: Schema.optional(Schema.Unknown).annotate({
    description: "JSON object providing values for the template variables. Required for `render`.",
  }),
  output_path: Schema.optional(Schema.String).annotate({
    description: "Write rendered text to this file instead of returning inline.",
  }),
  strict: Schema.optional(Schema.Boolean).annotate({
    description: "Throw on missing variables when true. Default false (missing → empty string).",
  }),
  escape: Schema.optional(Schema.Literals(ESCAPE_MODES)).annotate({
    description: "'none' (default) writes raw values; 'html' HTML-escapes `{{var}}` (use `{{{var}}}` to bypass).",
  }),
})

type Params = Schema.Schema.Type<typeof Parameters>
type Action = (typeof ACTIONS)[number]
type EscapeMode = (typeof ESCAPE_MODES)[number]

type Metadata = {
  action: Action
  template_path?: string
  output_path?: string
  bytes_in?: number
  bytes_out?: number
  variables?: string[]
  rendered_chars?: number
  elapsed_ms?: number
}

const done = (result: Tool.ExecuteResult<Metadata>) => result

function truncate(s: string): string {
  if (s.length <= MAX_OUTPUT_CHARS) return s
  return s.slice(0, MAX_OUTPUT_CHARS) + `\n... [truncated ${s.length - MAX_OUTPUT_CHARS} chars]`
}

// --- Template engine ----------------------------------------------------

type TextNode = { kind: "text"; value: string }
type VarNode = { kind: "var"; path: string; raw: boolean }
type SectionNode = {
  kind: "section"
  type: "if" | "unless" | "each"
  path: string
  body: TemplateNode[]
  alt: TemplateNode[] // {{else}} branch
}
type TemplateNode = TextNode | VarNode | SectionNode

type Token =
  | { kind: "text"; value: string; index: number }
  | { kind: "var"; path: string; raw: boolean; index: number }
  | { kind: "open"; type: "if" | "unless" | "each"; path: string; index: number }
  | { kind: "close"; type: "if" | "unless" | "each"; path: string; index: number }
  | { kind: "else"; index: number }

const TOKEN_RE = /\{\{(![\s\S]*?|\{\s*[^{}]+\s*\}|[^{}]+?)\}\}/g

function tokenize(template: string): Token[] {
  const tokens: Token[] = []
  let last = 0
  TOKEN_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = TOKEN_RE.exec(template))) {
    if (match.index > last) {
      tokens.push({ kind: "text", value: template.slice(last, match.index), index: last })
    }
    let inner = match[1]!
    last = match.index + match[0].length

    // Triple-stash {{{var}}} — raw, no HTML escape.
    if (inner.startsWith("{") && inner.endsWith("}")) {
      const path = inner.slice(1, -1).trim()
      tokens.push({ kind: "var", path, raw: true, index: match.index })
      continue
    }
    // Comments {{!...}} — drop.
    if (inner.startsWith("!")) continue

    inner = inner.trim()
    if (inner.startsWith("#")) {
      const rest = inner.slice(1).trim()
      const sp = rest.indexOf(" ")
      const head = sp === -1 ? rest : rest.slice(0, sp)
      const tail = sp === -1 ? "" : rest.slice(sp).trim()
      if (head === "if" || head === "unless" || head === "each") {
        tokens.push({ kind: "open", type: head, path: tail, index: match.index })
        continue
      }
      throw new Error(`template: unknown section '#${head}'`)
    }
    if (inner.startsWith("/")) {
      const head = inner.slice(1).trim()
      if (head === "if" || head === "unless" || head === "each") {
        tokens.push({ kind: "close", type: head, path: "", index: match.index })
        continue
      }
      throw new Error(`template: unknown closing section '/${head}'`)
    }
    if (inner === "else") {
      tokens.push({ kind: "else", index: match.index })
      continue
    }
    tokens.push({ kind: "var", path: inner, raw: false, index: match.index })
  }
  if (last < template.length) {
    tokens.push({ kind: "text", value: template.slice(last), index: last })
  }
  return tokens
}

function parseTokens(tokens: Token[]): TemplateNode[] {
  let i = 0

  function parseBody(stopOnElse: boolean, expectedClose?: "if" | "unless" | "each"): TemplateNode[] {
    const out: TemplateNode[] = []
    while (i < tokens.length) {
      const tok = tokens[i]!
      if (tok.kind === "close") {
        if (!expectedClose) {
          throw new Error(`template: unexpected closing section '/${tok.type}' at offset ${tok.index}`)
        }
        if (tok.type !== expectedClose) {
          throw new Error(
            `template: closing '/${tok.type}' does not match opening '#${expectedClose}' at offset ${tok.index}`,
          )
        }
        return out
      }
      if (tok.kind === "else") {
        if (!stopOnElse) {
          throw new Error(`template: '{{else}}' outside of #if/#unless at offset ${tok.index}`)
        }
        return out
      }
      if (tok.kind === "text") {
        out.push({ kind: "text", value: tok.value })
        i++
        continue
      }
      if (tok.kind === "var") {
        out.push({ kind: "var", path: tok.path, raw: tok.raw })
        i++
        continue
      }
      // open
      const start = tok
      i++
      const body = parseBody(true, start.type)
      let alt: TemplateNode[] = []
      if (i < tokens.length && tokens[i]!.kind === "else") {
        if (start.type === "each") {
          throw new Error(`template: '{{else}}' is not supported inside '#each' at offset ${tokens[i]!.index}`)
        }
        i++
        alt = parseBody(false, start.type)
      }
      if (i >= tokens.length || tokens[i]!.kind !== "close") {
        throw new Error(`template: unclosed '#${start.type}' at offset ${start.index}`)
      }
      const close = tokens[i] as Extract<Token, { kind: "close" }>
      if (close.type !== start.type) {
        throw new Error(
          `template: '/${close.type}' does not match '#${start.type}' at offset ${close.index}`,
        )
      }
      i++
      out.push({ kind: "section", type: start.type, path: start.path, body, alt })
    }
    if (expectedClose) throw new Error(`template: unclosed '#${expectedClose}'`)
    return out
  }

  const tree = parseBody(false)
  if (i < tokens.length) {
    throw new Error(`template: unexpected token after end-of-template at offset ${tokens[i]!.index}`)
  }
  return tree
}

export function parseTemplate(template: string): TemplateNode[] {
  return parseTokens(tokenize(template))
}

function htmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

function isTruthy(v: unknown): boolean {
  if (v === null || v === undefined || v === false) return false
  if (typeof v === "number") return v !== 0
  if (typeof v === "string") return v.length > 0
  if (Array.isArray(v)) return v.length > 0
  if (typeof v === "object") return Object.keys(v as object).length > 0
  return Boolean(v)
}

type Frame = {
  value: unknown
  index?: number
  first?: boolean
  last?: boolean
  parent?: Frame
}

function lookup(path: string, frame: Frame, root: unknown): unknown {
  const trimmed = path.trim()
  if (trimmed === "" || trimmed === ".") return frame.value
  if (trimmed === "this") return frame.value
  if (trimmed === "@index") return frame.index
  if (trimmed === "@first") return frame.first
  if (trimmed === "@last") return frame.last

  // Walk inheritance chain so {{name}} inside #each works against the current item or any ancestor frame.
  const parts = trimmed.split(".")
  let cursor: Frame | undefined = frame
  while (cursor) {
    const v = walk(cursor.value, parts)
    if (v !== undefined) return v
    cursor = cursor.parent
  }
  // Fall back to root.
  return walk(root, parts)
}

function walk(value: unknown, parts: string[]): unknown {
  let cur: unknown = value
  for (const p of parts) {
    if (cur === null || cur === undefined) return undefined
    if (Array.isArray(cur)) {
      if (/^\d+$/.test(p)) cur = cur[Number(p)]
      else return undefined
    } else if (typeof cur === "object") {
      cur = (cur as Record<string, unknown>)[p]
    } else {
      return undefined
    }
  }
  return cur
}

function stringify(v: unknown): string {
  if (v === null || v === undefined) return ""
  if (typeof v === "string") return v
  if (typeof v === "number" || typeof v === "boolean") return String(v)
  return JSON.stringify(v)
}

export function renderNodes(
  nodes: TemplateNode[],
  data: unknown,
  options: { strict: boolean; escape: EscapeMode },
): string {
  const root = data
  const out: string[] = []
  let written = 0

  function push(text: string): void {
    written += text.length
    if (written > MAX_RENDERED_BYTES) throw new Error(`template: rendered output exceeds ${MAX_RENDERED_BYTES} bytes`)
    out.push(text)
  }

  function visit(nodes: TemplateNode[], frame: Frame): void {
    for (const node of nodes) {
      if (node.kind === "text") {
        push(node.value)
        continue
      }
      if (node.kind === "var") {
        const v = lookup(node.path, frame, root)
        if (v === undefined) {
          if (options.strict) throw new Error(`template: missing variable '${node.path}'`)
          continue
        }
        let s = stringify(v)
        if (options.escape === "html" && !node.raw) s = htmlEscape(s)
        push(s)
        continue
      }
      // section
      const v = lookup(node.path, frame, root)
      if (node.type === "if") {
        if (isTruthy(v)) visit(node.body, frame)
        else visit(node.alt, frame)
        continue
      }
      if (node.type === "unless") {
        if (!isTruthy(v)) visit(node.body, frame)
        else visit(node.alt, frame)
        continue
      }
      // each
      if (Array.isArray(v)) {
        const arr = v
        for (let idx = 0; idx < arr.length; idx++) {
          const child: Frame = {
            value: arr[idx],
            index: idx,
            first: idx === 0,
            last: idx === arr.length - 1,
            parent: frame,
          }
          visit(node.body, child)
        }
      } else if (v && typeof v === "object") {
        const entries = Object.entries(v as Record<string, unknown>)
        for (let idx = 0; idx < entries.length; idx++) {
          const [k, val] = entries[idx]!
          const child: Frame = {
            value: { ...(val && typeof val === "object" && !Array.isArray(val) ? val : {}), key: k, value: val },
            index: idx,
            first: idx === 0,
            last: idx === entries.length - 1,
            parent: frame,
          }
          visit(node.body, child)
        }
      }
      // Non-iterable: render alt (none for each, so silent).
    }
  }

  visit(nodes, { value: root })
  return out.join("")
}

export function extractVariables(nodes: TemplateNode[]): string[] {
  const seen = new Set<string>()
  function walk(nodes: TemplateNode[]): void {
    for (const node of nodes) {
      if (node.kind === "var") {
        if (!node.path.startsWith("@") && node.path !== "this" && node.path !== ".") {
          seen.add(node.path)
        }
        continue
      }
      if (node.kind === "section") {
        if (node.path) seen.add(node.path)
        walk(node.body)
        walk(node.alt)
      }
    }
  }
  walk(nodes)
  return Array.from(seen).sort()
}

// --- Tool wrapper -------------------------------------------------------

export const TemplateTool = Tool.define(
  "template",
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Params, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const start = Date.now()
          const action = params.action
          const escape: EscapeMode = params.escape ?? "none"
          const strict = params.strict ?? false

          // Resolve template source.
          let templateText: string
          let inputBytes = 0
          let templatePath: string | undefined
          if (params.template_path !== undefined) {
            templatePath = path.isAbsolute(params.template_path)
              ? params.template_path
              : path.resolve(Instance.directory, params.template_path)
            yield* ctx.ask({
              permission: "read",
              patterns: [templatePath],
              always: ["*"],
              metadata: { filePath: templatePath, action },
            })
            yield* assertExternalDirectoryEffect(ctx, templatePath, { kind: "file" })
            const info = yield* fs.stat(templatePath).pipe(Effect.catch(() => Effect.succeed(undefined)))
            if (!info) throw new Error(`template: file not found: ${templatePath}`)
            if (info.type !== "File") throw new Error(`template: not a regular file: ${templatePath}`)
            inputBytes = Number(info.size ?? 0)
            if (inputBytes > MAX_TEMPLATE_BYTES) {
              throw new Error(`template: file too large (${inputBytes} bytes > ${MAX_TEMPLATE_BYTES})`)
            }
            templateText = yield* Effect.promise(() => readFile(templatePath!, "utf8"))
          } else if (params.template !== undefined) {
            templateText = params.template
            inputBytes = Buffer.byteLength(templateText, "utf8")
          } else {
            throw new Error("template: provide either 'template' or 'template_path'")
          }

          let outputPath: string | undefined
          if (params.output_path !== undefined) {
            outputPath = path.isAbsolute(params.output_path)
              ? params.output_path
              : path.resolve(Instance.directory, params.output_path)
            yield* ctx.ask({
              permission: "write",
              patterns: [outputPath],
              always: ["*"],
              metadata: { filePath: outputPath, action },
            })
            yield* assertExternalDirectoryEffect(ctx, outputPath, { kind: "file" })
          }

          let nodes: TemplateNode[]
          try {
            nodes = parseTemplate(templateText)
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err)
            throw new Error(msg)
          }

          if (action === "extract") {
            const vars = extractVariables(nodes)
            return done({
              title: `template extract: ${vars.length} variable(s)`,
              metadata: {
                action,
                template_path: templatePath,
                bytes_in: inputBytes,
                variables: vars,
                elapsed_ms: Date.now() - start,
              },
              output: vars.length > 0 ? vars.join("\n") : "(no variables)",
            })
          }

          // render
          if (params.data === undefined) {
            throw new Error("template: 'data' is required for render (use {} for none)")
          }
          let rendered: string
          try {
            rendered = renderNodes(nodes, params.data, { strict, escape })
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err)
            throw new Error(msg)
          }

          if (outputPath) {
            yield* Effect.promise(() => writeFile(outputPath!, rendered, "utf8"))
            const after = yield* Effect.promise(() => fsStat(outputPath!).then((s) => Number(s.size)))
            return done({
              title: `template render → ${outputPath}`,
              metadata: {
                action,
                template_path: templatePath,
                output_path: outputPath,
                bytes_in: inputBytes,
                bytes_out: after,
                rendered_chars: rendered.length,
                elapsed_ms: Date.now() - start,
              },
              output: `wrote ${after} bytes to ${outputPath}`,
            })
          }
          return done({
            title: `template render: ${rendered.length} chars`,
            metadata: {
              action,
              template_path: templatePath,
              bytes_in: inputBytes,
              rendered_chars: rendered.length,
              elapsed_ms: Date.now() - start,
            },
            output: truncate(rendered),
          })
        }),
    }
  }),
)

export const __testing = {
  parseTemplate,
  renderNodes,
  extractVariables,
  tokenize,
  htmlEscape,
}
