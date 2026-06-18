import { defineConfig } from "vite"
import appPlugin from "@opencode-ai/app/vite"
import path from "node:path"
import { fileURLToPath } from "node:url"

const configDir = path.dirname(fileURLToPath(import.meta.url))
const rendererRoot = path.join(configDir, "src", "renderer")

const channel = (() => {
  const raw = process.env.OPENCODE_CHANNEL
  if (raw === "dev" || raw === "beta" || raw === "prod") return raw
  return "dev"
})()

const fastBuild = process.env.OPENCODE_FAST_BUILD === "true" || process.env.OPENCODE_FAST_BUILD === "1"

export default defineConfig({
  plugins: [appPlugin],
  publicDir: path.join(configDir, "..", "app", "public"),
  root: rendererRoot,
  define: {
    "import.meta.env.VITE_OPENCODE_CHANNEL": JSON.stringify(channel),
  },
  build: {
    emptyOutDir: true,
    minify: fastBuild ? false : undefined,
    outDir: path.join(configDir, "out", "renderer"),
    reportCompressedSize: fastBuild ? false : undefined,
    target: "esnext",
    rollupOptions: {
      input: {
        main: path.join(rendererRoot, "index.html"),
        loading: path.join(rendererRoot, "loading.html"),
      },
    },
  },
})
