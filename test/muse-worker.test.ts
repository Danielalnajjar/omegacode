import { after, before, test } from "node:test"
import assert from "node:assert/strict"
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { EventEmitter } from "node:events"
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"

import { MuseWorker, MUSE_MIN_VERSION, type MuseWorkerOpts } from "../src/worker/muse.js"
import { AgentError, AgentInterrupted, type WorkerProgress } from "../src/worker/index.js"
import type { SpawnProcess } from "../src/worker/subprocess-jsonl.js"
import type { AgentSpec, Effort } from "../src/dsl/types.js"

// Tests never read the operator's Muse settings or authentication.
const configRoot = mkdtempSync(join(tmpdir(), "muse-worker-config-"))
const priorData = process.env.XDG_DATA_HOME
const priorXdg = process.env.XDG_CONFIG_HOME
before(() => { process.env.XDG_CONFIG_HOME = configRoot; process.env.XDG_DATA_HOME = configRoot })
after(() => {
  if (priorData === undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME = priorData
  if (priorXdg === undefined) delete process.env.XDG_CONFIG_HOME
  else process.env.XDG_CONFIG_HOME = priorXdg
  rmSync(configRoot, { recursive: true, force: true })
})

class FakeStdin extends EventEmitter {
  writable = true
  chunks: string[] = []
  ended = false
  write(chunk: string, cb?: (err?: Error | null) => void): boolean {
    this.chunks.push(chunk)
    if (cb) queueMicrotask(() => cb(null))
    return true
  }
  end(): void {
    this.ended = true
  }
}

class FakeProc extends EventEmitter {
  readonly stdout = new EventEmitter() as EventEmitter & { setEncoding(e: string): void }
  readonly stderr = new EventEmitter() as EventEmitter & { setEncoding(e: string): void }
  readonly stdin = new FakeStdin()
  kills: string[] = []
  constructor() {
    super()
    ;(this.stdout as any).setEncoding = () => {}
    ;(this.stderr as any).setEncoding = () => {}
  }
  pushLine(obj: unknown): void {
    this.stdout.emit("data", JSON.stringify(obj) + "\n")
  }
  end(code: number | null, signal: string | null = null): void {
    this.emit("exit", code, signal)
    this.emit("close", code, signal)
  }
  kill(signal?: string): boolean {
    this.kills.push(signal ?? "SIGTERM")
    return true
  }
}

interface SpawnCall {
  bin: string
  args: string[]
  cwd?: string
  env?: NodeJS.ProcessEnv
  proc: FakeProc
}

type Script = (p: FakeProc, call: SpawnCall) => void

const versionOk: Script = (p) => {
  p.stdout.emit("data", "1.2.1 (1.2.1-R2847.1)\n")
  p.end(0)
}

function harness(
  scripts: Script[],
  workerOpts: Omit<MuseWorkerOpts, "spawnProcess"> = {},
): { worker: MuseWorker; spawned: SpawnCall[] } {
  const spawned: SpawnCall[] = []
  const queue = [...scripts]
  const spawnProcess: SpawnProcess = (bin, args, opts) => {
    const proc = new FakeProc()
    const call: SpawnCall = { bin, args, cwd: opts.cwd, env: opts.env, proc }
    spawned.push(call)
    const script = queue.shift()
    assert.ok(script, `unexpected spawn #${spawned.length}: ${bin} ${args.join(" ")}`)
    queueMicrotask(() => script(proc, call))
    return proc as any
  }
  return { worker: new MuseWorker({ ...workerOpts, spawnProcess }), spawned }
}

function ctx(signal?: AbortSignal): { signal: AbortSignal; onProgress: (e: WorkerProgress) => void; events: WorkerProgress[] } {
  const events: WorkerProgress[] = []
  return { signal: signal ?? new AbortController().signal, onProgress: (e) => events.push(e), events }
}

function spec(over: Partial<AgentSpec> = {}): AgentSpec {
  return {
    prompt: "do the thing",
    provider: "muse",
    cwd: "/tmp/project",
    sandbox: "read-only",
    approval: "never",
    ...over,
  }
}

function terminal(text = "final", value: unknown = "completed", type = "run.terminal.completed") {
  return { payload_type: type, payload: { terminal: value, text, reason: "measured failure" } }
}
function replay(name: string, code: number | null = 0, signal: string | null = null): Script {
  return (p) => { p.stdout.emit("data", readFileSync(new URL(`./fixtures/muse/${name}.jsonl`, import.meta.url), "utf8")); p.end(code, signal) }
}
function rejects(code: string, retryable = false) {
  return (err: unknown) => { assert.ok(err instanceof AgentError); assert.equal(err.code, code); assert.equal(err.retryable, retryable); return true }
}

// Regression: recorded read/tool/model events map correctly and terminal text is authoritative.
test("Muse replays recorded read-only success without inventing usage", async () => {
  const { worker, spawned } = harness([versionOk, replay("real-readonly")])
  const context = ctx()
  const result = await worker.runAgent(spec({ model: "muse-spark-1.3-contributor", effort: "max", maxTurns: 12 }), context)
  assert.match(result.text, /> hello/)
  assert.deepEqual(result.usage, { inputTokens: 0, outputTokens: 0, costUsd: 0 })
  assert.equal(context.events.filter(e => e.kind === "usage").length, 1)
  assert.ok(context.events.some(e => e.kind === "tool-result" && e.name === "read_file" && e.output?.includes("1|hello")))
  assert.ok(context.events.some(e => e.kind === "phase" && e.phase.includes("muse-spark")))
  assert.ok(context.events.some(e => e.kind === "text"))
  const args = spawned[1]!.args
  for (const flag of ["exec", "--json", "--no-foreign-personal-context", "--disable-web-tools", "--user-input-auto-resolve"]) assert.ok(args.includes(flag))
  for (const [flag, value] of [["--model", "muse-spark-1.3-contributor"], ["--reasoning-effort", "max"], ["--max-model-steps", "12"], ["--permission-profile", "omegacode-read-only"]]) assert.equal(args[args.indexOf(flag!) + 1], value)
  for (const flag of ["--disable-write", "--disable-shell", "--approval-mode", "--approval-judge", "--sandbox-network"]) assert.equal(args.includes(flag), false)
  assert.match(args[args.indexOf("--session-id") + 1]!, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  assert.equal(args.includes("--no-session-log"), false)
  assert.equal(existsSync(args[args.indexOf("--prompt-file") + 1]!), false)
})

// Regression: failed recorded terminals must not become a successful empty result or retry.
test("Muse replays bad-model failure", async () => {
  const { worker } = harness([versionOk, replay("p2-bad-model", 1)])
  await assert.rejects(worker.runAgent(spec(), ctx()), err => { rejects("turn_failed")(err); assert.match((err as Error).message, /definitely-not-a-model/); return true })
})

for (const value of ["failed", "cancelled", "interrupted", "unknown", null, undefined]) {
  // Regression: any non-completed terminal value fails closed and is non-retryable.
  test(`Muse refuses terminal ${value}`, async () => {
    const { worker } = harness([versionOk, p => { p.pushLine({ payload_type: "run.terminal.completed", payload: { terminal: value, text: "ignored", reason: "failure" } }); p.end(0) }])
    await assert.rejects(worker.runAgent(spec(), ctx()), rejects("turn_failed"))
  })
}

// Regression: a completed-looking value on a failed event cannot certify success.
test("Muse requires both completed event type and terminal value", async () => {
  const { worker } = harness([versionOk, p => { p.pushLine(terminal("bad", "completed", "run.terminal.failed")); p.end(0) }])
  await assert.rejects(worker.runAgent(spec(), ctx()), rejects("turn_failed"))
})

// Regression: streamed text and post-terminal messages cannot replace the final answer.
test("Muse accepts a terminal with no items and ignores later items", async () => {
  const { worker } = harness([versionOk, p => {
    p.pushLine(terminal("authoritative"))
    p.pushLine({ payload_type: "run.output.delta", payload: { text: "late" } })
    p.end(0)
  }])
  const context = ctx()
  assert.equal((await worker.runAgent(spec(), context)).text, "authoritative")
  // Only the usage bookkeeping may follow the terminal; the late item must not surface as progress.
  assert.deepEqual(context.events.map(e => e.kind), ["phase", "usage"])
})

for (const [code, signal, error, retryable] of [[0, null, "turn_incomplete", false], [143, null, "provider_exit", false], [null, "SIGTERM", "provider_exit", true]] as const) {
  // Regression: terminal-free EOF distinguishes normal exit, exit code, and external signal death.
  test(`Muse SIGTERM fixture without terminal: ${code}/${signal}`, async () => {
    const { worker } = harness([versionOk, replay("p2-sigterm", code, signal)])
    await assert.rejects(worker.runAgent(spec(), ctx()), rejects(error, retryable))
  })
}

// Regression: malformed/truncated streams cannot be mistaken for completed turns.
test("Muse rejects malformed terminal-free EOF", async () => {
  const { worker } = harness([versionOk, p => { p.stdout.emit("data", 'not json\n{"payload_type":'); p.end(0) }])
  await assert.rejects(worker.runAgent(spec(), ctx()), rejects("turn_incomplete"))
})

// Regression: own cancellation keeps interruption semantics instead of external-exit retry.
test("Muse abort before and during spawn", async () => {
  const ac = new AbortController()
  const { worker, spawned } = harness([versionOk, p => { ac.abort(); p.end(null, "SIGTERM") }])
  await assert.rejects(worker.runAgent(spec(), ctx(ac.signal)), AgentInterrupted)
  assert.ok(spawned[1]!.proc.kills.includes("SIGTERM"))
  await assert.rejects(worker.runAgent(spec(), ctx(ac.signal)), AgentInterrupted)
  assert.equal(spawned.length, 2)
})

// Regression: the shared watchdog remains retryable and removes per-attempt files.
test("Muse stall", async () => {
  const { worker, spawned } = harness([versionOk, p => {
    p.kill = signal => { p.kills.push(signal ?? "SIGTERM"); queueMicrotask(() => p.end(null, signal)); return true }
  }], { stallTimeoutMs: 10 })
  const keepAlive = setTimeout(() => {}, 1000)
  try {
    await assert.rejects(worker.runAgent(spec(), ctx()), rejects("turn_stalled", true))
    const call = spawned[1]!
    assert.ok(call.proc.kills.includes("SIGTERM"))
    assert.equal(existsSync(call.args[call.args.indexOf("--prompt-file") + 1]!), false)
  } finally { clearTimeout(keepAlive) }
})

// Regression: missing executables are normalized without a model spawn.
test("Muse missing binary", async () => {
  const { worker } = harness([p => p.emit("error", new Error("ENOENT"))])
  await assert.rejects(worker.runAgent(spec(), ctx()), rejects("binary_not_found"))
})

// Regression: unsupported sandbox and old version never reach an agent process.
test("Muse preflight rejections", async () => {
  const { worker, spawned } = harness([p => { p.stdout.emit("data", "1.2.0\n"); p.end(0) }])
  await assert.rejects(worker.runAgent(spec({ sandbox: "workspace-write" }), ctx()), rejects("unsupported_sandbox"))
  assert.equal(spawned.length, 0)
  await assert.rejects(worker.runAgent(spec(), ctx()), rejects("provider_outdated"))
  assert.equal(spawned.length, 1)
  assert.equal(MUSE_MIN_VERSION, "1.2.1")
})

for (const effort of ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as Effort[]) {
  // Regression: every effort is forwarded unchanged, including max and ultra.
  test(`Muse effort ${effort} and explicit full access`, async () => {
    const { worker, spawned } = harness([versionOk, p => { p.pushLine(terminal()); p.end(0) }])
    await worker.runAgent(spec({ effort, sandbox: "danger-full-access" }), ctx())
    const args = spawned[1]!.args
    assert.equal(args[args.indexOf("--reasoning-effort") + 1], effort)
    assert.ok(args.includes("--disable-sandbox") && args.includes("--disable-approval"))
    assert.equal(args.includes("--disable-write"), false)
    assert.equal(args.includes("--permission-profile"), false)
    assert.equal(args[args.indexOf("--approval-mode") + 1], "never")
    assert.equal(args[args.indexOf("--approval-judge") + 1], "off")
  })
}

// Regression: schema instructions and corrective instructions stay in one fresh prompt per attempt.
test("Muse schema output uses runtime correction contract, never an extraction turn", async () => {
  const { worker, spawned } = harness([versionOk, (p, call) => {
    const prompt = readFileSync(call.args[call.args.indexOf("--prompt-file") + 1]!, "utf8")
    assert.match(prompt, /corrective instructions/)
    assert.match(prompt, /JSON Schema/)
    p.pushLine(terminal('```json\n{"ok":true}\n```')); p.end(0)
  }, p => { p.pushLine(terminal("not JSON")); p.end(0) }])
  const s = spec({ instructions: "corrective instructions", schema: { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } } })
  assert.deepEqual((await worker.runAgent(s, ctx())).structured, { ok: true })
  assert.equal((await worker.runAgent(s, ctx())).structured, undefined)
  assert.equal(spawned.length, 3)
})

// Regression: invalid author schemas fail before any executable is invoked.
test("Muse invalid schema", async () => {
  const { worker, spawned } = harness([])
  await assert.rejects(worker.runAgent(spec({ schema: { $ref: "#/missing" } }), ctx()), rejects("invalid_schema"))
  assert.equal(spawned.length, 0)
})

// Regression: private configs preserve settings and symlink auth without mutating parent environment.
test("Muse per-call private configuration and concurrent cleanup", { skip: process.platform === "win32" }, async () => {
  const root = mkdtempSync(join(tmpdir(), "muse-config-test-"))
  const previous = process.env.XDG_CONFIG_HOME
  const originalHome = process.env.HOME
  try {
    process.env.XDG_CONFIG_HOME = root
    const source = join(root, "muse")
    mkdirSync(source)
    const settings = { mcpServers: { forbidden: { command: "never" } }, run: { nested: { mcpServers: "preserve" } }, other: 42, permissions: { schema_version: 1, profiles: { personal: { extends: ":read-only" }, "omegacode-read-only": { extends: ":full-access" } } } }
    writeFileSync(join(source, "settings.json"), JSON.stringify(settings))
    writeFileSync(join(source, "auth.json"), "fake-auth-never-copy")
    mkdirSync(join(source, "rules"))
    writeFileSync(join(source, "lock"), "fake lock")
    const paths: string[] = []
    const pending: FakeProc[] = []
    const inspect: Script = (p, call) => {
      const target = join(call.env!.XDG_CONFIG_HOME!, "muse")
      paths.push(target)
      assert.deepEqual(JSON.parse(readFileSync(join(target, "settings.json"), "utf8")), { schema_version: 1, run: settings.run, other: 42, permissions: { ...settings.permissions, profiles: { ...settings.permissions.profiles, "omegacode-read-only": { extends: ":read-only", approval: "allow_all", reviewer: "none" } } } })
      assert.equal(statSync(target).mode & 0o777, 0o700)
      assert.equal(statSync(join(target, "settings.json")).mode & 0o777, 0o600)
      for (const entry of ["auth.json", "rules", "lock"]) {
        assert.equal(lstatSync(join(target, entry)).isSymbolicLink(), true)
        assert.equal(readlinkSync(join(target, entry)), join(source, entry))
      }
      assert.equal(call.env!.HOME, originalHome)
      assert.equal(process.env.XDG_CONFIG_HOME, root)
      pending.push(p)
      if (pending.length === 2) {
        pending[0]!.stderr.emit("data", "first run diagnostic")
        pending[1]!.stderr.emit("data", "second run diagnostic")
        replay("p3-alpha")(pending[0]!, call)
        pending[1]!.pushLine(terminal("BETA")); pending[1]!.end(0)
      }
    }
    const { worker } = harness([versionOk, inspect, inspect])
    const results = await Promise.all([worker.runAgent(spec(), ctx()), worker.runAgent(spec(), ctx())])
    assert.deepEqual(results.map(r => r.text), ["ALPHA", "BETA"])
    assert.equal(new Set(paths).size, 2)
    for (const target of paths) assert.equal(existsSync(dirname(target)), false)
    assert.deepEqual(JSON.parse(readFileSync(join(source, "settings.json"), "utf8")), settings)
    assert.equal(lstatSync(join(source, "auth.json")).isSymbolicLink(), false)
  } finally {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = previous
    rmSync(root, { recursive: true, force: true })
  }
})

// Regression: missing settings still install read-only policy, preserving full-access behavior.
for (const sourceExists of [false, true]) {
  for (const sandbox of ["read-only", "danger-full-access"] as const) {
    test(`Muse missing settings with source=${sourceExists} sandbox=${sandbox}`, async () => {
      const root = mkdtempSync(join(tmpdir(), "muse-empty-config-"))
      const previous = process.env.XDG_CONFIG_HOME
      try {
        process.env.XDG_CONFIG_HOME = root
        if (sourceExists) {
          mkdirSync(join(root, "muse"))
          writeFileSync(join(root, "muse", "auth.json"), "fake-auth")
        }
        const { worker } = harness([versionOk, (p, call) => {
          if (sandbox === "read-only") {
            const target = join(call.env!.XDG_CONFIG_HOME!, "muse")
            assert.notEqual(call.env!.XDG_CONFIG_HOME, root)
            assert.deepEqual(JSON.parse(readFileSync(join(target, "settings.json"), "utf8")), { schema_version: 1, permissions: { schema_version: 1, profiles: { "omegacode-read-only": { extends: ":read-only", approval: "allow_all", reviewer: "none" } } } })
            if (sourceExists) assert.equal(readlinkSync(join(target, "auth.json")), join(root, "muse", "auth.json"))
          } else assert.equal(call.env!.XDG_CONFIG_HOME, root)
          assert.equal(call.env!.HOME, process.env.HOME)
          p.pushLine(terminal()); p.end(0)
        }])
        await worker.runAgent(spec({ sandbox }), ctx())
      } finally {
        if (previous === undefined) delete process.env.XDG_CONFIG_HOME
        else process.env.XDG_CONFIG_HOME = previous
        rmSync(root, { recursive: true, force: true })
      }
    })

  }
}

// Regression: malformed source settings fail as the worker's own error, before any executable is invoked.
test("Muse malformed source settings is invalid_config", async () => {
  const root = mkdtempSync(join(tmpdir(), "muse-bad-config-"))
  const previous = process.env.XDG_CONFIG_HOME
  try {
    process.env.XDG_CONFIG_HOME = root
    mkdirSync(join(root, "muse"))
    writeFileSync(join(root, "muse", "settings.json"), "{ not json")
    const { worker, spawned } = harness([versionOk])
    await assert.rejects(worker.runAgent(spec(), ctx()), rejects("invalid_config"))
    assert.equal(spawned.length, 1)
  } finally {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = previous
    rmSync(root, { recursive: true, force: true })
  }
})

// Regression: an empty XDG value uses the home config without exposing MCP servers.
test("Muse empty XDG_CONFIG_HOME uses private home settings", { skip: process.platform === "win32" }, async () => {
  const home = mkdtempSync(join(tmpdir(), "muse-fake-home-"))
  const previousXdg = process.env.XDG_CONFIG_HOME
  const previousHome = process.env.HOME
  try {
    process.env.HOME = home
    process.env.XDG_CONFIG_HOME = ""
    const source = join(home, ".config", "muse")
    mkdirSync(source, { recursive: true })
    writeFileSync(join(source, "settings.json"), JSON.stringify({ mcpServers: { forbidden: {} }, other: 42 }))
    let settings: unknown
    const { worker, spawned } = harness([versionOk, (p, call) => {
      if (call.env?.XDG_CONFIG_HOME) settings = JSON.parse(readFileSync(join(call.env.XDG_CONFIG_HOME, "muse", "settings.json"), "utf8"))
      assert.equal(call.env!.HOME, home)
      p.pushLine(terminal()); p.end(0)
    }])
    await worker.runAgent(spec(), ctx())
    assert.ok(spawned[1]!.env!.XDG_CONFIG_HOME, "child must receive a private XDG_CONFIG_HOME")
    assert.notEqual(spawned[1]!.env!.XDG_CONFIG_HOME, join(home, ".config"))
    assert.deepEqual(settings, { other: 42, schema_version: 1, permissions: { schema_version: 1, profiles: { "omegacode-read-only": { extends: ":read-only", approval: "allow_all", reviewer: "none" } } } })
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = previousXdg
    rmSync(home, { recursive: true, force: true })
  }
})

test("Muse empty terminal reason names the failed terminal", async () => {
  const { worker } = harness([versionOk, p => {
    p.pushLine({ payload_type: "run.terminal.failed", payload: { terminal: "failed", reason: "" } }); p.end(0)
  }])
  await assert.rejects(worker.runAgent(spec(), ctx()), err => {
    rejects("turn_failed")(err)
    assert.match((err as Error).message, /failed/)
    return true
  })
})

test("Muse unreadable settings is invalid_config before agent spawn", { skip: process.platform === "win32" || process.getuid?.() === 0 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "muse-unreadable-config-"))
  const previous = process.env.XDG_CONFIG_HOME
  const settingsPath = join(root, "muse", "settings.json")
  try {
    process.env.XDG_CONFIG_HOME = root
    mkdirSync(join(root, "muse"))
    writeFileSync(settingsPath, "{}")
    chmodSync(settingsPath, 0o000)
    const { worker, spawned } = harness([versionOk])
    await assert.rejects(worker.runAgent(spec(), ctx()), err => {
      rejects("invalid_config")(err)
      assert.match((err as Error).message, /EACCES/)
      assert.match((err as Error).message, /permission denied/i)
      return true
    })
    assert.equal(spawned.length, 1)
  } finally {
    chmodSync(settingsPath, 0o600)
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = previous
    rmSync(root, { recursive: true, force: true })
  }
})

