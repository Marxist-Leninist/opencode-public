import { afterEach, beforeEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Agent } from "../../src/agent/agent"
import { MessageID, SessionID } from "../../src/session/schema"
import { Tool } from "../../src/tool"
import { KvTool, __testing, setStorePathForTesting } from "../../src/tool/kv"
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

let tmpDir: string

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "kv-test-"))
  setStorePathForTesting(path.join(tmpDir, "kv.json"))
})

afterEach(() => {
  setStorePathForTesting(undefined)
  try {
    rmSync(tmpDir, { recursive: true, force: true })
  } catch {}
})

describe("tool.kv helpers", () => {
  it.live("validateKey rejects illegal characters", () =>
    Effect.gen(function* () {
      expect(() => __testing.validateKey("good-key")).not.toThrow()
      expect(() => __testing.validateKey("ns/good")).not.toThrow()
      expect(() => __testing.validateKey("bad space")).toThrow(/letters/i)
      expect(() => __testing.validateKey("")).toThrow(/required/i)
      expect(() => __testing.validateKey(undefined)).toThrow(/required/i)
    }),
  )

  it.live("validateNamespace rejects slashes", () =>
    Effect.gen(function* () {
      expect(__testing.validateNamespace(undefined)).toBe("default")
      expect(__testing.validateNamespace("proj.x")).toBe("proj.x")
      expect(() => __testing.validateNamespace("a/b")).toThrow(/letters/i)
    }),
  )

  it.live("isExpired and computeExpiry agree on the same clock", () =>
    Effect.gen(function* () {
      const now = 1_700_000_000_000
      const expiry = __testing.computeExpiry(
        { action: "set", key: "k", value: "v", ttl_seconds: 60 } as any,
        now,
      )
      expect(expiry).toBe(now + 60_000)
      expect(__testing.isExpired({ created_at: now, updated_at: now, expires_at: now - 1, value: 1 }, now)).toBe(true)
      expect(__testing.isExpired({ created_at: now, updated_at: now, value: 1 }, now)).toBe(false)
    }),
  )

  it.live("ttl_seconds and expires_at are mutually exclusive", () =>
    Effect.gen(function* () {
      const now = Date.now()
      expect(() =>
        __testing.computeExpiry(
          {
            action: "set",
            key: "k",
            value: "v",
            ttl_seconds: 60,
            expires_at: new Date(now + 60_000).toISOString(),
          } as any,
          now,
        ),
      ).toThrow(/mutually exclusive/i)
    }),
  )

  it.live("test driver honours explicit store path overrides", () =>
    Effect.gen(function* () {
      const file = path.join(tmpDir, "override.json")
      const driven = yield* Effect.promise(() =>
        __testing.drive({ action: "set", key: "k", value: "v", namespace: "t" } as any, file, 1_700_000_000_000),
      )
      expect(driven.file).toBe(file)
      expect(existsSync(file)).toBe(true)
    }),
  )
})

