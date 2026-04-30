import { Effect, Schema } from "effect"
import { readFile } from "node:fs/promises"
import * as path from "node:path"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Instance } from "../project/instance"
import { assertExternalDirectoryEffect } from "./external-directory"
import DESCRIPTION from "./audio.txt"
import * as Tool from "./tool"

const ACTIONS = ["info"] as const
const FORMATS_OUT = ["text", "json"] as const
const MAX_INPUT_BYTES = 64 * 1024 * 1024

export const Parameters = Schema.Struct({
  action: Schema.optional(Schema.Literals(ACTIONS)).annotate({
    description: "info - parse audio file header. Default info.",
  }),
  filePath: Schema.String.check(Schema.isMinLength(1)).annotate({
    description: "Audio file path (absolute or project-relative).",
  }),
  format: Schema.optional(Schema.Literals(FORMATS_OUT)).annotate({
    description: "'text' (default) or 'json'.",
  }),
})

type Params = Schema.Schema.Type<typeof Parameters>

type AudioInfo = {
  format: "mp3" | "wav" | "flac" | "ogg-vorbis" | "ogg-opus" | "mp4" | "unknown"
  mime: string
  codec?: string
  sample_rate?: number
  channels?: number
  bit_depth?: number
  bit_rate?: number
  duration_s?: number
  vbr?: boolean
  bytes: number
}

type Metadata = {
  filePath: string
  format: string
  bytes: number
  duration_s?: number
  sample_rate?: number
  channels?: number
  elapsed_ms: number
}

const done = (result: Tool.ExecuteResult<Metadata>) => result

// ---------- ID3v2 skip ----------

function id3v2Length(buf: Buffer): number {
  if (buf.length < 10) return 0
  if (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) {
    const size =
      ((buf[6]! & 0x7f) << 21) | ((buf[7]! & 0x7f) << 14) | ((buf[8]! & 0x7f) << 7) | (buf[9]! & 0x7f)
    return 10 + size
  }
  return 0
}

// ---------- MP3 ----------

const MP3_BITRATE: Record<string, number[]> = {
  // [V][L][index]
  "1-1": [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448, -1],
  "1-2": [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384, -1],
  "1-3": [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, -1],
  "2-1": [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256, -1],
  "2-2": [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, -1],
  "2-3": [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, -1],
}
const MP3_SR: Record<number, number[]> = {
  1: [44100, 48000, 32000, -1],
  2: [22050, 24000, 16000, -1],
  25: [11025, 12000, 8000, -1],
}
const MP3_SAMPLES: Record<string, number> = {
  "1-1": 384,
  "1-2": 1152,
  "1-3": 1152,
  "2-1": 384,
  "2-2": 1152,
  "2-3": 576,
  "25-1": 384,
  "25-2": 1152,
  "25-3": 576,
}

