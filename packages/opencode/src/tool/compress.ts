import { Effect, Schema } from "effect"
import {
  brotliCompressSync,
  brotliDecompressSync,
  constants as zlibConstants,
  deflateRawSync,
  deflateSync,
  gunzipSync,
  gzipSync,
  inflateRawSync,
  inflateSync,
} from "node:zlib"
import { writeFile } from "node:fs/promises"
import * as path from "path"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Instance } from "../project/instance"
import { assertExternalDirectoryEffect } from "./external-directory"
import DESCRIPTION from "./compress.txt"
import * as Tool from "./tool"

const ACTIONS = ["compress", "decompress"] as const
const ALGORITHMS = ["gzip", "deflate", "deflate-raw", "brotli"] as const
const VALUE_ENCODINGS = ["utf8", "hex", "base64", "base64url"] as const
const OUTPUT_ENCODINGS = ["utf8", "hex", "base64", "base64url"] as const

const MAX_INLINE_BYTES = 64 * 1024 * 1024 // 64 MiB

export const Parameters = Schema.Struct({
  action: Schema.Literals(ACTIONS).annotate({
    description: "compress or decompress",
  }),
  algorithm: Schema.Literals(ALGORITHMS).annotate({
    description: "gzip | deflate | deflate-raw | brotli",
  }),
  value: Schema.optional(Schema.String).annotate({
    description: "Inline input. Mutually exclusive with inputPath.",
  }),
  inputPath: Schema.optional(Schema.String).annotate({
    description: "File path to read input from.",
  }),
  outputPath: Schema.optional(Schema.String).annotate({
    description: "Optional file path to write output to (in addition to inline result).",
  }),
  value_encoding: Schema.optional(Schema.Literals(VALUE_ENCODINGS)).annotate({
    description: "How to interpret `value`. Default utf8 (compress) or base64 (decompress).",
  }),
  output_encoding: Schema.optional(Schema.Literals(OUTPUT_ENCODINGS)).annotate({
    description: "Encoding for inline output. Default base64 (compress) or utf8 (decompress).",
  }),
  level: Schema.optional(
    Schema.Number.check(Schema.isInt())
      .check(Schema.isGreaterThanOrEqualTo(0))
      .check(Schema.isLessThanOrEqualTo(11)),
  ).annotate({
    description: "Compression level 0-11. Default 6 (gzip/deflate) / 4 (brotli).",
  }),
})

type Params = Schema.Schema.Type<typeof Parameters>
type Action = (typeof ACTIONS)[number]
type Algorithm = (typeof ALGORITHMS)[number]
type ValueEncoding = (typeof VALUE_ENCODINGS)[number]
type OutputEncoding = (typeof OUTPUT_ENCODINGS)[number]

type Metadata = {
  action: Action
  algorithm: Algorithm
  input_bytes: number
  output_bytes: number
  ratio?: number
  outputPath?: string
  result?: string
}

function decodeValue(value: string, enc: ValueEncoding): Buffer {
  if (enc === "utf8") return Buffer.from(value, "utf8")
  if (enc === "hex") return Buffer.from(value.replace(/[^0-9a-fA-F]/g, ""), "hex")
  if (enc === "base64") return Buffer.from(value, "base64")
  if (enc === "base64url") return Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64")
  throw new Error(`compress: unknown value_encoding '${enc}'`)
}

function encodeOutput(buf: Buffer, enc: OutputEncoding): string {
  if (enc === "utf8") return buf.toString("utf8")
  if (enc === "hex") return buf.toString("hex")
  if (enc === "base64") return buf.toString("base64")
  if (enc === "base64url") {
    return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "")
  }
  throw new Error(`compress: unknown output_encoding '${enc}'`)
}

export function compressBuffer(buf: Buffer, algo: Algorithm, level?: number): Buffer {
  if (algo === "gzip") return gzipSync(buf, level !== undefined ? { level } : undefined)
  if (algo === "deflate") return deflateSync(buf, level !== undefined ? { level } : undefined)
  if (algo === "deflate-raw") return deflateRawSync(buf, level !== undefined ? { level } : undefined)
  if (algo === "brotli") {
    const params = level !== undefined ? { [zlibConstants.BROTLI_PARAM_QUALITY]: level } : undefined
    return brotliCompressSync(buf, params ? { params } : undefined)
  }
  throw new Error(`compress: unknown algorithm '${algo}'`)
}

