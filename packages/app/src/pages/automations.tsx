import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { Switch as Toggle } from "@opencode-ai/ui/switch"
import { showToast } from "@opencode-ai/ui/toast"
import { createMemo, createResource, createSignal, For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useSDK } from "@/context/sdk"
import { useLocal } from "@/context/local"

type Schedule = "every_minutes" | "hourly" | "daily" | "weekly"
type Weekday = "MON" | "TUE" | "WED" | "THU" | "FRI" | "SAT" | "SUN"

type AutomationDefinition = {
  id: string
  title: string
  prompt: string
  schedule: Schedule
  interval_minutes?: number
  time?: string
  days_of_week?: Weekday[]
  working_directory: string
  model?: string
  agent?: string
  enabled: boolean
  task_name: string
  definition_path: string
  prompt_path: string
  script_path: string
  session_path?: string
  log_dir?: string
  history_path?: string
  created_at: string
  updated_at: string
}

type ToolResult = {
  title: string
  output: string
  metadata?: Record<string, unknown>
}
type Activity = {
  title: string
  output: string
  loading?: boolean
}

type RawSdkClient = {
  request<T>(options: {
    method: string
    url: string
    body?: unknown
    parseAs: "json"
    responseStyle: "data"
    throwOnError: true
  }): Promise<T>
}

type FormState = {
  id: string
  title: string
  prompt: string
  schedule: Schedule
  interval_minutes: number
  time: string
  days_of_week: Weekday[]
  working_directory: string
  model: string
  agent: string
  enabled: boolean
}

const WEEKDAYS: Weekday[] = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"]
const inputClass =
  "h-8 w-full rounded-md border border-border-weak-base bg-background-base px-2 text-13-regular text-text-strong outline-none focus:border-border-focus"
const labelClass = "flex flex-col gap-1 text-12-medium text-text-base"

function parseError(error: unknown) {
  if (error instanceof Error) return error.message
  return String(error)
}

function scheduleText(item: AutomationDefinition) {
  if (item.schedule === "every_minutes") return `Every ${item.interval_minutes ?? 1} minute(s)`
  if (item.schedule === "hourly") return `Every ${item.interval_minutes ?? 1} hour(s)`
  if (item.schedule === "weekly") return `Weekly ${(item.days_of_week ?? WEEKDAYS).join(", ")} at ${item.time ?? "09:00"}`
  return `Daily at ${item.time ?? "09:00"}`
}

