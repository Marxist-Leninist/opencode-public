import { describe, expect, test } from "bun:test"
import { EOL } from "os"
import { SG_NATIVE_TOOL_IDS, formatToolSmoke, smokeToolIDs } from "../../src/cli/cmd/debug/tools"

describe("debug tools smoke helpers", () => {
  test("filters to expected SG native tool ids and reports missing ids", () => {
    const result = smokeToolIDs(["bash", "json", "slug", "tree"], true)

    expect(result.ids).toEqual(["json", "slug", "tree"])
    expect(result.missing).toContain("pkce")
    expect(result.missing).not.toContain("json")
  })

  test("sorts full tool ids without SG missing checks", () => {
    expect(smokeToolIDs(["write", "bash", "read"], false)).toEqual({
      ids: ["bash", "read", "write"],
      missing: [],
    })
  })

  test("formats newline lists and JSON output", () => {
    const result = { ids: ["json", "slug"], missing: [] }

    expect(formatToolSmoke(result, false)).toBe(`json${EOL}slug${EOL}`)
    expect(JSON.parse(formatToolSmoke(result, true))).toEqual(result)
  })

  test("keeps the SG smoke list sorted for stable launched-binary checks", () => {
    expect([...SG_NATIVE_TOOL_IDS].toSorted()).toEqual([...SG_NATIVE_TOOL_IDS])
  })

  test("ids are unique - no accidental duplicate after a merge", () => {
    expect(new Set(SG_NATIVE_TOOL_IDS).size).toBe(SG_NATIVE_TOOL_IDS.length)
  })

  test("smoke list covers flagship and query helper SG tools", () => {
    // These are flagship SG additions; guard against regressing the smoke
    // list when adding new tools.
    expect(SG_NATIVE_TOOL_IDS).toContain("wait")
    expect(SG_NATIVE_TOOL_IDS).toContain("hash")
    expect(SG_NATIVE_TOOL_IDS).toContain("country")
    expect(SG_NATIVE_TOOL_IDS).toContain("jsonpath")
    expect(SG_NATIVE_TOOL_IDS).toContain("xpath")
  })
})
