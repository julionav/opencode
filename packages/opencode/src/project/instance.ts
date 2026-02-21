import { Log } from "@/util/log"
import { Context } from "../util/context"
import { Project } from "./project"
import { State } from "./state"
import { iife } from "@/util/iife"
import { GlobalBus } from "@/bus/global"
import { Filesystem } from "@/util/filesystem"
import { Runtime } from "@/runtime"

interface Context {
  directory: string
  worktree: string
  project: Project.Info
}
const context = Context.create<Context>("instance")
const cache = new Map<string, Promise<Context>>()
const fallback = globalThis as unknown as { __OPENCODE_INSTANCE_FALLBACK?: Context }

const disposal = {
  all: undefined as Promise<void> | undefined,
}

export const Instance = {
  async provide<R>(input: { directory: string; init?: () => Promise<any>; fn: () => R }): Promise<R> {
    let existing = cache.get(input.directory)
    if (!existing) {
      Log.Default.info("creating instance", { directory: input.directory })
      existing = iife(async () => {
        const { project, sandbox } = await Project.fromDirectory(input.directory)
        const ctx = {
          directory: input.directory,
          worktree: sandbox,
          project,
        }
        // WebContainer's AsyncLocalStorage propagation can be unreliable across
        // framework middleware boundaries. Keep a best-effort fallback context
        // (single-instance demo mode) so handlers can still resolve Instance.*.
        if (Runtime.mode() === "webcontainer") fallback.__OPENCODE_INSTANCE_FALLBACK = ctx
        await context.provide(ctx, async () => {
          await input.init?.()
        })
        return ctx
      })
      cache.set(input.directory, existing)
    }
    const ctx = await existing
    // Important: `await` the downstream work so AsyncLocalStorage
    // correctly propagates in runtimes with weaker async_hooks support (e.g. WebContainer).
    return context.provide(ctx, async () => {
      return await input.fn()
    })
  },
  get directory() {
    try {
      return context.use().directory
    } catch (e) {
      if (Runtime.mode() === "webcontainer" && fallback.__OPENCODE_INSTANCE_FALLBACK)
        return fallback.__OPENCODE_INSTANCE_FALLBACK.directory
      throw e
    }
  },
  get worktree() {
    try {
      return context.use().worktree
    } catch (e) {
      if (Runtime.mode() === "webcontainer" && fallback.__OPENCODE_INSTANCE_FALLBACK)
        return fallback.__OPENCODE_INSTANCE_FALLBACK.worktree
      throw e
    }
  },
  get project() {
    try {
      return context.use().project
    } catch (e) {
      if (Runtime.mode() === "webcontainer" && fallback.__OPENCODE_INSTANCE_FALLBACK)
        return fallback.__OPENCODE_INSTANCE_FALLBACK.project
      throw e
    }
  },
  /**
   * Check if a path is within the project boundary.
   * Returns true if path is inside Instance.directory OR Instance.worktree.
   * Paths within the worktree but outside the working directory should not trigger external_directory permission.
   */
  containsPath(filepath: string) {
    if (Filesystem.contains(Instance.directory, filepath)) return true
    // Non-git projects set worktree to "/" which would match ANY absolute path.
    // Skip worktree check in this case to preserve external_directory permissions.
    if (Instance.worktree === "/") return false
    return Filesystem.contains(Instance.worktree, filepath)
  },
  state<S>(init: () => S, dispose?: (state: Awaited<S>) => Promise<void>): () => S {
    return State.create(() => Instance.directory, init, dispose)
  },
  async dispose() {
    Log.Default.info("disposing instance", { directory: Instance.directory })
    await State.dispose(Instance.directory)
    cache.delete(Instance.directory)
    GlobalBus.emit("event", {
      directory: Instance.directory,
      payload: {
        type: "server.instance.disposed",
        properties: {
          directory: Instance.directory,
        },
      },
    })
  },
  async disposeAll() {
    if (disposal.all) return disposal.all

    disposal.all = iife(async () => {
      Log.Default.info("disposing all instances")
      const entries = [...cache.entries()]
      for (const [key, value] of entries) {
        if (cache.get(key) !== value) continue

        const ctx = await value.catch((error) => {
          Log.Default.warn("instance dispose failed", { key, error })
          return undefined
        })

        if (!ctx) {
          if (cache.get(key) === value) cache.delete(key)
          continue
        }

        if (cache.get(key) !== value) continue

        await context.provide(ctx, async () => {
          await Instance.dispose()
        })
      }
    }).finally(() => {
      disposal.all = undefined
    })

    return disposal.all
  },
}
