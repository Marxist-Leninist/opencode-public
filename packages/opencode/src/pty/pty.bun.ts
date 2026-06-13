import { spawn as create } from "bun-pty"
import type { Opts, Proc } from "./pty"

export type { Disp, Exit, Opts, Proc } from "./pty"

function ignoreKillError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  if (/ChildProcess\.kill|ESRCH|no such process|not found|not running|already exited/i.test(message)) return
  throw error
}

export function spawn(file: string, args: string[], opts: Opts): Proc {
  const pty = create(file, args, opts)
  return {
    pid: pty.pid,
    onData(listener) {
      return pty.onData(listener)
    },
    onExit(listener) {
      return pty.onExit(listener)
    },
    write(data) {
      pty.write(data)
    },
    resize(cols, rows) {
      pty.resize(cols, rows)
    },
    kill(signal) {
      try {
        pty.kill(signal)
      } catch (error) {
        ignoreKillError(error)
      }
    },
  }
}
