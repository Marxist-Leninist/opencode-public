/** @ts-expect-error */
import * as pty from "@lydell/node-pty"
import type { Opts, Proc } from "./pty"

export type { Disp, Exit, Opts, Proc } from "./pty"

function ignoreKillError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  if (/ChildProcess\.kill|ESRCH|no such process|not found|not running|already exited/i.test(message)) return
  throw error
}

export function spawn(file: string, args: string[], opts: Opts): Proc {
  const proc = pty.spawn(file, args, opts)
  return {
    pid: proc.pid,
    onData(listener) {
      return proc.onData(listener)
    },
    onExit(listener) {
      return proc.onExit(listener)
    },
    write(data) {
      proc.write(data)
    },
    resize(cols, rows) {
      proc.resize(cols, rows)
    },
    kill(signal) {
      try {
        proc.kill(signal)
      } catch (error) {
        ignoreKillError(error)
      }
    },
  }
}
