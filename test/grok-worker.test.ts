import { test } from "node:test"
import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { isAbsolute, join } from "node:path"
import { fileURLToPath } from "node:url"

import { GrokWorker, GROK_MIN_VERSION, type GrokWorkerOpts } from "../src/worker/grok.js"
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

const expectedAgentProfilePath = fileURLToPath(
  new URL("../src/worker/agents/fleet-omegacode-grok-worker.md", import.meta.url),
)

function harness(
  scripts: Script[],
  workerOpts: Omit<GrokWorkerOpts, "spawnProcess"> = {},
): { worker: GrokWorker; spawned: SpawnCall[] } {
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
  return { worker: new GrokWorker({ ...workerOpts, spawnProcess }), spawned }
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
  const result = await h.worker.runAgent(spec({ model: "grok-4.7", effort: "high" }), c)

  assert.equal(h.spawned.length, 2)
  assert.deepEqual(h.spawned[0]!.args, ["--version"])
  const args = h.spawned[1]!.args
  assert.equal(flagAfter(args, "--cwd"), "/tmp/project")
  assert.equal(flagAfter(args, "--sandbox"), "read-only")
  assert.equal(flagAfter(args, "--output-format"), "streaming-json")
  assert.equal(flagAfter(args, "-m"), "grok-4.7")
  assert.equal(flagAfter(args, "--reasoning-effort"), "high")
  assert.ok(args.includes("--always-approve"))
  assert.ok(!args.includes("--permission-mode"))
  assert.ok(args.includes("--no-auto-update"))
  assert.ok(args.includes("--no-subagents"))
  const promptPath = flagAfter(args, "--prompt-file")
  assert.ok(promptPath)
  // prompt file is cleaned up after the turn; contents were written before spawn
  assert.equal(h.spawned[1]!.cwd, "/tmp/project")
  assert.equal(h.spawned[1]!.env?.GROK_DISABLE_AUTOUPDATER, "1")

  assert.equal(result.text, "Hello world")
  assert.equal(result.status, "completed")
  assert.deepEqual(result.usage, {
    inputTokens: 112,
    outputTokens: 20,
    costUsd: 0.01,
    cacheReadInputTokens: 10,
    cacheCreationInputTokens: 2,
    reasoningOutputTokens: 5,
  })

  const kinds = c.events.map((e) => e.kind)
  assert.deepEqual(kinds, ["reasoning", "tool", "tool-result", "text", "usage"])
})

test("forwards the grok-4.7-build-fast model id", async () => {
  const h = harness([versionOk, happyRun])
  await h.worker.runAgent(spec({ model: "grok-4.7-build-fast" }), ctx())

  const args = h.spawned[1]!.args
  assert.equal(flagAfter(args, "-m"), "grok-4.7-build-fast")
})

test("fresh spawn stamps the absolute shipped Grok fleet profile", async () => {
  const h = harness([versionOk, happyRun])
  await h.worker.runAgent(spec(), ctx())

  const profilePath = flagAfter(h.spawned[1]!.args, "--agent")
  assert.equal(profilePath, expectedAgentProfilePath)
  assert.ok(isAbsolute(profilePath))
})

test("every sandbox maps OS confinement and always-approve", async () => {
  const h = harness([versionOk, happyRun, happyRun, happyRun])
  await h.worker.runAgent(spec({ sandbox: "read-only" }), ctx())
  const ro = h.spawned[1]!.args
  assert.equal(flagAfter(ro, "--sandbox"), "read-only")
  assert.ok(ro.includes("--always-approve"))
  assert.ok(!ro.includes("--permission-mode"))

  await h.worker.runAgent(spec({ sandbox: "workspace-write" }), ctx())
  const ws = h.spawned[2]!.args
  assert.equal(flagAfter(ws, "--sandbox"), "workspace")
  assert.ok(ws.includes("--always-approve"))
  assert.ok(!ws.includes("--permission-mode"))

  await h.worker.runAgent(spec({ sandbox: "danger-full-access" }), ctx())
  const full = h.spawned[3]!.args
  assert.equal(flagAfter(full, "--sandbox"), "off")
  assert.ok(full.includes("--always-approve"))
})

