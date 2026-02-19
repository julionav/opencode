- To regenerate the JavaScript SDK, run `./packages/sdk/js/script/build.ts`.
- ALWAYS USE PARALLEL TOOLS WHEN APPLICABLE.
- The default branch in this repo is `dev`.
- Local `main` ref may not exist; use `dev` or `origin/dev` for diffs.
- Prefer automation: execute requested actions without confirmation unless blocked by missing info or safety/irreversibility.

## Style Guide

### General Principles

- Keep things in one function unless composable or reusable
- Avoid `try`/`catch` where possible
- Avoid using the `any` type
- Prefer single word variable names where possible
- Use Bun APIs when possible, like `Bun.file()`
- Rely on type inference when possible; avoid explicit type annotations or interfaces unless necessary for exports or clarity
- Prefer functional array methods (flatMap, filter, map) over for loops; use type guards on filter to maintain type inference downstream

### Naming

Prefer single word names for variables and functions. Only use multiple words if necessary.

```ts
// Good
const foo = 1
function journal(dir: string) {}

// Bad
const fooBar = 1
function prepareJournal(dir: string) {}
```

Reduce total variable count by inlining when a value is only used once.

```ts
// Good
const journal = await Bun.file(path.join(dir, "journal.json")).json()

// Bad
const journalPath = path.join(dir, "journal.json")
const journal = await Bun.file(journalPath).json()
```

### Destructuring

Avoid unnecessary destructuring. Use dot notation to preserve context.

```ts
// Good
obj.a
obj.b

// Bad
const { a, b } = obj
```

### Variables

Prefer `const` over `let`. Use ternaries or early returns instead of reassignment.

```ts
// Good
const foo = condition ? 1 : 2

// Bad
let foo
if (condition) foo = 1
else foo = 2
```

### Control Flow

Avoid `else` statements. Prefer early returns.

```ts
// Good
function foo() {
  if (condition) return 1
  return 2
}

// Bad
function foo() {
  if (condition) return 1
  else return 2
}
```

### Schema Definitions (Drizzle)

Use snake_case for field names so column names don't need to be redefined as strings.

```ts
// Good
const table = sqliteTable("session", {
  id: text().primaryKey(),
  project_id: text().notNull(),
  created_at: integer().notNull(),
})

// Bad
const table = sqliteTable("session", {
  id: text("id").primaryKey(),
  projectID: text("project_id").notNull(),
  createdAt: integer("created_at").notNull(),
})
```

## Testing

- Avoid mocks as much as possible
- Test actual implementation, do not duplicate logic into tests
- Tests cannot run from repo root (guard: `do-not-run-tests-from-root`); run from package dirs like `packages/opencode`.

## Cloud-specific instructions

### Services overview

| Service | Start command | Port | Notes |
|---------|--------------|------|-------|
| Backend API | `bun run --conditions=browser ./src/index.ts serve --port 4096` (from `packages/opencode`) | 4096 | Headless API server; uses embedded SQLite — no external DB needed |
| Web UI | `bun dev -- --port 4444` (from `packages/app`) | 4444 | Vite dev server; proxies API calls to `localhost:4096` |

### Running services

- Start the backend **before** the web UI — the frontend connects to `localhost:4096`.
- On first backend start, an automatic SQLite migration runs; subsequent starts are instant.
- Without `OPENCODE_SERVER_PASSWORD` the server runs unsecured (fine for local dev).
- AI chat requires at least one LLM provider API key (e.g. `ANTHROPIC_API_KEY`). The UI and API are fully functional without one — only message generation fails.

### Lint / typecheck / test

- Typecheck all packages: `bun typecheck` (runs `turbo typecheck`).
- Format check: `bun prettier --check "packages/opencode/src/**/*.ts"`.
- Unit tests: `cd packages/opencode && bun test` (1107 tests).
- App unit tests: `cd packages/app && bun test`.
- Pre-push hook (`bun typecheck`) validates Bun version matches `package.json#packageManager`.

### Gotchas

- `bun dev` (from repo root) starts the **TUI** which requires a real terminal — use `bun run --conditions=browser ./src/index.ts serve` for headless/API mode in cloud environments.
- The `packages/app` AGENTS.md notes: **never restart the backend server**; it handles hot-reload itself.
- See `packages/app/AGENTS.md` and `packages/opencode/AGENTS.md` for package-specific guidance.
