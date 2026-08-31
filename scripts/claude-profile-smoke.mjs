#!/usr/bin/env node
// Checked host harness. It performs read-only exact profile resolution and never reloads plugins,
// changes logins, or starts a viewer.
import { createHash, randomUUID } from "node:crypto"
import { execFile } from "node:child_process"
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const LANES = ["A1", "B", "A2"]
const SMOKE_ENV = [
  "OMEGACODE_HOME", "PATH", "OMEGA_PROFILE_SMOKE_TRACE", "OMEGA_PROFILE_SMOKE_NONCE",
  "OMEGA_PROFILE_SMOKE_REAL_CLAUDE", "OMEGA_PROFILE_SMOKE_REAL_BB",
  "OMEGA_PROFILE_SMOKE_NODE", "OMEGA_PROFILE_SMOKE_CHILD_HELPER", "OMEGA_PROFILE_SMOKE_BB_HELPER",
  "OMEGA_PROFILE_SMOKE_ALLOWED_PROFILES", "OMEGA_PROFILE_SMOKE_RUN_ROOT",
  "OMEGA_PROFILE_SMOKE_DEADLINE_AT", "OMEGA_PROFILE_SMOKE_DROP_LANE",
]

export async function runClaudeProfileSmoke(options) {
  validateOptions(options)
  const root = options.root ?? mkdtempSync(join(tmpdir(), "omega-profile-smoke-"))
  if (options.root) mkdirSync(root, { mode: 0o700 })
  const trace = join(root, "trace")
  const bin = join(root, "bin")
  const omegaHome = join(root, "omega-home")
  const nonce = options.nonce ?? randomUUID()
  const deadlineMs = options.deadlineMs ?? 120_000
  const deadlineAt = Date.now() + deadlineMs
  const savedEnv = Object.fromEntries(SMOKE_ENV.map((key) => [key, process.env[key]]))
  const controller = new AbortController()
  const deadline = setTimeout(() => controller.abort(), deadlineMs)
  let runPromise
  let primaryError

  try {
    mkdirSync(trace, { mode: 0o700 })
    mkdirSync(bin, { mode: 0o700 })
    mkdirSync(omegaHome, { mode: 0o700 })
    for (const lane of LANES) mkdirSync(join(root, lane), { mode: 0o700 })
    const wrapper = join(here, "claude-profile-smoke-exec.sh")
    const bbWrapper = join(bin, "bb")
    copyFileSync(wrapper, bbWrapper)
    chmodSync(bbWrapper, 0o700)

    const bindingA = await resolveBinding(options.realBb, options.profileA, controller.signal)
    const bindingB = await resolveBinding(options.realBb, options.profileB, controller.signal)
    if (bindingA.configDir === bindingB.configDir) throw new Error("profile smoke requires two distinct resolved Claude homes")
    const expectedDigests = {
      A1: digest(bindingA.configDir),
      B: digest(bindingB.configDir),
      A2: digest(bindingA.configDir),
    }

    process.env.OMEGACODE_HOME = omegaHome
    process.env.PATH = `${bin}:${savedEnv.PATH ?? ""}`
    process.env.OMEGA_PROFILE_SMOKE_TRACE = trace
    process.env.OMEGA_PROFILE_SMOKE_NONCE = nonce
    process.env.OMEGA_PROFILE_SMOKE_REAL_CLAUDE = options.realClaude
    process.env.OMEGA_PROFILE_SMOKE_REAL_BB = options.realBb
    process.env.OMEGA_PROFILE_SMOKE_NODE = process.execPath
    process.env.OMEGA_PROFILE_SMOKE_CHILD_HELPER = join(here, "claude-profile-smoke-child.mjs")
    process.env.OMEGA_PROFILE_SMOKE_BB_HELPER = join(here, "claude-profile-smoke-bb.mjs")
    process.env.OMEGA_PROFILE_SMOKE_ALLOWED_PROFILES = JSON.stringify([options.profileA, options.profileB])
    process.env.OMEGA_PROFILE_SMOKE_RUN_ROOT = root
    process.env.OMEGA_PROFILE_SMOKE_DEADLINE_AT = String(deadlineAt)
    delete process.env.OMEGA_PROFILE_SMOKE_DROP_LANE
    if (options.dropLane) process.env.OMEGA_PROFILE_SMOKE_DROP_LANE = options.dropLane

    runPromise = Promise.resolve(options.runWorkflow({
      file: join(here, "../examples/claude-profile-routing-smoke.workflow.js"),
      args: { profileA: options.profileA, profileB: options.profileB, model: options.model, traceRoot: root, nonce },
      signal: controller.signal,
      overrides: { pathToClaudeCodeExecutable: wrapper },
      quiet: true,
    }))
    const arrivalsPromise = waitForArrivals(trace, nonce, controller.signal)
    const first = await Promise.race([
      arrivalsPromise.then((arrivals) => ({ kind: "arrivals", arrivals })),
      runPromise.then((outcome) => ({ kind: "outcome", outcome })),
    ])
    if (first.kind === "outcome") throw new Error(`profile smoke run ended before all children arrived: ${first.outcome.error ?? first.outcome.status}`)
    const arrivals = first.arrivals
    assertArrivals(arrivals, expectedDigests, nonce)
    writeFileSync(join(trace, "release"), "release", { flag: "wx", mode: 0o600 })

    const outcome = await runPromise
    if (outcome.status !== "completed") throw new Error(`profile smoke run ${outcome.status}: ${outcome.error ?? "unknown failure"}`)
    const evidence = inspectRun({ outcome, omegaHome, trace, nonce, expectedDigests, profileA: options.profileA, profileB: options.profileB })
    if (options.receiptPath) writeReceipt(options.receiptPath, evidence)
    return evidence
  } catch (error) {
    primaryError = error
    throw error
  } finally {
    clearTimeout(deadline)
    try {
      controller.abort()
      if (existsSync(trace) && !existsSync(join(trace, "release")) && !existsSync(join(trace, "abandon"))) {
        writeFileSync(join(trace, "abandon"), "abandon", { flag: "wx", mode: 0o600 })
      }
      if (runPromise) await boundedSettlement(runPromise, 10_000)
      assertOwnedChildrenExited(trace)
    } catch (cleanupError) {
      if (!primaryError) throw cleanupError
      const failureMessage = primaryError instanceof Error ? primaryError.message : String(primaryError)
      const cleanupMessage = cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
      throw new AggregateError([primaryError, cleanupError], `${failureMessage}; cleanup also failed: ${cleanupMessage}`)
    } finally {
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      rmSync(root, { recursive: true, force: true })
    }
  }
}

