import fs from "node:fs/promises"

process.env.OPENCODE_RUNTIME = process.env.OPENCODE_RUNTIME || "webcontainer"

const port = Number(process.env.PORT ?? 4096)
const hostname = process.env.HOSTNAME ?? "0.0.0.0"

console.log(
  "[dbg 3cdfc3] webcontainer-entry env",
  JSON.stringify({
    OPENCODE_RUNTIME: process.env.OPENCODE_RUNTIME,
    PORT: process.env.PORT,
    OPENCODE_ANTHROPIC_BASE_URL: process.env.OPENCODE_ANTHROPIC_BASE_URL,
    hasAnthropicKey: !!process.env.ANTHROPIC_API_KEY,
  }),
)

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

serve(
  {
    fetch: app.fetch,
    port,
  },
  () => {
    // Keep log format compatible with @opencode-ai/sdk createOpencodeServer()
    console.log(`opencode serverrrr listening on http://${hostname}:${port}`)
  },
)
