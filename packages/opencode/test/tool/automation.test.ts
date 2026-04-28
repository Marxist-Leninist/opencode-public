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
        created_at: "2026-04-28T00:00:00.000Z",
        updated_at: "2026-04-28T00:00:00.000Z",
      }

      expect(__testing.schtasksCreateArgs({ ...def, log_dir: "C:\\logs", history_path: "C:\\hist.jsonl" })).toEqual([
        "/Create",
        "/TN",
        "\\OpenCode SG\\daily-repo-check",
        "/TR",
        '"C:\\state\\daily-repo-check.cmd"',
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
        '"C:\\state\\weekly-standup.cmd"',
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
        log_dir: "C:\\state\\logs\\demo",
        history_path: "C:\\state\\history\\demo.jsonl",
        created_at: "2026-04-28T00:00:00.000Z",
        updated_at: "2026-04-28T00:00:00.000Z",
      }
      const script = __testing.buildRunnerScript(def)
      expect(script).toContain("setlocal enabledelayedexpansion")
      expect(script).toContain("OPENCODE_SG_AUTOMATION_RUN=1")
      expect(script).toContain("OPENCODE_SG_AUTOMATION_ID=demo")
      expect(script).toContain("wmic os get localdatetime")
      expect(script).toContain("1>> %LOG% 2>&1")
      expect(script).toContain('"id":"demo"')
      expect(script).toContain(">> %HIST%")
      expect(script).toContain('mkdir "C:\\state\\logs\\demo"')
      expect(script).toContain('mkdir "C:\\state\\history"')
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
