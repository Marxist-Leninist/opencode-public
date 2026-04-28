import { describe, expect, test } from "bun:test"
import { parseTextToolCall } from "../../src/session/text-tool-call"

describe("parseTextToolCall", () => {
  test("parses Ring/OpenAI-style name plus JSON-string arguments", () => {
    expect(parseTextToolCall('{"name":"Bash","arguments":"{\\"command\\":\\"ls -la\\"}"}')).toEqual({
      tool: "Bash",
      input: { command: "ls -la" },
    })
  })

  test("parses fenced function call payloads", () => {
    expect(
      parseTextToolCall('```json\n{"function":{"name":"grep","arguments":"{\\"pattern\\":\\"foo\\"}"}}\n```'),
    ).toEqual({
      tool: "grep",
      input: { pattern: "foo" },
    })
  })

  test("parses Ring tool_call wrapper payloads", () => {
    expect(parseTextToolCall('<tool_call>\n{"name":"Bash","arguments":{"command":"ls -la"}}\n</tool_call>')).toEqual({
      tool: "Bash",
      input: { command: "ls -la" },
    })
  })

  test("ignores normal answers", () => {
    expect(parseTextToolCall("I can run ls for you.")).toBeUndefined()
  })
})
