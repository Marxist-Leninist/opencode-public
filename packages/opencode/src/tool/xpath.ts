import { Effect, Schema } from "effect"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Instance } from "../project/instance"
import { assertExternalDirectoryEffect } from "./external-directory"
import DESCRIPTION from "./xpath.txt"
import * as Tool from "./tool"

const MODES = ["values", "xml", "paths", "first", "count"] as const
const MAX_FILE_BYTES = 64 * 1024 * 1024
const MAX_OUTPUT_CHARS = 32_000
const MAX_DATA_BYTES = 8 * 1024 * 1024
const DEFAULT_LIMIT = 100
const MAX_LIMIT = 1000
const MAX_RECURSION_DEPTH = 256

export const Parameters = Schema.Struct({
  path: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2048)).annotate({
    description:
      "XPath-like expression. Examples: '/rss/channel/title', '//item/link', \"//book[@category='fiction']/title\".",
  }),
  data: Schema.optional(Schema.String).annotate({
    description: "Inline XML string to query. Use this OR filePath, not both. Up to ~8 MiB.",
  }),
  filePath: Schema.optional(Schema.String).annotate({
    description:
      "Path to an XML file to query. Absolute preferred; relative paths resolve from the project directory. Up to 64 MiB.",
  }),
  mode: Schema.optional(Schema.Literals(MODES)).annotate({
    description:
      "values (default): JSON array of matched values. xml: matched nodes as XML fragments. paths: canonical XPath paths. first: first match. count: number of matches.",
  }),
  limit: Schema.optional(
    Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(MAX_LIMIT)),
  ).annotate({
    description: `Cap on returned matches (1-${MAX_LIMIT}). Default ${DEFAULT_LIMIT}.`,
  }),
  pretty: Schema.optional(Schema.Boolean).annotate({
    description: "Pretty-print XML output (default false). Only affects mode=xml.",
  }),
})

type Params = Schema.Schema.Type<typeof Parameters>
type Mode = (typeof MODES)[number]

type Metadata = {
  mode: Mode
  path: string
  source: "data" | "file"
  filePath?: string
  matches: number
  truncated?: boolean
  capped?: boolean
  elapsed_ms: number
}

const done = (result: Tool.ExecuteResult<Metadata>) => result

// ---------- XML node tree ----------

export type XmlElement = {
  type: "element"
  name: string
  attrs: Record<string, string>
  children: XmlNode[]
}
type XmlText = { type: "text"; value: string }
type XmlNode = XmlElement | XmlText

function isElement(n: XmlNode): n is XmlElement {
  return n.type === "element"
}

// ---------- XML parser ----------

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

function encodeText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