function parseMp3(buf: Buffer): AudioInfo {
  const skip = id3v2Length(buf)
  let i = skip
  while (i + 4 <= buf.length) {
    const b0 = buf[i]!
    const b1 = buf[i + 1]!
    const b2 = buf[i + 2]!
    const b3 = buf[i + 3]!
    if (b0 === 0xff && (b1 & 0xe0) === 0xe0) {
      const versionBits = (b1 >> 3) & 0x03
      const layerBits = (b1 >> 1) & 0x03
      if (versionBits === 1 || layerBits === 0) {
        i++
        continue
      }
      const version = versionBits === 3 ? 1 : versionBits === 2 ? 2 : 25
      const layer = layerBits === 3 ? 1 : layerBits === 2 ? 2 : 3
      const protectionBit = b1 & 0x01
      const bitrateIdx = (b2 >> 4) & 0x0f
      const sampleIdx = (b2 >> 2) & 0x03
      const padding = (b2 >> 1) & 0x01
      const channelMode = (b3 >> 6) & 0x03
      const brTable = MP3_BITRATE[`${version === 25 ? 2 : version}-${layer}`]
      const srTable = MP3_SR[version]
      if (!brTable || !srTable) {
        i++
        continue
      }
      const br = brTable[bitrateIdx]
      const sr = srTable[sampleIdx]
      if (br === undefined || sr === undefined || br <= 0 || sr <= 0) {
        i++
        continue
      }
      const bitRate = br * 1000
      const channels = channelMode === 3 ? 1 : 2
      const samplesPerFrame = MP3_SAMPLES[`${version}-${layer}`] ?? 1152
      // Frame size
      const frameSize =
        layer === 1
          ? Math.floor(((12 * bitRate) / sr + padding) * 4)
          : Math.floor((samplesPerFrame * bitRate) / 8 / sr + padding)
      // Look for Xing/Info VBR header
      const xingOffset =
        i + 4 + (protectionBit === 0 ? 2 : 0) + (channelMode === 3 ? 17 : 32)
      let frames: number | undefined
      let totalBytes: number | undefined
      let vbr = false
      if (xingOffset + 8 < buf.length) {
        const tag = buf.slice(xingOffset, xingOffset + 4).toString("ascii")
        if (tag === "Xing" || tag === "Info") {
          if (tag === "Xing") vbr = true
          const flags = buf.readUInt32BE(xingOffset + 4)
          let p = xingOffset + 8
          if (flags & 1) {
            frames = buf.readUInt32BE(p)
            p += 4
          }
          if (flags & 2) {
            totalBytes = buf.readUInt32BE(p)
            p += 4
          }
        }
      }
      let duration_s: number | undefined
      let avgBitRate = bitRate
      if (frames) {
        duration_s = (frames * samplesPerFrame) / sr
        if (totalBytes && duration_s > 0) {
          avgBitRate = Math.round((totalBytes * 8) / duration_s)
        }
      } else {
        // Estimate from file size
        const audioBytes = buf.length - skip
        if (frameSize > 0) {
          const estFrames = audioBytes / frameSize
          duration_s = (estFrames * samplesPerFrame) / sr
        }
      }
      return {
        format: "mp3",
        mime: "audio/mpeg",
        codec: `MPEG-${version === 25 ? "2.5" : version} Layer ${layer}`,
        sample_rate: sr,
        channels,
        bit_rate: avgBitRate,
        duration_s,
        vbr,
        bytes: buf.length,
      }
    }
    i++
  }
  return { format: "mp3", mime: "audio/mpeg", bytes: buf.length }
}

// ---------- WAV ----------

function parseWav(buf: Buffer): AudioInfo {
  if (buf.length < 12) return { format: "wav", mime: "audio/wav", bytes: buf.length }
  let p = 12
  let sample_rate: number | undefined
  let channels: number | undefined
  let bit_depth: number | undefined
  let format_tag: number | undefined
  let dataSize: number | undefined
  let bytesPerSec: number | undefined
  while (p + 8 <= buf.length) {
    const tag = buf.slice(p, p + 4).toString("ascii")
    const size = buf.readUInt32LE(p + 4)
    if (tag === "fmt ") {
      format_tag = buf.readUInt16LE(p + 8)
      channels = buf.readUInt16LE(p + 10)
      sample_rate = buf.readUInt32LE(p + 12)
      bytesPerSec = buf.readUInt32LE(p + 16)
      bit_depth = buf.readUInt16LE(p + 22)
      if (format_tag === 0xfffe && size >= 40) {
        // WAVE_FORMAT_EXTENSIBLE - actual format in subFormat GUID's first 2 bytes
        format_tag = buf.readUInt16LE(p + 32)
      }
    } else if (tag === "data") {
      dataSize = size
      break
    }
    p += 8 + size + (size % 2 === 1 ? 1 : 0)
  }
  let codec = "PCM"
  if (format_tag === 3) codec = "IEEE float"
  else if (format_tag === 6) codec = "A-law"
  else if (format_tag === 7) codec = "mu-law"
  else if (format_tag === 0x0055) codec = "MP3-in-WAV"
  let duration_s: number | undefined
  if (dataSize !== undefined && bytesPerSec && bytesPerSec > 0) {
    duration_s = dataSize / bytesPerSec
  }
  return {
    format: "wav",
    mime: "audio/wav",
    codec,
    sample_rate,
    channels,
    bit_depth,
    bit_rate: bytesPerSec ? bytesPerSec * 8 : undefined,
    duration_s,
    bytes: buf.length,
  }
}

