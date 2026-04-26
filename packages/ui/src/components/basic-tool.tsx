import { createEffect, For, Match, on, onCleanup, Show, Switch, type JSX } from "solid-js"
import { animate, type AnimationPlaybackControls } from "motion"
import { createStore } from "solid-js/store"
import { Collapsible } from "./collapsible"
import type { IconProps } from "./icon"
import { TextShimmer } from "./text-shimmer"

export type TriggerTitle = {
  title: string
  titleClass?: string
  subtitle?: string
  subtitleClass?: string
  args?: string[]
  argsClass?: string
  action?: JSX.Element
}

const isTriggerTitle = (val: any): val is TriggerTitle => {
  return (
    typeof val === "object" && val !== null && "title" in val && (typeof Node === "undefined" || !(val instanceof Node))
  )
}

export interface BasicToolProps {
  icon: IconProps["name"]
  trigger: TriggerTitle | JSX.Element
  children?: JSX.Element
  status?: string
  hideDetails?: boolean
  defaultOpen?: boolean
  forceOpen?: boolean
  defer?: boolean
  locked?: boolean
  animated?: boolean
  onSubtitleClick?: () => void
  onTriggerClick?: JSX.EventHandlerUnion<HTMLElement, MouseEvent>
  triggerHref?: string
  clickable?: boolean
}

const SPRING = { type: "spring" as const, visualDuration: 0.35, bounce: 0 }

export function BasicTool(props: BasicToolProps) {
  const [state, setState] = createStore({
    open: props.defaultOpen ?? false,
    ready: props.defaultOpen ?? false,
  })
  const open = () => state.open
  const ready = () => state.ready
  const pending = () => props.status === "pending" || props.status === "running"

  let frame: number | undefined

  const cancel = () => {
    if (frame === undefined) return
    cancelAnimationFrame(frame)
    frame = undefined
  }

  onCleanup(cancel)

  createEffect(() => {
    if (props.forceOpen) setState("open", true)
  })

  createEffect(
    on(
      open,
      (value) => {
        if (!props.defer) return
        if (!value) {
          cancel()
          setState("ready", false)
          return
        }

        cancel()
        frame = requestAnimationFrame(() => {
          frame = undefined
          if (!open()) return
          setState("ready", true)
        })
      },
      { defer: true },
    ),
  )

  // Animated height for collapsible open/close
  let contentRef: HTMLDivElement | undefined
  let heightAnim: AnimationPlaybackControls | undefined
  const initialOpen = open()

  createEffect(
    on(
      open,
      (isOpen) => {
        if (!props.animated || !contentRef) return
        heightAnim?.stop()
        if (isOpen) {
          contentRef.style.overflow = "hidden"
          heightAnim = animate(contentRef, { height: "auto" }, SPRING)
          void heightAnim.finished.then(() => {
            if (!contentRef || !open()) return
            contentRef.style.overflow = "visible"
            contentRef.style.height = "auto"
          })
        } else {
          contentRef.style.overflow = "hidden"
          heightAnim = animate(contentRef, { height: "0px" }, SPRING)
        }
      },
      { defer: true },
    ),
  )

  onCleanup(() => {
    heightAnim?.stop()
  })

  const handleOpenChange = (value: boolean) => {
    if (pending()) return
    if (props.locked && !value) return
    setState("open", value)
  }

  const trigger = () => (
    <div
      data-component="tool-trigger"
      data-clickable={props.clickable ? "true" : undefined}
      data-hide-details={props.hideDetails ? "true" : undefined}
    >
      <div data-slot="basic-tool-tool-trigger-content">
        <div data-slot="basic-tool-tool-info">
          <Switch>
            <Match when={isTriggerTitle(props.trigger) && props.trigger}>
              {(title) => (
                <div data-slot="basic-tool-tool-info-structured">
                  <div data-slot="basic-tool-tool-info-main">
                    <span
                      data-slot="basic-tool-tool-title"
                      classList={{
                        [title().titleClass ?? ""]: !!title().titleClass,
                      }}
                    >
                      <TextShimmer text={title().title} active={pending()} />
                    </span>
                    <Show when={!pending()}>
                      <Show when={title().subtitle}>
                        <span
                          data-slot="basic-tool-tool-subtitle"
                          classList={{
                            [title().subtitleClass ?? ""]: !!title().subtitleClass,
                            clickable: !!props.onSubtitleClick,
                          }}
                          onClick={(e) => {
                            if (props.onSubtitleClick) {
                              e.stopPropagation()
                              props.onSubtitleClick()
                            }
                          }}
                        >
                          {title().subtitle}
                        </span>
                      </Show>
                      <Show when={title().args?.length}>
                        <For each={title().args}>
                          {(arg) => (
                            <span
                              data-slot="basic-tool-tool-arg"
                              classList={{
                                [title().argsClass ?? ""]: !!title().argsClass,
                              }}
                            >
                              {arg}
                            </span>
                          )}
                        </For>
                      </Show>
                    </Show>
                  </div>
                  <Show when={!pending() && title().action}>
                    <span data-slot="basic-tool-tool-action">{title().action}</span>
                  </Show>
                </div>
              )}
            </Match>
            <Match when={true}>{props.trigger as JSX.Element}</Match>
          </Switch>
        </div>
      </div>
      <Show when={props.children && !props.hideDetails && !props.locked && !pending()}>
        <Collapsible.Arrow />
      </Show>
    </div>
  )

  return (
    <Collapsible open={open()} onOpenChange={handleOpenChange} class="tool-collapsible">
      <Show
        when={props.triggerHref}
        fallback={
          <Collapsible.Trigger
            data-hide-details={props.hideDetails ? "true" : undefined}
            onClick={props.onTriggerClick}
          >
            {trigger()}
          </Collapsible.Trigger>
        }
      >
        {(href) => (
          <Collapsible.Trigger
            as="a"
            href={href()}
            data-hide-details={props.hideDetails ? "true" : undefined}
            onClick={props.onTriggerClick}
          >
            {trigger()}
          </Collapsible.Trigger>
        )}
      </Show>
      <Show when={props.animated && props.children && !props.hideDetails}>
        <div
          ref={contentRef}
          data-slot="collapsible-content"
          data-animated
          style={{
            height: initialOpen ? "auto" : "0px",
            overflow: initialOpen ? "visible" : "hidden",
          }}
        >
          {props.children}
        </div>
      </Show>
      <Show when={!props.animated && props.children && !props.hideDetails}>
        <Collapsible.Content>
          <Show when={!props.defer || ready()}>{props.children}</Show>
        </Collapsible.Content>
      </Show>
    </Collapsible>
  )
}

