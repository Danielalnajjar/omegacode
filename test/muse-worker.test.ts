import { after, before, test } from "node:test"
import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"

import { MuseWorker, MUSE_MIN_VERSION, type MuseWorkerOpts } from "../src/worker/muse.js"
import { AgentError, AgentInterrupted, type WorkerProgress } from "../src/worker/index.js"
import type { SpawnProcess } from "../src/worker/subprocess-jsonl.js"
import type { AgentSpec, Effort } from "../src/dsl/types.js"

// Tests never read the operator's Muse settings or authentication.
const configRoot = mkdtempSync(join(tmpdir(), "muse-worker-config-"))
const priorXdg = process.env.XDG_CONFIG_HOME
before(() => { process.env.XDG_CONFIG_HOME = configRoot })
after(() => {
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
  assert.equal(context.events.some(e => e.kind === "usage"), false)
  assert.ok(context.events.some(e => e.kind === "tool-result" && e.name === "read_file" && e.output?.includes("1|hello")))
  assert.ok(context.events.some(e => e.kind === "phase" && e.phase.includes("muse-spark")))
  assert.ok(context.events.some(e => e.kind === "text"))
  const args = spawned[1]!.args
  for (const flag of ["exec", "--json", "--disable-write", "--disable-shell", "--no-session-log", "--no-foreign-personal-context", "--disable-web-tools", "--user-input-auto-resolve"]) assert.ok(args.includes(flag))
  for (const [flag, value] of [["--model", "muse-spark-1.3-contributor"], ["--reasoning-effort", "max"], ["--max-model-steps", "12"], ["--approval-mode", "never"], ["--approval-judge", "off"]]) assert.equal(args[args.indexOf(flag!) + 1], value)
  assert.equal(args.includes("--session-id"), false)
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
  assert.deepEqual(context.events, [])
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
  const { worker, spawned } = harness([versionOk, () => {}], { stallTimeoutMs: 10 })
  const keepAlive = setTimeout(() => {}, 1000)
  try {
    await assert.rejects(worker.runAgent(spec(), ctx()), rejects("turn_stalled", true))
    const call = spawned[1]!
    assert.ok(call.proc.kills.includes("SIGTERM"))
    assert.equal(existsSync(call.args[call.args.indexOf("--prompt-file") + 1]!), false)
    call.proc.end(null, "SIGTERM")
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
    const settings = { mcpServers: { forbidden: { command: "never" } }, run: { nested: { mcpServers: "preserve" } }, other: 42 }
    writeFileSync(join(source, "settings.json"), JSON.stringify(settings))
    writeFileSync(join(source, "auth.json"), "fake-auth-never-copy")
    mkdirSync(join(source, "rules"))
    writeFileSync(join(source, "lock"), "fake lock")
    const paths: string[] = []
    const pending: FakeProc[] = []
    const inspect: Script = (p, call) => {
      const target = join(call.env!.XDG_CONFIG_HOME!, "muse")
      paths.push(target)
      assert.deepEqual(JSON.parse(readFileSync(join(target, "settings.json"), "utf8")), { run: settings.run, other: 42 })
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

// Regression: missing source settings means no private override or inherited-home rewrite.
test("Muse missing source settings preserves XDG_CONFIG_HOME", async () => {
  const root = mkdtempSync(join(tmpdir(), "muse-empty-config-"))
  const previous = process.env.XDG_CONFIG_HOME
  try {
    process.env.XDG_CONFIG_HOME = root
    const { worker } = harness([versionOk, (p, call) => {
      assert.equal(call.env!.XDG_CONFIG_HOME, root)
      assert.equal(call.env!.HOME, process.env.HOME)
      p.pushLine(terminal()); p.end(0)
    }])
    await worker.runAgent(spec(), ctx())
  } finally {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = previous
    rmSync(root, { recursive: true, force: true })
  }
})
