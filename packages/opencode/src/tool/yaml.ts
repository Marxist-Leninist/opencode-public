import { Effect, Schema } from "effect"
import { readFile, writeFile, stat as fsStat } from "node:fs/promises"
import * as path from "node:path"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Instance } from "../project/instance"
import { assertExternalDirectoryEffect } from "./external-directory"
import DESCRIPTION from "./yaml.txt"
import * as Tool from "./tool"

const ACTIONS = ["parse", "stringify", "to_json", "from_json"] as const
const MAX_INPUT_BYTES = 32 * 1024 * 1024
const MAX_OUTPUT_CHARS = 16_000

export const Parameters = Schema.Struct({
  action: Schema.Literals(ACTIONS).annotate({
    description:
      "parse: YAML → JSON. stringify: arbitrary JSON value → YAML. to_json: alias of parse, output is JSON text. from_json: alias of stringify, input is a JSON value (object/array/scalar).",
  }),
  content: Schema.optional(Schema.String).annotate({
    description: "Inline input text. For parse/to_json: YAML. For stringify/from_json: JSON.",
  }),
  filePath: Schema.optional(Schema.String).annotate({
    description: "Read input from this file instead of `content`. Absolute or relative to project directory.",
  }),
  output_path: Schema.optional(Schema.String).annotate({
    description: "Write the result to this file instead of returning inline. Absolute or relative to project directory.",
  }),
  pretty: Schema.optional(Schema.Boolean).annotate({
    description: "For parse/to_json: pretty-print JSON output (default true).",
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

export const YamlTool = Tool.define(
  "yaml",
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
            if (!info) throw new Error(`yaml: file not found: ${target}`)
            if (info.type !== "File") throw new Error(`yaml: not a regular file: ${target}`)
            inputBytes = Number(info.size ?? 0)
            if (inputBytes > MAX_INPUT_BYTES) {
              throw new Error(`yaml: file too large (${inputBytes} bytes > ${MAX_INPUT_BYTES})`)
            }
            inputText = yield* Effect.promise(() => readFile(target, "utf8"))
          } else if (params.content !== undefined) {
            inputText = params.content
            inputBytes = Buffer.byteLength(inputText, "utf8")
          } else {
            throw new Error("yaml: provide either 'content' or 'filePath'")
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

          // YAML.parse / stringify is provided by Bun's built-in.
          const yamlNs: { parse: (s: string) => unknown; stringify: (v: unknown) => string } | undefined =
            (globalThis as any).Bun?.YAML
          if (!yamlNs?.parse || !yamlNs?.stringify) {
            throw new Error("yaml: Bun.YAML is not available in this runtime")
          }

          if (action === "parse" || action === "to_json") {
            let value: unknown
            try {
              value = yamlNs.parse(inputText!)
            } catch (err: unknown) {
              const msg = err instanceof Error ? err.message : String(err)
              throw new Error(`yaml.parse: ${msg}`)
            }
            const pretty = params.pretty ?? true
            const text = pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value)
            if (outputPath) {
              yield* Effect.promise(() => writeFile(outputPath!, text + "\n", "utf8"))
              const after = yield* Effect.promise(() => fsStat(outputPath!).then((s) => Number(s.size)))
              return done({
                title: `yaml ${action} → ${outputPath}`,
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
              title: `yaml ${action}: ${text.length} chars`,
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
            throw new Error(`yaml.${action}: input must be JSON: ${msg}`)
          }
          let text: string
          try {
            text = yamlNs.stringify(value)
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err)
            throw new Error(`yaml.${action}: failed to encode: ${msg}`)
          }
          if (outputPath) {
            const final = text.endsWith("\n") ? text : text + "\n"
            yield* Effect.promise(() => writeFile(outputPath!, final, "utf8"))
            const after = yield* Effect.promise(() => fsStat(outputPath!).then((s) => Number(s.size)))
            return done({
              title: `yaml ${action} → ${outputPath}`,
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
            title: `yaml ${action}: ${text.length} chars`,
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
