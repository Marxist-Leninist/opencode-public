#!/usr/bin/env bun
import { readdir, readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const sdk = fileURLToPath(new URL("..", import.meta.url))
const root = path.resolve(sdk, "../../..")
const opencodeSrc = path.join(root, "packages/opencode/src")
const generatedTypes = path.join(sdk, "src/v2/gen/types.gen.ts")

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const result: string[] = []
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      result.push(...(await walk(full)))
      continue
    }
    if (entry.isFile() && entry.name.endsWith(".ts")) result.push(full)
  }
  return result
}

const sourceEventTypes = new Set<string>()
const sourceOperationIds = new Set<string>()
const sourceFiles = await walk(opencodeSrc)
for (const file of sourceFiles) {
  const text = await readFile(file, "utf8")
  for (const match of text.matchAll(/BusEvent\.define\(\s*["']([^"']+)["']/g)) {
    sourceEventTypes.add(match[1])
  }
  for (const match of text.matchAll(/operationId:\s*["']([^"']+)["']/g)) {
    sourceOperationIds.add(match[1])
  }
}

const generated = await readFile(generatedTypes, "utf8")
const generatedEventTypes = new Set<string>()
for (const match of generated.matchAll(/export type Event[A-Za-z0-9_]* = \{\s+type: "([^"]+)"/g)) {
  generatedEventTypes.add(match[1])
}

function toOperationType(operationId: string) {
  return operationId
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join("")
}

const generatedOperationTypes = new Set<string>()
for (const match of generated.matchAll(/export type ([A-Za-z0-9_]+)Responses =/g)) {
  generatedOperationTypes.add(match[1])
}

const missingEvents = [...sourceEventTypes].filter((event) => !generatedEventTypes.has(event)).sort()
const missingOperations = [...sourceOperationIds]
  .map((operation) => ({ operation, type: toOperationType(operation) }))
  .filter((item) => !generatedOperationTypes.has(item.type))
  .sort((a, b) => a.operation.localeCompare(b.operation))

if (missingEvents.length > 0 || missingOperations.length > 0) {
  console.error("Generated SDK contract is stale.")
  console.error("Run `bun run build` in packages/sdk/js and commit the generated v2 SDK updates.")
  console.error("")
  for (const event of missingEvents) console.error(`- missing event: ${event}`)
  for (const item of missingOperations) console.error(`- missing operation: ${item.operation} (${item.type}Responses)`)
  process.exit(1)
}

console.log(
  `sdk contract ok: ${sourceEventTypes.size} backend events and ${sourceOperationIds.size} operations covered by generated SDK`,
)