export function decompressBuffer(buf: Buffer, algo: Algorithm): Buffer {
  if (algo === "gzip") return gunzipSync(buf)
  if (algo === "deflate") return inflateSync(buf)
  if (algo === "deflate-raw") return inflateRawSync(buf)
  if (algo === "brotli") return brotliDecompressSync(buf)
  throw new Error(`compress: unknown algorithm '${algo}'`)
}

const done = (result: Tool.ExecuteResult<Metadata>) => result

export const CompressTool = Tool.define(
  "compress",
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Params, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const action = params.action
          const algo = params.algorithm
          const hasValue = typeof params.value === "string" && params.value.length > 0
          const hasFile = typeof params.inputPath === "string" && params.inputPath.length > 0
          if (!hasValue && !hasFile) throw new Error("compress: pass either `value` or `inputPath`")
          if (hasValue && hasFile) throw new Error("compress: pass exactly one of `value` or `inputPath`")

          const valEnc: ValueEncoding =
            params.value_encoding ?? (action === "compress" ? "utf8" : "base64")
          const outEnc: OutputEncoding =
            params.output_encoding ?? (action === "compress" ? "base64" : "utf8")

          let input: Buffer
          if (hasValue) {
            input = decodeValue(params.value!, valEnc)
            if (input.byteLength > MAX_INLINE_BYTES) {
              throw new Error(`compress: input exceeds ${MAX_INLINE_BYTES} bytes — use inputPath`)
            }
          } else {
            const target = path.isAbsolute(params.inputPath!)
              ? params.inputPath!
              : path.resolve(Instance.directory, params.inputPath!)
            yield* ctx.ask({
              permission: "read",
              patterns: [target],
              always: ["*"],
              metadata: { filePath: target, algo, action },
            })
            yield* assertExternalDirectoryEffect(ctx, target, { kind: "file" })
            const info = yield* fs.stat(target).pipe(Effect.catch(() => Effect.succeed(undefined)))
            if (!info) throw new Error(`compress: file not found: ${target}`)
            if (info.type !== "File") throw new Error(`compress: not a regular file: ${target}`)
            const data = yield* Effect.promise(() => Bun.file(target).arrayBuffer())
            input = Buffer.from(data)
          }

          const output =
            action === "compress" ? compressBuffer(input, algo, params.level) : decompressBuffer(input, algo)

          const meta: Metadata = {
            action,
            algorithm: algo,
            input_bytes: input.byteLength,
            output_bytes: output.byteLength,
            ratio: action === "compress" ? Number((output.byteLength / Math.max(1, input.byteLength)).toFixed(4)) : undefined,
          }

          if (params.outputPath) {
            const target = path.isAbsolute(params.outputPath)
              ? params.outputPath
              : path.resolve(Instance.directory, params.outputPath)
            yield* ctx.ask({
              permission: "write",
              patterns: [target],
              always: ["*"],
              metadata: { filePath: target, algo, action },
            })
            yield* assertExternalDirectoryEffect(ctx, target, { kind: "file" })
            yield* Effect.promise(() => writeFile(target, output))
            meta.outputPath = target
          }

          let resultStr: string | undefined
          // Avoid returning huge inline strings; cap at 4 MiB encoded.
          const inlineCap = 4 * 1024 * 1024
          if (output.byteLength <= inlineCap || !params.outputPath) {
            resultStr = encodeOutput(output, outEnc)
            meta.result = resultStr
          }

          const ratioStr =
            action === "compress" && input.byteLength > 0
              ? ` (${((output.byteLength * 100) / input.byteLength).toFixed(1)}%)`
              : ""

          return done({
            title: `${action}.${algo}: ${input.byteLength}B → ${output.byteLength}B${ratioStr}`,
            metadata: meta,
            output: params.outputPath
              ? `wrote ${output.byteLength} bytes to ${meta.outputPath}${resultStr ? `\n${resultStr}` : ""}`
              : resultStr ?? `${output.byteLength} bytes (output exceeded inline cap; pass outputPath)`,
          })
        }),
    }
  }),
)

export const __testing = {
  decodeValue,
  encodeOutput,
}
