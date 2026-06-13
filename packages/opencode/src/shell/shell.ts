import { Flag } from "@opencode-ai/core/flag/flag"
import { lazy } from "@/util/lazy"
import { Filesystem } from "@/util"
import { which } from "@/util/which"
import path from "path"
import { spawn, type ChildProcess } from "child_process"
import { setTimeout as sleep } from "node:timers/promises"

const SIGKILL_TIMEOUT_MS = 200
const TASKKILL_TIMEOUT_MS = 2_000

const BLACKLIST = new Set(["fish", "nu"])
const LOGIN = new Set(["bash", "dash", "fish", "ksh", "sh", "zsh"])
const POSIX = new Set(["bash", "dash", "ksh", "sh", "zsh"])

function runTaskkill(pid: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const done = (ok: boolean) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve(ok)
    }
    let killer: ReturnType<typeof spawn> | undefined
    try {
      killer = spawn("taskkill", ["/pid", String(pid), "/f", "/t"], {
        stdio: "ignore",
        windowsHide: true,
        detached: true,
      })
      // Detach so EPERM from killing elevated children doesn't bubble up
      killer.unref()
    } catch {
      done(false)
      return
    }
    timer = setTimeout(() => {
      try {
        killer?.kill()
      } catch {
        // taskkill already exited.
      }
      done(false)
    }, TASKKILL_TIMEOUT_MS)
    killer?.once("exit", (code) => done(code === 0))
    killer?.once("error", () => done(false))
  })
}

export async function killPidTree(pid: number | undefined, opts?: { exited?: () => boolean }): Promise<void> {
  if (!pid || opts?.exited?.()) return

  if (process.platform === "win32") {
    const ok = await runTaskkill(pid)
    if (!ok && !opts?.exited?.()) {
      try {
        process.kill(pid)
      } catch {
        // Process already exited or cannot be signaled directly.
      }
    }
    return
  }

  try {
    process.kill(-pid, "SIGTERM")
    await sleep(SIGKILL_TIMEOUT_MS)
    if (!opts?.exited?.()) {
      process.kill(-pid, "SIGKILL")
    }
  } catch (_e) {
    try {
      process.kill(pid, "SIGTERM")
    } catch {
      return
    }
    await sleep(SIGKILL_TIMEOUT_MS)
    if (!opts?.exited?.()) {
      try {
        process.kill(pid, "SIGKILL")
      } catch {
        // Process already exited.
      }
    }
  }
}

export async function killTree(proc: ChildProcess, opts?: { exited?: () => boolean }): Promise<void> {
  const pid = proc.pid
  if (!pid || opts?.exited?.()) return

  if (process.platform === "win32") {
    await killPidTree(pid, opts)
    return
  }

  try {
    process.kill(-pid, "SIGTERM")
    await sleep(SIGKILL_TIMEOUT_MS)
    if (!opts?.exited?.()) {
      process.kill(-pid, "SIGKILL")
    }
  } catch (_e) {
    try {
      proc.kill("SIGTERM")
    } catch {
      return
    }
    await sleep(SIGKILL_TIMEOUT_MS)
    if (!opts?.exited?.()) {
      try {
        proc.kill("SIGKILL")
      } catch {
        // Process already exited.
      }
    }
  }
}

function full(file: string) {
  if (process.platform !== "win32") return file
  const shell = Filesystem.windowsPath(file)
  if (path.win32.dirname(shell) !== ".") {
    if (shell.startsWith("/") && name(shell) === "bash") return gitbash() || shell
    return shell
  }
  return which(shell) || shell
}

function pick() {
  const pwsh = which("pwsh.exe")
  if (pwsh) return pwsh
  const powershell = which("powershell.exe")
  if (powershell) return powershell
}

function select(file: string | undefined, opts?: { acceptable?: boolean }) {
  if (file && (!opts?.acceptable || !BLACKLIST.has(name(file)))) return full(file)
  if (process.platform === "win32") {
    const shell = pick()
    if (shell) return shell
  }
  return fallback()
}

export function gitbash() {
  if (process.platform !== "win32") return
  if (Flag.OPENCODE_GIT_BASH_PATH) return Flag.OPENCODE_GIT_BASH_PATH
  const git = which("git")
  if (!git) return
  const file = path.join(git, "..", "..", "bin", "bash.exe")
  if (Filesystem.stat(file)?.size) return file
}

function fallback() {
  if (process.platform === "win32") {
    const file = gitbash()
    if (file) return file
    return process.env.COMSPEC || "cmd.exe"
  }
  if (process.platform === "darwin") return "/bin/zsh"
  const bash = which("bash")
  if (bash) return bash
  return "/bin/sh"
}

export function name(file: string) {
  if (process.platform === "win32") return path.win32.parse(Filesystem.windowsPath(file)).name.toLowerCase()
  return path.basename(file).toLowerCase()
}

export function login(file: string) {
  return LOGIN.has(name(file))
}

export function posix(file: string) {
  return POSIX.has(name(file))
}

export const preferred = lazy(() => select(process.env.SHELL))

export const acceptable = lazy(() => select(process.env.SHELL, { acceptable: true }))

export * as Shell from "./shell"
