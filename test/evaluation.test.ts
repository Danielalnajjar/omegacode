import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { TypeSafeEvaluationClient, EvaluationError, validateEvaluationInput, validateEvaluationResponse } from "../src/evaluation/typesafe.ts"
import type { EvaluationClient } from "../src/evaluation/typesafe.ts"
import { Runtime } from "../src/runtime/primitives.ts"
import { Journal } from "../src/runtime/journal.ts"
import { DEFAULTS, emptyUsage, type AgentResult, type AgentSpec, type EvaluationQuestion, type EvaluationResult, type RunDefaults } from "../src/dsl/types.ts"
import type { EventSink, WorkflowEventInput } from "../src/runtime/events.ts"
import type { Worker, WorkerContext, WorkerFactory } from "../src/worker/index.ts"
import { runInSandbox } from "../src/runtime/sandbox.ts"
import { runWorkflow } from "../src/runtime/run.ts"
import { AgentInterrupted } from "../src/worker/index.ts"

const QUESTIONS: Record<string, EvaluationQuestion> = {
  supported: { type: "noul", instructions: "Does `claim` follow from `evidence`?" },
  route: {
    type: "choice",
    instructions: "Which route best matches `claim`?",
    criteria: { accept: "Supported", escalate: "Needs reasoning", reject: "Contradicted" },
  },
  materiality: { type: "score", instructions: "How material is `claim`?", criteria: ["none", "low", "material"] },
}

function responseBody() {
  return {
    model: "jev-latest",
    answers: {
      supported: { type: "noul", noul: 0.91 },
      route: { type: "choice", choice: "accept", probabilities: { accept: 0.8, escalate: 0.15, reject: 0.05 }, confidence: 0.77 },
      materiality: { type: "score", score: 1.6, legend: { "0": "none", "1": "low", "2": "material" }, probabilities: { "0": 0.05, "1": 0.3, "2": 0.65 }, confidence: 0.71 },
    },
    usage: { input_tokens: 1000, output_tokens: 12 },
  }
}

test("TypeSafe client sends one batched System One request and accounts usage", async () => {
  const calls: Array<{ url: unknown; init?: RequestInit }> = []
  const client = new TypeSafeEvaluationClient({
    apiKey: "test-key",
    fetchFn: (async (url, init) => {
      calls.push({ url, init })
      return new Response(JSON.stringify(responseBody()), { status: 200, headers: { "content-type": "application/json" } })
    }) as typeof fetch,
  })
  const result = await client.evaluate({ state: { claim: "x", evidence: "y" }, questions: QUESTIONS })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, "https://api.typesafe.ai/v1/systemone")
  const sent = JSON.parse(String(calls[0].init?.body))
  assert.equal(sent.model, "jev-latest")
  assert.deepEqual(Object.keys(sent.questions).sort(), Object.keys(QUESTIONS).sort())
  assert.equal(result.answers.route.type, "choice")
  assert.deepEqual(result.usage, { input_tokens: 1000, output_tokens: 12 })
  assert.equal(calls[0].init?.redirect, "error")
})

test("TypeSafe client retries only transient failures", async () => {
  let attempts = 0
  const sleeps: number[] = []
  const client = new TypeSafeEvaluationClient({
    apiKey: "test-key",
    sleep: async (ms) => { sleeps.push(ms) },
    fetchFn: (async () => {
      attempts += 1
      if (attempts < 3) return new Response(JSON.stringify({ detail: "busy" }), { status: 529 })
      return new Response(JSON.stringify(responseBody()), { status: 200 })
    }) as typeof fetch,
  })
  await client.evaluate({ state: { claim: "x" }, questions: QUESTIONS })
  assert.equal(attempts, 3)
  assert.deepEqual(sleeps, [250, 500])

  attempts = 0
  const bad = new TypeSafeEvaluationClient({
    apiKey: "test-key",
    fetchFn: (async () => { attempts += 1; return new Response(JSON.stringify({ detail: "bad" }), { status: 422 }) }) as typeof fetch,
  })
  await assert.rejects(() => bad.evaluate({ state: { claim: "x" }, questions: QUESTIONS }), (error: unknown) => {
    assert.ok(error instanceof EvaluationError)
    assert.equal(error.code, "http_422")
    return true
  })
  assert.equal(attempts, 1)
})

test("input and response validation fail closed", () => {
  assert.throws(() => validateEvaluationInput({ x: 1 }, {}), /must not be empty/)
  assert.throws(() => validateEvaluationInput({ x: 1 }, { q: { type: "choice", instructions: "x", criteria: { only: null } } }), /2\.\.255/)
  const wrong = responseBody()
  delete (wrong.answers as Record<string, unknown>).route
  assert.throws(() => validateEvaluationResponse(wrong, QUESTIONS, "jev-latest"), /exactly match question ids/)
})

