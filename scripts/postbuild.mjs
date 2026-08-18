// Portable post-build step (runs after `tsup` in the `build` script). Replaces the POSIX-only
// `rm -rf dist/web && cp -r viewer/dist dist/web` so the build + prepublishOnly work on Windows too.
// It runs after tsup (not as onSuccess) because tsup's dts worker manages dist independently and
// would clobber files written from onSuccess.
//
// Three jobs:
//   1. Copy the built React viewer (viewer/dist) into dist/web. serve.ts resolves its web assets at
//      join(__dirname, "web") and __dirname is dist/ once bundled.
//   2. Copy the self-contained author ambient types to dist/ambient.d.ts (the target of the
//      package.json "./ambient" export). The source MUST NOT import any other module, or the d.ts is
//      dead on arrival for npm consumers — we assert that here so a regression fails the build loudly.
//   3. Copy the Grok fleet profile next to the bundled worker so its import.meta.url-relative path
//      resolves identically in source and in the published dist.

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const dist = join(root, "dist")

if (!existsSync(dist)) mkdirSync(dist, { recursive: true })

// 1. Viewer assets -> dist/web
const viewerDist = join(root, "viewer", "dist")
const webOut = join(dist, "web")
if (!existsSync(viewerDist)) {
  throw new Error(
    `viewer build output missing at ${viewerDist}; run the viewer build before tsup (pnpm build)`,
  )
}
rmSync(webOut, { recursive: true, force: true })
cpSync(viewerDist, webOut, { recursive: true })

// 2. Self-contained ambient types -> dist/ambient.d.ts
const ambientSrc = join(root, "src", "dsl", "ambient.d.ts")
const ambient = readFileSync(ambientSrc, "utf8")
// Reject any import/require so the shipped d.ts never depends on an unpublished module.
for (const line of ambient.split("\n")) {
  const code = line.replace(/\/\/.*/, "").trim()
  if (/^import\b/.test(code) || /\brequire\s*\(/.test(code) || /^export\b.*\bfrom\b/.test(code)) {
    throw new Error(
      `src/dsl/ambient.d.ts must be self-contained (no imports). Offending line: ${line.trim()}`,
    )
  }
}
writeFileSync(join(dist, "ambient.d.ts"), ambient)

// 3. Grok fleet profile -> dist/agents
const agentsSrc = join(root, "src", "worker", "agents")
const agentsOut = join(dist, "agents")
if (!existsSync(agentsSrc)) {
  throw new Error(`Grok agent profiles missing at ${agentsSrc}`)
}
rmSync(agentsOut, { recursive: true, force: true })
cpSync(agentsSrc, agentsOut, { recursive: true })

console.log(
  "postbuild: copied viewer -> dist/web, wrote dist/ambient.d.ts, and copied Grok agent profiles -> dist/agents",
)