// ---------- FLAC ----------

function parseFlac(buf: Buffer): AudioInfo {
  if (buf.length < 42) return { format: "flac", mime: "audio/flac", bytes: buf.length }
  // Skip "fLaC" header (4 bytes), then metadata blocks.
  let p = 4
  while (p + 4 <= buf.length) {
    const last = buf[p]! & 0x80
    const blockType = buf[p]! & 0x7f
    const blockSize = (buf[p + 1]! << 16) | (buf[p + 2]! << 8) | buf[p + 3]!
    p += 4
    if (blockType === 0 && p + 18 <= buf.length) {
      // STREAMINFO
      // bytes 10..13: sample rate (20 bits) + channels (3) + bit depth (5) + total samples high 4
      const b10 = buf[p + 10]!
      const b11 = buf[p + 11]!
      const b12 = buf[p + 12]!
      const b13 = buf[p + 13]!
      const sample_rate = (b10 << 12) | (b11 << 4) | (b12 >> 4)
      const channels = ((b12 >> 1) & 0x07) + 1
      const bit_depth = (((b12 & 0x01) << 4) | (b13 >> 4)) + 1
      const totalSamplesHigh = b13 & 0x0f
      const totalSamplesLow = buf.readUInt32BE(p + 14)
      const totalSamples = totalSamplesHigh * 0x100000000 + totalSamplesLow
      const duration_s = sample_rate > 0 ? totalSamples / sample_rate : undefined
      return {
        format: "flac",
        mime: "audio/flac",
        codec: "FLAC",
        sample_rate,
        channels,
        bit_depth,
        duration_s,
        bytes: buf.length,
      }
    }
    p += blockSize
    if (last) break
  }
  return { format: "flac", mime: "audio/flac", bytes: buf.length }
}

// ---------- OGG ----------

function parseOgg(buf: Buffer): AudioInfo {
  // Each Ogg page: capture "OggS", version, flags, granule(8), serial(4), seq(4), checksum(4),
  // segment count(1), segment table.
  // We need: first page identification packet (Vorbis or Opus), and last page granule for duration.
  if (buf.length < 27 || buf.slice(0, 4).toString("ascii") !== "OggS") {
    return { format: "ogg-vorbis", mime: "audio/ogg", bytes: buf.length }
  }
  let codecKind: "ogg-vorbis" | "ogg-opus" | "unknown" = "unknown"
  let sample_rate: number | undefined
  let channels: number | undefined
  let bit_rate: number | undefined
  let firstGranule: bigint | undefined
  let lastGranule: bigint | undefined
  let p = 0
  while (p + 27 <= buf.length) {
    if (buf.slice(p, p + 4).toString("ascii") !== "OggS") {
      p++
      continue
    }
    const granule = buf.readBigUInt64LE(p + 6)
    const segCount = buf[p + 26]!
    if (p + 27 + segCount > buf.length) break
    let pageDataLen = 0
    for (let i = 0; i < segCount; i++) pageDataLen += buf[p + 27 + i]!
    const dataStart = p + 27 + segCount
    if (dataStart + pageDataLen > buf.length) break
    const data = buf.slice(dataStart, dataStart + pageDataLen)
    if (codecKind === "unknown") {
      if (data.length >= 7 && data[0] === 0x01 && data.slice(1, 7).toString("ascii") === "vorbis") {
        codecKind = "ogg-vorbis"
        // identification packet: version(4) channels(1) sample_rate(4) bitrate_max(4) bitrate_nom(4) ...
        if (data.length >= 30) {
          channels = data[11]!
          sample_rate = data.readUInt32LE(12)
          const nominal = data.readInt32LE(20)
          if (nominal > 0) bit_rate = nominal
        }
        firstGranule = granule
      } else if (data.length >= 8 && data.slice(0, 8).toString("ascii") === "OpusHead") {
        codecKind = "ogg-opus"
        if (data.length >= 19) {
          channels = data[9]!
          sample_rate = data.readUInt32LE(12)
        }
        firstGranule = granule
      }
    }
    if (codecKind !== "unknown") {
      lastGranule = granule
    }
    p = dataStart + pageDataLen
  }
  let duration_s: number | undefined
  if (codecKind === "ogg-vorbis" && lastGranule !== undefined && sample_rate) {
    duration_s = Number(lastGranule) / sample_rate
  } else if (codecKind === "ogg-opus" && lastGranule !== undefined) {
    // Opus uses 48 kHz granule positions regardless of input sample rate.
    duration_s = Number(lastGranule) / 48_000
  }
  if (codecKind === "unknown") {
    return { format: "ogg-vorbis", mime: "audio/ogg", bytes: buf.length }
  }
  return {
    format: codecKind,
    mime: codecKind === "ogg-opus" ? "audio/opus" : "audio/ogg",
    codec: codecKind === "ogg-opus" ? "Opus" : "Vorbis",
    sample_rate,
    channels,
    bit_rate,
    duration_s,
    bytes: buf.length,
  }
  void firstGranule
}

