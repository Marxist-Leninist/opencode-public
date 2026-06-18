#!/usr/bin/env bun
import { readdir, stat } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

export const sdkDir = fileURLToPath(new URL("..", import.meta.url))
export const repoRoot = path.resolve(sdkDir, "../../..")

const sourceRoots = [path.join(repoRoot, "packages", "opencode", "src")]
const generatedRoot = path.join(sdkDir, "src", "v2", "gen")

type MtimeScan = {
  count: number
  newest: number
}

async function newestMtime(dir: string, predicate: (file: string) => boolean): Promise<MtimeScan> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return { count: 0, newest: 0 }
  }

  let count = 0
  let newest = 0
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      const child = await newestMtime(full, predicate)
      count += child.count
      newest = Math.max(newest, child.newest)
      continue
    }
    if (!entry.isFile() || !predicate(full)) continue
    const info = await stat(full)
    count++
    newest = Math.max(newest, info.mtimeMs)
  }
  return { count, newest }
}

export async function sdkNeedsSync() {
  const sources = await Promise.all(sourceRoots.map((root) => newestMtime(root, (file) => file.endsWith(".ts"))))
  const sourceNewest = Math.max(...sources.map((scan) => scan.newest))
  const generated = await newestMtime(generatedRoot, (file) => file.endsWith(".ts"))

  if (generated.count === 0) return true
  return sourceNewest > generated.newest + 1
}

export async function syncIfNeeded(opts: { force?: boolean } = {}) {
  if (!opts.force && !(await sdkNeedsSync())) {
    console.log("backend sdk already current")
    return false
  }

  const { generateSdk } = await import("./generate")
  await generateSdk()
  console.log("backend sdk synced from opencode server OpenAPI")
  return true
}

if (import.meta.main) {
  await syncIfNeeded({ force: process.argv.includes("--force") })
}
