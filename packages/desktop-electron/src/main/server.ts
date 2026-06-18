import { app } from "electron"
import { DEFAULT_SERVER_URL_KEY, WSL_ENABLED_KEY } from "./constants"
import { getUserShell, loadShellEnv } from "./shell-env"
import { getStore } from "./store"

export type WslConfig = { enabled: boolean }

export type HealthCheck = { wait: Promise<void> }

export function getDefaultServerUrl(): string | null {
  const value = getStore().get(DEFAULT_SERVER_URL_KEY)
  return typeof value === "string" && isHttpUrl(value) ? value : null
}

export function setDefaultServerUrl(url: string | null) {
  if (url && isHttpUrl(url)) {
    getStore().set(DEFAULT_SERVER_URL_KEY, url)
    return
  }

  getStore().delete(DEFAULT_SERVER_URL_KEY)
}

function isHttpUrl(value: string) {
  try {
    const url = new URL(value)
    return url.protocol === "http:" || url.protocol === "https:"
  } catch {
    return false
  }
}

export function getWslConfig(): WslConfig {
  const value = getStore().get(WSL_ENABLED_KEY)
  return { enabled: typeof value === "boolean" ? value : false }
}

export function setWslConfig(config: WslConfig) {
  getStore().set(WSL_ENABLED_KEY, config.enabled)
}

export async function spawnLocalServer(hostname: string, port: number, password: string) {
  prepareServerEnv(password, isLowResourceMode())
  const { Log, Server } = await import("virtual:opencode-server")
  await Log.init({ level: "WARN" })
  const listener = await Server.listen({
    port,
    hostname,
    username: "opencode",
    password,
    cors: rendererCorsOrigins(),
  })

  const wait = (async () => {
    const url = `http://${hostname}:${port}`

    const ready = async () => {
      while (true) {
        await new Promise((resolve) => setTimeout(resolve, 100))
        if (await checkHealth(url, password)) return
      }
    }

    await ready()
  })()

  return { listener, health: { wait } }
}

function rendererCorsOrigins() {
  const origins = new Set(["oc://renderer"])

  if (!app.isPackaged) {
    origins.add("http://localhost:5173")
    origins.add("http://127.0.0.1:5173")

    const devUrl = process.env.ELECTRON_RENDERER_URL
    if (devUrl) {
      try {
        origins.add(new URL(devUrl).origin)
      } catch {}
    }
  }

  return [...origins]
}

function prepareServerEnv(password: string, lowResource: boolean) {
  const shell = process.platform === "win32" ? null : getUserShell()
  const shellEnv = shell ? (loadShellEnv(shell) ?? {}) : {}
  const env = {
    ...process.env,
    ...shellEnv,
    OPENCODE_EXPERIMENTAL_ICON_DISCOVERY: lowResource ? "false" : "true",
    OPENCODE_EXPERIMENTAL_FILEWATCHER: lowResource ? "false" : "true",
    OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: lowResource ? "true" : (process.env.OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER ?? "false"),
    OPENCODE_CLIENT: "desktop",
    OPENCODE_SERVER_USERNAME: "opencode",
    OPENCODE_SERVER_PASSWORD: password,
    XDG_STATE_HOME: app.getPath("userData"),
  }
  Object.assign(process.env, env)
}

function isLowResourceMode() {
  const value = process.env.OPENCODE_DESKTOP_LOW_RESOURCE?.toLowerCase()
  return value !== "false" && value !== "0"
}

export async function checkHealth(url: string, password?: string | null): Promise<boolean> {
  let healthUrl: URL
  try {
    healthUrl = new URL("/global/health", url)
  } catch {
    return false
  }

  const headers = new Headers()
  if (password) {
    const auth = Buffer.from(`opencode:${password}`).toString("base64")
    headers.set("authorization", `Basic ${auth}`)
  }

  try {
    const res = await fetch(healthUrl, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(3000),
    })
    return res.ok
  } catch {
    return false
  }
}