function encodeAttr(s: string): string {
  return encodeText(s).replace(/"/g, "&quot;")
}

export function parseXmlTree(input: string): XmlElement {
  let i = 0
  const n = input.length
  if (input.charCodeAt(0) === 0xfeff) i = 1
  while (i < n && /\s/.test(input[i]!)) i++

  if (input.startsWith("<?xml", i)) {
    const end = input.indexOf("?>", i)
    if (end === -1) throw new Error("xpath: unterminated XML declaration")
    i = end + 2
  }

  const stack: XmlElement[] = []
  let root: XmlElement | undefined

  while (i < n) {
    if (input[i] === "<") {
      if (input.startsWith("<!--", i)) {
        const end = input.indexOf("-->", i + 4)
        if (end === -1) throw new Error("xpath: unterminated comment")
        i = end + 3
        continue
      }
      if (input.startsWith("<![CDATA[", i)) {
        const end = input.indexOf("]]>", i + 9)
        if (end === -1) throw new Error("xpath: unterminated CDATA")
        const text = input.slice(i + 9, end)
        if (stack.length > 0) stack[stack.length - 1]!.children.push({ type: "text", value: text })
        i = end + 3
        continue
      }
      if (input.startsWith("<!", i) || input.startsWith("<?", i)) {
        const end = input.indexOf(">", i)
        if (end === -1) throw new Error("xpath: unterminated <! or <? section")
        i = end + 1
        continue
      }
      if (input[i + 1] === "/") {
        const end = input.indexOf(">", i)
        if (end === -1) throw new Error("xpath: unterminated closing tag")
        const name = input.slice(i + 2, end).trim()
        const top = stack.pop()
        if (!top) throw new Error(`xpath: closing tag </${name}> with no open element`)
        if (top.name !== name) {
          throw new Error(`xpath: closing tag </${name}> does not match open <${top.name}>`)
        }
        i = end + 1
        continue
      }
      const tagEnd = findTagEnd(input, i + 1)
      const raw = input.slice(i + 1, tagEnd)
      const selfClose = raw.endsWith("/")
      const body = selfClose ? raw.slice(0, -1).trim() : raw.trim()
      const { name, attrs } = parseTagBody(body)
      const node: XmlElement = { type: "element", name, attrs, children: [] }
      if (stack.length > 0) {
        stack[stack.length - 1]!.children.push(node)
      } else {
        if (root) throw new Error("xpath: multiple root elements")
        root = node
      }
      if (!selfClose) stack.push(node)
      i = tagEnd + 1
      continue
    }
    const next = input.indexOf("<", i)
    const chunk = next === -1 ? input.slice(i) : input.slice(i, next)
    if (stack.length > 0 && chunk.length > 0) {
      stack[stack.length - 1]!.children.push({ type: "text", value: decodeEntities(chunk) })
    }
    i = next === -1 ? n : next
  }

  if (stack.length > 0) {
    throw new Error(`xpath: unclosed element <${stack[stack.length - 1]!.name}>`)
  }
  if (!root) throw new Error("xpath: no root element found")
  return root
}

function findTagEnd(input: string, from: number): number {
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
  throw new Error("xpath: unterminated tag")
}

function parseTagBody(body: string): { name: string; attrs: Record<string, string> } {
  const m = body.match(/^([^\s/>]+)\s*([\s\S]*)$/)
  if (!m) throw new Error(`xpath: malformed tag '${body}'`)
  const name = m[1]!
  const rest = (m[2] ?? "").trim()
  const attrs: Record<string, string> = {}
  let i = 0
  while (i < rest.length) {
    while (i < rest.length && /\s/.test(rest[i]!)) i++
    if (i >= rest.length) break
    const kStart = i
    while (i < rest.length && !/[\s=]/.test(rest[i]!)) i++
    const key = rest.slice(kStart, i)
    while (i < rest.length && /\s/.test(rest[i]!)) i++
    if (rest[i] !== "=") {
      attrs[key] = ""
      continue
    }
    i++
    while (i < rest.length && /\s/.test(rest[i]!)) i++
    const quote = rest[i]
    if (quote !== '"' && quote !== "'") {
      throw new Error(`xpath: attribute '${key}' value must be quoted`)
    }
    const close = rest.indexOf(quote, i + 1)
    if (close === -1) throw new Error(`xpath: unterminated attribute '${key}'`)
    attrs[key] = decodeEntities(rest.slice(i + 1, close))
    i = close + 1
  }
  return { name, attrs }
}

// ---------- XPath parser ----------

type Predicate =
  | { kind: "position"; n: number } // [N], 1-based
  | { kind: "last" } // [last()]
  | { kind: "attrExists"; name: string } // [@x]
  | { kind: "attrEquals"; name: string; value: string } // [@x='v']

type Step =
  | { kind: "child"; name: string; predicates: Predicate[] }
  | { kind: "descendant"; name: string; predicates: Predicate[] }
  | { kind: "wildcard"; descendant: boolean; predicates: Predicate[] }
  | { kind: "attribute"; name: string }
  | { kind: "text" }
  | { kind: "name" }

export function parseXpath(input: string): { absolute: boolean; steps: Step[] } {
  const trimmed = input.trim()
  if (!trimmed) throw new Error("xpath: empty path")

  let s = trimmed
  let absolute = false
  if (s.startsWith("//")) {
    // descendant-or-self start; we model it as absolute=true with first step kind=descendant
    absolute = true
  } else if (s.startsWith("/")) {
    absolute = true
    s = s.slice(1)
  }

  const steps: Step[] = []
  let i = 0
  let pendingDescendant = false
  if (trimmed.startsWith("//")) {
    s = trimmed.slice(2)
    pendingDescendant = true
  }

  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i]!)) i++
    if (i >= s.length) break

    if (s.startsWith("//", i)) {
      pendingDescendant = true
      i += 2
      continue
    }
    if (s[i] === "/") {
      i++
      continue
    }

    // attribute step
    if (s[i] === "@") {
      i++
      const start = i
      while (i < s.length && /[A-Za-z0-9_:.-]/.test(s[i]!)) i++
      const name = s.slice(start, i)
      if (!name) throw new Error("xpath: expected attribute name after @")
      steps.push({ kind: "attribute", name })
      continue
    }

    // text() / name() / last()
    if (s.startsWith("text()", i)) {
      steps.push({ kind: "text" })
      i += "text()".length
      continue
    }
    if (s.startsWith("name()", i)) {
      steps.push({ kind: "name" })
      i += "name()".length
      continue
    }

    // wildcard or named element
    let name: string
    if (s[i] === "*") {
      name = "*"
      i++
    } else {
      const start = i
      while (i < s.length && /[A-Za-z0-9_:.-]/.test(s[i]!)) i++
      name = s.slice(start, i)
      if (!name) throw new Error(`xpath: expected name at offset ${i + 1}`)
    }

    const predicates: Predicate[] = []
    while (s[i] === "[") {
      const end = findClosingBracket(s, i)
      const body = s.slice(i + 1, end).trim()
      predicates.push(parsePredicate(body))
      i = end + 1
    }

    if (name === "*") {
      steps.push({ kind: "wildcard", descendant: pendingDescendant, predicates })
    } else if (pendingDescendant) {
      steps.push({ kind: "descendant", name, predicates })
    } else {
      steps.push({ kind: "child", name, predicates })
    }
    pendingDescendant = false
  }

  return { absolute, steps }
}