function resolveBinding(realBb, profileId, signal) {
  return new Promise((resolve, reject) => {
    execFile(realBb, ["subscription", "resolve-omega", "--profile-id", profileId, "--json"], {
      encoding: "utf8", maxBuffer: 64 * 1024, signal, killSignal: "SIGKILL",
    }, (error, stdout) => {
      if (error) return reject(new Error(`profile smoke could not exact-resolve ${profileId}`))
      let value
      try { value = JSON.parse(stdout) } catch { return reject(new Error(`profile smoke received malformed exact-resolution output for ${profileId}`)) }
      if (!value || typeof value !== "object" || Array.isArray(value)
        || Object.keys(value).sort().join(",") !== "claudeCodeExecutable,configDir,label,profileId"
        || value.profileId !== profileId || typeof value.label !== "string" || !value.label.trim()
        || typeof value.configDir !== "string" || !value.configDir.trim()
        || typeof value.claudeCodeExecutable !== "string" || !value.claudeCodeExecutable.trim()) {
        return reject(new Error(`profile smoke received an invalid exact-resolution binding for ${profileId}`))
      }
      resolve(value)
    })
  })
}

async function waitForArrivals(trace, nonce, signal) {
  while (!signal.aborted) {
    const arrivals = []
    for (const lane of LANES) {
      const path = join(trace, `${lane}.arrival.json`)
      if (!existsSync(path)) break
      try { arrivals.push(JSON.parse(readFileSync(path, "utf8"))) } catch { break }
    }
    if (arrivals.length === LANES.length) return arrivals
    await new Promise((done) => setTimeout(done, 20))
  }
  throw new Error(`profile smoke deadline expired before all three direct children arrived for nonce ${nonce}`)
}

