import { Effect, Schema } from "effect"
import { readFile, writeFile, stat as fsStat } from "node:fs/promises"
import * as path from "node:path"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Instance } from "../project/instance"
import { assertExternalDirectoryEffect } from "./external-directory"
import DESCRIPTION from "./text.txt"
import * as Tool from "./tool"

const ACTIONS = [
  "count",
  "case",
  "slugify",
  "normalize",
  "trim",
  "lines",
  "reverse",
  "sort",
  "dedupe",
] as const

const CASE_MODES = ["lower", "upper", "title", "sentence", "snake", "kebab", "camel", "pascal", "constant"] as const

const MAX_INPUT_BYTES = 32 * 1024 * 1024
const MAX_OUTPUT_CHARS = 16_000

export const Parameters = Schema.Struct({
  action: Schema.Literals(ACTIONS).annotate({
    description:
      "count: characters/words/lines/bytes. case: convert to a case mode (set 'mode'). slugify: URL-safe slug. normalize: collapse whitespace. trim: strip leading/trailing whitespace per line or whole input. lines: head/tail/range/grep. reverse: reverse line order or characters. sort: sort lines (asc/desc, optional dedupe/case-insensitive/numeric). dedupe: remove duplicate lines preserving order.",
  }),
  content: Schema.optional(Schema.String).annotate({ description: "Inline input text." }),
  filePath: Schema.optional(Schema.String).annotate({
    description: "Read input from this file instead of `content`. Absolute or relative to project directory.",
  }),
  output_path: Schema.optional(Schema.String).annotate({
    description: "Write the result to a file instead of returning inline. Absolute or relative to project directory.",
  }),
  mode: Schema.optional(Schema.Literals(CASE_MODES)).annotate({
    description: "Case mode for `case`: lower, upper, title, sentence, snake, kebab, camel, pascal, constant.",
  }),
  separator: Schema.optional(Schema.String).annotate({
    description: "Separator for slugify (default '-'). One or more characters.",
  }),
  whole: Schema.optional(Schema.Boolean).annotate({
    description: "For trim: trim the whole string instead of per-line. Default false (per-line).",
  }),
  head: Schema.optional(Schema.Number.check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(0))).annotate({
    description: "lines: keep first N lines.",
  }),
  tail: Schema.optional(Schema.Number.check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(0))).annotate({
    description: "lines: keep last N lines.",
  }),
  range_start: Schema.optional(Schema.Number.check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(1))).annotate({
    description: "lines: 1-indexed start line for range.",
  }),
  range_end: Schema.optional(Schema.Number.check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(1))).annotate({
    description: "lines: 1-indexed inclusive end line for range.",
  }),
  grep: Schema.optional(Schema.String).annotate({
    description: "lines: keep lines matching this substring or regex (treated as regex if `grep_regex` is true).",
  }),
  grep_regex: Schema.optional(Schema.Boolean).annotate({
    description: "lines: interpret `grep` as a regular expression. Default false.",
  }),
  invert: Schema.optional(Schema.Boolean).annotate({
    description: "lines: invert grep — keep lines that DO NOT match. Default false.",
  }),
  desc: Schema.optional(Schema.Boolean).annotate({ description: "sort: descending. Default false." }),
  numeric: Schema.optional(Schema.Boolean).annotate({
    description: "sort: numeric sort (best-effort, falls back to string compare). Default false.",
  }),
  case_insensitive: Schema.optional(Schema.Boolean).annotate({
    description: "sort/dedupe: ignore case when comparing. Default false.",
  }),
  reverse_chars: Schema.optional(Schema.Boolean).annotate({
    description: "reverse: reverse characters instead of lines. Default false.",
  }),
})

type Params = Schema.Schema.Type<typeof Parameters>
type Action = (typeof ACTIONS)[number]
type CaseMode = (typeof CASE_MODES)[number]

type CountInfo = {
  characters: number
  bytes: number
  words: number
  lines: number
  graphemes_estimate?: number
}

type Metadata = {
  action: Action
  filePath?: string
  output_path?: string
  bytes_in?: number
  bytes_out?: number
  count?: CountInfo
  mode?: CaseMode
  elapsed_ms?: number
}

function truncate(s: string): string {
  if (s.length <= MAX_OUTPUT_CHARS) return s
  return s.slice(0, MAX_OUTPUT_CHARS) + `\n... [truncated ${s.length - MAX_OUTPUT_CHARS} chars]`
}

