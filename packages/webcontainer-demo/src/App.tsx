import { configureAPIKey, WebContainer } from "@webcontainer/api"
import { createOpencodeClient, type Message, type Part, type Session } from "@opencode-ai/sdk/client"
import CodeMirror from "@uiw/react-codemirror"
import { javascript } from "@codemirror/lang-javascript"
import React, { useEffect, useMemo, useRef, useState } from "react"
import { Terminal as Xterm } from "xterm"
import { FitAddon } from "xterm-addon-fit"
import "xterm/css/xterm.css"

type File = { path: string; name: string }
type Msg = { info: Message; parts: Part[] }

const DEBUG_ENDPOINT = "http://127.0.0.1:7289/ingest/2e4da3b2-be54-4177-829b-bb666cdd5fb8"
const DEBUG_SESSION_ID = "3cdfc3"
const DEBUG_RUN_ID = "tunnel-2"

function dbg(input: { hypothesisId: string; location: string; message: string; data?: Record<string, unknown> }) {
  // #region agent log
  fetch(DEBUG_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Debug-Session-Id": DEBUG_SESSION_ID,
    },
    body: JSON.stringify({
      sessionId: DEBUG_SESSION_ID,
      runId: DEBUG_RUN_ID,
      hypothesisId: input.hypothesisId,
      location: input.location,
      message: input.message,
      data: input.data ?? {},
      timestamp: Date.now(),
    }),
  }).catch(() => {})
  // #endregion agent log
}

configureAPIKey("")
const project = "/project"
const opencode = "/opencode"
const cors = (() => {
  try {
    const url = new URL(window.location.href)
    return url.searchParams.get("cors") ?? ""
  } catch {
    return ""
  }
})()

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
    <title>Hello</title>
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
            contents: `const el = document.querySelector('#app')
el.innerHTML = '<h1>Hello world</h1><p>Edited by OpenCode</p>'`,
          },
        },
      },
    },
  } as const
}

async function list(wc: WebContainer, dir: string): Promise<File[]> {
  const entries = await wc.fs.readdir(dir, { withFileTypes: true })
  const next = await Promise.all(
    entries.map(async (entry) => {
      const name = entry.name
      if (name === "node_modules") return
      const p = `${dir}/${name}`.replaceAll("//", "/")
      if (entry.isDirectory()) {
        return list(wc, p)
      }
      if (entry.isFile()) {
        return [{ path: p, name }]
      }
    }),
  )
  return next.flat().filter(Boolean).flat() as File[]
}

async function read(wc: WebContainer, p: string) {
  return (await wc.fs.readFile(p, "utf-8")) as string
}

async function write(wc: WebContainer, p: string, text: string) {
  await wc.fs.writeFile(p, text)
}

async function files() {
  const res = await fetch("/opencode/manifest.json")
  if (!res.ok) throw new Error("Missing /public/opencode (run bun run setup)")
  const json = (await res.json()) as { files: string[] }
  return json.files
}

async function mount(wc: WebContainer) {
  const manifest = await files()

  const entries = await Promise.all(
    manifest.map(async (name) => {
      const res = await fetch(`/opencode/${name}`)
      if (!res.ok) throw new Error(`Failed to fetch /opencode/${name}`)
      if (name.endsWith(".wasm")) return [name, new Uint8Array(await res.arrayBuffer())] as const
      return [name, await res.text()] as const
    }),
  )

  const dir: Record<string, any> = {}
  for (const [name, contents] of entries) {
    dir[name] = {
      file: {
        contents,
      },
    }
  }

  await wc.mount({
    project: { directory: site() as any },
    opencode: { directory: dir as any },
  } as any)
}

type Pending = {
  resolve: (response: Response) => void
  reject: (error: Error) => void
  controller?: ReadableStreamDefaultController<Uint8Array>
  path?: string
  bytes?: number
  chunks?: number
  sample?: Uint8Array[]
}

type ProxyFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

function concat(chunks: Uint8Array[]) {
  const size = chunks.reduce((n, x) => n + x.byteLength, 0)
  const out = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

function createProxyFetch(iframe: HTMLIFrameElement): ProxyFetch {
  const pending = new Map<string, Pending>()

  window.addEventListener("message", (e) => {
    const data = e.data
    if (!data?.id) return
    const entry = pending.get(data.id)
    if (!entry) return

    if (data.type === "start") {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          entry.controller = controller
        },
      })
      entry.bytes = 0
      entry.chunks = 0
      entry.sample = entry.path?.includes("/message") ? [] : undefined
      if (entry.path === "/session") {
        dbg({
          hypothesisId: "H3",
          location: "packages/webcontainer-demo/src/App.tsx:createProxyFetch",
          message: "proxyFetch start",
          data: { path: entry.path, status: data.status },
        })
      }
      entry.resolve(new Response(stream, { status: data.status, headers: data.headers }))
    } else if (data.type === "chunk") {
      const u8 = data.chunk instanceof Uint8Array ? data.chunk : new Uint8Array(data.chunk)
      entry.bytes = (entry.bytes ?? 0) + u8.byteLength
      entry.chunks = (entry.chunks ?? 0) + 1
      if (entry.sample) {
        const total = entry.sample.reduce((n, x) => n + x.byteLength, 0)
        if (total < 64 * 1024) entry.sample.push(new Uint8Array(u8))
      }
      entry.controller?.enqueue(u8)
    } else if (data.type === "end") {
      entry.controller?.close()
      if (entry.path === "/session") {
        dbg({
          hypothesisId: "H3",
          location: "packages/webcontainer-demo/src/App.tsx:createProxyFetch",
          message: "proxyFetch end",
          data: { path: entry.path },
        })
      }
      if (entry.path?.includes("/message")) {
        try {
          const bytes = entry.sample ? concat(entry.sample) : undefined
          const sample = bytes ? new TextDecoder().decode(bytes) : ""
          JSON.parse(sample)
          dbg({
            hypothesisId: "H5",
            location: "packages/webcontainer-demo/src/App.tsx:createProxyFetch",
            message: "proxyFetch message JSON ok",
            data: { path: entry.path, bytes: entry.bytes, chunks: entry.chunks, sampleLen: sample.length },
          })
        } catch (e) {
          dbg({
            hypothesisId: "H5",
            location: "packages/webcontainer-demo/src/App.tsx:createProxyFetch",
            message: "proxyFetch message JSON parse failed",
            data: {
              path: entry.path,
              bytes: entry.bytes,
              chunks: entry.chunks,
              error: e instanceof Error ? e.message : String(e),
            },
          })
        }
      }
      pending.delete(data.id)
    } else if (data.type === "error") {
      const err = new Error(data.message)
      dbg({
        hypothesisId: "H3",
        location: "packages/webcontainer-demo/src/App.tsx:createProxyFetch",
        message: "proxyFetch error",
        data: { path: entry.path, error: err.message },
      })
      if (entry.controller) {
        try {
          entry.controller.error(err)
        } catch {}
      } else {
        entry.reject(err)
      }
      pending.delete(data.id)
    }
  })

  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = input instanceof Request ? input : new Request(input, init)
    const url = new URL(req.url)
    const body = req.body ? await new Response(req.body).text() : null
    const id = crypto.randomUUID()
    const headers: Record<string, string> = {}
    req.headers.forEach((v, k) => {
      headers[k] = v
    })

    if (url.pathname === "/session" || url.pathname === "/event" || url.pathname.startsWith("/session/")) {
      dbg({
        hypothesisId: "H1",
        location: "packages/webcontainer-demo/src/App.tsx:createProxyFetch",
        message: "proxyFetch request",
        data: {
          method: req.method,
          path: url.pathname,
          hasDirectoryHeader: typeof headers["x-opencode-directory"] === "string",
          directoryHeader: headers["x-opencode-directory"],
          hasQueryDirectory: url.searchParams.has("directory"),
        },
      })
    }

    return new Promise<Response>((resolve, reject) => {
      const entry: Pending = { resolve, reject, path: url.pathname }
      pending.set(id, entry)

      req.signal?.addEventListener(
        "abort",
        () => {
          const e = pending.get(id)
          if (!e) return
          pending.delete(id)
          const err = new DOMException("The operation was aborted", "AbortError")
          if (e.controller) {
            try {
              e.controller.error(err)
            } catch {}
          } else {
            e.reject(err)
          }
        },
        { once: true },
      )

      iframe.contentWindow!.postMessage({ id, method: req.method, path: url.pathname + url.search, headers, body }, "*")
    })
  }
}

