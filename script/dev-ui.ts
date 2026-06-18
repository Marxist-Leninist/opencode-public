import path from "node:path"
import { fileURLToPath } from "node:url"

type Child = {
  name: string
  process: ReturnType<typeof Bun.spawn>
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const bun = process.execPath
const children: Child[] = []

function start(name: string, cwd: string, args: string[]) {
  const child = Bun.spawn([bun, ...args], {
    cwd,
    env: {
      ...process.env,
      FORCE_COLOR: "1",
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })

  const entry = { name, process: child }
  children.push(entry)
  pipe(child.stdout, name)
  pipe(child.stderr, name)
  return entry
}

async function runOnce(name: string, cwd: string, args: string[]) {
  const child = Bun.spawn([bun, ...args], {
    cwd,
    env: {
      ...process.env,
      FORCE_COLOR: "1",
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })

  pipe(child.stdout, name)
  pipe(child.stderr, name)

  const code = await child.exited
  if (code !== 0) {
    throw new Error(`${name} exited with code ${code}`)
  }
}

async function pipe(stream: ReadableStream<Uint8Array>, name: string) {
  const reader = stream.pipeThrough(new TextDecoderStream()).getReader()
  let pending = ""

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    pending += value
    const lines = pending.split(/\r?\n/)
    pending = lines.pop() ?? ""
    for (const line of lines) {
      if (line.length) console.log(`[${name}] ${line}`)
    }
  }

  if (pending.length) console.log(`[${name}] ${pending}`)
}

function stopAll() {
  for (const child of children) {
    if (child.process.exitCode === null) child.process.kill()
  }
}

process.on("SIGINT", () => {
  stopAll()
  process.exit(130)
})

process.on("SIGTERM", () => {
  stopAll()
  process.exit(143)
})

const sdk = path.join(root, "packages", "sdk", "js")
try {
  await runOnce("sdk", sdk, ["run", "sync:if-needed"])
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
}

start("sdk", sdk, ["run", "watch:contract"])

start("server", path.join(root, "packages", "opencode"), [
  "run",
  "--conditions=browser",
  "./src/index.ts",
  "serve",
  "--port",
  "4096",
])

start("app", path.join(root, "packages", "app"), ["dev", "--", "--port", "4444"])

console.log("OpenCode local UI dev servers starting")
console.log("SDK:      watching backend contract")
console.log("Backend:  http://localhost:4096")
console.log("Frontend: http://localhost:4444")

const firstExit = await Promise.race(
  children.map(async (child) => {
    const code = await child.process.exited
    return { name: child.name, code }
  }),
)

stopAll()
console.error(`${firstExit.name} exited with code ${firstExit.code}`)
process.exit(firstExit.code || 1)
