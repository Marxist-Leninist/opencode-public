import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Switch } from "@opencode-ai/ui/switch"
import { TextField } from "@opencode-ai/ui/text-field"
import { showToast } from "@opencode-ai/ui/toast"
import { useMutation } from "@tanstack/solid-query"
import { batch, For, Show, createSignal } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { useSDK } from "@/context/sdk"
import { useGlobalSync } from "@/context/global-sync"
import { useSync } from "@/context/sync"
import {
  buildMcpServerConfig,
  emptyMcpKvRow,
  parseMcpName,
  type McpKvRow,
  type McpTransport,
} from "./mcp-config-utils"

type FormState = {
  name: string
  transport: McpTransport
  command: string
  url: string
  enabled: boolean
  defer: boolean
  timeout: string
  headers: McpKvRow[]
  environment: McpKvRow[]
  err: Record<string, string>
}

function validate(form: FormState): Record<string, string> {
  const err: Record<string, string> = {}
  try {
    parseMcpName(form.name)
  } catch (error) {
    err.name = error instanceof Error ? error.message : String(error)
  }
  try {
    buildMcpServerConfig(form)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes("URL")) err.url = message
    else if (message.includes("Command")) err.command = message
    else if (message.includes("Timeout")) err.timeout = message
    else err.form = message
  }
  return err
}

