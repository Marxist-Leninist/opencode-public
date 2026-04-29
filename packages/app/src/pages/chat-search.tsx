import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { Switch as Toggle } from "@opencode-ai/ui/switch"
import { showToast } from "@opencode-ai/ui/toast"
import { useNavigate, useParams } from "@solidjs/router"
import { createMemo, createSignal, For, Show } from "solid-js"
import { useSDK } from "@/context/sdk"
import { useLocal } from "@/context/local"
import { decode64 } from "@/utils/base64"

type Hit = {
  id: string
  title: string
  directory?: string
  snippet?: string
  score: number
  why?: string
  matched_at?: number
  matched_role?: "user" | "assistant"
}

type SearchResponse = {
  hits: Hit[]
  mode: "classical" | "ai"
  elapsed_ms: number
  scanned: number
  truncated: boolean
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

const inputClass =
  "h-9 w-full rounded-md border border-border-weak-base bg-background-base px-3 text-13-regular text-text-strong outline-none focus:border-border-focus"
const labelClass = "flex flex-col gap-1 text-12-medium text-text-base"

function fmtMs(ms: number) {
  if (ms < 1000) return `${ms} ms`
  return `${(ms / 1000).toFixed(2)} s`
}

function fmtRel(when?: number) {
  if (!when) return ""
  const diff = Date.now() - when
  if (diff < 60_000) return "just now"
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  return `${Math.floor(diff / 86_400_000)}d ago`
}

export default function ChatSearchPage() {
  const sdk = useSDK()
  const local = useLocal()
  const navigate = useNavigate()
  const params = useParams()
  const dir = createMemo(() => decode64(params.dir ?? ""))

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

  const [query, setQuery] = createSignal("")
  const [mode, setMode] = createSignal<"classical" | "ai">("classical")
  const [model, setModel] = createSignal("")
  const [caseSensitive, setCaseSensitive] = createSignal(false)
  const [regex, setRegex] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  const [hits, setHits] = createSignal<Hit[]>([])
  const [meta, setMeta] = createSignal<Pick<SearchResponse, "elapsed_ms" | "scanned" | "truncated"> | null>(null)
  const [error, setError] = createSignal<string | undefined>()

  const rawClient = () => (sdk.client as unknown as { client: RawSdkClient }).client

  async function runSearch() {
    const q = query().trim()
    if (!q) return
    if (mode() === "ai" && !model()) {
      showToast({ variant: "error", title: "Pick a model", description: "AI-augmented search needs a model." })
      return
    }
    setBusy(true)
    setError(undefined)
    setHits([])
    setMeta(null)
    try {
      const [providerID, ...rest] = mode() === "ai" ? model().split("/") : ["", ""]
      const modelID = rest.join("/")
      const body: Record<string, unknown> = {
        query: q,
        mode: mode(),
        directory: dir() || undefined,
        limit: 25,
        case_sensitive: caseSensitive(),
        regex: regex(),
      }
      if (mode() === "ai") {
        body.providerID = providerID
        body.modelID = modelID
      }
      const resp = await rawClient().request<SearchResponse>({
        method: "POST",
        url: "/chat-search",
        body,
        parseAs: "json",
        responseStyle: "data",
        throwOnError: true,
      })
      setHits(resp.hits)
      setMeta({ elapsed_ms: resp.elapsed_ms, scanned: resp.scanned, truncated: resp.truncated })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(msg)
      showToast({ variant: "error", title: "Search failed", description: msg })
    } finally {
      setBusy(false)
    }
  }

  function openSession(id: string) {
    const target = dir() ? `/${params.dir}/session/${id}` : `/session/${id}`
    navigate(target)
  }

  return (
    <div class="flex flex-col h-full overflow-y-auto no-scrollbar">
      <div class="sticky top-0 z-10 bg-[linear-gradient(to_bottom,var(--surface-stronger-non-alpha)_calc(100%_-_24px),transparent)]">
        <div class="px-6 pt-6 pb-3 flex flex-col gap-2">
          <h2 class="text-16-medium text-text-strong">Search chats</h2>
          <p class="text-13-regular text-text-weak">
            Classical mode does literal/regex text matching across every message in every session, with snippets.
            AI-augmented mode asks the model of your choice to rank session relevance to your query.
          </p>
        </div>
      </div>

      <div class="px-6 pb-4 flex flex-col gap-3">
        <div class="flex gap-2">
          <button
            type="button"
            class={
              "h-8 px-3 rounded-md text-12-medium border " +
              (mode() === "classical"
                ? "bg-surface-stronger text-text-strong border-border-base"
                : "bg-transparent text-text-weak border-border-weak-base hover:text-text-strong")
            }
            onClick={() => setMode("classical")}
          >
            Classical (text / regex)
          </button>
          <button
            type="button"
            class={
              "h-8 px-3 rounded-md text-12-medium border " +
              (mode() === "ai"
                ? "bg-surface-stronger text-text-strong border-border-base"
                : "bg-transparent text-text-weak border-border-weak-base hover:text-text-strong")
            }
            onClick={() => setMode("ai")}
          >
            AI-augmented (model picks)
          </button>
        </div>

        <div class="flex gap-2 items-center">
          <input
            class={inputClass}
            placeholder={
              mode() === "classical"
                ? "Search across all messages — literal text by default, toggle Regex to use a pattern"
                : "Ask in plain language — e.g. 'sessions where I debugged Ring streaming'"
            }
            value={query()}
            onInput={(e) => setQuery(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !busy()) void runSearch()
            }}
            spellcheck={true}
          />
          <Button onClick={() => void runSearch()} disabled={busy() || !query().trim()} size="normal">
            <Icon name="magnifying-glass" />
            {busy() ? "Searching..." : "Search"}
          </Button>
        </div>

        <Show when={mode() === "classical"}>
          <div class="flex gap-4 text-12-regular text-text-weak items-center">
            <label class="flex items-center gap-2">
              <Toggle checked={caseSensitive()} onChange={(v) => setCaseSensitive(v)} />
              Case sensitive
            </label>
            <label class="flex items-center gap-2">
              <Toggle checked={regex()} onChange={(v) => setRegex(v)} />
              Regex
            </label>
          </div>
        </Show>

        <Show when={mode() === "ai"}>
          <label class={labelClass}>
            Model
            <select class={inputClass} value={model()} onChange={(e) => setModel(e.currentTarget.value)}>
              <option value="">Select a model…</option>
              <For each={modelOptions()}>
                {(opt) => <option value={opt.value}>{opt.label}</option>}
              </For>
            </select>
            <span class="text-11-regular text-text-weak">
              Local SG personality + custom instructions still apply. Heavier models (Claude Opus, Ring 2.5-1T,
              GPT-5) give richer rankings; cheap models give a fast first pass.
            </span>
          </label>
        </Show>

        <Show when={meta()}>
          <div class="text-12-regular text-text-weak">
            Scanned {meta()!.scanned} session(s) in {fmtMs(meta()!.elapsed_ms)}
            <Show when={meta()!.truncated}> — results truncated</Show>
          </div>
        </Show>
        <Show when={error()}>
          <div class="text-12-regular text-error">{error()}</div>
        </Show>
      </div>

      <div class="px-6 pb-12 flex flex-col gap-2">
        <Show
          when={hits().length > 0}
          fallback={
            <div class="text-12-regular text-text-weak py-6">
              <Show when={!busy() && query().trim()}>No matches yet.</Show>
              <Show when={!query().trim()}>Type a query above and hit Enter.</Show>
            </div>
          }
        >
          <For each={hits()}>
            {(hit) => (
              <button
                type="button"
                class="text-left rounded-md border border-border-weak-base bg-background-base hover:bg-surface-stronger px-3 py-3 flex flex-col gap-1"
                onClick={() => openSession(hit.id)}
              >
                <div class="flex items-center justify-between gap-3">
                  <div class="text-13-medium text-text-strong truncate">{hit.title}</div>
                  <div class="shrink-0 flex items-center gap-2 text-11-regular text-text-weak">
                    <span>score {(hit.score * 100).toFixed(0)}%</span>
                    <Show when={hit.matched_at}>
                      <span>• {fmtRel(hit.matched_at)}</span>
                    </Show>
                    <Show when={hit.matched_role}>
                      <span>• {hit.matched_role}</span>
                    </Show>
                  </div>
                </div>
                <Show when={hit.why}>
                  <div class="text-12-regular text-text-base">{hit.why}</div>
                </Show>
                <Show when={hit.snippet}>
                  <div class="text-12-regular text-text-weak whitespace-pre-wrap">{hit.snippet}</div>
                </Show>
                <Show when={hit.directory}>
                  <div class="text-11-regular text-text-weak truncate">{hit.directory}</div>
                </Show>
              </button>
            )}
          </For>
        </Show>
      </div>
    </div>
  )
}
