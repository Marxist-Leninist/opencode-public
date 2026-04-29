import { describe, expect, test } from "bun:test"
import { mkdir, rm, writeFile } from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { __testing } from "../../src/tool/disk"

const { parseWmicCsvLine, parseDfPosixLine, fmtBytes, walkUsage, reportPath } = __testing

describe("disk.parseWmicCsvLine", () => {
  test("parses a Windows wmic logicaldisk row", () => {
    const row = parseWmicCsvLine("HOST,C:,NTFS,123456789,987654321")
    expect(row).toBeDefined()
    expect(row!.mount).toBe("C:\\")
    expect(row!.fs_type).toBe("NTFS")
    expect(row!.free_bytes).toBe(123456789)
    expect(row!.total_bytes).toBe(987654321)
    expect(row!.used_bytes).toBe(987654321 - 123456789)
    expect(row!.percent_used).toBeGreaterThan(0)
  })
  test("returns undefined for malformed rows", () => {
    expect(parseWmicCsvLine("Node,DeviceID,FileSystem,FreeSpace,Size")).toBeUndefined()
    expect(parseWmicCsvLine("HOST,not-a-drive,NTFS,1,2")).toBeUndefined()
    expect(parseWmicCsvLine("HOST,C:,NTFS,abc,xyz")).toBeUndefined()
    expect(parseWmicCsvLine("")).toBeUndefined()
  })
})

describe("disk.parseDfPosixLine", () => {
  test("parses a typical df -kP row", () => {
    // /dev/disk1   488245288   200000000   200000000     50%  /
    const row = parseDfPosixLine("/dev/disk1 488245288 200000000 200000000 50% /")
    expect(row).toBeDefined()
    expect(row!.mount).toBe("/")
    expect(row!.total_bytes).toBe(488245288 * 1024)
    expect(row!.free_bytes).toBe(200000000 * 1024)
    expect(row!.used_bytes).toBe(200000000 * 1024)
  })
  test("preserves multi-word mount points", () => {
    const row = parseDfPosixLine("/dev/sda1 100 50 50 50% /mnt/some volume")
    expect(row).toBeDefined()
    expect(row!.mount).toBe("/mnt/some volume")
  })
  test("returns undefined for malformed rows", () => {
    expect(parseDfPosixLine("")).toBeUndefined()
    expect(parseDfPosixLine("not enough columns")).toBeUndefined()
  })
})

describe("disk.fmtBytes", () => {
  test("formats bytes / KB / MB / GB / TB scales", () => {
    expect(fmtBytes(0)).toBe("0 B")
    expect(fmtBytes(512)).toBe("512 B")
    expect(fmtBytes(2048)).toBe("2.0 KB")
    expect(fmtBytes(2 * 1024 * 1024)).toBe("2.0 MB")
    expect(fmtBytes(3 * 1024 * 1024 * 1024)).toBe("3.00 GB")
    expect(fmtBytes(2 * 1024 * 1024 * 1024 * 1024)).toBe("2.00 TB")
  })
  test("returns '?' for invalid input", () => {
    expect(fmtBytes(NaN)).toBe("?")
    expect(fmtBytes(-1)).toBe("?")
  })
})

describe("disk.walkUsage", () => {
  test("walks a small directory tree, reports total + top files", async () => {
    const root = await mkdir(path.join(os.tmpdir(), `disk-usage-test-${Date.now()}`), { recursive: true })
    try {
      const dir = root!
      await writeFile(path.join(dir, "small.txt"), "x".repeat(100))
      await writeFile(path.join(dir, "medium.txt"), "y".repeat(5000))
      await mkdir(path.join(dir, "sub"), { recursive: true })
      await writeFile(path.join(dir, "sub", "big.txt"), "z".repeat(10000))

      const ac = new AbortController()
      const r = await walkUsage(dir, 5, 10, ac.signal)
      expect(r.total_bytes).toBe(100 + 5000 + 10000)
      expect(r.file_count).toBe(3)
      expect(r.dir_count).toBeGreaterThanOrEqual(2)
      expect(r.top.length).toBe(3)
      expect(r.top[0].path.endsWith("big.txt")).toBe(true)
      expect(r.top[0].size_bytes).toBe(10000)
    } finally {
      if (root) await rm(root, { recursive: true, force: true })
    }
  })
  test("respects max_depth and marks truncated", async () => {
    const root = path.join(os.tmpdir(), `disk-depth-test-${Date.now()}`)
    await mkdir(path.join(root, "a", "b", "c"), { recursive: true })
    await writeFile(path.join(root, "top.txt"), "x".repeat(10))
    await writeFile(path.join(root, "a", "b", "c", "deep.txt"), "y".repeat(10))
    try {
      const ac = new AbortController()
      const r = await walkUsage(root, 5, 1, ac.signal)
      expect(r.truncated).toBe(true)
      // depth 1 still walks root + a but not into a/b
      expect(r.total_bytes).toBe(10) // only top.txt
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("disk.reportPath", () => {
  test("reports plausible free/total bytes for tmp", async () => {
    const r = await reportPath(os.tmpdir())
    expect(r.total_bytes).toBeGreaterThan(0)
    expect(r.free_bytes).toBeGreaterThanOrEqual(0)
    expect(r.used_bytes).toBeGreaterThanOrEqual(0)
    expect(r.percent_used).toBeGreaterThanOrEqual(0)
    expect(r.percent_used).toBeLessThanOrEqual(100)
  })
})
