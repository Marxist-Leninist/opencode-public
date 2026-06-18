import { $ } from "bun"
import { rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { createClient } from "@hey-api/openapi-ts"
import { Server } from "../../../opencode/src/server/server"

export const sdkDir = fileURLToPath(new URL("..", import.meta.url))
export const repoRoot = path.resolve(sdkDir, "../../..")

export async function generateSdk() {
  process.chdir(sdkDir)

  const openapi = path.join(sdkDir, "openapi.json")
  await writeFile(openapi, JSON.stringify(await Server.openapiWithCodeSamples(), null, 2))

  try {
    await createClient({
      input: "./openapi.json",
      output: {
        path: "./src/v2/gen",
        tsConfigPath: path.join(sdkDir, "tsconfig.json"),
        clean: true,
      },
      plugins: [
        {
          name: "@hey-api/typescript",
          exportFromIndex: false,
        },
        {
          name: "@hey-api/sdk",
          instance: "OpencodeClient",
          exportFromIndex: false,
          auth: false,
          paramsStructure: "flat",
        },
        {
          name: "@hey-api/client-fetch",
          exportFromIndex: false,
          baseUrl: "http://localhost:4096",
        },
      ],
    })

    process.chdir(repoRoot)
    await $`bun prettier --write packages/sdk/js/src/v2`
    process.chdir(sdkDir)
  } finally {
    await rm(openapi, { force: true })
    process.chdir(sdkDir)
  }
}