test("effort maps onto grok-4.7 menu ids", async () => {
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

test("valid main-turn structured output skips schema extraction", async () => {
  const validMain: Script = (p) => {
    p.pushLine({ type: "text", data: 'Result:\n```json\n{"ok":true}\n```' })
    p.pushLine({ type: "end", stopReason: "end_turn", sessionId: "ses_1", usage: { input_tokens: 4, output_tokens: 2 } })
    p.end(0)
  }
  const h = harness([versionOk, validMain])

  const result = await h.worker.runAgent(
    spec({ schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] } }),
    ctx(),
  )

  assert.equal(h.spawned.length, 2)
  assert.deepEqual(result.structured, { ok: true })
  assert.match(result.text, /"ok":true/)
  assert.equal(result.usage.outputTokens, 2)
})

test("schema-invalid main-turn JSON falls through to extraction and preserves the fleet stamp", async () => {
  const invalidMain: Script = (p) => {
    p.pushLine({ type: "text", data: '{"ok":"not a boolean"}' })
    p.pushLine({ type: "end", stopReason: "end_turn", sessionId: "ses_1", usage: { input_tokens: 100, output_tokens: 20 } })
    p.end(0)
  }
  const h = harness([
    versionOk,
    invalidMain,
    (p, call) => {
      assert.equal(flagAfter(call.args, "--resume"), "ses_1")
      assert.equal(flagAfter(call.args, "--tools"), "todo_write")
      assert.equal(call.args.filter(arg => arg === "--tools").length, 1)
      assert.equal(flagAfter(call.args, "--deny"), "MCPTool")
      assert.ok(!call.args.includes("--json-schema"))
      const promptPath = flagAfter(call.args, "--prompt-file")
      assert.ok(promptPath)
      const body = readFileSync(promptPath, "utf8")
      assert.match(body, /Output ONLY the JSON/)
      assert.match(body, /"ok"/)
      p.pushLine({ type: "text", data: '{"ok":true}' })
      p.pushLine({ type: "end", stopReason: "end_turn", sessionId: "ses_1", usage: { input_tokens: 4, output_tokens: 2 } })
      p.end(0)
    },
  ])
  const result = await h.worker.runAgent(spec({ schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] } }), ctx())
  assert.equal(h.spawned.length, 3)
  assert.deepEqual(result.structured, { ok: true })
  assert.equal(result.text, '{"ok":true}')
  assert.equal(result.usage.inputTokens, 104)
  assert.equal(result.usage.outputTokens, 22)
  const freshProfilePath = flagAfter(h.spawned[1]!.args, "--agent")
  const resumedProfilePath = flagAfter(h.spawned[2]!.args, "--agent")
  assert.equal(freshProfilePath, expectedAgentProfilePath)
  assert.equal(resumedProfilePath, expectedAgentProfilePath)
  assert.equal(resumedProfilePath, freshProfilePath)
})

test("missing shipped Grok fleet profile fails before any subprocess spawn", async () => {
  const h = harness([], {
    agentProfileIsFile: (path) => {
      assert.equal(path, expectedAgentProfilePath)
      return false
    },
  })

  await assert.rejects(
    () => h.worker.runAgent(spec(), ctx()),
    (err: unknown) =>
      err instanceof AgentError &&
      err.code === "provider_error" &&
      err.message.includes(expectedAgentProfilePath) &&
      /missing or not a regular file/.test(err.message),
  )
  assert.equal(h.spawned.length, 0)
})

test("stream error is fatal even on exit 0 and preserves aggregate usage", async () => {
  const h = harness([
    versionOk,
    (p) => {
      p.pushLine({
        type: "error",
        message: "AuthorizationRequired",
        usage: { input_tokens: 7, output_tokens: 3, reasoning_tokens: 2 },
        total_cost_usd: 0.02,
      })
      p.end(0)
    },
  ])
  await assert.rejects(
    () => h.worker.runAgent(spec(), ctx()),
    (err: unknown) =>
      err instanceof AgentError &&
      err.code === "provider_error" &&
      /AuthorizationRequired/.test(err.message) &&
      err.usage?.inputTokens === 7 &&
      err.usage.outputTokens === 3 &&
      err.usage.costUsd === 0.02,
  )
})

