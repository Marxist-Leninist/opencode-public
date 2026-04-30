import type { Config } from "@opencode-ai/sdk/v2/client"
import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { Tag } from "@opencode-ai/ui/tag"
import { TextField } from "@opencode-ai/ui/text-field"
import { showToast } from "@opencode-ai/ui/toast"
import { createMemo, type Component, For, Show } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { useGlobalSync } from "@/context/global-sync"
import { useLanguage } from "@/context/language"
import { SettingsList } from "./settings-list"

type PluginOptions = Record<string, unknown>
type PluginSpec = string | [string, PluginOptions]

function configuredPlugins(config: Config) {
  return (config.plugin ?? []) as PluginSpec[]
}

function pluginSpecifier(spec: PluginSpec) {
  return Array.isArray(spec) ? spec[0] : spec
}

function pluginOptionsText(spec: PluginSpec) {
  return Array.isArray(spec) ? JSON.stringify(spec[1]) : ""
}

function pluginKind(specifier: string) {
  if (/^(?:\.{1,2}[\\/]|[a-zA-Z]:[\\/]|\/|file:)/.test(specifier)) return "path"
  return "package"
}

function parseSpecifier(value: string) {
  const specifier = value.trim()
  if (!specifier) throw new Error("Plugin package or path is required.")
  return specifier
}

function parseOptions(value: string) {
  const trimmed = value.trim()
  if (!trimmed) return undefined
  const parsed = JSON.parse(trimmed) as unknown
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error("Plugin options must be a JSON object.")
  }
  return parsed as PluginOptions
}

function buildPlugin(specifier: string, options: PluginOptions | undefined): PluginSpec {
  return options ? [specifier, options] : specifier
}

