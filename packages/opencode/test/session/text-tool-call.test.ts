import { describe, expect, test } from "bun:test"
import { parseTextToolCall, parseTextToolCalls, __testing } from "../../src/session/text-tool-call"

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

  test("parses Python-style dict with single quotes and True/None", () => {
    expect(
      parseTextToolCall(
        "<tool_call>{'name': 'bash', 'arguments': {'command': 'ls', 'background': True, 'timeout': None}}</tool_call>",
      ),
    ).toEqual({
      tool: "bash",
      input: { command: "ls", background: true, timeout: null },
    })
  })

  test("parses Python-style False inside double-quoted string passes through unchanged", () => {
    // We DO want True/False/None outside strings rewritten, but inside a string they should stay.
    const r = parseTextToolCall(
      '{"name":"bash","arguments":"{\\"command\\":\\"echo True\\"}"}',
    )
    expect(r).toEqual({ tool: "bash", input: { command: "echo True" } })
  })

  test("__testing.pythonishToJson handles single-quoted strings + literals", () => {
    expect(__testing.pythonishToJson("{'a': True, 'b': False, 'c': None, 'd': 'hi'}")).toBe(
      '{"a": true, "b": false, "c": null, "d": "hi"}',
    )
  })

  test("__testing.pythonishToJson preserves identifiers containing True/False/None substrings", () => {
    expect(__testing.pythonishToJson("Truecaller")).toBe("Truecaller")
    expect(__testing.pythonishToJson("Falsey")).toBe("Falsey")
  })
})

describe("parseTextToolCalls (plural)", () => {
  test("returns single call when only one wrapper present", () => {
    const r = parseTextToolCalls('<tool_call>{"name":"bash","arguments":{"command":"ls"}}</tool_call>')
    expect(r).toHaveLength(1)
    expect(r[0]).toEqual({ tool: "bash", input: { command: "ls" } })
  })

  test("returns each call from multiple wrappers in order", () => {
    const r = parseTextToolCalls(
      'Step 1:\n<tool_call>{"name":"bash","arguments":{"command":"ls"}}</tool_call>\n' +
        'Step 2:\n<tool_call>{"name":"read","arguments":{"path":"/etc/hosts"}}</tool_call>',
    )
    expect(r.length).toBeGreaterThanOrEqual(2)
    expect(r[0]).toEqual({ tool: "bash", input: { command: "ls" } })
    expect(r[1]).toEqual({ tool: "read", input: { path: "/etc/hosts" } })
  })

  test("expands a tool_calls envelope into multiple calls", () => {
    const r = parseTextToolCalls(
      '<tool_call>{"tool_calls":[{"name":"bash","arguments":{"command":"ls"}},{"name":"grep","arguments":{"pattern":"foo"}}]}</tool_call>',
    )
    expect(r).toHaveLength(2)
    expect(r[0].tool).toBe("bash")
    expect(r[1].tool).toBe("grep")
  })

  test("dedupes identical calls", () => {
    const r = parseTextToolCalls(
      '<tool_call>{"name":"bash","arguments":{"command":"ls"}}</tool_call><tool_call>{"name":"bash","arguments":{"command":"ls"}}</tool_call>',
    )
    expect(r).toHaveLength(1)
  })

  test("returns empty array when nothing to parse", () => {
    expect(parseTextToolCalls("Just a normal answer.")).toEqual([])
  })
})
