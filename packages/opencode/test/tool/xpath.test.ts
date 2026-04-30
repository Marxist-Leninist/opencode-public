import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Agent } from "../../src/agent/agent"
import { MessageID, SessionID } from "../../src/session/schema"
import { Tool } from "../../src/tool"
import { XpathTool, __testing } from "../../src/tool/xpath"
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

const sample = `<?xml version="1.0" encoding="UTF-8"?>
<store>
  <book category="fiction"><title>Lord of the Rings</title><author>Tolkien</author><price>22.99</price></book>
  <book category="reference"><title>Strunk Style Guide</title><author>Strunk</author><price>14.99</price></book>
  <book category="fiction"><title>Heart of Darkness</title><author>Conrad</author><price>8.99</price></book>
  <bicycle color="red"><price>19.95</price></bicycle>
</store>`

describe("tool.xpath parser", () => {
  test("absolute single-step", () => {
    const r = __testing.parseXpath("/store")
    expect(r.absolute).toBe(true)
    expect(r.steps).toEqual([{ kind: "child", name: "store", predicates: [] }])
  })

  test("absolute multi-step", () => {
    const r = __testing.parseXpath("/store/book/title")
    expect(r.absolute).toBe(true)
    expect(r.steps.map((s) => s.kind)).toEqual(["child", "child", "child"])
  })

  test("descendant operator", () => {
    const r = __testing.parseXpath("//book")
    expect(r.absolute).toBe(true)
    expect(r.steps[0]).toEqual({ kind: "descendant", name: "book", predicates: [] })
  })

  test("attribute step", () => {
    const r = __testing.parseXpath("//book/@category")
    expect(r.steps[r.steps.length - 1]).toEqual({ kind: "attribute", name: "category" })
  })

  test("position predicate", () => {
    const r = __testing.parseXpath("/store/book[2]")
    const last = r.steps[r.steps.length - 1]!
    expect(last.kind).toBe("child")
    expect((last as any).predicates[0]).toEqual({ kind: "position", n: 2 })
  })

  test("attribute equality predicate", () => {
    const r = __testing.parseXpath("//book[@category='fiction']")
    const last = r.steps[r.steps.length - 1]!
    expect((last as any).predicates[0]).toEqual({ kind: "attrEquals", name: "category", value: "fiction" })
  })

  test("text() terminal", () => {
    const r = __testing.parseXpath("//author/text()")
    expect(r.steps[r.steps.length - 1]).toEqual({ kind: "text" })
  })

  test("rejects empty path", () => {
    expect(() => __testing.parseXpath("")).toThrow(/empty/)
  })
})

describe("tool.xpath evaluator", () => {
  test("absolute path matches root", () => {
    const root = __testing.parseXmlTree(sample)
    const parsed = __testing.parseXpath("/store")
    const r = __testing.evaluateXpath(root, parsed, { limit: 100 })
    expect(r.matches).toHaveLength(1)
    expect((r.matches[0] as any).node.name).toBe("store")
  })

  test("descendant matches every book", () => {
    const root = __testing.parseXmlTree(sample)
    const parsed = __testing.parseXpath("//book")
    const r = __testing.evaluateXpath(root, parsed, { limit: 100 })
    expect(r.matches).toHaveLength(3)
  })

  test("attribute filter selects fiction books", () => {
    const root = __testing.parseXmlTree(sample)
    const parsed = __testing.parseXpath("//book[@category='fiction']/title")
    const r = __testing.evaluateXpath(root, parsed, { limit: 100 })
    expect(r.matches).toHaveLength(2)
  })

  test("position predicate", () => {
    const root = __testing.parseXmlTree(sample)
    const parsed = __testing.parseXpath("/store/book[1]/title")
    const r = __testing.evaluateXpath(root, parsed, { limit: 100 })
    expect(r.matches).toHaveLength(1)
  })

  test("attribute step yields attribute matches", () => {
    const root = __testing.parseXmlTree(sample)
    const parsed = __testing.parseXpath("//book/@category")
    const r = __testing.evaluateXpath(root, parsed, { limit: 100 })
    expect(r.matches).toHaveLength(3)
    expect((r.matches[0] as any).kind).toBe("attribute")
  })

  test("descendant of every price", () => {
    const root = __testing.parseXmlTree(sample)
    const parsed = __testing.parseXpath("//price")
    const r = __testing.evaluateXpath(root, parsed, { limit: 100 })
    expect(r.matches).toHaveLength(4)
  })

  test("limit caps results", () => {
    const root = __testing.parseXmlTree(sample)
    const parsed = __testing.parseXpath("//*")
    const r = __testing.evaluateXpath(root, parsed, { limit: 3 })
    expect(r.matches).toHaveLength(3)
    expect(r.capped).toBe(true)
  })

  test("formatPath produces canonical output", () => {
    expect(__testing.formatXpathPath([{ name: "store", index: 1, nameIndex: 1 }])).toBe("/store[1]")
  })
})

