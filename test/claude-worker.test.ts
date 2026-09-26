// ClaudeWorker turn-loop tests. The SDK's query() is injected (ClaudeWorkerOpts.queryFn — the
// claude analogue of CodexWorker's spawnChild seam): tests script the message stream and observe
// the Options the worker built. This is what asserts the canUseTool gate is actually WIRED into
// the SDK call — checkTool's own classification semantics are covered in factory.test.ts.

import { withRetry } from "../src/worker/errors.ts"
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { ClaudeWorker, type QueryFn } from "../src/worker/claude.ts"
import { ISOLATED_TOOLS } from "../src/worker/claude-isolation.ts"
import { AgentError, AgentInterrupted, type WorkerContext, type WorkerProgress } from "../src/worker/index.ts"
import type { AgentSpec } from "../src/dsl/types.ts"
import { USAGE_LIMIT_ERROR_PREFIXES } from "@anthropic-ai/claude-agent-sdk"
import type { Options, PermissionResult, SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { setTestEnv } from "./test-env.ts"

interface QueryCall {
  prompt: string
  options: Options
}

/** A QueryFn that records its call and replays a scripted message sequence. */
function scripted(messages: unknown[], calls: QueryCall[] = []): QueryFn {
  return (params) => {
    calls.push(params as QueryCall)
    return (async function* () {
      yield* messages as SDKMessage[]
    })()
  }
}

function assistantMsg(blocks: unknown): unknown {
  return { type: "assistant", message: { content: blocks } }
}
function userMsg(blocks: unknown): unknown {
  return { type: "user", message: { content: blocks } }
}
/** A success result message (override `subtype`/`usage`/… for the error shapes). */
function resultMsg(over: Record<string, unknown> = {}): unknown {
  return {
    type: "result",
    subtype: "success",
    result: "all done",
    usage: { input_tokens: 10, output_tokens: 4 },
    total_cost_usd: 0.01,
    ...over,
  }
}

function ctx(signal?: AbortSignal): WorkerContext & { events: WorkerProgress[] } {
  const events: WorkerProgress[] = []
  return { signal: signal ?? new AbortController().signal, onProgress: (e) => events.push(e), events }
}

function spec(over: Partial<AgentSpec> = {}): AgentSpec {
  return { prompt: "do the thing", provider: "claude-code", cwd: "/work/repo", sandbox: "workspace-write", approval: "never", ...over }
}

const SCHEMA = { type: "object", properties: { answer: { type: "number" } }, required: ["answer"] }

/** The shape the worker installs (the SDK type carries an extra options param we don't use). */
type Gate = (toolName: string, input: Record<string, unknown>) => Promise<PermissionResult>

function tick(): Promise<void> {
  return new Promise((r) => setImmediate(r))
}

test("serviceTier is rejected before starting a non-codex provider turn", async () => {
  const calls: QueryCall[] = []
  const worker = new ClaudeWorker({ queryFn: scripted([resultMsg()], calls) })
  await assert.rejects(
    worker.runAgent(spec({ serviceTier: "fast" }), ctx()),
    (error: unknown) => error instanceof AgentError && error.code === "unsupported_option",
  )
  assert.equal(calls.length, 0)
})

// ===========================================================================
// canUseTool wiring — deleting the canUseTool option must fail these tests
// ===========================================================================

test("canUseTool is wired into the SDK options and enforces the spec's sandbox + cwd", async () => {
  const calls: QueryCall[] = []
  const worker = new ClaudeWorker({ queryFn: scripted([resultMsg()], calls) })
  await worker.runAgent(spec({ sandbox: "workspace-write", cwd: "/work/repo" }), ctx())
  const gate = calls[0]!.options.canUseTool as Gate | undefined
  assert.ok(gate, "options.canUseTool must be installed — without it workspace-write is unenforced")
  const denied = await gate("Write", { file_path: "/etc/passwd" })
  assert.equal(denied.behavior, "deny")
  assert.match((denied as { message: string }).message, /outside the workspace/)
  const input = { file_path: "/work/repo/ok.txt", content: "x" }
  const allowed = await gate("Write", input)
  assert.equal(allowed.behavior, "allow")
  assert.equal((allowed as { updatedInput: unknown }).updatedInput, input) // input passed through untouched
})

test("canUseTool carries the spec's SANDBOX through (read-only denies writes, allows read Bash)", async () => {
  const calls: QueryCall[] = []
  const worker = new ClaudeWorker({ queryFn: scripted([resultMsg()], calls) })
  await worker.runAgent(spec({ sandbox: "read-only" }), ctx())
  const gate = calls[0]!.options.canUseTool as Gate
  assert.equal((await gate("Bash", { command: "rm -rf x" })).behavior, "deny")
  assert.equal((await gate("Bash", { command: "git log --oneline" })).behavior, "allow")
  assert.equal((await gate("Write", { file_path: "/work/repo/x" })).behavior, "deny")
})

// ===========================================================================
// runAgent — happy path, options mapping, structured output
// ===========================================================================

test("happy path: result text + usage (cache tokens fold into inputTokens)", async () => {
  const calls: QueryCall[] = []
  const worker = new ClaudeWorker({
    queryFn: scripted(
      [resultMsg({ usage: { input_tokens: 10, cache_read_input_tokens: 200, cache_creation_input_tokens: 30, output_tokens: 4 }, total_cost_usd: 0.05 })],
      calls,
    ),
  })
  const res = await worker.runAgent(spec(), ctx())
  assert.equal(res.text, "all done")
  assert.equal(res.status, "completed")
  assert.equal(res.structured, undefined) // no schema on the spec → structured stays absent
  assert.equal(res.usage.inputTokens, 240)
  assert.equal(res.usage.outputTokens, 4)
  assert.equal(res.usage.costUsd, 0.05)
  assert.equal(res.usage.cacheReadInputTokens, 200)
  assert.equal(res.usage.cacheCreationInputTokens, 30)
  assert.equal(calls[0]!.prompt, "do the thing")
})

test("Claude silence watchdog aborts the SDK query with retryable turn_stalled", async () => {
  let queryAborted = false
  const worker = new ClaudeWorker({ stallTimeoutMs: 25, queryFn: ({ options }) => (async function* () {
    await new Promise<void>((resolve) => options.abortController!.signal.addEventListener("abort", () => {
      queryAborted = true
      resolve()
    }, { once: true }))
  })() })
  await assert.rejects(worker.runAgent(spec(), ctx()), (err: unknown) =>
    err instanceof AgentError && err.code === "turn_stalled" && err.retryable && /25ms/.test(err.message))
  assert.equal(queryAborted, true)
})

test("Claude silence watchdog resets on each SDK message", async () => {
  const worker = new ClaudeWorker({ stallTimeoutMs: 250, queryFn: () => (async function* () {
    for (let i = 0; i < 3; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100))
      yield assistantMsg([{ type: "text", text: String(i) }]) as SDKMessage
    }
    yield resultMsg() as SDKMessage
  })() })
  assert.equal((await worker.runAgent(spec(), ctx())).text, "all done")
})

