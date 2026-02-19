import { Log } from "../util/log"
import path from "path"
import fs from "fs/promises"
import { Global } from "../global"
import { Filesystem } from "../util/filesystem"
import { lazy } from "../util/lazy"
import { Lock } from "../util/lock"
import { NamedError } from "@opencode-ai/util/error"
import z from "zod"
import { Runtime } from "@/runtime"
import { spawn } from "node:child_process"

export namespace Storage {
  const log = Log.create({ service: "storage" })

  type Migration = (dir: string) => Promise<void>

  export const NotFoundError = NamedError.create(
    "NotFoundError",
    z.object({
      message: z.string(),
    }),
  )

  function exec(cmd: string, args: string[], opts: { cwd: string }) {
    return new Promise<{ code: number; stdout: string }>((resolve) => {
      const proc = spawn(cmd, args, {
        cwd: opts.cwd,
        stdio: ["ignore", "pipe", "ignore"],
      })
      let out = ""
      proc.stdout?.on("data", (chunk) => {
        out += chunk.toString()
      })
      proc.on("close", (code) => resolve({ code: code ?? 1, stdout: out }))
      proc.on("error", () => resolve({ code: 1, stdout: "" }))
    })
  }

  const MIGRATIONS: Migration[] = Runtime.mode() === "webcontainer" ? [] : [
    async (dir) => {
      const project = path.resolve(dir, "../project")
      if (!(await Filesystem.isDir(project))) return
      const projects = await Runtime.glob("*", {
        cwd: project,
        absolute: false,
        onlyDirectories: true,
        onlyFiles: false,
        dot: false,
        followSymlinks: false,
      })
      for (const projectDir of projects) {
        log.info(`migrating project ${projectDir}`)
        let projectID = projectDir
        const fullProjectDir = path.join(project, projectDir)
        let worktree = "/"

        if (projectID !== "global") {
          const msgs = await Runtime.glob("storage/session/message/*/*.json", {
            cwd: path.join(project, projectDir),
            absolute: true,
            onlyFiles: true,
            dot: true,
          })
          for (const msgFile of msgs) {
            const json = await Filesystem.readJson<any>(msgFile)
            worktree = json.path?.root
            if (worktree) break
          }
          if (!worktree) continue
          if (!(await Filesystem.isDir(worktree))) continue
          const bin = Runtime.which("git")
          const [id] = bin
            ? await exec(bin, ["rev-list", "--max-parents=0", "--all"], { cwd: worktree }).then((result) =>
                result.stdout
                  .split("\n")
                  .filter(Boolean)
                  .map((x) => x.trim())
                  .toSorted(),
              )
            : []
          if (!id) continue
          projectID = id

          await Filesystem.writeJson(path.join(dir, "project", projectID + ".json"), {
            id,
            vcs: "git",
            worktree,
            time: {
              created: Date.now(),
              initialized: Date.now(),
            },
          })

          log.info(`migrating sessions for project ${projectID}`)
          const sessions = await Runtime.glob("storage/session/info/*.json", {
            cwd: fullProjectDir,
            absolute: true,
            onlyFiles: true,
            dot: true,
          })
          for (const sessionFile of sessions) {
            const dest = path.join(dir, "session", projectID, path.basename(sessionFile))
            log.info("copying", {
              sessionFile,
              dest,
            })
            const session = await Filesystem.readJson<any>(sessionFile)
            await Filesystem.writeJson(dest, session)
            log.info(`migrating messages for session ${session.id}`)
            const sessionMsgs = await Runtime.glob(`storage/session/message/${session.id}/*.json`, {
              cwd: fullProjectDir,
              absolute: true,
              onlyFiles: true,
              dot: true,
            })
            for (const msgFile of sessionMsgs) {
              const dest = path.join(dir, "message", session.id, path.basename(msgFile))
              log.info("copying", {
                msgFile,
                dest,
              })
              const message = await Filesystem.readJson<any>(msgFile)
              await Filesystem.writeJson(dest, message)

              log.info(`migrating parts for message ${message.id}`)
              const parts = await Runtime.glob(`storage/session/part/${session.id}/${message.id}/*.json`, {
                cwd: fullProjectDir,
                absolute: true,
                onlyFiles: true,
                dot: true,
              })
              for (const partFile of parts) {
                const dest = path.join(dir, "part", message.id, path.basename(partFile))
                const part = await Filesystem.readJson(partFile)
                log.info("copying", {
                  partFile,
                  dest,
                })
                await Filesystem.writeJson(dest, part)
              }
            }
          }
        }
      }
    },
    async (dir) => {
      const items = await Runtime.glob("session/*/*.json", {
        cwd: dir,
        absolute: true,
        onlyFiles: true,
        dot: true,
      })
      for (const item of items) {
        const session = await Filesystem.readJson<any>(item)
        if (!session.projectID) continue
        if (!session.summary?.diffs) continue
        const { diffs } = session.summary
        await Filesystem.write(path.join(dir, "session_diff", session.id + ".json"), JSON.stringify(diffs))
        await Filesystem.writeJson(path.join(dir, "session", session.projectID, session.id + ".json"), {
          ...session,
          summary: {
            additions: diffs.reduce((sum: any, x: any) => sum + x.additions, 0),
            deletions: diffs.reduce((sum: any, x: any) => sum + x.deletions, 0),
          },
        })
      }
    },
  ]