function findClosingBracket(s: string, openIdx: number): number {
  let depth = 1
  let i = openIdx + 1
  let inSingle = false
  let inDouble = false
  while (i < s.length) {
    const c = s[i]
    if (c === '"' && !inSingle) inDouble = !inDouble
    else if (c === "'" && !inDouble) inSingle = !inSingle
    else if (!inSingle && !inDouble) {
      if (c === "[") depth++
      else if (c === "]") {
        depth--
        if (depth === 0) return i
      }
    }
    i++
  }
  throw new Error("xpath: unterminated predicate")
}

function parsePredicate(body: string): Predicate {
  if (/^\d+$/.test(body)) {
    const n = parseInt(body, 10)
    if (n < 1) throw new Error("xpath: position predicate must be >= 1")
    return { kind: "position", n }
  }
  if (body === "last()") return { kind: "last" }
  if (body.startsWith("@")) {
    const eq = body.indexOf("=")
    if (eq === -1) {
      const name = body.slice(1).trim()
      if (!name) throw new Error("xpath: empty attribute predicate")
      return { kind: "attrExists", name }
    }
    const name = body.slice(1, eq).trim()
    const rhs = body.slice(eq + 1).trim()
    const m = rhs.match(/^(['"])(.*)\1$/s)
    if (!m) throw new Error(`xpath: attribute value must be quoted (got '${rhs}')`)
    return { kind: "attrEquals", name, value: m[2]! }
  }
  throw new Error(`xpath: unsupported predicate '[${body}]'`)
}

// ---------- Evaluator ----------

type ElementMatch = { kind: "element"; node: XmlElement; path: PathSegment[] }
type AttrMatch = { kind: "attribute"; name: string; value: string; path: PathSegment[] }
type TextMatch = { kind: "text"; value: string; path: PathSegment[] }
type NameMatch = { kind: "name"; value: string; path: PathSegment[] }
export type XpathMatch = ElementMatch | AttrMatch | TextMatch | NameMatch

type PathSegment = { name: string; index: number; nameIndex: number } // index is overall sibling index, nameIndex is 1-based among same-name siblings

function applyPredicates(elements: XmlElement[], predicates: Predicate[]): XmlElement[] {
  if (predicates.length === 0) return elements
  let cur = elements
  for (const pred of predicates) {
    if (pred.kind === "position") {
      const out: XmlElement[] = []
      const e = cur[pred.n - 1]
      if (e) out.push(e)
      cur = out
    } else if (pred.kind === "last") {
      cur = cur.length > 0 ? [cur[cur.length - 1]!] : []
    } else if (pred.kind === "attrExists") {
      cur = cur.filter((el) => Object.prototype.hasOwnProperty.call(el.attrs, pred.name))
    } else if (pred.kind === "attrEquals") {
      cur = cur.filter((el) => el.attrs[pred.name] === pred.value)
    }
  }
  return cur
}

function children(el: XmlElement): XmlElement[] {
  return el.children.filter(isElement)
}

function descendantsAndSelf(el: XmlElement, out: XmlElement[] = []): XmlElement[] {
  out.push(el)
  for (const child of el.children) {
    if (isElement(child)) descendantsAndSelf(child, out)
  }
  return out
}

function descendantsAndSelfWithParents(
  el: XmlElement,
  parent: XmlElement,
  out: { el: XmlElement; parent: XmlElement }[] = [],
): { el: XmlElement; parent: XmlElement }[] {
  out.push({ el, parent })
  for (const child of el.children) {
    if (isElement(child)) descendantsAndSelfWithParents(child, el, out)
  }
  return out
}

function pathSegmentFor(parent: XmlElement, child: XmlElement): PathSegment {
  let nameIdx = 0
  let totalIdx = 0
  let found = -1
  let foundNameIdx = -1
  for (const c of parent.children) {
    if (!isElement(c)) continue
    totalIdx++
    if (c.name === child.name) nameIdx++
    if (c === child) {
      found = totalIdx
      foundNameIdx = nameIdx
      break
    }
  }
  return { name: child.name, index: found, nameIndex: foundNameIdx }
}

function elementText(el: XmlElement): string {
  let out = ""
  for (const c of el.children) {
    if (c.type === "text") out += c.value
    else out += elementText(c)
  }
  return out
}

export function evaluateXpath(
  root: XmlElement,
  parsed: { absolute: boolean; steps: Step[] },
  opts: { limit: number },
): { matches: XpathMatch[]; capped: boolean } {
  const out: XpathMatch[] = []
  let capped = false

  // Seed: if absolute, we start with [root]. The first step's name (if "child") must match root or we filter.
  // To allow //x or /a/b uniformly, we start as if the cursor were "at the root context" - and child steps
  // operate on it. For the first child step in absolute mode, we filter root by name.
  let cur: { el: XmlElement; path: PathSegment[] }[] = [
    { el: root, path: [{ name: root.name, index: 1, nameIndex: 1 }] },
  ]

  // Special case: absolute path with first step being a child step. The first child step
  // in XPath actually selects from the document root, which IS that element. So we re-interpret:
  // /a/b means root must be `a`, then child `b` of root. We already seed root.
  // If first step is "child name=X", we filter root by that name; if root.name != X, no matches.
  let first = true

  for (let stepIdx = 0; stepIdx < parsed.steps.length; stepIdx++) {
    const step = parsed.steps[stepIdx]!
    if (out.length >= opts.limit) {
      capped = true
      break
    }

    if (step.kind === "attribute" || step.kind === "text" || step.kind === "name") {
      // Terminal step: produces non-element matches from current elements.
      for (const ctx of cur) {
        if (out.length >= opts.limit) {
          capped = true
          break
        }
        if (step.kind === "attribute") {
          if (Object.prototype.hasOwnProperty.call(ctx.el.attrs, step.name)) {
            out.push({ kind: "attribute", name: step.name, value: ctx.el.attrs[step.name]!, path: ctx.path })
          }
        } else if (step.kind === "text") {
          out.push({ kind: "text", value: elementText(ctx.el), path: ctx.path })
        } else {
          out.push({ kind: "name", value: ctx.el.name, path: ctx.path })
        }
      }
      cur = []
      break // attribute/text/name must be the last step
    }

    const next: { el: XmlElement; path: PathSegment[] }[] = []

    for (const ctx of cur) {
      if (next.length + out.length >= opts.limit + opts.limit) break // cheap early-out

      let candidates: { el: XmlElement; parent: XmlElement }[]

      if (step.kind === "child") {
        if (first && parsed.absolute) {
          if (ctx.el.name === step.name || step.name === "*") {
            candidates = [{ el: ctx.el, parent: ctx.el }]
          } else {
            candidates = []
          }
        } else {
          candidates = children(ctx.el).map((c) => ({ el: c, parent: ctx.el }))
          if (step.name !== "*") candidates = candidates.filter((c) => c.el.name === step.name)
        }
      } else if (step.kind === "descendant") {
        if (first && parsed.absolute) {
          // // path: every descendant including root that matches name
          const all = descendantsAndSelfWithParents(ctx.el, ctx.el)
          candidates = all.filter((c) => c.el.name === step.name)
        } else {
          // From each context element, find its descendants (excluding self) matching name
          const list: { el: XmlElement; parent: XmlElement }[] = []
          collectDescendantsMatching(ctx.el, step.name, list, MAX_RECURSION_DEPTH)
          candidates = list
        }
      } else {
        // wildcard
        if (step.descendant) {
          if (first && parsed.absolute) {
            candidates = descendantsAndSelfWithParents(ctx.el, ctx.el)
          } else {
            const list: { el: XmlElement; parent: XmlElement }[] = []
            collectDescendantsMatching(ctx.el, "*", list, MAX_RECURSION_DEPTH)
            candidates = list
          }
        } else {
          if (first && parsed.absolute) {
            candidates = [{ el: ctx.el, parent: ctx.el }]
          } else {
            candidates = children(ctx.el).map((c) => ({ el: c, parent: ctx.el }))
          }
        }
      }

      const filtered = applyPredicates(
        candidates.map((c) => c.el),
        step.predicates,
      )
      const filteredSet = new Set(filtered)
      for (const cand of candidates) {
        if (!filteredSet.has(cand.el)) continue
        const seg =
          first && parsed.absolute && cand.el === root && cand.parent === root
            ? ctx.path[ctx.path.length - 1]!
            : pathSegmentFor(cand.parent, cand.el)
        const newPath =
          first && parsed.absolute && cand.el === root && cand.parent === root
            ? ctx.path
            : [...ctx.path, seg]
        next.push({ el: cand.el, path: newPath })
      }
    }

    cur = next
    first = false
  }

  // If we never emitted via terminal step, every remaining element becomes an element match.
  for (const ctx of cur) {
    if (out.length >= opts.limit) {
      capped = true
      break
    }
    out.push({ kind: "element", node: ctx.el, path: ctx.path })
  }

  return { matches: out, capped }
}

function collectDescendantsMatching(
  el: XmlElement,
  name: string,
  out: { el: XmlElement; parent: XmlElement }[],
  depth: number,
): void {
  if (depth <= 0) return
  for (const child of el.children) {
    if (!isElement(child)) continue
    if (name === "*" || child.name === name) {
      out.push({ el: child, parent: el })
    }
    collectDescendantsMatching(child, name, out, depth - 1)
  }
}

// ---------- Output formatting ----------

export function formatXpathPath(segs: PathSegment[]): string {
  return "/" + segs.map((s) => `${s.name}[${s.nameIndex}]`).join("/")
}

export function nodeToXmlString(node: XmlNode, pretty: boolean, indent = ""): string {
  if (node.type === "text") return encodeText(node.value)
  const attrs = Object.entries(node.attrs)
    .map(([k, v]) => ` ${k}="${encodeAttr(v)}"`)
    .join("")
  if (node.children.length === 0) return `${indent}<${node.name}${attrs}/>`
  const childTexts = node.children.map((c) =>
    pretty && c.type === "element" ? "\n" + nodeToXmlString(c, true, indent + "  ") : nodeToXmlString(c, pretty, indent + "  "),
  )
  const inner = childTexts.join("")
  const tail = pretty && node.children.some((c) => c.type === "element") ? "\n" + indent : ""
  return `${indent}<${node.name}${attrs}>${inner}${tail}</${node.name}>`
}

function matchToValue(m: XpathMatch): string {
  if (m.kind === "element") return elementText(m.node)
  if (m.kind === "attribute") return m.value
  if (m.kind === "text") return m.value
  return m.value
}

function truncate(s: string): { content: string; truncated: boolean } {
  if (s.length <= MAX_OUTPUT_CHARS) return { content: s, truncated: false }
  return { content: s.slice(0, MAX_OUTPUT_CHARS) + `\n... [truncated ${s.length - MAX_OUTPUT_CHARS} chars]`, truncated: true }
}

// ---------- Tool ----------

export const XpathTool = Tool.define(
  "xpath",
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Params, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const start = Date.now()
          const mode: Mode = params.mode ?? "values"
          const limit = params.limit ?? DEFAULT_LIMIT
          const pretty = params.pretty ?? false

          if (params.data === undefined && params.filePath === undefined) {
            throw new Error("xpath: either 'data' or 'filePath' must be provided")
          }
          if (params.data !== undefined && params.filePath !== undefined) {
            throw new Error("xpath: pass only one of 'data' or 'filePath', not both")
          }

          let raw: string
          let source: "data" | "file"
          let filePathResolved: string | undefined

          if (params.data !== undefined) {
            const sizeBytes = Buffer.byteLength(params.data, "utf8")
            if (sizeBytes > MAX_DATA_BYTES) {
              throw new Error(
                `xpath: 'data' too large (${sizeBytes} > ${MAX_DATA_BYTES} bytes); use filePath instead`,
              )
            }
            raw = params.data
            source = "data"
          } else {
            const target = path.isAbsolute(params.filePath!)
              ? params.filePath!
              : path.resolve(Instance.directory, params.filePath!)
            yield* ctx.ask({
              permission: "read",
              patterns: [target],
              always: ["*"],
              metadata: { filePath: target },
            })
            yield* assertExternalDirectoryEffect(ctx, target, { kind: "file" })
            const info = yield* fs.stat(target).pipe(Effect.catch(() => Effect.succeed(undefined)))
            if (!info) throw new Error(`xpath: file not found: ${target}`)
            if (info.type !== "File") throw new Error(`xpath: not a regular file: ${target}`)
            const sizeBytes = Number(info.size ?? 0)
            if (sizeBytes > MAX_FILE_BYTES) {
              throw new Error(`xpath: file too large (${sizeBytes} > ${MAX_FILE_BYTES} bytes); refusing to load`)
            }
            raw = yield* Effect.promise(() => readFile(target, "utf8"))
            source = "file"
            filePathResolved = target
          }

          const root = parseXmlTree(raw)
          const parsed = parseXpath(params.path)
          const { matches, capped } = evaluateXpath(root, parsed, { limit })

          const elapsed_ms = Date.now() - start

          if (mode === "count") {
            return done({
              title: `xpath ${params.path} -> ${matches.length}${capped ? "+" : ""}`,
              metadata: {
                mode,
                path: params.path,
                source,
                filePath: filePathResolved,
                matches: matches.length,
                capped,
                elapsed_ms,
              },
              output: capped ? `${matches.length}+ (capped at limit ${limit})` : String(matches.length),
            })
          }

          if (mode === "first") {
            const m = matches[0]
            const value = m === undefined ? null : matchToValue(m)
            const json = JSON.stringify(value)
            const t = truncate(json)
            return done({
              title:
                matches.length > 0
                  ? `xpath ${params.path} -> first match`
                  : `xpath ${params.path} -> no match`,
              metadata: {
                mode,
                path: params.path,
                source,
                filePath: filePathResolved,
                matches: matches.length,
                truncated: t.truncated,
                capped,
                elapsed_ms,
              },
              output: t.content,
            })
          }

          if (mode === "paths") {
            const list = matches.map((m) => {
              const base = formatXpathPath(m.path)
              if (m.kind === "attribute") return `${base}/@${m.name}`
              if (m.kind === "text") return `${base}/text()`
              if (m.kind === "name") return `${base}/name()`
              return base
            })
            const out = list.join("\n")
            const t = truncate(out)
            return done({
              title: `xpath ${params.path} -> ${list.length}${capped ? "+" : ""} paths`,
              metadata: {
                mode,
                path: params.path,
                source,
                filePath: filePathResolved,
                matches: list.length,
                truncated: t.truncated,
                capped,
                elapsed_ms,
              },
              output: t.content || "(no matches)",
            })
          }

          if (mode === "xml") {
            const fragments: string[] = []
            for (const m of matches) {
              if (m.kind === "element") fragments.push(nodeToXmlString(m.node, pretty))
              else if (m.kind === "attribute") fragments.push(`${m.name}="${encodeAttr(m.value)}"`)
              else fragments.push(encodeText(m.value))
            }
            const joined = fragments.join(pretty ? "\n" : "\n")
            const t = truncate(joined)
            return done({
              title: `xpath ${params.path} -> ${matches.length}${capped ? "+" : ""} fragments`,
              metadata: {
                mode,
                path: params.path,
                source,
                filePath: filePathResolved,
                matches: matches.length,
                truncated: t.truncated,
                capped,
                elapsed_ms,
              },
              output: t.content || "(no matches)",
            })
          }

          // values (default): JSON array of stringified values
          const vals = matches.map(matchToValue)
          const json = JSON.stringify(vals)
          const t = truncate(json)
          return done({
            title: `xpath ${params.path} -> ${vals.length}${capped ? "+" : ""} values`,
            metadata: {
              mode,
              path: params.path,
              source,
              filePath: filePathResolved,
              matches: vals.length,
              truncated: t.truncated,
              capped,
              elapsed_ms,
            },
            output: t.content,
          })
        }),
    }
  }),
)

export const __testing = {
  parseXmlTree,
  parseXpath,
  evaluateXpath,
  formatXpathPath,
  nodeToXmlString,
}
