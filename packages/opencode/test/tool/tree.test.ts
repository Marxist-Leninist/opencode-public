import { describe, expect, test } from "bun:test"
import { Effect, Exit, Layer } from "effect"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Agent } from "../../src/agent/agent"
import { MessageID, SessionID } from "../../src/session/schema"
import { Tool } from "../../src/tool"
import { TreeTool, __testing } from "../../src/tool/tree"
import { Truncate } from "../../src/tool"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  Layer.mergeAll(CrossSpawnSpawner.defaultLayer, AppFileSystem.defaultLayer, Truncate.defaultLayer, Agent.defaultLayer),
)

const baseCtx: Tool.Context = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make(""),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

const recordAsk = (calls: Array<Parameters<Tool.Context["ask"]>[0]>, fail = false): Tool.Context["ask"] => (input) =>
  Effect.sync(() => {
    calls.push(input)
    if (fail) throw new Error("permission probe")
  })

async function buildSampleTree(root: string) {
  await fs.mkdir(path.join(root, "src", "lib"), { recursive: true })
  await fs.mkdir(path.join(root, "node_modules", "x"), { recursive: true })
  await fs.mkdir(path.join(root, ".git"), { recursive: true })
  await fs.writeFile(path.join(root, "README.md"), "# hi\n")
  await fs.writeFile(path.join(root, "src", "index.ts"), "export const x = 1\n")
  await fs.writeFile(path.join(root, "src", "lib", "a.ts"), "// a\n")
  await fs.writeFile(path.join(root, "src", "lib", "b.ts"), "// b\n")
  await fs.writeFile(path.join(root, "node_modules", "x", "p.json"), "{}")
  await fs.writeFile(path.join(root, ".env"), "SECRET=1\n")
  await fs.writeFile(path.join(root, ".git", "HEAD"), "ref: refs/heads/main\n")
}

describe("tool.tree helpers", () => {
  test("shouldIncludeName respects show_hidden", () => {
    expect(
      __testing.shouldIncludeName(".env", "/p/.env", { showHidden: false, excludes: [] }),
    ).toBe(false)
    expect(
      __testing.shouldIncludeName(".env", "/p/.env", { showHidden: true, excludes: [] }),
    ).toBe(true)
  })

  test("shouldIncludeName respects pattern (case-insensitive substring)", () => {
    expect(
      __testing.shouldIncludeName("Index.TS", "/p/Index.TS", {
        showHidden: false,
        pattern: ".ts",
        excludes: [],
      }),
    ).toBe(true)
    expect(
      __testing.shouldIncludeName("Index.tsx", "/p/Index.tsx", {
        showHidden: false,
        pattern: ".rs",
        excludes: [],
      }),
    ).toBe(false)
  })

  test("shouldIncludeName respects excludes (basename and full path)", () => {
    expect(
      __testing.shouldIncludeName("node_modules", "/p/node_modules", {
        showHidden: false,
        excludes: ["node_modules"],
      }),
    ).toBe(false)
    expect(
      __testing.shouldIncludeName("a.ts", "/p/dist/a.ts", {
        showHidden: false,
        excludes: ["dist"],
      }),
    ).toBe(false)
  })

  test("sortEntries puts dirs before files", () => {
    const e = [
      { name: "z.ts", full: "/p/z.ts", isDir: false, isSymlink: false, size: 0, mtime: 0 },
      { name: "a", full: "/p/a", isDir: true, isSymlink: false, size: 0, mtime: 0 },
      { name: "b.ts", full: "/p/b.ts", isDir: false, isSymlink: false, size: 0, mtime: 0 },
    ]
    const sorted = __testing.sortEntries(e, "name")
    expect(sorted.map((x) => x.name)).toEqual(["a", "b.ts", "z.ts"])
  })
})

