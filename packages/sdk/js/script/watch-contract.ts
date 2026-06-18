#!/usr/bin/env bun
import { watch } from "node:fs"
import path from "node:path"

import { repoRoot, syncIfNeeded } from "./sync-if-needed"

const sourceRoot = path.join(repoRoot, "packages", "opencode", "src")
let timer: ReturnType<typeof setTimeout> | undefined
let running = false
let pending = false

await syncIfNeeded()

function schedule() {
  if (timer) clearTimeout(timer)
  timer = setTimeout(run, 250)
}

async function run() {
  if (running) {
    pending = true
    return
  }

  running = true
  try {
    await syncIfNeeded()
  } catch (err) {
    console.error(err instanceof Error ? err.stack || err.message : String(err))
  } finally {
    running = false
    if (pending) {
      pending = false
      schedule()
    }
  }
}

try {
  watch(sourceRoot, { recursive: true }, (_event, filename) => {
    if (filename && !filename.toString().endsWith(".ts")) return
    schedule()
  })
  console.log(`backend sdk contract watcher active: ${sourceRoot}`)
} catch (err) {
  console.warn(
    `recursive watch unavailable (${err instanceof Error ? err.message : String(err)}); polling backend contract`,
  )
  setInterval(() => void syncIfNeeded(), 2_000)
}

await new Promise(() => {})
