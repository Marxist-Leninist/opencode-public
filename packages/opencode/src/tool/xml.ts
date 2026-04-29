import { Effect, Schema } from "effect"
import { readFile, writeFile, stat as fsStat } from "node:fs/promises"
import * as path from "node:path"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Instance } from "../project/instance"
import { assertExternalDirectoryEffect } from "./external-directory"
import DESCRIPTION from "./xml.txt"
import * as Tool from "./tool"

const ACTIONS = ["parse", "stringify", "to_json", "from_json"] as const
const MAX_INPUT_BYTES = 32 * 1024 * 1024
const MAX_OUTPUT_CHARS = 16_000

export const Parameters = Schema.Struct({
  action: Schema.Literals(ACTIONS).annotate({
    description:
      "parse: XML → JSON. stringify: JSON value → XML. to_json: alias of parse. from_json: alias of stringify.",
  }),
  content: Schema.optional(Schema.String).annotate({
    description: "Inline input text. For parse/to_json: XML. For stringify/from_json: JSON.",
  }),
  filePath: Schema.optional(Schema.String).annotate({
    description: "Read input from this file instead of `content`. Absolute or relative to project directory.",
  }),
  output_path: Schema.optional(Schema.String).annotate({
    description: "Write the result to this file instead of returning inline. Absolute or relative to project directory.",
  }),
  pretty: Schema.optional(Schema.Boolean).annotate({
    description: "Pretty-print output (default true). For parse: pretty JSON. For stringify: indented XML.",
  }),
  attribute_prefix: Schema.optional(Schema.String).annotate({
    description: "Object key prefix used for XML attributes (default '@').",
  }),
  text_key: Schema.optional(Schema.String).annotate({
    description: "Object key used for the text child of mixed-content nodes (default '#text').",
  }),
  xml_declaration: Schema.optional(Schema.Boolean).annotate({
    description: "When stringifying, prepend <?xml version=\"1.0\" encoding=\"UTF-8\"?>. Default true.",
  }),
})

type Params = Schema.Schema.Type<typeof Parameters>
type Action = (typeof ACTIONS)[number]

type Metadata = {
  action: Action
  filePath?: string
  output_path?: string
  bytes_in?: number
  bytes_out?: number
  elapsed_ms?: number
}

function truncate(s: string): string {
  if (s.length <= MAX_OUTPUT_CHARS) return s
  return s.slice(0, MAX_OUTPUT_CHARS) + `\n... [truncated ${s.length - MAX_OUTPUT_CHARS} chars]`
}

const done = (result: Tool.ExecuteResult<Metadata>) => result

// --- XML parser ---------------------------------------------------------

type ParseOpts = { attributePrefix: string; textKey: string }

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g, (_, ent) => {
    if (ent === "amp") return "&"
    if (ent === "lt") return "<"
    if (ent === "gt") return ">"
    if (ent === "quot") return '"'
    if (ent === "apos") return "'"
    if (ent.startsWith("#x")) return String.fromCodePoint(parseInt(ent.slice(2), 16))
    if (ent.startsWith("#")) return String.fromCodePoint(parseInt(ent.slice(1), 10))
    return _
  })
}

