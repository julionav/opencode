#!/usr/bin/env bun

import path from "node:path"
import fs from "node:fs/promises"
import { existsSync } from "node:fs"

const root = path.resolve(import.meta.dirname, "../../..")
const src = path.join(root, "packages", "opencode", "dist", "webcontainer")
const dst = path.join(root, "packages", "webcontainer-demo", "public", "opencode")

async function build() {
  const proc = Bun.spawn([process.execPath, "run", "--cwd", path.join(root, "packages", "opencode"), "build:webcontainer"], {
    stdout: "inherit",
    stderr: "inherit",
  })
  const code = await proc.exited
  if (code !== 0) throw new Error("Failed to build opencode webcontainer bundle")
}

if (!existsSync(path.join(src, "server.mjs"))) {
  await build()
}

await fs.rm(dst, { recursive: true, force: true })
await fs.mkdir(dst, { recursive: true })

const files = await fs.readdir(src).catch(() => [])
await Promise.all(files.map((name) => fs.copyFile(path.join(src, name), path.join(dst, name))))

await fs.writeFile(path.join(dst, "manifest.json"), JSON.stringify({ files }, null, 2))

console.log(`Copied opencode bundle (${files.length} files) to public/opencode`)

