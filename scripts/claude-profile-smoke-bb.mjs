#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs"
import { isAbsolute, join } from "node:path"

const realBb = process.env.OMEGA_PROFILE_SMOKE_REAL_BB
const trace = process.env.OMEGA_PROFILE_SMOKE_TRACE
const nonce = process.env.OMEGA_PROFILE_SMOKE_NONCE
const allowed = JSON.parse(process.env.OMEGA_PROFILE_SMOKE_ALLOWED_PROFILES ?? "null")
const wrapperPid = Number(process.argv[2])
const args = process.argv.slice(3)
const expectedPrefix = ["subscription", "resolve-omega", "--profile-id"]
const valid = isAbsolute(realBb ?? "")
  && isAbsolute(trace ?? "")
  && typeof nonce === "string"
  && Number.isInteger(wrapperPid)
  && wrapperPid > 1
  && process.ppid === wrapperPid
  && Array.isArray(allowed)
  && allowed.length === 2
  && allowed.every((value) => typeof value === "string" && value.length > 0)
  && args.length === 5
  && expectedPrefix.every((value, index) => args[index] === value)
  && allowed.includes(args[3])
  && args[4] === "--json"

if (!valid) {
  process.stderr.write("profile smoke bb wrapper refused a non-resolver invocation\n")
  process.exit(78)
}

mkdirSync(join(trace, "resolver"), { recursive: true, mode: 0o700 })
writeFileSync(
  join(trace, "resolver", `${wrapperPid}.json`),
  JSON.stringify({ nonce, pid: wrapperPid, argv: args, at: Date.now() }),
  { flag: "wx", mode: 0o600 },
)
