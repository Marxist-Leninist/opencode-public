import { Effect, Schema } from "effect"
import { spawn } from "node:child_process"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { InstanceState } from "@/effect"
import DESCRIPTION from "./screenshot.txt"
import * as Tool from "./tool"

const REGIONS = ["full", "primary", "active_window"] as const

export const Parameters = Schema.Struct({
  output_path: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2048))).annotate({
    description: "Absolute or project-relative path where the PNG will be saved. Default is a timestamped file in OS temp.",
  }),
  region: Schema.optional(Schema.Literals(REGIONS)).annotate({
    description: "Region to capture: full, primary (default), active_window.",
  }),
  delay_ms: Schema.optional(
    Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(10_000)),
  ).annotate({
    description: "Delay in ms before capture (0-10000).",
  }),
})

type Params = Schema.Schema.Type<typeof Parameters>
type Region = (typeof REGIONS)[number]

type Metadata = {
  platform: NodeJS.Platform
  backend: string
  region: Region
  delay_ms: number
  path?: string
  bytes?: number
  delivered: boolean
  error?: string
  exit_code?: number
}

const done = (result: Tool.ExecuteResult<Metadata>) => result

function runProcess(
  cmd: string,
  args: string[],
  signal: AbortSignal,
  timeoutMs = 30_000,
  stdin?: string,
): Promise<{ code: number | null; stderr: string; stdout: string }> {
  return new Promise((resolve) => {
    let settled = false
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true })
    const timer = setTimeout(() => {
      if (!settled) {
        try {
          child.kill()
        } catch {}
        settled = true
        resolve({ code: null, stderr: "timeout", stdout: "" })
      }
    }, timeoutMs)
    const onAbort = () => {
      try {
        child.kill()
      } catch {}
    }
    signal.addEventListener("abort", onAbort, { once: true })
    let stderr = ""
    let stdout = ""
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString()
    })
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString()
    })
    child.on("error", (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener("abort", onAbort)
      resolve({ code: null, stderr: err.message, stdout })
    })
    child.on("close", (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener("abort", onAbort)
      resolve({ code, stderr, stdout })
    })
    if (stdin !== undefined) {
      try {
        child.stdin?.end(stdin)
      } catch {}
    } else {
      try {
        child.stdin?.end()
      } catch {}
    }
  })
}

function defaultOutputPath(): string {
  const ts = new Date()
    .toISOString()
    .replace(/[:.]/g, "-")
    .replace("T", "_")
    .slice(0, 19)
  return path.join(os.tmpdir(), `opencode-sg-screenshot-${ts}.png`)
}

const psEscape = (s: string) => s.replace(/`/g, "``").replace(/\$/g, "`$").replace(/"/g, '`"')

function buildWindowsScript(outPath: string, region: Region): string {
  // Use Add-Type for System.Drawing + WindowFromPoint when needed.
  // We escape only `, $, ".  Backslashes in outPath are fine inside a PS string literal.
  const safe = psEscape(outPath)
  if (region === "active_window") {
    return `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class W {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L,T,R,B; }
}
"@
$h = [W]::GetForegroundWindow()
$r = New-Object W+RECT
[void][W]::GetWindowRect($h, [ref]$r)
$w = [Math]::Max(1, $r.R - $r.L)
$h2 = [Math]::Max(1, $r.B - $r.T)
$bmp = New-Object System.Drawing.Bitmap $w, $h2
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($r.L, $r.T, 0, 0, (New-Object System.Drawing.Size($w, $h2)))
$bmp.Save("${safe}", [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose()
$bmp.Dispose()
exit 0
`.trim()
  }
  if (region === "full") {
    return `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
$bmp.Save("${safe}", [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose()
$bmp.Dispose()
exit 0
`.trim()
  }
  // primary
  return `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap $screen.Width, $screen.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($screen.Location, [System.Drawing.Point]::Empty, $screen.Size)
$bmp.Save("${safe}", [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose()
$bmp.Dispose()
exit 0
`.trim()
}

async function captureWindows(outPath: string, region: Region, signal: AbortSignal) {
  const script = buildWindowsScript(outPath, region)
  const args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", "-"]
  return runProcess("powershell.exe", args, signal, 30_000, script)
}