// Regression: a later contradictory terminal cannot hide behind the first success.
test("Muse rejects conflicting terminals through EOF", async () => {
  const { worker } = harness([versionOk, p => {
    p.pushLine(terminal())
    p.pushLine(terminal("failed", "failed", "run.terminal.failed"))
    p.end(0)
  }])
  await assert.rejects(worker.runAgent(spec(), ctx()), rejects("turn_failed"))
})

// Regression: malformed settings never quote credential-adjacent input into errors or events.
test("Muse malformed settings diagnostic is content-free", async () => {
  const source = join(configRoot, "muse")
  mkdirSync(source, { recursive: true })
  const settings = join(source, "settings.json")
  const sentinel = "SECRET_SENTINEL_TOKEN"
  writeFileSync(settings, sentinel)
  const context = ctx()
  try {
    const { worker } = harness([versionOk])
    await assert.rejects(worker.runAgent(spec(), context), (err: unknown) => {
      assert.ok(err instanceof AgentError)
      assert.equal(err.code, "invalid_config")
      assert.equal(err.message.includes(sentinel), false)
      assert.ok(err.message.includes(settings))
      return true
    })
    assert.equal(JSON.stringify(context.events).includes(sentinel), false)
  } finally { rmSync(settings, { force: true }) }
})