// ---------- MP4 / M4A ----------

function readU32(buf: Buffer, p: number): number {
  return buf.readUInt32BE(p)
}

function parseMp4(buf: Buffer): AudioInfo {
  // Walk top-level boxes; find moov, descend into trak/mdia/...
  const result: AudioInfo = { format: "mp4", mime: "audio/mp4", bytes: buf.length }
  let timescale: number | undefined
  let durationUnits: number | undefined
  let codec: string | undefined
  let sample_rate: number | undefined
  let channels: number | undefined

  function walk(start: number, end: number, depth: number) {
    let p = start
    while (p + 8 <= end) {
      let size = readU32(buf, p)
      const type = buf.slice(p + 4, p + 8).toString("ascii")
      let headerSize = 8
      if (size === 1) {
        if (p + 16 > end) return
        const big = Number(buf.readBigUInt64BE(p + 8))
        size = big
        headerSize = 16
      }
      if (size < headerSize || p + size > end) return
      const childStart = p + headerSize
      const childEnd = p + size
      if (type === "moov" || type === "trak" || type === "mdia" || type === "minf" || type === "stbl") {
        walk(childStart, childEnd, depth + 1)
      } else if (type === "mvhd") {
        const version = buf[childStart]!
        const head = version === 1 ? 4 : 4
        let q = childStart + head + 4 + 4 + 4 // flags(0..2 + version) + creation(4 or 8) + modification(4 or 8)
        if (version === 1) {
          q = childStart + 4 + 8 + 8
          timescale = buf.readUInt32BE(q)
          q += 4
          durationUnits = Number(buf.readBigUInt64BE(q))
        } else {
          q = childStart + 4 + 4 + 4
          timescale = buf.readUInt32BE(q)
          q += 4
          durationUnits = buf.readUInt32BE(q)
        }
      } else if (type === "stsd") {
        // stsd: version(1) flags(3) entry_count(4)
        // first entry: size(4) type(4) reserved(6) data_reference_index(2)
        // for audio: version(2) revision(2) vendor(4) channels(2) sample_size(2) compr(2) packet(2) sample_rate(4 fixed-point)
        if (childEnd - childStart >= 8) {
          const entryCount = buf.readUInt32BE(childStart + 4)
          if (entryCount > 0 && childStart + 8 + 16 < childEnd) {
            const entryStart = childStart + 8
            codec = buf.slice(entryStart + 4, entryStart + 8).toString("ascii")
            const sampleEntryBase = entryStart + 16
            if (sampleEntryBase + 20 <= childEnd) {
              channels = buf.readUInt16BE(sampleEntryBase + 8)
              const fixedSr = buf.readUInt32BE(sampleEntryBase + 16)
              // Sample rate is 16.16 fixed point
              sample_rate = fixedSr >>> 16
            }
          }
        }
      }
      p += size
    }
  }
  walk(0, buf.length, 0)
  let duration_s: number | undefined
  if (timescale && durationUnits !== undefined && timescale > 0) {
    duration_s = durationUnits / timescale
  }
  if (codec) result.codec = codec
  if (sample_rate) result.sample_rate = sample_rate
  if (channels) result.channels = channels
  if (duration_s !== undefined) result.duration_s = duration_s
  return result
}

// ---------- detection ----------

