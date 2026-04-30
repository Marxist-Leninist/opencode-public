import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Agent } from "../../src/agent/agent"
import { MessageID, SessionID } from "../../src/session/schema"
import { Tool } from "../../src/tool"
import { PkceTool, __testing } from "../../src/tool/pkce"
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

const RFC_VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
const RFC_CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"

describe("tool.pkce helpers", () => {
  test("deriveChallenge matches the RFC 7636 S256 example", () => {
    expect(__testing.deriveChallenge(RFC_VERIFIER, "S256")).toBe(RFC_CHALLENGE)
    expect(__testing.deriveChallenge(RFC_VERIFIER, "plain")).toBe(RFC_VERIFIER)
  })

  test("randomVerifier respects the verifier alphabet and length", () => {
    const verifier = __testing.randomVerifier(64)
    expect(verifier).toHaveLength(64)
    expect(__testing.VERIFIER_RE.test(verifier)).toBe(true)
    expect(__testing.entropyBitsOfVerifier(64)).toBeGreaterThan(380)
  })

  test("constantTimeEq returns true only for equal strings", () => {
    expect(__testing.constantTimeEq("abc", "abc")).toBe(true)
    expect(__testing.constantTimeEq("abc", "abd")).toBe(false)
    expect(__testing.constantTimeEq("abc", "abcd")).toBe(false)
  })
})

describe("tool.pkce tool", () => {
  it.live("challenge derives the expected S256 challenge", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* PkceTool
        const tool = yield* toolInfo.init()
        const result = yield* tool.execute({ action: "challenge", code_verifier: RFC_VERIFIER }, baseCtx)
        expect(result.output).toBe(RFC_CHALLENGE)
        expect(result.metadata.code_challenge_method).toBe("S256")
      }),
    ),
  )

  it.live("verify reports matching and non-matching challenges", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const toolInfo = yield* PkceTool
        const tool = yield* toolInfo.init()
        const ok = yield* tool.execute(
          { action: "verify", code_verifier: RFC_VERIFIER, code_challenge: RFC_CHALLENGE },
          baseCtx,
        )
        const fail = yield* tool.execute(
          { action: "verify", code_verifier: RFC_VERIFIER, code_challenge: "wrong" },
          baseCtx,
        )
        expect(ok.metadata.match).toBe(true)
        expect(fail.metadata.match).toBe(false)
      }),
    ),
  )
})
