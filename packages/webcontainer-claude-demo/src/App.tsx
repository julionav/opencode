import { javascript } from "@codemirror/lang-javascript"
import CodeMirror from "@uiw/react-codemirror"
import { configureAPIKey, WebContainer } from "@webcontainer/api"
import React, { useMemo, useRef, useState } from "react"
import claudeServer from "./template/claude-server.mjs?raw"

type File = { path: string; name: string }
type Chat = { id: string; role: "user" | "assistant" | "system" | "error"; text: string }
type Pending = {
  resolve: (res: Response) => void
  reject: (err: Error) => void
  controller?: ReadableStreamDefaultController<Uint8Array>
}

type ProxyFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

const project = "/project"
const claude = "/claude"
const cors = (() => {
  const byEnv = import.meta.env.VITE_CORS_PROXY ?? ""
  try {
    const url = new URL(window.location.href)
    return url.searchParams.get("cors") ?? byEnv
  } catch {
    return byEnv
  }
})()

configureAPIKey("")

function site() {
  return {
    "package.json": {
      file: {
        contents: JSON.stringify(
          {
            name: "user-app",
            private: true,
            type: "module",
            scripts: {
              dev: "vite --host 0.0.0.0 --port 5173",
              build: "vite build",
              preview: "vite preview --host 0.0.0.0 --port 5173",
            },
            devDependencies: {
              vite: "^7.1.4",
            },
          },
          null,
          2,
        ),
      },
    },
    "index.html": {
      file: {
        contents: `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Claude Demo</title>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/main.js"></script>
  </body>
</html>`,
      },
    },
    src: {
      directory: {
        "main.js": {
          file: {
            contents: `const root = document.querySelector('#app')
root.innerHTML = '<h1>Hello world</h1><p>Ask Claude to edit me.</p>'`,
          },
        },
      },
    },
  } as const
}

function service() {
  return {
    "package.json": {
      file: {
        contents: JSON.stringify(
          {
            name: "claude-service",
            private: true,
            type: "module",
            dependencies: {
              "@anthropic-ai/claude-agent-sdk": "^0.2.50",
            },
          },
          null,
          2,
        ),
      },
    },
    "server.mjs": {
      file: {
        contents: claudeServer,
      },
    },
  } as const
}

function createProxyFetch(frame: HTMLIFrameElement): ProxyFetch {
  const pending = new Map<string, Pending>()

  window.addEventListener("message", (event) => {
    const data = event.data
    if (!data?.id) return
    const item = pending.get(data.id)
    if (!item) return

    if (data.type === "start") {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          item.controller = controller
        },
      })
      item.resolve(new Response(stream, { status: data.status, headers: data.headers }))
      return
    }

    if (data.type === "chunk") {
      const chunk = data.chunk instanceof Uint8Array ? data.chunk : new Uint8Array(data.chunk)
      item.controller?.enqueue(chunk)
      return
    }

    if (data.type === "end") {
      item.controller?.close()
      pending.delete(data.id)
      return
    }

    if (data.type === "error") {
      const error = new Error(data.message)
      if (item.controller) {
        item.controller.error(error)
      } else {
        item.reject(error)
      }
      pending.delete(data.id)
    }
  })

  return async (input, init) => {
    const req = input instanceof Request ? input : new Request(input, init)
    const url = new URL(req.url)
    const headers: Record<string, string> = {}
    req.headers.forEach((value, key) => {
      headers[key] = value
    })
    const body = req.body ? await new Response(req.body).text() : null
    const id = crypto.randomUUID()

    return new Promise<Response>((resolve, reject) => {
      pending.set(id, { resolve, reject })
      frame.contentWindow!.postMessage(
        {
          id,
          method: req.method,
          path: url.pathname + url.search,
          headers,
          body,
        },
        "*",
      )
    })
  }
}

async function list(wc: WebContainer, dir: string): Promise<File[]> {
  const items = await wc.fs.readdir(dir, { withFileTypes: true })
  const next = await Promise.all(
    items.map(async (item) => {
      const path = `${dir}/${item.name}`.replaceAll("//", "/")
      if (item.name === "node_modules") return []
      if (item.isDirectory()) return list(wc, path)
      if (!item.isFile()) return []
      return [{ path, name: item.name }]
    }),
  )
  return next.flat()
}

async function read(wc: WebContainer, path: string) {
  return (await wc.fs.readFile(path, "utf-8")) as string
}

async function write(wc: WebContainer, path: string, text: string) {
  await wc.fs.writeFile(path, text)
}

async function consume(stream: ReadableStream<string>, push: (line: string) => void) {
  const reader = stream.getReader()
  while (true) {
    const result = await reader.read()
    if (result.done) return
    push(result.value)
  }
}