function assertArrivals(arrivals, expectedDigests, nonce) {
  if (new Set(arrivals.map((row) => row.pid)).size !== LANES.length) throw new Error("profile smoke children did not have three distinct PIDs")
  for (let index = 0; index < LANES.length; index++) {
    const lane = LANES[index]
    const row = arrivals[index]
    if (!row || Object.keys(row).sort().join(",") !== "at,digest,lane,nonce,pid"
      || row.lane !== lane || row.nonce !== nonce || row.digest !== expectedDigests[lane]
      || !Number.isInteger(row.pid) || !Number.isFinite(row.at)) {
      throw new Error(`profile smoke child ${lane} did not observe its expected binding`)
    }
  }
}

function inspectRun({ outcome, omegaHome, trace, nonce, expectedDigests, profileA, profileB }) {
  const expectedResults = LANES.map((lane) => `${lane}:${nonce}`)
  if (JSON.stringify(outcome.result) !== JSON.stringify(expectedResults)) throw new Error("profile smoke results did not match the three exact sentinels")
  const runPath = join(omegaHome, "runs", outcome.runId)
  const durableResult = JSON.parse(readFileSync(join(runPath, "result.json"), "utf8"))
  if (JSON.stringify(durableResult) !== JSON.stringify(expectedResults)) throw new Error("profile smoke durable result did not match the workflow outcome")
  const events = readFileSync(join(runPath, "events.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line))
  const phases = new Set(events.filter((event) => event.type === "phase" && !event.pending).map((event) => `${event.index}:${event.title}`))
  if (phases.size !== 1 || !phases.has("1:A/B/A")) throw new Error("profile smoke did not execute exactly one A/B/A phase")
  const terminal = events.at(-1)
  if (terminal?.type !== "run" || terminal.status !== "completed") throw new Error("profile smoke durable events are not completed")

  const resolverDir = join(trace, "resolver")
  const resolverCalls = readdirSync(resolverDir).sort().map((name) => JSON.parse(readFileSync(join(resolverDir, name), "utf8")))
  if (resolverCalls.length !== 3) throw new Error(`profile smoke expected three resolver calls, observed ${resolverCalls.length}`)
  const resolvedIds = []
  for (const row of resolverCalls) {
    const argv = row.argv
    if (row.nonce !== nonce || !Number.isInteger(row.pid) || !Number.isFinite(row.at)
      || !Array.isArray(argv) || argv.length !== 5
      || argv[0] !== "subscription" || argv[1] !== "resolve-omega" || argv[2] !== "--profile-id" || argv[4] !== "--json"
      || ![profileA, profileB].includes(argv[3])) throw new Error("profile smoke bb trace contains a refused invocation")
    resolvedIds.push(argv[3])
  }
  if (resolvedIds.filter((id) => id === profileA).length !== 2 || resolvedIds.filter((id) => id === profileB).length !== 1) {
    throw new Error("profile smoke resolver calls did not map A/B/A")
  }

  const arrivals = LANES.map((lane) => JSON.parse(readFileSync(join(trace, `${lane}.arrival.json`), "utf8")))
  const processRows = LANES.map((lane) => JSON.parse(readFileSync(join(trace, "process", `${lane}.json`), "utf8")))
  assertArrivals(arrivals, expectedDigests, nonce)
  for (let index = 0; index < LANES.length; index++) {
    if (processRows[index].lane !== LANES[index] || processRows[index].nonce !== nonce || processRows[index].pid !== arrivals[index].pid) {
      throw new Error("profile smoke process trace did not retain the exec'd child PID")
    }
  }

  const receipt = {
    version: 1,
    runId: outcome.runId,
    status: outcome.status,
    nonce,
    profiles: { A: profileA, B: profileB },
    bindingDigests: expectedDigests,
    childPids: Object.fromEntries(arrivals.map((row) => [row.lane, row.pid])),
    arrivalsAt: Object.fromEntries(arrivals.map((row) => [row.lane, row.at])),
    resolverCalls: resolverCalls.map((row) => ({ pid: row.pid, argv: row.argv, at: row.at })),
    resultMarkers: expectedResults,
    routeBoundary: "direct-claude-agent-sdk",
    observedDirectSdkChildren: processRows.length,
  }
  const forbiddenRoutePrefix = "acp" + "-sub-"
  if (JSON.stringify(receipt).includes(forbiddenRoutePrefix) || smokeSources().some((source) => source.includes(forbiddenRoutePrefix))) {
    throw new Error("profile smoke source or trace contains an ACP provider identifier")
  }
  return receipt
}

function smokeSources() {
  return [
    join(here, "claude-profile-smoke-exec.sh"),
    join(here, "claude-profile-smoke.mjs"),
    join(here, "claude-profile-smoke-child.mjs"),
    join(here, "claude-profile-smoke-bb.mjs"),
    join(here, "../examples/claude-profile-routing-smoke.workflow.js"),
  ].map((path) => readFileSync(path, "utf8"))
}

function writeReceipt(path, receipt) {
  const absolute = resolve(path)
  mkdirSync(dirname(absolute), { recursive: true })
  const temporary = `${absolute}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o600 })
  renameSync(temporary, absolute)
}

function validateOptions(options) {
  if (!options || typeof options.runWorkflow !== "function") throw new Error("profile smoke requires the package's public runWorkflow export")
  if (typeof options.profileA !== "string" || typeof options.profileB !== "string" || !options.profileA || !options.profileB || options.profileA === options.profileB) {
    throw new Error("profile smoke requires two distinct non-empty profile IDs")
  }
  if (typeof options.model !== "string" || !options.model) throw new Error("profile smoke requires one explicit Claude model")
  if (!isAbsolute(options.realClaude ?? "") || !isAbsolute(options.realBb ?? "")) throw new Error("profile smoke requires absolute Claude and bb executable paths")
  if (options.root !== undefined && !isAbsolute(options.root)) throw new Error("profile smoke root must be absolute")
  if (options.dropLane !== undefined && !LANES.includes(options.dropLane)) throw new Error("profile smoke dropLane must be A1, B, or A2")
  if (options.deadlineMs !== undefined && (!Number.isInteger(options.deadlineMs) || options.deadlineMs < 50)) throw new Error("profile smoke deadlineMs must be at least 50ms")
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex")
}

function assertOwnedChildrenExited(trace) {
  const processDir = join(trace, "process")
  if (!existsSync(processDir)) return
  for (const name of readdirSync(processDir)) {
    const row = JSON.parse(readFileSync(join(processDir, name), "utf8"))
    try {
      process.kill(row.pid, 0)
      throw new Error(`profile smoke owned child ${row.pid} remained alive after cleanup`)
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ESRCH") continue
      throw error
    }
  }
}

async function boundedSettlement(promise, timeoutMs) {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("profile smoke owned run did not settle after abort")), timeoutMs)
    promise.then(
      () => { clearTimeout(timer); resolve() },
      () => { clearTimeout(timer); resolve() },
    )
  })
}

function parseArgs(argv) {
  const values = {}
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    const value = argv[index + 1]
    if (!key?.startsWith("--") || value === undefined) throw new Error("profile smoke arguments must be --name value pairs")
    values[key.slice(2)] = value
  }
  return values
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const required = ["profile-a", "profile-b", "model", "claude", "bb", "package-entry", "receipt"]
  for (const name of required) if (!args[name]) throw new Error(`profile smoke requires --${name}`)
  const entry = resolve(args["package-entry"])
  const imported = await import(pathToFileURL(entry).href)
  if (typeof imported.runWorkflow !== "function") throw new Error("--package-entry does not export runWorkflow")
  const receipt = await runClaudeProfileSmoke({
    profileA: args["profile-a"],
    profileB: args["profile-b"],
    model: args.model,
    realClaude: resolve(args.claude),
    realBb: resolve(args.bb),
    receiptPath: resolve(args.receipt),
    deadlineMs: args["deadline-ms"] === undefined ? undefined : Number(args["deadline-ms"]),
    runWorkflow: imported.runWorkflow,
  })
  console.log(JSON.stringify(receipt, null, 2))
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