const done = (result: Tool.ExecuteResult<Metadata>) => result

function splitWords(s: string): string[] {
  // Split on whitespace and case transitions / non-alphanum.
  return s
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/g)
    .filter(Boolean)
}

export function toCase(s: string, mode: CaseMode): string {
  if (mode === "lower") return s.toLowerCase()
  if (mode === "upper") return s.toUpperCase()
  if (mode === "title") {
    return s.replace(/\b([a-zA-Z])([a-zA-Z]*)/g, (_m, a, b) => a.toUpperCase() + b.toLowerCase())
  }
  if (mode === "sentence") {
    const lower = s.toLowerCase()
    return lower.replace(/(^|[.!?]\s+)([a-z])/g, (_m, p, ch) => p + ch.toUpperCase())
  }
  const words = splitWords(s)
  if (words.length === 0) return ""
  if (mode === "snake") return words.map((w) => w.toLowerCase()).join("_")
  if (mode === "constant") return words.map((w) => w.toUpperCase()).join("_")
  if (mode === "kebab") return words.map((w) => w.toLowerCase()).join("-")
  if (mode === "camel") {
    return words
      .map((w, i) => (i === 0 ? w.toLowerCase() : w[0]!.toUpperCase() + w.slice(1).toLowerCase()))
      .join("")
  }
  if (mode === "pascal") {
    return words.map((w) => w[0]!.toUpperCase() + w.slice(1).toLowerCase()).join("")
  }
  return s
}

export function slugify(input: string, separator = "-"): string {
  // NFD-normalise to strip combining accents, then keep [a-z0-9] words.
  const cleaned = input
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9]+/g, " ")
    .trim()
    .toLowerCase()
  if (!cleaned) return ""
  return cleaned.split(/\s+/g).join(separator)
}

export function normalize(s: string): string {
  // Collapse runs of whitespace to a single space, normalise newlines first.
  return s.replace(/\r\n/g, "\n").replace(/[ \t]+/g, " ").replace(/\n[ \t]+/g, "\n").trim()
}

export function counts(s: string): CountInfo {
  const characters = s.length
  const bytes = Buffer.byteLength(s, "utf8")
  // Words: contiguous non-whitespace runs.
  const words = s.match(/\S+/g)?.length ?? 0
  // Lines: number of newline-terminated runs + a trailing partial line if present.
  let lines = 0
  for (let i = 0; i < s.length; i++) if (s[i] === "\n") lines++
  if (!s.endsWith("\n") && s.length > 0) lines++
  // Estimate graphemes via Intl.Segmenter when available — coarse but useful for emoji.
  let graphemes_estimate: number | undefined
  const Seg = (Intl as unknown as { Segmenter?: new (loc: string, opts: object) => any }).Segmenter
  if (Seg) {
    try {
      const seg = new Seg("en", { granularity: "grapheme" })
      let n = 0
      for (const _ of seg.segment(s)) n++
      graphemes_estimate = n
    } catch {
      /* ignore */
    }
  }
  return { characters, bytes, words, lines, graphemes_estimate }
}

