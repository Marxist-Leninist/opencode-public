import { describe, expect, test, beforeAll, afterAll } from "bun:test"
import { Effect, Exit, Layer } from "effect"
import path from "path"
import { createServer, type Server } from "node:http"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Agent } from "../../src/agent/agent"
import { MessageID, SessionID } from "../../src/session/schema"
import { Tool } from "../../src/tool"
import { DownloadTool, __testing } from "../../src/tool/download"
import { Truncate } from "../../src/tool"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const { isHttpUrl, fmtBytes, normalizeHex } = __testing

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

let server: Server
let port: number
let baseUrl: string

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === "/hello") {
      res.writeHead(200, { "content-type": "text/plain", "content-length": "5" })
      res.end("hello")
      return
    }
    if (req.url === "/big") {
      const body = Buffer.alloc(64 * 1024, 0x41) // 64 KB of 'A'
      res.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(body.length) })
      res.end(body)
      return
    }
    if (req.url === "/redirect") {
      res.writeHead(302, { location: "/hello" })
      res.end()
      return
    }
    if (req.url === "/notfound") {
      res.writeHead(404)
      res.end("nope")
      return
    }
    if (req.url === "/badlen") {
      // Server lies: claims 5 bytes but expected check sees 5
      res.writeHead(200, { "content-type": "text/plain", "content-length": "5" })
      res.end("hello")
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve())
  })
  const addr = server.address()
  if (typeof addr === "object" && addr) {
    port = addr.port
    baseUrl = `http://127.0.0.1:${port}`
  }
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

describe("download helpers", () => {
  test("isHttpUrl", () => {
    expect(isHttpUrl("https://example.com")).toBe(true)
    expect(isHttpUrl("http://example.com")).toBe(true)
    expect(isHttpUrl("ftp://x")).toBe(false)
    expect(isHttpUrl("not a url")).toBe(false)
  })

  test("fmtBytes covers all ranges", () => {
    expect(fmtBytes(512)).toBe("512 B")
    expect(fmtBytes(2048)).toBe("2.0 KB")
    expect(fmtBytes(2 * 1024 * 1024)).toBe("2.0 MB")
    expect(fmtBytes(2 * 1024 * 1024 * 1024)).toBe("2.00 GB")
  })

  test("normalizeHex strips non-hex chars and lowercases", () => {
    expect(normalizeHex("AA:BB cc")).toBe("aabbcc")
  })
})

describe("tool.download", () => {
  it.live("downloads a small file and reports metadata", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const dest = path.join(dir, "hello.txt")
        const toolInfo = yield* DownloadTool
        const tool = yield* toolInfo.init()
        const result = yield* tool.execute({ url: `${baseUrl}/hello`, dest }, baseCtx)
        expect(result.metadata.bytes_received).toBe(5)
        expect(result.metadata.status_code).toBe(200)
        expect(result.metadata.content_type).toContain("text/plain")
        expect(result.output).toContain("Downloaded")
      }),
    ),
  )

  it.live("verifies expected_sha256 on success", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const dest = path.join(dir, "hello-verified.txt")
        const toolInfo = yield* DownloadTool
        const tool = yield* toolInfo.init()
        // sha256("hello") = 2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824
        const result = yield* tool.execute(
          {
            url: `${baseUrl}/hello`,
            dest,
            expected_sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
          },
          baseCtx,
        )
        expect(result.metadata.matches).toBe(true)
        expect(result.metadata.sha256).toBe(
          "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
        )
      }),
    ),
  )

  it.live("removes file and errors on sha256 mismatch", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const dest = path.join(dir, "mismatch.txt")
        const toolInfo = yield* DownloadTool
        const tool = yield* toolInfo.init()
        const exit = yield* Effect.exit(
          tool.execute(
            {
              url: `${baseUrl}/hello`,
              dest,
              expected_sha256: "0000000000000000000000000000000000000000000000000000000000000000",
            },
            baseCtx,
          ),
        )
        expect(Exit.isFailure(exit)).toBe(true)
        // File should not exist after mismatch.
        const fs = yield* AppFileSystem.Service
        const stat = yield* fs.stat(dest).pipe(Effect.catch(() => Effect.succeed(undefined)))
        expect(stat).toBeUndefined()
      }),
    ),
  )

  it.live("if_exists=skip leaves existing file alone", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const dest = path.join(dir, "already.txt")
        yield* Effect.promise(() => Bun.write(dest, "stay"))
        const toolInfo = yield* DownloadTool
        const tool = yield* toolInfo.init()
        const result = yield* tool.execute({ url: `${baseUrl}/hello`, dest, if_exists: "skip" }, baseCtx)
        expect(result.metadata.skipped).toBe(true)
        const text = yield* Effect.promise(() => Bun.file(dest).text())
        expect(text).toBe("stay")
      }),
    ),
  )

  it.live("rejects non-http URLs", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const toolInfo = yield* DownloadTool
        const tool = yield* toolInfo.init()
        const exit = yield* Effect.exit(
          tool.execute({ url: "ftp://example.com/x", dest: path.join(dir, "x") }, baseCtx),
        )
        expect(Exit.isFailure(exit)).toBe(true)
      }),
    ),
  )

  it.live("rejects 404 responses", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const toolInfo = yield* DownloadTool
        const tool = yield* toolInfo.init()
        const exit = yield* Effect.exit(
          tool.execute({ url: `${baseUrl}/notfound`, dest: path.join(dir, "x") }, baseCtx),
        )
        expect(Exit.isFailure(exit)).toBe(true)
      }),
    ),
  )

  it.live("rejects on expected_size_bytes mismatch", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const toolInfo = yield* DownloadTool
        const tool = yield* toolInfo.init()
        const exit = yield* Effect.exit(
          tool.execute(
            { url: `${baseUrl}/hello`, dest: path.join(dir, "x"), expected_size_bytes: 999 },
            baseCtx,
          ),
        )
        expect(Exit.isFailure(exit)).toBe(true)
      }),
    ),
  )

  it.live("follows redirects", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const dest = path.join(dir, "redirected.txt")
        const toolInfo = yield* DownloadTool
        const tool = yield* toolInfo.init()
        const result = yield* tool.execute({ url: `${baseUrl}/redirect`, dest }, baseCtx)
        expect(result.metadata.bytes_received).toBe(5)
      }),
    ),
  )

  it.live("max_bytes cap aborts oversize downloads", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const toolInfo = yield* DownloadTool
        const tool = yield* toolInfo.init()
        const exit = yield* Effect.exit(
          tool.execute({ url: `${baseUrl}/big`, dest: path.join(dir, "big.bin"), max_bytes: 1024 }, baseCtx),
        )
        expect(Exit.isFailure(exit)).toBe(true)
      }),
    ),
  )
})
