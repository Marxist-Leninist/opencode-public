import { isRecord } from "@/util/record"

export type TextToolCall = {
  tool: string
  input: Record<string, unknown>
}

function extractJsonBlock(text: string): string {
  // 1. Try to find a <tool_call> block (ignoring surrounding text)
  const toolCallMatch = text.match(/<\s*tool_call\s*>([\s\S]*?)<\s*\/\s*tool_call\s*>/i)
  if (toolCallMatch) return toolCallMatch[1].trim()

  // 2. Try to find a markdown json fence
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)
  if (fenceMatch) return fenceMatch[1].trim()

  // 3. Try to extract first JSON object or array structure
  const jsonMatch = text.match(/({[\s\S]*})|(\[[\s\S]*\])/)
  if (jsonMatch) return jsonMatch[0].trim()

  return text.trim()
}

function parseInput(value: unknown): Record<string, unknown> | undefined {
  if (isRecord(value)) return value
  if (typeof value !== "string") return
  const trimmed = value.trim()
  if (!trimmed) return {}
  try {
    const parsed = JSON.parse(trimmed)
    if (isRecord(parsed)) return parsed
  } catch (e) {
    return undefined
  }
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

  // Handle OpenAI-style {"tool_calls": [...]}
  if (isRecord(parsed) && Array.isArray(parsed.tool_calls) && parsed.tool_calls.length > 0) {
    parsed = parsed.tool_calls[0]
  } else if (Array.isArray(parsed) && parsed.length > 0) {
    // Handle bare array of tool calls: [...]
    parsed = parsed[0]
  }

  if (!isRecord(parsed)) return

  const name =
    parsed.name ??
    parsed.tool ??
    parsed.tool_name ??
    (isRecord(parsed.function) ? parsed.function.name : undefined)

  if (typeof name !== "string" || !name.trim()) return

  const input = parseInput(
    parsed.arguments ??
      parsed.args ??
      parsed.input ??
      parsed.parameters ??
      (isRecord(parsed.function) ? parsed.function.arguments : undefined) ??
      parsed
  )
  if (!input) return

  return {
    tool: name.trim(),
    input,
  }
}
