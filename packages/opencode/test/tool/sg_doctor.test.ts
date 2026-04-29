import { describe, expect, test, beforeAll, afterAll } from "bun:test"
import { createServer, type Server } from "node:http"
import { __testing } from "../../src/tool/sg_doctor"
import path from "path"
import { writeFile, mkdtemp, rm } from "node:fs/promises"
import os from "node:os"

const {
  probeRing,
  probeRingText,
  probeRingMultimodal,
  probeMcp,
  probeScheduler,
  probeOpenAiCompatibleModels,
  probeWithCache,
  probeCache,
  cacheKey,
  sweepExpired,
} = __testing

describe("sg_doctor probes", () => {
  let server: Server
  let baseUrl: string

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === "/v1/models" && req.headers.authorization === "Bearer goodkey") {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ object: "list", data: [{ id: "Ring-2.5-1T" }] }))
        return
      }
      if (req.url === "/v1/models" && req.headers.authorization === "Bearer wrongkey") {
        res.writeHead(401)
        res.end("auth failed")
        return
      }
      if (req.url === "/v1/models-noring" && req.headers.authorization === "Bearer goodkey") {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ object: "list", data: [{ id: "OtherModel" }] }))
        return
      }
      if (req.url === "/upstream/models" && req.headers.authorization === "Bearer goodkey") {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(
          JSON.stringify({
            object: "list",
            data: [
              { id: "deepseek-v4-pro" },
              { id: "deepseek-v4-flash" },
              { id: "anthropic/claude-haiku" },
            ],
          }),
        )
        return
      }
      if (req.url === "/upstream/models" && req.headers.authorization === "Bearer wrongkey") {
        res.writeHead(401, { "content-type": "application/json" })
        res.end(JSON.stringify({ error: { message: "Invalid bearer" } }))
        return
      }
      if (req.url === "/upstream-empty/models" && req.headers.authorization === "Bearer goodkey") {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ object: "list", data: [] }))
        return
      }
      if (req.url === "/v1-textonly/chat/completions" && req.method === "POST") {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: "assistant",
                  content:
                    "probe-ok [NOTE: 1 non-text attachment(s) (images/files/audio) were dropped because the Ring text-only model …]",
                },
              },
            ],
          }),
        )
        return
      }
      // Newer Ring shape: drop note is in reasoning_content, not content.
      if (req.url === "/v1-textonly-reasoning/chat/completions" && req.method === "POST") {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: "assistant",
                  content: "However, note that the user's message does not contain any non-text attachment.",
                  reasoning_content:
                    'We are given a specific instruction: "Reply with exactly: probe-ok [NOTE: 1 non-text attachment(s) (images/files/audio) were dropped because the Ring-2.5-1T text proxy does not yet support multimodal input.]"',
                },
              },
            ],
          }),
        )
        return
      }
      // Same as v1-textonly but with the response truncated mid-note before "were dropped" — happens at low max_tokens.
      if (req.url === "/v1-textonly-truncated/chat/completions" && req.method === "POST") {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: "assistant",
                  content: 'Reply with exactly: probe-ok [NOTE: 1 non-text attachment(s) (images/files/a',
                },
              },
            ],
          }),
        )
        return
      }
      if (req.url === "/v1-multimodal/chat/completions" && req.method === "POST") {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(
          JSON.stringify({
            choices: [{ message: { role: "assistant", content: "probe-ok" } }],
          }),
        )
        return
      }
      if (req.url === "/v1-weird/chat/completions" && req.method === "POST") {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "what?" } }] }))
        return
      }
      // ring_text: completion echoes the OKZ sentinel.
      if (req.url === "/v1-text-ok/chat/completions" && req.method === "POST") {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(
          JSON.stringify({
            choices: [{ message: { role: "assistant", content: "OKZ" } }],
          }),
        )
        return
      }
      // ring_text: completion runs but doesn't echo the sentinel.
      if (req.url === "/v1-text-bad/chat/completions" && req.method === "POST") {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(
          JSON.stringify({
            choices: [{ message: { role: "assistant", content: "I cannot do that." } }],
          }),
        )
        return
      }
      // ring_text: completion route is dead even though /models works (proxy half-up).
      if (req.url === "/v1-text-503/chat/completions" && req.method === "POST") {
        res.writeHead(503, { "content-type": "text/plain" })
        res.end("upstream unavailable")
        return
      }
      if (req.url === "/mcp/sse") {
        if (req.method === "HEAD") {
          res.writeHead(200, { "content-type": "text/event-stream" })
          res.end()
          return
        }
        res.writeHead(200, { "content-type": "text/event-stream" })
        res.write(":keepalive\n\n")
        // Don't end - simulate SSE streaming.
        return
      }
      res.writeHead(404)
      res.end()
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()))
    const addr = server.address()
    if (typeof addr === "object" && addr) {
      baseUrl = `http://127.0.0.1:${addr.port}`
    }
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  test("probeRing detects Ring-2.5-1T listing with valid key", async () => {
    const result = await probeRing(`${baseUrl}/v1`, "goodkey", 4000)
    expect(result.target).toBe("ring")
    expect(result.ok).toBe(true)
    expect(result.status).toBe(200)
    expect(result.detail).toContain("Ring-2.5-1T")
  })

  test("probeRing reports missing API key", async () => {
    const result = await probeRing(`${baseUrl}/v1`, undefined, 4000)
    expect(result.ok).toBe(false)
    expect(result.detail).toContain("no API key")
  })

  test("probeRing reports auth failure", async () => {
    const result = await probeRing(`${baseUrl}/v1`, "wrongkey", 4000)
    expect(result.ok).toBe(false)
    expect(result.status).toBe(401)
  })

  test("probeRing flags missing model in list", async () => {
    const result = await probeRing(`${baseUrl}/v1-noring`, "goodkey", 4000)
    expect(result.ok).toBe(false)
  })

  test("probeRingText reports OK when sentinel is echoed", async () => {
    const result = await probeRingText(`${baseUrl}/v1-text-ok`, "goodkey", 4000)
    expect(result.target).toBe("ring_text")
    expect(result.ok).toBe(true)
    expect(result.detail).toContain("OKZ")
  })

  test("probeRingText flags response that does not echo sentinel", async () => {
    const result = await probeRingText(`${baseUrl}/v1-text-bad`, "goodkey", 4000)
    expect(result.target).toBe("ring_text")
    expect(result.ok).toBe(false)
    expect(result.status).toBe(200)
  })

  test("probeRingText flags 5xx as not-ok with status code", async () => {
    const result = await probeRingText(`${baseUrl}/v1-text-503`, "goodkey", 4000)
    expect(result.target).toBe("ring_text")
    expect(result.ok).toBe(false)
    expect(result.status).toBe(503)
  })

  test("probeRingText reports missing API key", async () => {
    const result = await probeRingText(`${baseUrl}/v1-text-ok`, undefined, 4000)
    expect(result.target).toBe("ring_text")
    expect(result.ok).toBe(false)
    expect(result.detail).toContain("no API key")
  })

  test("probeMcp detects HEAD-reachable MCP endpoint", async () => {
    const result = await probeMcp("sg1", `${baseUrl}/mcp/sse`, 4000)
    expect(result.target).toBe("sg1")
    expect(result.ok).toBe(true)
    expect(result.status).toBeDefined()
  })

  test("probeMcp reports unreachable host", async () => {
    const result = await probeMcp("sg2", "http://127.0.0.1:1/mcp/sse", 1500)
    expect(result.target).toBe("sg2")
    expect(result.ok).toBe(false)
  })

  test("probeScheduler accepts a valid local script entry", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "sgsched-"))
    const script = path.join(dir, "server.py")
    await writeFile(script, "print('ok')\n")
    try {
      const result = await probeScheduler({
        mcp: { "sg-scheduler": { type: "local", command: ["python", script] } },
      })
      expect(result.ok).toBe(true)
      expect(result.detail).toContain("python")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("probeScheduler flags missing script", async () => {
    const result = await probeScheduler({
      mcp: { "sg-scheduler": { type: "local", command: ["python", "/nope/missing-server.py"] } },
    })
    expect(result.ok).toBe(false)
    expect(result.detail).toContain("not found")
  })

  test("probeScheduler flags missing config entry", async () => {
    const result = await probeScheduler({})
    expect(result.ok).toBe(false)
    expect(result.detail).toContain("no sg-scheduler")
  })

  test("probeRingMultimodal: text-only proxy is reported as ok with text-only detail", async () => {
    const result = await probeRingMultimodal(`${baseUrl}/v1-textonly`, "goodkey", 6000)
    expect(result.target).toBe("ring_multimodal")
    expect(result.ok).toBe(true)
    expect(result.detail).toMatch(/text-only/i)
  })

  test("probeRingMultimodal: drop note in reasoning_content is still detected as text-only", async () => {
    const result = await probeRingMultimodal(`${baseUrl}/v1-textonly-reasoning`, "goodkey", 6000)
    expect(result.target).toBe("ring_multimodal")
    expect(result.ok).toBe(true)
    expect(result.detail).toMatch(/text-only/i)
  })

  test("probeRingMultimodal: truncated drop note is still detected as text-only", async () => {
    // When the response is cut off mid-sentence (low max_tokens) before "were dropped",
    // the "non-text attachment(s)" substring alone must trigger the text-only verdict.
    const result = await probeRingMultimodal(`${baseUrl}/v1-textonly-truncated`, "goodkey", 6000)
    expect(result.target).toBe("ring_multimodal")
    expect(result.ok).toBe(true)
    expect(result.detail).toMatch(/text-only/i)
  })

  test("probeRingMultimodal: multimodal-capable proxy is reported as ok with multimodal detail", async () => {
    const result = await probeRingMultimodal(`${baseUrl}/v1-multimodal`, "goodkey", 6000)
    expect(result.target).toBe("ring_multimodal")
    expect(result.ok).toBe(true)
    expect(result.detail).toMatch(/multimodal/i)
  })

  test("probeRingMultimodal: inconclusive response is reported not-ok", async () => {
    const result = await probeRingMultimodal(`${baseUrl}/v1-weird`, "goodkey", 6000)
    expect(result.target).toBe("ring_multimodal")
    expect(result.ok).toBe(false)
    expect(result.detail).toMatch(/inconclusive/i)
  })

  test("probeRingMultimodal: missing key returns clear error", async () => {
    const result = await probeRingMultimodal(`${baseUrl}/v1-textonly`, undefined, 4000)
    expect(result.ok).toBe(false)
    expect(result.detail).toMatch(/no API key/)
  })

  test("probeOpenAiCompatibleModels: deepseek-style /models with valid key", async () => {
    const result = await probeOpenAiCompatibleModels("deepseek", `${baseUrl}/upstream`, "goodkey", 4000, "deepseek")
    expect(result.target).toBe("deepseek")
    expect(result.ok).toBe(true)
    expect(result.status).toBe(200)
    expect(result.detail).toMatch(/3 models/)
    expect(result.detail).toMatch(/deepseek: yes/)
  })

  test("probeOpenAiCompatibleModels: openrouter-style /models with valid key, no hint", async () => {
    const result = await probeOpenAiCompatibleModels("openrouter", `${baseUrl}/upstream`, "goodkey", 4000)
    expect(result.target).toBe("openrouter")
    expect(result.ok).toBe(true)
    expect(result.detail).toMatch(/3 models/)
    expect(result.detail).not.toMatch(/yes|no/)
  })

  test("probeOpenAiCompatibleModels: 401 surfaces auth error", async () => {
    const result = await probeOpenAiCompatibleModels("deepseek", `${baseUrl}/upstream`, "wrongkey", 4000)
    expect(result.ok).toBe(false)
    expect(result.status).toBe(401)
  })

  test("probeOpenAiCompatibleModels: missing API key short-circuits", async () => {
    const result = await probeOpenAiCompatibleModels("openrouter", `${baseUrl}/upstream`, undefined, 4000)
    expect(result.ok).toBe(false)
    expect(result.detail).toMatch(/no API key/)
  })

  test("probeOpenAiCompatibleModels: empty model list reports not-ok", async () => {
    const result = await probeOpenAiCompatibleModels("deepseek", `${baseUrl}/upstream-empty`, "goodkey", 4000)
    expect(result.ok).toBe(false)
    expect(result.detail).toMatch(/list empty/)
  })

  test("probeWithCache: ttl=0 always probes fresh", async () => {
    probeCache.clear()
    let calls = 0
    const probe = async () => {
      calls++
      return { target: "ring_text" as const, ok: true, latency_ms: 5, detail: `call ${calls}` }
    }
    const a = await probeWithCache("ring_text", "https://example.test", "k1", 0, false, probe)
    const b = await probeWithCache("ring_text", "https://example.test", "k1", 0, false, probe)
    expect(calls).toBe(2)
    expect(a.from_cache).toBeUndefined()
    expect(b.from_cache).toBeUndefined()
  })

  test("probeWithCache: ttl>0 reuses a successful probe", async () => {
    probeCache.clear()
    let calls = 0
    const probe = async () => {
      calls++
      return { target: "ring_multimodal" as const, ok: true, latency_ms: 9, detail: `c${calls}` }
    }
    const fresh = await probeWithCache("ring_multimodal", "https://example.test", "k1", 60_000, false, probe)
    const cached = await probeWithCache("ring_multimodal", "https://example.test", "k1", 60_000, false, probe)
    expect(calls).toBe(1)
    expect(fresh.from_cache).toBeUndefined()
    expect(cached.from_cache).toBe(true)
    expect(typeof cached.cache_age_ms).toBe("number")
  })

  test("probeWithCache: failures are not cached", async () => {
    probeCache.clear()
    let calls = 0
    const probe = async () => {
      calls++
      return { target: "ring_text" as const, ok: false, detail: `fail ${calls}` }
    }
    await probeWithCache("ring_text", "https://example.test", "k2", 60_000, false, probe)
    await probeWithCache("ring_text", "https://example.test", "k2", 60_000, false, probe)
    expect(calls).toBe(2)
  })

  test("probeWithCache: force_refresh ignores cache", async () => {
    probeCache.clear()
    let calls = 0
    const probe = async () => {
      calls++
      return { target: "ring_multimodal" as const, ok: true, detail: `c${calls}` }
    }
    await probeWithCache("ring_multimodal", "https://example.test", "k3", 60_000, false, probe)
    const refreshed = await probeWithCache("ring_multimodal", "https://example.test", "k3", 60_000, true, probe)
    expect(calls).toBe(2)
    expect(refreshed.from_cache).toBeUndefined()
  })

  test("probeWithCache: different keys cache separately", async () => {
    probeCache.clear()
    let calls = 0
    const probe = async () => {
      calls++
      return { target: "ring_text" as const, ok: true, detail: `c${calls}` }
    }
    await probeWithCache("ring_text", "https://a.test", "x", 60_000, false, probe)
    await probeWithCache("ring_text", "https://b.test", "x", 60_000, false, probe)
    await probeWithCache("ring_text", "https://a.test", "y", 60_000, false, probe)
    expect(calls).toBe(3)
  })

  test("sweepExpired: removes entries older than ttl", async () => {
    probeCache.clear()
    const k = cacheKey("ring_text", "https://expired.test", "key")
    probeCache.set(k, {
      result: { target: "ring_text", ok: true },
      ts: Date.now() - 10_000,
    })
    sweepExpired(5_000)
    expect(probeCache.has(k)).toBe(false)
  })

  test("cacheKey: only the suffix of the API key participates (no full-key leakage)", () => {
    const long = "abcdefghijklmnopqrstuvwxyz123456"
    const k = cacheKey("ring_text", "https://example.test", long)
    expect(k).not.toContain(long)
    expect(k.endsWith(long.slice(-8))).toBe(true)
  })
})