test("Claude silence watchdog 0 allows a silent query to finish", async () => {
  const worker = new ClaudeWorker({ stallTimeoutMs: 0, queryFn: () => (async function* () {
    await new Promise((resolve) => setTimeout(resolve, 40))
    yield resultMsg() as SDKMessage
  })() })
  assert.equal((await worker.runAgent(spec(), ctx())).text, "all done")
})

test("Claude closes an open SDK stream when message handling throws", async () => {
  let returned = false
  let queryAbort: AbortSignal | undefined
  const worker = new ClaudeWorker({ queryFn: ({ options }) => {
    queryAbort = options.abortController!.signal
    return { [Symbol.asyncIterator]: () => {
      let delivered = false
      return {
        next: async (): Promise<IteratorResult<SDKMessage>> => {
          if (delivered) return new Promise(() => {})
          delivered = true
          return { done: false, value: assistantMsg([{ type: "text", text: "partial" }]) as SDKMessage }
        },
        return: async (): Promise<IteratorResult<SDKMessage>> => {
          returned = true
          return { done: true, value: undefined }
        },
      }
    } }
  } })
  const context = ctx()
  context.onProgress = () => { throw new Error("progress handler failed") }
  await assert.rejects(worker.runAgent(spec(), context), /progress handler failed/)
  assert.equal(queryAbort?.aborted, true)
  assert.equal(returned, true)
})

const MODEL_USAGE_A = {
  inputTokens: 100,
  cacheReadInputTokens: 50,
  cacheCreationInputTokens: 25,
  outputTokens: 10,
  costUSD: 0.40,
  contextWindow: 200000,
  maxOutputTokens: 8192,
  webSearchRequests: 0,
}
const MODEL_USAGE_B = {
  inputTokens: 20,
  cacheReadInputTokens: 10,
  cacheCreationInputTokens: 5,
  outputTokens: 4,
  costUSD: 0.10,
  contextWindow: 200000,
  maxOutputTokens: 8192,
  webSearchRequests: 0,
}
const CONFLICTING_SNAKE_USAGE = {
  input_tokens: 10,
  cache_read_input_tokens: 200,
  cache_creation_input_tokens: 77,
  output_tokens: 4,
}
const STREAM_USAGE = {
  input_tokens: 100,
  cache_read_input_tokens: 1000,
  cache_creation_input_tokens: 10,
  output_tokens: 7,
}

test("lastResult modelUsage wins tokens; total_cost_usd wins cost", async () => {
  const worker = new ClaudeWorker({
    queryFn: scripted([
      resultMsg({
        modelUsage: { A: MODEL_USAGE_A, B: MODEL_USAGE_B },
        usage: CONFLICTING_SNAKE_USAGE,
        total_cost_usd: 1.25,
      }),
    ]),
  })
  const res = await worker.runAgent(spec(), ctx())
  assert.equal(res.usage.inputTokens, 210)
  assert.equal(res.usage.outputTokens, 14)
  assert.equal(res.usage.cacheReadInputTokens, 60)
  assert.equal(res.usage.cacheCreationInputTokens, 30)
  assert.equal(res.usage.costUsd, 1.25)
})

test("empty modelUsage object falls back to snake usage", async () => {
  const worker = new ClaudeWorker({
    queryFn: scripted([
      resultMsg({
        modelUsage: {},
        usage: { input_tokens: 10, cache_read_input_tokens: 200, cache_creation_input_tokens: 30, output_tokens: 4 },
        total_cost_usd: 0.05,
      }),
    ]),
  })
  const res = await worker.runAgent(spec(), ctx())
  assert.equal(res.usage.inputTokens, 240)
  assert.equal(res.usage.outputTokens, 4)
  assert.equal(res.usage.costUsd, 0.05)
  assert.equal(res.usage.cacheReadInputTokens, 200)
  assert.equal(res.usage.cacheCreationInputTokens, 30)
})

test("spec → SDK options: cwd/model/maxTurns/effort floor/instructions preset append", async () => {
  const calls: QueryCall[] = []
  const worker = new ClaudeWorker({ queryFn: scripted([resultMsg()], calls), model: "default-model" })
  await worker.runAgent(spec({ model: "claude-x", maxTurns: 7, effort: "none", instructions: "be terse" }), ctx())
  const o = calls[0]!.options
  assert.equal(o.cwd, "/work/repo")
  assert.equal(o.model, "claude-x") // spec.model wins over the worker default
  assert.equal(o.maxTurns, 7)
  assert.equal(o.effort, "low") // codex-only "none" maps to the SDK floor
  assert.deepEqual(o.systemPrompt, { type: "preset", preset: "claude_code", append: "be terse" })
  assert.equal(o.permissionMode, "default")
  assert.deepEqual(o.settingSources, [])

  await worker.runAgent(spec(), ctx()) // no spec.model/effort/instructions
  const o2 = calls[1]!.options
  assert.equal(o2.model, "default-model")
  assert.equal(o2.effort, undefined)
  assert.equal(o2.systemPrompt, undefined)
})

