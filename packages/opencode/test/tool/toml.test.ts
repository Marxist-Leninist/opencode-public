import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Agent } from "../../src/agent/agent"
import { MessageID, SessionID } from "../../src/session/schema"
import { Tool } from "../../src/tool"
import { TomlTool, __testing } from "../../src/tool/toml"
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

describe("tool.toml helpers", () => {
  test("parse top-level scalars and tables", () => {
    const r = __testing.parseTOML(`
name = "opencode"
version = "1.0.0"
debug = true
port = 8080
ratio = 1.5
list = [1, 2, 3]

[deps]
effect = "3.0.0"
zod = "3.22.0"
`)
    expect(r.name).toBe("opencode")
    expect(r.debug).toBe(true)
    expect(r.port).toBe(8080)
    expect(r.ratio).toBe(1.5)
    expect(r.list).toEqual([1, 2, 3])
    expect((r.deps as any).effect).toBe("3.0.0")
  })
  test("parse nested tables and array of tables", () => {
    const r = __testing.parseTOML(`
[a.b.c]
x = 1

[[items]]
name = "one"

[[items]]
name = "two"
`)
    expect(((r.a as any).b as any).c.x).toBe(1)
    expect((r.items as any).length).toBe(2)
    expect((r.items as any)[0].name).toBe("one")
  })
  test("parse hex/oct/bin and inf/nan", () => {
    const r = __testing.parseTOML(`
hex = 0xff
oct = 0o77
bin = 0b101
big = 1_000_000
posinf = inf
neginf = -inf
`)
    expect(r.hex).toBe(255)
    expect(r.oct).toBe(63)
    expect(r.bin).toBe(5)
    expect(r.big).toBe(1_000_000)
    expect(r.posinf).toBe(Infinity)
    expect(r.neginf).toBe(-Infinity)
  })
  test("stringify roundtrip", () => {
    const obj = { name: "opencode", count: 7, deps: { effect: "3.0.0" } }
    const s = __testing.stringifyTOML(obj)
    const parsed = __testing.parseTOML(s)
    expect(parsed).toEqual(obj as any)
  })
  test("stringify array-of-tables", () => {
    const obj = { items: [{ name: "a" }, { name: "b" }] }
    const s = __testing.stringifyTOML(obj)
    expect(s).toContain("[[items]]")
    const parsed = __testing.parseTOML(s)
    expect(parsed).toEqual(obj as any)
  })
})

describe("tool.toml tool", () => {
  it.live("parse via tool", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const ti = yield* TomlTool
        const tool = yield* ti.init()
        const r = yield* tool.execute(
          { action: "parse", value: 'name = "opencode"\nversion = "1.0.0"' },
          baseCtx,
        )
        const obj = JSON.parse(r.output)
        expect(obj.name).toBe("opencode")
      }),
    ),
  )
  it.live("stringify via tool", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const ti = yield* TomlTool
        const tool = yield* ti.init()
        const r = yield* tool.execute({ action: "stringify", data: { name: "opencode" } }, baseCtx)
        expect(r.output).toContain('name = "opencode"')
      }),
    ),
  )
})
