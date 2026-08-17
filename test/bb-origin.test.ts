import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { runWorkflow } from "../src/runtime/run.ts"

test("a run launched inside bb records its original thread without leaking connection context", async () => {
  const root = mkdtempSync(join(tmpdir(), "omegacode-bb-origin-"))
  const workflow = join(root, "origin.workflow.js")
  writeFileSync(
    workflow,
    `export const meta = { name: "origin", description: "origin test" }\nreturn { ok: true }\n`,
    "utf8",
  )
  const saved = saveEnvironment([
    "OMEGACODE_HOME",
    "BB_THREAD_ID",
    "BB_PROJECT_ID",
    "BB_ENVIRONMENT_ID",
    "BB_SERVER_URL",
  ])

  try {
    process.env.OMEGACODE_HOME = join(root, "home")
    process.env.BB_THREAD_ID = "thr_origin"
    process.env.BB_PROJECT_ID = "proj_origin"
    process.env.BB_ENVIRONMENT_ID = "env_origin"
    process.env.BB_SERVER_URL = "https://must-not-be-persisted.example"

    const first = await runWorkflow({ file: workflow, fake: true, quiet: true })
    const originPath = join(process.env.OMEGACODE_HOME, "runs", first.runId, "bb-origin.json")
    const firstOrigin = JSON.parse(readFileSync(originPath, "utf8"))
    assert.deepEqual(firstOrigin, {
      schemaVersion: 1,
      threadId: "thr_origin",
      projectId: "proj_origin",
      environmentId: "env_origin",
      capturedAt: firstOrigin.capturedAt,
    })
    assert.equal(typeof firstOrigin.capturedAt, "number")
    assert.equal("serverUrl" in firstOrigin, false)

    process.env.BB_THREAD_ID = "thr_resume_elsewhere"
    await runWorkflow({
      file: workflow,
      fake: true,
      quiet: true,
      resumeRunId: first.runId,
    })
    assert.equal(JSON.parse(readFileSync(originPath, "utf8")).threadId, "thr_origin")

    delete process.env.BB_THREAD_ID
    const unattributed = await runWorkflow({ file: workflow, fake: true, quiet: true })
    assert.equal(
      existsSync(join(process.env.OMEGACODE_HOME, "runs", unattributed.runId, "bb-origin.json")),
      false,
    )
  } finally {
    restoreEnvironment(saved)
    rmSync(root, { recursive: true, force: true })
  }
})

function saveEnvironment(names: string[]): Map<string, string | undefined> {
  return new Map(names.map((name) => [name, process.env[name]]))
}

function restoreEnvironment(saved: Map<string, string | undefined>): void {
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
}