function detectFormat(buf: Buffer): AudioInfo["format"] {
  if (buf.length < 4) return "unknown"
  const b0 = buf[0]!
  const b1 = buf[1]!
  const b2 = buf[2]!
  const b3 = buf[3]!
  if (b0 === 0x49 && b1 === 0x44 && b2 === 0x33) return "mp3" // ID3
  if (b0 === 0xff && (b1 & 0xe0) === 0xe0) return "mp3"
  if (
    buf.length >= 12 &&
    b0 === 0x52 &&
    b1 === 0x49 &&
    b2 === 0x46 &&
    b3 === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x41 &&
    buf[10] === 0x56 &&
    buf[11] === 0x45
  )
    return "wav"
  if (b0 === 0x66 && b1 === 0x4c && b2 === 0x61 && b3 === 0x43) return "flac"
  if (b0 === 0x4f && b1 === 0x67 && b2 === 0x67 && b3 === 0x53) return "ogg-vorbis" // refined later
  // ftyp box at byte 4
  if (
    buf.length >= 12 &&
    buf[4] === 0x66 &&
    buf[5] === 0x74 &&
    buf[6] === 0x79 &&
    buf[7] === 0x70
  )
    return "mp4"
  return "unknown"
}

function parseAudioInfo(buf: Buffer): AudioInfo {
  const fmt = detectFormat(buf)
  if (fmt === "mp3") return parseMp3(buf)
  if (fmt === "wav") return parseWav(buf)
  if (fmt === "flac") return parseFlac(buf)
  if (fmt === "ogg-vorbis") return parseOgg(buf)
  if (fmt === "mp4") return parseMp4(buf)
  return { format: "unknown", mime: "application/octet-stream", bytes: buf.length }
}

function formatText(info: AudioInfo): string {
  const parts = [`format=${info.format}`, `mime=${info.mime}`]
  if (info.codec) parts.push(`codec=${info.codec}`)
  if (info.sample_rate !== undefined) parts.push(`sample_rate=${info.sample_rate}`)
  if (info.channels !== undefined) parts.push(`channels=${info.channels}`)
  if (info.bit_depth !== undefined) parts.push(`bit_depth=${info.bit_depth}`)
  if (info.bit_rate !== undefined) parts.push(`bit_rate=${info.bit_rate}`)
  if (info.duration_s !== undefined) parts.push(`duration_s=${info.duration_s.toFixed(2)}`)
  if (info.vbr) parts.push("vbr=true")
  parts.push(`bytes=${info.bytes}`)
  return parts.join(" ")
}

export const AudioTool = Tool.define(
  "audio",
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Params, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const start = Date.now()
          const target = path.isAbsolute(params.filePath)
            ? params.filePath
            : path.resolve(Instance.directory, params.filePath)
          yield* ctx.ask({
            permission: "read",
            patterns: [target],
            always: ["*"],
            metadata: { filePath: target, action: "info" },
          })
          yield* assertExternalDirectoryEffect(ctx, target, { kind: "file" })
          const stat = yield* fs.stat(target).pipe(Effect.catch(() => Effect.succeed(undefined)))
          if (!stat) throw new Error(`audio: file not found: ${target}`)
          const buf = yield* Effect.promise(() => readFile(target))
          if (buf.length > MAX_INPUT_BYTES) {
            throw new Error(`audio: file too large (${buf.length} bytes > ${MAX_INPUT_BYTES})`)
          }
          const info = parseAudioInfo(buf)
          const elapsed_ms = Date.now() - start
          const fmt = params.format ?? "text"
          const output = fmt === "json" ? JSON.stringify(info, null, 2) : formatText(info)
          return done({
            title: `audio info: ${info.format}${info.duration_s !== undefined ? ` (${info.duration_s.toFixed(1)}s)` : ""}`,
            metadata: {
              filePath: target,
              format: info.format,
              bytes: info.bytes,
              duration_s: info.duration_s,
              sample_rate: info.sample_rate,
              channels: info.channels,
              elapsed_ms,
            },
            output,
          })
        }),
    }
  }),
)

export const __testing = {
  parseMp3,
  parseWav,
  parseFlac,
  parseOgg,
  parseMp4,
  parseAudioInfo,
  detectFormat,
  formatText,
  id3v2Length,
}
