import { isRecord } from "@/util/record"

export type TextToolCall = {
  tool: string
  input: Record<string, unknown>
}

// Wrapper tags Ring / Qwen / DeepSeek-style models emit around tool calls.
const WRAPPER_TAGS = ["tool_call", "function_call", "tool", "function"] as const

// Namespace prefixes some models stick on tool names. We strip them when the
// suffix matches an actual tool the agent has available.
const TOOL_NAME_PREFIXES = ["functions.", "tools.", "multi_tool_use.", "namespace."] as const

function extractJsonBlock(text: string): string {
  // 1. Try every recognized wrapper tag.
  for (const tag of WRAPPER_TAGS) {
    const re = new RegExp(`<\\s*${tag}\\s*>([\\s\\S]*?)<\\s*\\/\\s*${tag}\\s*>`, "i")
    const m = text.match(re)
    if (m) return m[1].trim()
  }

  // 2. Try a markdown fence, with or without a language tag (json / tool / yaml / etc).
  const fenceMatch = text.match(/```\s*(?:[a-zA-Z0-9_-]+)?\s*([\s\S]*?)\s*```/)
  if (fenceMatch) return fenceMatch[1].trim()

  // 3. Try to extract first JSON object or array structure.
  const jsonMatch = text.match(/({[\s\S]*})|(\[[\s\S]*\])/)
  if (jsonMatch) return jsonMatch[0].trim()

  return text.trim()
}

function decodeMaybeEscaped(value: string): string {
  // Some models double-escape arguments (especially when a tool call gets re-stringified
  // through one or more JSON layers). If a leading double-quote is followed by a backslash,
  // try to JSON.parse it once to peel the outer quotes.
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      const peeled = JSON.parse(value)
      if (typeof peeled === "string") return peeled
    } catch {}
  }
  // HTML entity encoded JSON happens occasionally with proxied responses.
  if (value.includes("&quot;") || value.includes("&amp;")) {
    return value.replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&#39;/g, "'")
  }
  return value
}

function parseInput(value: unknown): Record<string, unknown> | undefined {
  if (isRecord(value)) return value
  if (typeof value !== "string") return
  const trimmed = decodeMaybeEscaped(value.trim())
  if (!trimmed) return {}
  try {
    const parsed = JSON.parse(trimmed)
    if (isRecord(parsed)) return parsed
    if (Array.isArray(parsed)) return undefined
  } catch (e) {
    return undefined
  }
  return undefined
}

function stripNamespace(name: string): string {
  for (const prefix of TOOL_NAME_PREFIXES) {
    if (name.startsWith(prefix) && name.length > prefix.length) {
      return name.slice(prefix.length)
    }
  }
  return name
}

function unwrapEnvelope(parsed: unknown): unknown {
  // Handle OpenAI-style {"tool_calls": [...]}
  if (isRecord(parsed) && Array.isArray(parsed.tool_calls) && parsed.tool_calls.length > 0) {
    return parsed.tool_calls[0]
  }
  // Handle legacy {"function_call": {...}}
  if (isRecord(parsed) && isRecord(parsed.function_call)) {
    return parsed.function_call
  }
  // Handle bare array of tool calls: [...]
  if (Array.isArray(parsed) && parsed.length > 0) {
    return parsed[0]
  }
  // Handle {"type":"function","function":{...}} shape - keep as-is so .function can be picked up.
  return parsed
}

export function parseTextToolCall(text: string): TextToolCall | undefined {
  const jsonText = extractJsonBlock(text)
  if (!jsonText) return

  let parsed: unknown
  try {
    parsed = JSON.parse(jsonText)
  } catch (e) {
    return
  }

  parsed = unwrapEnvelope(parsed)

  if (!isRecord(parsed)) return

  const rawName =
    parsed.name ??
    parsed.tool ??
    parsed.tool_name ??
    parsed.toolName ??
    (isRecord(parsed.function) ? parsed.function.name : undefined)

  if (typeof rawName !== "string" || !rawName.trim()) return
  const name = stripNamespace(rawName.trim())

  // The "arguments" field is sometimes a JSON string, sometimes already an object.
  // Some models emit `parameters`, `args`, `input`, or even nest under `function.arguments`.
  // Fall back to the parsed envelope itself only if no shape-typed source was found
  // AND the envelope clearly contains anything other than name/wrappers.
  let argsSource: unknown =
    parsed.arguments ??
    parsed.args ??
    parsed.input ??
    parsed.parameters ??
    (isRecord(parsed.function) ? parsed.function.arguments : undefined)

  if (argsSource === undefined) {
    // Fallback: pull every key that isn't a known wrapper field.
    const remainder: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(parsed)) {
      if (["name", "tool", "tool_name", "toolName", "type", "function", "id"].includes(k)) continue
      remainder[k] = v
    }
    if (Object.keys(remainder).length > 0) argsSource = remainder
    else argsSource = {}
  }

  const input = parseInput(argsSource)
  if (!input) return

  return {
    tool: name,
    input,
  }
}

export const __testing = { extractJsonBlock, parseInput, stripNamespace, decodeMaybeEscaped, unwrapEnvelope }
