import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./task-status.txt"
import { BackgroundTask } from "../session/background-task"

export const Parameters = Schema.Struct({
  task_id: Schema.optional(Schema.String).annotate({
    description: "Optional. Show only this task_id instead of every background task for the session.",
  }),
})

type Params = Schema.Schema.Type<typeof Parameters>

type Metadata = {
  count: number
  running: number
  done: number
}

const finish = (result: Tool.ExecuteResult<Metadata>) => result

export const TaskStatusTool = Tool.define(
  "task_status",
  Effect.succeed({
    description: DESCRIPTION,
    parameters: Parameters,
    execute: (params: Params, ctx: Tool.Context<Metadata>) =>
      Effect.gen(function* () {
        let list = BackgroundTask.list(ctx.sessionID)
        if (params.task_id) list = list.filter((e) => e.taskID === params.task_id)

        const running = list.filter((e) => e.status === "running").length
        const done = list.filter((e) => e.status !== "running").length

        if (list.length === 0) {
          return finish({
            title: "task_status: none",
            metadata: { count: 0, running: 0, done: 0 },
            output: params.task_id
              ? `No background task with task_id ${params.task_id} for this session.`
              : "No background tasks for this session.",
          })
        }

        const lines = list
          .slice()
          .sort((a, b) => a.startedAt - b.startedAt)
          .map((e) => {
            const secs = (((e.completedAt ?? Date.now()) - e.startedAt) / 1000).toFixed(0)
            const tag = e.status === "running" ? `running ${secs}s` : `${e.status} ${secs}s`
            return `- ${e.taskID} [${tag}] @${e.subagentType}: ${e.description}`
          })

        return finish({
          title: `task_status: ${running} running, ${done} finished`,
          metadata: { count: list.length, running, done },
          output: [
            `${list.length} background task(s): ${running} running, ${done} finished. Collect a finished one with task_result(task_id=...).`,
            ...lines,
          ].join("\n"),
        })
      }),
  }),
)
