import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Agent } from "../../src/agent/agent"
import { MessageID, SessionID } from "../../src/session/schema"
import { Tool } from "../../src/tool"
import { SemverTool, __testing } from "../../src/tool/semver"
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

describe("tool.semver helpers", () => {
  test("parse strict + loose forms", () => {
    expect(__testing.parse("1.2.3")).toBeTruthy()
    expect(__testing.parse("v1.2.3")).toBeTruthy()
    expect(__testing.parse("1.2")?.patch).toBe(0)
    expect(__testing.parse("1")?.minor).toBe(0)
    expect(__testing.parse("not a version")).toBeNull()
    const p = __testing.parse("1.2.3-rc.1+build.42")!
    expect(p.prerelease).toEqual(["rc", 1])
    expect(p.build).toEqual(["build", "42"])
  })
  test("compare ordering", () => {
    expect(__testing.compare("1.2.3", "1.2.4")).toBe(-1)
    expect(__testing.compare("2.0.0", "1.99.0")).toBe(1)
    expect(__testing.compare("1.0.0", "1.0.0")).toBe(0)
  })
  test("prerelease ordering: pre < stable, numeric vs alpha", () => {
    expect(__testing.compare("1.0.0-alpha", "1.0.0")).toBe(-1)
    expect(__testing.compare("1.0.0-alpha.1", "1.0.0-alpha.2")).toBe(-1)
    expect(__testing.compare("1.0.0-alpha", "1.0.0-beta")).toBe(-1)
    expect(__testing.compare("1.0.0-rc.1", "1.0.0-rc.10")).toBe(-1)
  })
  test("satisfies caret/tilde/x-range", () => {
    expect(__testing.satisfies("1.2.3", "^1.0.0")).toBe(true)
    expect(__testing.satisfies("2.0.0", "^1.0.0")).toBe(false)
    expect(__testing.satisfies("1.2.5", "~1.2.3")).toBe(true)
    expect(__testing.satisfies("1.3.0", "~1.2.3")).toBe(false)
    expect(__testing.satisfies("1.4.0", "1.x")).toBe(true)
    expect(__testing.satisfies("2.0.0", "1.x")).toBe(false)
    expect(__testing.satisfies("1.5.0", ">=1.0 <2.0")).toBe(true)
    expect(__testing.satisfies("1.5.0", "1.0 - 2.0")).toBe(true)
    expect(__testing.satisfies("3.0.0", "1.x || 3.x")).toBe(true)
  })
  test("max/min satisfying", () => {
    const versions = ["1.0.0", "1.2.3", "1.9.9", "2.0.0"]
    expect(__testing.maxSatisfying(versions, "^1.0.0")).toBe("1.9.9")
    expect(__testing.minSatisfying(versions, "^1.0.0")).toBe("1.0.0")
    expect(__testing.maxSatisfying(versions, "^9.0.0")).toBeNull()
  })
  test("inc bumps", () => {
    expect(__testing.inc("1.2.3", "patch")).toBe("1.2.4")
    expect(__testing.inc("1.2.3", "minor")).toBe("1.3.0")
    expect(__testing.inc("1.2.3", "major")).toBe("2.0.0")
    expect(__testing.inc("1.2.3", "prerelease", "rc")).toBe("1.2.4-rc.0")
    expect(__testing.inc("1.2.4-rc.0", "prerelease")).toBe("1.2.4-rc.1")
    expect(__testing.inc("1.2.3", "premajor", "beta")).toBe("2.0.0-beta.0")
  })
  test("sort ascending and descending", () => {
    const v = ["1.10.0", "1.2.0", "0.9.0", "2.0.0-rc.1"]
    expect(__testing.sortVersions(v)).toEqual(["0.9.0", "1.2.0", "1.10.0", "2.0.0-rc.1"])
    expect(__testing.sortVersions(v, true)).toEqual(["2.0.0-rc.1", "1.10.0", "1.2.0", "0.9.0"])
  })
  test("coerce loose strings", () => {
    expect(__testing.coerce("v2026")).toBe("2026.0.0")
    expect(__testing.coerce("Release 1.2 final")).toBe("1.2.0")
    expect(__testing.coerce("nope")).toBeNull()
  })
})

describe("tool.semver tool", () => {
  it.live("parse returns components", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* SemverTool
        const tool = yield* toolInfo.init()
        const r = yield* tool.execute({ action: "parse", value: "1.2.3-rc.1" }, baseCtx)
        expect((r.metadata.parsed as any)?.major).toBe(1)
        expect((r.metadata.parsed as any)?.prerelease).toEqual(["rc", 1])
      }),
    ),
  )
  it.live("compare returns -1/0/1", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* SemverTool
        const tool = yield* toolInfo.init()
        const r = yield* tool.execute({ action: "compare", a: "1.2.3", b: "1.2.4" }, baseCtx)
        expect(r.metadata.result).toBe(-1)
      }),
    ),
  )
  it.live("max_satisfying picks the highest", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* SemverTool
        const tool = yield* toolInfo.init()
        const r = yield* tool.execute(
          { action: "max_satisfying", versions: ["1.0.0", "1.5.0", "2.0.0"], range: "^1.0.0" },
          baseCtx,
        )
        expect(r.metadata.result).toBe("1.5.0")
      }),
    ),
  )
  it.live("inc patch", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* SemverTool
        const tool = yield* toolInfo.init()
        const r = yield* tool.execute({ action: "inc", value: "1.2.3", release: "patch" }, baseCtx)
        expect(r.metadata.result).toBe("1.2.4")
      }),
    ),
  )
  it.live("sort desc", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* SemverTool
        const tool = yield* toolInfo.init()
        const r = yield* tool.execute(
          { action: "sort", versions: ["1.0.0", "2.0.0", "1.5.0"], desc: true },
          baseCtx,
        )
        expect(r.metadata.result).toEqual(["2.0.0", "1.5.0", "1.0.0"])
      }),
    ),
  )
})
