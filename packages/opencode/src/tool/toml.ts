import { Effect, Schema } from "effect"
import { Instance } from "../project/instance"
import * as nodePath from "node:path"
import { promises as fs } from "node:fs"
import DESCRIPTION from "./toml.txt"
import * as Tool from "./tool"

const ACTIONS = ["parse", "stringify", "to_json", "from_json"] as const

export const Parameters = Schema.Struct({
  action: Schema.Literals(ACTIONS).annotate({ description: ACTIONS.join(" | ") }),
  value: Schema.optional(Schema.String).annotate({ description: "TOML text (parse) or JSON-encoded string (stringify)." }),
  data: Schema.optional(Schema.Unknown).annotate({ description: "JSON value to stringify." }),
  filePath: Schema.optional(Schema.String).annotate({ description: "Read TOML from this file." }),
  output_path: Schema.optional(Schema.String).annotate({ description: "Write stringify result to this file." }),
  pretty: Schema.optional(Schema.Boolean).annotate({ description: "Pretty-print stringify (default true)." }),
})

type Params = Schema.Schema.Type<typeof Parameters>

type Metadata = {
  action: (typeof ACTIONS)[number]
  bytes_in?: number
  bytes_out?: number
  source?: "value" | "filePath"
  output_path?: string
}

// ---------------- Parser ----------------

