import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Agent } from "../../src/agent/agent"
import { MessageID, SessionID } from "../../src/session/schema"
import { Tool } from "../../src/tool"
import { TabulateTool, __testing } from "../../src/tool/tabulate"
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

describe("tool.tabulate helpers", () => {
  test("derive columns from object rows", () => {
    expect(__testing.deriveColumns([{ a: 1, b: 2 }, { b: 3, c: 4 }])).toEqual(["a", "b", "c"])
  })

  test("derive columns from array rows", () => {
    expect(__testing.deriveColumns([[1, 2], [3, 4, 5]])).toEqual(["col_0", "col_1", "col_2"])
  })

  test("ascii format basic", () => {
    const out = __testing.tabulate(
      [
        { name: "alice", age: 30 },
        { name: "bob", age: 25 },
      ],
      { format: "ascii" },
    )
    expect(out.output).toContain("name")
    expect(out.output).toContain("age")
    expect(out.output).toContain("alice")
    expect(out.output).toContain("bob")
    expect(out.output).toContain("+-")
    // Numeric column should be right-aligned: 30 padded with leading space if header is wider.
    expect(out.columns).toEqual(["name", "age"])
  })

  test("markdown format with header alignment row", () => {
    const out = __testing.tabulate(
      [{ x: 1, y: "hello" }, { x: 22, y: "world" }],
      { format: "markdown" },
    )
    expect(out.output).toMatch(/\|\s+x\s+\|\s+y\s+\|/)
    expect(out.output).toMatch(/^\|[\s\-:]+\|[\s\-:]+\|$/m)
  })

  test("tsv / csv format", () => {
    const tsv = __testing.tabulate([{ a: 1, b: "two" }], { format: "tsv" })
    expect(tsv.output).toBe("a\tb\n1\ttwo")
    const csv = __testing.tabulate([{ a: 1, b: "two,with comma" }], { format: "csv" })
    expect(csv.output).toBe('a,b\n1,"two,with comma"')
  })

  test("max_col_width truncation", () => {
    const out = __testing.tabulate([{ s: "abcdefghijklm" }], { format: "tsv", max_col_width: 5 })
    expect(out.output.split("\n")[1]).toBe("abcd…")
  })

  test("transpose", () => {
    const t = __testing.transposeRows([
      { a: 1, b: 2 },
      { a: 3, b: 4 },
    ])
    expect(t).toEqual([
      { _column: "a", row_0: 1, row_1: 3 },
      { _column: "b", row_0: 2, row_1: 4 },
    ])
  })

  test("parseMarkdownTable", () => {
    const src = [
      "| name | age |",
      "|------|----:|",
      "| alice | 30 |",
      "| bob   | 25 |",
    ].join("\n")
    const parsed = __testing.parseMarkdownTable(src)
    expect(parsed.columns).toEqual(["name", "age"])
    expect(parsed.rows).toEqual([
      { name: "alice", age: "30" },
      { name: "bob", age: "25" },
    ])
  })

  test("summaryStats", () => {
    const s = __testing.summaryStats([
      { x: 1, name: "a" },
      { x: 2, name: "a" },
      { x: 3, name: "b" },
    ])
    expect(s.x.numeric).toBe(true)
    expect(s.x.min).toBe(1)
    expect(s.x.max).toBe(3)
    expect(s.x.mean).toBeCloseTo(2)
    expect(s.name.numeric).toBe(false)
    expect(s.name.distinct).toBe(2)
  })

  test("isNumericLike", () => {
    expect(__testing.isNumericLike("1234")).toBe(true)
    expect(__testing.isNumericLike("1,234.5")).toBe(true)
    expect(__testing.isNumericLike("abc")).toBe(false)
    expect(__testing.isNumericLike("")).toBe(false)
  })
})

describe("tool.tabulate tool", () => {
  it.live("format ascii", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const ti = yield* TabulateTool
        const tool = yield* ti.init()
        const r = yield* tool.execute(
          { action: "format", rows: [{ a: 1, b: "x" }], format: "ascii" },
          baseCtx,
        )
        expect(r.metadata.rows).toBe(1)
        expect(r.output).toContain("a")
        expect(r.output).toContain("x")
      }),
    ),
  )

  it.live("parse_markdown", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const ti = yield* TabulateTool
        const tool = yield* ti.init()
        const r = yield* tool.execute(
          {
            action: "parse_markdown",
            text: "| a | b |\n|---|---|\n| 1 | 2 |\n",
          },
          baseCtx,
        )
        expect(r.metadata.parsed?.rows).toEqual([{ a: "1", b: "2" }])
      }),
    ),
  )

  it.live("summary", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const ti = yield* TabulateTool
        const tool = yield* ti.init()
        const r = yield* tool.execute(
          { action: "summary", rows: [{ x: 1 }, { x: 2 }, { x: 3 }] },
          baseCtx,
        )
        expect(r.metadata.summary?.x.numeric).toBe(true)
        expect(r.metadata.summary?.x.mean).toBe(2)
      }),
    ),
  )
})
