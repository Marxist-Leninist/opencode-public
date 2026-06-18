import type { Fiber } from "effect"

// In-process registry of background subagent tasks (task(background: true)).
// Single server process, so a module-level Map is the shared store across the
// spawning `task` tool and the `task_status` / `task_result` collection tools.
// Entries are keyed by the child session id (which is the task_id handed back
// to the model). The forked fiber writes the result/error here on completion.

export type BackgroundStatus = "running" | "done" | "error" | "cancelled"

export interface BackgroundEntry {
  taskID: string
  parentSessionID: string
  description: string
  subagentType: string
  status: BackgroundStatus
  result?: string
  error?: string
  startedAt: number
  completedAt?: number
  // Whether a completion has already been surfaced to the parent agent (nudge).
  notified: boolean
  fiber?: Fiber.Fiber<unknown, unknown>
}

const registry = new Map<string, BackgroundEntry>()

export const BackgroundTask = {
  register(entry: Omit<BackgroundEntry, "notified" | "fiber">) {
    registry.set(entry.taskID, { ...entry, notified: false })
  },

  setFiber(taskID: string, fiber: Fiber.Fiber<unknown, unknown>) {
    const e = registry.get(taskID)
    if (e) e.fiber = fiber
  },

  complete(taskID: string, result: string) {
    const e = registry.get(taskID)
    if (!e || e.status !== "running") return
    e.status = "done"
    e.result = result
    e.completedAt = Date.now()
  },

  fail(taskID: string, error: string) {
    const e = registry.get(taskID)
    if (!e || e.status !== "running") return
    e.status = "error"
    e.error = error
    e.completedAt = Date.now()
  },

  markCancelled(taskID: string) {
    const e = registry.get(taskID)
    if (!e || e.status !== "running") return
    e.status = "cancelled"
    e.completedAt = Date.now()
  },

  markNotified(taskID: string) {
    const e = registry.get(taskID)
    if (e) e.notified = true
  },

  get(taskID: string) {
    return registry.get(taskID)
  },

  list(parentSessionID: string) {
    return [...registry.values()].filter((e) => e.parentSessionID === parentSessionID)
  },

  // Finished-but-not-yet-announced tasks for a parent session. Marks them
  // notified as it returns them — used to nudge the parent agent that
  // background work it started has completed (consumed by the prompt loop).
  drainCompleted(parentSessionID: string) {
    const out: BackgroundEntry[] = []
    for (const e of registry.values()) {
      if (e.parentSessionID !== parentSessionID) continue
      if (e.status === "running" || e.notified) continue
      e.notified = true
      out.push(e)
    }
    return out
  },
}
