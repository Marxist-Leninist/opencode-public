import { Schema } from "effect"
import os from "os"
import { createWriteStream } from "node:fs"
import { writeFile } from "node:fs/promises"
import { spawn as nodeSpawn } from "node:child_process"
import * as Tool from "./tool"
import path from "path"
import DESCRIPTION from "./bash.txt"
import { Log } from "../util"
import { Instance } from "../project/instance"
import { lazy } from "@/util/lazy"
import { Language, type Node } from "web-tree-sitter"

import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { fileURLToPath } from "url"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Shell } from "@/shell/shell"
import { killPidTree } from "@/shell/shell"

import { BashArity } from "@/permission/arity"
import * as Truncate from "./truncate"
import { Plugin } from "@/plugin"
import { Effect, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { InstanceState } from "@/effect"

const MAX_METADATA_LENGTH = 30_000
const DEFAULT_TIMEOUT = Flag.OPENCODE_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS || 10 * 60 * 1000
const DEFAULT_BACKGROUND_AFTER = (() => {
  const raw = process.env.OPENCODE_EXPERIMENTAL_BASH_AUTO_BACKGROUND_MS
  if (raw === undefined || raw === "") return 45_000
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 45_000
})()
const PS = new Set(["powershell", "pwsh"])
const CWD = new Set(["cd", "push-location", "set-location"])
const FILES = new Set([
  ...CWD,
  "rm",
  "cp",
  "mv",
  "mkdir",
  "touch",
  "chmod",
  "chown",
  "cat",
  // Leave PowerShell aliases out for now. Common ones like cat/cp/mv/rm/mkdir
  // already hit the entries above, and alias normalization should happen in one
  // place later so we do not risk double-prompting.
  "get-content",
  "set-content",
  "add-content",
  "copy-item",
  "move-item",
  "remove-item",
  "new-item",
  "rename-item",
])
const FLAGS = new Set(["-destination", "-literalpath", "-path"])
const SWITCHES = new Set(["-confirm", "-debug", "-force", "-nonewline", "-recurse", "-verbose", "-whatif"])

export const Parameters = Schema.Struct({
  command: Schema.String.annotate({ description: "The command to execute" }),
  timeout: Schema.optional(Schema.Number).annotate({
    description: `Optional timeout in milliseconds. Default ${DEFAULT_TIMEOUT}; use larger values for builds, tests, installs, packaging, deploys, and other long-running commands.`,
  }),
  background_after: Schema.optional(Schema.Number).annotate({
    description: `Optional milliseconds to wait before detaching a still-running command into a background job. Default ${DEFAULT_BACKGROUND_AFTER}. Use 0 to wait in the foreground until exit or timeout.`,
  }),
  workdir: Schema.optional(Schema.String).annotate({
    description: `The working directory to run the command in. Defaults to the current directory. Use this instead of 'cd' commands.`,
  }),
  description: Schema.String.annotate({
    description:
      "Clear, concise description of what this command does in 5-10 words. Examples:\nInput: ls\nOutput: Lists files in current directory\n\nInput: git status\nOutput: Shows working tree status\n\nInput: npm install\nOutput: Installs package dependencies\n\nInput: mkdir foo\nOutput: Creates directory 'foo'",
  }),
})

type Part = {
  type: string
  text: string
}

type Scan = {
  dirs: Set<string>
  patterns: Set<string>
  always: Set<string>
}

type Chunk = {
  text: string
  size: number
}

type BashMetadata = {
  output: string
  description: string
  exit?: number | null
  truncated: boolean
  outputPath?: string
  backgrounded?: boolean
  backgroundJobID?: string
  pid?: number
  statusPath?: string
  elapsed_ms?: number
  background_after_ms?: number
}

type BackgroundRunResult =
  | { kind: "exit"; code: number | null; signal: NodeJS.Signals | null }
  | { kind: "background" }
  | { kind: "abort" }
  | { kind: "timeout" }
  | { kind: "error"; error: string }

export const log = Log.create({ service: "bash-tool" })

const resolveWasm = (asset: string) => {
  if (asset.startsWith("file://")) return fileURLToPath(asset)
  if (asset.startsWith("/") || /^[a-z]:/i.test(asset)) return asset
  const url = new URL(asset, import.meta.url)
  return fileURLToPath(url)
}

function parts(node: Node) {
  const out: Part[] = []
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)
    if (!child) continue
    if (child.type === "command_elements") {
      for (let j = 0; j < child.childCount; j++) {
        const item = child.child(j)
        if (!item || item.type === "command_argument_sep" || item.type === "redirection") continue
        out.push({ type: item.type, text: item.text })
      }
      continue
    }
    if (
      child.type !== "command_name" &&
      child.type !== "command_name_expr" &&
      child.type !== "word" &&
      child.type !== "string" &&
      child.type !== "raw_string" &&
      child.type !== "concatenation"
    ) {
      continue
    }
    out.push({ type: child.type, text: child.text })
  }
  return out
}

