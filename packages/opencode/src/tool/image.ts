import { Effect, Schema } from "effect"
import { readFile, writeFile } from "node:fs/promises"
import * as path from "node:path"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Instance } from "../project/instance"
import { assertExternalDirectoryEffect } from "./external-directory"
import DESCRIPTION from "./image.txt"
import * as Tool from "./tool"

const ACTIONS = ["info", "data_url", "from_data_url"] as const
const FORMATS_OUT = ["text", "json"] as const

const MAX_INPUT_BYTES = 64 * 1024 * 1024
const MAX_DATA_URL_BYTES = 16 * 1024 * 1024
const MAX_BASE64_INLINE = 4 * 1024 * 1024

export const Parameters = Schema.Struct({
  action: Schema.Literals(ACTIONS).annotate({
    description:
      "info (parse header for format/width/height/depth/has_alpha), data_url (encode file as base64 data: URL), from_data_url (decode data: URL to file).",
  }),
  filePath: Schema.optional(Schema.String).annotate({
    description: "Image file path. Required for info and data_url. Absolute or project-relative.",
  }),
  data_url: Schema.optional(Schema.String).annotate({
    description: "data: URL (data:image/png;base64,...). Required for from_data_url.",
  }),
  output_path: Schema.optional(Schema.String).annotate({
    description: "Write the result to this file. For data_url, the data: URL string. For from_data_url, the decoded image bytes (required).",
  }),
  format: Schema.optional(Schema.Literals(FORMATS_OUT)).annotate({
    description: "'text' (default) or 'json' for info action.",
  }),
})

type Params = Schema.Schema.Type<typeof Parameters>
type Action = (typeof ACTIONS)[number]

type ImageInfo = {
  format: "png" | "jpeg" | "gif" | "webp" | "bmp" | "ico" | "svg" | "unknown"
  mime: string
  width?: number
  height?: number
  bit_depth?: number
  color_type?: string
  has_alpha?: boolean
  is_animated?: boolean
  bytes: number
}

type Metadata = {
  action: Action
  filePath?: string
  output_path?: string
  bytes_in?: number
  bytes_out?: number
  format?: string
  width?: number
  height?: number
  has_alpha?: boolean
  elapsed_ms?: number
}

const done = (result: Tool.ExecuteResult<Metadata>) => result

function readUInt32BE(buf: Buffer, offset: number): number {
  return buf.readUInt32BE(offset)
}
function readUInt32LE(buf: Buffer, offset: number): number {
  return buf.readUInt32LE(offset)
}
function readUInt16BE(buf: Buffer, offset: number): number {
  return buf.readUInt16BE(offset)
}
function readUInt16LE(buf: Buffer, offset: number): number {
  return buf.readUInt16LE(offset)
}

