import { Bus } from "@/bus"
import { Instance } from "@/project/instance"
import { InstanceBootstrapWebcontainer } from "@/project/bootstrap-webcontainer"
import { Flag } from "@/flag/flag"
import { Log } from "@/util/log"
import { NotFoundError } from "@/storage/db"
import { NamedError } from "@opencode-ai/util/error"
import { Provider } from "@/provider/provider"
import { Hono } from "hono"
import { basicAuth } from "hono/basic-auth"
import { cors } from "hono/cors"
import { HTTPException } from "hono/http-exception"
import { streamSSE } from "hono/streaming"
import type { ContentfulStatusCode } from "hono/utils/http-status"
import { Auth } from "@/auth"
import { SessionRoutes } from "./routes/session"
import { GlobalRoutes } from "./routes/global"
import { WebContainerShellRoutes } from "./routes/webcontainer-shell"

export function createWebContainerApp() {
  const log = Log.create({ service: "webcontainer.server" })

  const app = new Hono()

  app.onError((err, c) => {
    log.error("failed", { error: err })
    if (err instanceof NamedError) {
      let status: ContentfulStatusCode
      if (err instanceof NotFoundError) status = 404
      else if (err instanceof Provider.ModelNotFoundError) status = 400
      else status = 500
      return c.json(err.toObject(), { status })
    }
    if (err instanceof HTTPException) return err.getResponse()
    const message = err instanceof Error && err.stack ? err.stack : err.toString()
    return c.json(new NamedError.Unknown({ message }).toObject(), { status: 500 })
  })

  app.use(
    cors({
      origin: "*",
    }),
  )

  app.use((c, next) => {
    // Allow CORS preflight requests to succeed without auth.
    if (c.req.method === "OPTIONS") return next()
    const password = Flag.OPENCODE_SERVER_PASSWORD
    if (!password) return next()
    const username = Flag.OPENCODE_SERVER_USERNAME ?? "opencode"
    return basicAuth({ username, password })(c, next)
  })

  app.use(async (c, next) => {
    const raw = c.req.query("directory") || c.req.header("x-opencode-directory") || process.cwd()
    const directory = (() => {
      try {
        return decodeURIComponent(raw)
      } catch {
        return raw
      }
    })()

    return Instance.provide({
      directory,
      init: InstanceBootstrapWebcontainer,
      async fn() {
        return next()
      },
    })
  })

  app.route("/global", GlobalRoutes())

  app.put("/auth/:providerID", async (c) => {
    const providerID = c.req.param("providerID")
    const body = await c.req.json().catch(() => undefined)
    const parsed = Auth.Info.safeParse(body)
    if (!parsed.success) {
      return c.json(new NamedError.Unknown({ message: parsed.error.message }).toObject(), { status: 400 })
    }
    await Auth.set(providerID, parsed.data)
    return c.json(true)
  })

  app.delete("/auth/:providerID", async (c) => {
    const providerID = c.req.param("providerID")
    await Auth.remove(providerID)
    return c.json(true)
  })

  app.route("/session", SessionRoutes())
  app.route("/experimental/shell", WebContainerShellRoutes())

  app.get("/event", async (c) => {
    log.info("event connected")
    c.header("X-Accel-Buffering", "no")
    c.header("X-Content-Type-Options", "nosniff")
    return streamSSE(c, async (stream) => {
      stream.writeSSE({
        data: JSON.stringify({
          type: "server.connected",
          properties: {},
        }),
      })

      const unsub = Bus.subscribeAll(async (event) => {
        await stream.writeSSE({
          data: JSON.stringify(event),
        })
        if (event.type === Bus.InstanceDisposed.type) {
          stream.close()
        }
      })

      const heartbeat = setInterval(() => {
        stream.writeSSE({
          data: JSON.stringify({
            type: "server.heartbeat",
            properties: {},
          }),
        })
      }, 10_000)

      await new Promise<void>((resolve) => {
        stream.onAbort(() => {
          clearInterval(heartbeat)
          unsub()
          resolve()
          log.info("event disconnected")
        })
      })
    })
  })

  app.get("/doc", async (c) => {
    // Keep this endpoint around so the outer UI can show a basic hint.
    // The full OpenAPI generator is Bun-oriented and can be re-added later.
    return c.json({
      title: "opencode (webcontainer)",
      openapi: "disabled",
    })
  })

  return app
}