function source(node: Node) {
  return (node.parent?.type === "redirected_statement" ? node.parent.text : node.text).trim()
}

function commands(node: Node) {
  return node.descendantsOfType("command").filter((child): child is Node => Boolean(child))
}

function unquote(text: string) {
  if (text.length < 2) return text
  const first = text[0]
  const last = text[text.length - 1]
  if ((first === '"' || first === "'") && first === last) return text.slice(1, -1)
  return text
}

function home(text: string) {
  if (text === "~") return os.homedir()
  if (text.startsWith("~/") || text.startsWith("~\\")) return path.join(os.homedir(), text.slice(2))
  return text
}

function envValue(key: string) {
  if (process.platform !== "win32") return process.env[key]
  const name = Object.keys(process.env).find((item) => item.toLowerCase() === key.toLowerCase())
  return name ? process.env[name] : undefined
}

function auto(key: string, cwd: string, shell: string) {
  const name = key.toUpperCase()
  if (name === "HOME") return os.homedir()
  if (name === "PWD") return cwd
  if (name === "PSHOME") return path.dirname(shell)
}

function expand(text: string, cwd: string, shell: string) {
  const out = unquote(text)
    .replace(/\$\{env:([^}]+)\}/gi, (_, key: string) => envValue(key) || "")
    .replace(/\$env:([A-Za-z_][A-Za-z0-9_]*)/gi, (_, key: string) => envValue(key) || "")
    .replace(/\$(HOME|PWD|PSHOME)(?=$|[\\/])/gi, (_, key: string) => auto(key, cwd, shell) || "")
  return home(out)
}

function provider(text: string) {
  const match = text.match(/^([A-Za-z]+)::(.*)$/)
  if (match) {
    if (match[1].toLowerCase() !== "filesystem") return
    return match[2]
  }
  const prefix = text.match(/^([A-Za-z]+):(.*)$/)
  if (!prefix) return text
  if (prefix[1].length === 1) return text
  return
}

function dynamic(text: string, ps: boolean) {
  if (text.startsWith("(") || text.startsWith("@(")) return true
  if (text.includes("$(") || text.includes("${") || text.includes("`")) return true
  if (ps) return /\$(?!env:)/i.test(text)
  return text.includes("$")
}

