// @refresh reload

import {
  ACCEPTED_FILE_EXTENSIONS,
  ACCEPTED_FILE_TYPES,
  AppBaseProviders,
  AppInterface,
  handleNotificationClick,
  loadLocaleDict,
  normalizeLocale,
  type Locale,
  type Platform,
  PlatformProvider,
  ServerConnection,
  useCommand,
} from "@opencode-ai/app"
import type { AsyncStorage } from "@solid-primitives/storage"
import { MemoryRouter } from "@solidjs/router"
import { createEffect, createResource, createSignal, onCleanup, onMount, Show } from "solid-js"
import { render } from "solid-js/web"
import pkg from "../../package.json"
import { initI18n, t } from "./i18n"
import { webviewZoom } from "./webview-zoom"
import "./styles.css"
import { useTheme } from "@opencode-ai/ui/theme"
import { Splash } from "@opencode-ai/ui/logo"

const root = document.getElementById("root")
if (import.meta.env.DEV && !(root instanceof HTMLElement)) {
  throw new Error(t("error.dev.rootNotFound"))
}

void initI18n()

const deepLinkEvent = "opencode:deep-link"

const emitDeepLinks = (urls: string[]) => {
  if (urls.length === 0) return
  window.__OPENCODE__ ??= {}
  const pending = window.__OPENCODE__.deepLinks ?? []
  window.__OPENCODE__.deepLinks = [...pending, ...urls]
  window.dispatchEvent(new CustomEvent(deepLinkEvent, { detail: { urls } }))
}

const listenForDeepLinks = () => {
  void window.api.consumeInitialDeepLinks().then((urls) => emitDeepLinks(urls))
  return window.api.onDeepLink((urls) => emitDeepLinks(urls))
}

