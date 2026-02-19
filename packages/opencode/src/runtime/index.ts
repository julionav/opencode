import fg from "fast-glob"
import fs from "node:fs/promises"
import { accessSync, constants } from "node:fs"
import os from "node:os"
import path from "node:path"

type BunLike = {
  which?: (cmd: string) => string | undefined
  sleep?: (ms: number) => Promise<void>
}

const bun = (globalThis as unknown as { Bun?: BunLike }).Bun

export namespace Runtime {
  export type Mode = "bun" | "node" | "webcontainer"

  export function mode(): Mode {
    if (typeof process.versions.bun === "string") return "bun"
    if (process.env.OPENCODE_RUNTIME === "webcontainer") return "webcontainer"
    return "node"
  }

  export function assertWebContainerMode() {
    if (mode() === "webcontainer") return
    throw new Error(`Expected OPENCODE_RUNTIME=webcontainer (got ${mode()})`)
  }

  export async function sleep(ms: number) {
    if (bun?.sleep) return bun.sleep(ms)
    await new Promise<void>((resolve) => setTimeout(resolve, ms))
  }

  export function which(cmd: string): string | undefined {
    if (bun?.which) return bun.which(cmd)

    const env = process.env.PATH ?? ""
    const dirs = env.split(path.delimiter).filter(Boolean)

    const exts =
      process.platform === "win32"
        ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM")
            .split(";")
            .filter(Boolean)
            .map((x) => x.toLowerCase())
        : [""]

    const hasExt = process.platform === "win32" && !!path.extname(cmd)
    const names = hasExt ? [cmd] : exts.map((ext) => cmd + ext)

    for (const dir of dirs) {
      for (const name of names) {
        const p = path.join(dir, name)
        try {
          accessSync(p, constants.X_OK)
          return p
        } catch {
          // continue
        }
      }
    }

    return
  }

  export async function readText(p: string) {
    return fs.readFile(p, "utf-8")
  }

  export async function writeText(p: string, text: string) {
    await fs.mkdir(path.dirname(p), { recursive: true })
    await fs.writeFile(p, text)
  }

  export async function realpath(p: string) {
    return fs.realpath(p).catch(() => p)
  }

  export function home() {
    return process.env.OPENCODE_TEST_HOME || os.homedir()
  }

  export type GlobOptions = {
    cwd?: string
    absolute?: boolean
    onlyFiles?: boolean
    onlyDirectories?: boolean
    dot?: boolean
    followSymlinks?: boolean
  }

  export async function glob(pattern: string | string[], opts?: GlobOptions) {
    return fg(pattern, {
      cwd: opts?.cwd,
      absolute: opts?.absolute ?? true,
      onlyFiles: opts?.onlyFiles ?? true,
      onlyDirectories: opts?.onlyDirectories ?? false,
      dot: opts?.dot ?? true,
      followSymbolicLinks: opts?.followSymlinks ?? true,
      unique: true,
      suppressErrors: true,
    })
  }

  export function globSync(pattern: string | string[], opts?: GlobOptions) {
    return fg.sync(pattern, {
      cwd: opts?.cwd,
      absolute: opts?.absolute ?? true,
      onlyFiles: opts?.onlyFiles ?? true,
      onlyDirectories: opts?.onlyDirectories ?? false,
      dot: opts?.dot ?? true,
      followSymbolicLinks: opts?.followSymlinks ?? true,
      unique: true,
      suppressErrors: true,
    })
  }
}