function prefix(text: string) {
  const match = /[?*[]/.exec(text)
  if (!match) return text
  if (match.index === 0) return
  return text.slice(0, match.index)
}

function pathArgs(list: Part[], ps: boolean) {
  if (!ps) {
    return list
      .slice(1)
      .filter((item) => !item.text.startsWith("-") && !(list[0]?.text === "chmod" && item.text.startsWith("+")))
      .map((item) => item.text)
  }

  const out: string[] = []
  let want = false
  for (const item of list.slice(1)) {
    if (want) {
      out.push(item.text)
      want = false
      continue
    }
    if (item.type === "command_parameter") {
      const flag = item.text.toLowerCase()
      if (SWITCHES.has(flag)) continue
      want = FLAGS.has(flag)
      continue
    }
    out.push(item.text)
  }
  return out
}

function preview(text: string) {
  if (text.length <= MAX_METADATA_LENGTH) return text
  return "...\n\n" + text.slice(-MAX_METADATA_LENGTH)
}

function tail(text: string, maxLines: number, maxBytes: number) {
  const lines = text.split("\n")
  if (lines.length <= maxLines && Buffer.byteLength(text, "utf-8") <= maxBytes) {
    return {
      text,
      cut: false,
    }
  }

  const out: string[] = []
  let bytes = 0
  for (let i = lines.length - 1; i >= 0 && out.length < maxLines; i--) {
    const size = Buffer.byteLength(lines[i], "utf-8") + (out.length > 0 ? 1 : 0)
    if (bytes + size > maxBytes) {
      if (out.length === 0) {
        const buf = Buffer.from(lines[i], "utf-8")
        let start = buf.length - maxBytes
        if (start < 0) start = 0
        while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++
        out.unshift(buf.subarray(start).toString("utf-8"))
      }
      break
    }
    out.unshift(lines[i])
    bytes += size
  }
  return {
    text: out.join("\n"),
    cut: true,
  }
}

const parse = Effect.fn("BashTool.parse")(function* (command: string, ps: boolean) {
  const tree = yield* Effect.promise(() => parser().then((p) => (ps ? p.ps : p.bash).parse(command)))
  if (!tree) throw new Error("Failed to parse command")
  return tree.rootNode
})

const ask = Effect.fn("BashTool.ask")(function* (ctx: Tool.Context, scan: Scan) {
  if (scan.dirs.size > 0) {
    const globs = Array.from(scan.dirs).map((dir) => {
      if (process.platform === "win32") return AppFileSystem.normalizePathPattern(path.join(dir, "*"))
      return path.join(dir, "*")
    })
    yield* ctx.ask({
      permission: "external_directory",
      patterns: globs,
      always: globs,
      metadata: {},
    })
  }

  if (scan.patterns.size === 0) return
  yield* ctx.ask({
    permission: "bash",
    patterns: Array.from(scan.patterns),
    always: Array.from(scan.always),
    metadata: {},
  })
})

function cmd(shell: string, name: string, command: string, cwd: string, env: NodeJS.ProcessEnv) {
  if (process.platform === "win32" && PS.has(name)) {
    return ChildProcess.make(shell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], {
      cwd,
      env,
      stdin: "ignore",
      detached: false,
    })
  }

  return ChildProcess.make(command, [], {
    shell,
    cwd,
    env,
    stdin: "ignore",
    detached: process.platform !== "win32",
  })
}

function bgcmd(shell: string, name: string, command: string, cwd: string, env: NodeJS.ProcessEnv) {
  if (process.platform === "win32" && PS.has(name)) {
    return nodeSpawn(shell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], {
      cwd,
      env,
      windowsHide: true,
      detached: false,
      stdio: ["ignore", "pipe", "pipe"],
    })
  }

  return nodeSpawn(command, [], {
    shell,
    cwd,
    env,
    windowsHide: true,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  })
}

