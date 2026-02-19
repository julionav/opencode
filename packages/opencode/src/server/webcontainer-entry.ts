import { serve } from "@hono/node-server"
import { createWebContainerApp } from "./webcontainer-app"

process.env.OPENCODE_RUNTIME = process.env.OPENCODE_RUNTIME || "webcontainer"

const port = Number(process.env.PORT ?? 4096)
const hostname = process.env.HOSTNAME ?? "0.0.0.0"

const app = createWebContainerApp()

serve({
  fetch: app.fetch,
  port,
  hostname,
})

// Keep log format compatible with @opencode-ai/sdk createOpencodeServer()
console.log(`opencode server listening on http://${hostname}:${port}`)