export const SettingsPlugins: Component = () => {
  const language = useLanguage()
  const globalSync = useGlobalSync()

  const [state, setState] = createStore({
    pending: "",
    add: {
      specifier: "",
      options: "",
    },
    edit: {} as Record<string, { specifier?: string; options?: string }>,
  })

  const plugins = createMemo(() => configuredPlugins(globalSync.data.config))

  const setEdit = (index: number, key: "specifier" | "options", value: string) => {
    setState(
      "edit",
      produce((draft) => {
        const id = String(index)
        draft[id] ??= {}
        draft[id][key] = value
      }),
    )
  }

  const updatePlugins = async (next: PluginSpec[], title: string, pending: string) => {
    setState("pending", pending)
    try {
      await globalSync.updateConfig({ plugin: next } as Config)
      showToast({ variant: "success", icon: "circle-check", title })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      showToast({ variant: "error", title: language.t("common.requestFailed"), description: message })
    } finally {
      setState("pending", "")
    }
  }

  const addPlugin = async () => {
    let specifier: string
    let options: PluginOptions | undefined
    try {
      specifier = parseSpecifier(state.add.specifier)
      options = parseOptions(state.add.options)
    } catch (err) {
      showToast({
        variant: "error",
        title: "Invalid plugin",
        description: err instanceof Error ? err.message : String(err),
      })
      return
    }
    if (plugins().some((item) => pluginSpecifier(item) === specifier)) {
      showToast({ variant: "error", title: "Plugin already exists", description: `${specifier} is already configured.` })
      return
    }

    await updatePlugins([...plugins(), buildPlugin(specifier, options)], "Plugin added", "add")
    setState("add", { specifier: "", options: "" })
  }

  const savePlugin = (index: number, spec: PluginSpec) => {
    const id = String(index)
    const edit = state.edit[id]
    let specifier: string
    let options: PluginOptions | undefined
    try {
      specifier = parseSpecifier(edit?.specifier ?? pluginSpecifier(spec))
      options = parseOptions(edit?.options ?? pluginOptionsText(spec))
    } catch (err) {
      showToast({
        variant: "error",
        title: "Invalid plugin",
        description: err instanceof Error ? err.message : String(err),
      })
      return
    }
    if (plugins().some((item, itemIndex) => itemIndex !== index && pluginSpecifier(item) === specifier)) {
      showToast({ variant: "error", title: "Plugin already exists", description: `${specifier} is already configured.` })
      return
    }

    const next = plugins().map((item, itemIndex) => (itemIndex === index ? buildPlugin(specifier, options) : item))
    return updatePlugins(next, "Plugin saved", `save:${index}`).then(() =>
      setState(
        "edit",
        produce((draft) => {
          delete draft[id]
        }),
      ),
    )
  }

  const removePlugin = (index: number) => {
    const next = plugins().filter((_, itemIndex) => itemIndex !== index)
    return updatePlugins(next, "Plugin removed", `remove:${index}`)
  }

  const isBusy = (key: string) => state.pending === key

  return (
    <div class="flex flex-col h-full overflow-y-auto no-scrollbar px-4 pb-10 sm:px-10 sm:pb-10">
      <div class="sticky top-0 z-10 bg-[linear-gradient(to_bottom,var(--surface-stronger-non-alpha)_calc(100%_-_24px),transparent)]">
        <div class="flex flex-col gap-2 pt-6 pb-8 max-w-[760px]">
          <h2 class="text-16-medium text-text-strong">Plugins</h2>
          <p class="text-13-regular text-text-weak">Install extension packages or local plugin paths into the active config.</p>
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
          <div class="flex items-center justify-between gap-4 pb-2">
            <h3 class="text-14-medium text-text-strong">Configured plugins</h3>
            <Tag>{plugins().length} total</Tag>
          </div>
          <SettingsList>
            <Show
              when={plugins().length > 0}
              fallback={<div class="py-4 text-14-regular text-text-weak">No plugins configured yet.</div>}
            >
              <For each={plugins()}>
                {(spec, index) => {
                  const itemIndex = () => index()
                  const edit = () => state.edit[String(itemIndex())]
                  const currentSpecifier = () => edit()?.specifier ?? pluginSpecifier(spec)
                  const currentOptions = () => edit()?.options ?? pluginOptionsText(spec)
                  return (
                    <div class="flex flex-col gap-3 py-4 border-b border-border-weak-base last:border-none">
                      <div class="flex flex-wrap items-start justify-between gap-3">
                        <div class="flex min-w-0 flex-col gap-1">
                          <div class="flex flex-wrap items-center gap-2">
                            <span class="text-14-medium text-text-strong truncate">{pluginSpecifier(spec)}</span>
                            <Tag>{pluginKind(pluginSpecifier(spec))}</Tag>
                            <Show when={Array.isArray(spec)}>
                              <Tag>options</Tag>
                            </Show>
                          </div>
                        </div>
                        <Button
                          size="small"
                          variant="ghost"
                          icon="trash"
                          disabled={isBusy(`remove:${itemIndex()}`)}
                          onClick={() => void removePlugin(itemIndex())}
                        >
                          Remove
                        </Button>
                      </div>
                      <div class="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
                        <TextField
                          label="Plugin package or path"
                          hideLabel
                          value={currentSpecifier()}
                          onChange={(value) => setEdit(itemIndex(), "specifier", value)}
                          placeholder="@scope/opencode-plugin"
                          spellcheck={false}
                          autocorrect="off"
                          autocomplete="off"
                          autocapitalize="off"
                          class="text-12-regular"
                        />
                        <TextField
                          label="Plugin options JSON"
                          hideLabel
                          value={currentOptions()}
                          onChange={(value) => setEdit(itemIndex(), "options", value)}
                          placeholder='{"key":"value"}'
                          spellcheck={false}
                          autocorrect="off"
                          autocomplete="off"
                          autocapitalize="off"
                          class="text-12-regular"
                        />
                        <Button
                          size="small"
                          variant="secondary"
                          disabled={isBusy(`save:${itemIndex()}`)}
                          onClick={() => void savePlugin(itemIndex(), spec)}
                        >
                          Save
                        </Button>
                      </div>
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
            void addPlugin()
          }}
        >
          <h3 class="text-14-medium text-text-strong pb-2">Add plugin</h3>
          <SettingsList>
            <div class="flex flex-col gap-3 py-4">
              <div class="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
                <TextField
                  label="Plugin package or path"
                  hideLabel
                  value={state.add.specifier}
                  onChange={(value) => setState("add", "specifier", value)}
                  placeholder="@scope/opencode-plugin"
                  spellcheck={false}
                  autocorrect="off"
                  autocomplete="off"
                  autocapitalize="off"
                  class="text-12-regular"
                />
                <TextField
                  label="Plugin options JSON"
                  hideLabel
                  value={state.add.options}
                  onChange={(value) => setState("add", "options", value)}
                  placeholder='{"key":"value"}'
                  spellcheck={false}
                  autocorrect="off"
                  autocomplete="off"
                  autocapitalize="off"
                  class="text-12-regular"
                />
                <Button type="submit" size="small" variant="secondary" icon="plus-small" disabled={state.pending === "add"}>
                  Add plugin
                </Button>
              </div>
            </div>
          </SettingsList>
          <div class="flex items-start gap-2 pt-2 text-12-regular text-text-weak">
            <Icon name="help" size="small" />
            <span>Changes apply after the server reloads its plugin list.</span>
          </div>
        </form>
      </div>
    </div>
  )
}