class TomlParser {
  src: string
  pos = 0
  line = 1
  col = 1
  constructor(src: string) {
    this.src = src
  }
  peek(off = 0) {
    return this.src[this.pos + off]
  }
  eof() {
    return this.pos >= this.src.length
  }
  advance(n = 1) {
    while (n-- > 0 && !this.eof()) {
      const ch = this.src[this.pos++]
      if (ch === "\n") {
        this.line++
        this.col = 1
      } else this.col++
    }
  }
  err(msg: string): never {
    throw new Error(`TOML: ${msg} at line ${this.line}:${this.col}`)
  }
  skipWS(includeNewline = false) {
    while (!this.eof()) {
      const ch = this.peek()
      if (ch === " " || ch === "\t") this.advance()
      else if (ch === "#") {
        while (!this.eof() && this.peek() !== "\n") this.advance()
      } else if (includeNewline && (ch === "\n" || ch === "\r")) {
        this.advance()
      } else break
    }
  }
  expectEol() {
    this.skipWS(false)
    if (this.eof()) return
    const ch = this.peek()
    if (ch === "\n") this.advance()
    else if (ch === "\r") {
      this.advance()
      if (this.peek() === "\n") this.advance()
    } else this.err(`expected end of line, got '${ch}'`)
  }
  match(s: string): boolean {
    if (this.src.startsWith(s, this.pos)) {
      this.advance(s.length)
      return true
    }
    return false
  }
  parse(): Record<string, unknown> {
    const root: Record<string, unknown> = {}
    let current: Record<string, unknown> = root
    let currentArrayPath: string[] | null = null
    const definedTables = new Set<string>()
    while (!this.eof()) {
      this.skipWS(true)
      if (this.eof()) break
      if (this.peek() === "[") {
        // Section header
        const isArr = this.peek(1) === "["
        this.advance(isArr ? 2 : 1)
        this.skipWS(false)
        const keyPath = this.parseKeyPath()
        this.skipWS(false)
        const closeStr = isArr ? "]]" : "]"
        if (!this.match(closeStr)) this.err(`expected '${closeStr}'`)
        this.expectEol()
        const fullKey = keyPath.join(".")
        if (isArr) {
          // [[a.b]] : create/append array of tables
          let parent: Record<string, unknown> = root
          for (let i = 0; i < keyPath.length - 1; i++) {
            const k = keyPath[i]!
            if (parent[k] === undefined) parent[k] = {}
            const v = parent[k]
            if (Array.isArray(v)) {
              const last = v[v.length - 1]
              if (last && typeof last === "object") parent = last as Record<string, unknown>
              else this.err(`'${keyPath.slice(0, i + 1).join(".")}' is not a table`)
            } else if (v && typeof v === "object") parent = v as Record<string, unknown>
            else this.err(`'${keyPath.slice(0, i + 1).join(".")}' is not a table`)
          }
          const last = keyPath[keyPath.length - 1]!
          if (parent[last] === undefined) parent[last] = []
          if (!Array.isArray(parent[last])) this.err(`'${fullKey}' redefined as array of tables`)
          const newTbl: Record<string, unknown> = {}
          ;(parent[last] as unknown[]).push(newTbl)
          current = newTbl
          currentArrayPath = keyPath
        } else {
          if (definedTables.has(fullKey)) this.err(`duplicate table [${fullKey}]`)
          definedTables.add(fullKey)
          let parent: Record<string, unknown> = root
          for (let i = 0; i < keyPath.length - 1; i++) {
            const k = keyPath[i]!
            if (parent[k] === undefined) parent[k] = {}
            const v = parent[k]
            if (Array.isArray(v)) {
              const lastEl = v[v.length - 1]
              if (lastEl && typeof lastEl === "object") parent = lastEl as Record<string, unknown>
              else this.err(`'${keyPath.slice(0, i + 1).join(".")}' is not a table`)
            } else if (v && typeof v === "object") parent = v as Record<string, unknown>
            else this.err(`'${keyPath.slice(0, i + 1).join(".")}' is not a table`)
          }
          const last = keyPath[keyPath.length - 1]!
          if (parent[last] === undefined) parent[last] = {}
          if (typeof parent[last] !== "object" || Array.isArray(parent[last]))
            this.err(`'${fullKey}' redefined`)
          current = parent[last] as Record<string, unknown>
          currentArrayPath = null
        }
        continue
      }
      // Key/value pair
      const keyPath = this.parseKeyPath()
      this.skipWS(false)
      if (!this.match("=")) this.err(`expected '=' after key`)
      this.skipWS(false)
      const value = this.parseValue()
      this.expectEol()
      // Place value in current table (with possibly nested keys)
      let target: Record<string, unknown> = current
      for (let i = 0; i < keyPath.length - 1; i++) {
        const k = keyPath[i]!
        if (target[k] === undefined) target[k] = {}
        if (typeof target[k] !== "object" || Array.isArray(target[k]))
          this.err(`'${keyPath.slice(0, i + 1).join(".")}' is not a table`)
        target = target[k] as Record<string, unknown>
      }
      const last = keyPath[keyPath.length - 1]!
      if (target[last] !== undefined) this.err(`duplicate key '${keyPath.join(".")}'`)
      target[last] = value
    }
    void currentArrayPath
    return root
  }
  parseKeyPath(): string[] {
    const parts: string[] = []
    parts.push(this.parseKey())
    while (true) {
      this.skipWS(false)
      if (this.peek() !== ".") break
      this.advance()
      this.skipWS(false)
      parts.push(this.parseKey())
    }
    return parts
  }
  parseKey(): string {
    const ch = this.peek()
    if (ch === '"') return this.parseBasicString(false)
    if (ch === "'") return this.parseLiteralString(false)
    let key = ""
    while (!this.eof()) {
      const c = this.peek()
      if (/[A-Za-z0-9_-]/.test(c!)) {
        key += c
        this.advance()
      } else break
    }
    if (!key) this.err("expected key")
    return key
  }
  parseValue(): unknown {
    const ch = this.peek()
    if (ch === '"') {
      if (this.src.startsWith('"""', this.pos)) return this.parseMultilineBasicString()
      return this.parseBasicString(false)
    }
    if (ch === "'") {
      if (this.src.startsWith("'''", this.pos)) return this.parseMultilineLiteralString()
      return this.parseLiteralString(false)
    }
    if (ch === "[") return this.parseArray()
    if (ch === "{") return this.parseInlineTable()
    if (ch === "t" || ch === "f") return this.parseBool()
    return this.parseNumberOrDate()
  }
  parseBasicString(_multi: boolean): string {
    this.advance() // opening "
    let out = ""
    while (!this.eof()) {
      const ch = this.peek()
      if (ch === '"') {
        this.advance()
        return out
      }
      if (ch === "\\") {
        this.advance()
        const esc = this.peek()
        this.advance()
        if (esc === "n") out += "\n"
        else if (esc === "t") out += "\t"
        else if (esc === "r") out += "\r"
        else if (esc === "b") out += "\b"
        else if (esc === "f") out += "\f"
        else if (esc === "\\") out += "\\"
        else if (esc === '"') out += '"'
        else if (esc === "u") {
          const hex = this.src.substr(this.pos, 4)
          this.advance(4)
          out += String.fromCodePoint(parseInt(hex, 16))
        } else if (esc === "U") {
          const hex = this.src.substr(this.pos, 8)
          this.advance(8)
          out += String.fromCodePoint(parseInt(hex, 16))
        } else if (esc === "/") out += "/"
        else this.err(`invalid escape \\${esc}`)
      } else if (ch === "\n") {
        this.err("unterminated basic string")
      } else {
        out += ch
        this.advance()
      }
    }
    this.err("unterminated basic string")
  }
  parseMultilineBasicString(): string {
    this.advance(3)
    if (this.peek() === "\n") this.advance()
    else if (this.peek() === "\r" && this.peek(1) === "\n") this.advance(2)
    let out = ""
    while (!this.eof()) {
      if (this.src.startsWith('"""', this.pos)) {
        this.advance(3)
        // strip trailing newline before closing? TOML spec only strips opening one.
        return out
      }
      const ch = this.peek()
      if (ch === "\\") {
        // Could be line-ending backslash (continuation) or normal escape.
        const nxt = this.peek(1)
        if (nxt === "\n" || nxt === "\r" || nxt === " " || nxt === "\t") {
          // skip whitespace until next non-ws
          this.advance() // consume backslash
          while (!this.eof()) {
            const c = this.peek()
            if (c === " " || c === "\t" || c === "\n" || c === "\r") this.advance()
            else break
          }
          continue
        }
        // Reuse simple escape parsing
        this.advance()
        const esc = this.peek()
        this.advance()
        if (esc === "n") out += "\n"
        else if (esc === "t") out += "\t"
        else if (esc === "r") out += "\r"
        else if (esc === "b") out += "\b"
        else if (esc === "f") out += "\f"
        else if (esc === "\\") out += "\\"
        else if (esc === '"') out += '"'
        else if (esc === "u") {
          const hex = this.src.substr(this.pos, 4)
          this.advance(4)
          out += String.fromCodePoint(parseInt(hex, 16))
        } else if (esc === "U") {
          const hex = this.src.substr(this.pos, 8)
          this.advance(8)
          out += String.fromCodePoint(parseInt(hex, 16))
        } else this.err(`invalid escape \\${esc}`)
      } else {
        out += ch
        this.advance()
      }
    }
    this.err("unterminated multi-line string")
  }
  parseLiteralString(_multi: boolean): string {
    this.advance() // opening '
    let out = ""
    while (!this.eof()) {
      const ch = this.peek()
      if (ch === "'") {
        this.advance()
        return out
      }
      if (ch === "\n") this.err("unterminated literal string")
      out += ch
      this.advance()
    }
    this.err("unterminated literal string")
  }
  parseMultilineLiteralString(): string {
    this.advance(3)
    if (this.peek() === "\n") this.advance()
    else if (this.peek() === "\r" && this.peek(1) === "\n") this.advance(2)
    let out = ""
    while (!this.eof()) {
      if (this.src.startsWith("'''", this.pos)) {
        this.advance(3)
        return out
      }
      out += this.peek()
      this.advance()
    }
    this.err("unterminated multi-line literal string")
  }
  parseBool(): boolean {
    if (this.match("true")) return true
    if (this.match("false")) return false
    this.err("expected bool")
  }
  parseNumberOrDate(): unknown {
    // Capture token
    const start = this.pos
    while (!this.eof()) {
      const c = this.peek()!
      if (c === "\n" || c === "\r" || c === "," || c === "]" || c === "}" || c === "#") break
      this.advance()
    }
    const raw = this.src.slice(start, this.pos).trim()
    if (!raw.length) this.err("expected value")
    // Date / time / datetime: leave as string for JSON-friendliness
    if (/^\d{4}-\d{2}-\d{2}(?:[Tt ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})?)?$/.test(raw)) return raw
    if (/^\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(raw)) return raw
    if (raw === "inf" || raw === "+inf") return Infinity
    if (raw === "-inf") return -Infinity
    if (raw === "nan" || raw === "+nan" || raw === "-nan") return NaN
    // Hex/oct/bin
    if (/^[+-]?0x[0-9A-Fa-f_]+$/.test(raw)) return parseInt(raw.replace(/_/g, "").slice(raw.startsWith("-") ? 3 : 2) , 16) * (raw.startsWith("-") ? -1 : 1)
    if (/^[+-]?0o[0-7_]+$/.test(raw)) return parseInt(raw.replace(/_/g, "").slice(raw.startsWith("-") ? 3 : 2), 8) * (raw.startsWith("-") ? -1 : 1)
    if (/^[+-]?0b[01_]+$/.test(raw)) return parseInt(raw.replace(/_/g, "").slice(raw.startsWith("-") ? 3 : 2), 2) * (raw.startsWith("-") ? -1 : 1)
    // Integer or float
    const cleaned = raw.replace(/_/g, "")
    if (/^[+-]?\d+$/.test(cleaned)) return parseInt(cleaned, 10)
    if (/^[+-]?(\d+(\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(cleaned)) return parseFloat(cleaned)
    this.err(`invalid value '${raw}'`)
  }
  parseArray(): unknown[] {
    this.advance() // [
    const out: unknown[] = []
    while (!this.eof()) {
      this.skipWS(true)
      if (this.peek() === "]") {
        this.advance()
        return out
      }
      const v = this.parseValue()
      out.push(v)
      this.skipWS(true)
      if (this.peek() === ",") {
        this.advance()
        this.skipWS(true)
      } else if (this.peek() === "]") {
        this.advance()
        return out
      } else this.err("expected ',' or ']'")
    }
    this.err("unterminated array")
  }
  parseInlineTable(): Record<string, unknown> {
    this.advance() // {
    const out: Record<string, unknown> = {}
    this.skipWS(false)
    if (this.peek() === "}") {
      this.advance()
      return out
    }
    while (true) {
      this.skipWS(false)
      const keyPath = this.parseKeyPath()
      this.skipWS(false)
      if (!this.match("=")) this.err("expected '='")
      this.skipWS(false)
      const v = this.parseValue()
      let target: Record<string, unknown> = out
      for (let i = 0; i < keyPath.length - 1; i++) {
        const k = keyPath[i]!
        if (target[k] === undefined) target[k] = {}
        target = target[k] as Record<string, unknown>
      }
      target[keyPath[keyPath.length - 1]!] = v
      this.skipWS(false)
      if (this.peek() === ",") {
        this.advance()
        continue
      }
      if (this.peek() === "}") {
        this.advance()
        return out
      }
      this.err("expected ',' or '}'")
    }
  }
}

export function parseTOML(src: string): Record<string, unknown> {
  const p = new TomlParser(src)
  return p.parse()
}

// ---------------- Stringify ----------------

const BARE_KEY_RE = /^[A-Za-z0-9_-]+$/

function quoteKey(k: string): string {
  if (BARE_KEY_RE.test(k)) return k
  return JSON.stringify(k)
}

function quoteString(s: string): string {
  return JSON.stringify(s)
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v)
}

