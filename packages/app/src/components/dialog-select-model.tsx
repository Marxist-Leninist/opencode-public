import { Popover as Kobalte } from "@kobalte/core/popover"
import { Component, ComponentProps, createMemo, JSX, Show, ValidComponent } from "solid-js"
import { createStore } from "solid-js/store"
import { useLocal } from "@/context/local"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { popularProviders } from "@/hooks/use-providers"
import { Button } from "@opencode-ai/ui/button"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Tag } from "@opencode-ai/ui/tag"
import { Dialog } from "@opencode-ai/ui/dialog"
import { List } from "@opencode-ai/ui/list"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { ModelTooltip } from "./model-tooltip"
import { useLanguage } from "@/context/language"
import { isDefaultVisibleModel } from "@/context/models"

const MODEL_POPOVER_ROW_LIMIT = 120
const MODEL_DIALOG_ROW_LIMIT = 240
const MODEL_INITIAL_CANDIDATE_MULTIPLIER = 3
const MODEL_SEARCH_CANDIDATE_MULTIPLIER = 8
const MODEL_SEARCH_MIN_CANDIDATES = 600

const isFree = (provider: string, cost: { input: number } | undefined) =>
  provider === "opencode" && (!cost || cost.input === 0)

const defaultVisibleRank = (model: { id: string; provider: { id: string } }) => {
  if (!isDefaultVisibleModel({ providerID: model.provider.id, modelID: model.id })) return 2
  if (model.id === "openrouter/auto") return 0
  if (model.id === "openrouter/free") return 1
  return 2
}

type ModelState = ReturnType<typeof useLocal>["model"]
type ModelItem = ReturnType<ModelState["list"]>[number]