test("claudeAgent selects a user-level SDK agent without loading project or local settings", async () => {
  const calls: QueryCall[] = []
  const worker = new ClaudeWorker({ queryFn: scripted([resultMsg(), resultMsg()], calls) })
  await worker.runAgent(spec({ claudeAgent: "librarian" }), ctx())
  assert.equal(calls[0]!.options.agent, "librarian")
  assert.deepEqual(calls[0]!.options.settingSources, ["user"])

  await worker.runAgent(spec(), ctx())
  assert.equal(calls[1]!.options.agent, undefined)
  assert.deepEqual(calls[1]!.options.settingSources, [])
})

test("profile and ordinary SDK calls isolate host TypeSafe credentials", async t => {
  setTestEnv(t, { ORDINARY: "kept", TYPESAFE_API_KEY: "test-only" })
  const calls: QueryCall[] = []
  let resolutions = 0
  const worker = new ClaudeWorker({
    queryFn: scripted([resultMsg(), resultMsg(), resultMsg()], calls),
    baseEnv: { ORDINARY: "kept", CLAUDE_CONFIG_DIR: "/ordinary", CLAUDE_CODE_EXECUTABLE: "/ordinary/claude" },
    profileResolver: async (profileId) => {
      resolutions += 1
      return {
        profileId,
        label: profileId.toUpperCase(),
        configDir: `/profiles/${profileId}`,
        claudeCodeExecutable: `/launchers/claude-${profileId}`,
      }
    },
  })
  const context = ctx()

  const preparedA = await worker.prepareAgentCall(spec({ claudeProfile: "a" }), context)
  const preparedB = await worker.prepareAgentCall(spec({ claudeProfile: "b" }), context)
  assert.deepEqual(context.events.filter((event) => event.kind === "claude-profile"), [
    { kind: "claude-profile", label: "A" },
    { kind: "claude-profile", label: "B" },
  ])
  await Promise.all([
    preparedA(spec({ prompt: "A", claudeProfile: "a" }), context),
    preparedB(spec({ prompt: "B", claudeProfile: "b" }), context),
  ])
  await worker.runAgent(spec({ prompt: "ordinary" }), context)

  assert.equal(resolutions, 2)
  assert.deepEqual(calls[0]!.options.env, {
    ORDINARY: "kept", CLAUDE_CONFIG_DIR: "/profiles/a", CLAUDE_CODE_EXECUTABLE: "/launchers/claude-a",
  })
  assert.deepEqual(calls[1]!.options.env, {
    ORDINARY: "kept", CLAUDE_CONFIG_DIR: "/profiles/b", CLAUDE_CODE_EXECUTABLE: "/launchers/claude-b",
  })
  assert.equal(calls[0]!.options.pathToClaudeCodeExecutable, "/launchers/claude-a")
  assert.equal(calls[1]!.options.pathToClaudeCodeExecutable, "/launchers/claude-b")
  assert.notEqual(calls[0]!.options.env, calls[1]!.options.env)
  assert.deepEqual(calls[2]!.options.env, { ORDINARY: "kept" })
  assert.equal(calls[2]!.options.pathToClaudeCodeExecutable, undefined)
})

test("an explicit worker executable overrides the selected profile launcher without changing its environment", async () => {
  const calls: QueryCall[] = []
  const worker = new ClaudeWorker({
    queryFn: scripted([resultMsg()], calls),
    pathToClaudeCodeExecutable: "/explicit/claude",
    profileResolver: async (profileId) => ({
      profileId, label: "A", configDir: "/profiles/a", claudeCodeExecutable: "/launchers/claude-a",
    }),
  })

  const prepared = await worker.prepareAgentCall(spec({ claudeProfile: "a" }), ctx())
  await prepared(spec({ claudeProfile: "a" }), ctx())

  assert.equal(calls[0]!.options.pathToClaudeCodeExecutable, "/explicit/claude")
  assert.equal(calls[0]!.options.env?.CLAUDE_CODE_EXECUTABLE, "/launchers/claude-a")
})

test("a call without a profile runs the Executor launcher when the home has one, unless isolated", { skip: process.platform !== "darwin" }, async t => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "claude-worker-home-")))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const launcher = join(home, ".local", "libexec", "claude-with-executor-mcp")
  mkdirSync(dirname(launcher), { recursive: true })
  writeFileSync(launcher, "#!/bin/sh\n", { mode: 0o700 })
  for (const name of ["workspace", "inputs", "scratch"]) mkdirSync(join(home, name))
  const workspace = join(home, "workspace")
  const isolation = join(home, "isolation.json")
  writeFileSync(isolation, JSON.stringify({ schemaVersion: "claude-isolation.v1", workspace, inputs: join(home, "inputs"), scratch: join(home, "scratch"),
    readRoots: [], blockedRoots: [home], writable: true }))
  const calls: QueryCall[] = []
  const worker = new ClaudeWorker({ queryFn: scripted([resultMsg(), resultMsg()], calls) })

  setTestEnv(t, { HOME: home })
  await worker.runAgent(spec(), ctx())
  process.env.OMEGACODE_CLAUDE_ISOLATION_CONFIG = isolation
  await worker.runAgent(spec({ cwd: workspace }), ctx())

  assert.equal(calls[0]!.options.pathToClaudeCodeExecutable, launcher)
  assert.equal(calls[1]!.options.pathToClaudeCodeExecutable, undefined)
})

for (const [key, value] of [
  ["CLAUDE_CODE_CUSTOM_OAUTH_URL", "https://oauth.redirect.invalid"],
  ["ANTHROPIC_UNIX_SOCKET", "/tmp/alternate-anthropic.sock"],
  ["CLAUDE_SECURESTORAGE_CONFIG_DIR", ""],
] as const) {
  test(`${key} blocks a profiled worker before profile resolution and SDK query`, async () => {
    let resolutions = 0
    let queries = 0
    const worker = new ClaudeWorker({
      baseEnv: { [key]: value },
      profileResolver: async (profileId) => {
        resolutions += 1
        return { profileId, label: "A", configDir: "/profiles/a", claudeCodeExecutable: "/launchers/claude-a" }
      },
      queryFn: () => {
        queries += 1
        return (async function* () { yield resultMsg() })()
      },
    })

    await assert.rejects(
      worker.prepareAgentCall(spec({ claudeProfile: "a" }), ctx()),
      (error: unknown) => error instanceof AgentError && error.code === "claude_profile_auth_conflict",
    )
    assert.equal(resolutions, 0)
    assert.equal(queries, 0)
  })
}

