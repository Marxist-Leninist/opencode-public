import { describe, expect, test } from "bun:test"
import { __testing } from "../../src/server/routes/instance/robot"

describe("server.robot helpers", () => {
  test("canSendImages requires model image support and blocks known text-only routes", () => {
    expect(
      __testing.canSendImages("openrouter", "openai/gpt-5.5", {
        capabilities: { input: { image: true } },
      }),
    ).toBe(true)
    expect(
      __testing.canSendImages("openrouter", "openrouter/free", {
        capabilities: { input: { image: true } },
      }),
    ).toBe(false)
    expect(
      __testing.canSendImages("openrouter", "deepseek/deepseek-v4-pro", {
        capabilities: { input: { image: true } },
      }),
    ).toBe(false)
    expect(__testing.canSendImages("openrouter", "openai/gpt-5.5", { capabilities: { input: {} } })).toBe(false)
  })

  test("tryParseAction accepts prose-wrapped JSON and clamps unsafe deltas", () => {
    const action = __testing.tryParseAction(
      [
        "The next move is:",
        '{"baseDelta":22,"shoulderDelta":-30,"elbowDelta":4,"wristDelta":2,"gripper":"closed","reasoning":"target is large"}',
      ].join("\n"),
    )

    expect(action).toEqual({
      baseDelta: 15,
      shoulderDelta: -15,
      elbowDelta: 4,
      wristDelta: 2,
      gripper: "closed",
      reasoning: "target is large",
    })
  })

  test("stripDataUrl decodes data urls and raw base64", () => {
    const dataUrl = __testing.stripDataUrl(`data:text/plain;base64,${Buffer.from("hello").toString("base64")}`)
    expect(dataUrl.mediaType).toBe("text/plain")
    expect(Buffer.from(dataUrl.data).toString("utf8")).toBe("hello")

    const raw = __testing.stripDataUrl(Buffer.from("world").toString("base64"))
    expect(raw.mediaType).toBe("image/png")
    expect(Buffer.from(raw.data).toString("utf8")).toBe("world")
  })
})
