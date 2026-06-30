#!/usr/bin/env node
import { spawnSync } from "node:child_process"

const mode = process.argv[2]

if (mode !== "--dev-preinstall" && mode !== "--frozen") {
  console.error("usage: node scripts/install-safe.mjs --dev-preinstall|--frozen")
  process.exit(1)
}

const major = Number(process.versions.node.split(".")[0])
if (!Number.isInteger(major) || major < 20) {
  console.error(`omegacode requires Node >=20; found ${process.version}`)
  process.exit(1)
}

const ua = process.env.npm_config_user_agent ?? ""
if (mode === "--dev-preinstall" && ua && !ua.startsWith("pnpm/")) {
  console.error("omegacode installs are pnpm-owned; run `pnpm install`, not npm/yarn/bun")
  process.exit(1)
}

if (mode === "--dev-preinstall") {
  process.exit(0)
}

const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm"
const result = spawnSync(pnpm, ["install", "--frozen-lockfile"], {
  stdio: "inherit",
  shell: process.platform === "win32",
})

if (result.error) {
  console.error(`failed to run pnpm install --frozen-lockfile: ${result.error.message}`)
  process.exit(1)
}

process.exit(result.status ?? 1)