function label(input: Record<string, unknown> | undefined) {
  const keys = ["description", "query", "url", "filePath", "path", "pattern", "name"]
  return keys.map((key) => input?.[key]).find((value): value is string => typeof value === "string" && value.length > 0)
}

function args(input: Record<string, unknown> | undefined) {
  if (!input) return []
  const skip = new Set(["description", "query", "url", "filePath", "path", "pattern", "name"])
  return Object.entries(input)
    .filter(([key]) => !skip.has(key))
    .flatMap(([key, value]) => {
      if (typeof value === "string") return [`${key}=${value}`]
      if (typeof value === "number") return [`${key}=${value}`]
      if (typeof value === "boolean") return [`${key}=${value}`]
      return []
    })
    .slice(0, 3)
}

function humanizeToolName(tool: string) {
  const trimmed = tool.replace(/^(?:sg1|sg2|sg|mcp)_/i, "")
  const words = trimmed
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  if (!words) return tool
  if (words.toLowerCase() === "search") return "MCP search"
  return words.replace(/\b[a-z]/g, (char) => char.toUpperCase())
}

/**
 * Extract the MCP server / namespace prefix from a tool id.
 * MCP tools land here as `<server>_<tool_name>`, e.g. `sg2_microwave_calc`,
 * `github_create_issue`, `mcp_search`. Returns the lowercase prefix or
 * undefined if the tool name has no underscore.
 */
function mcpServerPrefix(tool: string) {
  const match = /^([a-z][a-z0-9-]*)_/i.exec(tool)
  if (!match) return undefined
  return match[1].toLowerCase()
}

function isEmptyRecord(value: Record<string, unknown> | undefined) {
  return !value || Object.keys(value).length === 0
}

function formatPayload(value: unknown) {
  if (value === undefined || value === null) return ""
  if (typeof value === "string") {
    const text = value.trim()
    if (!text) return ""
    try {
      return JSON.stringify(JSON.parse(text), null, 2)
    } catch {
      return value
    }
  }
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function GenericToolBlock(props: { title: string; value: string }) {
  return (
    <Show when={props.value}>
      <div data-component="generic-tool-block">
        <div data-slot="generic-tool-block-title">{props.title}</div>
        <pre data-slot="generic-tool-block-pre" data-scrollable>
          {props.value}
        </pre>
      </div>
    </Show>
  )
}

export function GenericTool(props: {
  tool: string
  status?: string
  hideDetails?: boolean
  input?: Record<string, unknown>
  output?: string
  defaultOpen?: boolean
}) {
  const request = () => (isEmptyRecord(props.input) ? "" : formatPayload(props.input))
  const response = () => formatPayload(props.output)
  const hasDetails = () => !!request() || !!response()
  // MCP tool calls (anything that fell through to the generic renderer with
  // a `server_tool` shape) are conversational results worth showing inline,
  // so we open them by default up to a much higher size cap. Built-in tool
  // overrides have their own renderers and never hit this code path.
  const server = () => mcpServerPrefix(props.tool)
  const isMcp = () => server() !== undefined
  const sizeCap = () => (isMcp() ? 64_000 : 16_000)
  const defaultOpen = () => props.defaultOpen ?? (hasDetails() && request().length + response().length <= sizeCap())
  const title = () => humanizeToolName(props.tool)
  // For MCP, use the server name as a stable subtitle (e.g. "from sg2"),
  // and skip the noisy inline arg list since the Request block below shows
  // the full structured input. For non-MCP fallback, keep the original
  // subtitle/args behavior.
  const subtitle = () => (isMcp() ? `from ${server()}` : label(props.input))
  const triggerArgs = () => (isMcp() ? [] : args(props.input))

  return (
    <BasicTool
      icon="mcp"
      status={props.status}
      trigger={{
        title: title(),
        subtitle: subtitle(),
        args: triggerArgs(),
      }}
      hideDetails={props.hideDetails}
      defaultOpen={defaultOpen()}
      defer
    >
      {hasDetails() ? (
        <div data-component="generic-tool-details">
          <GenericToolBlock title="Request" value={request()} />
          <GenericToolBlock title="Response" value={response()} />
        </div>
      ) : undefined}
    </BasicTool>
  )
}