function encodeEntities(s: string, attr = false): string {
  let out = s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  if (attr) out = out.replace(/"/g, "&quot;")
  return out
}

type Node = { name: string; attrs: Record<string, string>; children: (Node | string)[] }

export function parseXml(input: string, opts: ParseOpts = { attributePrefix: "@", textKey: "#text" }): unknown {
  let i = 0
  const n = input.length

  // Strip BOM and leading whitespace.
  if (input.charCodeAt(0) === 0xfeff) i = 1
  while (i < n && /\s/.test(input[i]!)) i++

  // Skip XML declaration <?xml ... ?>
  if (input.startsWith("<?xml", i)) {
    const end = input.indexOf("?>", i)
    if (end === -1) throw new Error("xml.parse: unterminated XML declaration")
    i = end + 2
  }

  const stack: Node[] = []
  let root: Node | undefined

  while (i < n) {
    if (input[i] === "<") {
      // Comment
      if (input.startsWith("<!--", i)) {
        const end = input.indexOf("-->", i + 4)
        if (end === -1) throw new Error("xml.parse: unterminated comment")
        i = end + 3
        continue
      }
      // CDATA
      if (input.startsWith("<![CDATA[", i)) {
        const end = input.indexOf("]]>", i + 9)
        if (end === -1) throw new Error("xml.parse: unterminated CDATA")
        const text = input.slice(i + 9, end)
        if (stack.length > 0) stack[stack.length - 1]!.children.push(text)
        i = end + 3
        continue
      }
      // DOCTYPE / processing instruction — skip.
      if (input.startsWith("<!", i) || input.startsWith("<?", i)) {
        const end = input.indexOf(">", i)
        if (end === -1) throw new Error("xml.parse: unterminated <! or <? section")
        i = end + 1
        continue
      }
      // Closing tag
      if (input[i + 1] === "/") {
        const end = input.indexOf(">", i)
        if (end === -1) throw new Error("xml.parse: unterminated closing tag")
        const name = input.slice(i + 2, end).trim()
        const top = stack.pop()
        if (!top) throw new Error(`xml.parse: closing tag </${name}> with no open element`)
        if (top.name !== name) {
          throw new Error(`xml.parse: closing tag </${name}> does not match open <${top.name}>`)
        }
        i = end + 1
        continue
      }
      // Opening tag
      const end = findTagEnd(input, i + 1)
      const raw = input.slice(i + 1, end)
      const selfClose = raw.endsWith("/")
      const body = selfClose ? raw.slice(0, -1).trim() : raw.trim()
      const { name, attrs } = parseTagBody(body)
      const node: Node = { name, attrs, children: [] }
      if (stack.length > 0) {
        stack[stack.length - 1]!.children.push(node)
      } else {
        if (root) throw new Error("xml.parse: multiple root elements")
        root = node
      }
      if (!selfClose) stack.push(node)
      i = end + 1
      continue
    }
    // Text content
    const next = input.indexOf("<", i)
    const chunk = next === -1 ? input.slice(i) : input.slice(i, next)
    if (stack.length > 0 && chunk.length > 0) {
      stack[stack.length - 1]!.children.push(decodeEntities(chunk))
    }
    i = next === -1 ? n : next
  }

  if (stack.length > 0) {
    throw new Error(`xml.parse: unclosed element <${stack[stack.length - 1]!.name}>`)
  }
  if (!root) throw new Error("xml.parse: no root element found")

  return { [root.name]: nodeToJson(root, opts) }
}

function findTagEnd(input: string, from: number): number {
  // Walks past quoted attributes so a `>` inside a quoted attribute is not treated as the end.
  let i = from
  let inSingle = false
  let inDouble = false
  while (i < input.length) {
    const c = input[i]
    if (c === '"' && !inSingle) inDouble = !inDouble
    else if (c === "'" && !inDouble) inSingle = !inSingle
    else if (c === ">" && !inSingle && !inDouble) return i
    i++
  }
  throw new Error("xml.parse: unterminated tag")
}

function parseTagBody(body: string): { name: string; attrs: Record<string, string> } {
  // First whitespace splits name from attribute soup.
  const m = body.match(/^([^\s/>]+)\s*([\s\S]*)$/)
  if (!m) throw new Error(`xml.parse: malformed tag '${body}'`)
  const name = m[1]!
  const rest = (m[2] ?? "").trim()
  const attrs: Record<string, string> = {}
  let i = 0
  while (i < rest.length) {
    while (i < rest.length && /\s/.test(rest[i]!)) i++
    if (i >= rest.length) break
    let kStart = i
    while (i < rest.length && !/[\s=]/.test(rest[i]!)) i++
    const key = rest.slice(kStart, i)
    while (i < rest.length && /\s/.test(rest[i]!)) i++
    if (rest[i] !== "=") {
      // Boolean attribute (rare in XML but tolerate it).
      attrs[key] = ""
      continue
    }
    i++
    while (i < rest.length && /\s/.test(rest[i]!)) i++
    const quote = rest[i]
    if (quote !== '"' && quote !== "'") {
      throw new Error(`xml.parse: attribute '${key}' value must be quoted`)
    }
    const close = rest.indexOf(quote, i + 1)
    if (close === -1) throw new Error(`xml.parse: unterminated attribute '${key}'`)
    attrs[key] = decodeEntities(rest.slice(i + 1, close))
    i = close + 1
  }
  return { name, attrs }
}

function nodeToJson(node: Node, opts: ParseOpts): unknown {
  const hasAttrs = Object.keys(node.attrs).length > 0
  const childrenNodes = node.children.filter((c): c is Node => typeof c !== "string")
  const childrenText = node.children
    .filter((c): c is string => typeof c === "string")
    .join("")
    .trim()

  if (!hasAttrs && childrenNodes.length === 0) {
    return childrenText
  }

  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(node.attrs)) out[opts.attributePrefix + k] = v

  for (const child of childrenNodes) {
    const childValue = nodeToJson(child, opts)
    if (Object.prototype.hasOwnProperty.call(out, child.name)) {
      const cur = out[child.name]
      if (Array.isArray(cur)) cur.push(childValue)
      else out[child.name] = [cur, childValue]
    } else {
      out[child.name] = childValue
    }
  }

  if (childrenText.length > 0 && childrenNodes.length > 0) {
    out[opts.textKey] = childrenText
  } else if (childrenText.length > 0) {
    out[opts.textKey] = childrenText
  }
  return out
}

