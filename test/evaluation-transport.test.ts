import { test } from "node:test"
import assert from "node:assert/strict"
import { TypeSafeEvaluationClient, admitEvaluation, validateEvaluationResponse, type EvaluationAttempt } from "../src/evaluation/typesafe.ts"
import type { EvaluationRequest } from "../src/dsl/types.ts"
import { evaluationKey } from "../src/runtime/keys.ts"

const request: EvaluationRequest = { state: { count: 3, valid: true, nullable: null }, questions: { q: { type: "noul", instructions: "ok?" } } }
function response(body: EvaluationRequest, usage = { input_tokens: 7, output_tokens: 2 }) {
  return new Response(JSON.stringify({ model: body.model, answers: Object.fromEntries(Object.keys(body.questions).map(id => [id, { type: "noul", noul: 0.7 }])), usage }))
}

test("pinned model and UTF8 partitioning preserve all independent questions and sum raw usage", async () => {
  const sent: EvaluationRequest[] = []
  const receipts: EvaluationAttempt[] = []
  const client = new TypeSafeEvaluationClient({ apiKey: "test", fetchFn: async (_url, init) => {
    assert.ok(Buffer.byteLength(String(init?.body)) <= 32000)
    assert.equal(init?.redirect, "error")
    const body = JSON.parse(String(init?.body)); sent.push(body)
    return response(body, { input_tokens: sent.length * 11, output_tokens: sent.length })
  } })
  const questions = Object.fromEntries(["first", "second", "third"].map(id => [id, { type: "noul" as const, instructions: "界".repeat(6000) }]))
  const result = await client.evaluate({ state: "shared", model: "jev-2026-09-01", questions }, undefined, e => receipts.push(e))
  assert.equal(sent.length, 3)
  assert.deepEqual(Object.keys(result.answers), ["first", "second", "third"])
  assert.equal(result.model, "jev-2026-09-01")
  assert.deepEqual(result.usage, { input_tokens: 66, output_tokens: 6 })
  assert.deepEqual(receipts.map(e => [e.phase, e.batch, e.attempt]), [["started",1,1],["finished",1,1],["started",2,1],["finished",2,1],["started",3,1],["finished",3,1]])
})

test("closed JSON admission rejects invalid instructions, criteria, getters and unknown fields without echoing identifiers", () => {
  for (const instructions of [null, 1, true]) assert.throws(() => admitEvaluation({ ...request, questions: { q: { type: "noul", instructions } } } as any), /instructions/)
  assert.throws(() => admitEvaluation({ ...request, questions: { q: { type: "noul", instructions: "ok", criteria: { true: 7 } } } } as any), /criteria/)
  assert.throws(() => admitEvaluation({ ...request, timeoutMs: 1 } as any), /fields/)
  assert.throws(() => admitEvaluation(request, { model: "other" } as any), /fields/)
  assert.throws(() => admitEvaluation({ ...request, questions: { SECRET_SOURCE: { type: "noul", instructions: "ok", extra: 1 } } } as any), error => !String(error).includes("SECRET_SOURCE"))
  assert.throws(() => admitEvaluation({ ...request, state: { get hidden() { throw new Error("source-bearing getter") } } }), /data properties/)
  assert.throws(() => admitEvaluation({ ...request, model: " " }), /model/)
})

test("prototype-like ids and choice options remain own data, inherited choices are rejected", () => {
  assert.notEqual(evaluationKey("root", 0, JSON.parse('{"__proto__":"first"}'), {}, "jev-latest"), evaluationKey("root", 0, JSON.parse('{"__proto__":"second"}'), {}, "jev-latest"))
  const criteria = JSON.parse('{"__proto__":null,"constructor":null}')
  const questions = Object.fromEntries([["__proto__", { type: "choice" as const, instructions: "choose", criteria }]])
  const body = { model: "jev-latest", answers: Object.fromEntries([["__proto__", { type: "choice", choice: "__proto__", probabilities: JSON.parse('{"__proto__":0.7,"constructor":0.3}'), confidence: 0.6 }]]), usage: { input_tokens: 4, output_tokens: 1 } }
  const result = validateEvaluationResponse(body, questions, "jev-latest")
  assert.equal(Object.hasOwn(result.answers, "__proto__"), true)
  const answer = result.answers["__proto__"] as any
  assert.equal(Object.hasOwn(answer.probabilities, "__proto__"), true)
  assert.equal(answer.probabilities["__proto__"], 0.7)
  body.answers["__proto__"].choice = "toString"
  assert.throws(() => validateEvaluationResponse(body, questions, "jev-latest"), /choice/)
})