function detectFormat(buf: Buffer): ImageInfo["format"] {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "png"
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpeg"
  if (buf.length >= 6 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return "gif"
  if (
    buf.length >= 12 &&
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  ) return "webp"
  if (buf.length >= 2 && buf[0] === 0x42 && buf[1] === 0x4d) return "bmp"
  if (buf.length >= 4 && buf[0] === 0x00 && buf[1] === 0x00 && buf[2] === 0x01 && buf[3] === 0x00) return "ico"
  // SVG: text-based; allow leading whitespace and optional XML/UTF-8 BOM
  const head = buf.slice(0, Math.min(buf.length, 512)).toString("utf8").replace(/^﻿/, "").trimStart()
  if (head.startsWith("<?xml") || head.startsWith("<svg")) {
    if (head.toLowerCase().includes("<svg")) return "svg"
  }
  return "unknown"
}

const PNG_COLOR_TYPES: Record<number, string> = {
  0: "grayscale",
  2: "rgb",
  3: "indexed",
  4: "grayscale+alpha",
  6: "rgba",
}

export function parsePng(buf: Buffer): Partial<ImageInfo> {
  // PNG: signature(8) + IHDR chunk: length(4) + "IHDR"(4) + width(4) + height(4) + bit_depth(1) + color_type(1) + ...
  if (buf.length < 24) throw new Error("png: header truncated")
  const width = readUInt32BE(buf, 16)
  const height = readUInt32BE(buf, 20)
  const bit_depth = buf[24]
  const ct = buf[25]
  const color_type = (ct !== undefined && PNG_COLOR_TYPES[ct]) || `type ${ct}`
  const has_alpha = ct === 4 || ct === 6 || (ct === 3 && hasPngTrns(buf))
  // Animated PNG (APNG) has an "acTL" chunk before the first IDAT.
  const is_animated = scanForChunk(buf, "acTL", 8, 64 * 1024)
  return { width, height, bit_depth, color_type, has_alpha, is_animated }
}

function scanForChunk(buf: Buffer, name: string, start: number, maxScan: number): boolean {
  const target = Buffer.from(name, "ascii")
  const end = Math.min(buf.length - target.length, start + maxScan)
  for (let i = start; i <= end; i++) {
    if (
      buf[i] === target[0] &&
      buf[i + 1] === target[1] &&
      buf[i + 2] === target[2] &&
      buf[i + 3] === target[3]
    ) return true
  }
  return false
}

function hasPngTrns(buf: Buffer): boolean {
  // Walk PNG chunks until IDAT, look for tRNS.
  let off = 8
  while (off + 8 <= buf.length) {
    const len = readUInt32BE(buf, off)
    const type = buf.slice(off + 4, off + 8).toString("ascii")
    if (type === "tRNS") return true
    if (type === "IDAT") return false
    off += 8 + len + 4
    if (len < 0 || len > buf.length) return false
  }
  return false
}

export function parseJpeg(buf: Buffer): Partial<ImageInfo> {
  // JPEG: scan SOFn (0xFFC0..0xFFCF, excluding 0xFFC4, 0xFFC8, 0xFFCC) for dimensions.
  let off = 2
  while (off + 9 < buf.length) {
    if (buf[off] !== 0xff) {
      off++
      continue
    }
    const marker = buf[off + 1]
    if (marker === undefined) break
    // Stand-alone markers (no length): RST*, SOI, EOI, TEM
    if ((marker >= 0xd0 && marker <= 0xd9) || marker === 0x01) {
      off += 2
      continue
    }
    const segLen = readUInt16BE(buf, off + 2)
    if (
      marker >= 0xc0 && marker <= 0xcf &&
      marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    ) {
      const bit_depth = buf[off + 4]
      const height = readUInt16BE(buf, off + 5)
      const width = readUInt16BE(buf, off + 7)
      const components = buf[off + 9]
      const color_type =
        components === 1 ? "grayscale" : components === 3 ? "ycbcr" : components === 4 ? "cmyk" : `${components}-component`
      return { width, height, bit_depth, color_type, has_alpha: false }
    }
    off += 2 + segLen
  }
  throw new Error("jpeg: SOF marker not found")
}

export function parseGif(buf: Buffer): Partial<ImageInfo> {
  if (buf.length < 13) throw new Error("gif: header truncated")
  const width = readUInt16LE(buf, 6)
  const height = readUInt16LE(buf, 8)
  const packed = buf[10] ?? 0
  const bit_depth = (packed & 0x07) + 1
  // Animated GIF detection: scan for more than one image-descriptor (0x2C).
  let imageCount = 0
  for (let i = 13; i < Math.min(buf.length, 256 * 1024); i++) {
    if (buf[i] === 0x2c) {
      imageCount++
      if (imageCount > 1) break
    }
  }
  return { width, height, bit_depth, color_type: "indexed", has_alpha: true, is_animated: imageCount > 1 }
}

export function parseWebp(buf: Buffer): Partial<ImageInfo> {
  // RIFF .... WEBP <chunk>
  if (buf.length < 30) throw new Error("webp: header truncated")
  const chunk = buf.slice(12, 16).toString("ascii")
  if (chunk === "VP8 ") {
    // Lossy: width/height at offset 26..30, 14-bit
    const w = readUInt16LE(buf, 26) & 0x3fff
    const h = readUInt16LE(buf, 28) & 0x3fff
    return { width: w, height: h, color_type: "ycbcr", has_alpha: false }
  }
  if (chunk === "VP8L") {
    // Lossless: 14 bits each, packed at offsets 21..24
    const b0 = buf[21]!, b1 = buf[22]!, b2 = buf[23]!, b3 = buf[24]!
    const w = ((b1 & 0x3f) << 8 | b0) + 1
    const h = ((b3 & 0x0f) << 10 | b2 << 2 | (b1 >> 6)) + 1
    const has_alpha = (b3 & 0x10) !== 0
    return { width: w, height: h, color_type: "argb", has_alpha }
  }
  if (chunk === "VP8X") {
    const w = (buf[24]! | (buf[25]! << 8) | (buf[26]! << 16)) + 1
    const h = (buf[27]! | (buf[28]! << 8) | (buf[29]! << 16)) + 1
    const flags = buf[20] ?? 0
    const has_alpha = (flags & 0x10) !== 0
    const is_animated = (flags & 0x02) !== 0
    return { width: w, height: h, has_alpha, is_animated, color_type: "vp8x" }
  }
  throw new Error(`webp: unknown chunk '${chunk}'`)
}

export function parseBmp(buf: Buffer): Partial<ImageInfo> {
  if (buf.length < 30) throw new Error("bmp: header truncated")
  const dibSize = readUInt32LE(buf, 14)
  // BITMAPCOREHEADER (12) uses int16; later headers use int32.
  let width: number, height: number, bit_depth: number
  if (dibSize === 12) {
    width = readUInt16LE(buf, 18)
    height = readUInt16LE(buf, 20)
    bit_depth = readUInt16LE(buf, 24)
  } else {
    width = readUInt32LE(buf, 18) | 0
    height = Math.abs(readUInt32LE(buf, 22) | 0)
    bit_depth = readUInt16LE(buf, 28)
  }
  return { width, height, bit_depth, color_type: bit_depth >= 32 ? "rgba" : "rgb", has_alpha: bit_depth === 32 }
}

export function parseIco(buf: Buffer): Partial<ImageInfo> {
  if (buf.length < 16) throw new Error("ico: header truncated")
  const count = readUInt16LE(buf, 4)
  // First entry: width at 6, height at 7 — 0 means 256.
  const w0 = buf[6] ?? 0
  const h0 = buf[7] ?? 0
  const width = w0 === 0 ? 256 : w0
  const height = h0 === 0 ? 256 : h0
  const bit_depth = readUInt16LE(buf, 12)
  return { width, height, bit_depth, color_type: bit_depth >= 32 ? "rgba" : "indexed", has_alpha: bit_depth === 32, is_animated: false, ...(count > 1 ? { } : {}) }
}

export function parseSvg(buf: Buffer): Partial<ImageInfo> {
  const text = buf.toString("utf8")
  const tagMatch = text.match(/<svg\b[^>]*>/i)
  if (!tagMatch) throw new Error("svg: <svg> tag not found")
  const tag = tagMatch[0]
  function attr(name: string): string | undefined {
    const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"|\\b${name}\\s*=\\s*'([^']*)'`, "i"))
    return m ? (m[1] ?? m[2]) : undefined
  }
  const w = attr("width")
  const h = attr("height")
  const vb = attr("viewBox")
  let width: number | undefined
  let height: number | undefined
  if (w) width = parseFloat(w)
  if (h) height = parseFloat(h)
  if ((width === undefined || height === undefined) && vb) {
    const parts = vb.trim().split(/[\s,]+/)
    if (parts.length === 4) {
      const vw = parseFloat(parts[2]!)
      const vh = parseFloat(parts[3]!)
      if (width === undefined && Number.isFinite(vw)) width = vw
      if (height === undefined && Number.isFinite(vh)) height = vh
    }
  }
  return { width, height, color_type: "vector", has_alpha: true }
}

export function parseImageInfo(buf: Buffer): ImageInfo {
  const format = detectFormat(buf)
  const mime =
    format === "png" ? "image/png" :
    format === "jpeg" ? "image/jpeg" :
    format === "gif" ? "image/gif" :
    format === "webp" ? "image/webp" :
    format === "bmp" ? "image/bmp" :
    format === "ico" ? "image/x-icon" :
    format === "svg" ? "image/svg+xml" :
    "application/octet-stream"
  if (format === "unknown") return { format, mime, bytes: buf.length }
  const partial: Partial<ImageInfo> =
    format === "png" ? parsePng(buf) :
    format === "jpeg" ? parseJpeg(buf) :
    format === "gif" ? parseGif(buf) :
    format === "webp" ? parseWebp(buf) :
    format === "bmp" ? parseBmp(buf) :
    format === "ico" ? parseIco(buf) :
    format === "svg" ? parseSvg(buf) :
    {}
  return { format, mime, bytes: buf.length, ...partial }
}

function parseDataUrl(dataUrl: string): { mime: string; bytes: Buffer } {
  const m = dataUrl.match(/^data:([^;,]+)?(?:;charset=[^;,]+)?(;base64)?,(.*)$/s)
  if (!m) throw new Error("image: invalid data URL")
  const mime = m[1] || "application/octet-stream"
  const isBase64 = !!m[2]
  const payload = m[3] ?? ""
  const bytes = isBase64 ? Buffer.from(payload, "base64") : Buffer.from(decodeURIComponent(payload), "utf8")
  return { mime, bytes }
}

export const ImageTool = Tool.define(
  "image",
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Params, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const action = params.action
          const fmt = params.format ?? "text"
          const start = Date.now()

          if (action === "info") {
            if (!params.filePath) throw new Error("image: filePath is required for info")
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
            if (!info) throw new Error(`image: file not found: ${target}`)
            const buf = yield* Effect.promise(() => readFile(target))
            if (buf.length > MAX_INPUT_BYTES) {
              throw new Error(`image: file too large (${buf.length} bytes > ${MAX_INPUT_BYTES})`)
            }
            const result = parseImageInfo(buf)
            const elapsed_ms = Date.now() - start
            const text =
              fmt === "json"
                ? JSON.stringify(result, null, 2)
                : `format=${result.format} mime=${result.mime}` +
                  (result.width !== undefined ? ` size=${result.width}x${result.height}` : "") +
                  (result.bit_depth !== undefined ? ` depth=${result.bit_depth}` : "") +
                  (result.color_type ? ` color=${result.color_type}` : "") +
                  (result.has_alpha !== undefined ? ` alpha=${result.has_alpha}` : "") +
                  (result.is_animated ? " animated=true" : "") +
                  ` bytes=${result.bytes}`
            return done({
              title: `image info: ${result.format}${result.width !== undefined ? ` ${result.width}x${result.height}` : ""}`,
              metadata: {
                action,
                filePath: target,
                bytes_in: buf.length,
                format: result.format,
                width: result.width,
                height: result.height,
                has_alpha: result.has_alpha,
                elapsed_ms,
              },
              output: text,
            })
          }

          if (action === "data_url") {
            if (!params.filePath) throw new Error("image: filePath is required for data_url")
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
            const buf = yield* Effect.promise(() => readFile(target))
            if (buf.length > MAX_DATA_URL_BYTES) {
              throw new Error(`image: too large for data URL (${buf.length} bytes > ${MAX_DATA_URL_BYTES})`)
            }
            const info = parseImageInfo(buf)
            const dataUrl = `data:${info.mime};base64,${buf.toString("base64")}`
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
              yield* Effect.promise(() => writeFile(outputPath!, dataUrl, "utf8"))
            }
            const elapsed_ms = Date.now() - start
            const tooLargeForInline = dataUrl.length > MAX_BASE64_INLINE
            const output = outputPath
              ? `wrote ${dataUrl.length} chars to ${outputPath}`
              : tooLargeForInline
                ? `data URL too large to inline (${dataUrl.length} chars). Pass output_path to save.`
                : dataUrl
            return done({
              title: `image data_url: ${info.format} (${buf.length} bytes)`,
              metadata: {
                action,
                filePath: target,
                output_path: outputPath,
                bytes_in: buf.length,
                bytes_out: dataUrl.length,
                format: info.format,
                width: info.width,
                height: info.height,
                elapsed_ms,
              },
              output,
            })
          }

          if (action === "from_data_url") {
            if (!params.data_url) throw new Error("image: data_url is required for from_data_url")
            if (!params.output_path) throw new Error("image: output_path is required for from_data_url")
            if (params.data_url.length > MAX_DATA_URL_BYTES * 2) {
              throw new Error(`image: data URL too large (${params.data_url.length} chars)`)
            }
            const decoded = parseDataUrl(params.data_url)
            const outputPath = path.isAbsolute(params.output_path)
              ? params.output_path
              : path.resolve(Instance.directory, params.output_path)
            yield* ctx.ask({
              permission: "write",
              patterns: [outputPath],
              always: ["*"],
              metadata: { output_path: outputPath, action },
            })
            yield* assertExternalDirectoryEffect(ctx, outputPath, { kind: "file" })
            yield* Effect.promise(() => writeFile(outputPath, decoded.bytes))
            let info: ImageInfo | undefined
            try {
              info = parseImageInfo(decoded.bytes)
            } catch {}
            const elapsed_ms = Date.now() - start
            return done({
              title: `image from_data_url: ${decoded.bytes.length} bytes -> ${path.basename(outputPath)}`,
              metadata: {
                action,
                output_path: outputPath,
                bytes_in: params.data_url.length,
                bytes_out: decoded.bytes.length,
                format: info?.format,
                width: info?.width,
                height: info?.height,
                elapsed_ms,
              },
              output: `wrote ${decoded.bytes.length} bytes to ${outputPath} (mime=${decoded.mime})`,
            })
          }

          throw new Error(`image: unsupported action '${action}'`)
        }),
    }
  }),
)

export const __testing = {
  parseImageInfo,
  parsePng,
  parseJpeg,
  parseGif,
  parseWebp,
  parseBmp,
  parseIco,
  parseSvg,
  parseDataUrl,
  detectFormat,
}