describe("tool.kv tool", () => {
  it.live("set then get round-trips a JSON value", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* KvTool
        const tool = yield* toolInfo.init()

        const setRes = yield* tool.execute(
          { action: "set", key: "user", value: { id: 7, name: "ada" }, namespace: "test" },
          baseCtx,
        )
        expect(setRes.metadata.created).toBe(true)
        expect(setRes.metadata.previous_value).toBeNull()

        const getRes = yield* tool.execute({ action: "get", key: "user", namespace: "test" }, baseCtx)
        expect(getRes.metadata.found).toBe(true)
        expect(getRes.metadata.value).toEqual({ id: 7, name: "ada" })
      }),
    ),
  )

  it.live("set updates an existing key and reports previous_value", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* KvTool
        const tool = yield* toolInfo.init()

        yield* tool.execute({ action: "set", key: "n", value: 1, namespace: "t" }, baseCtx)
        const second = yield* tool.execute({ action: "set", key: "n", value: 2, namespace: "t" }, baseCtx)
        expect(second.metadata.created).toBe(false)
        expect(second.metadata.previous_value).toBe(1)
      }),
    ),
  )

  it.live("delete is idempotent", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* KvTool
        const tool = yield* toolInfo.init()

        yield* tool.execute({ action: "set", key: "go", value: "stay", namespace: "t" }, baseCtx)
        const first = yield* tool.execute({ action: "delete", key: "go", namespace: "t" }, baseCtx)
        const second = yield* tool.execute({ action: "delete", key: "go", namespace: "t" }, baseCtx)
        expect(first.metadata.deleted).toBe(true)
        expect(second.metadata.deleted).toBe(false)
      }),
    ),
  )

  it.live("incr starts at 0 and respects delta", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* KvTool
        const tool = yield* toolInfo.init()

        const a = yield* tool.execute({ action: "incr", key: "c", namespace: "t" }, baseCtx)
        const b = yield* tool.execute({ action: "incr", key: "c", namespace: "t", delta: 4 }, baseCtx)
        const c = yield* tool.execute({ action: "incr", key: "c", namespace: "t", delta: -2 }, baseCtx)
        expect(a.metadata.value).toBe(1)
        expect(b.metadata.value).toBe(5)
        expect(c.metadata.value).toBe(3)
      }),
    ),
  )

  it.live("incr refuses non-numeric existing values", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* KvTool
        const tool = yield* toolInfo.init()

        yield* tool.execute({ action: "set", key: "s", value: "hello", namespace: "t" }, baseCtx)
        const exit = yield* Effect.exit(tool.execute({ action: "incr", key: "s", namespace: "t" }, baseCtx))
        expect(exit._tag).toBe("Failure")
      }),
    ),
  )

  it.live("ttl_seconds expires entries on read", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* KvTool
        const tool = yield* toolInfo.init()

        yield* tool.execute({ action: "set", key: "soon", value: 1, ttl_seconds: 1, namespace: "t" }, baseCtx)
        // Force-expire by moving the file forward in time via touch with expires_at in the past is not allowed,
        // so we just sleep.
        yield* Effect.sleep("1100 millis")
        const got = yield* tool.execute({ action: "get", key: "soon", namespace: "t" }, baseCtx)
        expect(got.metadata.found).toBe(false)
      }),
    ),
  )

  it.live("pop returns the value and removes the key in one call", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* KvTool
        const tool = yield* toolInfo.init()

        yield* tool.execute({ action: "set", key: "p", value: [1, 2, 3], namespace: "t" }, baseCtx)
        const popped = yield* tool.execute({ action: "pop", key: "p", namespace: "t" }, baseCtx)
        const after = yield* tool.execute({ action: "get", key: "p", namespace: "t" }, baseCtx)
        expect(popped.metadata.found).toBe(true)
        expect(popped.metadata.value).toEqual([1, 2, 3])
        expect(popped.metadata.deleted).toBe(true)
        expect(after.metadata.found).toBe(false)
      }),
    ),
  )

  it.live("touch updates the expiry without changing the value", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* KvTool
        const tool = yield* toolInfo.init()

        yield* tool.execute({ action: "set", key: "k", value: "v", ttl_seconds: 60, namespace: "t" }, baseCtx)
        const t = yield* tool.execute({ action: "touch", key: "k", namespace: "t", ttl_seconds: 600 }, baseCtx)
        const got = yield* tool.execute({ action: "get", key: "k", namespace: "t" }, baseCtx)
        expect(t.metadata.touched).toBe(true)
        expect(got.metadata.value).toBe("v")
        expect(got.metadata.expires_at).toBeTruthy()
      }),
    ),
  )

  it.live("list and keys honour prefix filter and limit truncation", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* KvTool
        const tool = yield* toolInfo.init()

        for (const k of ["a:1", "a:2", "a:3", "b:1"]) {
          yield* tool.execute({ action: "set", key: k, value: k, namespace: "t" }, baseCtx)
        }

        const list = yield* tool.execute({ action: "list", namespace: "t", prefix: "a:" }, baseCtx)
        expect(list.metadata.total).toBe(3)
        expect(list.metadata.entries?.map((e) => e.key)).toEqual(["a:1", "a:2", "a:3"])

        const keys = yield* tool.execute({ action: "keys", namespace: "t", limit: 2 }, baseCtx)
        expect(keys.metadata.truncated).toBe(true)
        expect(keys.metadata.keys?.length).toBe(2)
      }),
    ),
  )

  it.live("clear without confirm is rejected; with confirm wipes the namespace", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* KvTool
        const tool = yield* toolInfo.init()

        yield* tool.execute({ action: "set", key: "x", value: 1, namespace: "wipe" }, baseCtx)
        const exit = yield* Effect.exit(tool.execute({ action: "clear", namespace: "wipe" }, baseCtx))
        expect(exit._tag).toBe("Failure")

        const cleared = yield* tool.execute({ action: "clear", namespace: "wipe", confirm: true }, baseCtx)
        expect(cleared.metadata.removed).toBe(1)

        const got = yield* tool.execute({ action: "get", key: "x", namespace: "wipe" }, baseCtx)
        expect(got.metadata.found).toBe(false)
      }),
    ),
  )

  it.live("info reports total entries and namespaces", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* KvTool
        const tool = yield* toolInfo.init()

        yield* tool.execute({ action: "set", key: "a", value: 1, namespace: "one" }, baseCtx)
        yield* tool.execute({ action: "set", key: "b", value: 2, namespace: "two" }, baseCtx)

        const info = yield* tool.execute({ action: "info", all_namespaces: true }, baseCtx)
        expect(info.metadata.total_entries).toBe(2)
        expect(info.metadata.namespaces).toEqual(["one", "two"])
      }),
    ),
  )

  it.live("rejects values that exceed the byte cap", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* KvTool
        const tool = yield* toolInfo.init()

        const big = "x".repeat(1_048_577)
        const exit = yield* Effect.exit(
          tool.execute({ action: "set", key: "big", value: big, namespace: "t" }, baseCtx),
        )
        expect(exit._tag).toBe("Failure")
      }),
    ),
  )

  it.live("survives a fresh read of the underlying file", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* KvTool
        const tool = yield* toolInfo.init()

        yield* tool.execute({ action: "set", key: "persisted", value: 42, namespace: "t" }, baseCtx)
        const file = path.join(tmpDir, "kv.json")
        const raw = yield* Effect.promise(() => Bun.file(file).text())
        expect(raw).toContain("persisted")
        expect(raw).toContain("42")
      }),
    ),
  )
})
