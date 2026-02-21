import { spawn } from "node:child_process"

export interface GitResult {
  exitCode: number
  text(): string | Promise<string>
  stdout: Buffer | ReadableStream<Uint8Array>
  stderr: Buffer | ReadableStream<Uint8Array>
}

/**
 * Run a git command.
 */
export async function git(args: string[], opts: { cwd: string; env?: Record<string, string> }): Promise<GitResult> {
  const env = opts.env ? { ...process.env, ...opts.env } : process.env

  return new Promise((resolve) => {
    const proc = spawn("git", args, {
      cwd: opts.cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    })

    const out: Buffer[] = []
    const err: Buffer[] = []

    proc.stdout?.on("data", (chunk) => out.push(Buffer.from(chunk)))
    proc.stderr?.on("data", (chunk) => err.push(Buffer.from(chunk)))

    const done = (code: number) => {
      const stdout = Buffer.concat(out)
      const stderr = Buffer.concat(err)
      resolve({
        exitCode: code,
        text: () => stdout.toString(),
        stdout,
        stderr,
      })
    }

    proc.on("error", (e) => {
      const stderr = Buffer.from(e instanceof Error ? e.message : String(e))
      resolve({
        exitCode: 1,
        text: () => "",
        stdout: Buffer.alloc(0),
        stderr,
      })
    })

    proc.on("close", (code) => done(code ?? 1))
  })
}