function jobID() {
  return `bash_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

const parser = lazy(async () => {
  const { Parser } = await import("web-tree-sitter")
  const { default: treeWasm } = await import("web-tree-sitter/tree-sitter.wasm" as string, {
    with: { type: "wasm" },
  })
  const treePath = resolveWasm(treeWasm)
  await Parser.init({
    locateFile() {
      return treePath
    },
  })
  const { default: bashWasm } = await import("tree-sitter-bash/tree-sitter-bash.wasm" as string, {
    with: { type: "wasm" },
  })
  const { default: psWasm } = await import("tree-sitter-powershell/tree-sitter-powershell.wasm" as string, {
    with: { type: "wasm" },
  })
  const bashPath = resolveWasm(bashWasm)
  const psPath = resolveWasm(psWasm)
  const [bashLanguage, psLanguage] = await Promise.all([Language.load(bashPath), Language.load(psPath)])
  const bash = new Parser()
  bash.setLanguage(bashLanguage)
  const ps = new Parser()
  ps.setLanguage(psLanguage)
  return { bash, ps }
})

// TODO: we may wanna rename this tool so it works better on other shells
export const BashTool = Tool.define(
  "bash",
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner
    const fs = yield* AppFileSystem.Service
    const trunc = yield* Truncate.Service
    const plugin = yield* Plugin.Service

    const cygpath = Effect.fn("BashTool.cygpath")(function* (shell: string, text: string) {
      const lines = yield* spawner
        .lines(ChildProcess.make(shell, ["-lc", 'cygpath -w -- "$1"', "_", text]))
        .pipe(Effect.catch(() => Effect.succeed([] as string[])))
      const file = lines[0]?.trim()
      if (!file) return
      return AppFileSystem.normalizePath(file)
    })

    const resolvePath = Effect.fn("BashTool.resolvePath")(function* (text: string, root: string, shell: string) {
      if (process.platform === "win32") {
        if (Shell.posix(shell) && text.startsWith("/") && AppFileSystem.windowsPath(text) === text) {
          const file = yield* cygpath(shell, text)
          if (file) return file
        }
        return AppFileSystem.normalizePath(path.resolve(root, AppFileSystem.windowsPath(text)))
      }
      return path.resolve(root, text)
    })

    const argPath = Effect.fn("BashTool.argPath")(function* (arg: string, cwd: string, ps: boolean, shell: string) {
      const text = ps ? expand(arg, cwd, shell) : home(unquote(arg))
      const file = text && prefix(text)
      if (!file || dynamic(file, ps)) return
      const next = ps ? provider(file) : file
      if (!next) return
      return yield* resolvePath(next, cwd, shell)
    })

    const collect = Effect.fn("BashTool.collect")(function* (root: Node, cwd: string, ps: boolean, shell: string) {
      const scan: Scan = {
        dirs: new Set<string>(),
        patterns: new Set<string>(),
        always: new Set<string>(),
      }

      for (const node of commands(root)) {
        const command = parts(node)
        const tokens = command.map((item) => item.text)
        const cmd = ps ? tokens[0]?.toLowerCase() : tokens[0]

        if (cmd && FILES.has(cmd)) {
          for (const arg of pathArgs(command, ps)) {
            const resolved = yield* argPath(arg, cwd, ps, shell)
            log.info("resolved path", { arg, resolved })
            if (!resolved || Instance.containsPath(resolved)) continue
            const dir = (yield* fs.isDir(resolved)) ? resolved : path.dirname(resolved)
            scan.dirs.add(dir)
          }
        }

        if (tokens.length && (!cmd || !CWD.has(cmd))) {
          scan.patterns.add(source(node))
          scan.always.add(BashArity.prefix(tokens).join(" ") + " *")
        }
      }

      return scan
    })

    const shellEnv = Effect.fn("BashTool.shellEnv")(function* (ctx: Tool.Context, cwd: string) {
      const extra = yield* plugin.trigger(
        "shell.env",
        { cwd, sessionID: ctx.sessionID, callID: ctx.callID },
        { env: {} },
      )
      return {
        ...process.env,
        ...extra.env,
      }
    })

    const runBackgroundable = Effect.fn("BashTool.runBackgroundable")(function* (
      input: {
        shell: string
        name: string
        command: string
        cwd: string
        env: NodeJS.ProcessEnv
        timeout: number
        backgroundAfter: number
        description: string
      },
      ctx: Tool.Context,
      limits: { maxLines: number; maxBytes: number },
      keep: number,
    ) {
      const id = jobID()
      const started = Date.now()
      const outputPath = yield* trunc.write("")
      const statusPath = `${outputPath}.status.json`
      const sink = createWriteStream(outputPath, { flags: "a" })
      const list: Chunk[] = []
      let last = ""
      let used = 0
      let cut = false
      let expired = false
      let aborted = false

      const child = bgcmd(input.shell, input.name, input.command, input.cwd, input.env)
      const exited = () => child.exitCode !== null || child.signalCode !== null
      const status = (state: string, extra: Record<string, unknown> = {}) =>
        writeFile(
          statusPath,
          JSON.stringify(
            {
              job_id: id,
              state,
              pid: child.pid,
              command: input.command,
              cwd: input.cwd,
              description: input.description,
              started_at: new Date(started).toISOString(),
              elapsed_ms: Date.now() - started,
              output_path: outputPath,
              status_path: statusPath,
              ...extra,
            },
            null,
            2,
          ),
          "utf-8",
        ).catch(() => {})

      const publish = () =>
        Effect.runPromise(
          ctx.metadata({
            metadata: {
              output: last,
              description: input.description,
              backgroundJobID: id,
              pid: child.pid,
              outputPath,
              statusPath,
            },
          }),
        ).catch(() => {})

      const append = (chunk: Buffer) => {
        const text = chunk.toString("utf-8")
        const size = Buffer.byteLength(text, "utf-8")
        list.push({ text, size })
        used += size
        while (used > keep && list.length > 1) {
          const item = list.shift()
          if (!item) break
          used -= item.size
          cut = true
        }
        last = preview(last + text)
        sink.write(text)
        publish()
      }

      child.stdout?.on("data", append)
      child.stderr?.on("data", append)
      void status("running")

      const result = yield* Effect.promise(
        () =>
          new Promise<BackgroundRunResult>((resolve) => {
            let settled = false
            const complete = (next: BackgroundRunResult) => {
              if (settled) return
              settled = true
              clearTimeout(backgroundTimer)
              if (next.kind !== "background") {
                clearTimeout(timeoutTimer)
                ctx.abort.removeEventListener("abort", onAbort)
              }
              resolve(next)
            }
            const finish = (code: number | null, signal: NodeJS.Signals | null) => {
              clearTimeout(backgroundTimer)
              clearTimeout(timeoutTimer)
              ctx.abort.removeEventListener("abort", onAbort)
              sink.end(() => {})
              void status("completed", {
                ended_at: new Date().toISOString(),
                exit_code: code,
                signal,
              })
              complete({ kind: "exit", code, signal })
            }
            const onAbort = () => {
              aborted = true
              void status("aborted", { ended_at: new Date().toISOString() })
              void killPidTree(child.pid, { exited })
              complete({ kind: "abort" })
            }
            const backgroundTimer = setTimeout(() => {
              void status("running", { backgrounded_at: new Date().toISOString() })
              complete({ kind: "background" })
            }, input.backgroundAfter)
            const timeoutTimer = setTimeout(() => {
              expired = true
              void status("timed_out", { ended_at: new Date().toISOString(), timeout_ms: input.timeout })
              void killPidTree(child.pid, { exited })
              complete({ kind: "timeout" })
            }, input.timeout + 100)

            ctx.abort.addEventListener("abort", onAbort, { once: true })
            child.once("error", (error) => {
              sink.end(() => {})
              void status("error", { ended_at: new Date().toISOString(), error: error.message })
              complete({ kind: "error", error: error.message })
            })
            child.once("close", finish)
          }),
      )

      const raw = list.map((item) => item.text).join("")
      const end = tail(raw, limits.maxLines, limits.maxBytes)
      if (end.cut) cut = true
      const outputTail = end.text || (result.kind === "background" ? "(no output yet)" : "(no output)")
      const common: { title: string; metadata: BashMetadata } = {
        title: input.description,
        metadata: {
          output: last || preview(outputTail),
          description: input.description,
          truncated: cut,
          ...(cut ? { outputPath } : {}),
        },
      }

      if (result.kind === "background") {
        return {
          ...common,
          metadata: {
            ...common.metadata,
            backgrounded: true,
            backgroundJobID: id,
            pid: child.pid,
            outputPath,
            statusPath,
            elapsed_ms: Date.now() - started,
            background_after_ms: input.backgroundAfter,
          },
          output:
            `Command is still running after ${input.backgroundAfter} ms, so OpenCode detached it and returned control to the agent.\n\n` +
            `Job id: ${id}\n` +
            `PID: ${child.pid ?? "unknown"}\n` +
            `Output log: ${outputPath}\n` +
            `Status file: ${statusPath}\n\n` +
            `Continue other work now. To monitor this job, use wait with until_pid_exit=${child.pid ?? "PID"}, read the status file, or read/grep the output log. To stop it, use the process tool kill action on the PID.\n\n` +
            `<bash_metadata>\nbackgrounded=true\nelapsed_ms=${Date.now() - started}\n</bash_metadata>\n\n` +
            outputTail,
        }
      }

      if (result.kind === "error") throw new Error(result.error)

      let output = outputTail
      if (cut) output = `...output truncated...\n\nFull output saved to: ${outputPath}\n\n` + output
      const meta: string[] = []
      if (expired || result.kind === "timeout") meta.push(`bash command timed out after ${input.timeout} ms.`)
      if (aborted || result.kind === "abort") meta.push("User aborted the command")
      if (meta.length > 0) output += "\n\n<bash_metadata>\n" + meta.join("\n") + "\n</bash_metadata>"

      return {
        ...common,
        metadata: {
          ...common.metadata,
          exit: result.kind === "exit" ? result.code : null,
          ...(cut ? { outputPath } : {}),
        },
        output,
      }
    })

    const run = Effect.fn("BashTool.run")(function* (
      input: {
        shell: string
        name: string
        command: string
        cwd: string
        env: NodeJS.ProcessEnv
        timeout: number
        backgroundAfter: number
        description: string
      },
      ctx: Tool.Context,
    ) {
      const limits = yield* trunc.limits()
      const keep = limits.maxBytes * 2
      let full = ""
      let last = ""
      const list: Chunk[] = []
      let used = 0
      let file = ""
      let sink: ReturnType<typeof createWriteStream> | undefined
      let cut = false
      let expired = false
      let aborted = false

      yield* ctx.metadata({
        metadata: {
          output: "",
          description: input.description,
        },
      })

      if (input.backgroundAfter > 0 && input.timeout > input.backgroundAfter) {
        return yield* runBackgroundable(input, ctx, limits, keep)
      }

      const code: number | null = yield* Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* spawner.spawn(cmd(input.shell, input.name, input.command, input.cwd, input.env))
          let exited = false

          yield* Effect.forkScoped(
            Stream.runForEach(Stream.decodeText(handle.all), (chunk) => {
              const size = Buffer.byteLength(chunk, "utf-8")
              list.push({ text: chunk, size })
              used += size
              while (used > keep && list.length > 1) {
                const item = list.shift()
                if (!item) break
                used -= item.size
                cut = true
              }

              last = preview(last + chunk)

              if (file) {
                sink?.write(chunk)
              } else {
                full += chunk
                if (Buffer.byteLength(full, "utf-8") > limits.maxBytes) {
                  return trunc.write(full).pipe(
                    Effect.andThen((next) =>
                      Effect.sync(() => {
                        file = next
                        cut = true
                        sink = createWriteStream(next, { flags: "a" })
                        full = ""
                      }),
                    ),
                    Effect.andThen(
                      ctx.metadata({
                        metadata: {
                          output: last,
                          description: input.description,
                        },
                      }),
                    ),
                  )
                }
              }

              return ctx.metadata({
                metadata: {
                  output: last,
                  description: input.description,
                },
              })
            }),
          )

          const abort = Effect.callback<void>((resume) => {
            if (ctx.abort.aborted) return resume(Effect.void)
            const handler = () => resume(Effect.void)
            ctx.abort.addEventListener("abort", handler, { once: true })
            return Effect.sync(() => ctx.abort.removeEventListener("abort", handler))
          })

          const timeout = Effect.sleep(`${input.timeout + 100} millis`)

          const exit = yield* Effect.raceAll([
            handle.exitCode.pipe(
              Effect.map((code) => {
                exited = true
                return { kind: "exit" as const, code }
              }),
            ),
            abort.pipe(Effect.map(() => ({ kind: "abort" as const, code: null }))),
            timeout.pipe(Effect.map(() => ({ kind: "timeout" as const, code: null }))),
          ])

          if (exit.kind === "abort" || exit.kind === "timeout") {
            if (exit.kind === "abort") aborted = true
            else expired = true
            yield* Effect.promise(() => killPidTree(handle.pid, { exited: () => exited }).catch(() => {}))
            yield* Effect.raceAll([
              handle.exitCode.pipe(
                Effect.map(() => {
                  exited = true
                }),
              ),
              Effect.sleep("2 seconds"),
            ]).pipe(Effect.catchCause(() => Effect.void))
            if (process.platform !== "win32") {
              yield* handle
                .kill({ forceKillAfter: "3 seconds" })
                .pipe(Effect.catchCause(() => Effect.void))
            }
          }

          return exit.kind === "exit" ? exit.code : null
        }),
      ).pipe(Effect.catchCause(() => Effect.succeed(-1)))

      const meta: string[] = []
      if (expired) {
        meta.push(
          `bash command timed out after ${input.timeout} ms. If the command is a build, test, install, package, deploy, or other expected long-running task, retry once with a larger timeout value in milliseconds instead of reporting the timeout as the final result.`,
        )
      }
      if (aborted) meta.push("User aborted the command")
      const raw = list.map((item) => item.text).join("")
      const end = tail(raw, limits.maxLines, limits.maxBytes)
      if (end.cut) cut = true
      if (!file && end.cut) {
        file = yield* trunc.write(raw)
      }

      let output = end.text
      if (!output) output = "(no output)"

      if (cut && file) {
        output = `...output truncated...\n\nFull output saved to: ${file}\n\n` + output
      }

      if (meta.length > 0) {
        output += "\n\n<bash_metadata>\n" + meta.join("\n") + "\n</bash_metadata>"
      }
      if (sink) {
        const stream = sink
        yield* Effect.promise(
          () =>
            new Promise<void>((resolve) => {
              stream.end(() => resolve())
              stream.on("error", () => resolve())
            }),
        )
      }

      const metadata: BashMetadata = {
        output: last || preview(output),
        exit: code,
        description: input.description,
        truncated: cut,
        ...(cut && file ? { outputPath: file } : {}),
      }

      return {
        title: input.description,
        metadata,
        output,
      }
    })

    return () =>
      Effect.gen(function* () {
        const shell = Shell.acceptable()
        const name = Shell.name(shell)
        const chain =
          name === "powershell"
            ? "If the commands depend on each other and must run sequentially, avoid '&&' in this shell because Windows PowerShell 5.1 does not support it. Use PowerShell conditionals such as `cmd1; if ($?) { cmd2 }` when later commands must depend on earlier success."
            : "If the commands depend on each other and must run sequentially, use a single Bash call with '&&' to chain them together (e.g., `git add . && git commit -m \"message\" && git push`). For instance, if one operation must complete before another starts (like mkdir before cp, Write before Bash for git operations, or git add before git commit), run these operations sequentially instead."
        log.info("bash tool using shell", { shell })

        const limits = yield* trunc.limits()
        const instance = yield* InstanceState.context

        return {
          description: DESCRIPTION.replaceAll("${directory}", instance.directory)
            .replaceAll("${os}", process.platform)
            .replaceAll("${shell}", name)
            .replaceAll("${chaining}", chain)
            .replaceAll("${defaultTimeout}", String(DEFAULT_TIMEOUT))
            .replaceAll("${defaultTimeoutMinutes}", String(Math.round(DEFAULT_TIMEOUT / 60_000)))
            .replaceAll("${backgroundAfter}", String(DEFAULT_BACKGROUND_AFTER))
            .replaceAll("${maxLines}", String(limits.maxLines))
            .replaceAll("${maxBytes}", String(limits.maxBytes)),
          parameters: Parameters,
          execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
            Effect.gen(function* () {
              const cwd = params.workdir
                ? yield* resolvePath(params.workdir, Instance.directory, shell)
                : Instance.directory
              if (params.timeout !== undefined && params.timeout < 0) {
                throw new Error(`Invalid timeout value: ${params.timeout}. Timeout must be a positive number.`)
              }
              if (params.background_after !== undefined && params.background_after < 0) {
                throw new Error(
                  `Invalid background_after value: ${params.background_after}. background_after must be zero or a positive number.`,
                )
              }
              const timeout = params.timeout ?? DEFAULT_TIMEOUT
              const backgroundAfter = params.background_after ?? DEFAULT_BACKGROUND_AFTER
              const ps = PS.has(name)
              const root = yield* parse(params.command, ps)
              const scan = yield* collect(root, cwd, ps, shell)
              if (!Instance.containsPath(cwd)) scan.dirs.add(cwd)
              yield* ask(ctx, scan)

              return yield* run(
                {
                  shell,
                  name,
                  command: params.command,
                  cwd,
                  env: yield* shellEnv(ctx, cwd),
                  timeout,
                  backgroundAfter,
                  description: params.description,
                },
                ctx,
              )
            }),
        }
      })
  }),
)
