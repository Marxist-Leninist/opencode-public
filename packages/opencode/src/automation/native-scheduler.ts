// In-process native scheduler for SG OpenCode automations.
//
// Replaces the dependency on Windows Task Scheduler (schtasks /Create + wscript +
// .vbs + .cmd chain) with a simple polling timer that lives inside the SG OpenCode
// sidecar process. Pros:
//
// * No OS scheduler drift — pause/disable is instantaneous and atomic with the
//   definition file. There is no second source of truth that can disagree.
// * Cross-platform — runs on Windows, macOS, Linux without any
//   platform-specific rigging.
// * No Notepad pop-ups or shell windows. We spawn the runner .cmd directly with
//   `windowsHide: true, detached: true`, so the only thing the user ever sees is
//   the produced log file (and any session created by the runner itself).
// * Tests no longer leak real Windows tasks. The previous design installed real
//   schtasks entries from inside test runs; the native path does no OS calls.
//
// Trade-off: timers only tick while SG OpenCode is running. We persist a
// `last_fired_at` per automation and on startup the scheduler will catch up on
// any miss-window that elapsed while the app was closed (capped to one make-up
// fire per automation, so we do not flood the model on first boot after a long
// downtime).

import * as childProcess from "node:child_process"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { Log } from "@/util"
import {
  AutomationStore,
  type AutomationDefinition,
} from "@/tool/automation"

const log = Log.create({ service: "automation.native-scheduler" })

const POLL_INTERVAL_MS = 15_000 // re-read definitions + check fires every 15s
const MIN_FIRE_GAP_MS = 30_000 // never fire the same automation twice within 30s
const STATE_FILE_NAME = "native-scheduler.json"

type LastFireMap = Record<string, number> // id -> ms epoch of last completed fire

let started = false
let timer: NodeJS.Timeout | undefined
const inflight = new Set<string>() // ids currently being fired

function nativeMode(): boolean {
  const flag = (process.env.OPENCODE_SG_NATIVE_SCHEDULER ?? "true").toLowerCase()
  return flag !== "false" && flag !== "0" && flag !== "no" && flag !== "off"
}

function statePath(): string {
  return path.join(AutomationStore.dirs().root, STATE_FILE_NAME)
}

async function loadLastFires(): Promise<LastFireMap> {
  try {
    const raw = await fs.readFile(statePath(), "utf8")
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === "object") return parsed as LastFireMap
  } catch {}
  return {}
}

async function writeLastFires(map: LastFireMap): Promise<void> {
  try {
    await fs.mkdir(path.dirname(statePath()), { recursive: true })
    await fs.writeFile(statePath(), JSON.stringify(map, null, 2), "utf8")
  } catch (err) {
    log.warn("failed to persist scheduler state", { err: String(err) })
  }
}

// Compute the interval (in ms) at which a definition should fire, OR the next
// concrete absolute fire time. For every_minutes/hourly we return an interval;
// for daily/weekly we return the next-fire timestamp (which gets re-computed
// each tick).
function dueAt(def: AutomationDefinition, lastFiredAt: number, now: number): number | undefined {
  if (def.schedule === "every_minutes") {
    const minutes = Math.max(1, def.interval_minutes ?? 1)
    return lastFiredAt + minutes * 60_000
  }
  if (def.schedule === "hourly") {
    const hours = Math.max(1, def.interval_minutes ?? 1)
    return lastFiredAt + hours * 60 * 60_000
  }
  if (def.schedule === "daily") {
    return nextDailyFire(def.time ?? "09:00", now)
  }
  if (def.schedule === "weekly") {
    return nextWeeklyFire(def.days_of_week, def.time ?? "09:00", now)
  }
  return undefined
}

function parseHHMM(time: string): { hh: number; mm: number } {
  const m = /^(\d{1,2}):(\d{2})$/.exec(time.trim())
  if (!m) return { hh: 9, mm: 0 }
  return { hh: Math.min(23, Math.max(0, parseInt(m[1], 10))), mm: Math.min(59, Math.max(0, parseInt(m[2], 10))) }
}

function nextDailyFire(time: string, now: number): number {
  const { hh, mm } = parseHHMM(time)
  const today = new Date(now)
  today.setHours(hh, mm, 0, 0)
  if (today.getTime() <= now) today.setDate(today.getDate() + 1)
  return today.getTime()
}

const WEEKDAY_INDEX: Record<string, number> = {
  SUN: 0,
  MON: 1,
  TUE: 2,
  WED: 3,
  THU: 4,
  FRI: 5,
  SAT: 6,
}