const ModelList: Component<{
  provider?: string
  class?: string
  onSelect: () => void
  action?: JSX.Element
  model?: ModelState
  rowLimit?: number
  tooltips?: boolean
  compactInitial?: boolean
}> = (props) => {
  const model = props.model ?? useLocal().model
  const language = useLanguage()

  const modelKey = (item: ModelItem) => `${item.provider.id}:${item.id}`
  const matchesProvider = (item: ModelItem) => !props.provider || item.provider.id === props.provider
  const isVisible = (item: ModelItem) => model.visible({ modelID: item.id, providerID: item.provider.id })

  const fullModels = createMemo(() => model.list().filter((item) => matchesProvider(item) && isVisible(item)))

  const collectVisibleModels = (limit: number, predicate?: (item: ModelItem) => boolean) => {
    const items: ModelItem[] = []
    for (const item of model.list()) {
      if (items.length >= limit) break
      if (!matchesProvider(item) || !isVisible(item)) continue
      if (predicate && !predicate(item)) continue
      items.push(item)
    }
    return items
  }

  const initialModels = createMemo(() => {
    const limit = Math.max(
      props.rowLimit ?? MODEL_DIALOG_ROW_LIMIT,
      (props.rowLimit ?? MODEL_POPOVER_ROW_LIMIT) * MODEL_INITIAL_CANDIDATE_MULTIPLIER,
    )
    const seen = new Set<string>()
    const items: ModelItem[] = []

    const add = (item: ModelItem | undefined) => {
      if (!item || !matchesProvider(item) || !isVisible(item)) return
      const key = modelKey(item)
      if (seen.has(key)) return
      seen.add(key)
      items.push(item)
    }

    add(model.current())
    for (const item of model.recent()) add(item)

    for (const item of model.list()) {
      if (items.length >= limit) break
      if (defaultVisibleRank(item) < 2) add(item)
    }

    for (const item of model.list()) {
      if (items.length >= limit) break
      if (popularProviders.includes(item.provider.id)) add(item)
    }

    for (const item of model.list()) {
      if (items.length >= limit) break
      add(item)
    }

    return items
  })

  const searchedModels = (filter: string) => {
    const needle = filter.trim().toLowerCase()
    const limit = Math.max(
      (props.rowLimit ?? MODEL_DIALOG_ROW_LIMIT) * MODEL_SEARCH_CANDIDATE_MULTIPLIER,
      MODEL_SEARCH_MIN_CANDIDATES,
    )
    const matches = collectVisibleModels(limit, (item) =>
      `${item.provider.name} ${item.name} ${item.id}`.toLowerCase().includes(needle),
    )
    if (matches.length > 0) return matches

    // Keep fuzzy-sort bounded even for typo/no-substring queries on huge provider catalogs.
    return collectVisibleModels(limit)
  }

  const models = (filter: string) => {
    const started = performance.now()
    const compact = props.compactInitial !== false
    const query = filter.trim()
    const items = compact ? (query === "" ? initialModels() : searchedModels(query)) : fullModels()
    const elapsed = Math.round(performance.now() - started)

    if (import.meta.env.DEV && compact) {
      console.info("[model-picker] candidates", {
        compact,
        query: query ? "search" : "initial",
        count: items.length,
        ms: elapsed,
      })
    }

    return items
  }

  return (
    <List
      class={`flex-1 min-h-0 [&_[data-slot=list-scroll]]:flex-1 [&_[data-slot=list-scroll]]:min-h-0 ${props.class ?? ""}`}
      search={{ placeholder: language.t("dialog.model.search.placeholder"), autofocus: true, action: props.action }}
      emptyMessage={language.t("dialog.model.empty")}
      key={(x) => `${x.provider.id}:${x.id}`}
      items={models}
      current={model.current()}
      filterKeys={["provider.name", "name", "id"]}
      maxItems={props.rowLimit}
      sortBy={(a, b) => defaultVisibleRank(a) - defaultVisibleRank(b) || a.name.localeCompare(b.name)}
      groupBy={(x) => x.provider.name}
      sortGroupsBy={(a, b) => {
        const aProvider = a.items[0].provider.id
        const bProvider = b.items[0].provider.id
        if (popularProviders.includes(aProvider) && !popularProviders.includes(bProvider)) return -1
        if (!popularProviders.includes(aProvider) && popularProviders.includes(bProvider)) return 1
        return popularProviders.indexOf(aProvider) - popularProviders.indexOf(bProvider)
      }}
      itemWrapper={
        props.tooltips === false
          ? undefined
          : (item, node) => (
              <Tooltip
                class="w-full"
                placement="right-start"
                gutter={12}
                value={<ModelTooltip model={item} latest={item.latest} free={isFree(item.provider.id, item.cost)} />}
              >
                {node}
              </Tooltip>
            )
      }
      onSelect={(x) => {
        model.set(x ? { modelID: x.id, providerID: x.provider.id } : undefined, {
          recent: true,
        })
        props.onSelect()
      }}
    >
      {(i) => (
        <div class="w-full flex items-center gap-x-2 text-13-regular">
          <span class="truncate">{i.name}</span>
          <Show when={isFree(i.provider.id, i.cost)}>
            <Tag>{language.t("model.tag.free")}</Tag>
          </Show>
          <Show when={i.latest}>
            <Tag>{language.t("model.tag.latest")}</Tag>
          </Show>
        </div>
      )}
    </List>
  )
}

type ModelSelectorTriggerProps = Omit<ComponentProps<typeof Kobalte.Trigger>, "as" | "ref">
type Dismiss = "escape" | "outside" | "select" | "manage" | "provider"