test("non-success terminal reasons reject partial text with aggregate usage", async () => {
  for (const stopReason of ["max_tokens", "max_turn_requests", "refusal", "cancelled"]) {
    const h = harness([
      versionOk,
      (p) => {
        p.pushLine({ type: "text", data: "partial" })
        p.pushLine({
          type: "end",
          stopReason,
          usage: { input_tokens: 9, output_tokens: 4, reasoning_tokens: 1 },
          total_cost_usd: 0.03,
        })
        p.end(0)
      },
    ])
    await assert.rejects(
      () => h.worker.runAgent(spec(), ctx()),
      (err: unknown) =>
        err instanceof AgentError &&
        err.code === "incomplete_result" &&
        err.retryable === false &&
        err.message.includes(stopReason) &&
        err.usage?.outputTokens === 4,
      stopReason,
    )
  }
})

test("max_turns_reached wins over the cancelled end and nonzero exit", async () => {
  const h = harness([
    versionOk,
    (p) => {
      p.pushLine({ type: "text", data: "partial" })
      p.pushLine({ type: "max_turns_reached" })
      p.pushLine({ type: "end", stopReason: "cancelled", usage: { input_tokens: 11, output_tokens: 5 } })
      p.end(1)
    },
  ])
  await assert.rejects(
    () => h.worker.runAgent(spec(), ctx()),
    (err: unknown) =>
      err instanceof AgentError &&
      err.code === "error_max_turns" &&
      err.retryable === false &&
      err.usage?.inputTokens === 11 &&
      err.usage.outputTokens === 5,
  )
})

test("exit 0 with text but no end event fails as protocol drift", async () => {
  const h = harness([
    versionOk,
    (p) => {
      p.pushLine({ type: "text", data: "looks complete" })
      p.end(0)
    },
  ])
  await assert.rejects(
    () => h.worker.runAgent(spec(), ctx()),
    (err: unknown) => err instanceof AgentError && err.code === "protocol_drift" && /without a terminal end event/.test(err.message),
  )
})

test("end event without stopReason fails closed as protocol drift", async () => {
  const h = harness([
    versionOk,
    (p) => {
      p.pushLine({ type: "text", data: "looks complete" })
      p.pushLine({ type: "end", usage: { input_tokens: 2, output_tokens: 1 } })
      p.end(0)
    },
  ])
  await assert.rejects(
    () => h.worker.runAgent(spec(), ctx()),
    (err: unknown) =>
      err instanceof AgentError &&
      err.code === "protocol_drift" &&
      /without a stopReason/.test(err.message) &&
      err.usage?.outputTokens === 1,
  )
})

test("nonzero exit preserves usage reported before termination", async () => {
  const h = harness([
    versionOk,
    (p) => {
      p.pushLine({ type: "usage", usage: { input_tokens: 13, output_tokens: 6 }, total_cost_usd: 0.04 })
      p.end(2)
    },
  ])
  await assert.rejects(
    () => h.worker.runAgent(spec(), ctx()),
    (err: unknown) =>
      err instanceof AgentError &&
      err.code === "provider_exit" &&
      err.usage?.inputTokens === 13 &&
      err.usage.outputTokens === 6 &&
      err.usage.costUsd === 0.04,
  )
})

test("schema extraction failure includes working-turn and failed-extraction usage", async () => {
  const h = harness([
    versionOk,
    happyRun,
    (p) => {
      p.pushLine({ type: "error", message: "formatting failed", usage: { input_tokens: 4, output_tokens: 2 } })
      p.end(1)
    },
  ])
  await assert.rejects(
    () => h.worker.runAgent(spec({ schema: { type: "object" } }), ctx()),
    (err: unknown) =>
      err instanceof AgentError &&
      err.code === "provider_error" &&
      err.usage?.inputTokens === 116 &&
      err.usage.outputTokens === 22 &&
      err.usage.costUsd === 0.01,
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

function isolationFixture(t: { after(fn: () => void): void }): { root: string; file: string; workspace: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "grok-worker-isolation-")))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  for (const name of ["workspace", "inputs", "scratch/home", "grok-home", "private"]) mkdirSync(join(root, name), { recursive: true })
  const file = join(root, "private", "grok-isolation.json")
  writeFileSync(file, JSON.stringify({ schemaVersion: "grok-isolation.v1", grokExecutable: "/usr/bin/true", grokHome: join(root, "grok-home"), home: join(root, "scratch/home"),
    workspace: join(root, "workspace"), inputs: join(root, "inputs"), scratch: join(root, "scratch"), readRoots: [], blockedRoots: [join(root, "private")], writable: true }))
  return { root, file, workspace: join(root, "workspace") }
}

