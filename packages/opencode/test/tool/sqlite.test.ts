import { Database } from "bun:sqlite"
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { __testing } from "@/tool/sqlite"

describe("sqlite tool helpers", () => {
  test("isReadOnlySql accepts SELECT/PRAGMA/EXPLAIN/WITH/VALUES", () => {
    expect(__testing.isReadOnlySql("SELECT 1")).toBe(true)
    expect(__testing.isReadOnlySql("  select * from t")).toBe(true)
    expect(__testing.isReadOnlySql("PRAGMA table_info(t)")).toBe(true)
    expect(__testing.isReadOnlySql("EXPLAIN QUERY PLAN SELECT 1")).toBe(true)
    expect(__testing.isReadOnlySql("WITH x AS (SELECT 1) SELECT * FROM x")).toBe(true)
    expect(__testing.isReadOnlySql("VALUES (1), (2)")).toBe(true)
  })

  test("isReadOnlySql rejects writes and DDL", () => {
    expect(__testing.isReadOnlySql("INSERT INTO t VALUES (1)")).toBe(false)
    expect(__testing.isReadOnlySql("UPDATE t SET a = 1")).toBe(false)
    expect(__testing.isReadOnlySql("DELETE FROM t")).toBe(false)
    expect(__testing.isReadOnlySql("CREATE TABLE t (a)")).toBe(false)
    expect(__testing.isReadOnlySql("DROP TABLE t")).toBe(false)
    expect(__testing.isReadOnlySql("REPLACE INTO t VALUES (1)")).toBe(false)
  })

  test("isReadOnlySql tolerates leading comments", () => {
    expect(__testing.isReadOnlySql("-- comment\nSELECT 1")).toBe(true)
    expect(__testing.isReadOnlySql("/* multi\nline */ SELECT 1")).toBe(true)
  })

  test("describeValue summarises blobs and bigints", () => {
    expect(__testing.describeValue(new Uint8Array([1, 2, 3]))).toBe("<blob 3 bytes>")
    expect(__testing.describeValue(123n)).toBe("123")
    expect(__testing.describeValue("hello")).toBe("hello")
    expect(__testing.describeValue(null)).toBeNull()
  })

  test("serializeRowsCsv quotes special characters", () => {
    const rows = [
      { a: "x,y", b: "ok" },
      { a: 'with "quotes"', b: "line\nbreak" },
    ]
    const out = __testing.serializeRowsCsv(rows)
    expect(out.split("\n")[0]).toBe("a,b")
    expect(out).toContain('"x,y"')
    expect(out).toContain('"with ""quotes"""')
    expect(out).toContain('"line\nbreak"')
  })

  test("serializeRowsJson preserves blob descriptors", () => {
    const out = __testing.serializeRowsJson([{ a: new Uint8Array([1, 2, 3]) }])
    expect(out).toContain("<blob 3 bytes>")
  })

  test("bindParams handles arrays, objects, scalars, and undefined", () => {
    expect(__testing.bindParams(undefined)).toBeUndefined()
    expect(__testing.bindParams([1, 2])).toEqual([1, 2])
    expect(__testing.bindParams({ a: 1 })).toEqual({ a: 1 })
    expect(__testing.bindParams("solo")).toEqual(["solo"])
  })
})

describe("sqlite tool e2e (bun:sqlite)", () => {
  let tmp: string
  let dbPath: string

  beforeAll(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "sg-sqlite-test-"))
    dbPath = path.join(tmp, "test.db")
    const db = new Database(dbPath)
    db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT)`)
    db.exec(`INSERT INTO users (id, name, email) VALUES (1, 'Alice', 'alice@x.test'), (2, 'Bob', NULL)`)
    db.close()
  })

  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  test("read-only Database can SELECT", () => {
    const db = new Database(dbPath, { readonly: true })
    const rows = db.query("SELECT id, name FROM users ORDER BY id").all()
    expect(rows).toEqual([
      { id: 1, name: "Alice" },
      { id: 2, name: "Bob" },
    ])
    db.close()
  })

  test("PRAGMA table_info returns column metadata", () => {
    const db = new Database(dbPath, { readonly: true })
    const cols = db.query(`PRAGMA table_info("users")`).all() as Record<string, unknown>[]
    expect(cols.length).toBe(3)
    expect(cols[0]!.name).toBe("id")
    expect(cols[1]!.name).toBe("name")
    db.close()
  })

  test("write_mode=false rejects INSERT via Database readonly", () => {
    const db = new Database(dbPath, { readonly: true })
    expect(() => db.exec("INSERT INTO users (id, name) VALUES (3, 'Carol')")).toThrow()
    db.close()
  })
})
