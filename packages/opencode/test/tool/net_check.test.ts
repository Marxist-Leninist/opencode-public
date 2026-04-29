import { describe, expect, test } from "bun:test"
import { createServer } from "node:net"
import { __testing } from "../../src/tool/net_check"

const { probeDns, probeTcp, summarise } = __testing

describe("net_check.probeDns", () => {
  test("resolves a real public hostname", async () => {
    const ac = new AbortController()
    const r = await probeDns("one.one.one.one", 5000, ac.signal)
    expect(r.mode).toBe("dns")
    expect(r.host).toBe("one.one.one.one")
    expect((r.addresses ?? []).length).toBeGreaterThan(0)
  }, 10_000)
  test("returns empty addresses for an invalid hostname without throwing", async () => {
    const ac = new AbortController()
    const r = await probeDns("definitely-not-a-real-host-xyz.invalid", 3000, ac.signal)
    expect(r.mode).toBe("dns")
    expect(r.addresses?.length ?? 0).toBe(0)
    expect(r.error).toBeDefined()
  }, 10_000)
})

describe("net_check.probeTcp", () => {
  test("connects to a local server on an ephemeral port", async () => {
    const server = createServer((sock) => {
      sock.end()
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const addr = server.address()
    if (!addr || typeof addr === "string") {
      server.close()
      throw new Error("could not bind ephemeral port")
    }
    const port = addr.port
    try {
      const ac = new AbortController()
      const r = await probeTcp("127.0.0.1", port, 3000, ac.signal)
      expect(r.connected).toBe(true)
      expect(typeof r.latency_ms).toBe("number")
      expect(r.error).toBeUndefined()
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }, 10_000)
  test("reports a clean failure for a closed port without throwing", async () => {
    // Reserved port that's almost always closed locally.
    const ac = new AbortController()
    const r = await probeTcp("127.0.0.1", 1, 1500, ac.signal)
    expect(r.connected).toBe(false)
    expect(r.error).toBeDefined()
  }, 10_000)
})

describe("net_check.summarise", () => {
  test("formats a successful tcp probe", () => {
    const sum = summarise({
      mode: "tcp",
      host: "5.75.217.57",
      port: 22,
      connected: true,
      latency_ms: 42,
      timeout_ms: 5000,
    })
    expect(sum.title).toMatch(/tcp 5\.75\.217\.57:22 OK/)
    expect(sum.output).toContain("connected in 42ms")
  })
  test("formats a failing http probe", () => {
    const sum = summarise({
      mode: "http",
      url: "https://example.invalid/",
      method: "HEAD",
      total_ms: 100,
      timeout_ms: 5000,
      error: "ENOTFOUND",
    })
    expect(sum.title).toMatch(/ENOTFOUND/)
    expect(sum.output).toContain("https://example.invalid")
  })
  test("formats dns with multiple records", () => {
    const sum = summarise({
      mode: "dns",
      host: "example.com",
      addresses: [
        { kind: "A", value: "93.184.216.34" },
        { kind: "AAAA", value: "2606:2800:220:1:248:1893:25c8:1946" },
      ],
      latency_ms: 30,
      timeout_ms: 5000,
    })
    expect(sum.output).toContain("A    93.184.216.34")
    expect(sum.output).toContain("AAAA 2606:2800:220:1:248:1893:25c8:1946")
  })
})
