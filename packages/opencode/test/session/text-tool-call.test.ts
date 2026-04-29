import { describe, expect, test } from "bun:test"
import { parseTextToolCall, __testing } from "../../src/session/text-tool-call"

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

  test("parses <function_call> wrapper", () => {
    expect(
      parseTextToolCall('<function_call>{"name":"read","arguments":{"path":"/etc/hosts"}}</function_call>'),
    ).toEqual({ tool: "read", input: { path: "/etc/hosts" } })
  })

  test("parses <function> wrapper with JSON-string arguments", () => {
    expect(parseTextToolCall('<function>{"name":"bash","arguments":"{\\"command\\":\\"pwd\\"}"}</function>')).toEqual({
      tool: "bash",
      input: { command: "pwd" },
    })
  })

  test("parses tool_calls wrapper from OpenAI tool-use messages", () => {
    expect(
      parseTextToolCall(
        '{"tool_calls":[{"id":"call_1","type":"function","function":{"name":"glob","arguments":"{\\"pattern\\":\\"*.ts\\"}"}}]}',
      ),
    ).toEqual({ tool: "glob", input: { pattern: "*.ts" } })
  })

  test("parses bare array of tool calls", () => {
    expect(
      parseTextToolCall('[{"name":"grep","arguments":{"pattern":"foo"}}]'),
    ).toEqual({ tool: "grep", input: { pattern: "foo" } })
  })

  test("parses legacy function_call envelope", () => {
    expect(
      parseTextToolCall('{"function_call":{"name":"bash","arguments":"{\\"command\\":\\"ls\\"}"}}'),
    ).toEqual({ tool: "bash", input: { command: "ls" } })
  })

  test("strips namespace prefixes from tool name", () => {
    expect(parseTextToolCall('{"name":"functions.bash","arguments":{"command":"ls"}}')).toEqual({
      tool: "bash",
      input: { command: "ls" },
    })
    expect(parseTextToolCall('{"name":"tools.read","arguments":{"path":"/x"}}')).toEqual({
      tool: "read",
      input: { path: "/x" },
    })
  })

  test("falls back to remainder fields when no arguments key present", () => {
    expect(parseTextToolCall('{"name":"bash","command":"ls -la","timeout":5}')).toEqual({
      tool: "bash",
      input: { command: "ls -la", timeout: 5 },
    })
  })

  test("parses fenced block with arbitrary language tag", () => {
    expect(
      parseTextToolCall('```tool\n{"name":"bash","arguments":{"command":"ls"}}\n```'),
    ).toEqual({ tool: "bash", input: { command: "ls" } })
  })

  test("decodes HTML-encoded arguments", () => {
    expect(
      parseTextToolCall('{"name":"bash","arguments":"{&quot;command&quot;:&quot;ls&quot;}"}'),
    ).toEqual({ tool: "bash", input: { command: "ls" } })
  })

  test("ignores trailing prose after a tool_call block", () => {
    expect(
      parseTextToolCall(
        'Sure, I will run that:\n<tool_call>{"name":"bash","arguments":{"command":"ls"}}</tool_call>\nLet me know.',
      ),
    ).toEqual({ tool: "bash", input: { command: "ls" } })
  })

  test("empty arguments string yields empty input object", () => {
    expect(parseTextToolCall('{"name":"todo","arguments":""}')).toEqual({
      tool: "todo",
      input: {},
    })
  })

  test("__testing.stripNamespace handles unknown prefixes", () => {
    expect(__testing.stripNamespace("foo.bar")).toBe("foo.bar")
    expect(__testing.stripNamespace("functions.")).toBe("functions.")
    expect(__testing.stripNamespace("functions.bash")).toBe("bash")
  })
})
