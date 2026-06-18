#!/usr/bin/env bun
import { generateSdk } from "./generate"

await generateSdk()
console.log("backend sdk synced from opencode server OpenAPI")