const createPlatform = (): Platform => {
  const os = (() => {
    const ua = navigator.userAgent
    if (ua.includes("Mac")) return "macos"
    if (ua.includes("Windows")) return "windows"
    if (ua.includes("Linux")) return "linux"
    return undefined
  })()

  const isWslEnabled = async () => {
    if (os !== "windows") return false
    return window.api
      .getWslConfig()
      .then((config) => config.enabled)
      .catch(() => false)
  }

  const wslHome = async () => {
    if (!(await isWslEnabled())) return undefined
    return window.api.wslPath("~", "windows").catch(() => undefined)
  }

  const handleWslPicker = async <T extends string | string[]>(result: T | null): Promise<T | null> => {
    if (!result || !(await isWslEnabled())) return result
    if (Array.isArray(result)) {
      return Promise.all(result.map((path) => window.api.wslPath(path, "linux").catch(() => path))) as any
    }
    return window.api.wslPath(result, "linux").catch(() => result) as any
  }

  const storage = (() => {
    const cache = new Map<string, AsyncStorage>()

    const createStorage = (name: string) => {
      const api: AsyncStorage = {
        getItem: (key: string) => window.api.storeGet(name, key),
        setItem: (key: string, value: string) => window.api.storeSet(name, key, value),
        removeItem: (key: string) => window.api.storeDelete(name, key),
        clear: () => window.api.storeClear(name),
        key: async (index: number) => (await window.api.storeKeys(name))[index],
        getLength: () => window.api.storeLength(name),
        get length() {
          return api.getLength()
        },
      }
      return api
    }

    return (name = "default.dat") => {
      const cached = cache.get(name)
      if (cached) return cached
      const api = createStorage(name)
      cache.set(name, api)
      return api
    }
  })()

  return {
    platform: "desktop",
    os,
    version: pkg.version,

    async openDirectoryPickerDialog(opts) {
      const defaultPath = await wslHome()
      const result = await window.api.openDirectoryPicker({
        multiple: opts?.multiple ?? false,
        title: opts?.title ?? t("desktop.dialog.chooseFolder"),
        defaultPath,
      })
      return await handleWslPicker(result)
    },

    async openFilePickerDialog(opts) {
      const result = await window.api.openFilePicker({
        multiple: opts?.multiple ?? false,
        title: opts?.title ?? t("desktop.dialog.chooseFile"),
        accept: opts?.accept ?? ACCEPTED_FILE_TYPES,
        extensions: opts?.extensions ?? ACCEPTED_FILE_EXTENSIONS,
      })
      return handleWslPicker(result)
    },

    async saveFilePickerDialog(opts) {
      const result = await window.api.saveFilePicker({
        title: opts?.title ?? t("desktop.dialog.saveFile"),
        defaultPath: opts?.defaultPath,
      })
      return handleWslPicker(result)
    },

    openLink(url: string) {
      window.api.openLink(url)
    },
    async openPath(path: string, app?: string) {
      if (os === "windows") {
        const resolvedApp = app ? await window.api.resolveAppPath(app).catch(() => null) : null
        const resolvedPath = await (async () => {
          if (await isWslEnabled()) {
            const converted = await window.api.wslPath(path, "windows").catch(() => null)
            if (converted) return converted
          }
          return path
        })()
        return window.api.openPath(resolvedPath, resolvedApp ?? undefined)
      }
      return window.api.openPath(path, app)
    },

    back() {
      window.history.back()
    },

    forward() {
      window.history.forward()
    },

    storage,

    checkUpdate: async () => {
      const config = await window.api.getWindowConfig().catch(() => ({ updaterEnabled: false }))
      if (!config.updaterEnabled) return { updateAvailable: false }
      return window.api.checkUpdate()
    },

    updateAndRestart: async () => {
      const config = await window.api.getWindowConfig().catch(() => ({ updaterEnabled: false }))
      if (!config.updaterEnabled) return
      await window.api.installUpdate()
    },

    restart: async () => {
      await window.api.killSidecar().catch(() => undefined)
      window.api.relaunch()
    },

    notify: async (title, description, href) => {
      const focused = await window.api.getWindowFocused().catch(() => document.hasFocus())
      if (focused) return

      const notification = new Notification(title, {
        body: description ?? "",
        icon: "https://opencode.ai/favicon-96x96-v3.png",
      })
      notification.onclick = () => {
        void window.api.showWindow()
        void window.api.setWindowFocus()
        handleNotificationClick(href)
        notification.close()
      }
    },

    fetch: (input, init) => {
      if (input instanceof Request) return fetch(input)
      return fetch(input, init)
    },

    getWslEnabled: () => isWslEnabled(),

    setWslEnabled: async (enabled) => {
      await window.api.setWslConfig({ enabled })
    },

    getDefaultServer: async () => {
      const url = await window.api.getDefaultServerUrl().catch(() => null)
      if (!url) return null
      return ServerConnection.Key.make(url)
    },

    setDefaultServer: async (url: string | null) => {
      await window.api.setDefaultServerUrl(url)
    },

    getDisplayBackend: async () => {
      return window.api.getDisplayBackend().catch(() => null)
    },

    setDisplayBackend: async (backend) => {
      await window.api.setDisplayBackend(backend)
    },

    parseMarkdown: (markdown: string) => window.api.parseMarkdownCommand(markdown),

    webviewZoom,

    checkAppExists: async (appName: string) => {
      return window.api.checkAppExists(appName)
    },

    async readClipboardImage() {
      const image = await window.api.readClipboardImage().catch(() => null)
      if (!image) return null
      const blob = new Blob([image.buffer], { type: "image/png" })
      return new File([blob], `pasted-image-${Date.now()}.png`, {
        type: "image/png",
      })
    },
  }
}

let menuTrigger = null as null | ((id: string) => void)
window.api.onMenuCommand((id) => {
  menuTrigger?.(id)
})
listenForDeepLinks()

window.addEventListener("error", (event) => {
  console.error("[desktop-renderer] uncaught error", {
    message: event.message,
    filename: event.filename,
    lineno: event.lineno,
    colno: event.colno,
    error: event.error,
  })
})

window.addEventListener("unhandledrejection", (event) => {
  console.error("[desktop-renderer] unhandled rejection", {
    reason: event.reason,
  })
})

document.addEventListener("visibilitychange", () => {
  console.info("[desktop-renderer] visibility", {
    state: document.visibilityState,
    hidden: document.hidden,
  })
})

type BootResource = {
  name: string
  loading: boolean
  state: string
}

function loadBootResource<T>(name: string, run: () => Promise<T>) {
  const start = performance.now()
  console.info(`[desktop-renderer] ${name}:start`)
  return run().then(
    (value) => {
      console.info(`[desktop-renderer] ${name}:ready`, { ms: Math.round(performance.now() - start) })
      return value
    },
    (error) => {
      console.error(`[desktop-renderer] ${name}:failed`, error)
      throw error
    },
  )
}

