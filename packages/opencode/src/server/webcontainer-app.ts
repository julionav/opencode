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

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS, DELETE, PATCH, PUT",
  "Access-Control-Allow-Headers": "Content-Type",
}

export function createWebContainerApp() {
  const log = Log.create({ service: "webcontainer.server" })

  const app = new Hono()

  app.use("*", async (c, next) => {
    log.info("request", {
      method: c.req.method,
      path: c.req.path,
      url: c.req.url,
    })
    return await next()
  })

  app.use(
    cors({
      origin: corsHeaders["Access-Control-Allow-Origin"],
      allowMethods: corsHeaders["Access-Control-Allow-Methods"].split(", "),
      allowHeaders: corsHeaders["Access-Control-Allow-Headers"].split(", "),
    }),
  )

  app.get("/health", (c) => c.text("hey"))

  app.get("/proxy", (c) => {
    return c.html(`<!DOCTYPE html>
<html><head><meta charset="utf-8"></head><body><script>
window.addEventListener("message", async (e) => {
  const { id, method, path, headers, body } = e.data
  if (!id || !path) return
  try {
    const res = await fetch(path, {
      method: method || "GET",
      headers: headers || {},
      body: body != null ? body : undefined,
    })
    const responseHeaders = {}
    res.headers.forEach((v, k) => { responseHeaders[k] = v })
    window.parent.postMessage({ id, type: "start", status: res.status, headers: responseHeaders }, "*")
    if (res.body) {
      const reader = res.body.getReader()
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        window.parent.postMessage({ id, type: "chunk", chunk: value }, "*", [value.buffer])
      }
    }
    window.parent.postMessage({ id, type: "end" }, "*")
  } catch (err) {
    window.parent.postMessage({ id, type: "error", message: err.message }, "*")
  }
})
window.parent.postMessage({ type: "ready" }, "*")
</script></body></html>`)
  })

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

  app.use(async (c, next) => {
    // Allow CORS preflight requests to succeed without auth.
    if (c.req.method === "OPTIONS") return await next()
    const password = Flag.OPENCODE_SERVER_PASSWORD
    if (!password) return await next()
    const username = Flag.OPENCODE_SERVER_USERNAME ?? "opencode"
    return await basicAuth({ username, password })(c, next)
  })

  app.use(async (c, next) => {
    const raw = "/home/workdir/project"
    const directory = (() => {
      try {
        return decodeURIComponent(raw)
      } catch {
        return raw
      }
    })()

    console.log("directory!!!!", directory)
    console.log(
      "[dbg 3cdfc3] instance.provide begin",
      JSON.stringify({ method: c.req.method, path: c.req.path, raw, directory }),
    )
    try {
      return await Instance.provide({
        directory,
        init: InstanceBootstrapWebcontainer,
        async fn() {
          console.log("[dbg 3cdfc3] instance.fn enter", JSON.stringify({ method: c.req.method, path: c.req.path }))
          const result = await next()
          console.log("[dbg 3cdfc3] instance.fn exit", JSON.stringify({ method: c.req.method, path: c.req.path }))
          return result
        },
      })
    } catch (e) {
      console.log("[dbg 3cdfc3] instance.provide error", e instanceof Error ? e.stack || e.message : String(e))
      throw e
    }
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
