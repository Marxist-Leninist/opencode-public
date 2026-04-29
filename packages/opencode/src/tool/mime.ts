import { Effect, Schema } from "effect"
import { Instance } from "../project/instance"
import * as nodePath from "node:path"
import { promises as fs } from "node:fs"
import DESCRIPTION from "./mime.txt"
import * as Tool from "./tool"

const ACTIONS = [
  "from_extension",
  "from_path",
  "from_content",
  "from_bytes",
  "extensions_for",
  "info",
] as const

export const Parameters = Schema.Struct({
  action: Schema.Literals(ACTIONS).annotate({ description: ACTIONS.join(" | ") }),
  value: Schema.optional(Schema.String).annotate({ description: "Extension/path/MIME/base64 (action-dependent)." }),
  mime: Schema.optional(Schema.String).annotate({ description: "MIME type for `extensions_for`." }),
  filePath: Schema.optional(Schema.String).annotate({ description: "File to inspect for from_content/info." }),
  default: Schema.optional(Schema.String).annotate({ description: "MIME to return on no match (default application/octet-stream)." }),
})

type Params = Schema.Schema.Type<typeof Parameters>

type Metadata = {
  action: (typeof ACTIONS)[number]
  result?: unknown
  size?: number
}

// ---------- Extension ↔ MIME table ----------

const EXT_MAP: Record<string, string> = {
  // Text
  txt: "text/plain",
  log: "text/plain",
  md: "text/markdown",
  markdown: "text/markdown",
  rst: "text/x-rst",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  htm: "text/html",
  html: "text/html",
  css: "text/css",
  ics: "text/calendar",
  vcf: "text/vcard",
  // Code-ish (text/* or application/* per IANA mostly)
  js: "text/javascript",
  mjs: "text/javascript",
  cjs: "text/javascript",
  ts: "application/typescript",
  tsx: "text/tsx",
  jsx: "text/jsx",
  json: "application/json",
  jsonl: "application/x-ndjson",
  ndjson: "application/x-ndjson",
  yaml: "application/yaml",
  yml: "application/yaml",
  toml: "application/toml",
  xml: "application/xml",
  ini: "text/plain",
  conf: "text/plain",
  cfg: "text/plain",
  properties: "text/x-java-properties",
  // Documents
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  odt: "application/vnd.oasis.opendocument.text",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  odp: "application/vnd.oasis.opendocument.presentation",
  rtf: "application/rtf",
  epub: "application/epub+zip",
  // Image
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  jpe: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  ico: "image/x-icon",
  svg: "image/svg+xml",
  tiff: "image/tiff",
  tif: "image/tiff",
  avif: "image/avif",
  heic: "image/heic",
  heif: "image/heif",
  // Audio
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  opus: "audio/opus",
  flac: "audio/flac",
  m4a: "audio/mp4",
  aac: "audio/aac",
  weba: "audio/webm",
  midi: "audio/midi",
  mid: "audio/midi",
  // Video
  mp4: "video/mp4",
  m4v: "video/x-m4v",
  webm: "video/webm",
  mkv: "video/x-matroska",
  mov: "video/quicktime",
  avi: "video/x-msvideo",
  wmv: "video/x-ms-wmv",
  flv: "video/x-flv",
  ogv: "video/ogg",
  // Font
  ttf: "font/ttf",
  otf: "font/otf",
  woff: "font/woff",
  woff2: "font/woff2",
  eot: "application/vnd.ms-fontobject",
  // Archive
  zip: "application/zip",
  tar: "application/x-tar",
  gz: "application/gzip",
  tgz: "application/gzip",
  bz2: "application/x-bzip2",
  xz: "application/x-xz",
  "7z": "application/x-7z-compressed",
  rar: "application/vnd.rar",
  zst: "application/zstd",
  zstd: "application/zstd",
  // Executable / binary
  exe: "application/vnd.microsoft.portable-executable",
  dll: "application/vnd.microsoft.portable-executable",
  msi: "application/x-msi",
  apk: "application/vnd.android.package-archive",
  jar: "application/java-archive",
  war: "application/java-archive",
  class: "application/java-vm",
  wasm: "application/wasm",
  // Data / DB
  sqlite: "application/vnd.sqlite3",
  sqlite3: "application/vnd.sqlite3",
  db: "application/vnd.sqlite3",
  parquet: "application/x-parquet",
  // Misc
  bin: "application/octet-stream",
  iso: "application/x-iso9660-image",
  torrent: "application/x-bittorrent",
}

