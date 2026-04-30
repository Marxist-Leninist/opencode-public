import type { Config } from "@opencode-ai/sdk/v2/client"
import { Button } from "@opencode-ai/ui/button"
import { Select } from "@opencode-ai/ui/select"
import { Switch } from "@opencode-ai/ui/switch"
import { Tag } from "@opencode-ai/ui/tag"
import { TextField } from "@opencode-ai/ui/text-field"
import { showToast } from "@opencode-ai/ui/toast"
import { createMemo, type Component, For, Show, type JSX } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { useGlobalSync } from "@/context/global-sync"
import { useLanguage } from "@/context/language"
import { parseMcpCommand, parseMcpRemoteUrl, parseMcpTimeout } from "./mcp-config-utils"
// NOTE: Settings is a global dialog and is rendered outside any per-instance
// SyncProvider, so we cannot use `useSync()` here. Live connect/disconnect
// status is shown in the workspace status popover instead — this tab manages
// CONFIG only.
import { SettingsList } from "./settings-list"

type DeferredMode = "smart" | "standard" | "augment"

type DeferredSearchConfig = {
  mode?: DeferredMode
  model?: string
  limit?: number
}

type ExperimentalConfig = NonNullable<Config["experimental"]> & {
  defer_mcp_tools?: boolean
  defer_mcp_tools_search?: DeferredSearchConfig
}

type AnyMcpEntry = {
  type?: "local" | "remote"
  url?: string
  command?: string[]
  environment?: Record<string, string>
  enabled?: boolean
  defer?: boolean
  timeout?: number
  headers?: Record<string, string>
  oauth?: unknown
}

type AddServerType = "remote" | "local"

const searchModes: Array<{ value: DeferredMode; label: string; description: string }> = [
  { value: "smart", label: "Smart", description: "Local ranking, no model spend" },
  { value: "standard", label: "Standard", description: "Strict token matching" },
  { value: "augment", label: "Augment", description: "Rerank with a small model" },
]

function mcpConfig(config: Config) {
  return (config.mcp ?? {}) as Record<string, AnyMcpEntry>
}

function experimentalConfig(config: Config) {
  return (config.experimental ?? {}) as ExperimentalConfig
}

function searchConfig(config: Config) {
  return (experimentalConfig(config).defer_mcp_tools_search ?? {}) as DeferredSearchConfig
}

function parseTimeout(value: string) {
  return parseMcpTimeout(value)
}

function parseLimit(value: string) {
  const trimmed = value.trim()
  if (!trimmed) return undefined
  const parsed = Number(trimmed)
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error("Search limit must be a positive whole number.")
  return parsed
}

function validateRemoteURL(value: string) {
  return parseMcpRemoteUrl(value)
}

function parseCommand(value: string) {
  return parseMcpCommand(value)
}

function parseEnvironment(value: string) {
  const trimmed = value.trim()
  if (!trimmed) return undefined

  if (trimmed.startsWith("{")) {
    const parsed = JSON.parse(trimmed) as unknown
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
      throw new Error("Environment JSON must be an object.")
    }
    const result: Record<string, string> = {}
    for (const [key, envValue] of Object.entries(parsed)) {
      if (typeof envValue !== "string") throw new Error(`Environment value for ${key} must be a string.`)
      result[key] = envValue
    }
    return Object.keys(result).length > 0 ? result : undefined
  }

  const result: Record<string, string> = {}
  for (const line of value.split(/\r?\n/)) {
    const trimmedLine = line.trim()
    if (!trimmedLine) continue
    const separator = trimmedLine.indexOf("=")
    if (separator <= 0) throw new Error("Environment lines must use KEY=value.")
    const key = trimmedLine.slice(0, separator).trim()
    if (!key) throw new Error("Environment key is required.")
    result[key] = trimmedLine.slice(separator + 1)
  }
  return Object.keys(result).length > 0 ? result : undefined
}

function serverSummary(entry: AnyMcpEntry) {
  if (entry.type === "remote") return entry.url ?? "Remote URL not set"
  if (entry.type === "local") return entry.command?.join(" ") || "Local command not set"
  return "Remote config override"
}

