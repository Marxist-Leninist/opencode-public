import type { Event } from "@opencode-ai/sdk/v2/client"

type RuntimeEvent =
  | { type: "server.heartbeat"; properties: Record<string, unknown> }
  | { type: `config.${string}`; properties?: unknown }
  | { type: "provider.auth.updated"; properties: { providerID: string } }

export type BackendEvent = Event | RuntimeEvent

export function isSdkEvent(event: BackendEvent): event is Event {
  if (event.type === "server.heartbeat") return false
  if (event.type.startsWith("config.")) return false
  if (event.type.startsWith("provider.")) return false
  return true
}
