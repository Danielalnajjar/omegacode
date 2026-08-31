import { test } from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { runWorkflow } from "../src/runtime/run.ts"
import { CLAUDE_PROFILE_AUTH_CONFLICTS } from "../src/worker/claude-profile.ts"
import { runClaudeProfileSmoke } from "../scripts/claude-profile-smoke.mjs"

const posixOnly = { skip: process.platform === "win32" }
const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const authControls = Object.values(CLAUDE_PROFILE_AUTH_CONFLICTS).flat()

async function waitForFile(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

function within<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs)
    promise.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (error) => { clearTimeout(timer); reject(error) },
    )
  })
}

test("profile smoke child exits 78 on abandon without invoking real Claude", posixOnly, async () => {
  const parent = mkdtempSync(join(tmpdir(), "omega-profile-smoke-child-abandon-"))
  const runRoot = join(parent, "owned-run")
  const cwd = join(runRoot, "A1")
  const trace = join(runRoot, "trace")
  const fakeClaude = join(parent, "claude-real")
  const claudeMarker = join(parent, "claude-invoked")
  mkdirSync(cwd, { recursive: true })
  writeFileSync(fakeClaude, [
    `#!${process.execPath}`,
    `require("node:fs").writeFileSync(${JSON.stringify(claudeMarker)}, "invoked")`,
  ].join("\n"), { mode: 0o700 })
  chmodSync(fakeClaude, 0o700)

  const child = spawn(join(root, "scripts", "claude-profile-smoke-exec.sh"), [], {
    cwd,
    env: {
      ...process.env,
      CLAUDE_CONFIG_DIR: "/profiles/profile-a",
      OMEGA_PROFILE_SMOKE_NODE: process.execPath,
      OMEGA_PROFILE_SMOKE_CHILD_HELPER: join(root, "scripts", "claude-profile-smoke-child.mjs"),
      OMEGA_PROFILE_SMOKE_TRACE: trace,
      OMEGA_PROFILE_SMOKE_NONCE: "direct-abandon-test",
      OMEGA_PROFILE_SMOKE_REAL_CLAUDE: fakeClaude,
      OMEGA_PROFILE_SMOKE_RUN_ROOT: runRoot,
      OMEGA_PROFILE_SMOKE_DEADLINE_AT: String(Date.now() + 60_000),
    },
    stdio: "pipe",
  })
  let exited = false
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject)
    child.once("exit", (code, signal) => { exited = true; resolve({ code, signal }) })
  })

  try {
    await waitForFile(join(trace, "A1.arrival.json"), 2_000)
    const started = Date.now()
    writeFileSync(join(trace, "abandon"), "abandon", { flag: "wx", mode: 0o600 })
    const result = await within(exit, 2_000, "child ignored abandon until its distant deadline")
    assert.deepEqual(result, { code: 78, signal: null })
    assert.ok(Date.now() - started < 2_000, "abandon did not settle promptly")
    assert.equal(existsSync(claudeMarker), false, "abandoned child invoked real Claude")
  } finally {
    if (!exited) {
      child.kill("SIGKILL")
      await within(exit.catch(() => ({ code: null, signal: null })), 2_000, "child did not terminate during cleanup").catch(() => undefined)
    }
    rmSync(parent, { recursive: true, force: true })
  }
})

test("profile smoke rejects a relative owned root before orchestration", async () => {
  await assert.rejects(
    runClaudeProfileSmoke({
      profileA: "profile-a",
      profileB: "profile-b",
      model: "claude-test",
      realClaude: "/bin/true",
      realBb: "/bin/true",
      runWorkflow,
      root: "relative-owned-run",
    }),
    /root must be absolute/,
  )
})