test("response byte limit cancels the body and records unknown usage", async () => {
  let cancelled = false
  const receipts: EvaluationAttempt[] = []
  const client = new TypeSafeEvaluationClient({ apiKey: "test", fetchFn: async () => new Response(new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(600000)) }, cancel() { cancelled = true } })) })
  await assert.rejects(client.evaluate(request, undefined, e => receipts.push(e)), { code: "response_too_large" })
  assert.equal(cancelled, true)
  assert.equal(receipts.length, 2)
  assert.equal(receipts[1]?.usage, undefined)
})

test("total deadline covers a stalled body even when the stream ignores fetch cancellation", async () => {
  let cancelled = false
  const client = new TypeSafeEvaluationClient({ apiKey: "test", deadlineMs: 30, fetchFn: async () => new Response(new ReadableStream({ cancel() { cancelled = true } })) })
  await assert.rejects(client.evaluate(request), { code: "timeout" })
  assert.equal(cancelled, true)
})

test("queued abort never admits HTTP and does not leak capacity", async () => {
  let calls = 0
  let release!: () => void
  const hold = new Promise<void>(r => { release = r })
  const client = new TypeSafeEvaluationClient({ apiKey: "test", fetchFn: async (_url, init) => { calls++; await hold; return response(JSON.parse(String(init?.body))) } })
  const active = Array.from({ length: 8 }, () => client.evaluate(request))
  await new Promise(r => setImmediate(r))
  const ac = new AbortController()
  const queued = client.evaluate(request, ac.signal)
  ac.abort()
  try { await assert.rejects(queued, { code: "aborted" }); assert.equal(calls, 8) }
  finally { release(); await Promise.all(active) }
  await client.evaluate(request)
  assert.equal(calls, 9)
})

test("numeric and date Retry-After are honored; waits outside total deadline never retry early", async () => {
  for (const header of ["2", new Date(Date.now() + 3000).toUTCString()]) {
    let calls = 0
    const delays: number[] = []
    const client = new TypeSafeEvaluationClient({ apiKey: "test", sleep: async ms => { delays.push(ms) }, fetchFn: async (_url, init) => ++calls === 1 ? new Response("private", { status: 429, headers: { "retry-after": header } }) : response(JSON.parse(String(init?.body))) })
    await client.evaluate(request)
    assert.equal(calls, 2)
    assert.ok(delays[0]! >= 1500)
  }
  let calls = 0
  const client = new TypeSafeEvaluationClient({ apiKey: "test", deadlineMs: 50, fetchFn: async () => { calls++; return new Response("private", { status: 529, headers: { "retry-after": "60" } }) } })
  await assert.rejects(client.evaluate(request), { code: "timeout" })
  assert.equal(calls, 1)
})

test("journal callback failure prevents admission or retry, while malformed answers preserve known usage", async () => {
  let calls = 0
  const client = new TypeSafeEvaluationClient({ apiKey: "test", fetchFn: async (_url, init) => { calls++; return response(JSON.parse(String(init?.body))) } })
  await assert.rejects(client.evaluate(request, undefined, () => { throw new Error("disk full") }), { code: "callback_error" })
  assert.equal(calls, 0)
  await assert.rejects(client.evaluate(request, undefined, event => { if (event.phase === "finished") throw new Error("disk full") }), { code: "callback_error" })
  assert.equal(calls, 1)
  const receipts: EvaluationAttempt[] = []
  const malformed = new TypeSafeEvaluationClient({ apiKey: "test", fetchFn: async () => new Response(JSON.stringify({ model: "jev-latest", answers: {}, usage: { input_tokens: 19, output_tokens: 2 } })) })
  await assert.rejects(malformed.evaluate(request, undefined, e => receipts.push(e)), { code: "invalid_response" })
  assert.deepEqual(receipts[1]?.usage, { input_tokens: 19, output_tokens: 2 })
})
