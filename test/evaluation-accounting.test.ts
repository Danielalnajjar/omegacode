import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Evaluator } from "../src/evaluation.ts"
import { runWorkflow } from "../src/runtime/run.ts"
import { Journal, journalPath } from "../src/runtime/journal.ts"
import { AgentInterrupted } from "../src/worker/index.ts"
import { setTestEnv } from "./test-env.ts"

const request = { state: "private-source", questions: { secretId: { type: "noul" as const, instructions: "private-rubric" } } }
const usage = { input_tokens: 13, output_tokens: 7 }
const response = { model: "jev-latest", answers: { secretId: { type: "noul", noul: 0.8 } }, usage }

test("earlier batch accounting survives failure and public resume without new billing", async t => {
  const dir = mkdtempSync(join(tmpdir(), "eval-ledger-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  setTestEnv(t, { OMEGACODE_HOME: dir, TYPESAFE_API_KEY: "synthetic" })
  const questions = Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`private-${i}`, request.questions.secretId]))
  let calls = 0
  t.mock.method(globalThis, "fetch", async (_url, opts) => {
    calls++
    const answers = Object.fromEntries(Object.keys(JSON.parse(opts.body).questions).map(k => [k, { type: "noul", noul: 0.8 }]))
    return calls === 1 ? Response.json({ ...response, answers }) : new Response("private-error", { status: 401 })
  })
  const file = join(dir, "account.workflow.js")
  writeFileSync(file, `export const meta={name:'account',description:'test'}; return await evaluate(${JSON.stringify({ ...request, questions })})`)
  const first = await runWorkflow({ file, typesafe: true, quiet: true })
  assert.equal(first.status, "failed")
  assert.deepEqual(first.evaluationUsage!.actual, { attempts: 2, unknownAttempts: 1, reported: usage, total: null })
  assert.deepEqual(first.evaluationUsage!.ledger.map(a => a.usage), [usage, null])
  assert.doesNotMatch(readFileSync(journalPath(first.runId), "utf8"), /private-|secretId|synthetic/)
  const replay = await runWorkflow({ file, typesafe: true, quiet: true, resumeRunId: first.runId })
  assert.equal(replay.status, "failed")
  assert.equal(calls, 2)
  assert.deepEqual(replay.evaluationUsage!.actual, first.evaluationUsage!.actual)
  assert.deepEqual(replay.evaluationUsage!.replayed, { successes: 0, failures: 1, usage: { input_tokens: 0, output_tokens: 0 } })
  assert.deepEqual(Journal.load(first.runId).evaluationLedger, first.evaluationUsage!.ledger)
})

test("malformed answers retain valid reported usage but never a successful receipt", async t => {
  setTestEnv(t, { TYPESAFE_API_KEY: "synthetic" })
  t.mock.method(globalThis, "fetch", async () => Response.json({ ...response, answers: {} }))
  const saved: unknown[] = []
  const evaluator = new Evaluator({ enabled: true, signal: new AbortController().signal, cached: new Map(), save: (_key, receipt) => saved.push(receipt) })
  await assert.rejects(evaluator.evaluate(request), /invalid_data/)
  assert.deepEqual(evaluator.accounting().actual, { attempts: 1, unknownAttempts: 0, reported: usage, total: usage })
  assert.deepEqual(saved, [{ status: "failed", code: "invalid_data" }])
})

test("retry and interruption admissions stay unknown across journal reload", async t => {
  const dir = mkdtempSync(join(tmpdir(), "eval-abort-ledger-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  setTestEnv(t, { OMEGACODE_HOME: dir, TYPESAFE_API_KEY: "synthetic" })
  const ac = new AbortController()
  const journal = new Journal("synthetic")
  let calls = 0
  t.mock.method(globalThis, "fetch", async () => {
    calls++
    assert.equal(Journal.load("synthetic").evaluationAttempts?.requests, calls)
    if (calls === 1) return new Response(null, { status: 529 })
    ac.abort()
    throw new Error("private-error")
  })
  const evaluator = new Evaluator({ enabled: true, signal: ac.signal, cached: new Map(), save: () => assert.fail(),
    saveAttempt: bytes => journal.append({ type: "evaluation-attempt", bytes }),
  })
  await assert.rejects(evaluator.evaluate(request), AgentInterrupted)
  assert.deepEqual(evaluator.accounting().actual, { attempts: 2, unknownAttempts: 2, reported: { input_tokens: 0, output_tokens: 0 }, total: null })
  assert.deepEqual(Journal.load("synthetic").evaluationLedger!.map(a => a.usage), [null, null])
})

test("journal callback failures prevent sends or leave durable usage unknown without leaking errors", async t => {
  setTestEnv(t, { TYPESAFE_API_KEY: "synthetic" })
  let calls = 0
  t.mock.method(globalThis, "fetch", async () => { calls++; return Response.json(response) })
  for (const stage of ["admission", "usage", "receipt"]) {
    const evaluator = new Evaluator({ enabled: true, signal: new AbortController().signal, cached: new Map(),
      saveAttempt: () => { if (stage === "admission") throw new Error("private-disk-error") },
      saveUsage: () => { if (stage === "usage") throw new Error("private-disk-error") },
      save: () => { if (stage === "receipt") throw new Error("private-disk-error") },
    })
    await assert.rejects(evaluator.evaluate(request), { message: "evaluation: request_failed" })
    assert.equal(evaluator.accounting().actual.attempts, stage === "admission" ? 0 : 1)
    assert.deepEqual(evaluator.accounting().actual.total, stage === "admission" ? { input_tokens: 0, output_tokens: 0 } : stage === "usage" ? null : usage)
  }
  assert.equal(calls, 2)
})

test("public success replay attributes tokens without increasing cumulative HTTP usage", async t => {
  const dir = mkdtempSync(join(tmpdir(), "eval-success-ledger-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  setTestEnv(t, { OMEGACODE_HOME: dir, TYPESAFE_API_KEY: "synthetic" })
  let calls = 0
  t.mock.method(globalThis, "fetch", async () => { calls++; return Response.json(response) })
  const file = join(dir, "account.workflow.js")
  writeFileSync(file, `export const meta={name:'account',description:'test'}; return await evaluate(${JSON.stringify(request)})`)
  const first = await runWorkflow({ file, typesafe: true, quiet: true })
  const replay = await runWorkflow({ file, typesafe: true, quiet: true, resumeRunId: first.runId })
  assert.equal(first.status, "completed")
  assert.equal(replay.status, "completed")
  assert.equal(calls, 1)
  assert.deepEqual(replay.evaluationUsage!.actual, { attempts: 1, unknownAttempts: 0, reported: usage, total: usage })
  assert.deepEqual(replay.evaluationUsage!.actual, first.evaluationUsage!.actual)
  assert.deepEqual(replay.evaluationUsage!.replayed, { successes: 1, failures: 0, usage })
})

test("cancellation during receipt save reaches producer and coalesced follower", async t => {
  setTestEnv(t, { TYPESAFE_API_KEY: "synthetic" })
  const ac = new AbortController()
  t.mock.method(globalThis, "fetch", async () => Response.json(response))
  const evaluator = new Evaluator({ enabled: true, signal: ac.signal, cached: new Map(), save: () => ac.abort() })
  await Promise.all([assert.rejects(evaluator.evaluate(request), AgentInterrupted), assert.rejects(evaluator.evaluate(request), AgentInterrupted)])
  assert.deepEqual(evaluator.accounting().actual.total, usage)
  assert.equal(evaluator.accounting().replayed.successes, 0)
})
