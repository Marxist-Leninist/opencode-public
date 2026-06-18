import { defineConfig } from "electron-vite"
import appPlugin from "@opencode-ai/app/vite"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const channel = (() => {
  const raw = process.env.OPENCODE_CHANNEL
  if (raw === "dev" || raw === "beta" || raw === "prod") return raw
  return "dev"
})()

const OPENCODE_SERVER_DIST = "../opencode/dist/node"

// Local dev/preview can run the backend from the repo build dir instead of re-bundling the
// ~20MB server blob into the Electron main process on every cold start. Packaging keeps the
// default inlined backend so the shipped app is self-contained.
const externalizeServer =
  process.argv.includes("dev") ||
  process.env.OPENCODE_EXTERNAL_SERVER === "true" ||
  process.env.OPENCODE_EXTERNAL_SERVER === "1"
const serverEntryUrl = pathToFileURL(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), OPENCODE_SERVER_DIST, "node.js"),
).href

const nodePtyPkg = `@lydell/node-pty-${process.platform}-${process.arch}`
const fastBuild = process.env.OPENCODE_FAST_BUILD === "true" || process.env.OPENCODE_FAST_BUILD === "1"
const buildDefaults = {
  minify: fastBuild ? false : undefined,
  reportCompressedSize: fastBuild ? false : undefined,
  sourcemap: false,
}

export default defineConfig({
  main: {
    define: {
      "import.meta.env.OPENCODE_CHANNEL": JSON.stringify(channel),
    },
    build: {
      ...buildDefaults,
      rollupOptions: {
        input: { index: "src/main/index.ts" },
      },
      externalizeDeps: { include: [nodePtyPkg] },
    },
    plugins: [
      {
        name: "opencode:node-pty-narrower",
        enforce: "pre",
        resolveId(s) {
          if (s === "@lydell/node-pty") return nodePtyPkg
        },
      },
      {
        name: "opencode:virtual-server-module",
        enforce: "pre",
        resolveId(id) {
          if (id !== "virtual:opencode-server") return
          // DEV/PREVIEW: externalize to the backend's source build dir (loaded only via dynamic
          // import() at runtime, so safe) — skips re-bundling the 20MB blob, ~0.4s main build.
          if (externalizeServer) return { id: serverEntryUrl, external: true }
          // PACKAGING: inline so the backend is bundled into the shipped app.
          return this.resolve(`${OPENCODE_SERVER_DIST}/node.js`)
        },
      },
      {
        name: "opencode:copy-server-assets",
        async writeBundle() {
          // Only needed for packaging (inlined backend chunk reads wasm from ./chunks).
          // In dev the backend runs from its source dir, so nothing to copy.
          if (externalizeServer) return
          for (const l of await fs.readdir(OPENCODE_SERVER_DIST)) {
            if (!l.endsWith(".wasm")) continue
            await fs.writeFile(`./out/main/chunks/${l}`, await fs.readFile(`${OPENCODE_SERVER_DIST}/${l}`))
          }
        },
      },
    ],
  },
  preload: {
    build: {
      ...buildDefaults,
      rollupOptions: {
        input: { index: "src/preload/index.ts" },
        output: {
          format: "cjs",
          entryFileNames: "[name].js",
        },
      },
    },
  },
  renderer: {
    plugins: [appPlugin],
    publicDir: "../../../app/public",
    root: "src/renderer",
    define: {
      "import.meta.env.VITE_OPENCODE_CHANNEL": JSON.stringify(channel),
    },
    build: {
      ...buildDefaults,
      target: "esnext",
      rollupOptions: {
        input: {
          main: "src/renderer/index.html",
          loading: "src/renderer/loading.html",
        },
      },
    },
  },
})