export function App() {
  const [booting, setBooting] = useState(false)
  const [wc, setWc] = useState<WebContainer>()
  const [preview, setPreview] = useState<string>()
  const [api, setApi] = useState<string>()
  const [session, setSession] = useState<Session>()

  const [files, setFiles] = useState<File[]>([])
  const [file, setFile] = useState<string>()
  const [text, setText] = useState<string>("")
  const [dirty, setDirty] = useState(false)

  const [input, setInput] = useState("")
  const [msgs, setMsgs] = useState<Msg[]>([])

  const [activeTerm, setActiveTerm] = useState<"output" | "project">("project")
  const outputRef = useRef<HTMLDivElement>(null)
  const projectRef = useRef<HTMLDivElement>(null)
  const terms = useRef<{
    output: { term: Xterm; fit: FitAddon }
    project: { term: Xterm; fit: FitAddon }
  }>()
  const proxyRef = useRef<{ fetch: ProxyFetch }>()

  const client = useMemo(() => {
    if (!api || !proxyRef.current) return
    return createOpencodeClient({
      baseUrl: api,
      directory: project,
      fetch: proxyRef.current.fetch,
    })
  }, [api])

  function unwrap<T>(res: { data?: T; error?: unknown }) {
    if (res.error) {
      const msg = typeof res.error === "object" ? JSON.stringify(res.error) : String(res.error)
      throw new Error(msg)
    }
    if (!res.data) throw new Error("Missing response data")
    return res.data
  }

  useEffect(() => {
    if (!outputRef.current || !projectRef.current) return
    if (terms.current) return
    const opts = { convertEol: true, fontSize: 12 }
    const output = new Xterm(opts)
    const outputFit = new FitAddon()
    output.loadAddon(outputFit)
    output.open(outputRef.current)
    outputFit.fit()
    const project = new Xterm(opts)
    const projectFit = new FitAddon()
    project.loadAddon(projectFit)
    project.open(projectRef.current)
    projectFit.fit()
    terms.current = { output: { term: output, fit: outputFit }, project: { term: project, fit: projectFit } }
    const onResize = () => {
      terms.current?.output.fit.fit()
      terms.current?.project.fit.fit()
    }
    window.addEventListener("resize", onResize)
    return () => window.removeEventListener("resize", onResize)
  }, [])

  useEffect(() => {
    terms.current?.output.fit.fit()
    terms.current?.project.fit.fit()
  }, [activeTerm])

  async function boot() {
    if (booting) return
    setBooting(true)

    const outputTerm = terms.current?.output.term
    const projectTerm = terms.current?.project.term
    outputTerm?.writeln("Booting WebContainer…")

    const wc = await WebContainer.boot({
      workdirName: "workdir",
      coep: "credentialless",
    })

    wc.internal.setCORSProxy({
      // Must be a publicly reachable URL (tunnel). Public origins cannot reach localhost due to PNA.
      address: cors || "https://preview.bolt.host",
      domains: ["api.anthropic.com"],
    })
    dbg({
      hypothesisId: "H6",
      location: "packages/webcontainer-demo/src/App.tsx:boot",
      message: "setCORSProxy configured",
      data: { address: cors || "https://preview.bolt.host", domains: ["api.anthropic.com"] },
    })

    setWc(wc)

    wc.on("server-ready", (port, url) => {
      console.log("server-ready", port, url)
      outputTerm?.writeln(`server-ready: ${port} ${url}`)
      if (port === 5173) setPreview(url)
      if (port === 4096) {
        void (async () => {
          const iframe = document.createElement("iframe")
          iframe.style.display = "none"
          iframe.src = `${url}/proxy`
          document.body.appendChild(iframe)

          await new Promise<void>((resolve) => {
            const handler = (e: MessageEvent) => {
              if (e.data?.type === "ready") {
                window.removeEventListener("message", handler)
                resolve()
              }
            }
            window.addEventListener("message", handler)
          })

          outputTerm?.writeln("proxy bridge ready")
          proxyRef.current = { fetch: createProxyFetch(iframe) }
          setApi(url)
        })()
      }
    })

    await mount(wc)

    const install = await wc.spawn("npm", ["install"], { cwd: project })
    void stream(outputTerm, install)
    await install.exit

    const vite = await wc.spawn("npm", ["run", "dev"], { cwd: project })
    void stream(outputTerm, vite)

    const op = await wc.spawn("node", ["server.mjs"], {
      cwd: opencode,
      env: {
        OPENCODE_RUNTIME: "webcontainer",
        PORT: "4096",
        HOSTNAME: "0.0.0.0",
        // Inline permission config (Config.Permission shape), not PermissionNext.Ruleset.
        OPENCODE_PERMISSION: JSON.stringify({ "*": "allow" }),
        // Force Anthropic SDK to call our proxy directly (avoid CORS/PNA; don't rely on setCORSProxy).
        OPENCODE_ANTHROPIC_BASE_URL: "https://proxy.bonemma.org/v1",
        ANTHROPIC_API_KEY: import.meta.env.VITE_ANTHROPIC_API_KEY ?? "",
      },
    })
    void stream(outputTerm, op)

    const shell = await wc.spawn("jsh", [], { cwd: project })
    projectTerm?.writeln("")
    projectTerm?.writeln(`$ jsh (${project})`)
    void attach(projectTerm, shell)

    setFiles(await list(wc, project))
    setFile(`${project}/index.html`)
    setText(await read(wc, `${project}/index.html`))

    setBooting(false)
  }

  async function save() {
    if (!wc || !file) return
    await write(wc, file, text)
    setDirty(false)
    setFiles(await list(wc, project))
  }

  async function pick(p: string) {
    if (!wc) return
    setFile(p)
    setText(await read(wc, p))
    setDirty(false)
  }

  async function ensure(): Promise<Session> {
    if (!client) throw new Error("opencode client is not ready")
    if (session) return session
    try {
      dbg({
        hypothesisId: "H3",
        location: "packages/webcontainer-demo/src/App.tsx:ensure",
        message: "session.create start",
        data: { hasClient: true, hasApi: !!api },
      })
      const res = await client.session.create({ body: {} })
      const next = unwrap(res)
      setSession(next)
      dbg({
        hypothesisId: "H3",
        location: "packages/webcontainer-demo/src/App.tsx:ensure",
        message: "session.create success",
        data: { sessionID: next.id },
      })
      return next
    } catch (e) {
      dbg({
        hypothesisId: "H3",
        location: "packages/webcontainer-demo/src/App.tsx:ensure",
        message: "session.create failed",
        data: { error: e instanceof Error ? e.message : String(e) },
      })
      throw e
    }
  }

  async function refresh(id: string) {
    if (!client) return
    const list = await client.session.messages({ path: { id } })
    setMsgs(unwrap(list))
  }

  async function send() {
    if (!client) return
    const text = input.trim()
    if (!text) return
    setInput("")
    try {
      const s = await ensure()
      dbg({
        hypothesisId: "H4",
        location: "packages/webcontainer-demo/src/App.tsx:send",
        message: "session.prompt start",
        data: { sessionID: s.id, textLen: text.length },
      })
      // Keep in sync with what's actually present in the bundled models list.
      const model = { providerID: "anthropic", modelID: "claude-haiku-4-5-20251001" }
      await client.session.prompt({
        path: { id: s.id },
        body: {
          agent: "build",
          parts: [{ type: "text", text }],
          model,
        },
      })
      await refresh(s.id)
      dbg({
        hypothesisId: "H4",
        location: "packages/webcontainer-demo/src/App.tsx:send",
        message: "session.prompt success",
        data: { sessionID: s.id },
      })
    } catch (e) {
      dbg({
        hypothesisId: "H4",
        location: "packages/webcontainer-demo/src/App.tsx:send",
        message: "session.prompt failed",
        data: { error: e instanceof Error ? e.message : String(e) },
      })
      throw e
    }
  }

  useEffect(() => {
    if (!api || !wc || !proxyRef.current) return
    const abort = new AbortController()
    const pfetch = proxyRef.current.fetch

    void (async () => {
      try {
        const url = new URL("/event", api)
        url.searchParams.set("directory", project)
        const res = await pfetch(new Request(url.toString(), { signal: abort.signal }))
        const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader()
        let buffer = ""

        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += value
          const parts = buffer.split("\n\n")
          buffer = parts.pop() ?? ""

          for (const part of parts) {
            let data = ""
            for (const line of part.split("\n")) {
              if (line.startsWith("data:")) data += line.replace(/^data:\s?/, "")
            }
            if (!data) continue

            const event = JSON.parse(data) as { type: string; properties: any }
            if (event.type !== "shell.exec.requested") continue
            const { id, cwd, command } = event.properties as {
              id: string
              cwd: string
              command: string
              timeout: number
            }
            const term = terms.current?.project.term
            term?.writeln("")
            term?.writeln(`[opencode] bash: ${command}`)
            console.log("command", command, cwd)
            const actualCwd = cwd.replace("/home/workdir/project", project)
            const proc = await wc.spawn("jsh", ["-c", command], { cwd: actualCwd })
            const output = await collect(proc)
            console.log("output", output)
            const resUrl = new URL(`/experimental/shell/exec/${id}`, api)
            resUrl.searchParams.set("directory", project)
            await pfetch(
              new Request(resUrl.toString(), {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ exitCode: output.code, output: output.text }),
              }),
            )
          }
        }
      } catch {
        // stream aborted or closed
      }
    })()

    return () => abort.abort()
  }, [api, wc])

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
          <div style={{ height: "100%", display: "grid", gridTemplateRows: "260px 1fr" }}>
            <div style={{ overflow: "auto" }}>
              {files.map((f) => (
                <div
                  key={f.path}
                  className={"file" + (file === f.path ? " active" : "")}
                  onClick={() => void pick(f.path)}
                >
                  <span className="mono">{f.path.replace(project + "/", "")}</span>
                </div>
              ))}
            </div>
            <div style={{ overflow: "auto" }}>
              <CodeMirror
                value={text}
                height="100%"
                extensions={[javascript()]}
                theme="dark"
                onChange={(v) => {
                  setText(v)
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
          <div style={{ fontWeight: 600 }}>Chat</div>
          <button onClick={() => void boot()} disabled={booting || !!wc} style={{ marginLeft: "auto" }}>
            {wc ? "Running" : booting ? "Booting…" : "Start"}
          </button>
        </div>
        <div className="body chat">
          {msgs.map((m) => {
            const role = m.info.role
            const text = m.parts
              .filter((p) => p.type === "text")
              .map((p) => p.text)
              .join("\n")
            return (
              <div key={m.info.id} className={"msg " + role}>
                <div className="small mono">{role}</div>
                <div>{text}</div>
              </div>
            )
          })}
        </div>
        <div className="footer">
          <input
            value={input}
            placeholder={client ? "Ask OpenCode to change the app…" : "Waiting for opencode server…"}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return
              void send()
            }}
            disabled={!client}
          />
          <button onClick={() => void send()} disabled={!client}>
            Send
          </button>
        </div>
      </div>

      <div className="panel">
        <div className="split">
          <div className="panel" style={{ borderRight: 0 }}>
            <div className="header">
              <div style={{ fontWeight: 600 }}>Preview</div>
              <div className="small mono" style={{ marginLeft: "auto" }}>
                {preview ?? ""}
              </div>
            </div>
            <div className="body">
              {preview ? <iframe src={preview} /> : <div className="chat">No preview yet.</div>}
            </div>
          </div>
          <div className="panel" style={{ borderRight: 0 }}>
            <div className="header">
              <div style={{ fontWeight: 600 }}>Terminal</div>
              <div className="term-tabs" style={{ display: "flex", gap: 4, marginLeft: "auto" }}>
                <button
                  className={activeTerm === "output" ? "active" : ""}
                  onClick={() => setActiveTerm("output")}
                  style={{ padding: "2px 8px", fontSize: 11 }}
                >
                  Output
                </button>
                <button
                  className={activeTerm === "project" ? "active" : ""}
                  onClick={() => setActiveTerm("project")}
                  style={{ padding: "2px 8px", fontSize: 11 }}
                >
                  Project
                </button>
              </div>
            </div>
            <div className="body" style={{ background: "#000", position: "relative", overflow: "hidden" }}>
              <div
                ref={outputRef}
                style={{
                  position: "absolute",
                  inset: 0,
                  display: activeTerm === "output" ? "block" : "none",
                }}
              />
              <div
                ref={projectRef}
                style={{
                  position: "absolute",
                  inset: 0,
                  display: activeTerm === "project" ? "block" : "none",
                }}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