export function extensionMime(input: string, def = "application/octet-stream"): string {
  if (!input) return def
  let s = input.trim().toLowerCase()
  // Strip query/hash
  s = s.split("?")[0]!.split("#")[0]!
  // If full path, take basename
  if (s.includes("/") || s.includes("\\")) s = s.replace(/\\/g, "/").split("/").pop()!
  // Take everything after the LAST dot
  const dot = s.lastIndexOf(".")
  if (dot < 0) {
    // could be a bare extension e.g. "png"
    if (EXT_MAP[s]) return EXT_MAP[s]!
    return def
  }
  const ext = s.slice(dot + 1)
  return EXT_MAP[ext] ?? def
}

export function extensionsFor(mime: string): string[] {
  const target = mime.trim().toLowerCase()
  const out: string[] = []
  for (const [ext, mt] of Object.entries(EXT_MAP)) {
    if (mt === target) out.push(ext)
  }
  return out
}

// ---------- Magic-number sniff ----------

function startsWithBytes(buf: Buffer, prefix: number[], offset = 0): boolean {
  if (buf.length < offset + prefix.length) return false
  for (let i = 0; i < prefix.length; i++) {
    if (buf[offset + i] !== prefix[i]) return false
  }
  return true
}

export function sniffMime(buf: Buffer): string | null {
  if (buf.length === 0) return null
  // PNG
  if (startsWithBytes(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png"
  // JPEG
  if (startsWithBytes(buf, [0xff, 0xd8, 0xff])) return "image/jpeg"
  // GIF
  if (startsWithBytes(buf, [0x47, 0x49, 0x46, 0x38])) return "image/gif"
  // RIFF -> WebP / WAV / AVI
  if (startsWithBytes(buf, [0x52, 0x49, 0x46, 0x46]) && buf.length >= 12) {
    const tag = buf.slice(8, 12).toString("ascii")
    if (tag === "WEBP") return "image/webp"
    if (tag === "WAVE") return "audio/wav"
    if (tag === "AVI ") return "video/x-msvideo"
  }
  // BMP
  if (startsWithBytes(buf, [0x42, 0x4d])) return "image/bmp"
  // ICO
  if (startsWithBytes(buf, [0x00, 0x00, 0x01, 0x00])) return "image/x-icon"
  // PDF
  if (startsWithBytes(buf, [0x25, 0x50, 0x44, 0x46, 0x2d])) return "application/pdf"
  // ZIP family (PK..)
  if (startsWithBytes(buf, [0x50, 0x4b, 0x03, 0x04]) || startsWithBytes(buf, [0x50, 0x4b, 0x05, 0x06])) {
    return "application/zip"
  }
  // gzip
  if (startsWithBytes(buf, [0x1f, 0x8b])) return "application/gzip"
  // bzip2
  if (startsWithBytes(buf, [0x42, 0x5a, 0x68])) return "application/x-bzip2"
  // xz
  if (startsWithBytes(buf, [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00])) return "application/x-xz"
  // 7z
  if (startsWithBytes(buf, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) return "application/x-7z-compressed"
  // RAR
  if (startsWithBytes(buf, [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07])) return "application/vnd.rar"
  // zstd
  if (startsWithBytes(buf, [0x28, 0xb5, 0x2f, 0xfd])) return "application/zstd"
  // SQLite
  if (startsWithBytes(buf, [0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x20, 0x66, 0x6f, 0x72, 0x6d, 0x61, 0x74, 0x20, 0x33, 0x00])) return "application/vnd.sqlite3"
  // ELF
  if (startsWithBytes(buf, [0x7f, 0x45, 0x4c, 0x46])) return "application/x-elf"
  // Mach-O
  if (
    startsWithBytes(buf, [0xfe, 0xed, 0xfa, 0xce]) ||
    startsWithBytes(buf, [0xfe, 0xed, 0xfa, 0xcf]) ||
    startsWithBytes(buf, [0xce, 0xfa, 0xed, 0xfe]) ||
    startsWithBytes(buf, [0xcf, 0xfa, 0xed, 0xfe])
  )
    return "application/x-mach-binary"
  // PE / EXE
  if (startsWithBytes(buf, [0x4d, 0x5a])) return "application/vnd.microsoft.portable-executable"
  // MP3 (ID3)
  if (startsWithBytes(buf, [0x49, 0x44, 0x33])) return "audio/mpeg"
  // MIDI
  if (startsWithBytes(buf, [0x4d, 0x54, 0x68, 0x64])) return "audio/midi"
  // FLAC
  if (startsWithBytes(buf, [0x66, 0x4c, 0x61, 0x43])) return "audio/flac"
  // OGG
  if (startsWithBytes(buf, [0x4f, 0x67, 0x67, 0x53])) return "audio/ogg"
  // MP4 / M4A / MOV (ftyp box at offset 4)
  if (buf.length >= 12 && buf.slice(4, 8).toString("ascii") === "ftyp") {
    const brand = buf.slice(8, 12).toString("ascii")
    if (brand === "qt  ") return "video/quicktime"
    if (brand.startsWith("M4A")) return "audio/mp4"
    return "video/mp4"
  }
  // EBML (MKV/WebM)
  if (startsWithBytes(buf, [0x1a, 0x45, 0xdf, 0xa3])) return "video/x-matroska"
  // TAR (POSIX): "ustar" at offset 257
  if (buf.length >= 263 && buf.slice(257, 262).toString("ascii") === "ustar") return "application/x-tar"
  // MS Compound (legacy office)
  if (startsWithBytes(buf, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return "application/x-cfb"
  return null
}

function isBinary(buf: Buffer): boolean {
  const len = Math.min(buf.length, 4096)
  for (let i = 0; i < len; i++) {
    if (buf[i] === 0) return true
  }
  // Non-UTF-8 heuristic: count high-bit chars; if >30%, treat as binary
  let highBits = 0
  for (let i = 0; i < len; i++) {
    const b = buf[i]!
    if (b < 9 || (b > 13 && b < 32 && b !== 27)) highBits++
  }
  return highBits > len * 0.3
}

const done = (result: Tool.ExecuteResult<Metadata>) => result

function resolvePath(p: string): string {
  return nodePath.isAbsolute(p) ? p : nodePath.join(Instance.directory, p)
}

export const MimeTool = Tool.define(
  "mime",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Params, _ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const action = params.action
          const def = params.default ?? "application/octet-stream"

          if (action === "from_extension" || action === "from_path") {
            if (!params.value) throw new Error(`mime.${action}: requires \`value\``)
            const m = extensionMime(params.value, def)
            return done({
              title: `mime: ${m}`,
              metadata: { action, result: m },
              output: m,
            })
          }

          if (action === "extensions_for") {
            const target = params.mime ?? params.value
            if (!target) throw new Error("mime.extensions_for: requires `mime`")
            const exts = extensionsFor(target)
            return done({
              title: `mime: ${exts.length} extensions for ${target}`,
              metadata: { action, result: exts },
              output: exts.join(", "),
            })
          }

          if (action === "from_content") {
            if (!params.filePath) throw new Error("mime.from_content: requires `filePath`")
            const abs = resolvePath(params.filePath)
            const fd = yield* Effect.promise(() => fs.open(abs, "r"))
            const buf = Buffer.alloc(4096)
            const stat = yield* Effect.promise(() => fd.stat())
            const { bytesRead } = yield* Effect.promise(() => fd.read(buf, 0, 4096, 0))
            yield* Effect.promise(() => fd.close())
            const sub = buf.slice(0, bytesRead)
            const m = sniffMime(sub) ?? def
            return done({
              title: `mime: ${m} (sniffed)`,
              metadata: { action, result: m, size: stat.size },
              output: m,
            })
          }

          if (action === "from_bytes") {
            if (!params.value) throw new Error("mime.from_bytes: requires base64 `value`")
            const buf = Buffer.from(params.value, "base64")
            const m = sniffMime(buf) ?? def
            return done({
              title: `mime: ${m} (sniffed bytes)`,
              metadata: { action, result: m, size: buf.length },
              output: m,
            })
          }

          if (action === "info") {
            const path = params.filePath ?? params.value
            if (!path) throw new Error("mime.info: requires `filePath` or `value` (path)")
            const extMime = extensionMime(path, def)
            const info: Record<string, unknown> = {
              path,
              extension: nodePath.extname(path).toLowerCase(),
              ext_mime: extMime,
            }
            if (params.filePath) {
              const abs = resolvePath(params.filePath)
              const stat = yield* Effect.promise(() => fs.stat(abs))
              const fd = yield* Effect.promise(() => fs.open(abs, "r"))
              const buf = Buffer.alloc(Math.min(4096, stat.size))
              const { bytesRead } = yield* Effect.promise(() => fd.read(buf, 0, buf.length, 0))
              yield* Effect.promise(() => fd.close())
              const sub = buf.slice(0, bytesRead)
              const sniffed = sniffMime(sub)
              info.size = stat.size
              if (sniffed) info.content_mime = sniffed
              const binary = isBinary(sub)
              info.binary = binary
              if (!binary) info.text = sub.toString("utf8")
            }
            const out = JSON.stringify(info, null, 2)
            return done({
              title: `mime.info: ${info.ext_mime}`,
              metadata: { action, result: info, size: info.size as number | undefined },
              output: out,
            })
          }

          throw new Error(`mime: unknown action '${action}'`)
        }),
    }
  }),
)

export const __testing = {
  extensionMime,
  extensionsFor,
  sniffMime,
  isBinary,
}
