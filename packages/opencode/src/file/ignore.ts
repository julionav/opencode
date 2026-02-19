import { sep } from "node:path"
import { Minimatch } from "minimatch"

export namespace FileIgnore {
  const FOLDERS = new Set([
    "node_modules",
    "bower_components",
    ".pnpm-store",
    "vendor",
    ".npm",
    "dist",
    "build",
    "out",
    ".next",
    "target",
    "bin",
    "obj",
    ".git",
    ".svn",
    ".hg",
    ".vscode",
    ".idea",
    ".turbo",
    ".output",
    "desktop",
    ".sst",
    ".cache",
    ".webkit-cache",
    "__pycache__",
    ".pytest_cache",
    "mypy_cache",
    ".history",
    ".gradle",
  ])

  const FILES = [
    "**/*.swp",
    "**/*.swo",

    "**/*.pyc",

    // OS
    "**/.DS_Store",
    "**/Thumbs.db",

    // Logs & temp
    "**/logs/**",
    "**/tmp/**",
    "**/temp/**",
    "**/*.log",

    // Coverage/test outputs
    "**/coverage/**",
    "**/.nyc_output/**",
  ]

  type Glob = Pick<Minimatch, "match">

  const FILE_GLOBS: Glob[] = FILES.map(
    (p) =>
      new Minimatch(p, {
        dot: true,
        nocase: process.platform === "win32",
        nocomment: true,
      }),
  )

  export const PATTERNS = [...FILES, ...FOLDERS]

  export function match(
    filepath: string,
    opts?: {
      extra?: Glob[]
      whitelist?: Glob[]
    },
  ) {
    for (const glob of opts?.whitelist || []) {
      if (glob.match(filepath)) return false
    }

    const parts = filepath.split(sep)
    for (let i = 0; i < parts.length; i++) {
      if (FOLDERS.has(parts[i])) return true
    }

    const extra = opts?.extra || []
    for (const glob of [...FILE_GLOBS, ...extra]) {
      if (glob.match(filepath)) return true
    }

    return false
  }
}
