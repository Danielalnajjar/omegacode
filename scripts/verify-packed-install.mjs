#!/usr/bin/env node

import { createHash } from "node:crypto"
import { lstatSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs"
import { join, relative, resolve } from "node:path"

const [expectedArg, installedArg, binArg, receiptArg] = process.argv.slice(2)
if (!expectedArg || !installedArg || !binArg) {
  process.stderr.write("usage: verify-packed-install.mjs <extracted-package> <installed-package> <bin> [receipt]\n")
  process.exit(2)
}

const expectedRoot = resolve(expectedArg)
const installedRoot = resolve(installedArg)
const binPath = resolve(binArg)

function digest(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex")
}

function inventory(root) {
  const rows = []
  const visit = (directory) => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name)
      const info = lstatSync(path)
      const item = relative(root, path)
      if (info.isSymbolicLink()) throw new Error(`${path} is a symlink; packed package payloads must be self-contained`)
      if (info.isDirectory()) {
        rows.push({ path: item, type: "directory", mode: info.mode & 0o777 })
        visit(path)
      } else if (info.isFile()) {
        rows.push({ path: item, type: "file", mode: info.mode & 0o777, sha256: digest(path), size: info.size })
      } else {
        throw new Error(`${path} has unsupported file type`)
      }
    }
  }
  visit(root)
  return rows
}

const expected = inventory(expectedRoot)
const installed = inventory(installedRoot)
if (JSON.stringify(installed) !== JSON.stringify(expected)) {
  throw new Error("installed package payload differs from the packed tarball (paths, types, modes, sizes, or hashes)")
}

const installedCli = resolve(installedRoot, "dist/cli.js")
if (realpathSync(binPath) !== realpathSync(installedCli)) {
  throw new Error(`omegacode bin does not resolve to ${installedCli}`)
}
if ((statSync(binPath).mode & 0o111) === 0) throw new Error("omegacode bin is not executable")

const receipt = {
  ok: true,
  expectedRoot,
  installedRoot,
  binPath,
  binRealPath: realpathSync(binPath),
  entryCount: expected.length,
  payloadSha256: createHash("sha256").update(JSON.stringify(expected)).digest("hex"),
}
if (receiptArg) writeFileSync(receiptArg, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 })
process.stdout.write(`${JSON.stringify(receipt)}\n`)