  const state = lazy(async () => {
    const dir = path.join(Global.Path.data, "storage")
    const migration = await Filesystem.readJson<string>(path.join(dir, "migration"))
      .then((x) => parseInt(x))
      .catch(() => 0)
    for (let index = migration; index < MIGRATIONS.length; index++) {
      log.info("running migration", { index })
      const migration = MIGRATIONS[index]
      await migration(dir).catch(() => log.error("failed to run migration", { index }))
      await Filesystem.write(path.join(dir, "migration"), (index + 1).toString())
    }
    return {
      dir,
    }
  })

  export async function remove(key: string[]) {
    const dir = await state().then((x) => x.dir)
    const target = path.join(dir, ...key) + ".json"
    return withErrorHandling(async () => {
      await fs.unlink(target).catch(() => {})
    })
  }

  export async function read<T>(key: string[]) {
    const dir = await state().then((x) => x.dir)
    const target = path.join(dir, ...key) + ".json"
    return withErrorHandling(async () => {
      using _ = await Lock.read(target)
      const result = await Filesystem.readJson<T>(target)
      return result as T
    })
  }

  export async function update<T>(key: string[], fn: (draft: T) => void) {
    const dir = await state().then((x) => x.dir)
    const target = path.join(dir, ...key) + ".json"
    return withErrorHandling(async () => {
      using _ = await Lock.write(target)
      const content = await Filesystem.readJson<T>(target)
      fn(content as T)
      await Filesystem.writeJson(target, content)
      return content
    })
  }

  export async function write<T>(key: string[], content: T) {
    const dir = await state().then((x) => x.dir)
    const target = path.join(dir, ...key) + ".json"
    return withErrorHandling(async () => {
      using _ = await Lock.write(target)
      await Filesystem.writeJson(target, content)
    })
  }

  async function withErrorHandling<T>(body: () => Promise<T>) {
    return body().catch((e) => {
      if (!(e instanceof Error)) throw e
      const errnoException = e as NodeJS.ErrnoException
      if (errnoException.code === "ENOENT") {
        throw new NotFoundError({ message: `Resource not found: ${errnoException.path}` })
      }
      throw e
    })
  }

  export async function list(prefix: string[]) {
    const dir = await state().then((x) => x.dir)
    try {
      const results = await Runtime.glob("**/*", {
        cwd: path.join(dir, ...prefix),
        absolute: false,
        onlyFiles: true,
        dot: true,
        followSymlinks: false,
      })
      const result = results.map((x) => [...prefix, ...x.slice(0, -5).split(path.sep)])
      result.sort()
      return result
    } catch {
      return []
    }
  }
}
