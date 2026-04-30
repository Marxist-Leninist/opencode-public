import { Effect, Schema } from "effect"
import * as path from "node:path"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Instance } from "../project/instance"
import { assertExternalDirectoryEffect } from "./external-directory"
import DESCRIPTION from "./sqlite.txt"
import * as Tool from "./tool"

const ACTIONS = ["query", "tables", "schema", "columns", "info", "exec"] as const
const FORMATS = ["json", "csv"] as const
const DEFAULT_LIMIT = 200
const MAX_LIMIT = 5000
const MAX_OUTPUT_CHARS = 16_000
const MAX_DB_BYTES = 4 * 1024 * 1024 * 1024 // 4 GiB safety cap; we never read the whole file, just refuse on oversize.

const READONLY_FIRST_TOKEN = /^\s*(?:--[^\n]*\n|\/\*[\s\S]*?\*\/|\s)*\b(SELECT|WITH|EXPLAIN|PRAGMA|VALUES)\b/i

export const Parameters = Schema.Struct({
  action: Schema.Literals(ACTIONS).annotate({
    description:
      "query (read-only SELECT/WITH/EXPLAIN/PRAGMA), tables (list user tables/views), schema (CREATE statements), columns (table_info for one table), info (db stats), or exec (writes; requires write_mode=true).",
  }),
  path: Schema.String.check(Schema.isMinLength(1)).annotate({
    description:
      "Path to the SQLite database file. Absolute preferred; relative paths resolve from the project directory.",
  }),
  sql: Schema.optional(Schema.String).annotate({
    description: "SQL text. Required for 'query' and 'exec'.",
  }),
  params: Schema.optional(Schema.Unknown).annotate({
    description:
      "Parameter bindings. Either a JSON array (positional ?) or a JSON object (named :foo / @foo / $foo).",
  }),
  table: Schema.optional(Schema.String).annotate({
    description: "Table name. Required for 'columns'; optional filter for 'schema'.",
  }),
  limit: Schema.optional(
    Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(MAX_LIMIT)),
  ).annotate({ description: `Row cap for 'query'. Default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}.` }),
  offset: Schema.optional(Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))).annotate({
    description: "Row offset for 'query'. Default 0.",
  }),
  format: Schema.optional(Schema.Literals(FORMATS)).annotate({
    description: "Row output format: 'json' (default) or 'csv'.",
  }),
  write_mode: Schema.optional(Schema.Boolean).annotate({
    description: "Open writable. Required for 'exec'. Default false.",
  }),
  timeout_ms: Schema.optional(
    Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(100), Schema.isLessThanOrEqualTo(60000)),
  ).annotate({ description: "SQLite busy timeout in ms. Default 5000, max 60000." }),
})

type Params = Schema.Schema.Type<typeof Parameters>
type Action = (typeof ACTIONS)[number]
type FormatMode = (typeof FORMATS)[number]
type SqliteRunResult = { changes?: number | bigint; lastInsertRowid?: number | bigint }
type SqliteStatement = {
  all: (...args: any[]) => Record<string, unknown>[]
  get: (...args: any[]) => Record<string, unknown> | undefined
  run: (...args: any[]) => SqliteRunResult
}
type SqliteDatabase = {
  exec: (sql: string) => unknown
  query: (sql: string) => SqliteStatement
  prepare: (sql: string) => SqliteStatement
  close: () => void
}

type Metadata = {
  action: Action
  path: string
  table?: string
  rows?: number
  columns?: string[]
  truncated?: boolean
  read_only?: boolean
  changes?: number
  last_insert_rowid?: number
  size_bytes?: number
  elapsed_ms?: number
}

const done = (result: Tool.ExecuteResult<Metadata>) => result

function truncate(s: string): string {
  if (s.length <= MAX_OUTPUT_CHARS) return s
  return s.slice(0, MAX_OUTPUT_CHARS) + `\n... [truncated ${s.length - MAX_OUTPUT_CHARS} chars]`
}