test("profile smoke exact resolution is bounded by the shared deadline", posixOnly, async () => {
  const parent = mkdtempSync(join(tmpdir(), "omega-profile-smoke-preflight-deadline-"))
  const runRoot = join(parent, "owned-run")
  const fakeBb = join(parent, "bb-real")
  const fakeClaude = join(parent, "claude-real")
  writeFileSync(fakeBb, `#!${process.execPath}\nsetInterval(() => {}, 1000)\n`, { mode: 0o700 })
  writeFileSync(fakeClaude, `#!${process.execPath}\n`, { mode: 0o700 })
  chmodSync(fakeBb, 0o700)
  chmodSync(fakeClaude, 0o700)

  const started = Date.now()
  try {
    await assert.rejects(
      runClaudeProfileSmoke({
        profileA: "profile-a",
        profileB: "profile-b",
        model: "claude-test",
        realClaude: fakeClaude,
        realBb: fakeBb,
        runWorkflow,
        root: runRoot,
        deadlineMs: 200,
      }),
      /could not exact-resolve profile-a/,
    )
    assert.ok(Date.now() - started < 2_000, "exact resolution exceeded the shared deadline")
    assert.equal(existsSync(runRoot), false, "preflight failure left the owned root")
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
})

test("profile smoke missing-third path aborts, settles owned children, and removes its run root", posixOnly, async () => {
  const parent = mkdtempSync(join(tmpdir(), "omega-profile-smoke-test-"))
  const root = join(parent, "owned-run")
  const fakeBb = join(parent, "bb-real")
  const fakeClaude = join(parent, "claude-real")
  writeFileSync(fakeBb, [
    `#!${process.execPath}`,
    `const id = process.argv[process.argv.indexOf("--profile-id") + 1]`,
    `if (!['profile-a', 'profile-b'].includes(id)) process.exit(78)`,
    `process.stdout.write(JSON.stringify({ profileId: id, label: id, configDir: '/profiles/' + id, claudeCodeExecutable: ${JSON.stringify(fakeClaude)} }))`,
  ].join("\n"), { mode: 0o700 })
  writeFileSync(fakeClaude, `#!${process.execPath}\nsetInterval(() => {}, 1000)\n`, { mode: 0o700 })
  chmodSync(fakeBb, 0o700)
  chmodSync(fakeClaude, 0o700)

  const saved = Object.fromEntries(authControls.map((key) => [key, process.env[key]]))
  for (const key of authControls) delete process.env[key]
  const started = Date.now()
  try {
    await assert.rejects(
      runClaudeProfileSmoke({
        profileA: "profile-a",
        profileB: "profile-b",
        model: "claude-test",
        realClaude: fakeClaude,
        realBb: fakeBb,
        runWorkflow,
        root,
        dropLane: "A2",
        deadlineMs: 750,
        nonce: "missing-third-test",
      }),
      /deadline expired|ended before all children arrived/,
    )
    assert.ok(Date.now() - started < 10_000, "missing-third cleanup exceeded its bounded deadline")
    assert.equal(existsSync(root), false, "run-owned trace directory survived failure cleanup")
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(parent, { recursive: true, force: true })
  }
})

test("profile smoke abandons wrong child bindings without invoking real Claude", posixOnly, async () => {
  const parent = mkdtempSync(join(tmpdir(), "omega-profile-smoke-mismatch-test-"))
  const root = join(parent, "owned-run")
  const fakeBb = join(parent, "bb-real")
  const fakeClaude = join(parent, "claude-real")
  const claudeMarker = join(parent, "claude-invoked")
  writeFileSync(fakeBb, [
    `#!${process.execPath}`,
    `const id = process.argv[process.argv.indexOf("--profile-id") + 1]`,
    `if (!['profile-a', 'profile-b'].includes(id)) process.exit(78)`,
    `const wrongAfterValidation = Boolean(process.env.OMEGA_PROFILE_SMOKE_TRACE) && id === 'profile-a'`,
    `const configDir = wrongAfterValidation ? '/profiles/wrong-profile-a' : '/profiles/' + id`,
    `process.stdout.write(JSON.stringify({ profileId: id, label: id, configDir, claudeCodeExecutable: ${JSON.stringify(fakeClaude)} }))`,
  ].join("\n"), { mode: 0o700 })
  writeFileSync(fakeClaude, [
    `#!${process.execPath}`,
    `require("node:fs").writeFileSync(${JSON.stringify(claudeMarker)}, "invoked")`,
  ].join("\n"), { mode: 0o700 })
  chmodSync(fakeBb, 0o700)
  chmodSync(fakeClaude, 0o700)

  const saved = Object.fromEntries(authControls.map((key) => [key, process.env[key]]))
  for (const key of authControls) delete process.env[key]
  try {
    await assert.rejects(
      runClaudeProfileSmoke({
        profileA: "profile-a",
        profileB: "profile-b",
        model: "claude-test",
        realClaude: fakeClaude,
        realBb: fakeBb,
        runWorkflow,
        root,
        deadlineMs: 2_000,
        nonce: "wrong-binding-test",
      }),
      /did not observe its expected binding/,
    )
    assert.equal(existsSync(claudeMarker), false, "wrongly bound child invoked real Claude")
    assert.equal(existsSync(root), false, "run-owned trace directory survived binding rejection")
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(parent, { recursive: true, force: true })
  }
})

test("profile smoke proves a successful direct-SDK A/B/A run and ignores inherited fault injection", posixOnly, async () => {
  const parent = mkdtempSync(join(tmpdir(), "omega-profile-smoke-success-test-"))
  const runRoot = join(parent, "owned-run")
  const receiptPath = join(parent, "receipt.json")
  const fakeBb = join(parent, "bb-real")
  const fakeClaude = join(parent, "claude-real")
  writeFileSync(fakeBb, [
    `#!${process.execPath}`,
    `const id = process.argv[process.argv.indexOf("--profile-id") + 1]`,
    `if (!['profile-a', 'profile-b'].includes(id)) process.exit(78)`,
    `process.stdout.write(JSON.stringify({ profileId: id, label: id, configDir: '/profiles/' + id, claudeCodeExecutable: ${JSON.stringify(fakeClaude)} }))`,
  ].join("\n"), { mode: 0o700 })
  writeFileSync(fakeClaude, [
    `#!${process.execPath}`,
    `const path = require('node:path')`,
    `const lane = path.basename(process.cwd())`,
    `const result = lane + ':' + process.env.OMEGA_PROFILE_SMOKE_NONCE`,
    `const session = '00000000-0000-4000-8000-000000000001'`,
    `console.log(JSON.stringify({ type: 'system', subtype: 'init', cwd: process.cwd(), session_id: session, tools: [], mcp_servers: [], model: 'claude-test', permissionMode: 'default', slash_commands: [], apiKeySource: 'none', output_style: 'default' }))`,
    `console.log(JSON.stringify({ type: 'assistant', message: { id: 'msg_1', role: 'assistant', content: [{ type: 'text', text: result }], model: 'claude-test', stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }, parent_tool_use_id: null, session_id: session }))`,
    `console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, duration_ms: 1, duration_api_ms: 1, num_turns: 1, result, session_id: session, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, modelUsage: {}, permission_denials: [] }))`,
  ].join("\n"), { mode: 0o700 })
  chmodSync(fakeBb, 0o700)
  chmodSync(fakeClaude, 0o700)

  const saved = Object.fromEntries([...authControls, "OMEGA_PROFILE_SMOKE_DROP_LANE"].map((key) => [key, process.env[key]]))
  for (const key of authControls) delete process.env[key]
  process.env.OMEGA_PROFILE_SMOKE_DROP_LANE = "A2"
  try {
    const receipt = await runClaudeProfileSmoke({
      profileA: "profile-a",
      profileB: "profile-b",
      model: "claude-test",
      realClaude: fakeClaude,
      realBb: fakeBb,
      runWorkflow,
      root: runRoot,
      receiptPath,
      deadlineMs: 5_000,
      nonce: "successful-a-b-a",
    })
    assert.deepEqual(receipt.resultMarkers, ["A1:successful-a-b-a", "B:successful-a-b-a", "A2:successful-a-b-a"])
    assert.equal(receipt.routeBoundary, "direct-claude-agent-sdk")
    assert.equal(receipt.observedDirectSdkChildren, 3)
    assert.equal("acpStarts" in receipt, false)
    assert.deepEqual(JSON.parse(readFileSync(receiptPath, "utf8")), receipt)
    assert.equal(existsSync(runRoot), false, "run-owned trace directory survived successful cleanup")
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(parent, { recursive: true, force: true })
  }
})
