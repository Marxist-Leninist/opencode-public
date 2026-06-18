#!/usr/bin/env bun
// Coupled dev loop: renderer HMR (electron-vite) + backend rebuild-on-save.
//
// The decoupling this fixes: `electron-vite dev` externalizes the backend to the
// prebuilt ../opencode/dist/node/node.js (see electron.vite.config.ts). Nothing
// rebuilt that blob when you edited packages/opencode/src, so backend changes
// never reached the running app — you'd edit the backend and see nothing change.
//
// Here we watch the backend source and rebuild the blob (incrementally, skipping
// the models.dev network fetch) on save. electron.vite.config.ts adds node.js as
// a watched file, so electron-vite then restarts Electron with the fresh backend.
// Net effect: edit anything in packages/opencode/src and the app reloads with it,
// exactly like the renderer already does.
import { spawn } from "node:child_process"
import { watch } from "node:fs"
import { fileURLToPath } from "node:url"
import path from "node:path"
import { $ } from "bun"

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, "..") // packages/desktop-electron
const backendDir = path.resolve(root, "../opencode")
const backendSrc = path.join(backendDir, "src")

const C = { m: "\x1b[35m", g: "\x1b[32m", r: "\x1b[31m", dim: "\x1b[2m", x: "\x1b[0m" }
const log = (msg: string) => process.stdout.write(`${C.m}[dev:coupled]${C.x} ${msg}\n`)

// 1) renderer HMR + main process (electron-vite owns these and restarts Electron
//    when node.js changes, via the addWatchFile in electron.vite.config.ts).
const ev = spawn("electron-vite", ["dev"], { stdio: "inherit", shell: true, cwd: root, env: process.env })
ev.on("exit", (code) => process.exit(code ?? 0))

// 2) backend watcher → incremental rebuild of ../opencode/dist/node/node.js
let building = false
let pending = false
let timer: ReturnType<typeof setTimeout> | undefined

async function rebuild(reason: string) {
  if (building) {
    pending = true
    return
  }
  building = true
  const started = Date.now()
  try {
    log(`backend ${C.dim}${reason}${C.x} → rebuilding…`)
    await $`bun script/build-node.ts --skip-generate`.cwd(backendDir).quiet()
    log(`${C.g}backend rebuilt in ${Date.now() - started}ms${C.x} → app reloading`)
  } catch (err) {
    log(`${C.r}backend build FAILED${C.x} (app keeps the previous backend):\n${err}`)
  } finally {
    building = false
    if (pending) {
      pending = false
      void rebuild("queued change")
    }
  }
}

watch(backendSrc, { recursive: true }, (_event, filename) => {
  if (!filename) return
  const f = filename.toString()
  if (f.includes(`dist${path.sep}`) || f.includes("node_modules")) return
  if (!/\.(ts|tsx|txt|sql|json)$/.test(f)) return
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => void rebuild(`change: ${f}`), 150)
})

log(`watching ${C.dim}../opencode/src${C.x} — backend edits now reload the app (like the renderer)`)
process.on("SIGINT", () => {
  try {
    ev.kill()
  } catch {}
  process.exit(0)
})
