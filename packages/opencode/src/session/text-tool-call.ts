import { isRecord } from "@/util/record"

export type TextToolCall = {
  tool: string
  input: Record<string, unknown>
}

function unwrapFence(text: string) {
  const trimmed = text.trim()
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  return match ? match[1].trim() : trimmed
}

function unwrapToolCall(text: string) {
  const trimmed = text.trim()
  const match = trimmed.match(/^<\s*tool_call\s*>\s*([\s\S]*?)\s*<\s*\/\s*tool_call\s*>$/i)
  return match ? match[1].trim() : trimmed
}

function parseInput(value: unknown) {
  if (isRecord(value)) return value
  if (typeof value !== "string") return
  const trimmed = value.trim()
  if (!trimmed) return {}
  const parsed = JSON.parse(trimmed)
  if (isRecord(parsed)) return parsed
}

export function parseTextToolCall(text: string): TextToolCall | undefined {
  const trimmed = unwrapToolCall(unwrapFence(text))
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return

  const parsed = JSON.parse(trimmed)
  if (!isRecord(parsed)) return

  const name = parsed.name ?? parsed.tool ?? parsed.tool_name ?? (isRecord(parsed.function) ? parsed.function.name : undefined)
  if (typeof name !== "string" || !name.trim()) return

  const input = parseInput(
    parsed.arguments ??
      parsed.args ??
      parsed.input ??
      parsed.parameters ??
      (isRecord(parsed.function) ? parsed.function.arguments : undefined),
  )
  if (!input) return

  return {
    tool: name.trim(),
    input,
  }
}