const SettingsRow: Component<{
  title: string | JSX.Element
  description: string | JSX.Element
  children: JSX.Element
}> = (props) => (
  <div class="flex flex-wrap items-center gap-4 py-3 border-b border-border-weak-base last:border-none sm:flex-nowrap">
    <div class="flex min-w-0 flex-1 flex-col gap-0.5">
      <span class="text-14-medium text-text-strong">{props.title}</span>
      <span class="text-12-regular text-text-weak">{props.description}</span>
    </div>
    <div class="flex w-full justify-end sm:w-auto sm:shrink-0">{props.children}</div>
  </div>
)

export const SettingsMcp: Component = () => {
  const language = useLanguage()
  const globalSync = useGlobalSync()
  // sync (per-instance) is intentionally NOT used here; see import-site note.

  const [state, setState] = createStore({
    pending: "",
    add: {
      type: "remote" as AddServerType,
      name: "",
      url: "",
      command: "",
      environment: "",
      timeout: "30000",
      enabled: true,
      defer: true,
    },
    search: {
      model: undefined as string | undefined,
      limit: undefined as string | undefined,
    },
    edit: {} as Record<string, { url?: string; timeout?: string }>,
  })

  const configMcp = createMemo(() => mcpConfig(globalSync.data.config))
  const entries = createMemo(() => Object.entries(configMcp()).sort(([a], [b]) => a.localeCompare(b)))
  const experimental = createMemo(() => experimentalConfig(globalSync.data.config))
  const deferredSearch = createMemo(() => searchConfig(globalSync.data.config))
  const globalDeferred = createMemo(() => experimental().defer_mcp_tools === true)
  const mode = createMemo<DeferredMode>(() => {
    const current = deferredSearch().mode
    return current === "standard" || current === "augment" ? current : "smart"
  })
  const modeOption = createMemo(() => searchModes.find((item) => item.value === mode()) ?? searchModes[0])
  const augmentModel = createMemo(() => deferredSearch().model ?? "")
  const searchLimit = createMemo(() => {
    const limit = deferredSearch().limit
    return typeof limit === "number" ? String(limit) : ""
  })
  const searchModelValue = createMemo(() => state.search.model ?? augmentModel())
  const searchLimitValue = createMemo(() => state.search.limit ?? searchLimit())
  const configuredCount = createMemo(() => entries().length)
  const deferredCount = createMemo(
    () => entries().filter(([, entry]) => entry.defer === true || (entry.defer !== false && globalDeferred())).length,
  )

  const updateConfig = async (patch: Config, title: string, pending: string) => {
    setState("pending", pending)
    try {
      await globalSync.updateConfig(patch)
      showToast({ variant: "success", icon: "circle-check", title })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      showToast({ variant: "error", title: language.t("common.requestFailed"), description: message })
    } finally {
      setState("pending", "")
    }
  }

  const updateExperimental = (patch: Partial<ExperimentalConfig>, title: string, pending: string) => {
    const next = {
      ...experimental(),
      ...patch,
    } as ExperimentalConfig
    return updateConfig({ experimental: next } as Config, title, pending)
  }

  const updateSearch = (patch: Partial<DeferredSearchConfig>, title: string, pending: string) => {
    const next = {
      ...experimental(),
      defer_mcp_tools_search: {
        ...deferredSearch(),
        ...patch,
      },
    } as ExperimentalConfig
    return updateConfig({ experimental: next } as Config, title, pending)
  }

  const updateMcp = (next: Record<string, AnyMcpEntry>, title: string, pending: string) => {
    return updateConfig({ mcp: next } as Config, title, pending)
  }

  const updateEntry = (name: string, patch: Partial<AnyMcpEntry>, title: string, pending: string) => {
    const current = configMcp()[name]
    if (!current) return
    const next = {
      ...configMcp(),
      [name]: {
        ...current,
        ...patch,
      },
    }
    return updateMcp(next, title, pending)
  }

  const setEdit = (name: string, key: "url" | "timeout", value: string) => {
    setState(
      "edit",
      produce((draft) => {
        draft[name] ??= {}
        draft[name][key] = value
      }),
    )
  }

  const saveSearchModel = () => {
    const model = searchModelValue().trim() || undefined
    void updateSearch({ model }, "MCP augment model saved", "global-model").then(() =>
      setState("search", "model", undefined),
    )
  }

  const saveSearchLimit = () => {
    try {
      const limit = parseLimit(searchLimitValue())
      void updateSearch({ limit }, "MCP search limit saved", "global-limit").then(() =>
        setState("search", "limit", undefined),
      )
    } catch (err) {
      showToast({
        variant: "error",
        title: "Invalid search limit",
        description: err instanceof Error ? err.message : String(err),
      })
    }
  }

  const addServer = async () => {
    const name = state.add.name.trim()
    if (!/^[A-Za-z0-9_-]+$/.test(name)) {
      showToast({
        variant: "error",
        title: "Invalid MCP name",
        description: "Use letters, numbers, underscores, or hyphens.",
      })
      return
    }
    if (configMcp()[name]) {
      showToast({ variant: "error", title: "MCP already exists", description: `${name} is already configured.` })
      return
    }

    let timeout: number | undefined
    let entry: AnyMcpEntry
    try {
      timeout = parseTimeout(state.add.timeout)
      if (state.add.type === "remote") {
        entry = {
          type: "remote",
          url: validateRemoteURL(state.add.url),
          enabled: state.add.enabled,
          defer: state.add.defer,
        }
      } else {
        const environment = parseEnvironment(state.add.environment)
        entry = {
          type: "local",
          command: parseCommand(state.add.command),
          enabled: state.add.enabled,
          defer: state.add.defer,
        }
        if (environment) entry.environment = environment
      }
    } catch (err) {
      showToast({
        variant: "error",
        title: "Invalid MCP server",
        description: err instanceof Error ? err.message : String(err),
      })
      return
    }
    if (timeout !== undefined) entry.timeout = timeout

    await updateMcp(
      {
        ...configMcp(),
        [name]: entry,
      },
      "MCP server added",
      "add",
    )

    setState("add", {
      type: state.add.type,
      name: "",
      url: "",
      command: "",
      environment: "",
      timeout: "30000",
      enabled: true,
      defer: true,
    })
  }

  const removeEntry = (name: string) => {
    const next = { ...configMcp() }
    delete next[name]
    return updateMcp(next, "MCP server removed", `remove:${name}`)
  }

  const saveRemote = (name: string, entry: AnyMcpEntry) => {
    const edit = state.edit[name]
    let patch: Partial<AnyMcpEntry> = {}
    try {
      if (entry.type === "remote") {
        patch.url = validateRemoteURL(edit?.url ?? entry.url ?? "")
      }
      patch.timeout = parseTimeout(edit?.timeout ?? (entry.timeout === undefined ? "" : String(entry.timeout)))
    } catch (err) {
      showToast({
        variant: "error",
        title: "Invalid MCP server",
        description: err instanceof Error ? err.message : String(err),
      })
      return
    }
    return updateEntry(name, patch, "MCP server saved", `save:${name}`)
  }

  // Live connection status comes from the per-instance MCP service which is
  // not available in the global Settings dialog. Show a stable placeholder
  // and direct users to the in-session status popover for runtime state.
  const status = (_name: string) => "configured"
  const statusError = (_name: string) => undefined as string | undefined
  const isBusy = (key: string) => state.pending === key || state.pending === "global"

  return (
    <div class="flex flex-col h-full overflow-y-auto no-scrollbar px-4 pb-10 sm:px-10 sm:pb-10">
      <div class="sticky top-0 z-10 bg-[linear-gradient(to_bottom,var(--surface-stronger-non-alpha)_calc(100%_-_24px),transparent)]">
        <div class="flex flex-col gap-2 pt-6 pb-8 max-w-[760px]">
          <h2 class="text-16-medium text-text-strong">{language.t("settings.mcp.title")}</h2>
          <p class="text-13-regular text-text-weak">
            {language.t("settings.mcp.description")} Deferred mode exposes only
            <span class="text-text-strong"> mcp_search</span> first, then auto-loads matching tools after search.
          </p>
          <Show when={globalSync.data.path.config}>
            <TextField
              label="Config path"
              hideLabel
              readOnly
              copyable
              value={globalSync.data.path.config}
              class="text-12-regular"
            />
          </Show>
        </div>
      </div>

      <div class="flex flex-col gap-8 max-w-[760px]">
        <div class="flex flex-col gap-1">
          <h3 class="text-14-medium text-text-strong pb-2">Deferred discovery defaults</h3>
          <SettingsList>
            <SettingsRow
              title="Defer all MCP tools"
              description="Use one compact search tool for MCP servers unless a server explicitly opts out."
            >
              <Switch
                checked={globalDeferred()}
                disabled={isBusy("global-defer")}
                onChange={(checked) =>
                  void updateExperimental({ defer_mcp_tools: checked }, "MCP deferred default saved", "global-defer")
                }
              />
            </SettingsRow>
            <SettingsRow
              title="Search mode"
              description="Smart is local and cheap. Augment reranks smart matches with the configured small model."
            >
              <Select
                options={searchModes}
                current={modeOption()}
                value={(item) => item.value}
                label={(item) => item.label}
                onSelect={(item) =>
                  item && void updateSearch({ mode: item.value }, "MCP search mode saved", "global-search-mode")
                }
                variant="secondary"
                size="small"
                triggerVariant="settings"
                triggerStyle={{ "min-width": "160px" }}
              >
                {(item) => (
                  <div class="flex flex-col">
                    <span>{item?.label}</span>
                    <span class="text-11-regular text-text-weak">{item?.description}</span>
                  </div>
                )}
              </Select>
            </SettingsRow>
            <SettingsRow
              title="Augment model"
              description="Used only when search mode is augment. Keep this on a cheaper fast model."
            >
              <div class="flex gap-2 w-full sm:w-[420px]">
                <TextField
                  label="Augment model"
                  hideLabel
                  value={searchModelValue()}
                  onChange={(value) => setState("search", "model", value)}
                  placeholder="deepseek/deepseek-v4-flash"
                  spellcheck={false}
                  autocorrect="off"
                  autocomplete="off"
                  autocapitalize="off"
                  class="text-12-regular"
                />
                <Button size="small" variant="secondary" disabled={isBusy("global-model")} onClick={saveSearchModel}>
                  Save
                </Button>
              </div>
            </SettingsRow>
            <SettingsRow
              title="Default load limit"
              description="How many matching MCP tools mcp_search activates when the prompt does not pass limit."
            >
              <div class="flex gap-2 w-full sm:w-[220px]">
                <TextField
                  label="Default load limit"
                  hideLabel
                  value={searchLimitValue()}
                  onChange={(value) => setState("search", "limit", value)}
                  placeholder="5"
                  inputMode="numeric"
                  class="text-12-regular"
                />
                <Button size="small" variant="secondary" disabled={isBusy("global-limit")} onClick={saveSearchLimit}>
                  Save
                </Button>
              </div>
            </SettingsRow>
          </SettingsList>
        </div>

        <div class="flex flex-col gap-1">
          <div class="flex items-center justify-between gap-4 pb-2">
            <h3 class="text-14-medium text-text-strong">Configured servers</h3>
            <div class="flex items-center gap-2 text-12-regular text-text-weak">
              <Tag>{configuredCount()} total</Tag>
              <Tag>{deferredCount()} deferred</Tag>
            </div>
          </div>
          <SettingsList>
            <Show
              when={entries().length > 0}
              fallback={<div class="py-4 text-14-regular text-text-weak">No MCP servers configured yet.</div>}
            >
              <For each={entries()}>
                {([name, entry]) => {
                  const currentURL = () => state.edit[name]?.url ?? entry.url ?? ""
                  const currentTimeout = () =>
                    state.edit[name]?.timeout ?? (entry.timeout === undefined ? "" : String(entry.timeout))
                  const deferred = () => entry.defer ?? globalDeferred()
                  return (
                    <div class="flex flex-col gap-3 py-4 border-b border-border-weak-base last:border-none">
                      <div class="flex flex-wrap items-start justify-between gap-3">
                        <div class="flex min-w-0 flex-col gap-1">
                          <div class="flex flex-wrap items-center gap-2">
                            <span class="text-14-medium text-text-strong truncate">{name}</span>
                            <Tag>{entry.type ?? "override"}</Tag>
                            <Tag>{status(name)}</Tag>
                            <Show when={deferred()}>
                              <Tag>deferred</Tag>
                            </Show>
                          </div>
                          <span class="text-12-regular text-text-weak truncate">{serverSummary(entry)}</span>
                          <Show when={statusError(name)}>
                            {(error) => <span class="text-12-regular text-text-weaker truncate">{error()}</span>}
                          </Show>
                        </div>
                        <div class="flex flex-wrap items-center gap-4">
                          <label class="flex items-center gap-2 text-12-regular text-text-base">
                            Enabled
                            <Switch
                              checked={entry.enabled !== false}
                              disabled={isBusy(`enabled:${name}`)}
                              onChange={(checked) =>
                                void updateEntry(name, { enabled: checked }, "MCP server updated", `enabled:${name}`)
                              }
                            />
                          </label>
                          <label class="flex items-center gap-2 text-12-regular text-text-base">
                            Defer
                            <Switch
                              checked={deferred()}
                              disabled={!entry.type || isBusy(`defer:${name}`)}
                              onChange={(checked) =>
                                void updateEntry(name, { defer: checked }, "MCP server updated", `defer:${name}`)
                              }
                            />
                          </label>
                          <Button
                            size="small"
                            variant="ghost"
                            icon="trash"
                            disabled={isBusy(`remove:${name}`)}
                            onClick={() => void removeEntry(name)}
                          >
                            Remove
                          </Button>
                        </div>
                      </div>

                      <Show when={entry.type === "remote"}>
                        <div class="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_120px_auto]">
                          <TextField
                            label={`${name} URL`}
                            hideLabel
                            value={currentURL()}
                            onChange={(value) => setEdit(name, "url", value)}
                            placeholder="https://mcp.example.com/mcp/sse"
                            spellcheck={false}
                            autocorrect="off"
                            autocomplete="off"
                            autocapitalize="off"
                            class="text-12-regular"
                          />
                          <TextField
                            label={`${name} timeout`}
                            hideLabel
                            value={currentTimeout()}
                            onChange={(value) => setEdit(name, "timeout", value)}
                            placeholder="30000"
                            inputMode="numeric"
                            class="text-12-regular"
                          />
                          <Button
                            size="small"
                            variant="secondary"
                            disabled={isBusy(`save:${name}`)}
                            onClick={() => void saveRemote(name, entry)}
                          >
                            Save
                          </Button>
                        </div>
                      </Show>
                      <Show when={entry.type === "local"}>
                        <div class="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_120px_auto]">
                          <TextField
                            label={`${name} command`}
                            hideLabel
                            value={entry.command?.join(" ") ?? ""}
                            readOnly
                            copyable
                            class="text-12-regular"
                          />
                          <TextField
                            label={`${name} timeout`}
                            hideLabel
                            value={currentTimeout()}
                            onChange={(value) => setEdit(name, "timeout", value)}
                            placeholder="30000"
                            inputMode="numeric"
                            class="text-12-regular"
                          />
                          <Button
                            size="small"
                            variant="secondary"
                            disabled={isBusy(`save:${name}`)}
                            onClick={() => void saveRemote(name, entry)}
                          >
                            Save
                          </Button>
                        </div>
                      </Show>
                    </div>
                  )
                }}
              </For>
            </Show>
          </SettingsList>
        </div>

        <form
          class="flex flex-col gap-1"
          onSubmit={(event) => {
            event.preventDefault()
            void addServer()
          }}
        >
          <h3 class="text-14-medium text-text-strong pb-2">Add server</h3>
          <SettingsList>
            <div class="flex flex-col gap-3 py-4">
              <div class="inline-flex rounded-md border border-border-base bg-surface-base overflow-hidden self-start">
                <button
                  type="button"
                  class="h-8 px-3 text-12-medium border-0 border-r border-border-base"
                  classList={{
                    "bg-surface-raised text-text-strong": state.add.type === "remote",
                    "bg-transparent text-text-base hover:bg-surface-base-hover": state.add.type !== "remote",
                  }}
                  onClick={() => setState("add", "type", "remote")}
                >
                  Remote
                </button>
                <button
                  type="button"
                  class="h-8 px-3 text-12-medium border-0"
                  classList={{
                    "bg-surface-raised text-text-strong": state.add.type === "local",
                    "bg-transparent text-text-base hover:bg-surface-base-hover": state.add.type !== "local",
                  }}
                  onClick={() => setState("add", "type", "local")}
                >
                  Local
                </button>
              </div>
              <div class="grid grid-cols-1 gap-2 sm:grid-cols-[180px_minmax(0,1fr)_120px]">
                <TextField
                  label="MCP name"
                  hideLabel
                  value={state.add.name}
                  onChange={(value) => setState("add", "name", value)}
                  placeholder="remote_tools"
                  spellcheck={false}
                  autocorrect="off"
                  autocomplete="off"
                  autocapitalize="off"
                  class="text-12-regular"
                />
                <Show
                  when={state.add.type === "remote"}
                  fallback={
                    <TextField
                      label="Local MCP command"
                      hideLabel
                      value={state.add.command}
                      onChange={(value) => setState("add", "command", value)}
                      placeholder='node "C:\path\server.js" --stdio'
                      spellcheck={false}
                      autocorrect="off"
                      autocomplete="off"
                      autocapitalize="off"
                      class="text-12-regular"
                    />
                  }
                >
                  <TextField
                    label="Remote MCP URL"
                    hideLabel
                    value={state.add.url}
                    onChange={(value) => setState("add", "url", value)}
                    placeholder="https://mcp.example.com/mcp/sse"
                    spellcheck={false}
                    autocorrect="off"
                    autocomplete="off"
                    autocapitalize="off"
                    class="text-12-regular"
                  />
                </Show>
                <TextField
                  label="Timeout"
                  hideLabel
                  value={state.add.timeout}
                  onChange={(value) => setState("add", "timeout", value)}
                  placeholder="30000"
                  inputMode="numeric"
                  class="text-12-regular"
                />
              </div>
              <Show when={state.add.type === "local"}>
                <textarea
                  value={state.add.environment}
                  onInput={(event) => setState("add", "environment", event.currentTarget.value)}
                  placeholder={"Environment, one KEY=value per line, or JSON object"}
                  spellcheck={false}
                  autocomplete="off"
                  class="min-h-[72px] resize-y rounded-md border border-border-base bg-surface-base px-3 py-2 text-12-regular text-text-base outline-none focus:border-border-active"
                />
              </Show>
              <div class="flex flex-wrap items-center justify-between gap-3">
                <div class="flex flex-wrap items-center gap-5">
                  <label class="flex items-center gap-2 text-12-regular text-text-base">
                    Enabled
                    <Switch checked={state.add.enabled} onChange={(checked) => setState("add", "enabled", checked)} />
                  </label>
                  <label class="flex items-center gap-2 text-12-regular text-text-base">
                    Deferred
                    <Switch checked={state.add.defer} onChange={(checked) => setState("add", "defer", checked)} />
                  </label>
                </div>
                <Button type="submit" size="small" variant="secondary" icon="plus-small" disabled={state.pending === "add"}>
                  Add server
                </Button>
              </div>
            </div>
          </SettingsList>
        </form>
      </div>
    </div>
  )
}
