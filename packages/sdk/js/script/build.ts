#!/usr/bin/env bun
import { $ } from "bun"

import { generateSdk, repoRoot, sdkDir } from "./generate"

await generateSdk()
process.chdir(repoRoot)
await $`bun prettier --write packages/sdk/js/src/gen`
process.chdir(sdkDir)
await $`rm -rf dist`
await $`bun tsc`