describe("tool.xpath tool", () => {
  it.live("queries inline XML for values", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* XpathTool
        const tool = yield* toolInfo.init()
        const result = yield* tool.execute(
          {
            data: sample,
            path: "//book/author",
          },
          baseCtx,
        )
        expect(result.metadata.matches).toBe(3)
        const parsed = JSON.parse(result.output)
        expect(parsed).toEqual(["Tolkien", "Strunk", "Conrad"])
      }),
    ),
  )

  it.live("count mode returns just the count", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* XpathTool
        const tool = yield* toolInfo.init()
        const result = yield* tool.execute(
          {
            data: sample,
            path: "//price",
            mode: "count",
          },
          baseCtx,
        )
        expect(result.metadata.matches).toBe(4)
        expect(result.output).toBe("4")
      }),
    ),
  )

  it.live("xml mode returns fragments", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* XpathTool
        const tool = yield* toolInfo.init()
        const result = yield* tool.execute(
          {
            data: sample,
            path: "//book[1]",
            mode: "xml",
          },
          baseCtx,
        )
        expect(result.metadata.matches).toBe(1)
        expect(result.output).toContain("<title>")
        expect(result.output).toContain("Tolkien")
      }),
    ),
  )

  it.live("attribute extraction returns attribute values", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* XpathTool
        const tool = yield* toolInfo.init()
        const result = yield* tool.execute(
          {
            data: sample,
            path: "//book/@category",
          },
          baseCtx,
        )
        expect(result.metadata.matches).toBe(3)
        const parsed = JSON.parse(result.output)
        expect(parsed).toEqual(["fiction", "reference", "fiction"])
      }),
    ),
  )

  it.live("first mode returns the first match", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* XpathTool
        const tool = yield* toolInfo.init()
        const result = yield* tool.execute(
          {
            data: sample,
            path: "//book/title",
            mode: "first",
          },
          baseCtx,
        )
        expect(JSON.parse(result.output)).toBe("Lord of the Rings")
      }),
    ),
  )

  it.live("paths mode returns canonical paths", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* XpathTool
        const tool = yield* toolInfo.init()
        const result = yield* tool.execute(
          {
            data: sample,
            path: "//book/title",
            mode: "paths",
          },
          baseCtx,
        )
        expect(result.metadata.matches).toBe(3)
        expect(result.output).toContain("/store[1]/book[1]/title[1]")
      }),
    ),
  )

  it.live("queries an XML file from disk", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const dir = mkdtempSync(join(tmpdir(), "xpath-test-"))
        const file = join(dir, "sample.xml")
        writeFileSync(file, sample, "utf8")
        const toolInfo = yield* XpathTool
        const tool = yield* toolInfo.init()
        const result = yield* tool.execute(
          {
            filePath: file,
            path: "/store/bicycle/@color",
          },
          baseCtx,
        )
        expect(result.metadata.matches).toBe(1)
        expect(JSON.parse(result.output)).toEqual(["red"])
        expect(result.metadata.source).toBe("file")
      }),
    ),
  )

  it.live("rejects when neither data nor filePath supplied", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* XpathTool
        const tool = yield* toolInfo.init()
        const exit = yield* Effect.exit(tool.execute({ path: "/x" } as any, baseCtx))
        expect(exit._tag).toBe("Failure")
      }),
    ),
  )

  it.live("rejects inline XML by UTF-8 byte size", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* XpathTool
        const tool = yield* toolInfo.init()
        const oversized = `<r>${"\u00e9".repeat(4_300_000)}</r>`
        const exit = yield* Effect.exit(tool.execute({ data: oversized, path: "/r" }, baseCtx))
        expect(exit._tag).toBe("Failure")
        if (exit._tag === "Failure") {
          expect(String(exit.cause)).toContain("too large")
        }
      }),
    ),
  )

  it.live("returns empty for missing path without throwing", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* XpathTool
        const tool = yield* toolInfo.init()
        const result = yield* tool.execute(
          {
            data: sample,
            path: "//noSuchElement",
          },
          baseCtx,
        )
        expect(result.metadata.matches).toBe(0)
        expect(result.output).toBe("[]")
      }),
    ),
  )
})
