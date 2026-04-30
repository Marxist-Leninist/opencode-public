import { describe, expect, test } from "bun:test"
import { __testing } from "../../src/tool/audio"

// ---------- Synthetic audio file builders ----------

// Build a minimal valid WAV file (44.1kHz, mono, 16-bit, ~1 second of silence).
function buildWav(sampleRate: number, channels: number, bitsPerSample: number, samples: number): Buffer {
  const blockAlign = (channels * bitsPerSample) / 8
  const byteRate = sampleRate * blockAlign
  const dataLen = samples * blockAlign
  const fmtLen = 16
  const totalLen = 4 + (8 + fmtLen) + (8 + dataLen)
  const buf = Buffer.alloc(8 + totalLen)
  let p = 0
  buf.write("RIFF", p, "ascii"); p += 4
  buf.writeUInt32LE(totalLen, p); p += 4
  buf.write("WAVE", p, "ascii"); p += 4
  buf.write("fmt ", p, "ascii"); p += 4
  buf.writeUInt32LE(fmtLen, p); p += 4
  buf.writeUInt16LE(1, p); p += 2 // PCM
  buf.writeUInt16LE(channels, p); p += 2
  buf.writeUInt32LE(sampleRate, p); p += 4
  buf.writeUInt32LE(byteRate, p); p += 4
  buf.writeUInt16LE(blockAlign, p); p += 2
  buf.writeUInt16LE(bitsPerSample, p); p += 2
  buf.write("data", p, "ascii"); p += 4
  buf.writeUInt32LE(dataLen, p); p += 4
  // PCM data left as zeros (silence) - fine for header parsing.
  return buf
}

// Minimal FLAC: "fLaC" + STREAMINFO block.
function buildFlac(sampleRate: number, channels: number, bitDepth: number, totalSamples: number): Buffer {
  const buf = Buffer.alloc(4 + 4 + 34)
  let p = 0
  buf.write("fLaC", p, "ascii"); p += 4
  // METADATA_BLOCK_HEADER: last=1, type=0 (STREAMINFO), 24-bit length=34
  buf.writeUInt8(0x80, p); p += 1
  buf.writeUInt8(0x00, p); p += 1
  buf.writeUInt8(0x00, p); p += 1
  buf.writeUInt8(0x22, p); p += 1
  // STREAMINFO body (34 bytes)
  // min_block(2) max_block(2) min_frame(3) max_frame(3) - leave zeros
  p += 2 + 2 + 3 + 3
  // bytes 10..13 carry sample_rate (20 bits) | channels (3) | bit depth (5) | total_samples high 4
  const sr = sampleRate & 0xfffff
  const ch = (channels - 1) & 0x07
  const bd = (bitDepth - 1) & 0x1f
  const totalHigh = Number((BigInt(totalSamples) >> 32n) & 0x0fn)
  buf.writeUInt8((sr >> 12) & 0xff, p); p += 1
  buf.writeUInt8((sr >> 4) & 0xff, p); p += 1
  buf.writeUInt8(((sr & 0x0f) << 4) | (ch << 1) | ((bd >> 4) & 0x01), p); p += 1
  buf.writeUInt8(((bd & 0x0f) << 4) | totalHigh, p); p += 1
  buf.writeUInt32BE(totalSamples & 0xffffffff, p); p += 4
  // 16 bytes MD5 - zeros are fine for our parser.
  return buf
}

describe("tool.audio detection", () => {
  test("detect wav header", () => {
    const wav = buildWav(44100, 2, 16, 100)
    expect(__testing.detectFormat(wav)).toBe("wav")
  })
  test("detect flac header", () => {
    const flac = buildFlac(44100, 2, 16, 1000)
    expect(__testing.detectFormat(flac)).toBe("flac")
  })
  test("detect mp3 ID3v2", () => {
    const buf = Buffer.alloc(64)
    buf.write("ID3", 0)
    buf[3] = 4 // version
    expect(__testing.detectFormat(buf)).toBe("mp3")
  })
  test("detect mp3 sync frame", () => {
    const buf = Buffer.from([0xff, 0xfb, 0x90, 0x00])
    expect(__testing.detectFormat(buf)).toBe("mp3")
  })
  test("detect mp4 ftyp", () => {
    const buf = Buffer.alloc(16)
    buf.write("ftyp", 4, "ascii")
    expect(__testing.detectFormat(buf)).toBe("mp4")
  })
})

describe("tool.audio parsers", () => {
  test("WAV: parses fmt + data, computes duration", () => {
    const wav = buildWav(48000, 2, 16, 48000) // 1 second
    const info = __testing.parseWav(wav)
    expect(info.format).toBe("wav")
    expect(info.sample_rate).toBe(48000)
    expect(info.channels).toBe(2)
    expect(info.bit_depth).toBe(16)
    expect(info.duration_s).toBeCloseTo(1, 2)
    expect(info.codec).toBe("PCM")
  })

  test("FLAC: STREAMINFO parsed correctly", () => {
    const flac = buildFlac(44100, 2, 16, 88200) // 2 seconds
    const info = __testing.parseFlac(flac)
    expect(info.format).toBe("flac")
    expect(info.sample_rate).toBe(44100)
    expect(info.channels).toBe(2)
    expect(info.bit_depth).toBe(16)
    expect(info.duration_s).toBeCloseTo(2, 2)
  })

  test("ID3v2 length skip", () => {
    const buf = Buffer.alloc(20)
    buf.write("ID3", 0)
    buf[3] = 4
    // Synchsafe 10
    buf[6] = 0
    buf[7] = 0
    buf[8] = 0
    buf[9] = 10
    expect(__testing.id3v2Length(buf)).toBe(20)
  })

  test("formatText: human-readable", () => {
    const wav = buildWav(48000, 2, 16, 48000)
    const info = __testing.parseWav(wav)
    const text = __testing.formatText(info)
    expect(text).toContain("format=wav")
    expect(text).toContain("sample_rate=48000")
    expect(text).toContain("channels=2")
    expect(text).toContain("bit_depth=16")
  })
})