function isReadOnlySql(sql: string): boolean {
  return READONLY_FIRST_TOKEN.test(sql)
}

function describeValue(v: unknown): unknown {
  if (v instanceof Uint8Array || (v && typeof v === "object" && (v as any).buffer instanceof ArrayBuffer)) {
    const len = (v as Uint8Array).byteLength ?? (v as Uint8Array).length ?? 0
    return `<blob ${len} bytes>`
  }
  if (typeof v === "bigint") return v.toString()
  return v
}

function serializeRowsJson(rows: Record<string, unknown>[]): string {
  return JSON.stringify(
    rows.map((r) => {
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(r)) out[k] = describeValue(v)
      return out
    }),
    null,
    2,
  )
}

function serializeRowsCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return ""
  const cols = Object.keys(rows[0]!)
  const escape = (raw: unknown) => {
    const v = describeValue(raw)
    const s = v == null ? "" : String(v)
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const lines = [cols.join(",")]
  for (const row of rows) lines.push(cols.map((c) => escape(row[c])).join(","))
  return lines.join("\n")
}

function bindParams(params: unknown): Record<string, unknown> | unknown[] | undefined {
  if (params === undefined || params === null) return undefined
  if (Array.isArray(params)) return params
  if (typeof params === "object") return params as Record<string, unknown>
  return [params]
}

