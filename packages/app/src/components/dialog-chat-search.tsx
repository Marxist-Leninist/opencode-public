import { Button } from "@opencode-ai/ui/button"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Icon } from "@opencode-ai/ui/icon"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { useNavigate } from "@solidjs/router"
import { createEffect, createMemo, createSignal, For, Show } from "solid-js"
import { useGlobalSDK } from "@/context/global-sdk"
import { useModels } from "@/context/models"
import { usePlatform } from "@/context/platform"
import { useServer } from "@/context/server"

type ChatSearchHit = {
  messageID: string
  partID?: string
  role: "user" | "assistant"
  type: string
  text: string
  snippet: string
  score: number
  time?: number
}

type ChatSearchResult = {
  session: {
    id: string
    title: string
    directory: string
    time: {
      updated: number
    }
  }
  score: number
  hits: ChatSearchHit[]
}

type SearchResponse = {
  query: string
  results: ChatSearchResult[]
}

type AugmentResponse = SearchResponse & {
  answer: string
  model: {
    providerID: string
    modelID: string
  }
}

type Mode = "classic" | "ai"

export function DialogChatSearch(props: { initialDirectory?: string }) {
  const dialog = useDialog()
  const navigate = useNavigate()
  const globalSDK = useGlobalSDK()
  const server = useServer()
  const platform = usePlatform()
  const models = useModels()

  const [query, setQuery] = createSignal("")
  const [mode, setMode] = createSignal<Mode>("classic")
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal("")
  const [results, setResults] = createSignal<ChatSearchResult[]>([])
  const [answer, setAnswer] = createSignal("")
  const [selectedModel, setSelectedModel] = createSignal("")

  const visibleModels = createMemo(() =>
    models
      .list()
      .filter((model) => models.visible({ providerID: model.provider.id, modelID: model.id }))
      .sort((a, b) => a.provider.name.localeCompare(b.provider.name) || a.name.localeCompare(b.name)),
  )

  const preferredModel = createMemo(() => {
    const list = visibleModels()
    const recent = models.recent
      .list()
      .map((item) => list.find((model) => model.provider.id === item.providerID && model.id === item.modelID))
      .find(Boolean)
    return (
      list.find((model) => /deepseek/i.test(`${model.provider.name} ${model.name} ${model.id}`)) ??
      list.find((model) => /ring/i.test(`${model.provider.name} ${model.name} ${model.id}`)) ??
      recent ??
      list[0]
    )
  })

  createEffect(() => {
    if (selectedModel()) return
    const model = preferredModel()
    if (model) setSelectedModel(`${model.provider.id}/${model.id}`)
  })

  function headers(json = false) {
    const output: Record<string, string> = {
      accept: "application/json",
    }
    if (json) output["content-type"] = "application/json"

    const http = server.current?.http
    if (http?.password) {
      output.authorization = `Basic ${btoa(`${http.username ?? "opencode"}:${http.password}`)}`
    }
    return output
  }

  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const fetcher = platform.fetch ?? fetch
    const response = await fetcher(`${globalSDK.url}${path}`, init)
    if (!response.ok) {
      const text = await response.text().catch(() => "")
      throw new Error(text || `Search failed with HTTP ${response.status}`)
    }
    return (await response.json()) as T
  }

  function modelBody() {
    const value = selectedModel()
    if (!value) return
    const [providerID, ...rest] = value.split("/")
    const modelID = rest.join("/")
    if (!providerID || !modelID) return
    return { providerID, modelID }
  }

  async function run(nextMode = mode()) {
    const trimmed = query().trim()
    if (!trimmed) return

    setMode(nextMode)
    setBusy(true)
    setError("")
    if (nextMode === "classic") setAnswer("")

    try {
      if (nextMode === "ai") {
        const response = await request<AugmentResponse>("/session/search/augment", {
          method: "POST",
          headers: headers(true),
          body: JSON.stringify({
            query: trimmed,
            directory: props.initialDirectory || undefined,
            limit: 20,
            model: modelBody(),
          }),
        })
        setAnswer(response.answer)
        setResults(response.results)
        return
      }

      const params = new URLSearchParams({
        query: trimmed,
        limit: "20",
      })
      if (props.initialDirectory) params.set("directory", props.initialDirectory)
      const response = await request<SearchResponse>(`/session/search?${params.toString()}`, {
        headers: headers(),
      })
      setResults(response.results)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  function openResult(result: ChatSearchResult) {
    navigate(`/${base64Encode(result.session.directory)}/session/${result.session.id}`)
    dialog.close()
  }

  function updated(result: ChatSearchResult) {
    return new Date(result.session.time.updated).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    })
  }

  return (
    <Dialog title="Search chats" size="large" transition class="w-[min(calc(100vw-40px),860px)]">
      <div class="flex flex-col gap-4 min-h-0">
        <form
          class="flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            void run()
          }}
        >
          <div class="relative flex-1 min-w-0">
            <div class="absolute left-3 top-1/2 -translate-y-1/2 text-icon-weak">
              <Icon name="magnifying-glass" />
            </div>
            <input
              autofocus
              value={query()}
              onInput={(event) => setQuery(event.currentTarget.value)}
              placeholder="Search chat text, tool output, titles..."
              class="w-full h-10 pl-10 pr-3 rounded-md border border-border-base bg-surface-base text-14-regular text-text-strong outline-none focus:border-border-strong"
            />
          </div>
          <Button type="submit" size="large" disabled={busy() || !query().trim()}>
            Search
          </Button>
        </form>

        <div class="flex items-center justify-between gap-3">
          <div class="inline-flex rounded-md border border-border-base bg-surface-base overflow-hidden">
            <button
              type="button"
              class="h-8 px-3 text-13-medium border-0 border-r border-border-base"
              classList={{
                "bg-surface-raised text-text-strong": mode() === "classic",
                "bg-transparent text-text-base hover:bg-surface-base-hover": mode() !== "classic",
              }}
              onClick={() => void run("classic")}
            >
              Classic
            </button>
            <button
              type="button"
              class="h-8 px-3 text-13-medium border-0"
              classList={{
                "bg-surface-raised text-text-strong": mode() === "ai",
                "bg-transparent text-text-base hover:bg-surface-base-hover": mode() !== "ai",
              }}
              onClick={() => void run("ai")}
            >
              AI
            </button>
          </div>

          <Show when={mode() === "ai"}>
            <select
              value={selectedModel()}
              onChange={(event) => setSelectedModel(event.currentTarget.value)}
              class="h-8 max-w-[360px] rounded-md border border-border-base bg-surface-base px-2 text-13-regular text-text-base outline-none"
            >
              <For each={visibleModels()}>
                {(model) => (
                  <option value={`${model.provider.id}/${model.id}`}>
                    {model.provider.name} / {model.name}
                  </option>
                )}
              </For>
            </select>
          </Show>
        </div>

        <Show when={error()}>
          <div class="rounded-md border border-border-critical bg-surface-base px-3 py-2 text-13-regular text-text-critical">
            {error()}
          </div>
        </Show>

        <Show when={mode() === "ai" && answer()}>
          <div class="rounded-md border border-border-base bg-surface-raised px-3 py-2 text-13-regular text-text-base whitespace-pre-wrap">
            {answer()}
          </div>
        </Show>

        <div class="min-h-[260px] max-h-[min(calc(100vh-320px),520px)] overflow-y-auto no-scrollbar border border-border-base rounded-md divide-y divide-border-base">
          <Show
            when={results().length > 0}
            fallback={
              <div class="h-[260px] flex items-center justify-center text-13-regular text-text-weak">
                {busy() ? "Searching..." : "No results"}
              </div>
            }
          >
            <For each={results()}>
              {(result) => (
                <button
                  type="button"
                  class="w-full text-left p-3 bg-transparent hover:bg-surface-base-hover border-0 flex flex-col gap-2"
                  onClick={() => openResult(result)}
                >
                  <div class="flex items-center justify-between gap-3">
                    <div class="min-w-0 flex items-center gap-2">
                      <Icon name="speech-bubble" />
                      <span class="truncate text-14-medium text-text-strong">{result.session.title}</span>
                    </div>
                    <span class="shrink-0 text-12-regular text-text-weak">{updated(result)}</span>
                  </div>
                  <div class="text-12-regular text-text-weak truncate">{result.session.directory}</div>
                  <Show when={result.hits[0]}>
                    {(hit) => (
                      <div class="text-13-regular text-text-base leading-5 line-clamp-3">
                        <span class="text-text-weak">{hit().role}: </span>
                        {hit().snippet}
                      </div>
                    )}
                  </Show>
                </button>
              )}
            </For>
          </Show>
        </div>
      </div>
    </Dialog>
  )
}
