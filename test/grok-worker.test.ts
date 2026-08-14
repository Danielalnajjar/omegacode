import { test } from "node:test"
import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { readFileSync } from "node:fs"

import { GrokWorker, GROK_MIN_VERSION } from "../src/worker/grok.js"
import { AgentError, AgentInterrupted, type WorkerProgress } from "../src/worker/index.js"
import type { SpawnProcess } from "../src/worker/subprocess-jsonl.js"
import type { AgentSpec, Effort } from "../src/dsl/types.js"

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
  p.stdout.emit("data", "grok 0.2.121 (deadbeef)\n")
  p.end(0)
}

function harness(scripts: Script[]): { worker: GrokWorker; spawned: SpawnCall[] } {
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
  return { worker: new GrokWorker({ spawnProcess }), spawned }
}

function ctx(signal?: AbortSignal): { signal: AbortSignal; onProgress: (e: WorkerProgress) => void; events: WorkerProgress[] } {
  const events: WorkerProgress[] = []
  return { signal: signal ?? new AbortController().signal, onProgress: (e) => events.push(e), events }
}

function spec(over: Partial<AgentSpec> = {}): AgentSpec {
  return {
    prompt: "do the thing",
    provider: "grok",
    cwd: "/tmp/project",
    sandbox: "read-only",
    approval: "never",
    ...over,
  }
}

const happyRun: Script = (p) => {
  p.pushLine({ type: "thought", data: "thinking…" })
  p.pushLine({
    type: "tool_call",
    toolCallId: "c1",
    toolName: "read_file",
    rawInput: { path: "src/a.ts" },
  })
  p.pushLine({
    type: "tool_call_update",
    toolCallId: "c1",
    status: "completed",
    rawOutput: { lines: 12 },
  })
  p.pushLine({ type: "text", data: "Hello world" })
  p.pushLine({
    type: "end",
    stopReason: "end_turn",
    sessionId: "ses_1",
    usage: {
      input_tokens: 100,
      output_tokens: 20,
      reasoning_tokens: 5,
      cache_read_input_tokens: 10,
      cache_creation_input_tokens: 2,
    },
    total_cost_usd: 0.01,
  })
  p.end(0)
}

function flagAfter(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag)
  return i === -1 ? undefined : args[i + 1]
}

test("happy path: argv shape, prompt file, event mapping, usage normalization", async () => {
  const h = harness([versionOk, happyRun])
  const c = ctx()
  const result = await h.worker.runAgent(spec({ model: "grok-4.6", effort: "high" }), c)

  assert.equal(h.spawned.length, 2)
  assert.deepEqual(h.spawned[0]!.args, ["--version"])
  const args = h.spawned[1]!.args
  assert.equal(flagAfter(args, "--cwd"), "/tmp/project")
  assert.equal(flagAfter(args, "--sandbox"), "read-only")
  assert.equal(flagAfter(args, "--output-format"), "streaming-json")
  assert.equal(flagAfter(args, "-m"), "grok-4.6")
  assert.equal(flagAfter(args, "--reasoning-effort"), "high")
  assert.equal(flagAfter(args, "--permission-mode"), "plan")
  assert.ok(args.includes("--no-auto-update"))
  assert.ok(args.includes("--no-subagents"))
  assert.ok(!args.includes("--always-approve"))
  const promptPath = flagAfter(args, "--prompt-file")
  assert.ok(promptPath)
  // prompt file is cleaned up after the turn; contents were written before spawn
  assert.equal(h.spawned[1]!.cwd, "/tmp/project")
  assert.equal(h.spawned[1]!.env?.GROK_DISABLE_AUTOUPDATER, "1")

  assert.equal(result.text, "Hello world")
  assert.equal(result.status, "completed")
  assert.deepEqual(result.usage, {
    inputTokens: 112,
    outputTokens: 25,
    costUsd: 0.01,
    cacheReadInputTokens: 10,
    cacheCreationInputTokens: 2,
  })

  const kinds = c.events.map((e) => e.kind)
  assert.deepEqual(kinds, ["reasoning", "tool", "tool-result", "text", "usage"])
})

