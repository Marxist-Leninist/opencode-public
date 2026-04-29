import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Agent } from "../../src/agent/agent"
import { MessageID, SessionID } from "../../src/session/schema"
import { Tool } from "../../src/tool"
import { EnvTool, __testing as envTesting } from "../../src/tool/env"
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

describe("tool.env", () => {
  it.live("get returns the value of a set variable", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        process.env.OC_TEST_ENV_VALUE = "hello-world"
        const toolInfo = yield* EnvTool
        const tool = yield* toolInfo.init()
        const result = yield* tool.execute({ action: "get", name: "OC_TEST_ENV_VALUE" }, baseCtx)
        expect(result.metadata.set).toBe(true)
        expect(result.metadata.value).toBe("hello-world")
        expect(result.output).toBe("hello-world")
        delete process.env.OC_TEST_ENV_VALUE
      }),
    ),
  )

  it.live("get on an unset variable returns null and reports not set", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        delete process.env.OC_TEST_UNSET_NAME
        const toolInfo = yield* EnvTool
        const tool = yield* toolInfo.init()
        const result = yield* tool.execute({ action: "get", name: "OC_TEST_UNSET_NAME" }, baseCtx)
        expect(result.metadata.set).toBe(false)
        expect(result.metadata.value).toBeNull()
        expect(result.title).toContain("not set")
      }),
    ),
  )

  it.live("has returns boolean only", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        process.env.OC_TEST_HAS = "anything"
        const toolInfo = yield* EnvTool
        const tool = yield* toolInfo.init()
        const got = yield* tool.execute({ action: "has", name: "OC_TEST_HAS" }, baseCtx)
        const missing = yield* tool.execute({ action: "has", name: "OC_TEST_HAS_NOT" }, baseCtx)
        expect(got.output).toBe("true")
        expect(missing.output).toBe("false")
        delete process.env.OC_TEST_HAS
      }),
    ),
  )

  it.live("list with name_pattern filters case-insensitively", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        process.env.OC_FILTER_ALPHA = "1"
        process.env.OC_FILTER_BETA = "2"
        process.env.OC_OTHER = "3"
        const toolInfo = yield* EnvTool
        const tool = yield* toolInfo.init()
        const result = yield* tool.execute({ action: "list", name_pattern: "filter" }, baseCtx)
        const names = (result.metadata.entries ?? []).map((e) => e.name)
        expect(names).toContain("OC_FILTER_ALPHA")
        expect(names).toContain("OC_FILTER_BETA")
        expect(names).not.toContain("OC_OTHER")
        delete process.env.OC_FILTER_ALPHA
        delete process.env.OC_FILTER_BETA
        delete process.env.OC_OTHER
      }),
    ),
  )

  it.live("list defaults to omitting values", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        process.env.OC_LIST_DEFAULT = "should-not-appear-by-default"
        const toolInfo = yield* EnvTool
        const tool = yield* toolInfo.init()
        const result = yield* tool.execute(
          { action: "list", name_pattern: "OC_LIST_DEFAULT" },
          baseCtx,
        )
        const entry = (result.metadata.entries ?? []).find((e) => e.name === "OC_LIST_DEFAULT")
        expect(entry).toBeDefined()
        expect(entry!.value).toBeUndefined()
        delete process.env.OC_LIST_DEFAULT
      }),
    ),
  )

  it.live("list with include_values masks secret-looking names", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        process.env.OC_TEST_API_KEY = "supersecret123"
        process.env.OC_TEST_PUBLIC = "harmless"
        const toolInfo = yield* EnvTool
        const tool = yield* toolInfo.init()
        const result = yield* tool.execute(
          { action: "list", name_pattern: "OC_TEST_", include_values: true },
          baseCtx,
        )
        const entries = result.metadata.entries ?? []
        const apiKey = entries.find((e) => e.name === "OC_TEST_API_KEY")
        const pub = entries.find((e) => e.name === "OC_TEST_PUBLIC")
        expect(apiKey?.value).toBe("***")
        expect(apiKey?.secret).toBe(true)
        expect(pub?.value).toBe("harmless")
        delete process.env.OC_TEST_API_KEY
        delete process.env.OC_TEST_PUBLIC
      }),
    ),
  )

  it.live("list with mask_secrets=false reveals the secret value", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        process.env.OC_TEST_TOKEN = "raw-token-456"
        const toolInfo = yield* EnvTool
        const tool = yield* toolInfo.init()
        const result = yield* tool.execute(
          {
            action: "list",
            name_pattern: "OC_TEST_TOKEN",
            include_values: true,
            mask_secrets: false,
          },
          baseCtx,
        )
        const entry = (result.metadata.entries ?? []).find((e) => e.name === "OC_TEST_TOKEN")
        expect(entry?.value).toBe("raw-token-456")
        delete process.env.OC_TEST_TOKEN
      }),
    ),
  )

  it.live("match returns names matching a regex", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        process.env.OC_RE_HTTP_PROXY = "1"
        process.env.OC_RE_HTTPS_PROXY = "2"
        process.env.OC_RE_NO_PROXY = "3"
        process.env.OC_RE_NOT_RELATED = "4"
        const toolInfo = yield* EnvTool
        const tool = yield* toolInfo.init()
        const result = yield* tool.execute(
          { action: "match", pattern: "^OC_RE_(HTTP|HTTPS|NO)_PROXY$" },
          baseCtx,
        )
        const names = (result.metadata.entries ?? []).map((e) => e.name).sort()
        expect(names).toEqual(["OC_RE_HTTPS_PROXY", "OC_RE_HTTP_PROXY", "OC_RE_NO_PROXY"])
        delete process.env.OC_RE_HTTP_PROXY
        delete process.env.OC_RE_HTTPS_PROXY
        delete process.env.OC_RE_NO_PROXY
        delete process.env.OC_RE_NOT_RELATED
      }),
    ),
  )

  it.live("match rejects an invalid regex", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* EnvTool
        const tool = yield* toolInfo.init()
        const exit = yield* Effect.exit(tool.execute({ action: "match", pattern: "[unterminated" }, baseCtx))
        expect(exit._tag).toBe("Failure")
      }),
    ),
  )
})

describe("tool.env helpers", () => {
  it.live("isSecretName classifies common keywords", () =>
    Effect.sync(() => {
      expect(envTesting.isSecretName("FOO_API_KEY")).toBe(true)
      expect(envTesting.isSecretName("FOO_PASSWORD")).toBe(true)
      expect(envTesting.isSecretName("FOO_AUTH")).toBe(true)
      expect(envTesting.isSecretName("FOO_SESSION")).toBe(true)
      expect(envTesting.isSecretName("PATH")).toBe(false)
      expect(envTesting.isSecretName("HOME")).toBe(false)
    }),
  )

  it.live("maskValue keeps non-secret values intact", () =>
    Effect.sync(() => {
      expect(envTesting.maskValue("hello", "FOO", true)).toBe("hello")
      expect(envTesting.maskValue("hello", "FOO_API_KEY", true)).toBe("***")
      expect(envTesting.maskValue("hello", "FOO_API_KEY", false)).toBe("hello")
      expect(envTesting.maskValue("", "FOO_API_KEY", true)).toBe("")
    }),
  )
})
