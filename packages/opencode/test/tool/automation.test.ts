import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import * as fs from "fs/promises"
import path from "path"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Agent } from "../../src/agent/agent"
import { MessageID, SessionID } from "../../src/session/schema"
import { AutomationTool, __testing } from "../../src/tool/automation"
import { Tool } from "../../src/tool"
import { Truncate } from "../../src/tool"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(CrossSpawnSpawner.defaultLayer, Truncate.defaultLayer, Agent.defaultLayer))

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

describe("tool.automation", () => {
  it.effect("sanitizes ids and builds schtasks arguments", () =>
    Effect.sync(() => {
      expect(__testing.sanitizeId("Daily Repo Check!!")).toBe("daily-repo-check")

      const def = {
        id: "daily-repo-check",
        title: "Daily Repo Check",
        prompt: "Check the repo.",
        schedule: "daily" as const,
        time: "09:00",
        working_directory: "C:\\repo",
        enabled: true,
        task_name: __testing.taskName("daily-repo-check"),
        definition_path: "C:\\state\\daily-repo-check.json",
        prompt_path: "C:\\state\\daily-repo-check.txt",
        script_path: "C:\\state\\daily-repo-check.cmd",
        session_path: "C:\\state\\sessions\\daily-repo-check.txt",
        created_at: "2026-04-28T00:00:00.000Z",
        updated_at: "2026-04-28T00:00:00.000Z",
      }

      expect(__testing.schtasksCreateArgs({ ...def, log_dir: "C:\\logs", history_path: "C:\\hist.jsonl" })).toEqual([
        "/Create",
        "/TN",
        "\\OpenCode SG\\daily-repo-check",
        "/TR",
        'wscript.exe "C:\\state\\daily-repo-check.vbs"',
        "/F",
        "/SC",
        "DAILY",
        "/ST",
        "09:00",
      ])
    }),
  )

  it.effect("schedules a weekly run on selected weekdays", () =>
    Effect.sync(() => {
      const def = {
        id: "weekly-standup",
        title: "Weekly standup",
        prompt: "x",
        schedule: "weekly" as const,
        time: "08:30",
        days_of_week: ["MON", "WED", "FRI"] as const,
        working_directory: "C:\\repo",
        enabled: true,
        task_name: __testing.taskName("weekly-standup"),
        definition_path: "C:\\state\\weekly-standup.json",
        prompt_path: "C:\\state\\weekly-standup.txt",
        script_path: "C:\\state\\weekly-standup.cmd",
        session_path: "C:\\state\\sessions\\weekly-standup.txt",
        log_dir: "C:\\state\\logs\\weekly-standup",
        history_path: "C:\\state\\history\\weekly-standup.jsonl",
        created_at: "2026-04-28T00:00:00.000Z",
        updated_at: "2026-04-28T00:00:00.000Z",
      }
      expect(__testing.schtasksCreateArgs(def)).toEqual([
        "/Create",
        "/TN",
        "\\OpenCode SG\\weekly-standup",
        "/TR",
        'wscript.exe "C:\\state\\weekly-standup.vbs"',
        "/F",
        "/SC",
        "WEEKLY",
        "/D",
        "MON,WED,FRI",
        "/ST",
        "08:30",
      ])
    }),
  )

  it.effect("runner script captures logs and writes a history line", () =>
    Effect.sync(() => {
      const def = {
        id: "demo",
        title: "Demo",
        prompt: "do x",
        schedule: "hourly" as const,
        interval_minutes: 1,
        working_directory: "C:\\work",
        enabled: true,
        task_name: __testing.taskName("demo"),
        definition_path: "C:\\state\\demo.json",
        prompt_path: "C:\\state\\demo.txt",
        script_path: "C:\\state\\demo.cmd",
        session_path: "C:\\state\\sessions\\demo.txt",
        log_dir: "C:\\state\\logs\\demo",
        history_path: "C:\\state\\history\\demo.jsonl",
        created_at: "2026-04-28T00:00:00.000Z",
        updated_at: "2026-04-28T00:00:00.000Z",
      }
      const script = __testing.buildRunnerScript(def)
      expect(script).toContain("setlocal enabledelayedexpansion")
      expect(script).toContain("OPENCODE_SG_AUTOMATION_RUN=1")
      expect(script).toContain("OPENCODE_SG_AUTOMATION_ID=demo")
      expect(script).toContain('set "DEF=C:\\state\\demo.json"')
      expect(script).toContain("Get-Date -Format yyyyMMdd-HHmmss-fff")
      expect(script).toContain('set "LOG=C:\\state\\logs\\demo\\!TS!.log"')
      expect(script).toContain('1>> "!LOG!" 2>&1')
      expect(script).toContain("ConvertFrom-Json")
      expect(script).toContain('skipped: automation is paused')
      expect(script).toContain('"skipped":"paused"')
      expect(script).toContain('set "SESSION_FILE=C:\\state\\sessions\\demo.txt"')
      expect(script).toContain('OPENCODE_SG_AUTOMATION_SESSION_FILE=!SESSION_FILE!')
      expect(script).toContain("!SESSION_ARGS!")
      expect(script).toContain('set "LOG_JSON=!LOG:\\=\\\\!"')
      expect(script).toContain('"id":"demo"')
      expect(script).toContain('"session_id":"!SESSION_ID!"')
      expect(script).toContain('"log":"!LOG_JSON!"')
      expect(script).toContain('>> "!HIST!"')
      expect(script).toContain('mkdir "C:\\state\\logs\\demo"')
      expect(script).toContain('mkdir "C:\\state\\history"')
    }),
  )

  it.effect("builds a hidden VBS launcher for scheduled tasks", () =>
    Effect.sync(() => {
      expect(__testing.vbsPath("C:\\state\\demo.cmd")).toBe("C:\\state\\demo.vbs")
      const launcher = __testing.buildVbsLauncher("C:\\state\\demo.cmd")
      expect(launcher).toContain("WScript.Shell")
      expect(launcher).toContain('WShell.Run """C:\\state\\demo.cmd""", 0, True')
    }),
  )

  it.effect("parses scheduler status from schtasks list output", () =>
    Effect.sync(() => {
      const parsed = __testing.parseTaskQuery(
        [
          "TaskName:                             \\OpenCode SG\\testing",
          "Next Run Time:                        29/04/2026 01:49:00",
          "Status:                               Running",
          "Last Result:                          267009",
          "Task To Run:                          wscript.exe \"C:\\Users\\User\\.local\\share\\opencode\\automations\\scripts\\testing.vbs\"",
          "Scheduled Task State:                 Enabled",
        ].join("\r\n"),
      )
      expect(parsed.status).toBe("Running")
      expect(parsed.last_result).toBe("267009")
      expect(parsed.next_run_time).toBe("29/04/2026 01:49:00")
      expect(parsed.scheduled_task_state).toBe("Enabled")
      expect(parsed.task_to_run).toContain("testing.vbs")
    }),
  )

  it.live("history action returns recent runs in reverse chronological order", () =>
    provideTmpdirInstance((dir) => {
      const prev = process.env.OPENCODE_SG_AUTOMATION_DIR
      const root = path.join(dir, "automation-state")
      process.env.OPENCODE_SG_AUTOMATION_DIR = root

      return Effect.gen(function* () {
        const toolInfo = yield* AutomationTool
        const tool = yield* toolInfo.init()

        yield* tool.execute(
          {
            action: "create",
            title: "Logs Demo",
            prompt: "test prompt",
            schedule: "every_minutes",
            interval_minutes: 5,
            install: false,
          },
          baseCtx,
        )

        const id = "logs-demo"
        const histDir = path.join(root, "history")
        yield* Effect.promise(async () => {
          await fs.mkdir(histDir, { recursive: true })
          const logsDir = path.join(root, "logs", id)
          await fs.mkdir(logsDir, { recursive: true })
          await fs.writeFile(
            path.join(histDir, `${id}.jsonl`),
            [
              JSON.stringify({ id, ts: "20260101-080000", exit: 0, log: path.join(logsDir, "20260101-080000.log") }),
              JSON.stringify({ id, ts: "20260101-090000", exit: 1, log: path.join(logsDir, "20260101-090000.log") }),
              JSON.stringify({ id, ts: "20260101-100000", exit: 0, log: path.join(logsDir, "20260101-100000.log") }),
              "",
            ].join("\n"),
            "utf8",
          )
          await fs.writeFile(path.join(logsDir, "20260101-100000.log"), "hello world\nfinal line\n", "utf8")
        })

        const history = yield* tool.execute(
          { action: "history", id, history_limit: 5 },
          baseCtx,
        )
        expect(history.metadata.action).toBe("history")
        expect(history.metadata.history_count).toBe(3)
        // newest first
        const lines = history.output.split("\n").filter((l) => /\d{8}-\d{6}/.test(l))
        expect(lines[0]?.startsWith("20260101-100000")).toBe(true)
        expect(lines[2]?.startsWith("20260101-080000")).toBe(true)

        const logs = yield* tool.execute({ action: "logs", id, tail_lines: 10 }, baseCtx)
        expect(logs.metadata.action).toBe("logs")
        expect(logs.metadata.log_run_ts).toBe("20260101-100000")
        expect(logs.output).toContain("final line")
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (prev === undefined) delete process.env.OPENCODE_SG_AUTOMATION_DIR
            else process.env.OPENCODE_SG_AUTOMATION_DIR = prev
          }),
        ),
      )
    }),
  )

  it.live("does not manually run a paused automation", () =>
    provideTmpdirInstance((dir) => {
      const prev = process.env.OPENCODE_SG_AUTOMATION_DIR
      process.env.OPENCODE_SG_AUTOMATION_DIR = path.join(dir, "automation-state")

      return Effect.gen(function* () {
        const toolInfo = yield* AutomationTool
        const tool = yield* toolInfo.init()

        yield* tool.execute(
          {
            action: "create",
            title: "Paused Manual Run",
            prompt: "should not run",
            schedule: "hourly",
            interval_minutes: 1,
            enabled: false,
            install: false,
          },
          baseCtx,
        )

        const started = yield* tool.execute({ action: "run_now", id: "paused-manual-run" }, baseCtx)
        expect(started.title).toBe("automation paused: paused-manual-run")
        expect(started.metadata.enabled).toBe(false)
        expect(started.metadata.running).toBe(false)
        expect(started.output).toContain("Skipped")
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (prev === undefined) delete process.env.OPENCODE_SG_AUTOMATION_DIR
            else process.env.OPENCODE_SG_AUTOMATION_DIR = prev
          }),
        ),
      )
    }),
  )

  it.live("creates and lists a definition without installing an OS task", () =>
    provideTmpdirInstance((dir) => {
      const prev = process.env.OPENCODE_SG_AUTOMATION_DIR
      process.env.OPENCODE_SG_AUTOMATION_DIR = path.join(dir, "automation-state")

      return Effect.gen(function* () {
        const toolInfo = yield* AutomationTool
        const tool = yield* toolInfo.init()

        const created = yield* tool.execute(
          {
            action: "create",
            title: "Hourly SG Check",
            prompt: "Check SG OpenCode and summarize.",
            schedule: "hourly",
            interval_minutes: 1,
            install: false,
          },
          baseCtx,
        )

        expect(created.metadata.id).toBe("hourly-sg-check")
        expect(created.metadata.installed).toBe(false)
        expect(created.output).toContain("Scheduled task not installed")

        const listed = yield* tool.execute({ action: "list" }, baseCtx)
        expect(listed.metadata.count).toBe(1)
        expect(listed.output).toContain("hourly-sg-check")
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (prev === undefined) delete process.env.OPENCODE_SG_AUTOMATION_DIR
            else process.env.OPENCODE_SG_AUTOMATION_DIR = prev
          }),
        ),
      )
    }),
  )
})
