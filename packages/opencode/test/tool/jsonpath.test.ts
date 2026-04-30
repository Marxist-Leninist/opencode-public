import { describe, expect, test } from "bun:test"
import { Effect, Exit, Layer } from "effect"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Agent } from "../../src/agent/agent"
import { MessageID, SessionID } from "../../src/session/schema"
import { Tool } from "../../src/tool"
import { JsonpathTool, __testing } from "../../src/tool/jsonpath"
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

const sample = {
  store: {
    book: [
      { category: "fiction", author: "Conrad", price: 8.99, isbn: "0-553-21311-3" },
      { category: "reference", author: "Strunk", price: 14.99 },
      { category: "fiction", author: "Tolkien", price: 22.99, isbn: "0-395-19395-8" },
    ],
    bicycle: { color: "red", price: 19.95 },
  },
  expensive: 10,
}

describe("tool.jsonpath parser", () => {
  test("$ root parses to empty steps", () => {
    expect(__testing.parseJsonPath("$")).toEqual([])
  })

  test("dot key path", () => {
    expect(__testing.parseJsonPath("$.foo.bar")).toEqual([
      { kind: "key", key: "foo" },
      { kind: "key", key: "bar" },
    ])
  })

  test("bracket key path with quotes", () => {
    expect(__testing.parseJsonPath("$['foo'][\"bar\"]")).toEqual([
      { kind: "key", key: "foo" },
      { kind: "key", key: "bar" },
    ])
  })

  test("numeric index and negative", () => {
    expect(__testing.parseJsonPath("$.items[0]")).toEqual([
      { kind: "key", key: "items" },
      { kind: "index", index: 0 },
    ])
    expect(__testing.parseJsonPath("$.items[-1]")).toEqual([
      { kind: "key", key: "items" },
      { kind: "index", index: -1 },
    ])
  })

  test("wildcard child", () => {
    expect(__testing.parseJsonPath("$.items[*]")).toEqual([
      { kind: "key", key: "items" },
      { kind: "wildcard" },
    ])
    expect(__testing.parseJsonPath("$.items.*")).toEqual([
      { kind: "key", key: "items" },
      { kind: "wildcard" },
    ])
  })

  test("descendant operator", () => {
    expect(__testing.parseJsonPath("$..price")).toEqual([{ kind: "descendant", key: "price" }])
    expect(__testing.parseJsonPath("$..*")).toEqual([{ kind: "descendant" }])
  })

  test("slice", () => {
    expect(__testing.parseJsonPath("$.items[0:5]")).toEqual([
      { kind: "key", key: "items" },
      { kind: "slice", start: 0, end: 5, step: 1 },
    ])
    expect(__testing.parseJsonPath("$.items[0:10:2]")).toEqual([
      { kind: "key", key: "items" },
      { kind: "slice", start: 0, end: 10, step: 2 },
    ])
    expect(__testing.parseJsonPath("$.items[:5]")).toEqual([
      { kind: "key", key: "items" },
      { kind: "slice", start: undefined, end: 5, step: 1 },
    ])
  })

  test("numeric union", () => {
    expect(__testing.parseJsonPath("$.items[0,2,4]")).toEqual([
      { kind: "key", key: "items" },
      { kind: "indices", indices: [0, 2, 4] },
    ])
  })

  test("string union", () => {
    expect(__testing.parseJsonPath("$['users','admins']")).toEqual([
      { kind: "keys", keys: ["users", "admins"] },
    ])
  })

  test("quoted bracket keys can contain closing brackets and commas", () => {
    expect(__testing.parseJsonPath("$['a]b']")).toEqual([{ kind: "key", key: "a]b" }])
    expect(__testing.parseJsonPath("$['a,b','c]d']")).toEqual([
      { kind: "keys", keys: ["a,b", "c]d"] },
    ])
  })

  test("rejects filter expressions clearly", () => {
    expect(() => __testing.parseJsonPath("$.items[?(@.price > 10)]")).toThrow(/filters and functions/)
  })

  test("rejects empty path", () => {
    expect(() => __testing.parseJsonPath("")).toThrow(/empty/)
  })

  test("rejects unterminated bracket", () => {
    expect(() => __testing.parseJsonPath("$.foo[0")).toThrow(/unterminated/)
  })
})

