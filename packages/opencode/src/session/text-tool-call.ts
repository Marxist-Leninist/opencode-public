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

// Some Ring/DeepSeek shapes emit Python-style dicts: single-quoted keys/strings,
// True/False/None instead of true/false/null. Convert minimally so JSON.parse can
// handle it without breaking strings that legitimately contain those tokens.
function pythonishToJson(input: string): string {
  let out = ""
  let i = 0
  while (i < input.length) {
    const ch = input[i]
    // Single-quoted string → re-emit as JSON double-quoted.
    if (ch === "'") {
      let j = i + 1
      let s = ""
      while (j < input.length) {
        const c = input[j]
        if (c === "\\" && j + 1 < input.length) {
          s += input[j] + input[j + 1]
          j += 2
          continue
        }
        if (c === "'") break
        s += c
        j++
      }
      // Escape any unescaped double quotes within s.
      const escaped = s.replace(/(^|[^\\])"/g, '$1\\"')
      out += '"' + escaped + '"'
      i = j + 1
      continue
    }
    // Double-quoted string → copy verbatim, including escapes.
    if (ch === '"') {
      let j = i + 1
      out += '"'
      while (j < input.length) {
        const c = input[j]
        out += c
        if (c === "\\" && j + 1 < input.length) {
          out += input[j + 1]
          j += 2
          continue
        }
        j++
        if (c === '"') break
      }
      i = j
      continue
    }
    // Python literals only when at a token boundary.
    if ((ch === "T" || ch === "F" || ch === "N") && /[A-Za-z_]/.test(input[i - 1] ?? "") === false) {
      if (input.startsWith("True", i) && !/[A-Za-z0-9_]/.test(input[i + 4] ?? "")) {
        out += "true"
        i += 4
        continue
      }
      if (input.startsWith("False", i) && !/[A-Za-z0-9_]/.test(input[i + 5] ?? "")) {
        out += "false"
        i += 5
        continue
      }
      if (input.startsWith("None", i) && !/[A-Za-z0-9_]/.test(input[i + 4] ?? "")) {
        out += "null"
        i += 4
        continue
      }
    }
    out += ch
    i++
  }
  return out
}

function tryJsonParse(jsonText: string): unknown {
  try {
    return JSON.parse(jsonText)
  } catch {}
  // Second attempt: pythonish dict → JSON.
  try {
    return JSON.parse(pythonishToJson(jsonText))
  } catch {}
  return undefined
}

// Find every plausible tool-call block in the text and return parsed payloads
// in document order. Used by parseTextToolCalls (plural) for multi-call shapes.
function extractAllJsonBlocks(text: string): string[] {
  const blocks: string[] = []
  // Wrapper tags first; can repeat.
  for (const tag of WRAPPER_TAGS) {
    const re = new RegExp(`<\\s*${tag}\\s*>([\\s\\S]*?)<\\s*\\/\\s*${tag}\\s*>`, "gi")
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) blocks.push(m[1].trim())
  }
  // Then markdown fences.
  const fenceRe = /```\s*(?:[a-zA-Z0-9_-]+)?\s*([\s\S]*?)\s*```/g
  let fm: RegExpExecArray | null
  while ((fm = fenceRe.exec(text)) !== null) blocks.push(fm[1].trim())
  return blocks
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
  const parsed = tryJsonParse(trimmed)
  if (isRecord(parsed)) return parsed
  if (Array.isArray(parsed)) return undefined
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

  let parsed: unknown = tryJsonParse(jsonText)
  if (parsed === undefined) return

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

// Parse every tool-call block found in `text` and return them in document order.
// Useful when Ring or DeepSeek emits multiple <tool_call> blocks in one message
// (an OpenAI parallel-tools shape rendered as text). Falls back to single-call
// parsing if no wrappers are found.
export function parseTextToolCalls(text: string): TextToolCall[] {
  const out: TextToolCall[] = []
  const seen = new Set<string>()
  const blocks = extractAllJsonBlocks(text)
  for (const block of blocks) {
    let parsed: unknown = tryJsonParse(block)
    if (parsed === undefined) continue
    // Unwrap may yield a list of calls — if so, expand.
    if (isRecord(parsed) && Array.isArray((parsed as { tool_calls?: unknown }).tool_calls)) {
      for (const item of (parsed as { tool_calls: unknown[] }).tool_calls) {
        const call = parseSingleObject(item)
        if (call) {
          const key = call.tool + "::" + JSON.stringify(call.input)
          if (!seen.has(key)) {
            seen.add(key)
            out.push(call)
          }
        }
      }
      continue
    }
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        const call = parseSingleObject(item)
        if (call) {
          const key = call.tool + "::" + JSON.stringify(call.input)
          if (!seen.has(key)) {
            seen.add(key)
            out.push(call)
          }
        }
      }
      continue
    }
    const call = parseSingleObject(parsed)
    if (call) {
      const key = call.tool + "::" + JSON.stringify(call.input)
      if (!seen.has(key)) {
        seen.add(key)
        out.push(call)
      }
    }
  }
  if (out.length === 0) {
    const single = parseTextToolCall(text)
    if (single) out.push(single)
  }
  return out
}

function parseSingleObject(parsed: unknown): TextToolCall | undefined {
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
  let argsSource: unknown =
    parsed.arguments ??
    parsed.args ??
    parsed.input ??
    parsed.parameters ??
    (isRecord(parsed.function) ? parsed.function.arguments : undefined)
  if (argsSource === undefined) {
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
  return { tool: name, input }
}

export const __testing = {
  extractJsonBlock,
  extractAllJsonBlocks,
  parseInput,
  stripNamespace,
  decodeMaybeEscaped,
  unwrapEnvelope,
  pythonishToJson,
  tryJsonParse,
}
