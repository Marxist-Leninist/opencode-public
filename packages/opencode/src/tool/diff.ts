import { Effect, Schema } from "effect"
import { readFile, writeFile, stat as fsStat } from "node:fs/promises"
import * as path from "node:path"
import { createTwoFilesPatch, diffLines, diffWords, diffChars, type Change } from "diff"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Instance } from "../project/instance"
import { assertExternalDirectoryEffect } from "./external-directory"
import DESCRIPTION from "./diff.txt"
import * as Tool from "./tool"

const FORMATS = ["unified", "lines", "words", "chars", "stat"] as const
const MAX_INPUT_BYTES = 32 * 1024 * 1024
const MAX_OUTPUT_CHARS = 16_000

export const Parameters = Schema.Struct({
  format: Schema.optional(Schema.Literals(FORMATS)).annotate({
    description:
      "Output format. unified (default) — RFC unified diff with @@ hunks. lines — colour-free per-line {+,-,=}. words — per-word diff. chars — per-character. stat — only counts (added/removed lines).",
  }),
  a: Schema.optional(Schema.String).annotate({ description: "Inline left-side text." }),
  b: Schema.optional(Schema.String).annotate({ description: "Inline right-side text." }),
  a_path: Schema.optional(Schema.String).annotate({
    description: "Read left-side from this file. Absolute or relative to project directory.",
  }),
  b_path: Schema.optional(Schema.String).annotate({
    description: "Read right-side from this file. Absolute or relative to project directory.",
  }),
  output_path: Schema.optional(Schema.String).annotate({
    description: "Write the diff output to this file (instead of returning inline).",
  }),
  context: Schema.optional(Schema.Number.check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(0))).annotate({
    description: "Lines of context for unified format. Default 3.",
  }),
  ignore_whitespace: Schema.optional(Schema.Boolean).annotate({
    description: "Ignore whitespace differences (treat them as equal). Default false.",
  }),
  label_a: Schema.optional(Schema.String).annotate({
    description: "Header label for the left side in unified output. Defaults to a_path or 'a'.",
  }),
  label_b: Schema.optional(Schema.String).annotate({
    description: "Header label for the right side in unified output. Defaults to b_path or 'b'.",
  }),
})

type Params = Schema.Schema.Type<typeof Parameters>
type Format = (typeof FORMATS)[number]

type Metadata = {
  format: Format
  added_lines?: number
  removed_lines?: number
  unchanged_lines?: number
  identical?: boolean
  a_path?: string
  b_path?: string
  output_path?: string
  bytes_a?: number
  bytes_b?: number
  bytes_out?: number
  elapsed_ms?: number
}

function truncateOutput(s: string): string {
  if (s.length <= MAX_OUTPUT_CHARS) return s
  return s.slice(0, MAX_OUTPUT_CHARS) + `\n... [truncated ${s.length - MAX_OUTPUT_CHARS} chars]`
}

function countLines(s: string): number {
  if (s.length === 0) return 0
  // Count terminated lines + a trailing partial line
  let n = 0
  for (let i = 0; i < s.length; i++) if (s[i] === "\n") n++
  if (!s.endsWith("\n")) n++
  return n
}

function tally(parts: Change[]): { added: number; removed: number; unchanged: number } {
  let added = 0
  let removed = 0
  let unchanged = 0
  for (const p of parts) {
    const lines = countLines(p.value)
    if (p.added) added += lines
    else if (p.removed) removed += lines
    else unchanged += lines
  }
  return { added, removed, unchanged }
}

function renderLines(parts: Change[]): string {
  const out: string[] = []
  for (const p of parts) {
    const sigil = p.added ? "+" : p.removed ? "-" : " "
    const lines = p.value.split("\n")
    // diffLines emits a trailing "" for terminated runs; drop it.
    if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop()
    for (const ln of lines) out.push(`${sigil}${ln}`)
  }
  return out.join("\n") + (out.length > 0 ? "\n" : "")
}

const done = (result: Tool.ExecuteResult<Metadata>) => result

function renderInline(parts: Change[]): string {
  const out: string[] = []
  for (const p of parts) {
    if (p.added) out.push(`{+${p.value}+}`)
    else if (p.removed) out.push(`[-${p.value}-]`)
    else out.push(p.value)
  }
  return out.join("")
}

