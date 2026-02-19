import { WebContainer } from "@webcontainer/api"
import { createOpencodeClient, type Message, type Part, type Session } from "@opencode-ai/sdk/client"
import CodeMirror from "@uiw/react-codemirror"
import { javascript } from "@codemirror/lang-javascript"
import React, { useEffect, useMemo, useRef, useState } from "react"
import { Terminal as Xterm } from "xterm"
import { FitAddon } from "xterm-addon-fit"
import "xterm/css/xterm.css"

type File = { path: string; name: string }
type Msg = { info: Message; parts: Part[] }

const project = "/project"
const opencode = "/opencode"

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

  const [key, setKey] = useState("")
  const [provider, setProvider] = useState<"openai" | "anthropic">("openai")

  const [input, setInput] = useState("")
  const [msgs, setMsgs] = useState<Msg[]>([])

  const termRef = useRef<HTMLDivElement>(null)
  const xterm = useRef<{ term: Xterm; fit: FitAddon }>()

  const client = useMemo(() => {
    if (!api) return
    return createOpencodeClient({
      baseUrl: api,
      directory: project,
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
    if (!termRef.current) return
    if (xterm.current) return
    const term = new Xterm({ convertEol: true, fontSize: 12 })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(termRef.current)
    fit.fit()
    xterm.current = { term, fit }
    const onResize = () => fit.fit()
    window.addEventListener("resize", onResize)
    return () => window.removeEventListener("resize", onResize)
  }, [])

  async function boot() {
    if (booting) return
    setBooting(true)

    const term = xterm.current?.term
    term?.writeln("Booting WebContainer…")

    const wc = await WebContainer.boot()
    setWc(wc)

    wc.on("server-ready", (port, url) => {
      term?.writeln(`server-ready: ${port} ${url}`)
      if (port === 5173) setPreview(url)
      if (port === 4096) setApi(url)
    })

    await mount(wc)

    const install = await wc.spawn("npm", ["install"], { cwd: project })
    void stream(term, install)
    await install.exit

    const vite = await wc.spawn("npm", ["run", "dev"], { cwd: project })
    void stream(term, vite)

    const op = await wc.spawn("node", ["server.mjs"], {
      cwd: opencode,
      env: {
        OPENCODE_RUNTIME: "webcontainer",
        PORT: "4096",
        HOSTNAME: "0.0.0.0",
      },
    })
    void stream(term, op)

    const shell = await wc.spawn("jsh", [], { cwd: project })
    term?.writeln("")
    term?.writeln("$ jsh")
    void attach(term, shell)

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

  async function auth() {
    if (!client) return
    if (!key.trim()) return
    const res = await client.auth.set({
      path: { id: provider },
      body: { type: "api", key },
    })
    unwrap(res)
  }

  async function ensure(): Promise<Session> {
    if (!client) throw new Error("opencode client is not ready")
    if (session) return session
    const res = await client.session.create({ body: {} })
    const next = unwrap(res)
    setSession(next)
    return next
  }

  async function refresh(id: string) {
    if (!client) return
    const list = await client.session.messages({ path: { id } })
    setMsgs(unwrap(list))
  }

  async function send() {
    if (!client) return
    const s = await ensure()
    const text = input.trim()
    if (!text) return
    setInput("")
    await client.session.prompt({
      path: { id: s.id },
      body: {
        agent: "build",
        parts: [{ type: "text", text }],
      },
    })
    await refresh(s.id)
  }

  useEffect(() => {
    if (!api || !wc) return
    const url = new URL("/event", api)
    url.searchParams.set("directory", project)
    const es = new EventSource(url.toString())
    es.onmessage = async (msg) => {
      const term = xterm.current?.term
      const event = JSON.parse(msg.data) as { type: string; properties: any }
      if (event.type !== "shell.exec.requested") return
      const { id, cwd, command } = event.properties as {
        id: string
        cwd: string
        command: string
        timeout: number
      }
      term?.writeln("")
      term?.writeln(`[opencode] bash: ${command}`)
      const proc = await wc.spawn("jsh", ["-c", command], { cwd })
      const output = await collect(proc)
      const resUrl = new URL(`/experimental/shell/exec/${id}`, api)
      resUrl.searchParams.set("directory", project)
      await fetch(resUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ exitCode: output.code, output: output.text }),
      })
    }
    return () => es.close()
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
        <div className="header">
          <div className="row" style={{ width: "100%" }}>
            <select value={provider} onChange={(e) => setProvider(e.target.value as any)}>
              <option value="openai">openai</option>
              <option value="anthropic">anthropic</option>
            </select>
            <input
              placeholder="API key (stored in container)"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              style={{ flex: 1, background: "#0f172a", color: "#e6e6e6", border: "1px solid #1a2233", borderRadius: 8 }}
            />
            <button onClick={() => void auth()}>Set</button>
          </div>
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
            <div className="body">{preview ? <iframe src={preview} /> : <div className="chat">No preview yet.</div>}</div>
          </div>
          <div className="panel" style={{ borderRight: 0 }}>
            <div className="header">
              <div style={{ fontWeight: 600 }}>Terminal</div>
            </div>
            <div className="body" ref={termRef} style={{ background: "#000" }} />
          </div>
        </div>
      </div>
    </div>
  )
}

async function stream(term: Xterm | undefined, proc: { output: ReadableStream<string>; exit: Promise<number> }) {
  const reader = proc.output.getReader()
  while (true) {
    const r = await reader.read()
    if (r.done) break
    term?.write(r.value)
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

async function attach(term: Xterm | undefined, proc: { output: ReadableStream<string>; input: WritableStream<string> }) {
  const reader = proc.output.getReader()
  const writer = proc.input.getWriter()
  term?.onData((data) => void writer.write(data))
  while (true) {
    const r = await reader.read()
    if (r.done) break
    term?.write(r.value)
  }
}