test("prepared retries reuse profile environment while accepting the current attempt spec", async () => {
  const calls: QueryCall[] = []
  const worker = new ClaudeWorker({
    queryFn: scripted([resultMsg(), resultMsg()], calls),
    baseEnv: { ORDINARY: "kept" },
    profileResolver: async (profileId) => ({
      profileId, label: "A", configDir: "/profiles/a", claudeCodeExecutable: "/launchers/claude-a",
    }),
  })
  const context = ctx()
  const prepared = await worker.prepareAgentCall(spec({ claudeProfile: "a" }), context)

  await prepared(spec({ prompt: "first", instructions: "first instructions", claudeProfile: "a" }), context)
  await prepared(spec({ prompt: "corrective", instructions: "corrective instructions", claudeProfile: "a" }), context)

  assert.equal(calls[0]!.prompt, "first")
  assert.deepEqual(calls[0]!.options.systemPrompt, { type: "preset", preset: "claude_code", append: "first instructions" })
  assert.equal(calls[1]!.prompt, "corrective")
  assert.deepEqual(calls[1]!.options.systemPrompt, { type: "preset", preset: "claude_code", append: "corrective instructions" })
  assert.deepEqual(calls[0]!.options.env, calls[1]!.options.env)
})

test("a claudeAgent SDK resolution failure is a hard provider failure", async () => {
  const worker = new ClaudeWorker({
    queryFn: () => (async function* () {
      throw new Error('Agent type "missing" not found')
    })(),
  })
  await assert.rejects(
    worker.runAgent(spec({ claudeAgent: "missing" }), ctx()),
    (error: unknown) => error instanceof AgentError && error.code === "sdk_error" && error.retryable === false,
  )
})

test("a transient SDK failure remains retryable when claudeAgent is selected", async () => {
  const worker = new ClaudeWorker({
    queryFn: () => (async function* () {
      throw new Error("socket hung up")
    })(),
  })
  await assert.rejects(
    worker.runAgent(spec({ claudeAgent: "librarian" }), ctx()),
    (error: unknown) => error instanceof AgentError && error.code === "sdk_error" && error.retryable === true,
  )
})

test("schema spec: outputFormat is sent and structured_output comes back on the result", async () => {
  const calls: QueryCall[] = []
  const worker = new ClaudeWorker({ queryFn: scripted([resultMsg({ structured_output: { answer: 42 } })], calls) })
  const res = await worker.runAgent(spec({ schema: SCHEMA }), ctx())
  assert.deepEqual(calls[0]!.options.outputFormat, { type: "json_schema", schema: SCHEMA })
  assert.deepEqual(res.structured, { answer: 42 })
  // without a schema the same SDK field is ignored and no outputFormat is sent
  const calls2: QueryCall[] = []
  const w2 = new ClaudeWorker({ queryFn: scripted([resultMsg({ structured_output: { answer: 42 } })], calls2) })
  const r2 = await w2.runAgent(spec(), ctx())
  assert.equal(r2.structured, undefined)
  assert.equal(calls2[0]!.options.outputFormat, undefined)
})

test("isolated Claude run passes the isolated tools and permits SDK StructuredOutput", { skip: process.platform !== "darwin" }, async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "claude-worker-isolation-")))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  for (const name of ["workspace", "inputs", "scratch"]) mkdirSync(join(root, name))
  const workspace = join(root, "workspace")
  const file = join(root, "isolation.json")
  writeFileSync(file, JSON.stringify({ schemaVersion: "claude-isolation.v1", workspace, inputs: join(root, "inputs"), scratch: join(root, "scratch"),
    readRoots: [], blockedRoots: [root], writable: true }))
  setTestEnv(t, { ...process.env, OMEGACODE_CLAUDE_ISOLATION_CONFIG: file })
  const calls: QueryCall[] = []
  const worker = new ClaudeWorker({ queryFn: scripted([resultMsg({ structured_output: { answer: 42 } })], calls) })
  await worker.runAgent(spec({ cwd: workspace, schema: SCHEMA }), ctx())
  const options = calls[0]!.options
  const gate = options.canUseTool as Gate
  assert.equal((await gate("StructuredOutput", { answer: 42 })).behavior, "allow")
  assert.equal((await gate("WebFetch", { url: "https://example.com" })).behavior, "deny")
  assert.deepEqual(options.tools, ISOLATED_TOOLS)
})

// ===========================================================================
// progress mapping
// ===========================================================================

test("progress mapping: text/thinking/tool_use/tool_result → WorkerProgress events in order", async () => {
  const c = ctx()
  const worker = new ClaudeWorker({
    queryFn: scripted([
      assistantMsg([
        { type: "text", text: "hello" },
        { type: "thinking", thinking: "hmm" },
        { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } },
      ]),
      userMsg([{ type: "tool_result", tool_use_id: "t1", content: "file.txt", is_error: false }]),
      // non-string tool_result content is JSON-stringified; is_error maps through
      userMsg([{ type: "tool_result", tool_use_id: "t2", content: [{ type: "text", text: "x" }], is_error: true }]),
      resultMsg(),
    ]),
  })
  await worker.runAgent(spec(), c)
  assert.deepEqual(c.events, [
    { kind: "text", text: "hello" },
    { kind: "reasoning", text: "hmm" },
    { kind: "tool", id: "t1", name: "Bash", input: { command: "ls" } },
    { kind: "tool-result", id: "t1", output: "file.txt", isError: false },
    { kind: "tool-result", id: "t2", output: '[{"type":"text","text":"x"}]', isError: true },
  ])
})

test("system commands_changed and background_tasks_changed pass through without progress", async () => {
  const c = ctx()
  const worker = new ClaudeWorker({
    queryFn: scripted([
      { type: "system", subtype: "commands_changed" },
      { type: "system", subtype: "background_tasks_changed" },
      resultMsg(),
    ]),
  })
  const res = await worker.runAgent(spec(), c)
  assert.equal(res.status, "completed")
  assert.equal(res.text, "all done")
  assert.deepEqual(c.events, [])
})

