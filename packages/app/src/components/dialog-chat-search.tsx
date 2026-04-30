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
import { useProviders } from "@/hooks/use-providers"
import {
  clampChatSearchIndex,
  moveChatSearchIndex,
  parseChatSearchModelSelection,
  splitChatSearchHighlight,
} from "./dialog-chat-search-utils"

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
  rankedCount?: number
  source?: "classic" | "rerank" | "semantic"
}

type Mode = "classic" | "ai"

const CHAT_SEARCH_MODEL_OPTIONS = [
  {
    providerID: "openrouter",
    modelID: "openrouter/auto@preset/latency",
  },
  {
    providerID: "openrouter",
    modelID: "openrouter/free@preset/latency",
  },
  {
    providerID: "openrouter",
    modelID: "inception/mercury-2",
  },
] as const

export function DialogChatSearch(props: { initialDirectory?: string }) {
  const dialog = useDialog()
  const navigate = useNavigate()
  const globalSDK = useGlobalSDK()
  const server = useServer()
  const platform = usePlatform()
  const models = useModels()
  const providers = useProviders()

  const STORAGE_MODE = "opencode.chatSearch.mode"
  const STORAGE_MODEL = "opencode.chatSearch.model"

  const persistedMode = (): Mode => {
    try {
      const v = localStorage.getItem(STORAGE_MODE)
      return v === "ai" ? "ai" : "classic"
    } catch {
      return "classic"
    }
  }
  const persistedModel = (): string => {
    try {
      return localStorage.getItem(STORAGE_MODEL) ?? ""
    } catch {
      return ""
    }
  }

  const [query, setQuery] = createSignal("")
  const [mode, setModeRaw] = createSignal<Mode>(persistedMode())
  const setMode = (next: Mode) => {
    try {
      localStorage.setItem(STORAGE_MODE, next)
    } catch {}
    setModeRaw(next)
  }
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal("")
  const [results, setResults] = createSignal<ChatSearchResult[]>([])
  const [answer, setAnswer] = createSignal("")
  const [aiDebug, setAiDebug] = createSignal("")
  const [selectedModel, setSelectedModelRaw] = createSignal(persistedModel())
  const setSelectedModel = (next: string) => {
    if (next) {
      try {
        localStorage.setItem(STORAGE_MODEL, next)
      } catch {}
    }
    setSelectedModelRaw(next)
  }
  const [selectedModelTouched, setSelectedModelTouched] = createSignal(persistedModel() !== "")
  const [activeIndex, setActiveIndex] = createSignal(0)

  const chatSearchModelOptions = createMemo(() => {
    return CHAT_SEARCH_MODEL_OPTIONS.flatMap((option) => {
      const provider = providers.all().find((item) => item.id === option.providerID)
      const model = provider?.models[option.modelID]
      if (!provider || !model) return []
      return [{ ...model, provider }]
    })
  })

  const visibleModels = createMemo(() => {
    const list = models
      .list()
      .filter((model) => models.visible({ providerID: model.provider.id, modelID: model.id }))
      .sort((a, b) => a.provider.name.localeCompare(b.provider.name) || a.name.localeCompare(b.name))
    const forced = chatSearchModelOptions()
    if (forced.length === 0) return list
    return [
      ...forced,
      ...list.filter(
        (model) => !forced.some((forcedModel) => model.provider.id === forcedModel.provider.id && model.id === forcedModel.id),
      ),
    ]
  })

  const preferredModel = createMemo(() => {
    const list = visibleModels()
    const recent = models.recent
      .list()
      .map((item) => list.find((model) => model.provider.id === item.providerID && model.id === item.modelID))
      .find(Boolean)
    return (
      chatSearchModelOptions()[0] ??
      list.find((model) => /deepseek/i.test(`${model.provider.name} ${model.name} ${model.id}`)) ??
      list.find((model) => /ring/i.test(`${model.provider.name} ${model.name} ${model.id}`)) ??
      recent ??
      list[0]
    )
  })

  createEffect(() => {
    if (selectedModelTouched()) return
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
    return parseChatSearchModelSelection(selectedModel())
  }

  function modelLabel(ref?: { providerID: string; modelID: string }) {
    if (!ref) return "selected model"
    const model = visibleModels().find((item) => item.provider.id === ref.providerID && item.id === ref.modelID)
    return model ? `${model.provider.name} / ${model.name}` : `${ref.providerID}/${ref.modelID}`
  }

  function classicSearch(trimmed: string) {
    const params = new URLSearchParams({
      query: trimmed,
      limit: "20",
    })
    if (props.initialDirectory) params.set("directory", props.initialDirectory)
    return request<SearchResponse>(`/session/search?${params.toString()}`, {
      headers: headers(),
    })
  }

  async function run(nextMode = mode()) {
    setMode(nextMode)
    const trimmed = query().trim()
    if (!trimmed) return

    setBusy(true)
    setError("")
    setAiDebug("")
    setActiveIndex(0)
    if (nextMode === "classic") setAnswer("")

    try {
      if (nextMode === "ai") {
        setAnswer("")
        setAiDebug("Classic search running...")
        const classic = await classicSearch(trimmed)
        setResults(classic.results)
        setAiDebug(
          `Classic: ${classic.results.length} ${classic.results.length === 1 ? "match" : "matches"} shown. AI running...`,
        )
        const aiStart = performance.now()
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
        const elapsed = ((performance.now() - aiStart) / 1000).toFixed(1)
        setAnswer(response.answer)
        const aiResultCount = response.results.length
        const classicCount = classic.results.length
        if (aiResultCount > 0) {
          setResults(response.results)
          setActiveIndex(0)
        } else {
          setAnswer(
            classicCount > 0 && response.answer.trim().toLowerCase() === "no matching chats found."
              ? "AI did not return better ranked matches; showing classic search results."
              : response.answer,
          )
          setResults(classic.results)
          setActiveIndex(0)
        }
        const sourceLabel = response.source === "rerank"
          ? "reranked"
          : response.source === "semantic"
          ? "semantic"
          : "classic"
        const ranked = response.rankedCount ?? aiResultCount
        setAiDebug(
          ranked > 0
            ? `AI ${sourceLabel} via ${modelLabel(response.model)} in ${elapsed}s - ${ranked} ranked, showing ${aiResultCount} result${aiResultCount === 1 ? "" : "s"}.`
            : `AI via ${modelLabel(response.model)} in ${elapsed}s - 0 ranked, showing ${classicCount} classic ${classicCount === 1 ? "match" : "matches"}.`,
        )
        return
      }

      const response = await classicSearch(trimmed)
      setResults(response.results)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      if (nextMode === "ai") setAiDebug("AI search failed before a response was received.")
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
              onKeyDown={(event) => {
                const list = results()
                if (event.key === "ArrowDown" && list.length > 0) {
                  event.preventDefault()
                  setActiveIndex((i) => moveChatSearchIndex(i, list.length, 1))
                } else if (event.key === "ArrowUp" && list.length > 0) {
                  event.preventDefault()
                  setActiveIndex((i) => moveChatSearchIndex(i, list.length, -1))
                } else if (event.key === "Enter" && !query().trim() && list.length > 0) {
                  event.preventDefault()
                  const target = list[activeIndex()]
                  if (target) openResult(target)
                } else if (event.key === "Enter" && list.length > 0 && (event.ctrlKey || event.metaKey)) {
                  event.preventDefault()
                  const target = list[activeIndex()]
                  if (target) openResult(target)
                }
              }}
              placeholder="Search chat text, tool output, titles... (↑/↓ navigate, Ctrl+Enter open)"
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
              onClick={() => {
                setMode("classic")
                if (query().trim()) void run("classic")
              }}
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
              onClick={() => {
                setMode("ai")
                if (query().trim()) void run("ai")
              }}
            >
              AI
            </button>
          </div>

          <Show when={mode() === "ai"}>
            <select
              value={selectedModel()}
              onChange={(event) => {
                setSelectedModelTouched(true)
                setSelectedModel(event.currentTarget.value)
              }}
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

        <Show when={mode() === "ai" && aiDebug()}>
          <div class="rounded-md border border-border-base bg-surface-base px-3 py-2 text-12-regular text-text-weak">
            {aiDebug()}
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
              {(result, index) => (
                <button
                  type="button"
                  class="w-full text-left p-3 bg-transparent border-0 flex flex-col gap-2"
                  classList={{
                    "bg-surface-raised": activeIndex() === index(),
                    "hover:bg-surface-base-hover": activeIndex() !== index(),
                  }}
                  onClick={() => openResult(result)}
                  onMouseEnter={() => setActiveIndex(clampChatSearchIndex(index(), results().length))}
                >
                  <div class="flex items-center justify-between gap-3">
                    <div class="min-w-0 flex items-center gap-2">
                      <Icon name="speech-bubble" />
                      <span class="truncate text-14-medium text-text-strong">{result.session.title}</span>
                      <Show when={result.hits.length > 0}>
                        <span class="shrink-0 text-11-regular text-text-weak rounded bg-surface-base px-1.5 py-0.5">
                          {result.hits.length} {result.hits.length === 1 ? "hit" : "hits"}
                        </span>
                      </Show>
                    </div>
                    <span class="shrink-0 text-12-regular text-text-weak">{updated(result)}</span>
                  </div>
                  <div class="text-12-regular text-text-weak truncate">{result.session.directory}</div>
                  <For each={result.hits.slice(0, 3)}>
                    {(hit) => (
                      <div class="text-13-regular text-text-base leading-5 line-clamp-2">
                        <span class="text-text-weak">{hit.role}: </span>
                        <For each={splitChatSearchHighlight(hit.snippet, query())}>
                          {(part) => {
                            return part.match ? (
                              <mark class="bg-yellow-300/30 text-text-strong rounded px-0.5">{part.text}</mark>
                            ) : (
                              <>{part.text}</>
                            )
                          }}
                        </For>
                      </div>
                    )}
                  </For>
                  <Show when={result.hits.length > 3}>
                    <div class="text-11-regular text-text-weak">+{result.hits.length - 3} more hits</div>
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