describe("tool.jsonpath evaluator", () => {
  test("root returns the entire document", () => {
    const r = __testing.applyJsonPath(sample, [], { limit: 100 })
    expect(r.matches).toHaveLength(1)
    expect(r.matches[0]!.value).toEqual(sample)
  })

  test("nested key", () => {
    const steps = __testing.parseJsonPath("$.store.bicycle.color")
    const r = __testing.applyJsonPath(sample, steps, { limit: 100 })
    expect(r.matches.map((m) => m.value)).toEqual(["red"])
  })

  test("wildcard over array", () => {
    const steps = __testing.parseJsonPath("$.store.book[*].author")
    const r = __testing.applyJsonPath(sample, steps, { limit: 100 })
    expect(r.matches.map((m) => m.value)).toEqual(["Conrad", "Strunk", "Tolkien"])
  })

  test("recursive descendant collects every price", () => {
    const steps = __testing.parseJsonPath("$..price")
    const r = __testing.applyJsonPath(sample, steps, { limit: 100 })
    expect(r.matches.map((m) => m.value).sort((a: any, b: any) => a - b)).toEqual([8.99, 14.99, 19.95, 22.99])
  })

  test("negative index", () => {
    const steps = __testing.parseJsonPath("$.store.book[-1].author")
    const r = __testing.applyJsonPath(sample, steps, { limit: 100 })
    expect(r.matches.map((m) => m.value)).toEqual(["Tolkien"])
  })

  test("slice", () => {
    const steps = __testing.parseJsonPath("$.store.book[0:2].author")
    const r = __testing.applyJsonPath(sample, steps, { limit: 100 })
    expect(r.matches.map((m) => m.value)).toEqual(["Conrad", "Strunk"])
  })

  test("slice with step", () => {
    const steps = __testing.parseJsonPath("$.store.book[0:3:2].author")
    const r = __testing.applyJsonPath(sample, steps, { limit: 100 })
    expect(r.matches.map((m) => m.value)).toEqual(["Conrad", "Tolkien"])
  })

  test("numeric union", () => {
    const steps = __testing.parseJsonPath("$.store.book[0,2].author")
    const r = __testing.applyJsonPath(sample, steps, { limit: 100 })
    expect(r.matches.map((m) => m.value)).toEqual(["Conrad", "Tolkien"])
  })

  test("string union", () => {
    const steps = __testing.parseJsonPath("$.store['book','bicycle']")
    const r = __testing.applyJsonPath(sample, steps, { limit: 100 })
    expect(r.matches).toHaveLength(2)
  })

  test("limit caps results", () => {
    const steps = __testing.parseJsonPath("$..*")
    const r = __testing.applyJsonPath(sample, steps, { limit: 5 })
    expect(r.matches.length).toBe(5)
    expect(r.capped).toBe(true)
  })

  test("missing key returns no matches", () => {
    const steps = __testing.parseJsonPath("$.store.nope")
    const r = __testing.applyJsonPath(sample, steps, { limit: 100 })
    expect(r.matches).toHaveLength(0)
  })

  test("formatPath produces valid bracket notation", () => {
    expect(__testing.formatPath(["store", "book", 0, "author"])).toBe("$['store']['book'][0]['author']")
  })

  test("formatPath escapes single quotes", () => {
    expect(__testing.formatPath(["it's"])).toBe("$['it\\'s']")
  })
})