function isArrayOfTables(v: unknown): boolean {
  return Array.isArray(v) && v.length > 0 && v.every((el) => isPlainObject(el))
}

function inlineValue(v: unknown): string {
  if (v === null) throw new Error("TOML cannot encode null")
  if (typeof v === "string") return quoteString(v)
  if (typeof v === "number") {
    if (Number.isNaN(v)) return "nan"
    if (!Number.isFinite(v)) return v > 0 ? "inf" : "-inf"
    if (Number.isInteger(v)) return String(v)
    return String(v)
  }
  if (typeof v === "boolean") return String(v)
  if (Array.isArray(v)) return "[" + v.map(inlineValue).join(", ") + "]"
  if (isPlainObject(v)) {
    const entries = Object.entries(v).map(([k, val]) => `${quoteKey(k)} = ${inlineValue(val)}`)
    return "{ " + entries.join(", ") + " }"
  }
  throw new Error(`TOML cannot encode value of type ${typeof v}`)
}

function emitTable(obj: Record<string, unknown>, prefix: string[]): string {
  const scalars: string[] = []
  const tables: string[] = []
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue
    if (isPlainObject(v)) {
      const next = [...prefix, k]
      tables.push(`\n[${next.map(quoteKey).join(".")}]\n` + emitTable(v as Record<string, unknown>, next))
    } else if (isArrayOfTables(v)) {
      const next = [...prefix, k]
      const header = `[[${next.map(quoteKey).join(".")}]]`
      for (const el of v as Record<string, unknown>[]) {
        tables.push(`\n${header}\n` + emitTable(el, next))
      }
    } else {
      scalars.push(`${quoteKey(k)} = ${inlineValue(v)}`)
    }
  }
  return scalars.join("\n") + (scalars.length ? "\n" : "") + tables.join("")
}

