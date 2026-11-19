import { test, type TestContext } from "node:test"
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { fileURLToPath } from "node:url"
import type { AgentSpec } from "../src/dsl/types.js"
import { CursorAcpWorker } from "../src/worker/cursor-acp.ts"
import { AgentError, AgentInterrupted } from "../src/worker/index.ts"

const posixOnly = { skip: process.platform === "win32" }
const bin = fileURLToPath(new URL("./fixtures/cursor-acp/agent.cjs", import.meta.url))
const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url))
const register = fileURLToPath(new URL("./register.mjs", import.meta.url))
const exec = promisify(execFile)

function setup(t: TestContext, scenario: string) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "omega-cursor-fixture-")))
  const home = join(dir, "home")
  mkdirSync(home)
  const previousHome = process.env.HOME
  process.env.HOME = home
  writeFileSync(join(dir, "scenario"), scenario)
  const worker = new CursorAcpWorker({ bin, requestTimeoutMs: 3000, promptTimeoutMs: 1000, killGraceMs: 50 })
  t.after(async () => {
    try {
      await worker.shutdown()
      rmSync(dir, { recursive: true, force: true })
    } finally {
      if (previousHome === undefined) delete process.env.HOME
      else process.env.HOME = previousHome
    }
  })
  const spec: AgentSpec = {
    cwd: dir, provider: "acp-cursor", model: "grok-4.7", effort: "medium",
    sandbox: "read-only", approval: "never", prompt: "Inspect the fixture",
  }
  const records = (cwd = dir) => readdirSync(cwd).filter(name => name.endsWith(".jsonl")).map(name =>
    readFileSync(join(cwd, name), "utf8").trim().split("\n").map(line => JSON.parse(line)))
  const assertClean = (record: ReturnType<typeof records>[number]) => {
    assert.equal(existsSync(record[0].config), false, "scratch state was removed")
    assert.throws(() => process.kill(record[0].pid, 0), { code: "ESRCH" }, "fixture process exited")
  }
  return { dir, home, worker, spec, records, assertClean }
}