describe("tool.tree tool", () => {
  it.live("renders a basic tree skipping default-excluded dirs", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => buildSampleTree(dir))
        const toolInfo = yield* TreeTool
        const tool = yield* toolInfo.init()
        const result = yield* tool.execute({ path: dir }, baseCtx)
        const out = result.output
        expect(out).toContain("README.md")
        expect(out).toContain("src")
        expect(out).toContain("index.ts")
        expect(out).toContain("a.ts")
        expect(out).toContain("b.ts")
        expect(out).not.toContain("node_modules")
        expect(out).not.toContain(".git")
        expect(out).not.toContain(".env")
        expect(result.metadata.dirs).toBeGreaterThanOrEqual(2)
        expect(result.metadata.files).toBeGreaterThanOrEqual(3)
      }),
    ),
  )

  it.live("show_hidden surfaces dotfiles and dotdirs", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => buildSampleTree(dir))
        const toolInfo = yield* TreeTool
        const tool = yield* toolInfo.init()
        const result = yield* tool.execute(
          { path: dir, show_hidden: true, exclude: ["node_modules"] },
          baseCtx,
        )
        expect(result.output).toContain(".env")
        expect(result.output).toContain(".git")
        expect(result.output).not.toContain("node_modules")
      }),
    ),
  )

  it.live("asks read permission before walking directory", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => buildSampleTree(dir))
        const calls: Array<Parameters<Tool.Context["ask"]>[0]> = []
        const toolInfo = yield* TreeTool
        const tool = yield* toolInfo.init()
        const exit = yield* Effect.exit(tool.execute({ path: dir }, { ...baseCtx, ask: recordAsk(calls, true) }))

        expect(Exit.isFailure(exit)).toBe(true)
        expect(calls).toHaveLength(1)
        expect(calls[0]!.permission).toBe("read")
        expect(calls[0]!.patterns).toEqual([dir])
        expect(calls[0]!.always).toEqual(["*"])
      }),
    ),
  )

  it.live("max_depth=1 lists only direct children", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => buildSampleTree(dir))
        const toolInfo = yield* TreeTool
        const tool = yield* toolInfo.init()
        const result = yield* tool.execute({ path: dir, max_depth: 1 }, baseCtx)
        expect(result.output).toContain("src")
        expect(result.output).toContain("README.md")
        expect(result.output).not.toContain("index.ts")
      }),
    ),
  )

  it.live("dirs_only filters out files but keeps dirs", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => buildSampleTree(dir))
        const toolInfo = yield* TreeTool
        const tool = yield* toolInfo.init()
        const result = yield* tool.execute({ path: dir, dirs_only: true }, baseCtx)
        expect(result.output).toContain("src")
        expect(result.output).toContain("lib")
        expect(result.output).not.toContain("README.md")
        expect(result.output).not.toContain("index.ts")
      }),
    ),
  )

  it.live("pattern filters by basename substring", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => buildSampleTree(dir))
        const toolInfo = yield* TreeTool
        const tool = yield* toolInfo.init()
        const result = yield* tool.execute({ path: dir, pattern: ".ts" }, baseCtx)
        // Pattern is a basename filter so only entries whose name contains ".ts"
        // are listed; "src" is filtered too. README.md must be filtered.
        expect(result.output).not.toContain("README.md")
        expect(result.output).toContain("a.ts")
      }),
    ),
  )

  it.live("show_size emits byte counts and bytes_total metadata", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => buildSampleTree(dir))
        const toolInfo = yield* TreeTool
        const tool = yield* toolInfo.init()
        const result = yield* tool.execute({ path: dir, show_size: true }, baseCtx)
        expect(result.output).toMatch(/README\.md \(\d+\)/)
        expect(typeof result.metadata.bytes_total).toBe("number")
        expect(result.metadata.bytes_total!).toBeGreaterThan(0)
      }),
    ),
  )

  it.live("max_entries truncates and reports it", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => buildSampleTree(dir))
        const toolInfo = yield* TreeTool
        const tool = yield* toolInfo.init()
        const result = yield* tool.execute({ path: dir, max_entries: 2 }, baseCtx)
        expect(result.metadata.truncated).toBe(true)
        expect(result.output).toContain("truncated")
      }),
    ),
  )

  it.live("rejects a path that is not a directory", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => buildSampleTree(dir))
        const toolInfo = yield* TreeTool
        const tool = yield* toolInfo.init()
        const exit = yield* Effect.exit(
          tool.execute({ path: path.join(dir, "README.md") }, baseCtx),
        )
        expect(exit._tag).toBe("Failure")
      }),
    ),
  )
})
