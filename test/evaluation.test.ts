import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Evaluator, validateResult } from "../src/evaluation.ts"
import type { EvaluationRequest, EvaluationResult } from "../src/evaluation-types.ts"
import { runWorkflow } from "../src/runtime/run.ts"
import { Journal, journalPath } from "../src/runtime/journal.ts"
import { AgentInterrupted } from "../src/worker/index.ts"
import { setTestEnv } from "./test-env.ts"

const request: EvaluationRequest = { state: "private-source", questions: { urgent: { type: "noul", instructions: "private-instruction" } } }
const result: EvaluationResult = { model: "jev-latest", answers: { urgent: { type: "noul", noul: 0.83 } }, usage: { input_tokens: 11, output_tokens: 3 } }

test("HTTP retry, full-input/model explicit-key identity, replay and no input journal disclosure", async t => {
  setTestEnv(t, { TYPESAFE_API_KEY: "test-only" })
  let calls = 0
  t.mock.method(globalThis, "fetch", async (url, opts) => {
    assert.equal(url, "https://api.typesafe.ai/v1/systemone")
    assert.equal(opts.redirect, "error")
    assert.equal(opts.headers.Authorization, "Bearer test-only")
    assert.equal(JSON.parse(opts.body).state.startsWith("private-source"), true)
    calls++
    return calls <= 2 ? new Response("not logged", { status: calls === 1 ? 429 : 529 }) : Response.json({ ...result, model: JSON.parse(opts.body).model })
  })
  const cached = new Map()
  const saved: unknown[] = []
  const evaluator = new Evaluator({ enabled: true, signal: new AbortController().signal, cached, save: (key, result) => saved.push({ key, result }) })
  assert.deepEqual(await evaluator.evaluate(request, { key: "stable" }), result)
  assert.equal(calls, 3)
  assert.deepEqual(await new Evaluator({ enabled: true, signal: new AbortController().signal, cached, save: () => assert.fail() }).evaluate(request, { key: "stable" }), result)
  assert.equal(calls, 3)
  await evaluator.evaluate({ ...request, state: "private-source-changed" }, { key: "stable" })
  await evaluator.evaluate({ ...request, model: "other-model" }, { key: "stable" })
  assert.equal(calls, 5)
  assert.doesNotMatch(JSON.stringify(saved), /private-source|private-instruction|test-only/)
})

test("disabled, oversized input, invalid answer and HTTP error do not disclose source", async t => {
  setTestEnv(t, { TYPESAFE_API_KEY: "test-only" })
  let calls = 0
  t.mock.method(globalThis, "fetch", async () => { calls++; return new Response("private-source test-only", { status: 401 }) })
  const evaluator = new Evaluator({ enabled: true, signal: new AbortController().signal, cached: new Map(), save: (_key, receipt) => assert.deepEqual(receipt, { status: "failed", code: "http_401" }) })
  await assert.rejects(new Evaluator({ enabled: false, signal: new AbortController().signal, cached: new Map(), save: () => assert.fail() }).evaluate(request), /disabled/)
  await assert.rejects(evaluator.evaluate({ ...request, state: "x".repeat(1_048_577) }), /invalid_data/)
  assert.equal(calls, 0)
  await assert.rejects(evaluator.evaluate(request), { message: "evaluation: http_401" })
  assert.throws(() => validateResult({ ...result, answers: { urgent: { type: "noul", noul: 1.1 } } }, request.questions))
})

test("parent cancellation propagates through active HTTP rather than becoming consumer fallback", async t => {
  setTestEnv(t, { TYPESAFE_API_KEY: "test-only" })
  const ac = new AbortController()
  t.mock.method(globalThis, "fetch", async (_url, opts) => {
    ac.abort()
    opts.signal.throwIfAborted()
    assert.fail("cancelled request continued")
  })
  await assert.rejects(new Evaluator({ enabled: true, signal: ac.signal, cached: new Map(), save: () => assert.fail() }).evaluate(request), AgentInterrupted)
})