// Regression: cancelling --version interrupts preflight and does not poison the cached check.
test("Muse cancels preflight and retries version on the next attempt", async () => {
  const ac = new AbortController()
  const { worker, spawned } = harness([
    p => { ac.abort(); p.stdout.emit("data", "1.2.1\n"); p.end(0) },
    versionOk,
    p => { p.pushLine(terminal()); p.end(0) },
  ])
  await assert.rejects(worker.runAgent(spec(), ctx(ac.signal)), AgentInterrupted)
  assert.deepEqual(spawned[0]!.proc.kills, ["SIGTERM"])
  assert.equal((await worker.runAgent(spec(), ctx())).text, "final")
  assert.deepEqual(spawned.map(call => call.args[0]), ["--version", "--version", "exec"])
})

// Regression: a SIGTERM-resistant child can recreate XDG until SIGKILL; cleanup must follow close.
test("Muse scratch remains absent after a SIGTERM-resistant child closes", { skip: process.platform === "win32", timeout: 15_000 }, async () => {
  const settings = join(configRoot, "muse", "settings.json")
  mkdirSync(dirname(settings), { recursive: true })
  writeFileSync(settings, "{}")
  const ac = new AbortController()
  let child: ChildProcessWithoutNullStreams | undefined
  let scratch = ""
  let closed = false
  const worker = new MuseWorker({ spawnProcess: (_bin, args, opts) => {
    if (args.includes("--version")) return spawn(process.execPath, ["-e", 'console.log("1.2.1")'])
    scratch = dirname(opts.env!.XDG_CONFIG_HOME!)
    child = spawn(process.execPath, ["-e", `
      const fs = require('node:fs');
      process.on('SIGTERM', () => {});
      setInterval(() => {
        fs.mkdirSync(process.env.XDG_CONFIG_HOME, { recursive: true });
        fs.writeFileSync(process.env.XDG_CONFIG_HOME + '/still-alive', 'yes');
      }, 10);
      console.log(JSON.stringify({payload_type:'run.output.delta',payload:{text:'ready'}}));
    `], { env: opts.env })
    child.on("close", () => { closed = true })
    return child
  } })
  try {
    await assert.rejects(worker.runAgent(spec(), { signal: ac.signal, onProgress: () => ac.abort() }), AgentInterrupted)
    assert.equal(closed, true)
    assert.equal(child!.signalCode, "SIGKILL")
    assert.equal(existsSync(scratch), false)
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.equal(existsSync(scratch), false)
  } finally {
    child?.kill("SIGKILL")
    rmSync(settings, { force: true })
    if (scratch) rmSync(scratch, { recursive: true, force: true })
  }
})

