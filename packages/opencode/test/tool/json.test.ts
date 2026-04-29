import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import path from "path"
import { writeFile, readFile } from "node:fs/promises"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Agent } from "../../src/agent/agent"
import { MessageID, SessionID } from "../../src/session/schema"
import { Tool } from "../../src/tool"
import { JsonTool, __testing } from "../../src/tool/json"
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

describe("tool.json.parsePath", () => {
  const cases: { input: string | undefined; expected: { kind: "key" | "index"; key?: string; index?: number }[] }[] = [
    { input: undefined, expected: [] },
    { input: "", expected: [] },
    { input: "$", expected: [] },
    { input: ".", expected: [] },
    { input: "model", expected: [{ kind: "key", key: "model" }] },
    {
      input: "provider.deepseek.options.apiKey",
      expected: [
        { kind: "key", key: "provider" },
        { kind: "key", key: "deepseek" },
        { kind: "key", key: "options" },
        { kind: "key", key: "apiKey" },
      ],
    },
    {
      input: "list[0].x",
      expected: [
        { kind: "key", key: "list" },
        { kind: "index", index: 0 },
        { kind: "key", key: "x" },
      ],
    },
    {
      input: "mcp['sg-scheduler'].command",
      expected: [
        { kind: "key", key: "mcp" },
        { kind: "key", key: "sg-scheduler" },
        { kind: "key", key: "command" },
      ],
    },
    {
      input: "$.foo.bar",
      expected: [
        { kind: "key", key: "foo" },
        { kind: "key", key: "bar" },
      ],
    },
  ]
  for (const c of cases) {
    it.live(`parses ${JSON.stringify(c.input)}`, () =>
      Effect.gen(function* () {
        const got = __testing.parsePath(c.input)
        expect(got).toEqual(c.expected as any)
      }),
    )
  }
})

describe("tool.json.deepMerge", () => {
  it.live("merges nested objects", () =>
    Effect.gen(function* () {
      const out = __testing.deepMerge(
        { a: 1, nest: { x: 1, y: 2 } },
        { b: 2, nest: { y: 99, z: 3 } },
      )
      expect(out).toEqual({ a: 1, b: 2, nest: { x: 1, y: 99, z: 3 } })
    }),
  )
  it.live("source replaces non-object target field", () =>
    Effect.gen(function* () {
      const out = __testing.deepMerge({ a: 1 }, { a: { x: 1 } })
      expect(out).toEqual({ a: { x: 1 } })
    }),
  )
})

describe("tool.json", () => {
  const SAMPLE = {
    model: "deepseek/deepseek-v4-pro",
    enabled_providers: ["deepseek", "openrouter", "sg-ring"],
    mcp: {
      "sg-scheduler": { command: ["python", "server.py"] },
    },
    provider: { deepseek: { options: { apiKey: "k", timeout: 30000 } } },
  }

  const writeSample = (dir: string) =>
    Effect.promise(async () => {
      const p = path.join(dir, "config.json")
      await writeFile(p, JSON.stringify(SAMPLE, null, 2) + "\n", "utf8")
      return p
    })

  it.live("get returns nested value", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const p = yield* writeSample(dir)
        const tool = yield* (yield* JsonTool).init()
        const r = yield* tool.execute(
          { action: "get", filePath: p, path: "provider.deepseek.options.apiKey" },
          baseCtx,
        )
        expect(r.metadata.found).toBe(true)
        expect(r.metadata.json_type).toBe("string")
        expect(r.output).toBe('"k"')
      }),
    ),
  )

  it.live("get reports missing path", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const p = yield* writeSample(dir)
        const tool = yield* (yield* JsonTool).init()
        const r = yield* tool.execute({ action: "get", filePath: p, path: "nonexistent" }, baseCtx)
        expect(r.metadata.found).toBe(false)
        expect(r.output).toContain("not found")
      }),
    ),
  )

  it.live("has and type return correct values", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const p = yield* writeSample(dir)
        const tool = yield* (yield* JsonTool).init()
        const has = yield* tool.execute(
          { action: "has", filePath: p, path: "enabled_providers[1]" },
          baseCtx,
        )
        expect(has.output).toBe("true")
        const t = yield* tool.execute(
          { action: "type", filePath: p, path: "enabled_providers" },
          baseCtx,
        )
        expect(t.output).toBe("array")
      }),
    ),
  )

  it.live("keys returns object keys", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const p = yield* writeSample(dir)
        const tool = yield* (yield* JsonTool).init()
        const r = yield* tool.execute({ action: "keys", filePath: p, path: "mcp" }, baseCtx)
        expect(r.metadata.keys).toEqual(["sg-scheduler"])
      }),
    ),
  )

  it.live("set writes new value, preserves trailing newline", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const p = yield* writeSample(dir)
        const tool = yield* (yield* JsonTool).init()
        const r = yield* tool.execute(
          {
            action: "set",
            filePath: p,
            path: "provider.deepseek.options.timeout",
            value: 60000,
          },
          baseCtx,
        )
        expect(r.metadata.written).toBe(true)
        const text = yield* Effect.promise(() => readFile(p, "utf8"))
        expect(text.endsWith("\n")).toBe(true)
        const parsed = JSON.parse(text)
        expect(parsed.provider.deepseek.options.timeout).toBe(60000)
        expect(parsed.provider.deepseek.options.apiKey).toBe("k")
      }),
    ),
  )

  it.live("set creates missing intermediate keys by default", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const p = yield* writeSample(dir)
        const tool = yield* (yield* JsonTool).init()
        yield* tool.execute(
          { action: "set", filePath: p, path: "newSection.nested.flag", value: true },
          baseCtx,
        )
        const text = yield* Effect.promise(() => readFile(p, "utf8"))
        const parsed = JSON.parse(text)
        expect(parsed.newSection.nested.flag).toBe(true)
      }),
    ),
  )

  it.live("delete removes a key and reports change", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const p = yield* writeSample(dir)
        const tool = yield* (yield* JsonTool).init()
        const r = yield* tool.execute(
          { action: "delete", filePath: p, path: "mcp['sg-scheduler']" },
          baseCtx,
        )
        expect(r.metadata.written).toBe(true)
        const text = yield* Effect.promise(() => readFile(p, "utf8"))
        const parsed = JSON.parse(text)
        expect(parsed.mcp).toEqual({})
      }),
    ),
  )

  it.live("merge deep-merges into target object", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const p = yield* writeSample(dir)
        const tool = yield* (yield* JsonTool).init()
        yield* tool.execute(
          {
            action: "merge",
            filePath: p,
            path: "provider.deepseek.options",
            value: { timeout: 12345, baseURL: "https://example.com" },
          },
          baseCtx,
        )
        const text = yield* Effect.promise(() => readFile(p, "utf8"))
        const parsed = JSON.parse(text)
        expect(parsed.provider.deepseek.options).toEqual({
          apiKey: "k",
          timeout: 12345,
          baseURL: "https://example.com",
        })
      }),
    ),
  )

  it.live("write actions refuse a root path", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const p = yield* writeSample(dir)
        const tool = yield* (yield* JsonTool).init()
        const exit = yield* Effect.exit(
          tool.execute({ action: "set", filePath: p, path: "", value: { everything: "gone" } }, baseCtx),
        )
        expect(exit._tag).toBe("Failure")
      }),
    ),
  )
})
