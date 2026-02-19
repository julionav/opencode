import type { SQLiteBunDatabase } from "drizzle-orm/bun-sqlite"
import type { SQLJsDatabase } from "drizzle-orm/sql-js"
import { type SQLiteTransaction } from "drizzle-orm/sqlite-core"
export * from "drizzle-orm"
import { Context } from "../util/context"
import { lazy } from "../util/lazy"
import { Global } from "../global"
import { Log } from "../util/log"
import { NamedError } from "@opencode-ai/util/error"
import z from "zod"
import path from "path"
import { readFileSync, readdirSync, existsSync } from "fs"
import fs from "node:fs/promises"
import * as schema from "./schema"
import { Runtime } from "@/runtime"
import type { Database as SqlJsClient } from "sql.js"
import type { Database as BunClient } from "bun:sqlite"
import initSqlJs from "sql.js"
// CJS module, but Bun/Node interop provides `.default`
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import initSqlJsAsmMod from "sql.js/dist/sql-asm.js"

declare const OPENCODE_MIGRATIONS: { sql: string; timestamp: number }[] | undefined
declare const OPENCODE_SQLJS_WASM: string | undefined

export const NotFoundError = NamedError.create(
  "NotFoundError",
  z.object({
    message: z.string(),
  }),
)

const log = Log.create({ service: "db" })

const bun = Runtime.mode() === "bun"

const bunSqlite = bun ? await Runtime.load<any>("bun:sqlite") : undefined
const bunDriver = bun ? await Runtime.load<any>("drizzle-orm/bun-sqlite") : undefined
const bunMigrator = bun ? await Runtime.load<any>("drizzle-orm/bun-sqlite/migrator") : undefined

const sqlDriver = bun ? undefined : await import("drizzle-orm/sql-js")

const wasm =
  typeof OPENCODE_SQLJS_WASM === "string"
    ? OPENCODE_SQLJS_WASM
    : Runtime.mode() === "webcontainer"
      ? (() => {
          const p = new URL("sql-wasm.wasm", import.meta.url).pathname
          if (existsSync(p)) return p
          return
        })()
      : undefined

const initAsm = (initSqlJsAsmMod as any)?.default ?? initSqlJsAsmMod

const SQL = bun
  ? undefined
  : await initSqlJs(
      wasm
        ? {
            locateFile() {
              return wasm
            },
          }
        : {},
    ).catch(async () => {
      // Some WebContainer/browser combinations reject the wasm build.
      // Fall back to the asm.js build (slower, but more compatible).
      return initAsm({})
    })

export namespace Database {
  let sql: SqlJsClient | undefined

  export const Path = path.join(Global.Path.data, "opencode.db")
  type Schema = typeof schema
  export type Transaction = SQLiteTransaction<"sync", void, Schema>

  type Raw = BunClient | SqlJsClient
  type Client = (SQLiteBunDatabase<Schema> | SQLJsDatabase<Schema>) & { $client: Raw }

  type Journal = { sql: string; timestamp: number }[]

  function time(tag: string) {
    const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(tag)
    if (!match) return 0
    return Date.UTC(
      Number(match[1]),
      Number(match[2]) - 1,
      Number(match[3]),
      Number(match[4]),
      Number(match[5]),
      Number(match[6]),
    )
  }

  function migrations(dir: string): Journal {
    const dirs = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)

    const sql = dirs
      .map((name) => {
        const file = path.join(dir, name, "migration.sql")
        if (!existsSync(file)) return
        return {
          sql: readFileSync(file, "utf-8"),
          timestamp: time(name),
        }
      })
      .filter(Boolean) as Journal