async function stream(term: Xterm | undefined, proc: { output: ReadableStream<string>; exit: Promise<number> }) {
  const reader = proc.output.getReader()
  let buffer = ""
  while (true) {
    const r = await reader.read()
    if (r.done) break
    term?.write(r.value)
    buffer += r.value
    const parts = buffer.split("\n")
    buffer = parts.pop() ?? ""
    for (const line of parts) {
      const msg = line.trim()
      if (!msg) continue
      const interesting =
        msg.includes("[dbg 3cdfc3]") ||
        msg.includes("ProviderModelNotFoundError") ||
        msg.includes("api.anthropic.com") ||
        (msg.includes("service=llm") && (msg.includes("error=") || msg.includes("stream"))) ||
        (msg.includes("service=webcontainer.server") &&
          (msg.includes("path=/session") ||
            msg.includes("No context found for instance") ||
            msg.includes("directory!!!!")))
      if (!interesting) continue
      dbg({
        hypothesisId: "H2",
        location: "packages/webcontainer-demo/src/App.tsx:stream",
        message: "wc.proc line",
        data: { line: msg.slice(0, 400) },
      })
    }
  }
}

async function collect(proc: { output: ReadableStream<string>; exit: Promise<number> }) {
  const reader = proc.output.getReader()
  let text = ""
  while (true) {
    const r = await reader.read()
    if (r.done) break
    text += r.value
  }
  const code = await proc.exit
  return { text, code }
}

async function attach(
  term: Xterm | undefined,
  proc: { output: ReadableStream<string>; input: WritableStream<string> },
) {
  const reader = proc.output.getReader()
  const writer = proc.input.getWriter()
  term?.onData((data) => void writer.write(data))
  while (true) {
    const r = await reader.read()
    if (r.done) break
    term?.write(r.value)
  }
}
