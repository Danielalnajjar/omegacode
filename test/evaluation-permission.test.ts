import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { Journal } from "../src/runtime/journal.ts"
import { runWorkflow } from "../src/runtime/run.ts"

test("detached --typesafe persists permission and explicit false cannot downgrade its resumed run", () => {
  const home = mkdtempSync(join(tmpdir(), "omega-detached-eval-"))
  const file = join(home, "eval.workflow.js")
  writeFileSync(file, 'export const meta = {name:"eval",description:"permission"}; return await evaluate({state:"x",questions:{q:{type:"noul",instructions:"ok?"}}})')
  const env = { ...process.env, OMEGACODE_HOME: home, TYPESAFE_API_KEY: "" }
  const cli = (...args: string[]) => execFileSync(process.execPath, ["--import", "tsx", resolve("src/cli.ts"), ...args], { env, encoding: "utf8", timeout: 15000 })
  try {
    const launch = JSON.parse(cli("run", file, "--fake", "--typesafe", "--no-serve", "--detach", "--json"))
    const completed = JSON.parse(cli("wait", launch.runId, "--json"))
    assert.equal(completed.status, "completed")
    const entries = readFileSync(join(home, "runs", launch.runId, "journal.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line))
    assert.equal(entries.find(e => e.type === "meta").typesafeEvaluate, true)
    assert.equal(entries.some(e => e.type === "evaluation_attempt"), false)
    assert.throws(() => cli("run", file, "--resume", launch.runId, "--typesafe=false", "--fake", "--no-serve", "--json"), /cannot change --typesafe/)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test("legacy permission stays off and missing host key never starts HTTP", async () => {
  const home = mkdtempSync(join(tmpdir(), "omega-legacy-eval-"))
  const oldHome = process.env.OMEGACODE_HOME, oldKey = process.env.TYPESAFE_API_KEY
  const fetch = globalThis.fetch
  let calls = 0
  try {
    process.env.OMEGACODE_HOME = home
    delete process.env.TYPESAFE_API_KEY
    globalThis.fetch = async () => { calls++; throw new Error("must not request") }
    const file = join(home, "eval.workflow.js")
    writeFileSync(file, 'export const meta = {name:"eval",description:"permission"}; return await evaluate({state:"x",questions:{q:{type:"noul",instructions:"ok?"}}})')
    const missing = await runWorkflow({ file, typesafe: true, quiet: true })
    assert.equal(missing.status, "failed")
    assert.match(missing.error!, /TYPESAFE_API_KEY/)
    assert.equal(missing.evaluationUsage?.unknownAttempts, 0)
    const off = await runWorkflow({ file, quiet: true })
    const meta = Journal.load(off.runId).meta!
    delete meta.typesafeEvaluate
    new Journal(off.runId).append(meta)
    const legacy = await runWorkflow({ file, resumeRunId: off.runId, fake: true, quiet: true })
    assert.equal(legacy.status, "failed")
    assert.match(legacy.error!, /disabled/)
    assert.equal(calls, 0)
  } finally {
    globalThis.fetch = fetch
    if (oldHome === undefined) delete process.env.OMEGACODE_HOME; else process.env.OMEGACODE_HOME = oldHome
    if (oldKey === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = oldKey
    rmSync(home, { recursive: true, force: true })
  }
})
