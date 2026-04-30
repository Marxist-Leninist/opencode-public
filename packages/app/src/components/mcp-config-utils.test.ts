import { describe, expect, test } from "bun:test"
import {
  buildMcpServerConfig,
  emptyMcpKvRow,
  mcpRowsToRecord,
  parseMcpCommand,
  parseMcpName,
  parseMcpRemoteUrl,
  parseMcpTimeout,
} from "./mcp-config-utils"

describe("mcp config helpers", () => {
  test("validates MCP server names", () => {
    expect(parseMcpName(" sg_tools-1 ")).toBe("sg_tools-1")
    expect(() => parseMcpName("bad name")).toThrow("Letters, digits")
    expect(() => parseMcpName("")).toThrow("Name is required")
  })

  test("parses positive timeout values", () => {
    expect(parseMcpTimeout("")).toBeUndefined()
    expect(parseMcpTimeout(" 5000 ")).toBe(5000)
    expect(() => parseMcpTimeout("0")).toThrow("positive")
    expect(() => parseMcpTimeout("1.5")).toThrow("positive")
  })

  test("accepts only http and https remote URLs", () => {
    expect(parseMcpRemoteUrl(" https://example.com/mcp ")).toBe("https://example.com/mcp")
    expect(() => parseMcpRemoteUrl("ftp://example.com")).toThrow("http:// or https://")
    expect(() => parseMcpRemoteUrl("example.com")).toThrow("valid")
  })

  test("parses quoted local commands", () => {
    expect(parseMcpCommand('node "C:\\Program Files\\server.js" --stdio')).toEqual([
      "node",
      "C:\\Program Files\\server.js",
      "--stdio",
    ])
    expect(parseMcpCommand("python 'C:\\tools\\server script.py'")).toEqual([
      "python",
      "C:\\tools\\server script.py",
    ])
    expect(() => parseMcpCommand('node "unterminated')).toThrow("unmatched quote")
  })

  test("turns non-empty key/value rows into records", () => {
    expect(mcpRowsToRecord([emptyMcpKvRow(), { key: " Authorization ", value: "Bearer token" }])).toEqual({
      Authorization: "Bearer token",
    })
    expect(mcpRowsToRecord([emptyMcpKvRow()])).toBeUndefined()
  })

  test("builds remote and local server config", () => {
    expect(
      buildMcpServerConfig({
        transport: "remote",
        url: "https://example.com/mcp",
        command: "",
        enabled: true,
        defer: true,
        timeout: "10000",
        headers: [{ key: "X-Test", value: "1" }],
        environment: [],
      }),
    ).toEqual({
      type: "remote",
      url: "https://example.com/mcp",
      enabled: true,
      defer: true,
      timeout: 10000,
      headers: { "X-Test": "1" },
    })

    expect(
      buildMcpServerConfig({
        transport: "local",
        url: "",
        command: 'bun "C:\\mcp servers\\index.ts"',
        enabled: false,
        defer: false,
        timeout: "",
        headers: [],
        environment: [{ key: "TOKEN", value: "redacted" }],
      }),
    ).toEqual({
      type: "local",
      command: ["bun", "C:\\mcp servers\\index.ts"],
      enabled: false,
      defer: false,
      environment: { TOKEN: "redacted" },
    })
  })
})
