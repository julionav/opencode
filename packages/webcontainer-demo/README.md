# OpenCode WebContainer Demo

This package is a Vite + React demo that boots a StackBlitz WebContainer and runs:

- a user Vite app at `/project` (port **5173** inside the container)
- an OpenCode backend at `/opencode` (port **4096** inside the container)

The demo starts the backend with `OPENCODE_PERMISSION='{"*":"allow"}'` so tool calls don’t block on interactive permission prompts.

## Run locally

From the repo root:

```bash
bun install
bun run --cwd packages/webcontainer-demo dev
```

The `dev` script will:

1. build the Node/WebContainer-compatible OpenCode server bundle (`opencode build:webcontainer`)
2. copy it into `packages/webcontainer-demo/public/opencode/` (ignored by git)
3. start the Vite dev server for this demo UI

