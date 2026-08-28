#!/usr/bin/env node

import { createHash } from "node:crypto"
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from "node:fs"
import { dirname, join } from "node:path"

const [command, activePrefix, candidatePrefix, backupRoot] = process.argv.slice(2)
if (!command || !activePrefix || !candidatePrefix || !backupRoot || !["snapshot", "restore", "verify"].includes(command)) {
  process.stderr.write("usage: global-project-rollback.mjs <snapshot|restore|verify> <active-prefix> <candidate-prefix> <backup-root>\n")
  process.exit(2)
}

const statePath = join(backupRoot, "state.json")
const entriesRoot = join(backupRoot, "entries")

function rootPaths(prefix) {
  const nodeModules = join(prefix, "install", "global", "node_modules")
  return { nodeModules, nodeModulesBin: join(nodeModules, ".bin"), bin: join(prefix, "bin") }
}

function names(path) {
  return existsSync(path) ? readdirSync(path).sort() : []
}

function inventory(prefix) {
  const roots = rootPaths(prefix)
  const entries = []
  for (const name of names(roots.nodeModules)) {
    if (name === ".bin") continue
    const path = join(roots.nodeModules, name)
    if (name.startsWith("@") && lstatSync(path).isDirectory() && !lstatSync(path).isSymbolicLink()) {
      for (const child of names(path)) entries.push(`install/global/node_modules/${name}/${child}`)
    } else {
      entries.push(`install/global/node_modules/${name}`)
    }
  }
  for (const name of names(roots.nodeModulesBin)) entries.push(`install/global/node_modules/.bin/${name}`)
  for (const name of names(roots.bin)) entries.push(`bin/${name}`)
  return entries.sort()
}

function directoryState(prefix) {
  const roots = rootPaths(prefix)
  return Object.fromEntries(Object.entries(roots).map(([name, path]) => [name, existsSync(path)]))
}

function copyEntry(source, destination) {
  mkdirSync(dirname(destination), { recursive: true })
  cpSync(source, destination, {
    recursive: true,
    dereference: false,
    preserveTimestamps: true,
    verbatimSymlinks: true,
  })
}

function fingerprint(path) {
  const info = lstatSync(path)
  const mode = info.mode & 0o777
  if (info.isSymbolicLink()) return { type: "link", mode, target: readlinkSync(path) }
  if (info.isDirectory()) {
    return { type: "directory", mode, entries: Object.fromEntries(names(path).map((name) => [name, fingerprint(join(path, name))])) }
  }
  if (info.isFile()) {
    return { type: "file", mode, size: info.size, sha256: createHash("sha256").update(readFileSync(path)).digest("hex") }
  }
  throw new Error(`${path} has an unsupported filesystem type`)
}

function readState() {
  const value = JSON.parse(readFileSync(statePath, "utf8"))
  if (value?.version !== 1 || !Array.isArray(value.preCutoverEntries) || !Array.isArray(value.affectedEntries)
    || !value.directories || typeof value.directories !== "object") throw new Error("global rollback state is invalid")
  return value
}

function removeEmpty(path) {
  if (existsSync(path) && names(path).length === 0) rmdirSync(path)
}

function restore() {
  const state = readState()
  const before = new Set(state.preCutoverEntries)
  for (const rel of inventory(activePrefix).filter((rel) => !before.has(rel)).sort().reverse()) {
    rmSync(join(activePrefix, rel), { recursive: true, force: true })
  }
  for (const rel of state.affectedEntries) {
    const active = join(activePrefix, rel)
    const backup = join(entriesRoot, rel)
    rmSync(active, { recursive: true, force: true })
    if (existsSync(backup) || lstatExists(backup)) copyEntry(backup, active)
  }

  const roots = rootPaths(activePrefix)
  for (const scope of names(roots.nodeModules).filter((name) => name.startsWith("@"))) removeEmpty(join(roots.nodeModules, scope))
  if (!state.directories.nodeModulesBin) removeEmpty(roots.nodeModulesBin)
  if (!state.directories.nodeModules) removeEmpty(roots.nodeModules)
  if (!state.directories.bin) removeEmpty(roots.bin)
}

function lstatExists(path) {
  try { lstatSync(path); return true } catch (error) {
    if (error?.code === "ENOENT") return false
    throw error
  }
}

function verify() {
  const state = readState()
  const actualEntries = inventory(activePrefix)
  if (JSON.stringify(actualEntries) !== JSON.stringify(state.preCutoverEntries)) {
    throw new Error("global package or bin entry inventory differs after rollback")
  }
  for (const rel of state.affectedEntries) {
    const backup = join(entriesRoot, rel)
    const active = join(activePrefix, rel)
    if (!lstatExists(backup) || !lstatExists(active) || JSON.stringify(fingerprint(active)) !== JSON.stringify(fingerprint(backup))) {
      throw new Error(`global rollback did not restore ${rel}`)
    }
  }
  const actualDirectories = directoryState(activePrefix)
  if (JSON.stringify(actualDirectories) !== JSON.stringify(state.directories)) {
    throw new Error("global package or bin root presence differs after rollback")
  }
}

if (command === "snapshot") {
  if (existsSync(statePath)) throw new Error("global rollback snapshot already exists")
  const preCutoverEntries = inventory(activePrefix)
  const candidateEntries = new Set(inventory(candidatePrefix))
  const affectedEntries = preCutoverEntries.filter((rel) => candidateEntries.has(rel))
  mkdirSync(entriesRoot, { recursive: true })
  for (const rel of affectedEntries) copyEntry(join(activePrefix, rel), join(entriesRoot, rel))
  writeFileSync(statePath, `${JSON.stringify({
    version: 1,
    directories: directoryState(activePrefix),
    preCutoverEntries,
    affectedEntries,
  }, null, 2)}\n`, { mode: 0o600 })
} else if (command === "restore") {
  restore()
} else {
  verify()
}