export function stringifyTOML(obj: unknown): string {
  if (!isPlainObject(obj)) throw new Error("TOML root must be an object")
  const body = emitTable(obj as Record<string, unknown>, [])
  return body.endsWith("\n") ? body : body + "\n"
}

// ---------------- Tool ----------------

const done = (result: Tool.ExecuteResult<Metadata>) => result

function resolvePath(p: string): string {
  return nodePath.isAbsolute(p) ? p : nodePath.join(Instance.directory, p)
}

export const TomlTool = Tool.define(
  "toml",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Params, _ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const action = params.action
          const isParse = action === "parse" || action === "to_json"
          const isStringify = action === "stringify" || action === "from_json"

          if (isParse) {
            let text: string
            let source: "value" | "filePath"
            if (params.filePath) {
              const abs = resolvePath(params.filePath)
              text = yield* Effect.promise(() => fs.readFile(abs, "utf8"))
              source = "filePath"
            } else if (params.value !== undefined) {
              text = params.value
              source = "value"
            } else throw new Error("toml.parse: requires `value` or `filePath`")
            const obj = parseTOML(text)
            const out = JSON.stringify(obj, null, 2)
            return done({
              title: `toml.parse: ${Object.keys(obj).length} top-level keys`,
              metadata: { action, bytes_in: text.length, bytes_out: out.length, source },
              output: out,
            })
          }

          if (isStringify) {
            let data: unknown
            if (params.data !== undefined) data = params.data
            else if (params.value !== undefined) {
              try {
                data = JSON.parse(params.value)
              } catch (e: any) {
                throw new Error(`toml.stringify: \`value\` is not valid JSON (${e?.message ?? e})`)
              }
            } else throw new Error("toml.stringify: requires `data` or JSON-encoded `value`")
            const text = stringifyTOML(data)
            let outputPath: string | undefined
            if (params.output_path) {
              const abs = resolvePath(params.output_path)
              yield* Effect.promise(() => fs.mkdir(nodePath.dirname(abs), { recursive: true }))
              yield* Effect.promise(() => fs.writeFile(abs, text, "utf8"))
              outputPath = abs
            }
            return done({
              title: `toml.stringify: ${text.length} bytes${outputPath ? ` → ${outputPath}` : ""}`,
              metadata: { action, bytes_out: text.length, output_path: outputPath },
              output: outputPath ? `Wrote ${text.length} bytes → ${outputPath}` : text,
            })
          }

          throw new Error(`toml: unknown action '${action}'`)
        }),
    }
  }),
)

export const __testing = {
  parseTOML,
  stringifyTOML,
}
