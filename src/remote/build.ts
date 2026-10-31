// Which OmegaCode a process runs, so a run and a machine can refuse to work across different
// builds (ADR 0003, Machines). The protocol version alone misses AgentSpec fields added since.

import { createHash } from "node:crypto"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"

interface Package {
  root: string
  version: string
}

let cachedPackage: Package | null | undefined
let cachedBuild: string | undefined

function findPackage(): Package | null {
  if (cachedPackage !== undefined) return cachedPackage
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 4; i++, dir = dirname(dir)) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name?: string; version?: string }
      if (pkg.name === "omegacode") return (cachedPackage = { root: dir, version: pkg.version ?? "unknown" })
    } catch {
      // keep walking up
    }
  }
  return (cachedPackage = null)
}

export function packageVersion(): string {
  return findPackage()?.version ?? "unknown"
}

function files(dir: string, skip: (name: string) => boolean): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (skip(entry.name)) continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...files(path, skip))
    else if (entry.isFile()) out.push(path)
  }
  return out
}

/**
 * A hash of the code this process runs: the bundled `dist/` (without the viewer and source maps)
 * when built, else `src/`. Two machines with the same build report the same id.
 */
export function buildId(): string {
  if (cachedBuild) return cachedBuild
  const pkg = findPackage()
  if (!pkg) return (cachedBuild = "unknown")
  const here = fileURLToPath(import.meta.url)
  const dist = join(pkg.root, "dist")
  const code = !relative(dist, here).startsWith("..") && existsSync(dist) ? dist : join(pkg.root, "src")
  const hash = createHash("sha256")
  for (const file of files(code, (name) => name === "web" || name.endsWith(".map")).sort()) {
    hash.update(relative(code, file)).update("\0").update(readFileSync(file)).update("\0")
  }
  return (cachedBuild = hash.digest("hex").slice(0, 16))
}