// --- XML stringifier ----------------------------------------------------

type StringifyOpts = ParseOpts & { pretty: boolean; declaration: boolean }

export function stringifyXml(value: unknown, opts: StringifyOpts): string {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("xml.stringify: top-level value must be an object with exactly one root key")
  }
  const keys = Object.keys(value as Record<string, unknown>)
  if (keys.length !== 1) {
    throw new Error("xml.stringify: top-level object must have exactly one root key")
  }
  const rootName = keys[0]!
  const rootValue = (value as Record<string, unknown>)[rootName]
  const lines: string[] = []
  if (opts.declaration) lines.push('<?xml version="1.0" encoding="UTF-8"?>')
  emit(rootName, rootValue, opts, lines, 0)
  return lines.join(opts.pretty ? "\n" : "")
}

function emit(name: string, value: unknown, opts: StringifyOpts, out: string[], depth: number): void {
  const indent = opts.pretty ? "  ".repeat(depth) : ""

  if (Array.isArray(value)) {
    for (const item of value) emit(name, item, opts, out, depth)
    return
  }
  if (value === null || value === undefined) {
    out.push(`${indent}<${name}/>`)
    return
  }
  if (typeof value !== "object") {
    out.push(`${indent}<${name}>${encodeEntities(String(value))}</${name}>`)
    return
  }

  // Object with possible attributes (@-prefixed) and children.
  const obj = value as Record<string, unknown>
  const attrs: [string, string][] = []
  const text: string[] = []
  const children: [string, unknown][] = []
  for (const [k, v] of Object.entries(obj)) {
    if (k.startsWith(opts.attributePrefix)) {
      attrs.push([k.slice(opts.attributePrefix.length), v == null ? "" : String(v)])
    } else if (k === opts.textKey) {
      text.push(v == null ? "" : String(v))
    } else {
      children.push([k, v])
    }
  }

  const attrStr = attrs.map(([k, v]) => ` ${k}="${encodeEntities(v, true)}"`).join("")

  if (children.length === 0 && text.length === 0) {
    out.push(`${indent}<${name}${attrStr}/>`)
    return
  }
  if (children.length === 0) {
    out.push(`${indent}<${name}${attrStr}>${encodeEntities(text.join(""))}</${name}>`)
    return
  }
  out.push(`${indent}<${name}${attrStr}>`)
  if (text.length > 0) {
    const textIndent = opts.pretty ? "  ".repeat(depth + 1) : ""
    out.push(`${textIndent}${encodeEntities(text.join(""))}`)
  }
  for (const [ck, cv] of children) emit(ck, cv, opts, out, depth + 1)
  out.push(`${indent}</${name}>`)
}