async function events(res: Response, each: (event: string, data: string) => void) {
  if (!res.body) return
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
  let buffer = ""
  while (true) {
    const result = await reader.read()
    if (result.done) return
    buffer += result.value
    const parts = buffer.split("\n\n")
    buffer = parts.pop() ?? ""
    for (const part of parts) {
      let event = "message"
      let data = ""
      for (const line of part.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim()
        if (line.startsWith("data:")) data += line.replace(/^data:\s?/, "")
      }
      each(event, data)
    }
  }
}

function messageText(input: unknown) {
  if (!input || typeof input !== "object") return ""
  const msg = input as { type?: string; message?: { content?: { type?: string; text?: string }[] } }
  if (msg.type !== "assistant") return ""
  if (!Array.isArray(msg.message?.content)) return ""
  return msg.message.content.filter((item) => item.type === "text").flatMap((item) => item.text ?? []).join("\n")
}

export function App() {
  const [booting, setBooting] = useState(false)
  const [running, setRunning] = useState(false)
  const [sending, setSending] = useState(false)

  const [wc, setWc] = useState<WebContainer>()
  const [api, setApi] = useState("")
  const [preview, setPreview] = useState("")

  const [files, setFiles] = useState<File[]>([])
  const [file, setFile] = useState("")
  const [value, setValue] = useState("")
  const [dirty, setDirty] = useState(false)

  const [prompt, setPrompt] = useState("")
  const [model, setModel] = useState(import.meta.env.VITE_CLAUDE_MODEL ?? "claude-sonnet-4-6")
  const [sessionID, setSessionID] = useState("")
  const [chat, setChat] = useState<Chat[]>([])
  const [log, setLog] = useState("")

  const proxy = useRef<{ fetch: ProxyFetch }>()

  const ready = useMemo(() => !!api && !!proxy.current, [api])

  function note(input: string) {
    setLog((prev) => (prev + input).slice(-50_000))
  }

  function push(item: Omit<Chat, "id">) {
    setChat((prev) => prev.concat({ ...item, id: crypto.randomUUID() }))
  }

  async function boot() {
    if (booting || running) return
    setBooting(true)
    note("Booting WebContainer...\n")
    try {
      const next = await WebContainer.boot({
        workdirName: "workdir",
        coep: "credentialless",
      })
      next.internal.setCORSProxy({
        address: cors || "https://preview.bolt.host",
        domains: ["api.anthropic.com"],
      })
      next.on("server-ready", (port, url) => {
        note(`server-ready ${port} ${url}\n`)
        if (port === 5173) setPreview(url)
        if (port !== 4097) return
        void (async () => {
          const frame = document.createElement("iframe")
          frame.style.display = "none"
          frame.src = `${url}/proxy`
          document.body.appendChild(frame)
          await new Promise<void>((resolve) => {
            const handler = (event: MessageEvent) => {
              if (event.data?.type !== "ready") return
              window.removeEventListener("message", handler)
              resolve()
            }
            window.addEventListener("message", handler)
          })
          proxy.current = { fetch: createProxyFetch(frame) }
          setApi(url)
          note("proxy bridge ready\n")
        })()
      })

      await next.mount({
        project: { directory: site() },
        claude: { directory: service() },
      })

      setWc(next)
      note("Installing /project dependencies...\n")
      const projectInstall = await next.spawn("npm", ["install"], { cwd: project })
      await consume(projectInstall.output, note)
      const projectInstallCode = await projectInstall.exit
      if (projectInstallCode !== 0) throw new Error("project npm install failed")

      note("Installing /claude dependencies...\n")
      const claudeInstall = await next.spawn("npm", ["install"], { cwd: claude })
      await consume(claudeInstall.output, note)
      const claudeInstallCode = await claudeInstall.exit
      if (claudeInstallCode !== 0) throw new Error("claude npm install failed")

      note("Starting project dev server...\n")
      const projectDev = await next.spawn("npm", ["run", "dev"], { cwd: project })
      void consume(projectDev.output, note)

      note("Starting claude sdk server...\n")
      const claudeServer = await next.spawn("node", ["server.mjs"], {
        cwd: claude,
        env: {
          PORT: "4097",
          HOSTNAME: "0.0.0.0",
          CLAUDE_WORKDIR: project,
          CLAUDE_MODEL: model,
          ANTHROPIC_API_KEY: import.meta.env.VITE_ANTHROPIC_API_KEY ?? "",
        },
      })
      void consume(claudeServer.output, note)

      const nextFiles = await list(next, project)
      setFiles(nextFiles)
      const first = `${project}/index.html`
      setFile(first)
      setValue(await read(next, first))
      setRunning(true)
    } catch (error) {
      push({
        role: "error",
        text: error instanceof Error ? error.message : String(error),
      })
      note(`boot failed: ${error instanceof Error ? error.stack || error.message : String(error)}\n`)
    }
    setBooting(false)
  }

  async function save() {
    if (!wc || !file) return
    await write(wc, file, value)
    setDirty(false)
    setFiles(await list(wc, project))
  }

  async function pick(path: string) {
    if (!wc) return
    setFile(path)
    setValue(await read(wc, path))
    setDirty(false)
  }

  async function send() {
    if (!ready || !api || !proxy.current || !wc || sending) return
    const text = prompt.trim()
    if (!text) return
    setPrompt("")
    setSending(true)
    push({ role: "user", text })
    try {
      const url = new URL("/prompt", api)
      const res = await proxy.current.fetch(
        new Request(url.toString(), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            prompt: text,
            sessionID: sessionID || undefined,
            model,
          }),
        }),
      )
      await events(res, (event, data) => {
        if (event === "error") {
          const parsed = JSON.parse(data) as { message?: string; sessionID?: string }
          if (parsed.sessionID) setSessionID(parsed.sessionID)
          push({ role: "error", text: parsed.message ?? "unknown error" })
          return
        }
        if (event === "assistant") {
          const parsed = JSON.parse(data) as { text?: string; sessionID?: string }
          if (parsed.sessionID) setSessionID(parsed.sessionID)
          if (parsed.text) push({ role: "assistant", text: parsed.text })
          return
        }
        if (event === "done") {
          const parsed = JSON.parse(data) as { sessionID?: string }
          if (parsed.sessionID) setSessionID(parsed.sessionID)
          return
        }
        if (event !== "message") return
        const parsed = JSON.parse(data) as { type?: string; result?: string; session_id?: string }
        if (parsed.session_id) setSessionID(parsed.session_id)
        if (parsed.type === "result") {
          push({ role: "system", text: parsed.result ?? "Done" })
          return
        }
        const next = messageText(parsed)
        if (next) push({ role: "assistant", text: next })
      })
      const nextFiles = await list(wc, project)
      setFiles(nextFiles)
      if (file) {
        const next = await read(wc, file).catch(() => value)
        setValue(next)
      }
    } catch (error) {
      push({ role: "error", text: error instanceof Error ? error.message : String(error) })
    }
    setSending(false)
  }

  return (
    <div className="layout">
      <div className="panel">
        <div className="header">
          <div style={{ fontWeight: 600 }}>Files</div>
          <div className="small mono" style={{ marginLeft: "auto" }}>
            {file ? file.replace(project, "") : ""}
          </div>
        </div>
        <div className="body" style={{ overflow: "hidden" }}>
          <div style={{ height: "100%", display: "grid", gridTemplateRows: "240px 1fr" }}>
            <div style={{ overflow: "auto" }}>
              {files.map((item) => (
                <div
                  key={item.path}
                  className={"file" + (file === item.path ? " active" : "")}
                  onClick={() => void pick(item.path)}
                >
                  <span className="mono">{item.path.replace(project + "/", "")}</span>
                </div>
              ))}
            </div>
            <div style={{ overflow: "auto" }}>
              <CodeMirror
                value={value}
                height="100%"
                extensions={[javascript()]}
                theme="dark"
                onChange={(next) => {
                  setValue(next)
                  setDirty(true)
                }}
              />
            </div>
          </div>
        </div>
        <div className="footer">
          <button onClick={() => void save()} disabled={!dirty}>
            Save
          </button>
        </div>
      </div>

      <div className="panel">
        <div className="header">
          <div style={{ fontWeight: 600 }}>Claude Chat</div>
          <div className="small mono grow">session: {sessionID || "none"}</div>
          <button onClick={() => void boot()} disabled={booting || running}>
            {running ? "Running" : booting ? "Booting…" : "Start"}
          </button>
        </div>
        <div className="body chat">
          {chat.map((item) => (
            <div key={item.id} className={`msg ${item.role}`}>
              <div className="small mono">{item.role}</div>
              <div>{item.text}</div>
            </div>
          ))}
        </div>
        <div className="footer" style={{ display: "grid", gridTemplateColumns: "1fr 180px auto", gap: 8 }}>
          <input
            value={prompt}
            placeholder={ready ? "Ask Claude to edit /project..." : "Start the container first"}
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return
              void send()
            }}
            disabled={!ready || sending}
          />
          <input
            value={model}
            onChange={(event) => setModel(event.target.value)}
            disabled={sending}
            className="mono"
            title="Model"
          />
          <button onClick={() => void send()} disabled={!ready || sending}>
            {sending ? "Sending..." : "Send"}
          </button>
        </div>
      </div>

      <div className="panel">
        <div className="split">
          <div className="panel" style={{ borderRight: 0 }}>
            <div className="header">
              <div style={{ fontWeight: 600 }}>Preview</div>
              <div className="small mono" style={{ marginLeft: "auto" }}>
                {preview}
              </div>
            </div>
            <div className="body">
              {preview ? <iframe src={preview} /> : <div className="chat">No preview yet.</div>}
            </div>
          </div>
          <div className="panel" style={{ borderRight: 0 }}>
            <div className="header">
              <div style={{ fontWeight: 600 }}>Boot Output</div>
            </div>
            <div className="body">
              <pre className="log mono">{log}</pre>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