test("malformed/unknown blocks and message types are skipped without crashing", async () => {
  const c = ctx()
  const worker = new ClaudeWorker({
    queryFn: scripted([
      { type: "system", subtype: "init" }, // unrelated message type
      assistantMsg(["raw string", null, { type: "text" }, { type: "thinking", thinking: 42 }, { type: "tool_use", name: 7 }]),
      assistantMsg("not-an-array"),
      userMsg("not-an-array"),
      resultMsg(),
    ]),
  })
  const res = await worker.runAgent(spec(), c)
  assert.equal(res.text, "all done")
  assert.deepEqual(c.events, [])
})

// ===========================================================================
// result-loop failure paths
// ===========================================================================

test("a stream that ends without a result message → no_result (and is NOT re-wrapped as sdk_error)", async () => {
  const empty = new ClaudeWorker({ queryFn: scripted([]) })
  await assert.rejects(empty.runAgent(spec(), ctx()), (e) => e instanceof AgentError && e.code === "no_result" && e.retryable === false)
  // a stream with progress but no terminal result is equally incomplete
  const partial = new ClaudeWorker({ queryFn: scripted([assistantMsg([{ type: "text", text: "thinking…" }])]) })
  await assert.rejects(partial.runAgent(spec(), ctx()), (e) => e instanceof AgentError && e.code === "no_result")
})

test("non-success result → AgentError with the subtype as code; retryable only for rate/overload shapes", async () => {
  async function failWith(subtype: string): Promise<AgentError> {
    const worker = new ClaudeWorker({ queryFn: scripted([resultMsg({ subtype })]) })
    const err = await worker.runAgent(spec(), ctx()).catch((e) => e)
    assert.ok(err instanceof AgentError, `subtype ${subtype} must surface as AgentError`)
    return err
  }
  const maxTurns = await failWith("error_max_turns") // terminal cap: never retry
  assert.equal(maxTurns.code, "error_max_turns")
  assert.equal(maxTurns.retryable, false)
  assert.match(maxTurns.message, /claude result: error_max_turns/)
  assert.equal((await failWith("error_overloaded_529")).retryable, true)
  assert.equal((await failWith("error_rate_limited")).retryable, true)
  assert.equal((await failWith("error_during_execution")).retryable, false)
})

test("a failed turn's AgentError carries cache-inclusive usage (failed turns still bill)", async () => {
  const worker = new ClaudeWorker({
    queryFn: scripted([
      resultMsg({
        subtype: "error_during_execution",
        usage: { input_tokens: 100, cache_read_input_tokens: 4000, cache_creation_input_tokens: 500, output_tokens: 42 },
        total_cost_usd: 0.07,
      }),
    ]),
  })
  const err = await worker.runAgent(spec(), ctx()).catch((e) => e)
  assert.ok(err instanceof AgentError)
  assert.equal(err.usage?.inputTokens, 4600)
  assert.equal(err.usage?.outputTokens, 42)
  assert.equal(err.usage?.costUsd, 0.07)

  const errModel = await new ClaudeWorker({
    queryFn: scripted([
      resultMsg({
        subtype: "error_during_execution",
        modelUsage: { A: MODEL_USAGE_A, B: MODEL_USAGE_B },
        usage: CONFLICTING_SNAKE_USAGE,
        total_cost_usd: 1.25,
      }),
    ]),
  })
    .runAgent(spec(), ctx())
    .catch((e) => e)
  assert.ok(errModel instanceof AgentError)
  assert.equal(errModel.usage?.inputTokens, 210)
  assert.equal(errModel.usage?.outputTokens, 14)
  assert.equal(errModel.usage?.cacheReadInputTokens, 60)
  assert.equal(errModel.usage?.cacheCreationInputTokens, 30)
  assert.equal(errModel.usage?.costUsd, 1.25)

  const errZeroed = await new ClaudeWorker({
    queryFn: scripted([
      resultMsg({
        subtype: "error_during_execution",
        modelUsage: {
          crashed: {
            ...MODEL_USAGE_A,
            inputTokens: 0,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            outputTokens: 0,
            costUSD: 0,
          },
        },
        usage: { input_tokens: 100, cache_read_input_tokens: 4000, cache_creation_input_tokens: 500, output_tokens: 42 },
        total_cost_usd: 0.07,
      }),
    ]),
  })
    .runAgent(spec(), ctx())
    .catch((e) => e)
  assert.ok(errZeroed instanceof AgentError)
  assert.equal(errZeroed.usage?.inputTokens, 4600)
  assert.equal(errZeroed.usage?.outputTokens, 42)
  assert.equal(errZeroed.usage?.costUsd, 0.07)
})

test("an SDK throw is wrapped as retryable sdk_error (message preserved)", async () => {
  const midStream = new ClaudeWorker({
    queryFn: () =>
      (async function* (): AsyncGenerator<SDKMessage> {
        yield assistantMsg([{ type: "text", text: "partial" }]) as SDKMessage
        throw new Error("socket hung up")
      })(),
  })
  await assert.rejects(
    midStream.runAgent(spec(), ctx()),
    (e) => e instanceof AgentError && e.code === "sdk_error" && e.retryable === true && /socket hung up/.test(e.message),
  )
  const syncThrow = new ClaudeWorker({
    queryFn: () => {
      throw new Error("spawn failed")
    },
  })
  await assert.rejects(syncThrow.runAgent(spec(), ctx()), (e) => e instanceof AgentError && e.code === "sdk_error" && /spawn failed/.test(e.message))
})

// ===========================================================================
// background-task stream shapes — StructuredOutput recovery
// (Claude Code's background tasks can end the stream without a result message,
// or append a post-answer task-notification turn whose result lacks
// structured_output and whose text is watcher chatter.)
// ===========================================================================

/** assistant StructuredOutput call + its accepted tool_result. */
function structuredOutputTurn(payload: unknown, over: { id?: string; is_error?: boolean } = {}): unknown[] {
  const id = over.id ?? "so1"
  return [
    assistantMsg([{ type: "tool_use", id, name: "StructuredOutput", input: payload }]),
    userMsg([{ type: "tool_result", tool_use_id: id, content: "Structured output provided successfully", is_error: over.is_error ?? false }]),
  ]
}

