# Claude Agent SDK WebContainer Demo

This package is a Vite + React demo that boots a StackBlitz WebContainer and runs:

- a user Vite app at `/project` (port **5173** inside the container)
- a tiny Claude server at `/claude` (port **4097** inside the container)

The Claude server uses `@anthropic-ai/claude-agent-sdk` and exposes HTTP + SSE endpoints for prompting Claude.  
The browser talks to that server through an iframe proxy fetch bridge (`/proxy`), so agent communication is not done through host stdin/stdout.

## Run locally

From the repo root:

```bash
bun install
bun run --cwd packages/webcontainer-claude-demo dev
```

## Environment

Copy `.env.example` to `.env` and provide:

- `VITE_ANTHROPIC_API_KEY`

Optional:

- `VITE_CLAUDE_MODEL` (default model shown in the UI)
- `VITE_CORS_PROXY` (override CORS proxy origin)

You can also override the CORS proxy at runtime with `?cors=https://your-tunnel.example` in the page URL.

## Notes

- The first boot installs dependencies inside the WebContainer and can take a while.
- Claude model availability depends on your Anthropic account.
- The in-container server runs with SDK permission bypass mode for demo convenience.
