import { describe, expect, test } from "bun:test"
import { EOL } from "os"
import { evaluateDoctorSmoke, formatDoctorSmoke, parseWindowsCmdExeTarget } from "../../src/cli/cmd/debug/doctor"
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
    expect(SG_NATIVE_TOOL_IDS).toContain("kv")
    expect(SG_NATIVE_TOOL_IDS).toContain("lockfile")
  })
})

describe("debug doctor smoke helpers", () => {
  test("parses direct and variable based Windows launcher targets", () => {
    expect(parseWindowsCmdExeTarget('@echo off\n"C:\\sg\\opencode.exe" %*\n')).toBe("C:\\sg\\opencode.exe")
    expect(parseWindowsCmdExeTarget('set "OPENCODE_SG_EXE=C:\\sg gui\\OpenCode Dev.exe"\nstart "" "%OPENCODE_SG_EXE%"')).toBe(
      "C:\\sg gui\\OpenCode Dev.exe",
    )
  })

  test("evaluates a passing launched SG binary smoke result", () => {
    const result = evaluateDoctorSmoke({
      version: "0.0.0-sg/preferences-block-202605010200",
      execPath: "C:\\repo\\packages\\opencode\\dist\\opencode-windows-x64\\bin\\opencode.exe",
      toolIDs: [...SG_NATIVE_TOOL_IDS],
      permissionMode: "allow",
      launchers: [
        {
          id: "cli_launcher",
          path: "C:\\Users\\User\\.opencode\\bin\\opencode-sg.cmd",
          exists: true,
          target: "C:\\repo\\packages\\opencode\\dist\\opencode-windows-x64\\bin\\opencode.exe",
          target_exists: true,
          target_matches_exec: true,
        },
        {
          id: "gui_launcher",
          path: "C:\\Users\\User\\.opencode\\bin\\opencode-sg-gui.cmd",
          exists: true,
          target: "C:\\repo\\packages\\desktop-electron\\dist-sg\\OpenCode Dev.exe",
          target_exists: true,
        },
      ],
    })

    expect(result.ok).toBe(true)
    expect(result.missing_tools).toEqual([])
    expect(JSON.parse(formatDoctorSmoke(result, true))).toEqual(result)
    expect(formatDoctorSmoke(result, false)).toContain("SG doctor smoke: OK")
  })

  test("fails when SG branding, native tools, or launcher targets are missing", () => {
    const result = evaluateDoctorSmoke({
      version: "0.0.0",
      execPath: "C:\\repo\\opencode.exe",
      toolIDs: ["wait"],
      launchers: [
        {
          id: "cli_launcher",
          path: "C:\\Users\\User\\.opencode\\bin\\opencode-sg.cmd",
          exists: true,
          target: "C:\\repo\\missing.exe",
          target_exists: false,
        },
      ],
    })

    expect(result.ok).toBe(false)
    expect(result.checks.find((check) => check.id === "version")?.ok).toBe(false)
    expect(result.checks.find((check) => check.id === "native_tools")?.ok).toBe(false)
    expect(result.checks.find((check) => check.id === "cli_launcher")?.detail).toContain("target missing")
  })
})
