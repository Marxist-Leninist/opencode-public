import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Agent } from "../../src/agent/agent"
import { MessageID, SessionID } from "../../src/session/schema"
import { Tool } from "../../src/tool"
import { CsvTool, __testing } from "../../src/tool/csv"
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

describe("tool.csv helpers", () => {
  test("parseCsv handles RFC 4180 quoted fields and embedded newlines", () => {
    const text = `name,note\nalice,"hello, world"\nbob,"line1\nline2"\ncar,"she said ""hi"""\n`
    const rows = __testing.parseCsv(text)
    expect(rows).toEqual([
      ["name", "note"],
      ["alice", "hello, world"],
      ["bob", "line1\nline2"],
      ["car", 'she said "hi"'],
    ])
  })

  test("parseCsv handles tab delimiter and trim", () => {
    const text = " a\tb \n 1\t 2 "
    const rows = __testing.parseCsv(text, { delimiter: "\t", trim: true })
    expect(rows).toEqual([
      ["a", "b"],
      ["1", "2"],
    ])
  })

  test("parseCsv handles CRLF and trailing blank line", () => {
    const text = "a,b\r\n1,2\r\n"
    const rows = __testing.parseCsv(text)
    expect(rows).toEqual([
      ["a", "b"],
      ["1", "2"],
    ])
  })

  test("generateCsv from objects emits header", () => {
    const out = __testing.generateCsv([
      { name: "alice", age: 30 },
      { name: "bob", age: 25 },
    ])
    expect(out.text).toBe("name,age\nalice,30\nbob,25\n")
    expect(out.header).toEqual(["name", "age"])
  })

  test("generateCsv quotes fields with delimiter or quote", () => {
    const out = __testing.generateCsv([{ msg: 'hello, "world"' }])
    expect(out.text).toBe(`msg\n"hello, ""world"""\n`)
  })

  test("generateCsv from arrays without header by default", () => {
    const out = __testing.generateCsv([
      [1, 2],
      [3, 4],
    ])
    expect(out.text).toBe("1,2\n3,4\n")
    expect(out.header).toEqual([])
  })

  test("escapeField escapes embedded newlines", () => {
    const out = __testing.escapeField("a\nb", ",", '"')
    expect(out).toBe('"a\nb"')
  })
})

describe("tool.csv tool", () => {
  it.live("parses inline CSV with header into objects", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* CsvTool
        const tool = yield* toolInfo.init()
        const result = yield* tool.execute(
          { action: "parse", content: "name,age\nalice,30\nbob,25\n" },
          baseCtx,
        )
        expect(result.metadata.rows).toBe(2)
        expect(result.metadata.columns).toBe(2)
        expect(result.metadata.header).toEqual(["name", "age"])
        const parsed = JSON.parse(result.output)
        expect(parsed).toEqual([
          { name: "alice", age: "30" },
          { name: "bob", age: "25" },
        ])
      }),
    ),
  )

  it.live("info returns shape without serializing rows", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* CsvTool
        const tool = yield* toolInfo.init()
        const result = yield* tool.execute(
          { action: "info", content: "a,b,c\n1,2,3\n4,5,6\n" },
          baseCtx,
        )
        expect(result.metadata.rows).toBe(2)
        expect(result.metadata.columns).toBe(3)
        expect(result.output).toContain("rows: 2")
        expect(result.output).toContain("columns: 3")
      }),
    ),
  )

  it.live("generate emits CSV from JSON array of objects", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* CsvTool
        const tool = yield* toolInfo.init()
        const result = yield* tool.execute(
          {
            action: "generate",
            content: JSON.stringify([
              { x: 1, y: "a" },
              { x: 2, y: "b" },
            ]),
          },
          baseCtx,
        )
        expect(result.output.trim()).toBe("x,y\n1,a\n2,b")
      }),
    ),
  )

  it.live("limit caps parsed rows", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* CsvTool
        const tool = yield* toolInfo.init()
        const result = yield* tool.execute(
          {
            action: "parse",
            content: "a\n1\n2\n3\n4\n5\n",
            limit: 2,
          },
          baseCtx,
        )
        expect(result.metadata.truncated).toBe(true)
        const parsed = JSON.parse(result.output)
        expect(parsed.length).toBe(2)
      }),
    ),
  )

  it.live("rejects mixed-shape generate input", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* CsvTool
        const tool = yield* toolInfo.init()
        const exit = yield* Effect.exit(
          tool.execute({ action: "generate", content: '[{"a":1},[1,2]]' }, baseCtx),
        )
        expect(exit._tag).toBe("Failure")
      }),
    ),
  )
})
