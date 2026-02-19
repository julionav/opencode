import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { Instance } from "@/project/instance"
import { Log } from "@/util/log"
import { Runtime } from "@/runtime"
import { ulid } from "ulid"
import z from "zod"

export namespace WebContainerShell {
  const log = Log.create({ service: "webcontainer.shell" })

  export const ExecRequested = BusEvent.define(
    "shell.exec.requested",
    z.object({
      id: z.string(),
      cwd: z.string(),
      command: z.string(),
      timeout: z.number(),
    }),
  )

  type Pending = {
    resolve: (value: { exitCode: number; output: string }) => void
    timer: ReturnType<typeof setTimeout>
  }

  const state = Instance.state(() => {
    return {
      pending: new Map<string, Pending>(),
    }
  })

  export async function exec(input: { cwd: string; command: string; timeout: number; abort?: AbortSignal }) {
    if (Runtime.mode() !== "webcontainer") {
      throw new Error("WebContainerShell.exec is only available in OPENCODE_RUNTIME=webcontainer")
    }

    const id = ulid()

    const pending = new Promise<{ exitCode: number; output: string }>((resolve, reject) => {
      if (input.abort?.aborted) {
        reject(new Error("Aborted"))
        return
      }

      const timer = setTimeout(() => {
        state().pending.delete(id)
        resolve({
          exitCode: 124,
          output: `Error executing command: timed out after ${input.timeout}ms`,
        })
      }, input.timeout)

      state().pending.set(id, { resolve, timer })

      input.abort?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer)
          state().pending.delete(id)
          reject(new Error("Aborted"))
        },
        { once: true },
      )
    })

    await Bus.publish(ExecRequested, {
      id,
      cwd: input.cwd,
      command: input.command,
      timeout: input.timeout,
    })

    log.info("requested", { id })
    return pending
  }

  export function respond(input: { id: string; exitCode: number; output: string }) {
    const pending = state().pending.get(input.id)
    if (!pending) return false
    state().pending.delete(input.id)
    clearTimeout(pending.timer)
    pending.resolve({ exitCode: input.exitCode, output: input.output })
    log.info("responded", { id: input.id, exitCode: input.exitCode })
    return true
  }
}

