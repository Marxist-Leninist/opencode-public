#!/usr/bin/env bun
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const reuse = process.argv.includes("--reuse")
const bun = process.execPath
const builder = path.join(root, "node_modules", ".bin", process.platform === "win32" ? "electron-builder.exe" : "electron-builder")
const env = {
  ...process.env,
  OPENCODE_FAST_BUILD: "true",
  OPENCODE_DIR_TARGET: "true",
  CSC_IDENTITY_AUTO_DISCOVERY: "false",
  ELECTRON_BUILDER_DISABLE_SIGNING: "true",
}

if (!reuse) await run("build:fast", [bun, "run", "build:fast"], readPositiveIntEnv("OPENCODE_BUILD_TIMEOUT_MS", 10 * 60 * 1000))
await run(
  "electron-builder --dir",
  [builder, "--win", "--dir", "--config", "electron-builder.config.ts"],
  readPositiveIntEnv("OPENCODE_PACKAGE_TIMEOUT_MS", 4 * 60 * 1000),
)

async function run(name: string, command: string[], timeoutMs: number) {
  console.log(`[package-win-dir] ${name} starting`)
  const child = Bun.spawn(command, {
    cwd: root,
    env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  })

  const code = await waitWithTimeout(child, timeoutMs).catch(async (error) => {
    console.error(`[package-win-dir] ${name} timed out after ${timeoutMs}ms`)
    await killProcessTree(child.pid)
    throw error
  })

  if (code === 0) {
    console.log(`[package-win-dir] ${name} finished`)
    return
  }

  throw new Error(`${name} exited with code ${code}`)
}

async function waitWithTimeout(child: Bun.Subprocess, timeoutMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      child.exited,
      new Promise<number>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function killProcessTree(pid: number) {
  if (process.platform === "win32") {
    await Bun.spawn(["taskkill", "/PID", String(pid), "/T", "/F"], {
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
    }).exited
    return
  }

  try {
    process.kill(-pid, "SIGTERM")
  } catch {
    try {
      process.kill(pid, "SIGTERM")
    } catch {}
  }
}

function readPositiveIntEnv(name: string, fallback: number) {
  const raw = process.env[name]
  if (!raw) return fallback
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}
