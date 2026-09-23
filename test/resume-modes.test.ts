import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"
import { runWorkflow } from "../src/runtime/run.ts"
import { Journal, journalPath } from "../src/runtime/journal.ts"
import { setTestEnv } from "./test-env.ts"

function legacyJournal(runId: string): void {
  const path = journalPath(runId)
  const records = readFileSync(path, "utf8").trim().split("\n").map(line => JSON.parse(line))
  for (const record of records) if (record.type === "meta") {
    delete record.fake
    delete record.typesafe
  }
  writeFileSync(path, records.map(record => JSON.stringify(record)).join("\n") + "\n")
}

test("public resume preserves legacy fake journals and inherits newly recorded modes", async t => {
  const home = mkdtempSync(join(tmpdir(), "omega-mode-compat-"))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  setTestEnv(t, { HOME: home, OMEGACODE_HOME: join(home, "omega") })
  t.mock.method(globalThis, "fetch", async () => assert.fail("no workflow in this test may call HTTP"))
  const file = join(home, "modes.workflow.js")
  writeFileSync(file, `export const meta = {name:"modes",description:"mode replay"}; return "complete"`)
  const old = await runWorkflow({ file, fake: true, quiet: true })
  legacyJournal(old.runId)
  const legacy = await runWorkflow({ file, fake: true, quiet: true, resumeRunId: old.runId })
  assert.equal(legacy.status, "completed", legacy.error)
  assert.equal(Journal.load(old.runId).meta?.fake, undefined)
  await assert.rejects(runWorkflow({ file, typesafe: true, quiet: true, resumeRunId: old.runId }), /explicit --typesafe must match/)

  for (const fake of [false, true]) for (const typesafe of [false, true]) {
    const first = await runWorkflow({ file, fake, typesafe, quiet: true })
    const replay = await runWorkflow({ file, quiet: true, resumeRunId: first.runId })
    assert.equal(replay.status, "completed", replay.error)
    assert.equal(replay.result, "complete")
    assert.equal(Journal.load(first.runId).meta?.fake, fake)
    assert.equal(Journal.load(first.runId).meta?.typesafe, typesafe)
    await assert.rejects(runWorkflow({ file, fake: !fake, quiet: true, resumeRunId: first.runId }), /explicit --fake must match/)
    await assert.rejects(runWorkflow({ file, typesafe: !typesafe, quiet: true, resumeRunId: first.runId }), /explicit --typesafe must match/)
  }
})

test("foreground and detached CLI preserve omitted versus explicit false mode flags", { timeout: 60_000 }, async t => {
  const home = mkdtempSync(join(tmpdir(), "omega-mode-cli-"))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const omegaHome = join(home, "omega")
  // Child tests receive no inherited credentials or auth bundles. PATH and system
  // bootstrap paths are needed on Windows, but are never asserted as a full object.
  const env: NodeJS.ProcessEnv = { HOME: home, USERPROFILE: home, OMEGACODE_HOME: omegaHome }
  for (const key of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "TSX_DISABLE_CACHE"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key]
  }
  const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url))
  const cwd = fileURLToPath(new URL("..", import.meta.url))
  const invoke = (...args: string[]) => JSON.parse(execFileSync(process.execPath, ["--import", "tsx", cli, ...args], {
    cwd, env, encoding: "utf8", timeout: 25_000, stdio: ["ignore", "pipe", "pipe"],
  }))
  const file = join(home, "modes.workflow.js")
  writeFileSync(file, `export const meta = {name:"modes-cli",description:"mode replay"}; return "complete"`)
  const first = invoke("run", file, "--typesafe", "--fake", "--no-serve", "--json")
  assert.equal(first.status, "completed")
  assert.equal(invoke("run", file, "--resume", first.runId, "--no-serve", "--json").status, "completed")
  const detached = invoke("run", file, "--resume", first.runId, "--detach", "--no-serve", "--json")
  assert.equal(detached.runId, first.runId)
  // Wait for this new invocation to append its own terminal event: an earlier
  // successful run's terminal status is not proof that the detached resume ran.
  const eventsPath = join(omegaHome, "runs", first.runId, "events.jsonl")
  const deadline = Date.now() + 15_000
  for (;;) {
    const events = readFileSync(eventsPath, "utf8").trim().split("\n").map(line => JSON.parse(line))
    if (events.filter(event => event.type === "run" && event.status === "completed").length >= 3) break
    assert.ok(Date.now() < deadline, "detached resume did not publish its own completion")
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  // A contradiction must survive detached argv forwarding, not be omitted and
  // therefore inherited as true. Its append-only child log records the rejection.
  const rejected = invoke("run", file, "--resume", first.runId, "--typesafe=false", "--detach", "--no-serve", "--json")
  const rejectionDeadline = Date.now() + 15_000
  for (;;) {
    let log = ""
    try { log = readFileSync(rejected.logPath, "utf8") } catch {}
    if (log.includes("explicit --typesafe must match")) break
    assert.ok(Date.now() < rejectionDeadline, "explicit false was not rejected by the detached child")
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  // --fake=false must also remain explicit, not turn into inherited true.
  const fakeRejected = invoke("run", file, "--resume", first.runId, "--fake=false", "--detach", "--no-serve", "--json")
  const fakeDeadline = Date.now() + 15_000
  for (;;) {
    let log = ""
    try { log = readFileSync(fakeRejected.logPath, "utf8") } catch {}
    if (log.includes("explicit --fake must match")) break
    assert.ok(Date.now() < fakeDeadline, "explicit fake false was lost in detached forwarding")
    await new Promise(resolve => setTimeout(resolve, 25))
  }
})
