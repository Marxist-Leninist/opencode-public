import type { Event } from "@opencode-ai/sdk/v2/client"

type RuntimeEvent =
  | { type: `config.${string}`; properties?: unknown }

export type BackendEvent = Event | RuntimeEvent

export function isSdkEvent(event: BackendEvent): event is Event {
  if (event.type.startsWith("config.")) return false
  return true
}
