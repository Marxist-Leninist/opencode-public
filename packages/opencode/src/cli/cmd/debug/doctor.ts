import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { EOL } from "os"
import path from "path"
import { readFile, stat } from "node:fs/promises"
import { AppRuntime } from "@/effect/app-runtime"
import { ToolRegistry } from "../../../tool"
import { bootstrap } from "../../bootstrap"
import { cmd } from "../cmd"
import { smokeToolIDs } from "./tools"

type LauncherProbe = {
  id: "cli_launcher" | "gui_launcher"
  path: string
  exists: boolean
  target?: string
  target_exists?: boolean
  target_matches_exec?: boolean
}

type DoctorCheck = {
  id: string
  ok: boolean
  detail: string
}

type DoctorResult = {
  ok: boolean
  version: string
  exec_path: string
  checks: DoctorCheck[]
  missing_tools: string[]
  launchers: LauncherProbe[]
}

const exists = (file: string) =>
  stat(file).then(
    () => true,
    () => false,
  )

const comparePath = (value: string) => path.resolve(value).toLowerCase()

export function parseWindowsCmdExeTarget(text: string) {
  const fromVar = text.match(/^\s*set\s+"?OPENCODE_SG_EXE=([^"\r\n]+)"?/im)?.[1]?.trim()
  if (fromVar) return fromVar
  return text.match(/"([^"\r\n]*\.exe)"/i)?.[1]
}

async function inspectLauncher(id: LauncherProbe["id"], file: string, execPath: string): Promise<LauncherProbe> {
  const present = await exists(file)
  if (!present) return { id, path: file, exists: false }

  const target = parseWindowsCmdExeTarget(await readFile(file, "utf8"))
  if (!target) return { id, path: file, exists: true }

  const targetExists = await exists(target)
  return {
    id,
    path: file,
    exists: true,
    target,
    target_exists: targetExists,
    target_matches_exec: comparePath(target) === comparePath(execPath),
  }
}

async function inspectDefaultLaunchers(execPath: string) {
  const home = process.env.USERPROFILE ?? process.env.HOME
  if (!home || process.platform !== "win32") return []
  const bin = path.join(home, ".opencode", "bin")
  return await Promise.all([
    inspectLauncher("cli_launcher", path.join(bin, "opencode-sg.cmd"), execPath),
    inspectLauncher("gui_launcher", path.join(bin, "opencode-sg-gui.cmd"), execPath),
  ])
}

export function evaluateDoctorSmoke(input: {
  version: string
  execPath: string
  toolIDs: string[]
  permissionMode?: string
  launchers: LauncherProbe[]
}) {
  const toolSmoke = smokeToolIDs(input.toolIDs, true)
  const versionOk = input.version.includes("-sg/")
  const checks: DoctorCheck[] = [
    {
      id: "version",
      ok: versionOk,
      detail: versionOk ? input.version : `${input.version} (missing SG build marker)`,
    },
    {
      id: "native_tools",
      ok: toolSmoke.missing.length === 0,
      detail: toolSmoke.missing.length
        ? `missing ${toolSmoke.missing.join(", ")}`
        : `${toolSmoke.ids.length} SG native tools registered`,
    },
    {
      id: "permission_mode",
      ok: true,
      detail: input.permissionMode ? `OPENCODE_SG_PERMISSION_MODE=${input.permissionMode}` : "not set",
    },
    ...input.launchers.map((launcher): DoctorCheck => {
      if (!launcher.exists) {
        return {
          id: launcher.id,
          ok: false,
          detail: `launcher missing: ${launcher.path}`,
        }
      }
      if (!launcher.target) {
        return {
          id: launcher.id,
          ok: false,
          detail: `launcher target not detected: ${launcher.path}`,
        }
      }
      if (!launcher.target_exists) {
        return {
          id: launcher.id,
          ok: false,
          detail: `target missing: ${launcher.target}`,
        }
      }
      if (launcher.id === "cli_launcher" && path.basename(input.execPath).toLowerCase() === "opencode.exe") {
        return {
          id: launcher.id,
          ok: launcher.target_matches_exec === true,
          detail: launcher.target_matches_exec ? `targets running binary: ${launcher.target}` : `target differs: ${launcher.target}`,
        }
      }
      return {
        id: launcher.id,
        ok: true,
        detail: `target exists: ${launcher.target}`,
      }
    }),
  ]

  return {
    ok: checks.every((check) => check.ok),
    version: input.version,
    exec_path: input.execPath,
    checks,
    missing_tools: toolSmoke.missing,
    launchers: input.launchers,
  } satisfies DoctorResult
}

export function formatDoctorSmoke(result: DoctorResult, json: boolean) {
  if (json) return JSON.stringify(result, null, 2) + EOL
  return [
    `SG doctor smoke: ${result.ok ? "OK" : "FAIL"}`,
    ...result.checks.map((check) => `  ${check.id.padEnd(16)} ${check.ok ? "OK" : "FAIL"} - ${check.detail}`),
  ].join(EOL) + EOL
}

export const DoctorCommand = cmd({
  command: "doctor",
  describe: "run local SG binary smoke checks",
  builder: (yargs) =>
    yargs
      .option("check", {
        type: "boolean",
        describe: "exit non-zero if any SG smoke check fails",
      })
      .option("json", {
        type: "boolean",
        describe: "print JSON output",
      }),
  async handler(args) {
    await bootstrap(process.cwd(), async () => {
      const result = evaluateDoctorSmoke({
        version: InstallationVersion,
        execPath: process.execPath,
        toolIDs: await AppRuntime.runPromise(ToolRegistry.Service.use((service) => service.ids())),
        permissionMode: process.env.OPENCODE_SG_PERMISSION_MODE,
        launchers: await inspectDefaultLaunchers(process.execPath),
      })

      process.stdout.write(formatDoctorSmoke(result, Boolean(args.json)))
      if (!result.ok && args.check) process.exit(1)
    })
  },
})
