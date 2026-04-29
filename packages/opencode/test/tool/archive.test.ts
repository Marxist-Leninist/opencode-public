import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import path from "path"
import { mkdir, writeFile, readFile, stat } from "node:fs/promises"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Agent } from "../../src/agent/agent"
import { MessageID, SessionID } from "../../src/session/schema"
import { Tool } from "../../src/tool"
import { ArchiveTool, __testing } from "../../src/tool/archive"
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

describe("tool.archive", () => {
  describe("isUnsafeEntryName", () => {
    const cases: { name: string; unsafe: boolean }[] = [
      { name: "src/foo.ts", unsafe: false },
      { name: "a/b/c.txt", unsafe: false },
      { name: "/etc/passwd", unsafe: true },
      { name: "\\absolute\\win", unsafe: true },
      { name: "C:/Windows/sys.dll", unsafe: true },
      { name: "../escape/me", unsafe: true },
      { name: "ok/../bad", unsafe: true },
      { name: "", unsafe: true },
    ]
    for (const c of cases) {
      it.live(`flags ${JSON.stringify(c.name)} → unsafe=${c.unsafe}`, () =>
        Effect.gen(function* () {
          expect(__testing.isUnsafeEntryName(c.name)).toBe(c.unsafe)
        }),
      )
    }
  })

  describe("matchesPattern", () => {
    it.live("returns true when no pattern given", () =>
      Effect.gen(function* () {
        expect(__testing.matchesPattern("anything.txt", undefined)).toBe(true)
      }),
    )
    it.live("matches case-insensitively", () =>
      Effect.gen(function* () {
        expect(__testing.matchesPattern("PROject/Foo.TS", "foo")).toBe(true)
        expect(__testing.matchesPattern("a/b/c.txt", "zz")).toBe(false)
      }),
    )
  })

  it.live("creates, lists, and extracts a zip round-trip", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const srcDir = path.join(dir, "src")
        yield* Effect.promise(() => mkdir(srcDir, { recursive: true }))
        yield* Effect.promise(() => writeFile(path.join(srcDir, "a.txt"), "alpha"))
        yield* Effect.promise(() => writeFile(path.join(srcDir, "b.txt"), "bravo"))
        yield* Effect.promise(() => mkdir(path.join(srcDir, "nested"), { recursive: true }))
        yield* Effect.promise(() => writeFile(path.join(srcDir, "nested", "c.txt"), "charlie"))

        const toolInfo = yield* ArchiveTool
        const tool = yield* toolInfo.init()

        const archive = path.join(dir, "out.zip")
        const created = yield* tool.execute(
          {
            action: "create",
            archive_path: archive,
            source_paths: [srcDir],
          },
          baseCtx,
        )
        expect(created.metadata.action).toBe("create")
        expect(created.metadata.entry_count).toBeGreaterThanOrEqual(3)
        const archStat = yield* Effect.promise(() => stat(archive))
        expect(archStat.size).toBeGreaterThan(0)

        const listed = yield* tool.execute(
          {
            action: "list",
            archive_path: archive,
          },
          baseCtx,
        )
        expect(listed.metadata.action).toBe("list")
        expect(listed.metadata.entry_count).toBeGreaterThanOrEqual(3)
        const names = (listed.metadata.entries ?? []).map((e) => e.name)
        expect(names.some((n) => n.endsWith("a.txt"))).toBe(true)
        expect(names.some((n) => n.endsWith("c.txt"))).toBe(true)

        const dest = path.join(dir, "extracted")
        const extracted = yield* tool.execute(
          {
            action: "extract",
            archive_path: archive,
            dest_dir: dest,
          },
          baseCtx,
        )
        expect(extracted.metadata.action).toBe("extract")
        expect(extracted.metadata.extracted).toBeGreaterThanOrEqual(3)

        const aBuf = yield* Effect.promise(() => readFile(path.join(dest, "src", "a.txt"), "utf8"))
        expect(aBuf).toBe("alpha")
        const cBuf = yield* Effect.promise(() => readFile(path.join(dest, "src", "nested", "c.txt"), "utf8"))
        expect(cBuf).toBe("charlie")
      }),
    ),
  )

  it.live("name_pattern narrows extract", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const srcDir = path.join(dir, "src")
        yield* Effect.promise(() => mkdir(srcDir, { recursive: true }))
        yield* Effect.promise(() => writeFile(path.join(srcDir, "keep-me.txt"), "yes"))
        yield* Effect.promise(() => writeFile(path.join(srcDir, "drop-me.txt"), "no"))

        const toolInfo = yield* ArchiveTool
        const tool = yield* toolInfo.init()
        const archive = path.join(dir, "f.zip")
        yield* tool.execute(
          { action: "create", archive_path: archive, source_paths: [srcDir] },
          baseCtx,
        )
        const dest = path.join(dir, "narrow")
        const ex = yield* tool.execute(
          {
            action: "extract",
            archive_path: archive,
            dest_dir: dest,
            name_pattern: "keep-me",
          },
          baseCtx,
        )
        expect(ex.metadata.extracted).toBe(1)
        expect(ex.metadata.skipped).toBeGreaterThanOrEqual(1)
        const kept = yield* Effect.promise(() => readFile(path.join(dest, "src", "keep-me.txt"), "utf8"))
        expect(kept).toBe("yes")
      }),
    ),
  )

  it.live("refuses to overwrite existing archive on create", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const srcDir = path.join(dir, "src")
        yield* Effect.promise(() => mkdir(srcDir, { recursive: true }))
        yield* Effect.promise(() => writeFile(path.join(srcDir, "a.txt"), "alpha"))

        const archive = path.join(dir, "exists.zip")
        yield* Effect.promise(() => writeFile(archive, "not a real zip"))

        const toolInfo = yield* ArchiveTool
        const tool = yield* toolInfo.init()
        const exit = yield* Effect.exit(
          tool.execute(
            { action: "create", archive_path: archive, source_paths: [srcDir] },
            baseCtx,
          ),
        )
        expect(exit._tag).toBe("Failure")
      }),
    ),
  )
})