describe("tool.jsonpath tool", () => {
  it.live("queries inline data and returns values", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* JsonpathTool
        const tool = yield* toolInfo.init()
        const result = yield* tool.execute(
          {
            data: JSON.stringify(sample),
            path: "$.store.book[*].author",
          },
          baseCtx,
        )
        expect(result.metadata.matches).toBe(3)
        expect(result.metadata.source).toBe("data")
        const parsed = JSON.parse(result.output)
        expect(parsed).toEqual(["Conrad", "Strunk", "Tolkien"])
      }),
    ),
  )

  it.live("count mode returns just the count", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* JsonpathTool
        const tool = yield* toolInfo.init()
        const result = yield* tool.execute(
          {
            data: JSON.stringify(sample),
            path: "$..price",
            mode: "count",
          },
          baseCtx,
        )
        expect(result.metadata.matches).toBe(4)
        expect(result.output).toBe("4")
      }),
    ),
  )

  it.live("paths mode returns bracket-notation paths", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* JsonpathTool
        const tool = yield* toolInfo.init()
        const result = yield* tool.execute(
          {
            data: JSON.stringify(sample),
            path: "$.store.book[*].author",
            mode: "paths",
          },
          baseCtx,
        )
        expect(result.metadata.matches).toBe(3)
        expect(result.output).toContain("$['store']['book'][0]['author']")
        expect(result.output).toContain("$['store']['book'][2]['author']")
      }),
    ),
  )

  it.live("first mode returns the first match", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* JsonpathTool
        const tool = yield* toolInfo.init()
        const result = yield* tool.execute(
          {
            data: JSON.stringify(sample),
            path: "$.store.book[*].author",
            mode: "first",
          },
          baseCtx,
        )
        expect(JSON.parse(result.output)).toBe("Conrad")
      }),
    ),
  )

  it.live("queries a JSON file from disk", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const dir = mkdtempSync(join(tmpdir(), "jsonpath-test-"))
        const file = join(dir, "sample.json")
        writeFileSync(file, JSON.stringify(sample), "utf8")
        const toolInfo = yield* JsonpathTool
        const tool = yield* toolInfo.init()
        const result = yield* tool.execute(
          {
            filePath: file,
            path: "$.store.bicycle.price",
          },
          baseCtx,
        )
        expect(JSON.parse(result.output)).toEqual([19.95])
        expect(result.metadata.source).toBe("file")
      }),
    ),
  )

  it.live("asks read permission before reading a JSON file", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const dir = mkdtempSync(join(tmpdir(), "jsonpath-test-"))
        const file = join(dir, "sample.json")
        writeFileSync(file, JSON.stringify(sample), "utf8")
        const calls: Array<Parameters<Tool.Context["ask"]>[0]> = []
        const toolInfo = yield* JsonpathTool
        const tool = yield* toolInfo.init()
        const exit = yield* Effect.exit(
          tool.execute(
            {
              filePath: file,
              path: "$.store.bicycle.price",
            },
            { ...baseCtx, ask: recordAsk(calls, true) },
          ),
        )

        expect(Exit.isFailure(exit)).toBe(true)
        expect(calls).toHaveLength(1)
        expect(calls[0]!.permission).toBe("read")
        expect(calls[0]!.patterns).toEqual([file])
        expect(calls[0]!.always).toEqual(["*"])
      }),
    ),
  )

  it.live("stops quickly when already aborted", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const controller = new AbortController()
        controller.abort(new Error("stop jsonpath"))
        const toolInfo = yield* JsonpathTool
        const tool = yield* toolInfo.init()
        const exit = yield* Effect.exit(
          tool.execute(
            {
              data: JSON.stringify(sample),
              path: "$..price",
            },
            { ...baseCtx, abort: controller.signal },
          ),
        )
        expect(Exit.isFailure(exit)).toBe(true)
      }),
    ),
  )

  it.live("rejects when neither data nor filePath supplied", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* JsonpathTool
        const tool = yield* toolInfo.init()
        const exit = yield* Effect.exit(tool.execute({ path: "$" } as any, baseCtx))
        expect(exit._tag).toBe("Failure")
      }),
    ),
  )

  it.live("rejects when both data and filePath supplied", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* JsonpathTool
        const tool = yield* toolInfo.init()
        const exit = yield* Effect.exit(
          tool.execute({ path: "$", data: "{}", filePath: "x.json" } as any, baseCtx),
        )
        expect(exit._tag).toBe("Failure")
      }),
    ),
  )

  it.live("returns 0 matches for missing path without throwing", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* JsonpathTool
        const tool = yield* toolInfo.init()
        const result = yield* tool.execute(
          {
            data: JSON.stringify(sample),
            path: "$.no.such.thing",
          },
          baseCtx,
        )
        expect(result.metadata.matches).toBe(0)
        expect(result.output).toBe("[]")
      }),
    ),
  )
})
