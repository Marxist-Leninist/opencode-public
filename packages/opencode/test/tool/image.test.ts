import { describe, expect, test } from "bun:test"

import { __testing } from "@/tool/image"

// Standard 1x1 transparent PNG (PNG signature + IHDR + IDAT + IEND).
const PNG_1x1_TRANSPARENT = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
)

// Standard 1x1 white JPEG (smallest baseline JPEG).
const JPEG_1x1 = Buffer.from(
  "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/2wBDAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAr/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AL+AB//Z",
  "base64",
)

// 2x1 GIF89a static
const GIF_2x1 = Buffer.from("R0lGODdhAgABAIAAAP///wAAACwAAAAAAgABAAACAkQBADs=", "base64")

// Animated GIF89a (3-frame 1x1).
const GIF_ANIM = Buffer.from(
  "R0lGODlhAQABAIAAAP///wAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQAAAAAACwAAAAAAQABAAACAkQBACH5BAAAAAAALAAAAAABAAEAAAICRAEAIfkEAAAAAAAsAAAAAAEAAQAAAgJEAQA7",
  "base64",
)

// 2x1 BMP 24-bit
const BMP_2x1 = Buffer.from(
  "Qk1aAAAAAAAAADYAAAAoAAAAAgAAAAEAAAABABgAAAAAAAAAAAATCwAAEwsAAAAAAAAAAAAA////AAAAAAAA",
  "base64",
)

// 2x1 lossy WebP (VP8). Built via `cwebp` then base64'd.
const WEBP_VP8 = Buffer.from(
  "UklGRkAAAABXRUJQVlA4IDQAAACQAQCdASoCAAEAAQAcJaACdLoB+AAETAAA/v9LDAAAAAAA",
  "base64",
)

// Minimal SVG with width/height.
const SVG = Buffer.from(`<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50" viewBox="0 0 200 100">
  <rect width="100%" height="100%" fill="red"/>
</svg>`, "utf8")

// SVG with only viewBox.
const SVG_VB_ONLY = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100"/>`, "utf8")

// 16x16 BMP-style ICO header (one entry).
const ICO_16 = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x01, 0x00, 0x01, 0x00]),
  Buffer.from([0x10, 0x10, 0x00, 0x00, 0x01, 0x00, 0x20, 0x00]),
  Buffer.from([0x68, 0x04, 0x00, 0x00, 0x16, 0x00, 0x00, 0x00]),
])

describe("image format detection", () => {
  test("PNG signature", () => {
    expect(__testing.detectFormat(PNG_1x1_TRANSPARENT)).toBe("png")
  })
  test("JPEG signature", () => {
    expect(__testing.detectFormat(JPEG_1x1)).toBe("jpeg")
  })
  test("GIF signature", () => {
    expect(__testing.detectFormat(GIF_2x1)).toBe("gif")
  })
  test("WebP signature", () => {
    expect(__testing.detectFormat(WEBP_VP8)).toBe("webp")
  })
  test("BMP signature", () => {
    expect(__testing.detectFormat(BMP_2x1)).toBe("bmp")
  })
  test("ICO signature", () => {
    expect(__testing.detectFormat(ICO_16)).toBe("ico")
  })
  test("SVG signature (xml prelude)", () => {
    expect(__testing.detectFormat(SVG)).toBe("svg")
  })
  test("SVG signature (no xml prelude)", () => {
    expect(__testing.detectFormat(SVG_VB_ONLY)).toBe("svg")
  })
  test("unknown format", () => {
    expect(__testing.detectFormat(Buffer.from("hello world"))).toBe("unknown")
  })
})

describe("image info parsing", () => {
  test("PNG 1x1 transparent", () => {
    const info = __testing.parseImageInfo(PNG_1x1_TRANSPARENT)
    expect(info.format).toBe("png")
    expect(info.mime).toBe("image/png")
    expect(info.width).toBe(1)
    expect(info.height).toBe(1)
    expect(info.bit_depth).toBe(8)
    expect(info.is_animated).toBe(false)
    expect(info.bytes).toBe(PNG_1x1_TRANSPARENT.length)
  })

  test("JPEG 1x1", () => {
    const info = __testing.parseImageInfo(JPEG_1x1)
    expect(info.format).toBe("jpeg")
    expect(info.width).toBe(1)
    expect(info.height).toBe(1)
    expect(info.has_alpha).toBe(false)
  })

  test("GIF static", () => {
    const info = __testing.parseImageInfo(GIF_2x1)
    expect(info.format).toBe("gif")
    expect(info.width).toBe(2)
    expect(info.height).toBe(1)
    expect(info.is_animated).toBe(false)
  })

  test("GIF animated", () => {
    const info = __testing.parseImageInfo(GIF_ANIM)
    expect(info.format).toBe("gif")
    expect(info.is_animated).toBe(true)
  })

  test("BMP 2x1 24-bit", () => {
    const info = __testing.parseImageInfo(BMP_2x1)
    expect(info.format).toBe("bmp")
    expect(info.width).toBe(2)
    expect(info.height).toBe(1)
    expect(info.bit_depth).toBe(24)
  })

  test("WebP VP8 lossy", () => {
    const info = __testing.parseImageInfo(WEBP_VP8)
    expect(info.format).toBe("webp")
    expect(info.width).toBe(2)
    expect(info.height).toBe(1)
    expect(info.has_alpha).toBe(false)
  })

  test("ICO 16x16 32bpp", () => {
    const info = __testing.parseImageInfo(ICO_16)
    expect(info.format).toBe("ico")
    expect(info.width).toBe(16)
    expect(info.height).toBe(16)
    expect(info.bit_depth).toBe(32)
    expect(info.has_alpha).toBe(true)
  })

  test("SVG with width+height", () => {
    const info = __testing.parseImageInfo(SVG)
    expect(info.format).toBe("svg")
    expect(info.width).toBe(100)
    expect(info.height).toBe(50)
  })

  test("SVG with only viewBox falls back to viewBox dims", () => {
    const info = __testing.parseImageInfo(SVG_VB_ONLY)
    expect(info.format).toBe("svg")
    expect(info.width).toBe(200)
    expect(info.height).toBe(100)
  })
})

describe("image data URL handling", () => {
  test("parses base64 data URL", () => {
    const url = `data:image/png;base64,${PNG_1x1_TRANSPARENT.toString("base64")}`
    const decoded = __testing.parseDataUrl(url)
    expect(decoded.mime).toBe("image/png")
    expect(decoded.bytes.length).toBe(PNG_1x1_TRANSPARENT.length)
  })

  test("parses url-encoded data URL", () => {
    const url = `data:text/plain,hello%20world`
    const decoded = __testing.parseDataUrl(url)
    expect(decoded.mime).toBe("text/plain")
    expect(decoded.bytes.toString("utf8")).toBe("hello world")
  })

  test("rejects malformed data URL", () => {
    expect(() => __testing.parseDataUrl("not a data url")).toThrow()
  })
})