function nextWeeklyFire(days: ReadonlyArray<string> | undefined, time: string, now: number): number {
  const allowed = (days && days.length > 0 ? days : Object.keys(WEEKDAY_INDEX)).map((d) => WEEKDAY_INDEX[d] ?? -1).filter(
    (n) => n >= 0,
  )
  if (allowed.length === 0) return nextDailyFire(time, now)
  const { hh, mm } = parseHHMM(time)
  for (let dayOffset = 0; dayOffset < 8; dayOffset++) {
    const cand = new Date(now)
    cand.setDate(cand.getDate() + dayOffset)
    cand.setHours(hh, mm, 0, 0)
    if (cand.getTime() <= now) continue
    if (!allowed.includes(cand.getDay())) continue
    return cand.getTime()
  }
  return nextDailyFire(time, now)
}

// Fire a runner. We deliberately spawn the .cmd directly rather than going
// through wscript or cmd.exe; `windowsHide: true` keeps it console-less and
// `detached: true` plus `unref()` keeps the parent free to keep ticking.
async function fire(def: AutomationDefinition): Promise<void> {
  if (!def.script_path) {
    log.warn("automation has no script_path", { id: def.id })
    return
  }
  try {
    await fs.access(def.script_path)
  } catch {
    log.warn("automation script missing — skipping", { id: def.id, script: def.script_path })
    return
  }
  return new Promise((resolve) => {
    try {
      const child = childProcess.spawn(def.script_path, [], {
        cwd: def.working_directory || process.cwd(),
        windowsHide: true,
        detached: true,
        stdio: "ignore",
        env: {
          ...process.env,
          OPENCODE_SG_AUTOMATION_RUN: "1",
          OPENCODE_SG_AUTOMATION_ID: def.id,
          // Force-allow every permission. Automations have no human watcher
          // and must never block on an "Allow / Deny?" prompt. The bypass
          // engine recognises OPENCODE_SG_AUTOMATION_RUN=1 as an unconditional
          // override on top of OPENCODE_SG_PERMISSION_MODE.
          OPENCODE_SG_PERMISSION_MODE: "allow",
        },
      })
      child.on("error", (err) => {
        log.warn("automation runner spawn error", { id: def.id, err: String(err) })
      })
      child.unref()
      resolve()
    } catch (err) {
      log.warn("automation fire failed", { id: def.id, err: String(err) })
      resolve()
    }
  })
}

async function tick(state: { lastFires: LastFireMap }): Promise<void> {
  let defs: AutomationDefinition[]
  try {
    defs = await AutomationStore.list()
  } catch (err) {
    log.warn("native-scheduler: failed to list definitions", { err: String(err) })
    return
  }
  const now = Date.now()
  let dirty = false

  for (const def of defs) {
    if (!def.enabled) continue
    if (inflight.has(def.id)) continue
    const last = state.lastFires[def.id] ?? 0
    if (now - last < MIN_FIRE_GAP_MS) continue
    const due = dueAt(def, last || now - 1, now)
    if (due === undefined) continue
    if (due > now) continue

    inflight.add(def.id)
    try {
      log.info("native-scheduler: firing automation", { id: def.id, schedule: def.schedule })
      await fire(def)
      state.lastFires[def.id] = now
      dirty = true
    } finally {
      // Release inflight after a small delay so very fast-completing runners
      // do not double-fire on the immediately-next tick if their .cmd exits
      // before we record last_fired.
      setTimeout(() => inflight.delete(def.id), 5_000)
    }
  }

  if (dirty) {
    await writeLastFires(state.lastFires)
  }
}

export async function start(): Promise<void> {
  if (started) return
  started = true
  if (!nativeMode()) {
    log.info("native-scheduler disabled by OPENCODE_SG_NATIVE_SCHEDULER")
    return
  }
  const state = { lastFires: await loadLastFires() }
  log.info("native-scheduler starting", {
    poll_ms: POLL_INTERVAL_MS,
    state_path: statePath(),
    known_automations: Object.keys(state.lastFires).length,
  })
  // Run an immediate tick on boot, then on a steady cadence.
  void tick(state).catch(() => undefined)
  timer = setInterval(() => {
    void tick(state).catch((err) => {
      log.warn("native-scheduler tick error", { err: String(err) })
    })
  }, POLL_INTERVAL_MS)
  // Keep the timer from preventing process shutdown.
  if (typeof timer.unref === "function") timer.unref()
}

export function stop(): void {
  if (timer) {
    clearInterval(timer)
    timer = undefined
  }
  started = false
}

export const __testing = {
  dueAt,
  nextDailyFire,
  nextWeeklyFire,
  parseHHMM,
}
