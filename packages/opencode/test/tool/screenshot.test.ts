import { describe, expect, test } from "bun:test"
import { __testing } from "../../src/tool/screenshot"

const { defaultOutputPath, psEscape, buildWindowsScript, runProcess } = __testing

describe("screenshot helpers", () => {
  test("defaultOutputPath returns timestamped PNG in OS temp", () => {
    const p = defaultOutputPath()
    expect(p).toMatch(/opencode-sg-screenshot-/)
    expect(p.endsWith(".png")).toBe(true)
  })

  test("psEscape escapes PowerShell metacharacters", () => {
    expect(psEscape('Hi "x" $a `b')).toBe('Hi `"x`" `$a ``b')
  })

  test("buildWindowsScript embeds the output path inside double quotes", () => {
    const script = buildWindowsScript("C:/tmp/shot.png", "primary")
    expect(script).toContain('"C:/tmp/shot.png"')
    expect(script).toContain("PrimaryScreen")
  })

  test("buildWindowsScript switches on region", () => {
    expect(buildWindowsScript("C:/tmp/x.png", "full")).toContain("VirtualScreen")
    expect(buildWindowsScript("C:/tmp/x.png", "active_window")).toContain("GetForegroundWindow")
    expect(buildWindowsScript("C:/tmp/x.png", "primary")).toContain("PrimaryScreen")
  })

  test("buildWindowsScript escapes paths with backticks/dollar/quote", () => {
    const ugly = `C:/tmp/x"$a\`b.png`
    const s = buildWindowsScript(ugly, "primary")
    // The escaped path must appear inside the script literally as PS-escaped form.
    expect(s).toContain('`"')
    expect(s).toContain("`$a")
    // The double-backtick is the PS escape for a backtick.
    expect(s).toContain("``b")
  })
})

describe("screenshot.runProcess basic shape", () => {
  test("captures exit code 0 from a trivial command", async () => {
    const cmd = process.platform === "win32" ? "cmd.exe" : "true"
    const args = process.platform === "win32" ? ["/c", "exit 0"] : []
    const result = await runProcess(cmd, args, new AbortController().signal, 5000)
    expect(result.code).toBe(0)
  })

  test("reports stderr for a missing executable without throwing", async () => {
    const result = await runProcess(
      "definitely-not-a-real-screenshot-binary-xyz",
      [],
      new AbortController().signal,
      2000,
    )
    expect(result.code).toBeNull()
    expect(result.stderr.length).toBeGreaterThan(0)
  })
})