test("stream ends with NO result after an accepted StructuredOutput → recovered, not no_result", async () => {
  const worker = new ClaudeWorker({
    queryFn: scripted([
      ...structuredOutputTurn({ answer: 42 }),
      assistantMsg([{ type: "text", text: "gate is green" }]), // final answer, then the stream just closes
    ]),
  })
  const res = await worker.runAgent(spec({ schema: SCHEMA }), ctx())
  assert.equal(res.status, "completed")
  assert.deepEqual(res.structured, { answer: 42 })
  assert.equal(res.text, "gate is green")
})

test("no-result recovery sums assistant usage deduped by API message id (cost unknowable → 0)", async () => {
  const worker = new ClaudeWorker({
    queryFn: scripted([
      { type: "assistant", message: { id: "m1", usage: STREAM_USAGE, content: [{ type: "tool_use", id: "so1", name: "StructuredOutput", input: { answer: 1 } }] } },
      { type: "assistant", message: { id: "m1", usage: STREAM_USAGE, content: [{ type: "text", text: "same API message, second block" }] } }, // repeat id: counted once
      userMsg([{ type: "tool_result", tool_use_id: "so1", content: "ok", is_error: false }]),
      { type: "assistant", message: { id: "m2", usage: { input_tokens: 50, output_tokens: 3 }, content: [{ type: "text", text: "done" }] } },
    ]),
  })
  const res = await worker.runAgent(spec({ schema: SCHEMA }), ctx())
  assert.equal(res.usage.inputTokens, 1160)
  assert.equal(res.usage.outputTokens, 10)
  assert.equal(res.usage.costUsd, 0)
  assert.equal(res.usage.cacheReadInputTokens, 1000)
  assert.equal(res.usage.cacheCreationInputTokens, 10)
})

test("StructuredOutput recovery splices notification total_cost_usd onto stream tokens", async () => {
  const worker = new ClaudeWorker({
    queryFn: scripted([
      ...structuredOutputTurn({ answer: 1 }),
      { type: "assistant", message: { id: "m1", usage: STREAM_USAGE, content: [{ type: "text", text: "done" }] } },
      resultMsg({
        origin: { kind: "task-notification" },
        modelUsage: {
          sonnet: {
            inputTokens: 400,
            cacheReadInputTokens: 80,
            cacheCreationInputTokens: 20,
            outputTokens: 5,
            costUSD: 9,
            contextWindow: 1,
            maxOutputTokens: 1,
            webSearchRequests: 0,
          },
        },
        usage: { input_tokens: 10, output_tokens: 4 },
        total_cost_usd: 1.68,
      }),
    ]),
  })
  const res = await worker.runAgent(spec({ schema: SCHEMA }), ctx())
  assert.equal(res.status, "completed")
  assert.deepEqual(res.structured, { answer: 1 })
  assert.equal(res.usage.inputTokens, 1110)
  assert.equal(res.usage.outputTokens, 7)
  assert.equal(res.usage.cacheReadInputTokens, 1000)
  assert.equal(res.usage.cacheCreationInputTokens, 10)
  assert.equal(res.usage.costUsd, 1.68)
})

test("a post-answer NOTIFICATION turn's result lacking structured_output → recovered from the tool payload", async () => {
  const worker = new ClaudeWorker({
    queryFn: scripted([
      ...structuredOutputTurn({ answer: 42 }),
      assistantMsg([{ type: "text", text: "that's just the watcher exiting — nothing new" }]),
      resultMsg({ origin: { kind: "task-notification" }, total_cost_usd: 1.68 }), // no structured_output field
    ]),
  })
  const res = await worker.runAgent(spec({ schema: SCHEMA }), ctx())
  assert.deepEqual(res.structured, { answer: 42 })
  assert.equal(res.usage.costUsd, 1.68) // cost still taken from the notification result — it's all we have
})

test("zeroed error notification must not wipe stream usage on StructuredOutput recovery", async () => {
  const worker = new ClaudeWorker({
    queryFn: scripted([
      ...structuredOutputTurn({ answer: 1 }),
      { type: "assistant", message: { id: "m1", usage: STREAM_USAGE, content: [{ type: "text", text: "done" }] } },
      resultMsg({
        subtype: "error_during_execution",
        origin: { kind: "task-notification" },
        usage: { input_tokens: 0, output_tokens: 0 },
        modelUsage: {},
        total_cost_usd: 0,
      }),
    ]),
  })
  const res = await worker.runAgent(spec({ schema: SCHEMA }), ctx())
  assert.equal(res.status, "completed")
  assert.equal(res.usage.inputTokens, 1110)
  assert.equal(res.usage.outputTokens, 7)
  assert.equal(res.usage.cacheReadInputTokens, 1000)
  assert.equal(res.usage.cacheCreationInputTokens, 10)
  assert.equal(res.usage.costUsd, 0)
})

test("a non-success NOTIFICATION result after an accepted StructuredOutput does not fail the finished agent", async () => {
  const worker = new ClaudeWorker({
    queryFn: scripted([
      ...structuredOutputTurn({ answer: 42 }),
      resultMsg({ subtype: "error_during_execution", origin: { kind: "task-notification" } }),
    ]),
  })
  const res = await worker.runAgent(spec({ schema: SCHEMA }), ctx())
  assert.equal(res.status, "completed")
  assert.deepEqual(res.structured, { answer: 42 })
})

test("the PRIMARY turn's result is preferred over a later notification turn's (text and structured)", async () => {
  // free-form: the real answer must not be replaced by watcher chatter
  const freeForm = new ClaudeWorker({
    queryFn: scripted([
      resultMsg({ result: "the real analysis" }),
      resultMsg({ result: "background task completed — nothing new", origin: { kind: "task-notification" } }),
    ]),
  })
  const r1 = await freeForm.runAgent(spec(), ctx())
  assert.equal(r1.text, "the real analysis")
  // schema: the primary result's structured_output survives a notification result that lacks it
  const schemaed = new ClaudeWorker({
    queryFn: scripted([
      resultMsg({ structured_output: { answer: 7 } }),
      resultMsg({ origin: { kind: "task-notification" } }),
    ]),
  })
  const r2 = await schemaed.runAgent(spec({ schema: SCHEMA }), ctx())
  assert.deepEqual(r2.structured, { answer: 7 })
})

