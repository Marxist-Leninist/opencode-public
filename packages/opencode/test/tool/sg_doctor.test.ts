import { describe, expect, test, beforeAll, afterAll } from "bun:test"
import { createServer, type Server } from "node:http"
import { __testing } from "../../src/tool/sg_doctor"
import path from "path"
import { writeFile, mkdtemp, rm } from "node:fs/promises"
import os from "node:os"

const { probeRing, probeRingMultimodal, probeMcp, probeScheduler, probeOpenAiCompatibleModels } = __testing

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
})
