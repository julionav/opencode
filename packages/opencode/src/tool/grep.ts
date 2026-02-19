import z from "zod"
import { Tool } from "./tool"
import { Filesystem } from "../util/filesystem"

import DESCRIPTION from "./grep.txt"
import { Instance } from "../project/instance"
import path from "path"
import { assertExternalDirectory } from "./external-directory"
import fs from "node:fs/promises"
import { FileIgnore } from "@/file/ignore"
import { Runtime } from "@/runtime"

const MAX_LINE_LENGTH = 2000

export const GrepTool = Tool.define("grep", {
  description: DESCRIPTION,
  parameters: z.object({
    pattern: z.string().describe("The regex pattern to search for in file contents"),
    path: z.string().optional().describe("The directory to search in. Defaults to the current working directory."),
    include: z.string().optional().describe('File pattern to include in the search (e.g. "*.js", "*.{ts,tsx}")'),
  }),
  async execute(params, ctx) {
    if (!params.pattern) {
      throw new Error("pattern is required")
    }

    await ctx.ask({
      permission: "grep",
      patterns: [params.pattern],
      always: ["*"],
      metadata: {
        pattern: params.pattern,
        path: params.path,
        include: params.include,
      },
    })

    let searchPath = params.path ?? Instance.directory
    searchPath = path.isAbsolute(searchPath) ? searchPath : path.resolve(Instance.directory, searchPath)
    await assertExternalDirectory(ctx, searchPath, { kind: "directory" })

    const regex = (() => {
      try {
        return new RegExp(params.pattern)
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        throw new Error(`Invalid regex pattern: ${params.pattern}\n${msg}`)
      }
    })()

    const includes = params.include ? [params.include] : ["**/*"]
    const files = await Runtime.glob(includes, {
      cwd: searchPath,
      absolute: true,
      onlyFiles: true,
      dot: true,
      followSymlinks: true,
    })

    const matches: { path: string; modTime: number; lineNum: number; lineText: string }[] = []
    let hasErrors = false

    for (const filePath of files) {
      ctx.abort.throwIfAborted()

      const rel = path.relative(searchPath, filePath)
      if (FileIgnore.match(rel)) continue

      const stat = Filesystem.stat(filePath)
      if (!stat?.isFile()) continue
      if (stat.size > 1024 * 1024) continue

      const content = await fs.readFile(filePath, "utf-8").catch(() => {
        hasErrors = true
        return ""
      })
      if (!content) continue
      if (content.includes("\u0000")) continue

      const lines = content.split(/\r?\n/)
      for (let i = 0; i < lines.length; i++) {
        const lineText = lines[i] ?? ""
        if (!regex.test(lineText)) continue
        matches.push({
          path: filePath,
          modTime: stat.mtime.getTime(),
          lineNum: i + 1,
          lineText,
        })
      }
    }

    matches.sort((a, b) => b.modTime - a.modTime)

    const limit = 100
    const truncated = matches.length > limit
    const finalMatches = truncated ? matches.slice(0, limit) : matches

    if (finalMatches.length === 0) {
      return {
        title: params.pattern,
        metadata: { matches: 0, truncated: false },
        output: "No files found",
      }
    }

    const totalMatches = matches.length
    const outputLines = [`Found ${totalMatches} matches${truncated ? ` (showing first ${limit})` : ""}`]

    let currentFile = ""
    for (const match of finalMatches) {
      if (currentFile !== match.path) {
        if (currentFile !== "") {
          outputLines.push("")
        }
        currentFile = match.path
        outputLines.push(`${match.path}:`)
      }
      const truncatedLineText =
        match.lineText.length > MAX_LINE_LENGTH ? match.lineText.substring(0, MAX_LINE_LENGTH) + "..." : match.lineText
      outputLines.push(`  Line ${match.lineNum}: ${truncatedLineText}`)
    }

    if (truncated) {
      outputLines.push("")
      outputLines.push(
        `(Results truncated: showing ${limit} of ${totalMatches} matches (${totalMatches - limit} hidden). Consider using a more specific path or pattern.)`,
      )
    }

    if (hasErrors) {
      outputLines.push("")
      outputLines.push("(Some paths were inaccessible and skipped)")
    }

    return {
      title: params.pattern,
      metadata: {
        matches: totalMatches,
        truncated,
      },
      output: outputLines.join("\n"),
    }
  },
})