export const DiffTool = Tool.define(
  "diff",
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Params, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const start = Date.now()
          const fmt: Format = params.format ?? "unified"

          const sides: Array<{ text: string; bytes: number; path: string | undefined }> = []
          for (const [label, inline, file] of [
            ["a", params.a, params.a_path] as const,
            ["b", params.b, params.b_path] as const,
          ]) {
            if (file !== undefined) {
              const target = path.isAbsolute(file) ? file : path.resolve(Instance.directory, file)
              yield* ctx.ask({
                permission: "read",
                patterns: [target],
                always: ["*"],
                metadata: { filePath: target },
              })
              yield* assertExternalDirectoryEffect(ctx, target, { kind: "file" })
              const info = yield* fs.stat(target).pipe(Effect.catch(() => Effect.succeed(undefined)))
              if (!info) throw new Error(`diff: ${label}_path not found: ${target}`)
              if (info.type !== "File") throw new Error(`diff: ${label}_path is not a regular file: ${target}`)
              const size = Number(info.size ?? 0)
              if (size > MAX_INPUT_BYTES) {
                throw new Error(`diff: ${label}_path too large (${size} bytes > ${MAX_INPUT_BYTES})`)
              }
              const text = yield* Effect.promise(() => readFile(target, "utf8"))
              sides.push({ text, bytes: size, path: target })
            } else if (inline !== undefined) {
              sides.push({ text: inline, bytes: Buffer.byteLength(inline, "utf8"), path: undefined })
            } else {
              throw new Error(`diff: provide '${label}' or '${label}_path'`)
            }
          }
          const a = sides[0]!
          const b = sides[1]!

          let outputPath: string | undefined
          if (params.output_path !== undefined) {
            outputPath = path.isAbsolute(params.output_path)
              ? params.output_path
              : path.resolve(Instance.directory, params.output_path)
            yield* ctx.ask({
              permission: "write",
              patterns: [outputPath],
              always: ["*"],
              metadata: { filePath: outputPath },
            })
            yield* assertExternalDirectoryEffect(ctx, outputPath, { kind: "file" })
          }

          const ignoreWhitespace = params.ignore_whitespace ?? false
          const lineParts = diffLines(a.text, b.text, { ignoreWhitespace })
          const t = tally(lineParts)
          const identical = t.added === 0 && t.removed === 0

          let text: string
          if (fmt === "unified") {
            const labelA = params.label_a ?? params.a_path ?? "a"
            const labelB = params.label_b ?? params.b_path ?? "b"
            const ctxLines = params.context ?? 3
            text = createTwoFilesPatch(labelA, labelB, a.text, b.text, "", "", { context: ctxLines })
          } else if (fmt === "lines") {
            text = renderLines(lineParts)
          } else if (fmt === "words") {
            const wp = diffWords(a.text, b.text)
            text = renderInline(wp)
          } else if (fmt === "chars") {
            const cp = diffChars(a.text, b.text)
            text = renderInline(cp)
          } else {
            // stat
            text = `+${t.added} -${t.removed} =${t.unchanged}\n`
          }

          const meta: Metadata = {
            format: fmt,
            added_lines: t.added,
            removed_lines: t.removed,
            unchanged_lines: t.unchanged,
            identical,
            a_path: a.path,
            b_path: b.path,
            bytes_a: a.bytes,
            bytes_b: b.bytes,
            elapsed_ms: Date.now() - start,
          }

          if (outputPath) {
            yield* Effect.promise(() => writeFile(outputPath!, text, "utf8"))
            const after = yield* Effect.promise(() => fsStat(outputPath!).then((s) => Number(s.size)))
            return done({
              title: `diff ${fmt}: +${t.added} -${t.removed} → ${outputPath}`,
              metadata: { ...meta, output_path: outputPath, bytes_out: after },
              output: `wrote ${after} bytes to ${outputPath}`,
            })
          }

          return done({
            title: identical
              ? `diff ${fmt}: identical`
              : `diff ${fmt}: +${t.added} -${t.removed}`,
            metadata: meta,
            output: truncateOutput(text),
          })
        }),
    }
  }),
)

export const __testing = {
  countLines,
  tally,
  renderLines,
  renderInline,
}