test("workspace-write and danger-full-access map sandbox + always-approve", async () => {
  const h = harness([versionOk, happyRun, happyRun])
  await h.worker.runAgent(spec({ sandbox: "workspace-write" }), ctx())
  const ws = h.spawned[1]!.args
  assert.equal(flagAfter(ws, "--sandbox"), "workspace")
  assert.ok(ws.includes("--always-approve"))
  assert.ok(!ws.includes("--permission-mode"))

  await h.worker.runAgent(spec({ sandbox: "danger-full-access" }), ctx())
  const full = h.spawned[2]!.args
  assert.equal(flagAfter(full, "--sandbox"), "off")
  assert.ok(full.includes("--always-approve"))
})

test("effort maps onto grok-4.6 menu ids", async () => {
  const cases: Array<[Effort, string]> = [
    ["none", "low"],
    ["minimal", "low"],
    ["low", "low"],
    ["medium", "medium"],
    ["high", "high"],
    ["xhigh", "xhigh"],
    ["max", "xhigh"],
    ["ultra", "xhigh"],
  ]
  for (const [effort, expected] of cases) {
    const h = harness([versionOk, happyRun])
    await h.worker.runAgent(spec({ effort }), ctx())
    assert.equal(flagAfter(h.spawned[1]!.args, "--reasoning-effort"), expected, effort)
  }
})

test("serviceTier is rejected as codex-only", async () => {
  const h = harness([])
  await assert.rejects(
    () => h.worker.runAgent(spec({ serviceTier: "priority" }), ctx()),
    (err: unknown) => err instanceof AgentError && err.code === "unsupported_option" && /serviceTier is codex-only/.test(err.message),
  )
  assert.equal(h.spawned.length, 0)
})

test("approval on-request is rejected", async () => {
  const h = harness([])
  await assert.rejects(
    () => h.worker.runAgent(spec({ approval: "on-request" }), ctx()),
    (err: unknown) => err instanceof AgentError && err.code === "unsupported_option",
  )
})

test("schema extraction resumes the working session and does not use --json-schema", async () => {
  const h = harness([
    versionOk,
    happyRun,
    (p, call) => {
      assert.equal(flagAfter(call.args, "--resume"), "ses_1")
      assert.equal(flagAfter(call.args, "--tools"), "")
      assert.ok(!call.args.includes("--json-schema"))
      const promptPath = flagAfter(call.args, "--prompt-file")
      assert.ok(promptPath)
      const body = readFileSync(promptPath, "utf8")
      assert.match(body, /Output ONLY the JSON/)
      assert.match(body, /"ok"/)
      p.pushLine({ type: "text", data: '{"ok":true}' })
      p.pushLine({ type: "end", sessionId: "ses_1", usage: { input_tokens: 4, output_tokens: 2 } })
      p.end(0)
    },
  ])
  const result = await h.worker.runAgent(spec({ schema: { type: "object", properties: { ok: { type: "boolean" } } } }), ctx())
  assert.deepEqual(result.structured, { ok: true })
  assert.equal(result.text, '{"ok":true}')
  assert.equal(result.usage.inputTokens, 116)
  assert.equal(result.usage.outputTokens, 27)
})

test("stream error is fatal even on exit 0", async () => {
  const h = harness([
    versionOk,
    (p) => {
      p.pushLine({ type: "error", message: "AuthorizationRequired" })
      p.end(0)
    },
  ])
  await assert.rejects(
    () => h.worker.runAgent(spec(), ctx()),
    (err: unknown) => err instanceof AgentError && err.code === "provider_error" && /AuthorizationRequired/.test(err.message),
  )
})

test("outdated binary is refused before a paid turn", async () => {
  const h = harness([
    (p) => {
      p.stdout.emit("data", "grok 0.2.100\n")
      p.end(0)
    },
  ])
  await assert.rejects(
    () => h.worker.runAgent(spec(), ctx()),
    (err: unknown) =>
      err instanceof AgentError &&
      err.code === "provider_outdated" &&
      err.message.includes(GROK_MIN_VERSION),
  )
})

test("abort before spawn is AgentInterrupted", async () => {
  const h = harness([])
  const ac = new AbortController()
  ac.abort()
  await assert.rejects(() => h.worker.runAgent(spec(), ctx(ac.signal)), (err: unknown) => err instanceof AgentInterrupted)
})