export default function AutomationsPage() {
  const sdk = useSDK()
  const local = useLocal()
  const modelOptions = createMemo(() =>
    local.model
      .list()
      .filter((m) => local.model.visible({ modelID: m.id, providerID: m.provider.id }))
      .map((m) => ({
        value: `${m.provider.id}/${m.id}`,
        label: `${m.provider.name} / ${m.name}`,
      }))
      .sort((a, b) => a.label.localeCompare(b.label)),
  )
  const agentOptions = createMemo(() => local.agent.list().map((a) => a.name).sort((a, b) => a.localeCompare(b)))
  const [selected, setSelected] = createSignal<string | undefined>()
  const [busy, setBusy] = createSignal<string | undefined>()
  const [output, setOutput] = createSignal("")
  const [activity, setActivity] = createStore<Record<string, Activity>>({})

  const emptyForm = (): FormState => ({
    id: "",
    title: "",
    prompt: "",
    schedule: "hourly",
    interval_minutes: 1,
    time: "09:00",
    days_of_week: [...WEEKDAYS],
    working_directory: sdk.directory,
    model: "",
    agent: "",
    enabled: true,
  })

  const [form, setForm] = createStore<FormState>(emptyForm())
  const modelKnown = createMemo(() => !form.model || modelOptions().some((item) => item.value === form.model))
  const agentKnown = createMemo(() => !form.agent || agentOptions().includes(form.agent))

  const rawClient = () => (sdk.client as unknown as { client: RawSdkClient }).client

  async function request<T>(path = "", init?: { method?: string; body?: unknown }): Promise<T> {
    return rawClient().request<T>({
      method: init?.method ?? "GET",
      url: `/automation${path}`,
      body: init?.body,
      parseAs: "json",
      responseStyle: "data",
      throwOnError: true,
    })
  }

  const [items, itemsActions] = createResource(() => request<AutomationDefinition[]>())
  const automations = createMemo(() => items() ?? [])
  const selectedItem = createMemo(() => automations().find((item) => item.id === selected()))

  const resetForm = () => {
    setSelected(undefined)
    setOutput("")
    setForm(emptyForm())
  }

  const edit = (item: AutomationDefinition) => {
    setSelected(item.id)
    setOutput("")
    setForm({
      id: item.id,
      title: item.title,
      prompt: item.prompt,
      schedule: item.schedule,
      interval_minutes: item.interval_minutes ?? 1,
      time: item.time ?? "09:00",
      days_of_week: item.days_of_week?.length ? [...item.days_of_week] : [...WEEKDAYS],
      working_directory: item.working_directory,
      model: item.model ?? "",
      agent: item.agent ?? "",
      enabled: item.enabled,
    })
  }

  const save = async (event: Event) => {
    event.preventDefault()
    setBusy("save")
    try {
      const body = {
        action: selected() ? "update" : "create",
        id: form.id.trim() || undefined,
        title: form.title.trim(),
        prompt: form.prompt.trim(),
        schedule: form.schedule,
        interval_minutes:
          form.schedule === "daily" || form.schedule === "weekly" ? undefined : Math.max(1, form.interval_minutes),
        time: form.schedule === "daily" || form.schedule === "weekly" ? form.time : undefined,
        days_of_week: form.schedule === "weekly" ? form.days_of_week : undefined,
        working_directory: form.working_directory.trim() || sdk.directory,
        model: form.model.trim() || undefined,
        agent: form.agent.trim() || undefined,
        enabled: form.enabled,
        install: true,
      }
      const result = await request<ToolResult>("", { method: "POST", body })
      setOutput(result.output)
      await itemsActions.refetch()
      showToast({ variant: "success", title: result.title })
      if (!selected()) {
        const next = automations().find((item) => item.title === body.title)
        if (next) edit(next)
      }
    } catch (error) {
      showToast({ variant: "error", title: "Automation failed", description: parseError(error) })
    } finally {
      setBusy(undefined)
    }
  }

  // Tracks an in-flight log-tail loop so a second Run doesn't stack pollers.
  let tailInterval: ReturnType<typeof setInterval> | undefined
  const stopTail = () => {
    if (tailInterval) {
      clearInterval(tailInterval)
      tailInterval = undefined
    }
  }

  // After a Run, the scheduled task runs for minutes in the background. Without
  // live feedback the GUI looks frozen. This polls the /logs action every 3s
  // and streams the tail into the output area until it stops growing for 12s
  // (run finished) or 10 min cap.
  const startLogTail = (item: AutomationDefinition) => {
    stopTail()
    const startedAt = Date.now()
    let lastLen = -1
    let stableSince = Date.now()
    const startMessage = `[automation: ${item.id}] starting - tailing log...`
    setOutput(startMessage)
    setActivity(item.id, { title: "Running automation", output: startMessage, loading: true })
    tailInterval = setInterval(async () => {
      try {
        const tail = await request<ToolResult>(`/${encodeURIComponent(item.id)}/logs`, {
          method: "POST",
          body: {},
        })
        setOutput(tail.output ?? "")
        setActivity(item.id, { title: tail.title, output: tail.output ?? "", loading: true })
        const len = (tail.output ?? "").length
        if (len !== lastLen) {
          lastLen = len
          stableSince = Date.now()
        } else if (Date.now() - stableSince >= 12_000) {
          stopTail()
          setBusy(undefined)
          setActivity(item.id, { title: tail.title, output: tail.output ?? "" })
          await itemsActions.refetch()
        }
        if (Date.now() - startedAt >= 10 * 60_000) {
          stopTail()
          setBusy(undefined)
        }
      } catch {
        // Log file may not exist yet on the first poll; keep trying.
      }
    }, 3_000)
  }

  const runAction = async (
    item: AutomationDefinition,
    action: "enable" | "disable" | "run_now" | "status" | "logs" | "history",
  ) => {
    setBusy(`${action}:${item.id}`)
    const label =
      action === "run_now"
        ? "Starting"
        : action === "status"
          ? "Checking status"
          : action === "logs"
            ? "Loading logs"
            : action === "history"
              ? "Loading history"
              : action === "enable"
                ? "Enabling"
                : "Pausing"
    setActivity(item.id, {
      title: `${label}...`,
      output: "Waiting for the local automation service.",
      loading: true,
    })
    try {
      const result = await request<ToolResult>(`/${encodeURIComponent(item.id)}/${action}`, {
        method: "POST",
        body: {},
      })
      setOutput(result.output)
      setActivity(item.id, { title: result.title, output: result.output })
      await itemsActions.refetch()
      if (action === "enable" || action === "disable") {
        showToast({ variant: "success", title: result.title })
      }
      if (action === "run_now") {
        showToast({ variant: "success", title: `Running ${item.id}...` })
        // Briefly wait for the runner script to start writing, then live-tail
        // its log into the output area until the run finishes.
        setBusy(`tail:${item.id}`)
        setTimeout(() => startLogTail(item), 2_000)
      }
    } catch (error) {
      setActivity(item.id, { title: "Automation failed", output: parseError(error) })
      showToast({ variant: "error", title: "Automation failed", description: parseError(error) })
    } finally {
      // Don't clear busy when we're about to hand off to the tail loop.
      if (action !== "run_now") setBusy(undefined)
    }
  }

  const remove = async (item: AutomationDefinition) => {
    if (!confirm(`Delete automation "${item.title}"?`)) return
    setBusy(`delete:${item.id}`)
    try {
      const result = await request<ToolResult>(`/${encodeURIComponent(item.id)}`, { method: "DELETE" })
      setOutput(result.output)
      if (selected() === item.id) resetForm()
      await itemsActions.refetch()
      showToast({ variant: "success", title: result.title })
    } catch (error) {
      showToast({ variant: "error", title: "Automation failed", description: parseError(error) })
    } finally {
      setBusy(undefined)
    }
  }

  const toggleDay = (day: Weekday, checked: boolean) => {
    setForm(
      "days_of_week",
      checked ? [...new Set([...form.days_of_week, day])] : form.days_of_week.filter((item) => item !== day),
    )
  }

  const busyFor = (item: AutomationDefinition, action: string) => busy() === `${action}:${item.id}`
  const busyItem = (item: AutomationDefinition) => Boolean(busy()?.endsWith(`:${item.id}`))

  return (
    <main class="size-full overflow-y-auto bg-background-base">
      <div class="mx-auto flex max-w-6xl flex-col gap-6 px-6 py-6 md:px-8">
        <div class="flex min-w-0 items-center justify-between gap-4">
          <div class="min-w-0">
            <h1 class="text-20-medium text-text-strong">Automations</h1>
            <p class="mt-1 text-14-regular text-text-base">
              Create SG OpenCode routines that run locally on a schedule.
            </p>
          </div>
          <Button icon="plus-small" size="large" onClick={resetForm}>
            New automation
          </Button>
        </div>

        <div class="rounded-lg bg-surface-raised-base px-3 py-2 text-13-medium text-text-base">
          Local automations use Windows Task Scheduler and only run while this computer is awake.
        </div>

        <div class="grid min-h-0 grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_390px]">
          <section class="min-w-0">
            <div class="mb-3 flex items-center justify-between gap-3">
              <h2 class="text-16-medium text-text-strong">Current</h2>
              <span class="text-12-regular text-text-weak">{automations().length} saved</span>
            </div>
            <Show
              when={!items.loading}
              fallback={<div class="h-32 rounded-lg bg-surface-raised-base animate-pulse" />}
            >
              <Show
                when={automations().length > 0}
                fallback={
                  <div class="rounded-lg border border-border-weaker-base p-6 text-14-regular text-text-base">
                    No automations yet. Create one on the right.
                  </div>
                }
              >
                <div class="flex flex-col gap-2">
                  <For each={automations()}>
                    {(item) => (
                      <article
                        class="group rounded-lg border border-border-weaker-base bg-background-base p-3 transition-colors hover:bg-surface-raised-base"
                        classList={{ "border-border-focus": selected() === item.id }}
                      >
                        <div class="flex min-w-0 items-start gap-3">
                          <button
                            type="button"
                            class="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md bg-surface-base text-icon-base"
                            onClick={() => edit(item)}
                            aria-label={`Edit ${item.title}`}
                          >
                            <Icon name="task" size="small" />
                          </button>
                          <button type="button" class="min-w-0 flex-1 text-left" onClick={() => edit(item)}>
                            <div class="truncate text-14-medium text-text-strong">{item.title}</div>
                            <div class="mt-0.5 truncate text-13-regular text-text-base">
                              {scheduleText(item)} - {item.enabled ? "Enabled" : "Paused"}
                            </div>
                          </button>
                          <span
                            class="rounded-md px-2 py-1 text-12-medium"
                            classList={{
                              "bg-surface-success-base text-text-on-success-base": item.enabled,
                              "bg-surface-base text-text-weak": !item.enabled,
                            }}
                          >
                            {item.enabled ? "Local" : "Paused"}
                          </span>
                        </div>
                        <div class="mt-3 flex flex-wrap gap-2 pl-10">
                          <Button
                            size="small"
                            icon="arrow-right"
                            disabled={busyItem(item)}
                            onClick={() => runAction(item, "run_now")}
                          >
                            {busyFor(item, "run_now") || busyFor(item, "tail") ? "Running..." : "Run"}
                          </Button>
                          <Button
                            size="small"
                            icon={item.enabled ? "circle-ban-sign" : "check-small"}
                            disabled={busyItem(item)}
                            onClick={() => runAction(item, item.enabled ? "disable" : "enable")}
                          >
                            {busyFor(item, "disable") ? "Pausing..." : busyFor(item, "enable") ? "Enabling..." : item.enabled ? "Pause" : "Enable"}
                          </Button>
                          <Button
                            size="small"
                            icon="status"
                            variant="ghost"
                            disabled={busyItem(item)}
                            onClick={() => runAction(item, "status")}
                          >
                            {busyFor(item, "status") ? "Checking..." : "Status"}
                          </Button>
                          <Button
                            size="small"
                            icon="status"
                            variant="ghost"
                            disabled={busyItem(item)}
                            onClick={() => runAction(item, "history")}
                          >
                            {busyFor(item, "history") ? "Loading..." : "History"}
                          </Button>
                          <Button
                            size="small"
                            icon="terminal"
                            variant="ghost"
                            disabled={busyItem(item)}
                            onClick={() => runAction(item, "logs")}
                          >
                            {busyFor(item, "logs") ? "Loading..." : "Logs"}
                          </Button>
                          <Button size="small" icon="trash" variant="ghost" onClick={() => remove(item)}>
                            Delete
                          </Button>
                        </div>
                        <Show when={activity[item.id]}>
                          {(info) => (
                            <div
                              class="mt-3 ml-10 min-w-0 rounded-md border border-border-weaker-base bg-surface-base px-3 py-2"
                              classList={{ "animate-pulse": info().loading }}
                            >
                              <div class="mb-1 truncate text-12-medium text-text-strong">{info().title}</div>
                              <pre class="max-h-48 overflow-auto whitespace-pre-wrap text-12-regular text-text-base">
                                {info().output}
                              </pre>
                            </div>
                          )}
                        </Show>
                      </article>
                    )}
                  </For>
                </div>
              </Show>
            </Show>
          </section>

          <aside class="min-w-0">
            <form class="rounded-lg border border-border-weaker-base bg-background-base p-4" onSubmit={save}>
              <div class="mb-4 flex items-center justify-between gap-3">
                <div class="min-w-0">
                  <h2 class="truncate text-16-medium text-text-strong">
                    {selectedItem() ? "Edit automation" : "New automation"}
                  </h2>
                  <p class="mt-0.5 truncate text-12-regular text-text-weak">{selectedItem()?.id ?? "Not saved yet"}</p>
                </div>
                <Toggle checked={form.enabled} onChange={(checked) => setForm("enabled", checked)} hideLabel>
                  Enabled
                </Toggle>
              </div>

              <div class="flex flex-col gap-3">
                <label class={labelClass}>
                  Title
                  <input
                    class={inputClass}
                    value={form.title}
                    onInput={(event) => setForm("title", event.currentTarget.value)}
                    required
                  />
                </label>

                <label class={labelClass}>
                  ID
                  <input
                    class={inputClass}
                    value={form.id}
                    onInput={(event) => setForm("id", event.currentTarget.value)}
                    placeholder="auto-generated from title"
                  />
                </label>

                <div class="grid grid-cols-2 gap-3">
                  <label class={labelClass}>
                    Schedule
                    <select
                      class={inputClass}
                      value={form.schedule}
                      onInput={(event) => setForm("schedule", event.currentTarget.value as Schedule)}
                    >
                      <option value="every_minutes">Every minutes</option>
                      <option value="hourly">Hourly</option>
                      <option value="daily">Daily</option>
                      <option value="weekly">Weekly</option>
                    </select>
                  </label>

                  <Show
                    when={form.schedule === "daily" || form.schedule === "weekly"}
                    fallback={
                      <label class={labelClass}>
                        Interval
                        <input
                          class={inputClass}
                          type="number"
                          min="1"
                          max="10080"
                          value={String(form.interval_minutes)}
                          onInput={(event) => setForm("interval_minutes", Number(event.currentTarget.value) || 1)}
                        />
                      </label>
                    }
                  >
                    <label class={labelClass}>
                      Time
                      <input
                        class={inputClass}
                        type="time"
                        value={form.time}
                        onInput={(event) => setForm("time", event.currentTarget.value)}
                      />
                    </label>
                  </Show>
                </div>

                <Show when={form.schedule === "weekly"}>
                  <div class="flex flex-col gap-2">
                    <div class="text-12-medium text-text-base">Days</div>
                    <div class="grid grid-cols-7 gap-1">
                      <For each={WEEKDAYS}>
                        {(day) => (
                          <button
                            type="button"
                            class="h-7 rounded-md border border-border-weaker-base text-12-medium"
                            classList={{
                              "bg-surface-base-active text-text-strong": form.days_of_week.includes(day),
                              "text-text-weak": !form.days_of_week.includes(day),
                            }}
                            onClick={() => toggleDay(day, !form.days_of_week.includes(day))}
                          >
                            {day.slice(0, 1)}
                          </button>
                        )}
                      </For>
                    </div>
                  </div>
                </Show>

                <label class={labelClass}>
                  Working directory
                  <input
                    class={inputClass}
                    value={form.working_directory}
                    onInput={(event) => setForm("working_directory", event.currentTarget.value)}
                  />
                </label>

                <div class="grid grid-cols-2 gap-3">
                  <label class={labelClass}>
                    Model
                    <select
                      class={inputClass}
                      value={form.model}
                      onInput={(event) => setForm("model", event.currentTarget.value)}
                    >
                      <option value="">Default model</option>
                      <Show when={!modelKnown()}>
                        <option value={form.model}>Custom: {form.model}</option>
                      </Show>
                      <For each={modelOptions()}>
                        {(opt) => <option value={opt.value}>{opt.label}</option>}
                      </For>
                    </select>
                  </label>
                  <label class={labelClass}>
                    Agent
                    <select
                      class={inputClass}
                      value={form.agent}
                      onInput={(event) => setForm("agent", event.currentTarget.value)}
                    >
                      <option value="">Default agent</option>
                      <Show when={!agentKnown()}>
                        <option value={form.agent}>Custom: {form.agent}</option>
                      </Show>
                      <For each={agentOptions()}>
                        {(name) => <option value={name}>{name}</option>}
                      </For>
                    </select>
                  </label>
                </div>

                <label class={labelClass}>
                  Prompt
                  <textarea
                    class="min-h-44 w-full resize-y rounded-md border border-border-weak-base bg-background-base px-2 py-2 text-13-regular text-text-strong outline-none focus:border-border-focus"
                    value={form.prompt}
                    onInput={(event) => setForm("prompt", event.currentTarget.value)}
                    required
                  />
                </label>

                <div class="flex gap-2 pt-1">
                  <Button type="submit" icon="check-small" size="large" disabled={busy() === "save"}>
                    Save automation
                  </Button>
                  <Button type="button" variant="ghost" size="large" onClick={resetForm}>
                    Clear
                  </Button>
                </div>
              </div>
            </form>

            <Show when={output()}>
              <pre class="mt-4 max-h-72 overflow-auto rounded-lg border border-border-weaker-base bg-surface-raised-base p-3 text-12-regular text-text-base whitespace-pre-wrap">
                {output()}
              </pre>
            </Show>
          </aside>
        </div>
      </div>
    </main>
  )
}