// Regression: cancellation of the shared preflight owner must not cancel another live attempt.
test("Muse retries shared preflight for the uncancelled concurrent attempt", async () => {
  const first = new AbortController()
  const second = new AbortController()
  const { worker, spawned } = harness([
    p => { first.abort(); p.end(null, "SIGTERM") },
    versionOk,
    p => { p.pushLine(terminal()); p.end(0) },
  ])
  const results = await Promise.allSettled([
    worker.runAgent(spec(), ctx(first.signal)),
    worker.runAgent(spec(), ctx(second.signal)),
  ])
  assert.equal(results[0]!.status, "rejected")
  if (results[0]!.status === "rejected") assert.ok(results[0]!.reason instanceof AgentInterrupted)
  assert.equal(second.signal.aborted, false)
  assert.equal(results[1]!.status, "fulfilled")
  if (results[1]!.status === "fulfilled") assert.equal(results[1]!.value.text, "final")
  assert.deepEqual(spawned.map(call => call.args[0]), ["--version", "--version", "exec"])
})

function writeUsageLog(call: SpawnCall, lines: unknown[], child = "") {
  const id = call.args[call.args.indexOf("--session-id") + 1]!
  const path = join(configRoot, "muse", "sessions", "2001", "02", "03", id, child, "session.jsonl")
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, lines.map(line => typeof line === "string" ? line : JSON.stringify(line)).join("\n"))
  return path
}
function completion(usage: unknown) { return { payload: { event: { kind: "model_completed", model: null, usage } } } }
for (const sandbox of ["read-only", "danger-full-access"] as const) {
  test(`Muse sums session and nested subagent usage: ${sandbox}`, async () => {
    const { worker, spawned } = harness([versionOk, (p, call) => {
      writeUsageLog(call, [completion({ input_tokens: 10, output_tokens: 3, cached_tokens: 4, reasoning_tokens: 2 }), "bad secret bytes", completion({ input_tokens: 0, output_tokens: 0 }), completion({ input_tokens: "bad" })])
      writeUsageLog(call, [completion({ input_tokens: 20, output_tokens: 5, cache_read_tokens: 6, cached_tokens: 99, cache_write_tokens: 7 })], "subagent/a/subagent/b")
      p.pushLine(terminal()); p.end(0)
    }])
    const context = ctx()
    const result = await worker.runAgent(spec({ sandbox }), context)
    assert.deepEqual(result.usage, { inputTokens: 30, outputTokens: 8, costUsd: 0, cacheReadInputTokens: 10, cacheCreationInputTokens: 7 })
    assert.deepEqual(context.events.filter(e => e.kind === "usage"), [{ kind: "usage", usage: result.usage }])
    assert.equal(spawned[1]!.args.includes("--no-session-log"), false)
    assert.match(spawned[1]!.args[spawned[1]!.args.indexOf("--session-id") + 1]!, /^[0-9a-f-]{36}$/)
  })
}
for (const problem of ["missing", "malformed", "unreadable", "no-completions"] as const) {
  test(`Muse tolerates ${problem} usage log without exposing content`, async () => {
    const { worker } = harness([versionOk, (p, call) => {
      if (problem === "malformed") writeUsageLog(call, ["SECRET malformed bytes"])
      if (problem === "no-completions") writeUsageLog(call, [{ payload: { event: { kind: "model_started", model: "SECRET" } } }])
      if (problem === "unreadable") { const path = writeUsageLog(call, []); rmSync(path); mkdirSync(path) }
      p.pushLine(terminal()); p.end(0)
    }])
    const context = ctx()
    const result = await worker.runAgent(spec(), context)
    assert.deepEqual(result.usage, { inputTokens: 0, outputTokens: 0, costUsd: 0 })
    const phases = context.events.filter(e => e.kind === "phase")
    assert.equal(phases.length, 1)
    assert.match(JSON.stringify(phases), /session/)
    assert.equal(JSON.stringify(phases).includes("SECRET"), false)
  })
}
test("Muse preserves failed attempt usage on AgentError", async () => {
  const { worker } = harness([versionOk, (p, call) => {
    writeUsageLog(call, [completion({ input_tokens: 12, output_tokens: 2 })])
    p.pushLine(terminal("failed", "failed", "run.terminal.failed")); p.end(1)
  }])
  await assert.rejects(worker.runAgent(spec(), ctx()), error => {
    assert.ok(error instanceof AgentError)
    assert.deepEqual(error.usage, { inputTokens: 12, outputTokens: 2, costUsd: 0 })
    return true
  })
})
