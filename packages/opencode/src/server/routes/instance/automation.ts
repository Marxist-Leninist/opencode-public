import type { Context as HonoContext } from "hono"
import { Hono } from "hono"
import { Effect } from "effect"
import { AutomationStore, AutomationTool, type Params } from "@/tool/automation"
import type { Context as ToolContext } from "@/tool/tool"
import { MessageID, SessionID } from "@/session/schema"
import { lazy } from "@/util/lazy"
import { jsonRequest } from "./trace"

const ACTIONS = new Set(["create", "update", "delete", "enable", "disable", "run_now", "status", "logs", "history"])

function bodyParams(c: HonoContext) {
  return Effect.promise(async () => {
    if (c.req.header("content-length") === "0") return {} as Partial<Params>
    return (await c.req.json().catch(() => ({}))) as Partial<Params>
  })
}

function context(c: HonoContext): ToolContext {
  return {
    sessionID: SessionID.make("ses_automation_gui"),
    messageID: MessageID.make("msg_automation_gui"),
    callID: "automation-gui",
    agent: "build",
    abort: c.req.raw.signal,
    messages: [],
    metadata: () => Effect.void,
    ask: () => Effect.void,
  }
}

function execute(c: HonoContext, params: Params) {
  return Effect.gen(function* () {
    const info = yield* AutomationTool
    const tool = yield* info.init()
    return yield* tool.execute(params, context(c))
  })
}

export const AutomationRoutes = lazy(() =>
  new Hono()
    .get("/", async (c) =>
      jsonRequest("AutomationRoutes.list", c, function* () {
        return yield* Effect.promise(() => AutomationStore.list())
      }),
    )
    .get("/:id", async (c) =>
      jsonRequest("AutomationRoutes.get", c, function* () {
        return yield* Effect.promise(() => AutomationStore.get(c.req.param("id")))
      }),
    )
    .post("/", async (c) =>
      jsonRequest("AutomationRoutes.save", c, function* () {
        const body = yield* bodyParams(c)
        const action = body.action ?? (body.id ? "update" : "create")
        if (action !== "create" && action !== "update") throw new Error(`automation: unsupported save action ${action}`)
        return yield* execute(c, { ...body, action } as Params)
      }),
    )
    .post("/:id/:action", async (c) =>
      jsonRequest("AutomationRoutes.action", c, function* () {
        const action = c.req.param("action")
        if (!ACTIONS.has(action)) throw new Error(`automation: unsupported action ${action}`)
        const body = yield* bodyParams(c)
        return yield* execute(c, { ...body, id: c.req.param("id"), action } as Params)
      }),
    )
    .delete("/:id", async (c) =>
      jsonRequest("AutomationRoutes.delete", c, function* () {
        return yield* execute(c, { id: c.req.param("id"), action: "delete" } as Params)
      }),
    ),
)