test("isolation launches grok through Seatbelt with a constructed env, --sandbox off and shell-only tools", async (t) => {
  const { root, file, workspace } = isolationFixture(t)
  process.env.GROK_ISOLATION_TEST_POISON = "must-not-inherit"
  t.after(() => { delete process.env.GROK_ISOLATION_TEST_POISON })
  const h = harness([versionOk, happyRun], { isolationFile: file })
  await h.worker.runAgent(spec({ cwd: workspace, sandbox: "workspace-write", model: "grok-4.7-build-fast", effort: "xhigh" }), ctx())
  for (const call of h.spawned) {
    assert.equal(call.bin, "/usr/bin/sandbox-exec")
    assert.equal(call.args[0], "-p")
    assert.equal(call.args[2], "/usr/bin/true")
    assert.deepEqual(call.env, { PATH: "/usr/bin:/bin", HOME: join(root, "scratch/home"), TMPDIR: join(root, "scratch"), GROK_HOME: join(root, "grok-home"),
      SHELL: "/bin/bash", LANG: "en_US.UTF-8", GROK_DISABLE_AUTOUPDATER: "1", ...(process.env.USER ? { USER: process.env.USER, LOGNAME: process.env.USER } : {}) })
  }
  assert.deepEqual(h.spawned[0]!.args.slice(3), ["--version"])
  const args = h.spawned[1]!.args
  assert.equal(flagAfter(args, "--sandbox"), "off")
  assert.equal(flagAfter(args, "--tools"), "run_terminal_command,todo_write")
  for (const tool of ["read_file", "search_replace", "write", "spawn_subagent", "web_fetch", "use_tool"]) assert.ok(flagAfter(args, "--disallowed-tools")!.split(",").includes(tool), tool)
  for (const flag of ["--no-memory", "--disable-web-search", "--no-subagents", "--always-approve"]) assert.ok(args.includes(flag), flag)
  assert.match(readFileSync(join(root, "scratch/home", ".bash_profile"), "utf8"), /^export PATH="\/opt\/homebrew\/bin:\/opt\/homebrew\/sbin:\$PATH"$/m)
})

test("a shell result with a non-zero exit code is recorded as an error", async () => {
  const shellRun: Script = (p) => {
    for (const [id, code] of [["ok", 0], ["bad", 7]] as const) {
      p.pushLine({ type: "tool_call", toolCallId: id, toolName: "run_terminal_command", rawInput: { command: "x" } })
      p.pushLine({ type: "tool_call_update", toolCallId: id, status: "completed", rawOutput: { output_for_prompt: `exit: ${code}\n`, exit_code: code } })
    }
    p.pushLine({ type: "text", data: "done" })
    p.pushLine({ type: "end", stopReason: "end_turn", sessionId: "ses_1", usage: { input_tokens: 1, output_tokens: 1 } })
    p.end(0)
  }
  const c = ctx()
  await harness([versionOk, shellRun]).worker.runAgent(spec(), c)
  const results = c.events.filter((e) => e.kind === "tool-result") as Array<{ id: string; isError?: boolean }>
  assert.deepEqual(results.map((e) => [e.id, e.isError]), [["ok", false], ["bad", true]])
})

test("isolated schema extraction keeps only the inert todo_write tool", async (t) => {
  const { file, workspace } = isolationFixture(t)
  const extraction: Script = (p) => {
    p.pushLine({ type: "text", data: "{\"answer\":\"ok\"}" })
    p.pushLine({ type: "end", stopReason: "end_turn", sessionId: "ses_1", usage: { input_tokens: 1, output_tokens: 1 } })
    p.end(0)
  }
  const h = harness([versionOk, happyRun, extraction], { isolationFile: file })
  const result = await h.worker.runAgent(spec({ cwd: workspace, schema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] } }), ctx())
  assert.deepEqual(result.structured, { answer: "ok" })
  const args = h.spawned[2]!.args
  assert.equal(flagAfter(args, "--tools"), "todo_write")
  assert.ok(flagAfter(args, "--disallowed-tools")!.split(",").includes("run_terminal_command"))
  assert.equal(args.filter(arg => arg === "--tools").length, 1)
})

test("isolation refuses a worker cwd outside the configured workspace before spawning", async (t) => {
  const { file } = isolationFixture(t)
  const h = harness([], { isolationFile: file })
  await assert.rejects(h.worker.runAgent(spec({ cwd: "/tmp" }), ctx()), /workspace differs/)
  assert.equal(h.spawned.length, 0)
})
