#!/usr/bin/env bun

import path from "node:path"
import fs from "node:fs/promises"
import { existsSync } from "node:fs"

const root = path.resolve(import.meta.dirname, "..")
process.chdir(root)

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

async function migrations(dir: string): Promise<Journal> {
  const dirs = await fs
    .readdir(dir, { withFileTypes: true })
    .then((items) => items.filter((d) => d.isDirectory()).map((d) => d.name))
    .catch(() => [])

  const sql = await Promise.all(
    dirs.map(async (name) => {
      const file = path.join(dir, name, "migration.sql")
      if (!existsSync(file)) return
      const text = await fs.readFile(file, "utf-8")
      return { sql: text, timestamp: time(name) }
    }),
  )

  return (sql.filter(Boolean) as Journal).sort((a, b) => a.timestamp - b.timestamp)
}

const out = path.join(root, "dist", "webcontainer")
await fs.rm(out, { recursive: true, force: true })
await fs.mkdir(out, { recursive: true })

const journal = await migrations(path.join(root, "migration"))
await fs.writeFile(path.join(out, "migrations.json"), JSON.stringify(journal))

const wasmSrc = path.join(root, "node_modules", "sql.js", "dist", "sql-wasm.wasm")
const wasmDst = path.join(out, "sql-wasm.wasm")
await fs.copyFile(wasmSrc, wasmDst)

const proc = Bun.spawn(
  [
    process.execPath,
    "build",
    "--target=node",
    "--format=esm",
    "--splitting",
    "--sourcemap=inline",
    "--outdir",
    out,
    "--entry-naming",
    "server.mjs",
    "--chunk-naming",
    "chunk-[hash].mjs",
    "--asset-naming",
    "asset-[hash].[ext]",
    "./src/server/webcontainer-entry.ts",
    "--external",
    "bun",
    "--external",
    "bun:*",
  ],
  { stdout: "inherit", stderr: "inherit" },
)
const code = await proc.exited
if (code !== 0) throw new Error("Failed to build webcontainer server bundle")

console.log(`Built webcontainer server: ${out}`)

