import { test, type TestContext } from "node:test"
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import fs, { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { promisify } from "node:util"
import { fileURLToPath } from "node:url"
import type { AgentSpec } from "../src/dsl/types.js"
import { CursorAcpWorker } from "../src/worker/cursor-acp.ts"
import { AgentError, AgentInterrupted } from "../src/worker/index.ts"

const posixOnly = { skip: process.platform === "win32" }
const persistentOnly = { skip: process.platform !== "darwin" && process.platform !== "linux" }
const bin = fileURLToPath(new URL("./fixtures/cursor-acp/agent.cjs", import.meta.url))
const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url))
const register = fileURLToPath(new URL("./register.mjs", import.meta.url))
const exec = promisify(execFile)

function setup(t: TestContext, scenario: string) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "omega-cursor-fixture-")))
  const home = join(dir, "home")
  mkdirSync(home)
  const previousHome = process.env.HOME
  const previousXdgConfigHome = process.env.XDG_CONFIG_HOME
  process.env.HOME = home
  delete process.env.XDG_CONFIG_HOME
  writeFileSync(join(dir, "scenario"), scenario)
  const worker = new CursorAcpWorker({ bin, requestTimeoutMs: 3000, promptTimeoutMs: 1000, killGraceMs: 50 })
  t.after(async () => {
    try {
      await worker.shutdown()
      rmSync(dir, { recursive: true, force: true })
    } finally {
      if (previousHome === undefined) delete process.env.HOME
      else process.env.HOME = previousHome
      if (previousXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME
      else process.env.XDG_CONFIG_HOME = previousXdgConfigHome
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

test("CLI capabilities and parallel Cursor ACP research work with a configured host home", persistentOnly, async (t) => {
  const { dir, home, records, assertClean } = setup(t, "research")
  const nativeConfig = "fixture configuration; must not be imported"
  const nativeFiles = [".claude/settings.json", ".cursor/mcp.json", ".cursor/hooks.json"].map(file => join(home, file))
  for (const file of nativeFiles) {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, nativeConfig)
  }
  const keychain = join(home, "Library", "Keychains", "login.keychain-db")
  if (process.platform === "darwin") {
    mkdirSync(dirname(keychain), { recursive: true })
    writeFileSync(keychain, "synthetic keychain fixture")
    writeFileSync(join(dirname(keychain), "other.keychain-db"), "not projected")
  }
  // A clean launch home can serve a checkout inside a different user's tree.
  mkdirSync(join(dir, ".cursor"))
  writeFileSync(join(dir, ".cursor", "mcp.json"), "fixture configuration outside the checkout")
  const project = join(dir, "project")
  mkdirSync(join(project, ".git"), { recursive: true })
  mkdirSync(join(project, ".cursor"))
  writeFileSync(join(project, ".cursor", "cli.json"), "{}")
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
  const outcome = JSON.parse(stdout)
  assert.equal(outcome.agentCounts.failed, 0)
  assert.deepEqual(outcome.result, [{ source: "fixture" }, { source: "fixture" }])
  const runs = records(project)
  assert.equal(runs.length, 2)
  assert.notEqual(runs[0][0].config, runs[1][0].config)
  assert.notEqual(runs[0][0].home, runs[1][0].home)
  for (const run of runs) {
    const launch = run[0]
    assert.notEqual(launch.home, home)
    assert.equal(launch.homeMode, 0o700)
    assert.deepEqual(launch.nativeHomeFiles, [])
    if (process.platform === "darwin") {
      assert.equal(launch.keychainAlias, keychain)
      assert.equal(launch.hasOtherKeychain, false)
    } else {
      assert.equal(launch.xdgConfigHome, join(home, ".config"))
    }
    assert.deepEqual(run.filter(frame => frame.method === "session/set_config_option")
      .map(frame => [frame.params.configId, frame.params.value]), [
      ["mode", "ask"], ["model", "grok-4.7"], ["reasoning", "medium"],
    ])
    const prompt = run.find(frame => frame.method === "session/prompt").params.prompt[0].text
    assert.match(prompt, /Cite a primary source/)
    assert.match(prompt, /JSON Schema:\n\{"type":"object"/)
    assertClean(run)
    assert.equal(existsSync(launch.home), false)
  }
  assert.equal(process.env.HOME, home)
  for (const file of nativeFiles) assert.equal(readFileSync(file, "utf8"), nativeConfig)
  if (process.platform === "darwin") assert.equal(readFileSync(keychain, "utf8"), "synthetic keychain fixture")
})

test("Cursor ACP retains the absolute Linux login root without importing extensions", { skip: process.platform !== "linux" }, async (t) => {
  const { dir, home, worker, spec, records, assertClean } = setup(t, "research")
  const xdg = join(dir, "xdg-config")
  process.env.XDG_CONFIG_HOME = xdg
  for (const root of [join(home, ".cursor"), join(xdg, "cursor")]) {
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, "hooks.json"), "fixture hooks; must not be imported")
  }
  const { text } = await worker.runAgent(spec, { signal: new AbortController().signal, onProgress() {} })
  assert.deepEqual(JSON.parse(text), { source: "fixture" })
  const [run] = records()
  assert.equal(run[0].xdgConfigHome, xdg)
  assert.deepEqual(run[0].nativeHomeFiles, [])
  assert.equal(run[0].hasConfigHooks, false)
  assertClean(run)
})

test("Cursor ACP keeps the managed Linux guest launcher on its original home", { skip: process.platform !== "linux" }, async (t) => {
  const { dir, home, spec, records, assertClean } = setup(t, "research")
  const exists = fs.existsSync
  t.mock.method(fs, "existsSync", (path: fs.PathLike) => path === "/etc/thread-vm/base-verified" || exists(path))
  const launcher = join(home, ".local", "bin", "thread-vm-cursor")
  mkdirSync(dirname(launcher), { recursive: true })
  symlinkSync(bin, launcher)
  const worker = new CursorAcpWorker({ bin: launcher })
  t.after(() => worker.shutdown())
  const ctx = { signal: new AbortController().signal, onProgress() {} }
  await worker.runAgent(spec, ctx)
  const [run] = records(dir)
  assert.equal(run[0].home, home)
  assertClean(run)

  mkdirSync(join(home, ".claude"))
  writeFileSync(join(home, ".claude", "settings.json"), "{}")
  await assert.rejects(worker.runAgent(spec, ctx), { code: "invalid_config", message: /without native MCP/ })
  assert.equal(records(dir).length, 1)
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

for (const [scope, file] of [
  ["workspace", ".cursor/mcp.json"],
  ["git root", ".cursor/hooks.json"],
  ["workspace", ".claude/settings.local.json"],
]) {
  test(`Cursor ACP refuses native extension configuration before launch: ${scope} ${file}`, posixOnly, async (t) => {
    const { dir, worker, spec, records } = setup(t, "research")
    const config = join(dir, file)
    mkdirSync(dirname(config), { recursive: true })
    writeFileSync(config, "fixture configuration; must not be read")
    if (scope === "git root") {
      mkdirSync(join(dir, ".git"))
      spec.cwd = join(dir, "nested")
      mkdirSync(spec.cwd)
    }
    await assert.rejects(worker.runAgent(spec, { signal: new AbortController().signal, onProgress() {} }),
      { code: "invalid_config", message: /without native MCP/ })
    assert.deepEqual(records(spec.cwd), [])
  })
}

test("Cursor ACP refuses machine-managed hooks before launch", persistentOnly, async (t) => {
  const { worker, spec, records } = setup(t, "research")
  const machineHooks = process.platform === "darwin" ? "/Library/Application Support/Cursor/hooks.json" : "/etc/cursor/hooks.json"
  const lstat = fs.promises.lstat
  t.mock.method(fs.promises, "lstat", (path: fs.PathLike) => lstat(path === machineHooks ? join(spec.cwd, "scenario") : path))
  await assert.rejects(worker.runAgent(spec, { signal: new AbortController().signal, onProgress() {} }),
    { code: "invalid_config", message: /without native MCP/ })
  assert.deepEqual(records(), [])
})

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
