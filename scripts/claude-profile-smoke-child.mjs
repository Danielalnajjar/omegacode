#!/usr/bin/env node
import { createHash } from "node:crypto"
import { closeSync, existsSync, mkdirSync, openSync, realpathSync, writeFileSync } from "node:fs"
import { basename, isAbsolute, join, resolve } from "node:path"

const trace = process.env.OMEGA_PROFILE_SMOKE_TRACE
const nonce = process.env.OMEGA_PROFILE_SMOKE_NONCE
const real = process.env.OMEGA_PROFILE_SMOKE_REAL_CLAUDE
const runRoot = process.env.OMEGA_PROFILE_SMOKE_RUN_ROOT
const deadlineAt = Number(process.env.OMEGA_PROFILE_SMOKE_DEADLINE_AT)
const wrapperPid = Number(process.argv[2])
const lane = basename(process.cwd())
const expectedCwd = runRoot && ["A1", "B", "A2"].includes(lane) ? join(runRoot, lane) : ""
if (!trace || !nonce || !real || !runRoot || !isAbsolute(real) || !Number.isFinite(deadlineAt)
  || !Number.isInteger(wrapperPid) || wrapperPid <= 1 || process.ppid !== wrapperPid
  || resolve(trace) !== resolve(join(runRoot, "trace"))
  || !expectedCwd || realpathSync(process.cwd()) !== realpathSync(expectedCwd)
  || !process.env.CLAUDE_CONFIG_DIR) process.exit(78)
mkdirSync(trace, { recursive: true })
mkdirSync(join(trace, "process"), { recursive: true, mode: 0o700 })
writeFileSync(join(trace, "process", `${lane}.json`), JSON.stringify({ lane, nonce, pid: wrapperPid, at: Date.now() }), { flag: "wx", mode: 0o600 })
const dropped = process.env.OMEGA_PROFILE_SMOKE_DROP_LANE === lane
const digest = createHash("sha256").update(process.env.CLAUDE_CONFIG_DIR).digest("hex")
if (!dropped) {
  const fd = openSync(join(trace, `${lane}.arrival.json`), "wx", 0o600)
  writeFileSync(fd, JSON.stringify({ lane, nonce, pid: wrapperPid, digest, at: Date.now() })); closeSync(fd)
}
while (true) {
  if (process.ppid !== wrapperPid) process.exit(78)
  if (existsSync(join(trace, "abandon"))) process.exit(78)
  if (!dropped && existsSync(join(trace, "release"))) break
  if (Date.now() >= deadlineAt) process.exit(78)
  await new Promise((done) => setTimeout(done, 25))
}
if (existsSync(join(trace, "abandon"))) process.exit(78)
