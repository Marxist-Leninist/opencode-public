import { Duration, Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./task-result.txt"
import { BackgroundTask } from "../session/background-task"

export const Parameters = Schema.Struct({
  task_id: Schema.String.annotate({
    description: "The task_id returned by a background `task` call (task: { background: true }).",
  }),
  wait_seconds: Schema.optional(
    Schema.Number.check(Schema.isInt())
      .check(Schema.isGreaterThanOrEqualTo(0))
      .check(Schema.isLessThanOrEqualTo(600)),
  ).annotate({
    description:
      "Optional. If the task is still running, block up to this many seconds for it to finish before returning. Default 0 (return current status immediately).",
  }),
})

type Params = Schema.Schema.Type<typeof Parameters>

type Metadata = {
  found: boolean
  status?: string
  sessionId?: string
  elapsed_seconds?: number
}

const done = (result: Tool.ExecuteResult<Metadata>) => result

export const TaskResultTool = Tool.define(
  "task_result",
  Effect.succeed({
    description: DESCRIPTION,
    parameters: Parameters,
    execute: (params: Params, ctx: Tool.Context<Metadata>) =>
      Effect.gen(function* () {
        const deadline = Date.now() + (params.wait_seconds ?? 0) * 1000
        let entry = BackgroundTask.get(params.task_id)

        while (entry && entry.status === "running" && Date.now() < deadline && !ctx.abort.aborted) {
          yield* Effect.sleep(Duration.millis(500))
          entry = BackgroundTask.get(params.task_id)
        }

        if (!entry) {
          return done({
            title: `task_result: unknown ${params.task_id}`,
            metadata: { found: false },
            output: `No background task with task_id ${params.task_id}. Use task_status to list this session's background tasks.`,
          })
        }

        const elapsed = ((entry.completedAt ?? Date.now()) - entry.startedAt) / 1000

        if (entry.status === "running") {
          return done({
            title: "task_result: still running",
            metadata: { found: true, status: "running", sessionId: entry.taskID, elapsed_seconds: elapsed },
            output: `Background task '${entry.description}' (${params.task_id}) is still running (${elapsed.toFixed(0)}s elapsed). Keep working and check again later, or call task_result with wait_seconds to block for it.`,
          })
        }

        if (entry.status === "error") {
          BackgroundTask.markNotified(params.task_id)
          return done({
            title: "task_result: error",
            metadata: { found: true, status: "error", sessionId: entry.taskID, elapsed_seconds: elapsed },
            output: `Background task '${entry.description}' (${params.task_id}) FAILED after ${elapsed.toFixed(0)}s:\n${entry.error ?? "unknown error"}`,
          })
        }

        if (entry.status === "cancelled") {
          BackgroundTask.markNotified(params.task_id)
          return done({
            title: "task_result: cancelled",
            metadata: { found: true, status: "cancelled", sessionId: entry.taskID, elapsed_seconds: elapsed },
            output: `Background task '${entry.description}' (${params.task_id}) was cancelled after ${elapsed.toFixed(0)}s.`,
          })
        }

        BackgroundTask.markNotified(params.task_id)
        return done({
          title: `task_result: ${entry.description}`,
          metadata: { found: true, status: "done", sessionId: entry.taskID, elapsed_seconds: elapsed },
          output: [
            `task_id: ${params.task_id} (@${entry.subagentType}, finished in ${elapsed.toFixed(0)}s)`,
            "",
            "<task_result>",
            entry.result ?? "",
            "</task_result>",
          ].join("\n"),
        })
      }),
  }),
)