export function ModelSelectorPopover(props: {
  provider?: string
  model?: ModelState
  children?: JSX.Element
  triggerAs?: ValidComponent
  triggerProps?: ModelSelectorTriggerProps
  onClose?: (cause: "escape" | "select") => void
}) {
  const [store, setStore] = createStore<{
    open: boolean
    dismiss: Dismiss | null
  }>({
    open: false,
    dismiss: null,
  })
  const dialog = useDialog()

  const close = (dismiss: Dismiss) => {
    setStore("dismiss", dismiss)
    setStore("open", false)
  }

  const handleManage = () => {
    close("manage")
    void import("./dialog-manage-models").then((x) => {
      dialog.show(() => <x.DialogManageModels />)
    })
  }

  const handleConnectProvider = () => {
    close("provider")
    void import("./dialog-select-provider").then((x) => {
      dialog.show(() => <x.DialogSelectProvider />)
    })
  }
  const language = useLanguage()

  return (
    <Kobalte
      open={store.open}
      onOpenChange={(next) => {
        if (next) setStore("dismiss", null)
        setStore("open", next)
      }}
      modal={false}
      placement="top-start"
      gutter={4}
    >
      <Kobalte.Trigger as={props.triggerAs ?? "div"} {...props.triggerProps}>
        {props.children}
      </Kobalte.Trigger>
      <Kobalte.Portal>
        <Kobalte.Content
          class="w-72 h-80 flex flex-col p-2 rounded-md border border-border-base bg-surface-raised-stronger-non-alpha shadow-md z-50 outline-none overflow-hidden"
          onEscapeKeyDown={(event) => {
            close("escape")
            event.preventDefault()
            event.stopPropagation()
          }}
          onPointerDownOutside={() => close("outside")}
          onFocusOutside={() => close("outside")}
          onCloseAutoFocus={(event) => {
            const dismiss = store.dismiss
            if (dismiss === "outside") event.preventDefault()
            if (dismiss === "escape" || dismiss === "select") {
              event.preventDefault()
              props.onClose?.(dismiss)
            }
            setStore("dismiss", null)
          }}
        >
          <Kobalte.Title class="sr-only">{language.t("dialog.model.select.title")}</Kobalte.Title>
          <ModelList
            provider={props.provider}
            model={props.model}
            onSelect={() => close("select")}
            rowLimit={MODEL_POPOVER_ROW_LIMIT}
            tooltips={false}
            class="p-1"
            action={
              <div class="flex items-center gap-1">
                <Tooltip placement="top" value={language.t("command.provider.connect")}>
                  <IconButton
                    icon="plus-small"
                    variant="ghost"
                    iconSize="normal"
                    class="size-6"
                    aria-label={language.t("command.provider.connect")}
                    onClick={handleConnectProvider}
                  />
                </Tooltip>
                <Tooltip placement="top" value={language.t("dialog.model.manage")}>
                  <IconButton
                    icon="sliders"
                    variant="ghost"
                    iconSize="normal"
                    class="size-6"
                    aria-label={language.t("dialog.model.manage")}
                    onClick={handleManage}
                  />
                </Tooltip>
              </div>
            }
          />
        </Kobalte.Content>
      </Kobalte.Portal>
    </Kobalte>
  )
}

export const DialogSelectModel: Component<{ provider?: string; model?: ModelState }> = (props) => {
  const dialog = useDialog()
  const language = useLanguage()

  const provider = () => {
    void import("./dialog-select-provider").then((x) => {
      dialog.show(() => <x.DialogSelectProvider />)
    })
  }

  const manage = () => {
    void import("./dialog-manage-models").then((x) => {
      dialog.show(() => <x.DialogManageModels />)
    })
  }

  return (
    <Dialog
      title={language.t("dialog.model.select.title")}
      action={
        <Button class="h-7 -my-1 text-14-medium" icon="plus-small" tabIndex={-1} onClick={provider}>
          {language.t("command.provider.connect")}
        </Button>
      }
    >
      <ModelList
        provider={props.provider}
        model={props.model}
        onSelect={() => dialog.close()}
        rowLimit={MODEL_DIALOG_ROW_LIMIT}
      />
      <Button variant="ghost" class="ml-3 mt-5 mb-6 text-text-base self-start" onClick={manage}>
        {language.t("dialog.model.manage")}
      </Button>
    </Dialog>
  )
}