async function openDb(target: string, writable: boolean, busyTimeoutMs: number): Promise<SqliteDatabase> {
  const db = isBunRuntime()
    ? await openBunDb(target, writable)
    : await openNodeDb(target, writable, busyTimeoutMs)
  try {
    db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`)
  } catch {
    // PRAGMA may fail silently on some SQLite builds; not fatal.
  }
  return db
}

function isBunRuntime() {
  return typeof (globalThis as any).Bun?.version === "string"
}

async function openBunDb(target: string, writable: boolean): Promise<SqliteDatabase> {
  const specifier = "bun" + ":sqlite"
  const { Database } = (await import(specifier)) as {
    Database: new (path: string, options?: Record<string, unknown>) => SqliteDatabase
  }
  return new Database(target, writable ? {} : { readonly: true, create: false })
}

async function openNodeDb(target: string, writable: boolean, busyTimeoutMs: number): Promise<SqliteDatabase> {
  const { DatabaseSync } = (await import("node:sqlite")) as {
    DatabaseSync: new (path: string, options?: { readOnly?: boolean; timeout?: number }) => {
      exec: (sql: string) => unknown
      prepare: (sql: string) => SqliteStatement
      close: () => void
    }
  }
  const db = new DatabaseSync(target, { readOnly: !writable, timeout: busyTimeoutMs })
  return {
    exec: (sql) => db.exec(sql),
    query: (sql) => db.prepare(sql),
    prepare: (sql) => db.prepare(sql),
    close: () => db.close(),
  }
}

export const SqliteTool = Tool.define(
  "sqlite",
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Params, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const action = params.action
          const target = path.isAbsolute(params.path)
            ? params.path
            : path.resolve(Instance.directory, params.path)

          const isWrite = action === "exec"
          if (isWrite && params.write_mode !== true) {
            throw new Error("sqlite: action 'exec' requires write_mode=true")
          }

          yield* ctx.ask({
            permission: isWrite ? "write" : "read",
            patterns: [target],
            always: ["*"],
            metadata: { path: target, action },
          })
          yield* assertExternalDirectoryEffect(ctx, target, { kind: "file" })

          const info = yield* fs.stat(target).pipe(Effect.catch(() => Effect.succeed(undefined)))
          if (!info) throw new Error(`sqlite: file not found: ${target}`)
          if (info.type !== "File") throw new Error(`sqlite: not a regular file: ${target}`)
          const sizeBytes = Number(info.size ?? 0)
          if (sizeBytes > MAX_DB_BYTES) {
            throw new Error(
              `sqlite: database too large (${sizeBytes} bytes > ${MAX_DB_BYTES}); refusing to open`,
            )
          }

          const fmt: FormatMode = params.format ?? "json"
          const limit = params.limit ?? DEFAULT_LIMIT
          const offset = params.offset ?? 0
          const busyTimeoutMs = params.timeout_ms ?? 5000

          const start = Date.now()
          const writable = isWrite || params.write_mode === true
          const db = yield* Effect.promise(() => openDb(target, writable, busyTimeoutMs))
          try {
            if (action === "query") {
              if (!params.sql || params.sql.trim().length === 0) {
                throw new Error("sqlite: query requires non-empty sql")
              }
              if (!isReadOnlySql(params.sql) && !writable) {
                throw new Error(
                  "sqlite: query rejects non-read-only SQL. Use action='exec' with write_mode=true for writes.",
                )
              }
              const stmt = db.query(params.sql)
              const bind = bindParams(params.params)
              const rawAll = bind === undefined ? stmt.all() : (stmt.all as any)(bind)
              const rawRows = (rawAll as Record<string, unknown>[]) ?? []
              const sliced = rawRows.slice(offset, offset + limit)
              const truncated = rawRows.length > offset + limit
              const cols = sliced.length > 0 ? Object.keys(sliced[0]!) : []
              const text = fmt === "csv" ? serializeRowsCsv(sliced) : serializeRowsJson(sliced)
              const elapsed_ms = Date.now() - start
              return done({
                title: `sqlite query: ${sliced.length} rows${truncated ? " (truncated)" : ""}`,
                metadata: {
                  action,
                  path: target,
                  rows: sliced.length,
                  columns: cols,
                  truncated,
                  read_only: !writable,
                  size_bytes: sizeBytes,
                  elapsed_ms,
                },
                output: truncate(text || "(no rows)"),
              })
            }

            if (action === "tables") {
              const rawAll = db
                .query(
                  `SELECT name, type FROM sqlite_schema WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY type, name`,
                )
                .all() as { name: string; type: string }[]
              const rows: { name: string; type: string; rows?: number }[] = []
              for (const t of rawAll) {
                let count: number | undefined
                try {
                  const r = db.query(`SELECT COUNT(*) AS n FROM "${t.name.replace(/"/g, '""')}"`).get() as
                    | { n: number }
                    | undefined
                  count = r?.n
                } catch {
                  count = undefined
                }
                rows.push({ name: t.name, type: t.type, rows: count })
              }
              const text =
                fmt === "csv"
                  ? serializeRowsCsv(rows as Record<string, unknown>[])
                  : serializeRowsJson(rows as Record<string, unknown>[])
              const elapsed_ms = Date.now() - start
              return done({
                title: `sqlite tables: ${rows.length}`,
                metadata: {
                  action,
                  path: target,
                  rows: rows.length,
                  columns: ["name", "type", "rows"],
                  read_only: !writable,
                  size_bytes: sizeBytes,
                  elapsed_ms,
                },
                output: truncate(text || "(no tables)"),
              })
            }

            if (action === "schema") {
              const rawAll = (
                params.table
                  ? db
                      .query(
                        `SELECT type, name, sql FROM sqlite_schema WHERE name = ? AND sql IS NOT NULL`,
                      )
                      .all(params.table)
                  : db
                      .query(
                        `SELECT type, name, sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type, name`,
                      )
                      .all()
              ) as { type: string; name: string; sql: string }[]
              const text = rawAll.map((r) => `-- ${r.type} ${r.name}\n${r.sql};`).join("\n\n")
              const elapsed_ms = Date.now() - start
              return done({
                title: params.table
                  ? `sqlite schema: ${params.table}${rawAll.length === 0 ? " (not found)" : ""}`
                  : `sqlite schema: ${rawAll.length} object(s)`,
                metadata: {
                  action,
                  path: target,
                  table: params.table,
                  rows: rawAll.length,
                  read_only: !writable,
                  size_bytes: sizeBytes,
                  elapsed_ms,
                },
                output: truncate(text || "(no schema)"),
              })
            }

            if (action === "columns") {
              if (!params.table || params.table.trim().length === 0) {
                throw new Error("sqlite: columns requires 'table'")
              }
              const safe = params.table.replace(/"/g, '""')
              const rows = db.query(`PRAGMA table_info("${safe}")`).all() as Record<string, unknown>[]
              const text =
                fmt === "csv" ? serializeRowsCsv(rows) : serializeRowsJson(rows)
              const elapsed_ms = Date.now() - start
              return done({
                title: `sqlite columns: ${params.table} → ${rows.length}`,
                metadata: {
                  action,
                  path: target,
                  table: params.table,
                  rows: rows.length,
                  columns: rows.length > 0 ? Object.keys(rows[0]!) : [],
                  read_only: !writable,
                  size_bytes: sizeBytes,
                  elapsed_ms,
                },
                output: truncate(text || "(no columns — table may not exist)"),
              })
            }

            if (action === "info") {
              const tables = db
                .query(
                  `SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
                )
                .all() as { name: string }[]
              const pragma = (q: string) => {
                try {
                  const r = db.query(`PRAGMA ${q}`).get()
                  if (!r) return undefined
                  const vals = Object.values(r as Record<string, unknown>)
                  return vals[0]
                } catch {
                  return undefined
                }
              }
              const summary = {
                path: target,
                size_bytes: sizeBytes,
                page_size: pragma("page_size"),
                page_count: pragma("page_count"),
                journal_mode: pragma("journal_mode"),
                application_id: pragma("application_id"),
                user_version: pragma("user_version"),
                schema_version: pragma("schema_version"),
                encoding: pragma("encoding"),
                table_count: tables.length,
                tables: tables.map((t) => t.name),
              }
              const elapsed_ms = Date.now() - start
              return done({
                title: `sqlite info: ${tables.length} table(s), ${sizeBytes} bytes`,
                metadata: {
                  action,
                  path: target,
                  rows: tables.length,
                  read_only: !writable,
                  size_bytes: sizeBytes,
                  elapsed_ms,
                },
                output: truncate(JSON.stringify(summary, null, 2)),
              })
            }

            if (action === "exec") {
              if (!params.sql || params.sql.trim().length === 0) {
                throw new Error("sqlite: exec requires non-empty sql")
              }
              // Bun's Database.exec runs multiple statements but returns no info; use prepare for single statements.
              const single = params.sql.trim().split(";").filter((s) => s.trim().length > 0).length === 1
              let changes: number | undefined
              let lastRowid: number | undefined
              if (single) {
                const stmt = db.prepare(params.sql)
                const bind = bindParams(params.params)
                const r = bind === undefined ? stmt.run() : (stmt.run as any)(bind)
                changes = Number((r as any)?.changes ?? 0)
                lastRowid = Number((r as any)?.lastInsertRowid ?? 0)
              } else {
                db.exec(params.sql)
              }
              const elapsed_ms = Date.now() - start
              return done({
                title: `sqlite exec: ${changes ?? "ok"}${changes ? " row(s) changed" : ""}`,
                metadata: {
                  action,
                  path: target,
                  changes,
                  last_insert_rowid: lastRowid,
                  read_only: false,
                  size_bytes: sizeBytes,
                  elapsed_ms,
                },
                output: `OK${changes !== undefined ? ` (changes=${changes}, last_insert_rowid=${lastRowid})` : ""}`,
              })
            }

            throw new Error(`sqlite: unsupported action '${action}'`)
          } finally {
            try {
              db.close()
            } catch {
              // ignore
            }
          }
        }),
    }
  }),
)

export const __testing = {
  isReadOnlySql,
  serializeRowsJson,
  serializeRowsCsv,
  describeValue,
  bindParams,
}
