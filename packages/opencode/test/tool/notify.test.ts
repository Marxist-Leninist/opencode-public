import { describe, expect, test } from "bun:test"
import { __testing } from "../../src/tool/notify"

const { psEscape, shEscape, oscEscape, runProcess } = __testing

describe("notify escapers", () => {
  test("psEscape escapes PowerShell metacharacters", () => {
    expect(psEscape('Hello "world" $var `tick')).toBe('Hello `"world`" `$var ``tick')
  })

  test("shEscape produces a single-quoted shell literal", () => {
    expect(shEscape("it's fine")).toBe(`'it'\\''s fine'`)
    expect(shEscape("plain")).toBe("'plain'")
  })

  test("oscEscape escapes osascript double quotes and backslashes", () => {
    expect(oscEscape('a"b\\c')).toBe('a\\"b\\\\c')
  })

  test("psEscape leaves benign text untouched", () => {
    expect(psEscape("Hello world")).toBe("Hello world")
  })
})

describe("notify.runProcess", () => {
  test("captures exit code 0 from a simple command", async () => {
    const cmd = process.platform === "win32" ? "cmd.exe" : "true"
    const args = process.platform === "win32" ? ["/c", "exit 0"] : []
    const result = await runProcess(cmd, args, new AbortController().signal, 5000)
    expect(result.code).toBe(0)
  })

  test("reports a missing executable without throwing", async () => {
    const result = await runProcess("definitely-not-a-real-binary-xyz", [], new AbortController().signal, 2000)
    expect(result.code).toBeNull()
    expect(result.stderr.length).toBeGreaterThan(0)
  })

  test("respects abort signal", async () => {
    const ac = new AbortController()
    const cmd = process.platform === "win32" ? "powershell.exe" : "sleep"
    const args = process.platform === "win32" ? ["-Command", "Start-Sleep -Seconds 30"] : ["30"]
    const promise = runProcess(cmd, args, ac.signal, 30000)
    setTimeout(() => ac.abort(), 100)
    const result = await promise
    expect(result.code === null || result.code !== 0).toBe(true)
  })
})
