import http from "node:http"
import { query } from "@anthropic-ai/claude-agent-sdk"

const port = Number(process.env.PORT ?? 4097)
const host = process.env.HOSTNAME ?? "0.0.0.0"
const workdir = process.env.CLAUDE_WORKDIR ?? "/project"
const model = process.env.CLAUDE_MODEL ?? "claude-sonnet-4-6"

function write(res, event, data) {
  res.write(`event: ${event}\n`)
  res.write(`data: ${JSON.stringify(data)}\n\n`)
}

async function parse(req) {
  let body = ""
  for await (const chunk of req) body += chunk
  if (!body) return {}
  return JSON.parse(body)
}

function headers(res) {
  res.setHeader("Access-Control-Allow-Origin", "*")
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
  res.setHeader("Access-Control-Allow-Headers", "Content-Type")
}

function proxy() {
  return `<!DOCTYPE html>
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
  } catch (error) {
    window.parent.postMessage({ id, type: "error", message: error.message }, "*")
  }
})
window.parent.postMessage({ type: "ready" }, "*")
</script></body></html>`
}

const server = http.createServer(async (req, res) => {
  headers(res)
  if (req.method === "OPTIONS") {
    res.writeHead(204)
    res.end()
    return
  }

  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ ok: true }))
    return
  }

  if (req.method === "GET" && req.url === "/proxy") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
    res.end(proxy())
    return
  }

  if (req.method === "POST" && req.url === "/prompt") {
    const input = await parse(req).catch((error) => {
      res.writeHead(400, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
      return undefined
    })
    if (!input) return

    if (!input.prompt || typeof input.prompt !== "string") {
      res.writeHead(400, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ error: "Missing prompt" }))
      return
    }

    const env = {
      ...process.env,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    }

    const options = {
      cwd: workdir,
      model: typeof input.model === "string" && input.model ? input.model : model,
      env,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
    }

    if (typeof input.sessionID === "string" && input.sessionID) {
      options.resume = input.sessionID
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    })

    let sessionID = typeof input.sessionID === "string" ? input.sessionID : ""
    write(res, "start", { model: options.model })

    try {
      for await (const msg of query({
        prompt: input.prompt,
        options,
      })) {
        if (msg && typeof msg === "object" && typeof msg.session_id === "string") {
          sessionID = msg.session_id
        }
        write(res, "message", msg)
      }
      write(res, "done", { sessionID })
      res.end()
      return
    } catch (error) {
      write(res, "error", { message: error instanceof Error ? error.message : String(error), sessionID })
      res.end()
      return
    }
  }

  res.writeHead(404, { "Content-Type": "application/json" })
  res.end(JSON.stringify({ error: "Not found" }))
})

server.listen(port, host, () => {
  console.log(`claude demo server listening on http://${host}:${port}`)
})