function DesktopBootFallback(props: { resources: () => BootResource[] }) {
  const [slow, setSlow] = createSignal(false)

  onMount(() => {
    const timer = setTimeout(() => {
      setSlow(true)
      console.warn("[desktop-renderer] boot gate still pending", {
        resources: props.resources(),
      })
    }, 4_000)
    onCleanup(() => clearTimeout(timer))
  })

  const pending = () => props.resources().filter((item) => item.loading)

  return (
    <div class="h-dvh w-screen bg-background-base flex flex-col items-center justify-center gap-5 text-text-weak">
      <Splash class="w-16 h-20 opacity-40 animate-pulse" />
      <div class="h-8 text-12-regular" aria-live="polite">
        <Show when={slow()} fallback={<span>Starting OpenCode...</span>}>
          <span>Still starting {pending().map((item) => item.name).join(", ") || "renderer"}...</span>
        </Show>
      </div>
    </div>
  )
}

render(() => {
  const platform = createPlatform()
  const [windowConfig] = createResource(() =>
    loadBootResource("windowConfig", () => window.api.getWindowConfig().catch(() => ({ updaterEnabled: false }))),
  )
  const loadLocale = async () => {
    const current = await platform.storage?.("opencode.global.dat").getItem("language")
    const legacy = current ? undefined : await platform.storage?.().getItem("language.v1")
    const raw = current ?? legacy
    if (!raw) return
    const locale = raw.match(/"locale"\s*:\s*"([^"]+)"/)?.[1]
    if (!locale) return
    const next = normalizeLocale(locale)
    if (next !== "en") await loadLocaleDict(next)
    return next satisfies Locale
  }

  const [windowCount] = createResource(() => loadBootResource("windowCount", () => window.api.getWindowCount()))

  // Fetch sidecar credentials (available immediately, before health check)
  const [sidecar] = createResource(() =>
    loadBootResource("sidecar", () => window.api.awaitInitialization(() => undefined)),
  )

  const [defaultServer] = createResource(() =>
    loadBootResource("defaultServer", async () => {
      const url = await platform.getDefaultServer?.()
      if (url) return ServerConnection.key({ type: "http", http: { url } })
    }),
  )
  const [locale] = createResource(() => loadBootResource("locale", loadLocale))
  const bootResources = () => [
    { name: "defaultServer", loading: defaultServer.loading, state: defaultServer.state },
    { name: "sidecar", loading: sidecar.loading, state: sidecar.state },
    { name: "windowConfig", loading: windowConfig.loading, state: windowConfig.state },
    { name: "windowCount", loading: windowCount.loading, state: windowCount.state },
    { name: "locale", loading: locale.loading, state: locale.state },
  ]
  const bootReady = () => bootResources().every((item) => !item.loading)

  let loggedReady = false
  createEffect(() => {
    if (!bootReady() || loggedReady) return
    loggedReady = true
    console.info("[desktop-renderer] boot gate ready", {
      resources: bootResources(),
    })
  })

  const servers = () => {
    const data = sidecar()
    if (!data) return []
    const server: ServerConnection.Sidecar = {
      displayName: "Local Server",
      type: "sidecar",
      variant: "base",
      http: {
        url: data.url,
        username: data.username ?? undefined,
        password: data.password ?? undefined,
      },
    }
    return [server] as ServerConnection.Any[]
  }

  function handleClick(e: MouseEvent) {
    const link = (e.target as HTMLElement).closest("a.external-link") as HTMLAnchorElement | null
    if (link?.href) {
      e.preventDefault()
      platform.openLink(link.href)
    }
  }

  function Inner() {
    const cmd = useCommand()
    menuTrigger = (id) => cmd.trigger(id)

    const theme = useTheme()

    createEffect(() => {
      theme.themeId()
      theme.mode()
      const bg = getComputedStyle(document.documentElement).getPropertyValue("--background-base").trim()
      if (bg) {
        void window.api.setBackgroundColor(bg)
      }
    })

    return null
  }

  onMount(() => {
    document.addEventListener("click", handleClick)
    onCleanup(() => {
      document.removeEventListener("click", handleClick)
    })
  })

  return (
    <PlatformProvider value={platform}>
      <AppBaseProviders locale={locale.latest}>
        <Show
          when={bootReady()}
          fallback={<DesktopBootFallback resources={bootResources} />}
        >
          {(_) => {
            return (
              <AppInterface
                defaultServer={defaultServer.latest ?? ServerConnection.Key.make("sidecar")}
                servers={servers()}
                router={MemoryRouter}
              >
                <Inner />
              </AppInterface>
            )
          }}
        </Show>
      </AppBaseProviders>
    </PlatformProvider>
  )
}, root!)
