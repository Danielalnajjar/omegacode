import { test } from "node:test"
import assert from "node:assert/strict"
import { EventEmitter } from "node:events"

import { AmpGrokWorker, type AmpGrokWorkerOpts } from "../src/worker/amp-grok.js"
import type { AgentSpec } from "../src/dsl/types.js"
import { AgentError, type WorkerProgress } from "../src/worker/index.js"
import type { SpawnProcess } from "../src/worker/subprocess-jsonl.js"

class FakeStdin extends EventEmitter {
  writable = true
  chunks: string[] = []
  write(chunk: string, cb?: (err?: Error | null) => void): boolean {
    this.chunks.push(chunk)
    if (cb) queueMicrotask(() => cb(null))
    return true
  }
  end(): void {}
}

class FakeProc extends EventEmitter {
  readonly stdout = new EventEmitter() as EventEmitter & { setEncoding(e: string): void }
  readonly stderr = new EventEmitter() as EventEmitter & { setEncoding(e: string): void }
  readonly stdin = new FakeStdin()
  constructor() {
    super()
    ;(this.stdout as any).setEncoding = () => {}
    ;(this.stderr as any).setEncoding = () => {}
  }
  pushLine(value: unknown): void {
    this.stdout.emit("data", JSON.stringify(value) + "\n")
  }
  end(code = 0): void {
    this.emit("exit", code, null)
    this.emit("close", code, null)
  }
  kill(): boolean {
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

type Script = (proc: FakeProc, call: SpawnCall) => void

function harness(
  scripts: Script[],
  opts: Omit<AmpGrokWorkerOpts, "spawnProcess"> = {},
): { worker: AmpGrokWorker; spawned: SpawnCall[] } {
  const queue = [...scripts]
  const spawned: SpawnCall[] = []
  const spawnProcess: SpawnProcess = (bin, args, spawnOpts) => {
    const proc = new FakeProc()
    const call = { bin, args, cwd: spawnOpts.cwd, env: spawnOpts.env, proc }
    spawned.push(call)
    const script = queue.shift()
    assert.ok(script, `unexpected spawn: ${bin} ${args.join(" ")}`)
    queueMicrotask(() => script(proc, call))
    return proc as any
  }
  return { worker: new AmpGrokWorker({ ...opts, spawnProcess }), spawned }
}

function spec(overrides: Partial<AgentSpec> = {}): AgentSpec {
  return {
    prompt: "inspect the change",
    provider: "grok",
    model: "grok-4.6",
    effort: "high",
    cwd: "/work/repo",
    sandbox: "read-only",
    approval: "never",
    ...overrides,
  }
}

function ctx(): { signal: AbortSignal; onProgress: (event: WorkerProgress) => void; events: WorkerProgress[] } {
  const events: WorkerProgress[] = []
  return { signal: new AbortController().signal, onProgress: (event) => events.push(event), events }
}

const versionOk: Script = (proc) => {
  proc.stdout.emit("data", "amp 0.0.0-test\n")
  proc.end()
}

function successfulTurn(tools: string[], result = "Looks good"): Script {
  return (proc) => {
    proc.pushLine({
      type: "system",
      subtype: "init",
      session_id: "T-amp-child",
      tools,
    })
    proc.pushLine({
      type: "assistant",
      message: {
        content: [
          { type: "thinking", thinking: "Checking the diff" },
          { type: "tool_use", id: "tool-1", name: "Read", input: { path: "src/a.ts" } },
          { type: "text", text: result },
        ],
        usage: { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 2 },
      },
    })
    proc.pushLine({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "tool-1", content: "file body" }] },
    })
    proc.pushLine({ type: "result", subtype: "success", is_error: false, result, session_id: "T-amp-child" })
    proc.end()
  }
}

test("read-only turn selects the effort mode, proves its tool surface, and records the Amp thread", async () => {
  const h = harness([versionOk, successfulTurn(["Read", "finder"])])
  const c = ctx()
  const result = await h.worker.runAgent(spec(), c)

  assert.equal(h.spawned.length, 2)
  assert.deepEqual(h.spawned[0]!.args, ["--version"])
  assert.deepEqual(h.spawned[1]!.args, [
    "--mode", "omega-grok-read-high",
    "--execute",
    "--stream-json-thinking",
    "--plugin-ready-timeout", "30",
    "--label", "omega",
  ])
  assert.equal(h.spawned[1]!.cwd, "/work/repo")
  assert.equal(h.spawned[1]!.env?.AMP_SKIP_UPDATE_CHECK, "1")
  assert.equal(h.spawned[1]!.proc.stdin.chunks.join(""), "inspect the change")
  assert.equal(result.text, "Looks good")
  assert.deepEqual(result.usage, {
    inputTokens: 12,
    outputTokens: 4,
    costUsd: 0,
    cacheReadInputTokens: 2,
  })
  assert.deepEqual(c.events.map((event) => event.kind), [
    "phase", "reasoning", "tool", "text", "usage", "tool-result",
  ])
  assert.deepEqual(c.events[0], { kind: "phase", phase: "amp-thread:T-amp-child" })
})