test("when the result carries structured_output (even alongside a tool payload), the result's wins; null falls back", async () => {
  const carried = new ClaudeWorker({
    queryFn: scripted([...structuredOutputTurn({ answer: 1 }), resultMsg({ structured_output: { answer: 2 } })]),
  })
  assert.deepEqual((await carried.runAgent(spec({ schema: SCHEMA }), ctx())).structured, { answer: 2 })
  // an explicit null structured_output must not shadow the accepted tool payload
  const nulled = new ClaudeWorker({
    queryFn: scripted([...structuredOutputTurn({ answer: 3 }), resultMsg({ structured_output: null })]),
  })
  assert.deepEqual((await nulled.runAgent(spec({ schema: SCHEMA }), ctx())).structured, { answer: 3 })
})

test("a result followed by trailing assistant messages still resolves (last RESULT, not last message)", async () => {
  const worker = new ClaudeWorker({
    queryFn: scripted([resultMsg(), assistantMsg([{ type: "text", text: "trailing notification chatter" }])]),
  })
  const res = await worker.runAgent(spec(), ctx())
  assert.equal(res.status, "completed")
  assert.equal(res.text, "all done")
})

test("abort that truncates the stream after an accepted StructuredOutput → AgentInterrupted, not completed", async () => {
  const ac = new AbortController()
  const worker = new ClaudeWorker({
    queryFn: () =>
      (async function* (): AsyncGenerator<SDKMessage> {
        for (const m of structuredOutputTurn({ answer: 42 })) yield m as SDKMessage
        ac.abort() // the SDK can end the iterator cleanly on abort — no throw, no result message
      })(),
  })
  await assert.rejects(worker.runAgent(spec({ schema: SCHEMA }), ctx(ac.signal)), (e) => e instanceof AgentInterrupted)
})

test("subagent-relayed messages (parent_tool_use_id set) do not feed recovery state or usage", async () => {
  const worker = new ClaudeWorker({
    queryFn: scripted([
      {
        type: "assistant",
        parent_tool_use_id: "task1", // a Task subagent's stream relayed through the parent query
        message: { id: "sub1", usage: { input_tokens: 999, output_tokens: 99 }, content: [{ type: "tool_use", id: "so1", name: "StructuredOutput", input: { answer: 13 } }] },
      },
      userMsg([{ type: "tool_result", tool_use_id: "so1", content: "ok", is_error: false }]),
    ]),
  })
  await assert.rejects(worker.runAgent(spec({ schema: SCHEMA }), ctx()), (e) => e instanceof AgentError && e.code === "no_result")
})

test("a REJECTED StructuredOutput call is not recovery evidence; a later accepted one is", async () => {
  // rejected only → still no_result
  const rejectedOnly = new ClaudeWorker({
    queryFn: scripted([...structuredOutputTurn({ answer: "bad" }, { is_error: true }), assistantMsg([{ type: "text", text: "hm" }])]),
  })
  await assert.rejects(rejectedOnly.runAgent(spec({ schema: SCHEMA }), ctx()), (e) => e instanceof AgentError && e.code === "no_result")
  // rejected then accepted retry → the retry's payload is recovered
  const retried = new ClaudeWorker({
    queryFn: scripted([
      ...structuredOutputTurn({ answer: "bad" }, { id: "so1", is_error: true }),
      ...structuredOutputTurn({ answer: 7 }, { id: "so2" }),
    ]),
  })
  const res = await retried.runAgent(spec({ schema: SCHEMA }), ctx())
  assert.deepEqual(res.structured, { answer: 7 })
})

test("an IN-FLIGHT StructuredOutput call at truncation disables recovery (the accepted payload was being superseded)", async () => {
  const worker = new ClaudeWorker({
    queryFn: scripted([
      ...structuredOutputTurn({ answer: 1 }), // accepted
      assistantMsg([{ type: "tool_use", id: "so2", name: "StructuredOutput", input: { answer: 2 } }]), // stream cuts before so2's tool_result
    ]),
  })
  await assert.rejects(worker.runAgent(spec({ schema: SCHEMA }), ctx()), (e) => e instanceof AgentError && e.code === "no_result")
})

test("no-result recovery is schema-gated: free-form agents keep the hard no_result error", async () => {
  // Same truncated-stream shape, but no spec.schema → partial text must not pass as an answer.
  const worker = new ClaudeWorker({
    queryFn: scripted([...structuredOutputTurn({ answer: 42 }), assistantMsg([{ type: "text", text: "partial" }])]),
  })
  await assert.rejects(worker.runAgent(spec(), ctx()), (e) => e instanceof AgentError && e.code === "no_result")
})

// ===========================================================================
// abort semantics
// ===========================================================================

test("abort mid-query → AgentInterrupted, and the abort is PROPAGATED to the SDK's abortController", async () => {
  const ac = new AbortController()
  const calls: QueryCall[] = []
  const queryFn: QueryFn = (params) => {
    calls.push(params as QueryCall)
    return (async function* (): AsyncGenerator<SDKMessage> {
      // Hang until the worker-side controller fires (proves the ctx.signal → abortController
      // wiring), then throw the way the SDK does on abort. The ctx-signal backstop keeps a
      // broken wiring from hanging the test — the post-reject assert catches it instead.
      await new Promise<void>((resolve) => {
        params.options.abortController?.signal.addEventListener("abort", () => resolve(), { once: true })
        ac.signal.addEventListener("abort", () => setTimeout(resolve, 50), { once: true })
      })
      throw new Error("aborted")
    })()
  }
  const worker = new ClaudeWorker({ queryFn })
  const run = worker.runAgent(spec(), ctx(ac.signal))
  await tick()
  ac.abort()
  await assert.rejects(run, (e) => e instanceof AgentInterrupted)
  assert.equal(calls[0]!.options.abortController?.signal.aborted, true, "ctx.signal abort must propagate to the SDK controller")
})

test("the abort listener is removed once the turn settles (no leak onto a later ctx abort)", async () => {
  const ac = new AbortController()
  const calls: QueryCall[] = []
  const worker = new ClaudeWorker({ queryFn: scripted([resultMsg()], calls) })
  await worker.runAgent(spec(), ctx(ac.signal))
  ac.abort()
  assert.equal(calls[0]!.options.abortController?.signal.aborted, false, "a leaked listener aborted the finished turn's controller")
})

