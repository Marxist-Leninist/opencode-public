import { defineConfig } from "vite"
import desktopPlugin from "./vite"

const fastBuild = process.env.OPENCODE_FAST_BUILD === "true" || process.env.OPENCODE_FAST_BUILD === "1"

export default defineConfig({
  plugins: [desktopPlugin] as any,
  server: {
    host: "0.0.0.0",
    allowedHosts: true,
    port: 3000,
  },
  build: {
    minify: fastBuild ? false : undefined,
    reportCompressedSize: fastBuild ? false : undefined,
    target: "esnext",
    // sourcemap: true,
  },
})