export function DialogAddMcp() {
  const dialog = useDialog()
  const sdk = useSDK()
  const globalSync = useGlobalSync()
  const sync = useSync()
  const [showAdvanced, setShowAdvanced] = createSignal(false)

  const [form, setForm] = createStore<FormState>({
    name: "",
    transport: "remote",
    command: "",
    url: "",
    enabled: true,
    defer: false,
    timeout: "",
    headers: [emptyMcpKvRow()],
    environment: [emptyMcpKvRow()],
    err: {},
  })

  const addRow = (field: "headers" | "environment") => {
    setForm(
      field,
      produce((rows: McpKvRow[]) => {
        rows.push(emptyMcpKvRow())
      }),
    )
  }

  const removeRow = (field: "headers" | "environment", index: number) => {
    setForm(
      field,
      produce((rows: McpKvRow[]) => {
        if (rows.length <= 1) return
        rows.splice(index, 1)
      }),
    )
  }

  const submit = useMutation(() => ({
    mutationFn: async () => {
      const errs = validate(form)
      if (Object.keys(errs).length > 0) {
        setForm("err", errs)
        throw new Error("Please fix the highlighted fields.")
      }
      const name = parseMcpName(form.name)
      const config = buildMcpServerConfig(form)
      // The generated SDK type lags SG's `defer` MCP config field.
      const result = await sdk.client.mcp.add({ name, config: config as any })
      return result.data
    },
    onSuccess: (data) => {
      if (data) sync.set("mcp", data)
      void globalSync.bootstrap()
      showToast({
        variant: "success",
        title: `Added MCP server "${form.name.trim()}"`,
      })
      dialog.close()
    },
    onError: (err) => {
      showToast({
        variant: "error",
        title: "Failed to add MCP server",
        description: err instanceof Error ? err.message : String(err),
      })
    },
  }))

  return (
    <Dialog title="Add MCP server" description="Connect a new Model Context Protocol server.">
      <form
        class="flex flex-col gap-4 min-w-[480px]"
        onSubmit={(e) => {
          e.preventDefault()
          batch(() => {
            setForm("err", {})
            submit.mutate()
          })
        }}
      >
        <Show when={form.err.form}>
          <span class="text-12-regular text-text-critical">{form.err.form}</span>
        </Show>

        <div class="flex flex-col gap-1.5">
          <label class="text-13-medium text-text-strong">Name</label>
          <TextField
            value={form.name}
            placeholder="my-server"
            onChange={(v) => setForm("name", v)}
            onInput={(e) => setForm("name", (e.currentTarget as HTMLInputElement).value)}
          />
          <Show when={form.err.name}>
            <span class="text-12-regular text-text-critical">{form.err.name}</span>
          </Show>
        </div>

        <div class="flex flex-col gap-1.5">
          <label class="text-13-medium text-text-strong">Transport</label>
          <div class="inline-flex rounded-md border border-border-base bg-surface-base overflow-hidden self-start">
            <button
              type="button"
              class="h-8 px-3 text-13-medium border-0 border-r border-border-base"
              classList={{
                "bg-surface-raised text-text-strong": form.transport === "remote",
                "bg-transparent text-text-base hover:bg-surface-base-hover": form.transport !== "remote",
              }}
              onClick={() => setForm("transport", "remote")}
            >
              Remote (HTTP/SSE)
            </button>
            <button
              type="button"
              class="h-8 px-3 text-13-medium border-0"
              classList={{
                "bg-surface-raised text-text-strong": form.transport === "local",
                "bg-transparent text-text-base hover:bg-surface-base-hover": form.transport !== "local",
              }}
              onClick={() => setForm("transport", "local")}
            >
              Local (stdio)
            </button>
          </div>
        </div>

        <Show when={form.transport === "remote"}>
          <div class="flex flex-col gap-1.5">
            <label class="text-13-medium text-text-strong">URL</label>
            <TextField
              value={form.url}
              placeholder="https://example.com/mcp/sse"
              onChange={(v) => setForm("url", v)}
              onInput={(e) => setForm("url", (e.currentTarget as HTMLInputElement).value)}
            />
            <Show when={form.err.url}>
              <span class="text-12-regular text-text-critical">{form.err.url}</span>
            </Show>
          </div>
        </Show>

        <Show when={form.transport === "local"}>
          <div class="flex flex-col gap-1.5">
            <label class="text-13-medium text-text-strong">Command</label>
            <TextField
              value={form.command}
              placeholder="python /path/to/server.py"
              onChange={(v) => setForm("command", v)}
              onInput={(e) => setForm("command", (e.currentTarget as HTMLInputElement).value)}
            />
            <span class="text-11-regular text-text-weak">Will be split on whitespace into argv.</span>
            <Show when={form.err.command}>
              <span class="text-12-regular text-text-critical">{form.err.command}</span>
            </Show>
          </div>
        </Show>

        <div class="flex items-center gap-6">
          <label class="flex items-center gap-2 text-13-regular text-text-base cursor-pointer">
            <Switch checked={form.enabled} onChange={(v) => setForm("enabled", v)} />
            <span>Enabled on startup</span>
          </label>
          <label class="flex items-center gap-2 text-13-regular text-text-base cursor-pointer">
            <Switch checked={form.defer} onChange={(v) => setForm("defer", v)} />
            <span>Deferred tool loading</span>
          </label>
        </div>

        <button
          type="button"
          class="self-start text-12-regular text-text-weak hover:text-text-base bg-transparent border-0 p-0"
          onClick={() => setShowAdvanced((v) => !v)}
        >
          {showAdvanced() ? "Hide" : "Show"} advanced
        </button>

        <Show when={showAdvanced()}>
          <div class="flex flex-col gap-3 pl-3 border-l border-border-base">
            <div class="flex flex-col gap-1.5">
              <label class="text-13-medium text-text-strong">Timeout (ms)</label>
              <TextField
                value={form.timeout}
                placeholder="5000"
                onChange={(v) => setForm("timeout", v)}
                onInput={(e) => setForm("timeout", (e.currentTarget as HTMLInputElement).value)}
              />
              <Show when={form.err.timeout}>
                <span class="text-12-regular text-text-critical">{form.err.timeout}</span>
              </Show>
            </div>

            <Show when={form.transport === "remote"}>
              <div class="flex flex-col gap-1.5">
                <label class="text-13-medium text-text-strong">Headers</label>
                <For each={form.headers}>
                  {(row, i) => (
                    <div class="flex gap-2 items-center">
                      <TextField
                        value={row.key}
                        placeholder="Authorization"
                        onChange={(v) => setForm("headers", i(), "key", v)}
                        onInput={(e) =>
                          setForm("headers", i(), "key", (e.currentTarget as HTMLInputElement).value)
                        }
                      />
                      <TextField
                        value={row.value}
                        placeholder="Bearer ..."
                        onChange={(v) => setForm("headers", i(), "value", v)}
                        onInput={(e) =>
                          setForm("headers", i(), "value", (e.currentTarget as HTMLInputElement).value)
                        }
                      />
                      <IconButton
                        type="button"
                        icon="trash"
                        size="small"
                        disabled={form.headers.length <= 1}
                        onClick={() => removeRow("headers", i())}
                      />
                    </div>
                  )}
                </For>
                <button
                  type="button"
                  class="self-start text-12-regular text-text-weak hover:text-text-base bg-transparent border-0 p-0"
                  onClick={() => addRow("headers")}
                >
                  + Add header
                </button>
              </div>
            </Show>

            <Show when={form.transport === "local"}>
              <div class="flex flex-col gap-1.5">
                <label class="text-13-medium text-text-strong">Environment variables</label>
                <For each={form.environment}>
                  {(row, i) => (
                    <div class="flex gap-2 items-center">
                      <TextField
                        value={row.key}
                        placeholder="API_KEY"
                        onChange={(v) => setForm("environment", i(), "key", v)}
                        onInput={(e) =>
                          setForm("environment", i(), "key", (e.currentTarget as HTMLInputElement).value)
                        }
                      />
                      <TextField
                        value={row.value}
                        placeholder="..."
                        onChange={(v) => setForm("environment", i(), "value", v)}
                        onInput={(e) =>
                          setForm("environment", i(), "value", (e.currentTarget as HTMLInputElement).value)
                        }
                      />
                      <IconButton
                        type="button"
                        icon="trash"
                        size="small"
                        disabled={form.environment.length <= 1}
                        onClick={() => removeRow("environment", i())}
                      />
                    </div>
                  )}
                </For>
                <button
                  type="button"
                  class="self-start text-12-regular text-text-weak hover:text-text-base bg-transparent border-0 p-0"
                  onClick={() => addRow("environment")}
                >
                  + Add variable
                </button>
              </div>
            </Show>
          </div>
        </Show>

        <div class="flex justify-end gap-2 pt-2 border-t border-border-base">
          <Button type="button" variant="secondary" onClick={() => dialog.close()}>
            Cancel
          </Button>
          <Button type="submit" disabled={submit.isPending}>
            {submit.isPending ? "Adding..." : "Add server"}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