export const TextTool = Tool.define(
  "text",
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Params, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const start = Date.now()
          const action = params.action

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
            if (!info) throw new Error(`text: file not found: ${target}`)
            if (info.type !== "File") throw new Error(`text: not a regular file: ${target}`)
            inputBytes = Number(info.size ?? 0)
            if (inputBytes > MAX_INPUT_BYTES) {
              throw new Error(`text: file too large (${inputBytes} bytes > ${MAX_INPUT_BYTES})`)
            }
            inputText = yield* Effect.promise(() => readFile(target, "utf8"))
          } else if (params.content !== undefined) {
            inputText = params.content
            inputBytes = Buffer.byteLength(inputText, "utf8")
          } else {
            throw new Error("text: provide either 'content' or 'filePath'")
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

          let resultText = ""
          let countInfo: CountInfo | undefined

          if (action === "count") {
            countInfo = counts(inputText!)
            const lines = [
              `characters: ${countInfo.characters}`,
              `bytes:      ${countInfo.bytes}`,
              `words:      ${countInfo.words}`,
              `lines:      ${countInfo.lines}`,
              countInfo.graphemes_estimate !== undefined
                ? `graphemes:  ${countInfo.graphemes_estimate}`
                : undefined,
            ].filter(Boolean) as string[]
            resultText = lines.join("\n")
          } else if (action === "case") {
            if (!params.mode) throw new Error("text.case: 'mode' is required")
            resultText = toCase(inputText!, params.mode)
          } else if (action === "slugify") {
            resultText = slugify(inputText!, params.separator ?? "-")
          } else if (action === "normalize") {
            resultText = normalize(inputText!)
          } else if (action === "trim") {
            if (params.whole) resultText = inputText!.trim()
            else resultText = inputText!.split("\n").map((l) => l.trimEnd()).join("\n").replace(/^\s+|\s+$/g, "")
          } else if (action === "lines") {
            let lines = inputText!.split("\n")
            // Strip trailing empty produced by trailing newline, retain otherwise.
            if (lines.length > 0 && lines[lines.length - 1] === "" && inputText!.endsWith("\n")) lines.pop()
            if (params.grep !== undefined) {
              const re = params.grep_regex ? new RegExp(params.grep) : undefined
              lines = lines.filter((l) => {
                const hit = re ? re.test(l) : l.includes(params.grep!)
                return params.invert ? !hit : hit
              })
            }
            if (params.range_start !== undefined || params.range_end !== undefined) {
              const start = (params.range_start ?? 1) - 1
              const end = params.range_end ?? lines.length
              lines = lines.slice(start, end)
            }
            if (params.head !== undefined) lines = lines.slice(0, params.head)
            if (params.tail !== undefined) lines = lines.slice(-params.tail)
            resultText = lines.join("\n")
          } else if (action === "reverse") {
            if (params.reverse_chars) resultText = Array.from(inputText!).reverse().join("")
            else {
              let lines = inputText!.split("\n")
              const trailing = lines.length > 0 && lines[lines.length - 1] === "" && inputText!.endsWith("\n")
              if (trailing) lines.pop()
              resultText = lines.reverse().join("\n") + (trailing ? "\n" : "")
            }
          } else if (action === "sort") {
            let lines = inputText!.split("\n")
            const trailing = lines.length > 0 && lines[lines.length - 1] === "" && inputText!.endsWith("\n")
            if (trailing) lines.pop()
            const ci = params.case_insensitive ?? false
            lines = lines.slice().sort((a, b) => {
              if (params.numeric) {
                const na = Number(a)
                const nb = Number(b)
                if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb
              }
              const ka = ci ? a.toLowerCase() : a
              const kb = ci ? b.toLowerCase() : b
              if (ka < kb) return -1
              if (ka > kb) return 1
              return 0
            })
            if (params.desc) lines.reverse()
            resultText = lines.join("\n") + (trailing ? "\n" : "")
          } else if (action === "dedupe") {
            const seen = new Set<string>()
            const lines = inputText!.split("\n")
            const trailing = lines.length > 0 && lines[lines.length - 1] === "" && inputText!.endsWith("\n")
            if (trailing) lines.pop()
            const ci = params.case_insensitive ?? false
            const kept: string[] = []
            for (const ln of lines) {
              const key = ci ? ln.toLowerCase() : ln
              if (seen.has(key)) continue
              seen.add(key)
              kept.push(ln)
            }
            resultText = kept.join("\n") + (trailing ? "\n" : "")
          }

          const meta: Metadata = {
            action,
            filePath: params.filePath,
            bytes_in: inputBytes,
            mode: params.mode,
            count: countInfo,
            elapsed_ms: Date.now() - start,
          }

          if (outputPath) {
            yield* Effect.promise(() => writeFile(outputPath!, resultText, "utf8"))
            const after = yield* Effect.promise(() => fsStat(outputPath!).then((s) => Number(s.size)))
            return done({
              title: `text ${action} → ${outputPath}`,
              metadata: { ...meta, output_path: outputPath, bytes_out: after },
              output: `wrote ${after} bytes to ${outputPath}`,
            })
          }
          return done({
            title:
              action === "count"
                ? `text count: ${countInfo!.characters}c / ${countInfo!.words}w / ${countInfo!.lines}l`
                : `text ${action}${params.mode ? ` (${params.mode})` : ""}`,
            metadata: meta,
            output: truncate(resultText),
          })
        }),
    }
  }),
)

export const __testing = {
  toCase,
  slugify,
  normalize,
  counts,
  splitWords,
}