test("danger-full-access uses a separate mode and requires the artifact/research tools", async () => {
  const tools = ["Read", "finder", "shell_command", "verified_context_pack"]
  const h = harness([versionOk, successfulTurn(tools)])

  await h.worker.runAgent(spec({ sandbox: "danger-full-access", effort: "xhigh" }), ctx())

  assert.equal(h.spawned[1]!.args[1], "omega-grok-full-xhigh")
})

test("medium effort uses the Amp-safe med suffix", async () => {
  const h = harness([versionOk, successfulTurn(["Read", "finder"])])

  await h.worker.runAgent(spec({ effort: "medium" }), ctx())

  assert.equal(h.spawned[1]!.args[1], "omega-grok-read-med")
})

test("an overlong custom mode prefix fails before a paid turn", async () => {
  const h = harness([versionOk], { modePrefix: "placecard-omega-grok" })

  await assert.rejects(
    () => h.worker.runAgent(spec(), ctx()),
    (error: unknown) => error instanceof AgentError && error.code === "unsupported_option" && /24-character limit/.test(error.message),
  )
  assert.equal(h.spawned.length, 1)
})

test("tool surfaces fail closed on missing or extra capabilities", async () => {
  for (const tools of [["Read"], ["Read", "finder", "shell_command"]]) {
    const h = harness([versionOk, successfulTurn(tools)])
    await assert.rejects(
      () => h.worker.runAgent(spec(), ctx()),
      (error: unknown) => error instanceof AgentError && error.code === "sandbox_mismatch",
    )
  }
})

test("unsupported policy is rejected before spawning", async () => {
  const cases: Array<[Partial<AgentSpec>, RegExp]> = [
    [{ sandbox: "workspace-write" }, /cannot enforce workspace-write/],
    [{ approval: "on-request" }, /cannot surface approval/],
    [{ model: "grok-4.5" }, /pinned to grok-4\.6/],
    [{ maxTurns: 3 }, /no enforceable turn cap/],
    [{ serviceTier: "fast" }, /serviceTier is codex-only/],
  ]
  for (const [overrides, message] of cases) {
    const h = harness([])
    await assert.rejects(
      () => h.worker.runAgent(spec(overrides), ctx()),
      (error: unknown) => error instanceof AgentError && error.code === "unsupported_option" && message.test(error.message),
    )
    assert.equal(h.spawned.length, 0)
  }
})

test("schema fallback uses a fresh Amp thread and aggregates usage", async () => {
  const invalid = successfulTurn(["Read", "finder"], '{"ok":"no"}')
  const extracted: Script = (proc, call) => {
    assert.match(call.proc.stdin.chunks.join(""), /Output ONLY JSON/)
    assert.equal(call.args[1], "omega-grok-extract-high")
    proc.pushLine({ type: "system", subtype: "init", session_id: "T-extract", tools: [] })
    proc.pushLine({
      type: "assistant",
      message: { content: [{ type: "text", text: '{"ok":true}' }], usage: { input_tokens: 3, output_tokens: 2 } },
    })
    proc.pushLine({ type: "result", subtype: "success", is_error: false, result: '{"ok":true}' })
    proc.end()
  }
  const h = harness([versionOk, invalid, extracted])
  const c = ctx()

  const result = await h.worker.runAgent(spec({
    schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
  }), c)

  assert.deepEqual(result.structured, { ok: true })
  assert.equal(result.usage.inputTokens, 15)
  assert.equal(result.usage.outputTokens, 6)
  assert.deepEqual(
    c.events.filter((event) => event.kind === "phase"),
    [
      { kind: "phase", phase: "amp-thread:T-amp-child" },
      { kind: "phase", phase: "amp-thread:T-extract" },
    ],
  )
})

test("terminal Amp errors are failures even when the process exits zero", async () => {
  const failed: Script = (proc) => {
    proc.pushLine({ type: "system", subtype: "init", tools: ["Read", "finder"] })
    proc.pushLine({ type: "result", subtype: "error", is_error: true, error: "model unavailable" })
    proc.end()
  }
  const h = harness([versionOk, failed])

  await assert.rejects(
    () => h.worker.runAgent(spec(), ctx()),
    (error: unknown) => error instanceof AgentError && error.code === "provider_error" && /model unavailable/.test(error.message),
  )
})
