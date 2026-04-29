import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Agent } from "../../src/agent/agent"
import { MessageID, SessionID } from "../../src/session/schema"
import { Tool } from "../../src/tool"
import { IniTool, __testing } from "../../src/tool/ini"
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

describe("tool.ini helpers", () => {
  test("parse simple INI", () => {
    const r = __testing.parseINI(`
[server]
host = localhost
port = 8080

[client]
timeout: 30
`)
    expect(r.server!.host).toBe("localhost")
    expect(r.server!.port).toBe("8080")
    expect(r.client!.timeout).toBe("30")
  })
  test("parse with coerce_numbers", () => {
    const r = __testing.parseINI(`
[s]
a = 5
b = true
c = hello
`, { coerceNumbers: true })
    expect(r.s!.a).toBe(5)
    expect(r.s!.b).toBe(true)
    expect(r.s!.c).toBe("hello")
  })
  test("parse strips quotes and comments", () => {
    const r = __testing.parseINI(`
# top-level comment
[s]
; section comment
quoted = "  hello  "
single = 'world'
`)
    expect(r.s!.quoted).toBe("  hello  ")
    expect(r.s!.single).toBe("world")
  })
  test("stringify roundtrip", () => {
    const obj = {
      "": { top: "1" },
      s: { a: "b", c: "d" },
    }
    const text = __testing.stringifyINI(obj)
    expect(text).toContain("top = 1")
    expect(text).toContain("[s]")
    expect(text).toContain("a = b")
    const parsed = __testing.parseINI(text)
    expect(parsed.s!.a).toBe("b")
  })
})

describe("tool.ini tool", () => {
  it.live("parse via tool", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const ti = yield* IniTool
        const tool = yield* ti.init()
        const r = yield* tool.execute(
          { action: "parse", value: "[s]\nk = v\n" },
          baseCtx,
        )
        const obj = JSON.parse(r.output)
        expect(obj.s.k).toBe("v")
      }),
    ),
  )
  it.live("stringify via tool", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const ti = yield* IniTool
        const tool = yield* ti.init()
        const r = yield* tool.execute(
          { action: "stringify", data: { server: { host: "localhost" } } },
          baseCtx,
        )
        expect(r.output).toContain("[server]")
        expect(r.output).toContain("host = localhost")
      }),
    ),
  )
})