// Exercise the real retry owner with scripted SDK streams; no model calls.
for (const scenario of [
  { name: "SDK budget cap", messages: [], error: "Claude Code returned an error result: Exceeded maximum budget", attempts: 1 },
  { name: "SDK cap text", messages: [], error: "Claude Code returned an error result: Reached maximum number of turns (45)", attempts: 1 },
  { name: "result then throw", messages: [resultMsg({ subtype: "error_max_turns", errors: ["Reached maximum number of turns (45)"] })], error: "socket hung up", attempts: 1, usage: { inputTokens: 10, outputTokens: 4, costUsd: 0.01 } },
  { name: "quota exhaustion beats 429", messages: [], error: "429 rate_limit: You've hit your usage limit; resets at 11pm", attempts: 1 },
  { name: "subscription rejection beats generic rate limit", messages: [{ type: "rate_limit_event", rate_limit_info: { status: "rejected", rateLimitType: "five_hour" } }], error: "429 rate limit", attempts: 1 },
  { name: "unknown process exit", messages: [], error: "Claude Code process exited with code 1", attempts: 1 },
  { name: "completed result cannot replay on transient close error", messages: [resultMsg()], error: "529 overloaded_error", attempts: 1, usage: { inputTokens: 10, outputTokens: 4, costUsd: 0.01 } },
  { name: "notification cannot erase primary usage", messages: [resultMsg(), resultMsg({ origin: { kind: "task-notification" }, usage: { input_tokens: 0, output_tokens: 0 }, total_cost_usd: 0 })], error: "socket hung up", attempts: 1, usage: { inputTokens: 10, outputTokens: 4, costUsd: 0.01 } },
  { name: "success result usage survives throw", messages: [resultMsg()], error: "unrecognized failure", attempts: 1, usage: { inputTokens: 10, outputTokens: 4, costUsd: 0.01 } },
  { name: "stream usage survives throw", messages: [{ type: "assistant", message: { id: "a1", usage: { input_tokens: 7, output_tokens: 3 }, content: [] } }], error: "unrecognized failure", attempts: 1, usage: { inputTokens: 7, outputTokens: 3, costUsd: 0 }, partial: true },
  { name: "overload still retries and retains usage", messages: [resultMsg({ subtype: "error_during_execution", errors: ["529 overloaded_error"] })], error: "529 overloaded_error", attempts: 4, usage: { inputTokens: 10, outputTokens: 4, costUsd: 0.01 } },
  { name: "temporary rate limit still retries and retains usage", messages: [resultMsg({ subtype: "error_during_execution", errors: ["429 rate_limit_error"] })], error: "429 rate_limit_error: requests per minute exceeded", attempts: 4, usage: { inputTokens: 10, outputTokens: 4, costUsd: 0.01 } },
]) {
  test(`retry classification: ${scenario.name}`, async () => {
    let invocations = 0
    const worker = new ClaudeWorker({ queryFn: () => (async function* () {
      invocations++
      yield* scenario.messages as SDKMessage[]
      throw new Error(scenario.error)
    })() })
    const context = ctx()
    const retries: AgentError[] = []
    await assert.rejects(withRetry(() => worker.runAgent(spec(), context), context.signal, {
      baseMs: 0, onRetry: ({ error }) => { retries.push(error) },
    }), (error: unknown) => {
      assert.ok(error instanceof AgentError)
      assert.equal(error.retryable, scenario.attempts > 1)
      assert.ok(error.message.includes(scenario.error))
      assert.deepEqual(error.usage, scenario.usage)
      if (scenario.partial) assert.match(error.message, /lower bound; cost unknown/)
      return true
    })
    assert.equal(invocations, scenario.attempts)
    assert.equal(retries.length, scenario.attempts - 1)
    for (const error of retries) assert.deepEqual(error.usage, scenario.usage)
  })
}

for (const [errors, retryable] of [
  [["429 rate_limit_error: requests per minute exceeded"], true],
  [["429 rate_limit_error: subscription allowance exhausted"], false],
] as const) {
  test(`structured execution error classifies its detail: ${errors[0]}`, async () => {
    const worker = new ClaudeWorker({ queryFn: scripted([resultMsg({ subtype: "error_during_execution", errors })]) })
    await assert.rejects(worker.runAgent(spec(), ctx()), (error: unknown) => {
      assert.ok(error instanceof AgentError)
      assert.equal(error.retryable, retryable)
      assert.ok(error.message.includes(errors[0]))
      return true
    })
  })
}

test("success-subtype is_error result remains a failure", async () => {
  const worker = new ClaudeWorker({ queryFn: scripted([resultMsg({ is_error: true, result: "You've hit your limit" })]) })
  await assert.rejects(worker.runAgent(spec(), ctx()), (error: unknown) => error instanceof AgentError && !error.retryable && error.message.includes("You've hit your limit"))
})

test("no-result EOF labels assistant usage as partial", async () => {
  const worker = new ClaudeWorker({ queryFn: scripted([{ type: "assistant", message: { id: "a1", usage: { input_tokens: 7, output_tokens: 3 }, content: [] } }]) })
  await assert.rejects(worker.runAgent(spec(), ctx()), (error: unknown) => {
    assert.ok(error instanceof AgentError)
    assert.equal(error.code, "no_result")
    assert.equal(error.usage?.inputTokens, 7)
    assert.match(error.message, /lower bound; cost unknown/)
    return true
  })
})

for (const prefix of USAGE_LIMIT_ERROR_PREFIXES) {
  test(`SDK usage allowance marker is terminal even with 429: ${prefix}`, async () => {
    let calls = 0
    const worker = new ClaudeWorker({ queryFn: () => {
      calls++
      throw new Error(`Claude Code returned an error result: 429 ${prefix}`)
    } })
    const context = ctx()
    await assert.rejects(withRetry(() => worker.runAgent(spec(), context), context.signal, { baseMs: 0 }),
      (error: unknown) => error instanceof AgentError && !error.retryable && error.message.includes(prefix))
    assert.equal(calls, 1)
  })
}
