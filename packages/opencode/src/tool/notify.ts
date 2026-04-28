import { Effect, Schema } from "effect"
import { spawn } from "node:child_process"
import DESCRIPTION from "./notify.txt"
import * as Tool from "./tool"

const URGENCIES = ["low", "normal", "critical"] as const

export const Parameters = Schema.Struct({
  title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120)).annotate({
    description: "Short headline (1-120 chars).",
  }),
  message: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(800)).annotate({
    description: "Body text (1-800 chars).",
  }),
  urgency: Schema.Literals(URGENCIES)
    .pipe(Schema.optional, Schema.withDecodingDefault(Effect.succeed("normal" as const)))
    .annotate({
      description: "Urgency: low, normal (default), or critical.",
    }),
  quiet: Schema.optional(Schema.Boolean).annotate({
    description: "If true, suppress notification sound where supported.",
  }),
})

type Params = Schema.Schema.Type<typeof Parameters>
type Urgency = (typeof URGENCIES)[number]

type Metadata = {
  platform: NodeJS.Platform
  backend: string
  urgency: Urgency
  quiet: boolean
  delivered: boolean
  exit_code?: number
  error?: string
}

const done = (result: Tool.ExecuteResult<Metadata>) => result

const psEscape = (s: string) => s.replace(/`/g, "``").replace(/\$/g, "`$").replace(/"/g, '`"')
const shEscape = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
const oscEscape = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')

function runProcess(
  cmd: string,
  args: string[],
  signal: AbortSignal,
  timeoutMs = 5000,
  stdin?: string,
): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    let settled = false
    const child = spawn(cmd, args, { stdio: ["pipe", "ignore", "pipe"], windowsHide: true })
    const timer = setTimeout(() => {
      if (!settled) {
        try {
          child.kill()
        } catch {}
        settled = true
        resolve({ code: null, stderr: "timeout" })
      }
    }, timeoutMs)
    const onAbort = () => {
      try {
        child.kill()
      } catch {}
    }
    signal.addEventListener("abort", onAbort, { once: true })
    let stderr = ""
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString()
    })
    child.on("error", (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener("abort", onAbort)
      resolve({ code: null, stderr: err.message })
    })
    child.on("close", (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener("abort", onAbort)
      resolve({ code, stderr })
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

async function notifyWindows(title: string, message: string, urgency: Urgency, quiet: boolean, signal: AbortSignal) {
  const scenario = urgency === "critical" ? "alarm" : "default"
  const audio = quiet
    ? "<audio silent='true' />"
    : urgency === "critical"
      ? "<audio src='ms-winsoundevent:Notification.Looping.Alarm' />"
      : "<audio src='ms-winsoundevent:Notification.Default' />"
  const xml = `<toast scenario='${scenario}'><visual><binding template='ToastGeneric'><text>${psEscape(title)}</text><text>${psEscape(message)}</text></binding></visual>${audio}</toast>`
  const script = `
$ErrorActionPreference = 'Stop'
try {
  [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime] | Out-Null
  [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType=WindowsRuntime] | Out-Null
  $xml = New-Object Windows.Data.Xml.Dom.XmlDocument
  $xml.LoadXml("${psEscape(xml)}")
  $toast = New-Object Windows.UI.Notifications.ToastNotification $xml
  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('OpenCode SG').Show($toast)
  exit 0
} catch {
  Write-Error $_
  exit 1
}
`.trim()
  const args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", "-"]
  return runProcess("powershell.exe", args, signal, 8000, script)
}

async function notifyLinux(title: string, message: string, urgency: Urgency, quiet: boolean, signal: AbortSignal) {
  const args = ["-u", urgency, "-a", "OpenCode SG"]
  if (quiet) args.push("--hint=string:suppress-sound:true")
  args.push(title, message)
  return runProcess("notify-send", args, signal, 5000)
}

async function notifyMac(title: string, message: string, urgency: Urgency, quiet: boolean, signal: AbortSignal) {
  const sound = quiet ? "" : urgency === "critical" ? ' sound name "Sosumi"' : ' sound name "Glass"'
  const script = `display notification "${oscEscape(message)}" with title "${oscEscape(title)}"${sound}`
  return runProcess("osascript", ["-e", script], signal, 5000)
}

export const NotifyTool = Tool.define(
  "notify",
  Effect.succeed({
    description: DESCRIPTION,
    parameters: Parameters,
    execute: (params: Params, ctx: Tool.Context<Metadata>) =>
      Effect.gen(function* () {
        const urgency = params.urgency ?? "normal"
        const quiet = params.quiet ?? false
        const platform = process.platform

        yield* ctx.metadata({
          title: `notify: ${params.title}`,
          metadata: {
            platform,
            backend: platform === "win32" ? "powershell-toast" : platform === "darwin" ? "osascript" : "notify-send",
            urgency,
            quiet,
            delivered: false,
          },
        })

        const backend = platform === "win32" ? "powershell-toast" : platform === "darwin" ? "osascript" : "notify-send"
        const result = yield* Effect.promise(async () => {
          try {
            if (platform === "win32")
              return await notifyWindows(params.title, params.message, urgency, quiet, ctx.abort)
            if (platform === "darwin") return await notifyMac(params.title, params.message, urgency, quiet, ctx.abort)
            return await notifyLinux(params.title, params.message, urgency, quiet, ctx.abort)
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err)
            return { code: null as number | null, stderr: msg }
          }
        })

        const delivered = result.code === 0
        const errMsg = !delivered ? (result.stderr.trim() || `exit=${result.code}`) : undefined

        return done({
          title: delivered ? `notified: ${params.title}` : `notify failed: ${params.title}`,
          metadata: {
            platform,
            backend,
            urgency,
            quiet,
            delivered,
            exit_code: result.code ?? undefined,
            error: errMsg,
          },
          output: delivered
            ? `Sent ${urgency} notification via ${backend}: ${params.title}\n  body: ${params.message}`
            : `Notification not delivered (${backend}, ${platform}). ${errMsg ?? ""}\n  Title was: ${params.title}\n  Message was: ${params.message}\n  Continue without retrying.`,
        })
      }),
  }),
)

export const __testing = { psEscape, shEscape, oscEscape, runProcess }