test("independent questions batch without truncating state and aggregate usage", async t => {
  setTestEnv(t, { TYPESAFE_API_KEY: "test-only" })
  const sizes: number[] = []
  t.mock.method(globalThis, "fetch", async (_url, opts) => {
    const body = JSON.parse(opts.body)
    assert.equal(body.state, request.state)
    sizes.push(Object.keys(body.questions).length)
    return Response.json({ ...result, answers: Object.fromEntries(Object.keys(body.questions).map(k => [k, { type: "noul", noul: 0.83 }])) })
  })
  const questions = Object.fromEntries(Array.from({ length: 33 }, (_, i) => [String(i), request.questions.urgent]))
  const actual = await new Evaluator({ enabled: true, signal: new AbortController().signal, cached: new Map(), save: () => {} }).evaluate({ state: request.state, questions })
  assert.deepEqual(sizes, [32, 1])
  assert.deepEqual(actual.usage, { input_tokens: 22, output_tokens: 6 })
  assert.equal(Object.keys(actual.answers).length, 33)
})

test("real sandbox global, persisted replay, permission pinning and fake/off no network", async t => {
  const dir = mkdtempSync(join(tmpdir(), "omega-evaluation-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  setTestEnv(t, { OMEGACODE_HOME: dir, TYPESAFE_API_KEY: "test-only" })
  let calls = 0
  t.mock.method(globalThis, "fetch", async () => { calls++; return Response.json(result) })
  const file = join(dir, "evaluation.workflow.js")
  writeFileSync(file, `export const meta = { name: "evaluation", description: "test" }; return await evaluate(${JSON.stringify(request)}, {key:"fixed"})`)
  const run = await runWorkflow({ file, typesafe: true, quiet: true })
  assert.equal(run.status, "completed", run.error)
  assert.deepEqual(run.result, result)
  assert.equal(Journal.load(run.runId).meta?.typesafe, true)
  assert.doesNotMatch(readFileSync(journalPath(run.runId), "utf8"), /private-source|private-instruction|test-only/)
  const replay = await runWorkflow({ file, typesafe: true, quiet: true, resumeRunId: run.runId })
  assert.deepEqual(replay.result, result)
  assert.equal(calls, 1)
  const inherited = await runWorkflow({ file, quiet: true, resumeRunId: run.runId })
  assert.equal(inherited.status, "completed", inherited.error)
  assert.deepEqual(inherited.result, result)
  await assert.rejects(runWorkflow({ file, typesafe: false, quiet: true, resumeRunId: run.runId }), /must match/)
  for (const options of [{}, { typesafe: true, fake: true }]) {
    const off = await runWorkflow({ file, quiet: true, ...options })
    assert.equal(off.status, "failed")
    assert.match(off.error!, /disabled/)
  }
  assert.equal(calls, 1)
})

test("Choice and Score validate distributions; score rubric is omitted from replay receipt", async t => {
  setTestEnv(t, { TYPESAFE_API_KEY: "test-only" })
  const questions = {
    route: { type: "choice", instructions: "route", criteria: { yes: null, no: "no" } },
    rank: { type: "score", instructions: "rank", criteria: ["private-low", "private-high"] },
  } as const
  const response = { model: "jev-latest", answers: {
    route: { type: "choice", choice: "no", probabilities: { yes: 0.2, no: 0.8 }, confidence: 0.6 },
    rank: { type: "score", score: 0.75, probabilities: { "0": 0.25, "1": 0.75 }, legend: { "0": "private-low", "1": "private-high" }, confidence: 0.5 },
  }, usage: { input_tokens: 2, output_tokens: 3 } }
  t.mock.method(globalThis, "fetch", async () => Response.json(response))
  const receipts = new Map()
  const evaluator = new Evaluator({ enabled: true, signal: new AbortController().signal, cached: new Map(), save: (k, v) => receipts.set(k, v) })
  assert.deepEqual(await evaluator.evaluate({ state: "state", questions }), response)
  assert.doesNotMatch(JSON.stringify([...receipts]), /private-low|private-high/)
  t.mock.method(globalThis, "fetch", async () => assert.fail("replay made HTTP call"))
  assert.deepEqual(await new Evaluator({ enabled: true, signal: new AbortController().signal, cached: receipts, save: () => assert.fail() }).evaluate({ state: "state", questions }), response)
  assert.throws(() => validateResult({ ...response, answers: { ...response.answers, route: { ...response.answers.route, choice: "yes" } } }, questions))
})

test("oversized HTTP response journals only a sanitized failure", async t => {
  setTestEnv(t, { TYPESAFE_API_KEY: "test-only" })
  t.mock.method(globalThis, "fetch", async () => new Response("x".repeat(1_048_577)))
  await assert.rejects(new Evaluator({ enabled: true, signal: new AbortController().signal, cached: new Map(), save: (_key, receipt) => assert.deepEqual(receipt, { status: "failed", code: "invalid_data" }) }).evaluate(request), /invalid_data/)
})

test("failed evaluation keeps the same fallback branch on public resume", async t => {
  const dir = mkdtempSync(join(tmpdir(), "omega-eval-fallback-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  setTestEnv(t, { OMEGACODE_HOME: dir, TYPESAFE_API_KEY: "synthetic" })
  let calls = 0
  t.mock.method(globalThis, "fetch", async () => { calls++; return new Response("private-error", { status: 401 }) })
  const file = join(dir, "fallback.workflow.js")
  writeFileSync(file, `export const meta = { name: "fallback", description: "test" }; try { await evaluate(${JSON.stringify(request)}); return "jev" } catch { return "frontier" }`)
  const first = await runWorkflow({ file, typesafe: true, quiet: true })
  assert.equal(first.result, "frontier")
  const loaded = Journal.load(first.runId)
  assert.equal(loaded.evaluationAttempts?.requests, 1)
  assert.deepEqual([...loaded.evaluations!.values()], [{ status: "failed", code: "http_401" }])
  assert.doesNotMatch(readFileSync(journalPath(first.runId), "utf8"), /private-source|private-instruction|private-error|synthetic/)
  t.mock.method(globalThis, "fetch", async () => { calls++; return Response.json(result) })
  const resumed = await runWorkflow({ file, typesafe: true, quiet: true, resumeRunId: first.runId })
  assert.equal(resumed.result, "frontier")
  assert.equal(calls, 1)
})

test("public interrupted run retries evaluation but retains durable HTTP admission count", async t => {
  const dir = mkdtempSync(join(tmpdir(), "omega-eval-interrupted-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  setTestEnv(t, { OMEGACODE_HOME: dir, TYPESAFE_API_KEY: "synthetic" })
  const ac = new AbortController()
  t.mock.method(globalThis, "fetch", async () => { ac.abort(); throw new Error("private-cancellation") })
  const file = join(dir, "interrupted.workflow.js")
  writeFileSync(file, `export const meta = {name:'interrupt',description:'test'}; return await evaluate(${JSON.stringify(request)})`)
  const first = await runWorkflow({ file, typesafe: true, quiet: true, signal: ac.signal })
  assert.equal(first.status, "interrupted")
  assert.equal(Journal.load(first.runId).evaluationAttempts?.requests, 1)
  assert.equal(Journal.load(first.runId).evaluations?.size ?? 0, 0)
  t.mock.method(globalThis, "fetch", async () => Response.json(result))
  const resumed = await runWorkflow({ file, typesafe: true, quiet: true, resumeRunId: first.runId })
  assert.equal(resumed.status, "completed")
  assert.deepEqual(resumed.result, result)
  assert.equal(Journal.load(first.runId).evaluationAttempts?.requests, 2)
})

test("unawaited failure emits a bounded diagnostic and stable failure receipt", async t => {
  const dir = mkdtempSync(join(tmpdir(), "omega-eval-unawaited-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  setTestEnv(t, { OMEGACODE_HOME: dir, TYPESAFE_API_KEY: "synthetic" })
  t.mock.method(globalThis, "fetch", async () => { throw new Error("private-network-detail") })
  const file = join(dir, "unawaited.workflow.js")
  writeFileSync(file, `export const meta = {name:'unawaited',description:'test'}; evaluate(${JSON.stringify(request)}); return "body-result"`)
  const logs: string[] = []
  const outcome = await runWorkflow({ file, typesafe: true, quiet: true, onEvent: e => { if (e.type === "log") logs.push(e.message) } })
  assert.equal(outcome.status, "completed")
  assert.equal(outcome.result, "body-result")
  assert.deepEqual(logs, ["evaluation failed; no answer is available"])
  assert.deepEqual([...Journal.load(outcome.runId).evaluations!.values()], [{ status: "failed", code: "request_failed" }])
})