test("CLI capabilities and parallel Cursor ACP research use the exact configured model and return validated JSON", posixOnly, async (t) => {
  const { dir, records, assertClean } = setup(t, "research")
  // A clean launch home can serve a checkout inside a different user's tree.
  mkdirSync(join(dir, ".cursor"))
  writeFileSync(join(dir, ".cursor", "mcp.json"), "fixture configuration outside the checkout")
  const project = join(dir, "project")
  mkdirSync(join(project, ".git"), { recursive: true })
  writeFileSync(join(project, "scenario"), "research")
  const env = { ...process.env, OMEGACODE_HOME: join(dir, "omega-home"), CURSOR_AGENT_BIN: bin,
    CURSOR_AUTH_TOKEN: "fixture-not-a-credential" }
  const flags = { cwd: project, env, timeout: 20_000 }
  const { stdout: caps } = await exec(process.execPath, ["--import", register, cli, "capabilities", "--json"], flags)
  assert.ok(JSON.parse(caps).providers.includes("acp-cursor"))
  assert.deepEqual(records(project), [], "capabilities did not spawn the fixture")

  const workflow = join(dir, "research.workflow.js")
  writeFileSync(workflow, `
    export const meta = { name: "cursor-research", description: "Fixture-backed research" }
    return await parallel(["alpha", "beta"].map(unit => () => agent("Inspect the fixture " + unit, {
      instructions: "Cite a primary source.",
      schema: { type: "object", properties: { source: { const: "fixture" } }, required: ["source"] }
    })))
  `)
  const { stdout } = await exec(process.execPath, ["--import", register, cli, "run", workflow,
    "--provider", "acp-cursor", "--model", "grok-4.7", "--effort", "medium", "--no-serve", "--json"], flags)
  assert.deepEqual(JSON.parse(stdout).result, [{ source: "fixture" }, { source: "fixture" }])
  const runs = records(project)
  assert.equal(runs.length, 2)
  assert.notEqual(runs[0][0].config, runs[1][0].config)
  for (const run of runs) {
    assert.deepEqual(run.filter(frame => frame.method === "session/set_config_option")
      .map(frame => [frame.params.configId, frame.params.value]), [
      ["mode", "ask"], ["model", "grok-4.7"], ["reasoning", "medium"],
    ])
    const prompt = run.find(frame => frame.method === "session/prompt").params.prompt[0].text
    assert.match(prompt, /Cite a primary source/)
    assert.match(prompt, /JSON Schema:\n\{"type":"object"/)
    assertClean(run)
  }
})

test("Cursor ACP refuses unauthenticated sessions distinctly without leaking diagnostics or authenticating", posixOnly, async (t) => {
  const { worker, spec, records, assertClean } = setup(t, "auth")
  await assert.rejects(worker.runAgent(spec, { signal: new AbortController().signal, onProgress() {} }),
    (error: unknown) => error instanceof AgentError && error.code === "auth_required" && !error.retryable
      && !error.message.includes("fixture-private-diagnostic"))
  const [run] = records()
  assert.deepEqual(run.slice(1).map(frame => frame.method), ["initialize", "session/new"])
  assertClean(run)
})

for (const scenario of ["no-effort", "wrong-model"]) {
  test(`Cursor ACP fails closed before prompting when config cannot be verified: ${scenario}`, posixOnly, async (t) => {
    const { worker, spec, records, assertClean } = setup(t, scenario)
    await assert.rejects(worker.runAgent(spec, { signal: new AbortController().signal, onProgress() {} }),
      { code: "invalid_config" })
    const [run] = records()
    assert.equal(run.some(frame => frame.method === "session/prompt"), false)
    assertClean(run)
  })
}

test("Cursor ACP rejects writable sandbox requests before spawn", posixOnly, async (t) => {
  const { worker, spec, records } = setup(t, "research")
  await assert.rejects(worker.runAgent({ ...spec, sandbox: "danger-full-access" }, {
    signal: new AbortController().signal, onProgress() {},
  }), { code: "unsupported_option" })
  assert.deepEqual(records(), [])
})

for (const scope of ["home", "workspace"] as const) {
  test(`Cursor ACP refuses native MCP configuration before launch: ${scope}`, posixOnly, async (t) => {
    const { dir, home, worker, spec, records } = setup(t, "research")
    const config = join(scope === "home" ? home : dir, ".cursor")
    mkdirSync(config)
    writeFileSync(join(config, "mcp.json"), "fixture configuration; must not be read")
    await assert.rejects(worker.runAgent(spec, { signal: new AbortController().signal, onProgress() {} }),
      { code: "invalid_config", message: /without native MCP/ })
    assert.deepEqual(records(), [])
  })
}

test("Cursor ACP returns a plain answer without the internal completion marker", posixOnly, async (t) => {
  const { worker, spec, records, assertClean } = setup(t, "plain")
  const output: string[] = []
  const result = await worker.runAgent(spec, {
    signal: new AbortController().signal,
    onProgress(progress) { if (progress.kind === "text") output.push(progress.text) },
  })
  assert.equal(result.text, "Read-only fixture result.")
  assert.deepEqual(output, [result.text])
  assertClean(records()[0])
})

for (const [scenario, code] of [
  ["backend-auth", "auth_required"], ["backend-unknown", "provider_error"],
]) {
  test(`Cursor ACP treats error chunks before end_turn as sanitized failures: ${scenario}`, posixOnly, async (t) => {
    const { worker, spec, records, assertClean } = setup(t, scenario)
    const output: string[] = []
    await assert.rejects(worker.runAgent(spec, {
      signal: new AbortController().signal,
      onProgress(progress) { if (progress.kind === "text") output.push(progress.text) },
    }), (error: unknown) => error instanceof AgentError && error.code === code &&
      !error.retryable && !error.message.includes("fixture-private-diagnostic"))
    assert.deepEqual(output, [])
    assertClean(records()[0])
  })
}

test("Cursor ACP timeout cancels and reaps a peer that ignores SIGTERM", posixOnly, async (t) => {
  const { worker, spec, records, assertClean } = setup(t, "timeout")
  await assert.rejects(worker.runAgent(spec, { signal: new AbortController().signal, onProgress() {} }),
    { code: "request_timeout" })
  const [run] = records()
  assert.equal(run.some(frame => frame.method === "session/cancel"), true)
  assert.equal(run.some(frame => frame.term === true), true)
  assertClean(run)
})

test("Cursor ACP user abort interrupts the turn and removes its state", posixOnly, async (t) => {
  const { worker, spec, records, assertClean } = setup(t, "cancel")
  const controller = new AbortController()
  await assert.rejects(worker.runAgent(spec, {
    signal: controller.signal,
    onProgress(progress) {
      if (progress.kind === "reasoning") controller.abort()
    },
  }), AgentInterrupted)
  const [run] = records()
  assert.equal(run.some(frame => frame.method === "session/cancel"), true)
  assertClean(run)
})