// --- Tool wrapper -------------------------------------------------------

export const XmlTool = Tool.define(
  "xml",
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Params, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const start = Date.now()
          const action = params.action
          const opts = {
            attributePrefix: params.attribute_prefix ?? "@",
            textKey: params.text_key ?? "#text",
            pretty: params.pretty ?? true,
            declaration: params.xml_declaration ?? true,
          }

          let inputText: string | undefined
          let inputBytes = 0
          if (params.filePath !== undefined) {
            const target = path.isAbsolute(params.filePath)
              ? params.filePath
              : path.resolve(Instance.directory, params.filePath)
            yield* ctx.ask({
              permission: "read",
              patterns: [target],
              always: ["*"],
              metadata: { filePath: target, action },
            })
            yield* assertExternalDirectoryEffect(ctx, target, { kind: "file" })
            const info = yield* fs.stat(target).pipe(Effect.catch(() => Effect.succeed(undefined)))
            if (!info) throw new Error(`xml: file not found: ${target}`)
            if (info.type !== "File") throw new Error(`xml: not a regular file: ${target}`)
            inputBytes = Number(info.size ?? 0)
            if (inputBytes > MAX_INPUT_BYTES) {
              throw new Error(`xml: file too large (${inputBytes} bytes > ${MAX_INPUT_BYTES})`)
            }
            inputText = yield* Effect.promise(() => readFile(target, "utf8"))
          } else if (params.content !== undefined) {
            inputText = params.content
            inputBytes = Buffer.byteLength(inputText, "utf8")
          } else {
            throw new Error("xml: provide either 'content' or 'filePath'")
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

          if (action === "parse" || action === "to_json") {
            let value: unknown
            try {
              value = parseXml(inputText!, opts)
            } catch (err: unknown) {
              const msg = err instanceof Error ? err.message : String(err)
              throw new Error(`xml.parse: ${msg}`)
            }
            const text = opts.pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value)
            if (outputPath) {
              yield* Effect.promise(() => writeFile(outputPath!, text + "\n", "utf8"))
              const after = yield* Effect.promise(() => fsStat(outputPath!).then((s) => Number(s.size)))
              return done({
                title: `xml ${action} → ${outputPath}`,
                metadata: {
                  action,
                  filePath: params.filePath,
                  output_path: outputPath,
                  bytes_in: inputBytes,
                  bytes_out: after,
                  elapsed_ms: Date.now() - start,
                },
                output: `wrote ${after} bytes to ${outputPath}`,
              })
            }
            return done({
              title: `xml ${action}: ${text.length} chars`,
              metadata: {
                action,
                filePath: params.filePath,
                bytes_in: inputBytes,
                elapsed_ms: Date.now() - start,
              },
              output: truncate(text),
            })
          }

          // stringify / from_json
          let value: unknown
          try {
            value = JSON.parse(inputText!)
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err)
            throw new Error(`xml.${action}: input must be JSON: ${msg}`)
          }
          let text: string
          try {
            text = stringifyXml(value, opts)
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err)
            throw new Error(`xml.${action}: ${msg}`)
          }
          if (outputPath) {
            const final = text.endsWith("\n") ? text : text + "\n"
            yield* Effect.promise(() => writeFile(outputPath!, final, "utf8"))
            const after = yield* Effect.promise(() => fsStat(outputPath!).then((s) => Number(s.size)))
            return done({
              title: `xml ${action} → ${outputPath}`,
              metadata: {
                action,
                filePath: params.filePath,
                output_path: outputPath,
                bytes_in: inputBytes,
                bytes_out: after,
                elapsed_ms: Date.now() - start,
              },
              output: `wrote ${after} bytes to ${outputPath}`,
            })
          }
          return done({
            title: `xml ${action}: ${text.length} chars`,
            metadata: {
              action,
              filePath: params.filePath,
              bytes_in: inputBytes,
              elapsed_ms: Date.now() - start,
            },
            output: truncate(text),
          })
        }),
    }
  }),
)

export const __testing = {
  parseXml,
  stringifyXml,
  decodeEntities,
  encodeEntities,
}