    return sql.sort((a, b) => a.timestamp - b.timestamp)
  }

  function journal() {
    const injected = (globalThis as unknown as { OPENCODE_MIGRATIONS?: Journal }).OPENCODE_MIGRATIONS
    if (injected) return injected
    return typeof OPENCODE_MIGRATIONS !== "undefined"
      ? OPENCODE_MIGRATIONS
      : migrations(path.join(import.meta.dirname, "../../migration"))
  }

  function applySqljsMigrations(sqlite: SqlJsClient, entries: Journal) {
    if (entries.length === 0) return

    sqlite.exec("CREATE TABLE IF NOT EXISTS __opencode_migrations (timestamp INTEGER PRIMARY KEY)")
    const row = sqlite.exec("SELECT MAX(timestamp) AS t FROM __opencode_migrations")[0]
    const max = (row?.values?.[0]?.[0] as number | null | undefined) ?? 0

    const next = entries.filter((e) => e.timestamp > max)
    if (next.length === 0) return

    log.info("applying migrations", {
      count: next.length,
      mode: typeof OPENCODE_MIGRATIONS !== "undefined" ? "bundled" : "dev",
    })

    // If this is an existing SQLite database (created by the Bun runtime path)
    // it may already contain the full schema but not our `__opencode_migrations` tracking table.
    // In that case, attempting to re-run migrations will fail on `CREATE TABLE ...`.
    if (max === 0) {
      const existing = sqlite.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='project'")[0]
      if (existing?.values?.length) {
        sqlite.run("INSERT OR REPLACE INTO __opencode_migrations (timestamp) VALUES (?)", [
          entries[entries.length - 1]!.timestamp,
        ])
        return
      }
    }

    for (const entry of next) {
      try {
        sqlite.exec(entry.sql)
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        if (!msg.includes("already exists")) throw e
      }
      sqlite.run("INSERT INTO __opencode_migrations (timestamp) VALUES (?)", [entry.timestamp])
    }
  }

  async function persist(sqlite: SqlJsClient) {
    const out = sqlite.export()
    await fs.mkdir(path.dirname(Path), { recursive: true })
    await fs.writeFile(Path, Buffer.from(out)).catch(() => {})
  }

  export const Client = lazy(() => {
    log.info("opening database", { path: path.join(Global.Path.data, "opencode.db") })

    if (bun) {
      const sqlite = new bunSqlite!.Database(path.join(Global.Path.data, "opencode.db"), { create: true })

      sqlite.run("PRAGMA journal_mode = WAL")
      sqlite.run("PRAGMA synchronous = NORMAL")
      sqlite.run("PRAGMA busy_timeout = 5000")
      sqlite.run("PRAGMA cache_size = -64000")
      sqlite.run("PRAGMA foreign_keys = ON")
      sqlite.run("PRAGMA wal_checkpoint(PASSIVE)")

      const db = bunDriver!.drizzle({ client: sqlite, schema }) as Client
      const entries = journal()
      if (entries.length > 0) bunMigrator!.migrate(db, entries)
      return db
    }

    if (!SQL || !sqlDriver) {
      throw new Error("sql.js is required for OPENCODE_RUNTIME=webcontainer")
    }

    const bytes = existsSync(Path) ? readFileSync(Path) : undefined
    const sqlite = bytes ? new SQL.Database(bytes) : new SQL.Database()
    sql = sqlite

    const db = Object.assign(sqlDriver.drizzle(sqlite, { schema }), { $client: sqlite }) as Client
    applySqljsMigrations(sqlite, journal())
    void persist(sqlite)

    return db
  })

  export type TxOrDb = Transaction | Client

  const ctx = Context.create<{
    tx: TxOrDb
    effects: (() => void | Promise<void>)[]
  }>("database")

  export function use<T>(callback: (trx: TxOrDb) => T): T {
    try {
      return callback(ctx.use().tx)
    } catch (err) {
      if (err instanceof Context.NotFound) {
        const effects: (() => void | Promise<void>)[] = []
        const result = ctx.provide({ effects, tx: Client() }, () => callback(Client()))
        for (const effect of effects) effect()
        if (!bun && sql) void persist(sql)
        return result
      }
      throw err
    }
  }

  export function effect(fn: () => any | Promise<any>) {
    try {
      ctx.use().effects.push(fn)
    } catch {
      fn()
    }
  }

  export function transaction<T>(callback: (tx: TxOrDb) => T): T {
    try {
      return callback(ctx.use().tx)
    } catch (err) {
      if (err instanceof Context.NotFound) {
        const effects: (() => void | Promise<void>)[] = []
        const result = Client().transaction((tx) => {
          return ctx.provide({ tx, effects }, () => callback(tx))
        })
        for (const effect of effects) effect()
        if (!bun && sql) void persist(sql)
        return result
      }
      throw err
    }
  }
}
