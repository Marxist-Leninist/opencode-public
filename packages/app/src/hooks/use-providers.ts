import { useGlobalSync } from "@/context/global-sync"
import { decode64 } from "@/utils/base64"
import { useParams } from "@solidjs/router"
import { createMemo } from "solid-js"

export const popularProviders = [
  "opencode",
  "opencode-go",
  "mimo",
  "xiaomi",
  "anthropic",
  "github-copilot",
  "openai",
  "google",
  "openrouter",
  "vercel",
]
const popularProviderSet = new Set(popularProviders)

// user-configured providers: opencode.json `provider` block ("config"), custom npm/plugin
// providers ("custom"), and env-key providers ("env"). Catalog-only entries are "api".
const configuredProviderSources = new Set(["config", "custom", "env"])
const isConfiguredSource = (source: string | undefined) =>
  source !== undefined && configuredProviderSources.has(source)

export function useProviders() {
  const globalSync = useGlobalSync()
  const params = useParams()
  const dir = createMemo(() => decode64(params.dir) ?? "")
  const providers = () => {
    if (dir()) {
      const [projectStore] = globalSync.child(dir())
      if (projectStore.provider_ready) return projectStore.provider
    }
    return globalSync.data.provider
  }
  return {
    all: () => providers().all,
    default: () => providers().default,
    popular: () => providers().all.filter((p) => popularProviderSet.has(p.id)),
    connected: () => {
      const connected = new Set(providers().connected)
      return providers().all.filter((p) => connected.has(p.id) || isConfiguredSource(p.source))
    },
    paid: () => {
      const connected = new Set(providers().connected)
      return providers().all.filter(
        (p) =>
          (connected.has(p.id) || isConfiguredSource(p.source)) &&
          (p.id !== "opencode" || Object.values(p.models).some((m) => m.cost?.input)),
      )
    },
  }
}