test("permission is explicit and pinned on resume; fake evaluation never fetches", async () => {
  const home = mkdtempSync(join(tmpdir(), "omega-eval-permission-"))
  const previous = process.env.OMEGACODE_HOME
  const key = process.env.TYPESAFE_API_KEY
  const fetch = globalThis.fetch
  try {
    process.env.OMEGACODE_HOME = home
    process.env.TYPESAFE_API_KEY = "present-but-not-permission"
    globalThis.fetch = async () => { throw new Error("network forbidden") }
    const file = join(home, "permission.workflow.js")
    writeFileSync(file, 'export const meta = {name:"permission",description:"evaluation permission"}; return await evaluate({state:"evidence",questions:{q:{type:"noul",instructions:"supported?"}}})')
    const off = await runWorkflow({ file, fake: true, quiet: true })
    assert.equal(off.status, "failed")
    assert.match(off.error!, /disabled.*--typesafe/)
    assert.equal(Journal.load(off.runId).meta?.typesafeEvaluate, false)
    await assert.rejects(runWorkflow({ file, fake: true, quiet: true, resumeRunId: off.runId, typesafe: true }), /cannot change/)
    const on = await runWorkflow({ file, fake: true, quiet: true, typesafe: true })
    assert.equal(on.status, "completed")
    assert.deepEqual((on.result as EvaluationResult).answers.q, { type: "noul", noul: 0.5 })
    const resumed = await runWorkflow({ file, fake: true, quiet: true, resumeRunId: on.runId })
    assert.equal(resumed.status, "completed")
    assert.deepEqual(resumed.evaluationUsage?.actual, { input_tokens: 0, output_tokens: 0 })
  } finally {
    globalThis.fetch = fetch
    if (previous === undefined) delete process.env.OMEGACODE_HOME; else process.env.OMEGACODE_HOME = previous
    if (key === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = key
    rmSync(home, { recursive: true, force: true })
  }
})

test("admission snapshots input, rejects non-JSON and oversize requests, and honors Retry-After", async () => {
  const seen: unknown[] = []
  const sleeps: number[] = []
  const client = new TypeSafeEvaluationClient({ apiKey: "test", sleep: async ms => { sleeps.push(ms) }, fetchFn: async (_url, init) => {
    seen.push(JSON.parse(String(init?.body)))
    if (seen.length === 1) return new Response("sensitive remote detail", { status: 429, headers: { "retry-after": "2" } })
    return new Response(JSON.stringify(responseBody()))
  } })
  const request = { state: { value: "original" }, questions: QUESTIONS }
  const pending = client.evaluate(request)
  request.state.value = "changed"
  await pending
  assert.equal((seen[0] as any).state.value, "original")
  assert.deepEqual(sleeps, [2000])
  await assert.rejects(client.evaluate({ state: new Date() as any, questions: QUESTIONS }), /plain JSON/)
  await assert.rejects(client.evaluate({ state: "x".repeat(128000), questions: QUESTIONS }), /budget/)
  assert.equal(seen.length, 2)
})

class NoopWorker implements Worker {
  readonly id = "codex" as const
  async runAgent(_spec: AgentSpec, _ctx: WorkerContext): Promise<AgentResult> {
    return { text: "unused", status: "completed", usage: emptyUsage() }
  }
  async shutdown(): Promise<void> {}
}
class OneFactory implements WorkerFactory {
  worker = new NoopWorker()
  get(): Worker { return this.worker }
  async shutdownAll(): Promise<void> {}
}
class Sink implements EventSink {
  emit(_e: WorkflowEventInput): void {}
  async close(): Promise<void> {}
}
function defaults(): RunDefaults {
  return { ...DEFAULTS, provider: "codex", cwd: process.cwd() }
}

async function runtimeWith(client: EvaluationClient, home: string, loaded = Journal.load("jev_runtime")) {
  process.env.OMEGACODE_HOME = home
  return new Runtime({
    runId: "jev_runtime", defaults: defaults(), factory: new OneFactory(), journal: new Journal("jev_runtime"), loaded,
    events: new Sink(), args: null, seed: 7, baseTimeMs: 1000, signal: new AbortController().signal, evaluationClient: client,
  })
}

test("failed coalesced followers journal deterministically and retain failure across resume", async () => {
  const home = mkdtempSync(join(tmpdir(), "omega-followers-"))
  const previous = process.env.OMEGACODE_HOME
  let calls = 0
  const client: EvaluationClient = { evaluate: async () => { calls++; throw new EvaluationError("unavailable", "http_529", true, 529) } }
  try {
    process.env.OMEGACODE_HOME = home
    const runtime = await runtimeWith(client, home)
    const request = { state: "shared", questions: { q: { type: "noul" as const, instructions: "ok?" } } }
    const results = await Promise.allSettled(["a", "b"].map(key => runtime.globals().evaluate(request, { key })))
    assert.deepEqual(results.map(r => r.status), ["rejected", "rejected"])
    await assert.rejects(runtime.globals().evaluate(request, { key: "c" }), { code: "http_529" })
    assert.equal(calls, 1)
    const loaded = Journal.load("jev_runtime")
    assert.equal(loaded.evaluations?.size, 3)
    for (const e of loaded.evaluations!.values()) { assert.equal(e.status, "failed"); assert.equal(e.usage, undefined) }
    const resumed = await runtimeWith(client, home, loaded)
    await assert.rejects(resumed.globals().evaluate(request, { key: "new-key" }), { code: "http_529" })
    assert.equal(calls, 1)
  } finally { if (previous === undefined) delete process.env.OMEGACODE_HOME; else process.env.OMEGACODE_HOME = previous; rmSync(home, { recursive: true, force: true }) }
})

test("evaluation abort after provider resolution remains control flow through parallel", async () => {
  const home = mkdtempSync(join(tmpdir(), "omega-abort-eval-"))
  const previous = process.env.OMEGACODE_HOME
  try {
    process.env.OMEGACODE_HOME = home
    const ac = new AbortController()
    const runtime = new Runtime({ runId: "jev_runtime", defaults: { ...defaults(), maxAgents: 1 }, factory: new OneFactory(), journal: new Journal("jev_runtime"), loaded: Journal.load("jev_runtime"), events: new Sink(), args: null, seed: 7, baseTimeMs: 1000, signal: ac.signal, evaluationClient: { evaluate: async () => { ac.abort(); return responseBody() as EvaluationResult } } })
    await assert.rejects(runtime.globals().parallel([() => runtime.globals().evaluate({ state: "x", questions: QUESTIONS })]), AgentInterrupted)
    assert.equal([...Journal.load("jev_runtime").evaluations!.values()][0]?.status, "interrupted")
  } finally { if (previous === undefined) delete process.env.OMEGACODE_HOME; else process.env.OMEGACODE_HOME = previous; rmSync(home, { recursive: true, force: true }) }
})

test("HTTP attempts persist known and unknown usage separately and evaluation calls are not agent capped", async () => {
  const home = mkdtempSync(join(tmpdir(), "omega-attempts-"))
  const previous = process.env.OMEGACODE_HOME
  let calls = 0
  const client = new TypeSafeEvaluationClient({ apiKey: "test", sleep: async () => {}, fetchFn: async () => ++calls === 1 ? new Response("private", { status: 529 }) : new Response(JSON.stringify(responseBody())) })
  try {
    process.env.OMEGACODE_HOME = home
    const runtime = new Runtime({ runId: "jev_runtime", defaults: { ...defaults(), maxAgents: 1 }, factory: new OneFactory(), journal: new Journal("jev_runtime"), loaded: Journal.load("jev_runtime"), events: new Sink(), args: null, seed: 7, baseTimeMs: 1000, signal: new AbortController().signal, evaluationClient: client })
    await runtime.globals().evaluate({ state: "first", questions: QUESTIONS })
    await runtime.globals().evaluate({ state: "second", questions: QUESTIONS })
    assert.deepEqual(runtime.evaluationUsage.actual, { input_tokens: 2000, output_tokens: 24 })
    assert.equal(runtime.evaluationUsage.unknownAttempts, 1)
    const entries = readFileSync(join(home, "runs", "jev_runtime", "journal.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line))
    assert.equal(entries.filter(e => e.type === "evaluation_attempt" && e.phase === "started").length, 3)
    assert.equal(entries.filter(e => e.type === "evaluation_attempt" && e.phase === "finished").length, 3)
    assert.ok(!JSON.stringify(entries).includes("private"))
  } finally { if (previous === undefined) delete process.env.OMEGACODE_HOME; else process.env.OMEGACODE_HOME = previous; rmSync(home, { recursive: true, force: true }) }
})

test("evaluate() journals success and replays exact input without another network decision", async () => {
  const home = mkdtempSync(join(tmpdir(), "omega-eval-"))
  const previous = process.env.OMEGACODE_HOME
  let calls = 0
  const result = responseBody() as EvaluationResult
  const client: EvaluationClient = { evaluate: async () => { calls += 1; return result } }
  try {
    process.env.OMEGACODE_HOME = home
    const runtime1 = await runtimeWith(client, home, { results: new Map(), indexByKey: new Map(), evaluations: new Map() })
    const first = await runInSandbox({ body: 'return await evaluate({state:{claim:"x"}, questions:{q:{type:"noul",instructions:"supported?"}}}, {key:"claim-x"})', filename: "eval.js", globals: runtime1.globals() })
    assert.equal((first as EvaluationResult).model, "jev-latest")
    assert.equal(calls, 1)
    const loaded = Journal.load("jev_runtime")
    assert.equal(loaded.evaluations?.size, 1)

    const runtime2 = await runtimeWith({ evaluate: async () => { throw new Error("must not run") } }, home, loaded)
    const second = await runInSandbox({ body: 'return await evaluate({state:{claim:"x"}, questions:{q:{type:"noul",instructions:"supported?"}}}, {key:"claim-x"})', filename: "eval.js", globals: runtime2.globals() })
    assert.equal((second as EvaluationResult).model, "jev-latest")
    assert.equal(calls, 1)
  } finally {
    if (previous === undefined) delete process.env.OMEGACODE_HOME
    else process.env.OMEGACODE_HOME = previous
    rmSync(home, { recursive: true, force: true })
  }
})

test("journaled evaluation failure replays the same fallback decision on resume", async () => {
  const home = mkdtempSync(join(tmpdir(), "omega-eval-fail-"))
  const previous = process.env.OMEGACODE_HOME
  let calls = 0
  const failing: EvaluationClient = { evaluate: async () => { calls += 1; throw new EvaluationError("overloaded", "http_529", true, 529) } }
  try {
    process.env.OMEGACODE_HOME = home
    const runtime1 = await runtimeWith(failing, home, { results: new Map(), indexByKey: new Map(), evaluations: new Map() })
    const body = 'try { await evaluate({state:"x", questions:{q:{type:"noul",instructions:"ok?"}}}, {key:"fallback"}); return "jev" } catch { return "reasoning-fallback" }'
    assert.equal(await runInSandbox({ body, filename: "eval.js", globals: runtime1.globals() }), "reasoning-fallback")
    assert.equal(calls, 1)
    const loaded = Journal.load("jev_runtime")
    const runtime2 = await runtimeWith({ evaluate: async () => { calls += 100; return responseBody() as unknown as EvaluationResult } }, home, loaded)
    assert.equal(await runInSandbox({ body, filename: "eval.js", globals: runtime2.globals() }), "reasoning-fallback")
    assert.equal(calls, 1)
  } finally {
    if (previous === undefined) delete process.env.OMEGACODE_HOME
    else process.env.OMEGACODE_HOME = previous
    rmSync(home, { recursive: true, force: true })
  }
})

test("changed input under a resumed explicit key cannot replay; identical content is reused immutably", async () => {
  const home = mkdtempSync(join(tmpdir(), "omega-eval-content-"))
  const previous = process.env.OMEGACODE_HOME
  let calls = 0
  const client: EvaluationClient = { evaluate: async request => {
    calls++
    return { model: "jev-latest", answers: { q: { type: "noul", noul: request.state === "old" ? 0.2 : 0.8 } }, usage: { input_tokens: 37, output_tokens: 3 } }
  } }
  try {
    process.env.OMEGACODE_HOME = home
    const first = await runtimeWith(client, home)
    const questions = { q: { type: "noul" as const, instructions: "supported?" } }
    await first.globals().evaluate({ state: "old", questions }, { key: "stable" })
    const resumed = await runtimeWith(client, home, Journal.load("jev_runtime"))
    const changed = await resumed.globals().evaluate({ state: "new", questions }, { key: "stable" })
    assert.deepEqual(changed.answers.q, { type: "noul", noul: 0.8 })
    assert.throws(() => { (changed.answers.q as any).noul = 0.1 }, TypeError)
    const reused = await resumed.globals().evaluate({ state: "new", questions }, { key: "other" })
    assert.deepEqual(reused.answers.q, { type: "noul", noul: 0.8 })
    assert.equal(calls, 2)
    assert.deepEqual(resumed.evaluationUsage, { actual: { input_tokens: 37, output_tokens: 3 }, replayed: { input_tokens: 37, output_tokens: 3 }, unknownAttempts: 0 })
  } finally {
    if (previous === undefined) delete process.env.OMEGACODE_HOME; else process.env.OMEGACODE_HOME = previous
    rmSync(home, { recursive: true, force: true })
  }
})