async function captureMac(outPath: string, region: Region, signal: AbortSignal) {
  // -x: no sound. -t png: format. -m: main display only (primary).
  const args = ["-x", "-t", "png"]
  if (region === "primary") args.push("-m")
  // active_window on macOS would need WindowID lookup; emulate with -W (interactive window pick)
  // is bad for unattended runs, so we just use full-screen capture for active_window on macOS.
  args.push(outPath)
  return runProcess("screencapture", args, signal, 30_000)
}

async function captureLinuxOnce(
  cmd: string,
  args: string[],
  signal: AbortSignal,
): Promise<{ ok: boolean; code: number | null; stderr: string }> {
  const r = await runProcess(cmd, args, signal, 30_000)
  return { ok: r.code === 0, code: r.code, stderr: r.stderr }
}

async function captureLinux(outPath: string, _region: Region, signal: AbortSignal) {
  // Try grim (Wayland) first, then gnome-screenshot, then scrot.
  let last: { ok: boolean; code: number | null; stderr: string } | undefined
  for (const attempt of [
    { cmd: "grim", args: [outPath] },
    { cmd: "gnome-screenshot", args: ["-f", outPath] },
    { cmd: "scrot", args: [outPath] },
  ]) {
    const r = await captureLinuxOnce(attempt.cmd, attempt.args, signal)
    if (r.ok) return { code: r.code, stderr: r.stderr, stdout: "" }
    last = r
  }
  return { code: last?.code ?? null, stderr: last?.stderr ?? "no screenshot backend (grim/gnome-screenshot/scrot) available", stdout: "" }
}

export const ScreenshotTool = Tool.define(
  "screenshot",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Params, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const ins = yield* InstanceState.context
          const platform = process.platform
          const region: Region = params.region ?? "primary"
          const delay = params.delay_ms ?? 0

          const rawOut = params.output_path ?? defaultOutputPath()
          const outPath = path.isAbsolute(rawOut) ? rawOut : path.resolve(ins.directory, rawOut)

          // Make parent dir if missing.
          yield* Effect.promise(async () => {
            try {
              await fs.mkdir(path.dirname(outPath), { recursive: true })
            } catch {}
          })

          const backend =
            platform === "win32"
              ? "powershell-system-drawing"
              : platform === "darwin"
                ? "screencapture"
                : "grim/gnome-screenshot/scrot"

          yield* ctx.metadata({
            title: `screenshot ${region} -> ${path.basename(outPath)}`,
            metadata: {
              platform,
              backend,
              region,
              delay_ms: delay,
              path: outPath,
              delivered: false,
            },
          })

          if (delay > 0) {
            yield* Effect.promise(
              () =>
                new Promise<void>((resolve) => {
                  const t = setTimeout(resolve, delay)
                  ctx.abort.addEventListener(
                    "abort",
                    () => {
                      clearTimeout(t)
                      resolve()
                    },
                    { once: true },
                  )
                }),
            )
          }

          const result = yield* Effect.promise(async () => {
            try {
              if (platform === "win32") return await captureWindows(outPath, region, ctx.abort)
              if (platform === "darwin") return await captureMac(outPath, region, ctx.abort)
              return await captureLinux(outPath, region, ctx.abort)
            } catch (err: unknown) {
              const msg = err instanceof Error ? err.message : String(err)
              return { code: null as number | null, stderr: msg, stdout: "" }
            }
          })

          let bytes: number | undefined
          if (result.code === 0) {
            const stat = yield* Effect.promise(async () => {
              try {
                return await fs.stat(outPath)
              } catch {
                return undefined
              }
            })
            if (stat?.size) bytes = stat.size
          }

          const delivered = result.code === 0 && (bytes ?? 0) > 0
          const errMsg = !delivered ? (result.stderr.trim() || `exit=${result.code}`) : undefined

          return done({
            title: delivered
              ? `screenshot saved: ${path.basename(outPath)} (${bytes} bytes)`
              : `screenshot failed: ${path.basename(outPath)}`,
            metadata: {
              platform,
              backend,
              region,
              delay_ms: delay,
              path: outPath,
              bytes,
              delivered,
              exit_code: result.code ?? undefined,
              error: errMsg,
            },
            output: delivered
              ? `Saved ${region} screenshot (${bytes} bytes) to ${outPath} via ${backend}.`
              : `Screenshot not captured (${backend}, ${platform}). ${errMsg ?? ""} Continue without retrying.`,
          })
        }),
    }
  }),
)

export const __testing = { defaultOutputPath, psEscape, buildWindowsScript, runProcess }
