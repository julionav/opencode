import fs from "node:fs/promises"

process.env.OPENCODE_RUNTIME = process.env.OPENCODE_RUNTIME || "webcontainer"

const port = Number(process.env.PORT ?? 4096)
const hostname = process.env.HOSTNAME ?? "0.0.0.0"

type Journal = { sql: string; timestamp: number }[]
const migrations = await fs
  .readFile(new URL("./migrations.json", import.meta.url), "utf-8")
  .then((text) => JSON.parse(text) as Journal)
  .catch(() => [] as Journal)

const global = globalThis as unknown as { OPENCODE_MIGRATIONS?: Journal }
global.OPENCODE_MIGRATIONS = migrations

const { serve } = await import("@hono/node-server")
const { createWebContainerApp } = await import("./webcontainer-app")

const app = createWebContainerApp()

serve({
  fetch: app.fetch,
  port,
  hostname,
})

// Keep log format compatible with @opencode-ai/sdk createOpencodeServer()
console.log(`opencode server listening on http://${hostname}:${port}`)

