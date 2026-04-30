export type McpTransport = "remote" | "local"
export type McpKvRow = { key: string; value: string }
export type McpServerConfig =
  | {
      type: "remote"
      url: string
      enabled: boolean
      defer: boolean
      headers?: Record<string, string>
      timeout?: number
    }
  | {
      type: "local"
      command: string[]
      enabled: boolean
      defer: boolean
      environment?: Record<string, string>
      timeout?: number
    }

export function emptyMcpKvRow(): McpKvRow {
  return { key: "", value: "" }
}

export function parseMcpName(value: string) {
  const name = value.trim()
  if (!name) throw new Error("Name is required.")
  if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error("Letters, digits, _ and - only.")
  return name
}

export function parseMcpTimeout(value: string) {
  const trimmed = value.trim()
  if (!trimmed) return undefined
  const timeout = Number(trimmed)
  if (!Number.isInteger(timeout) || timeout <= 0) throw new Error("Timeout must be a positive integer in ms.")
  return timeout
}

export function parseMcpRemoteUrl(value: string) {
  const trimmed = value.trim()
  if (!trimmed) throw new Error("URL is required.")
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new Error("URL must be a valid http:// or https:// address.")
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("URL must start with http:// or https://.")
  }
  return trimmed
}

export function parseMcpCommand(value: string) {
  const args: string[] = []
  let current = ""
  let quote: '"' | "'" | undefined
  let escaping = false

  for (const char of value.trim()) {
    if (escaping) {
      current += char === '"' || char === "\\" ? char : `\\${char}`
      escaping = false
      continue
    }
    if (quote === '"' && char === "\\") {
      escaping = true
      continue
    }
    if (quote) {
      if (char === quote) quote = undefined
      else current += char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (/\s/.test(char)) {
      if (current) {
        args.push(current)
        current = ""
      }
      continue
    }
    current += char
  }

  if (escaping) current += "\\"
  if (quote) throw new Error("Command has an unmatched quote.")
  if (current) args.push(current)
  if (args.length === 0) throw new Error("Command is required.")
  return args
}

export function mcpRowsToRecord(rows: McpKvRow[]) {
  const result: Record<string, string> = {}
  for (const row of rows) {
    const key = row.key.trim()
    if (!key) continue
    result[key] = row.value
  }
  return Object.keys(result).length > 0 ? result : undefined
}

export function buildMcpServerConfig(input: {
  transport: McpTransport
  command: string
  url: string
  enabled: boolean
  defer: boolean
  timeout: string
  headers: McpKvRow[]
  environment: McpKvRow[]
}): McpServerConfig {
  const timeout = parseMcpTimeout(input.timeout)
  if (input.transport === "remote") {
    const config: McpServerConfig = {
      type: "remote",
      url: parseMcpRemoteUrl(input.url),
      enabled: input.enabled,
      defer: input.defer,
    }
    const headers = mcpRowsToRecord(input.headers)
    if (headers) config.headers = headers
    if (timeout !== undefined) config.timeout = timeout
    return config
  }

  const config: McpServerConfig = {
    type: "local",
    command: parseMcpCommand(input.command),
    enabled: input.enabled,
    defer: input.defer,
  }
  const environment = mcpRowsToRecord(input.environment)
  if (environment) config.environment = environment
  if (timeout !== undefined) config.timeout = timeout
  return config
}
