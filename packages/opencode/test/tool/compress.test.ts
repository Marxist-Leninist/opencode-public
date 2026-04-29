import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Agent } from "../../src/agent/agent"
import { MessageID, SessionID } from "../../src/session/schema"
import { Tool } from "../../src/tool"
import { CompressTool, compressBuffer, decompressBuffer } from "../../src/tool/compress"
import { Truncate } from "../../src/tool"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { tmpdir } from "node:os"
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs"
import * as path from "node:path"

const it = testEffect(
  Layer.mergeAll(CrossSpawnSpawner.defaultLayer, AppFileSystem.defaultLayer, Truncate.defaultLayer, Agent.defaultLayer),
)

const baseCtx: Tool.Context = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make(""),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

describe("tool.compress helpers", () => {
  test("gzip round-trip", () => {
    const raw = Buffer.from("the quick brown fox the quick brown fox")
    const c = compressBuffer(raw, "gzip")
    expect(c.byteLength).toBeGreaterThan(0)
    const d = decompressBuffer(c, "gzip")
    expect(d.equals(raw)).toBe(true)
  })
  test("deflate, deflate-raw, brotli round-trip", () => {
    const raw = Buffer.from("hello hello hello hello hello hello")
    for (const algo of ["deflate", "deflate-raw", "brotli"] as const) {
      const c = compressBuffer(raw, algo)
      const d = decompressBuffer(c, algo)
      expect(d.equals(raw)).toBe(true)
    }
  })
  test("gzip level 1 vs 9 produce different sizes", () => {
    const raw = Buffer.from("abc".repeat(1000))
    const c1 = compressBuffer(raw, "gzip", 1)
    const c9 = compressBuffer(raw, "gzip", 9)
    // Both should round-trip, sizes likely differ.
    expect(decompressBuffer(c1, "gzip").equals(raw)).toBe(true)
    expect(decompressBuffer(c9, "gzip").equals(raw)).toBe(true)
  })
})

describe("tool.compress tool", () => {
  it.live("compresses inline value to base64 and decompresses back", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* CompressTool
        const tool = yield* toolInfo.init()
        const c = yield* tool.execute(
          { action: "compress", algorithm: "gzip", value: "hello hello hello" },
          baseCtx,
        )
        expect(c.metadata.algorithm).toBe("gzip")
        expect(c.metadata.input_bytes).toBe(17)
        expect(c.metadata.output_bytes).toBeGreaterThan(0)
        expect(c.metadata.result).toBeDefined()

        const d = yield* tool.execute(
          {
            action: "decompress",
            algorithm: "gzip",
            value: c.metadata.result as string,
            value_encoding: "base64",
          },
          baseCtx,
        )
        expect(d.metadata.result).toBe("hello hello hello")
      }),
    ),
  )

  it.live("compresses a file to outputPath and decompresses back", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* CompressTool
        const tool = yield* toolInfo.init()
        const dir = mkdtempSync(path.join(tmpdir(), "compress-test-"))
        const inFile = path.join(dir, "raw.txt")
        const gzFile = path.join(dir, "raw.txt.gz")
        const outFile = path.join(dir, "round.txt")
        writeFileSync(inFile, "round trip me " + "x".repeat(1000))
        const c = yield* tool.execute(
          { action: "compress", algorithm: "gzip", inputPath: inFile, outputPath: gzFile },
          baseCtx,
        )
        expect(c.metadata.outputPath).toBe(gzFile)
        expect(existsSync(gzFile)).toBe(true)
        const d = yield* tool.execute(
          { action: "decompress", algorithm: "gzip", inputPath: gzFile, outputPath: outFile },
          baseCtx,
        )
        expect(d.metadata.outputPath).toBe(outFile)
        expect(readFileSync(outFile, "utf8")).toBe(readFileSync(inFile, "utf8"))
      }),
    ),
  )

  it.live("brotli compresses and decompresses inline", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* CompressTool
        const tool = yield* toolInfo.init()
        const c = yield* tool.execute(
          { action: "compress", algorithm: "brotli", value: "x".repeat(500), level: 4 },
          baseCtx,
        )
        const d = yield* tool.execute(
          {
            action: "decompress",
            algorithm: "brotli",
            value: c.metadata.result as string,
            value_encoding: "base64",
          },
          baseCtx,
        )
        expect(d.metadata.result).toBe("x".repeat(500))
      }),
    ),
  )

  it.live("rejects passing both value and inputPath", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* CompressTool
        const tool = yield* toolInfo.init()
        const exit = yield* Effect.exit(
          tool.execute(
            { action: "compress", algorithm: "gzip", value: "a", inputPath: "/tmp/x" },
            baseCtx,
          ),
        )
        expect(exit._tag).toBe("Failure")
      }),
    ),
  )
})
