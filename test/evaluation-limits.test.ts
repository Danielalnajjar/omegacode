import { test } from "node:test"
import assert from "node:assert/strict"
import { setTimeout as delay } from "node:timers/promises"
import { Evaluator, MAX_NETWORK_BYTES, validateResult } from "../src/evaluation.ts"
import { AgentInterrupted } from "../src/worker/index.ts"
import { providerEnv } from "../src/worker/provider-env.ts"
import { Semaphore } from "../src/runtime/semaphore.ts"
import { setTestEnv } from "./test-env.ts"

const request = { state: "private-state", questions: { privateQuestion: { type: "noul" as const, instructions: "private-instruction" } } }
const result = { model: "jev-latest", answers: { privateQuestion: { type: "noul", noul: 0.7 } }, usage: { input_tokens: 1, output_tokens: 2 } }

test("queued cancellation removes waiter without stealing or leaking an active slot", async () => {
  const sem = new Semaphore(1)
  const release = await sem.acquire()
  const ac = new AbortController()
  const cancelled = sem.run(async () => assert.fail("cancelled waiter ran"), ac.signal)
  const rejected = assert.rejects(cancelled, /cancelled/)
  ac.abort(new Error("cancelled"))
  await rejected
  let started = false
  const next = sem.run(async () => { started = true })
  await delay(5)
  assert.equal(started, false)
  release()
  await next
  await sem.run(async () => {})
})

test("total deadline includes queue time, active HTTP and body consumption", async t => {
  setTestEnv(t, { TYPESAFE_API_KEY: "synthetic" })
  let calls = 0
  t.mock.method(globalThis, "fetch", async (_url, opts) => {
    calls++
    // Simulate a transport that takes time to finish abort cleanup. The queued deadline
    // must reject independently, not wait for that cleanup to release the only slot.
    await delay(80)
    opts.signal.throwIfAborted()
    return Response.json(result)
  })
  const evaluator = new Evaluator({ enabled: true, signal: new AbortController().signal, cached: new Map(), save: (_key, receipt) => assert.deepEqual(receipt, { status: "failed", code: "deadline" }), limits: { concurrency: 1, deadlineMs: 30 } })
  let firstSettled = false
  const first = evaluator.evaluate(request).finally(() => { firstSettled = true })
  const firstChecked = assert.rejects(first, { message: "evaluation: deadline" })
  await assert.rejects(evaluator.evaluate({ ...request, state: "second" }), { message: "evaluation: deadline" })
  assert.equal(firstSettled, false)
  await firstChecked
  assert.equal(calls, 1)
  t.mock.method(globalThis, "fetch", async (_url, opts) => new Response(new ReadableStream({
    start(controller) { opts.signal.addEventListener("abort", () => controller.error(new Error("private-network-detail")), { once: true }) },
  })))
  // Keep the event loop alive for the mock stream (real network streams have their own handle).
  await Promise.all([assert.rejects(evaluator.evaluate({ ...request, state: "body" }), { message: "evaluation: deadline" }), delay(50)])
})

test("parent cancellation drains active and queued evaluations, never becomes a fallback error", async t => {
  setTestEnv(t, { TYPESAFE_API_KEY: "synthetic" })
  const ac = new AbortController()
  let calls = 0
  t.mock.method(globalThis, "fetch", async (_url, opts) => {
    calls++
    await delay(500, undefined, { signal: opts.signal })
    return Response.json(result)
  })
  const evaluator = new Evaluator({ enabled: true, signal: ac.signal, cached: new Map(), save: () => assert.fail(), limits: { concurrency: 2 } })
  const work = Array.from({ length: 8 }, (_, i) => evaluator.evaluate({ ...request, state: String(i) }))
  const checked = Promise.all(work.map(p => assert.rejects(p, AgentInterrupted)))
  await delay(5)
  ac.abort(new Error("private-cancel-reason"))
  await checked
  assert.equal(calls, 2)
})

test("concurrency cap and in-flight dedup preserve independent copies and full explicit-key inputs", async t => {
  setTestEnv(t, { TYPESAFE_API_KEY: "synthetic" })
  let active = 0, peak = 0, calls = 0
  t.mock.method(globalThis, "fetch", async () => {
    calls++; peak = Math.max(peak, ++active)
    await delay(10)
    active--
    return Response.json(result)
  })
  const evaluator = new Evaluator({ enabled: true, signal: new AbortController().signal, cached: new Map(), save: () => {}, limits: { concurrency: 2 } })
  const identical = Array.from({ length: 4 }, () => evaluator.evaluate(request, { key: "explicit" }))
  const other = Array.from({ length: 5 }, (_, i) => evaluator.evaluate({ ...request, state: String(i) }, { key: "explicit" }))
  const results = await Promise.all([...identical, ...other])
  assert.equal(calls, 6)
  assert.equal(peak, 2)
  results[0]!.usage.input_tokens = 900
  assert.equal(results[1]!.usage.input_tokens, 1)
  await evaluator.evaluate({ ...request, questions: { privateQuestion: { ...request.questions.privateQuestion, instructions: "changed" } } }, { key: "explicit" })
  assert.equal(calls, 7)
})

test("Retry-After seconds/date cannot overrun total budget or trigger an early retry", async t => {
  setTestEnv(t, { TYPESAFE_API_KEY: "synthetic" })
  for (const header of ["120", "9".repeat(400), new Date(Date.now() + 120_000).toUTCString()]) {
    let calls = 0
    t.mock.method(globalThis, "fetch", async () => { calls++; return new Response(null, { status: 429, headers: { "retry-after": header } }) })
    const evaluator = new Evaluator({ enabled: true, signal: new AbortController().signal, cached: new Map(), save: (_key, receipt) => assert.deepEqual(receipt, { status: "failed", code: "deadline" }), limits: { deadlineMs: 50 } })
    await assert.rejects(evaluator.evaluate(request), { message: "evaluation: deadline" })
    assert.equal(calls, 1)
  }
  const times: number[] = []
  t.mock.method(globalThis, "fetch", async () => {
    times.push(performance.now())
    return times.length === 1 ? new Response(null, { status: 529, headers: { "retry-after": "0.3" } }) : Response.json(result)
  })
  await new Evaluator({ enabled: true, signal: new AbortController().signal, cached: new Map(), save: () => {} }).evaluate(request)
  assert.equal(times.length, 2)
  assert.ok(times[1]! - times[0]! >= 290)
})

test("independent call, HTTP request and outgoing-byte budgets bound runaway evaluation", async t => {
  setTestEnv(t, { TYPESAFE_API_KEY: "synthetic" })
  let calls = 0
  t.mock.method(globalThis, "fetch", async () => { calls++; return Response.json(result) })
  const limited = new Evaluator({ enabled: true, signal: new AbortController().signal, cached: new Map(), save: () => {}, limits: { maxCalls: 2 } })
  await limited.evaluate(request)
  await limited.evaluate(request)
  await assert.rejects(limited.evaluate(request), /call_cap/)
  assert.equal(calls, 1)
  const http = new Evaluator({ enabled: true, signal: new AbortController().signal, cached: new Map(), save: () => {}, limits: { maxRequests: 1 } })
  await http.evaluate(request)
  await assert.rejects(http.evaluate({ ...request, state: "different" }), /request_cap/)
  const bytes = new Evaluator({ enabled: true, signal: new AbortController().signal, cached: new Map(), save: () => {}, limits: { maxRequestBytes: 10 } })
  await assert.rejects(bytes.evaluate(request), /transfer_budget/)
  assert.equal(calls, 2)
})

test("identifiers including __proto__ round-trip without persisting source names", async t => {
  setTestEnv(t, { TYPESAFE_API_KEY: "synthetic" })
  const questions = JSON.parse('{"__proto__":{"type":"noul","instructions":"private"},"privateQuestion":{"type":"choice","instructions":"private","criteria":{"privateYes":null,"privateNo":null}}}')
  const response = JSON.parse('{"model":"jev-latest","answers":{"__proto__":{"type":"noul","noul":0.6},"privateQuestion":{"type":"choice","choice":"privateYes","probabilities":{"privateYes":0.8,"privateNo":0.2},"confidence":0.6}},"usage":{"input_tokens":1,"output_tokens":2}}')
  let calls = 0
  t.mock.method(globalThis, "fetch", async () => { calls++; return Response.json(response) })
  const cached = new Map()
  const evaluator = new Evaluator({ enabled: true, signal: new AbortController().signal, cached, save: () => {} })
  assert.deepEqual(await evaluator.evaluate({ state: "state", questions }), response)
  assert.deepEqual(await evaluator.evaluate({ state: "state", questions }), response)
  assert.equal(calls, 1)
  assert.doesNotMatch(JSON.stringify([...cached]), /private|__proto__/)
})

test("invalid JSON states and network failures never disclose request/credential/error text", async t => {
  setTestEnv(t, { TYPESAFE_API_KEY: "synthetic" })
  let calls = 0
  t.mock.method(globalThis, "fetch", async () => { calls++; throw new Error("synthetic private-network-detail") })
  const evaluator = new Evaluator({ enabled: true, signal: new AbortController().signal, cached: new Map(), save: (_key, receipt) => assert.deepEqual(receipt, { status: "failed", code: "request_failed" }) })
  const cyclic: any = {}; cyclic.self = cyclic
  for (const state of [{ a: undefined }, { a: NaN }, { toJSON() { return "hidden" } }, cyclic, new Date(), [1, , 3]]) {
    await assert.rejects(evaluator.evaluate({ ...request, state }), { message: "evaluation: invalid_request" })
  }
  assert.equal(calls, 0)
  await assert.rejects(evaluator.evaluate(request), { message: "evaluation: request_failed" })
  assert.equal(calls, 1)
  const env = providerEnv({ Typesafe_Api_Key: "synthetic", TYPESAFE_API_KEY: "synthetic", KEEP: "yes" })
  assert.equal(Object.keys(env).some(k => k.toUpperCase() === "TYPESAFE_API_KEY"), false)
  assert.equal(env.KEEP, "yes")
})

test("network packing respects whole-state byte budget; pinned models and options are checked", async t => {
  setTestEnv(t, { TYPESAFE_API_KEY: "synthetic" })
  const sizes: number[] = []
  const state = "s".repeat(16_000)
  t.mock.method(globalThis, "fetch", async (_url, opts) => {
    const body = JSON.parse(opts.body)
    assert.equal(body.state, state)
    assert.ok(Buffer.byteLength(opts.body) <= MAX_NETWORK_BYTES)
    sizes.push(Object.keys(body.questions).length)
    return Response.json({ ...result, model: "jev-pinned", answers: Object.fromEntries(Object.keys(body.questions).map(k => [k, { type: "noul", noul: 0.7 }])) })
  })
  const evaluator = new Evaluator({ enabled: true, signal: new AbortController().signal, cached: new Map(), save: () => {} })
  const questions = Object.fromEntries(Array.from({ length: 3 }, (_, i) => [String(i), { type: "noul" as const, instructions: "i".repeat(5_000) }]))
  const answer = await evaluator.evaluate({ state, questions, model: "jev-pinned" })
  assert.equal(Object.keys(answer.answers).length, 3)
  assert.deepEqual(sizes, [1, 1, 1])
  await assert.rejects(evaluator.evaluate({ state: "s".repeat(MAX_NETWORK_BYTES), questions }), /network_budget/)
  assert.equal(sizes.length, 3)
  await assert.rejects(evaluator.evaluate({ state, questions, model: "different-pinned" }), /model_mismatch/)
  for (const opts of [{ key: 12 }, { label: Infinity }, { key: "" }, { key: "x".repeat(257) }]) {
    await assert.rejects(evaluator.evaluate(request, opts as any), /invalid_options/)
  }
})

test("documented aliases resolve consistently across batches and replay the recorded model", async t => {
  setTestEnv(t, { TYPESAFE_API_KEY: "synthetic" })
  let calls = 0
  t.mock.method(globalThis, "fetch", async (_url, opts) => {
    calls++
    const body = JSON.parse(opts.body)
    assert.ok(["jev-latest", "jev-preview"].includes(body.model))
    return Response.json({ ...result, model: "jev-1.13.0",
      answers: Object.fromEntries(Object.keys(body.questions).map(k => [k, { type: "noul", noul: 0.7 }])) })
  })
  const questions = Object.fromEntries(Array.from({ length: 33 }, (_, i) => [String(i), request.questions.privateQuestion]))
  for (const model of ["jev-latest", "jev-preview"]) {
    const evaluator = new Evaluator({ enabled: true, signal: new AbortController().signal, cached: new Map(), save: () => {} })
    const input = { state: "state", questions, model }
    const first = await evaluator.evaluate(input)
    assert.equal(first.model, "jev-1.13.0")
    assert.equal(Object.keys(first.answers).length, 33)
    assert.deepEqual(await evaluator.evaluate(input), first)
    assert.equal(evaluator.accounting().actual.attempts, 2)
    assert.equal(evaluator.accounting().replayed.successes, 1)
  }
  assert.equal(calls, 4)
})

test("score accepts 2 through 10 criteria and rejects out-of-range counts before HTTP", async t => {
  setTestEnv(t, { TYPESAFE_API_KEY: "synthetic" })
  let calls = 0
  t.mock.method(globalThis, "fetch", async (_url, opts) => {
    calls++
    const { questions } = JSON.parse(opts.body)
    const criteria = questions.score.criteria as string[]
    return Response.json({ ...result, answers: { score: { type: "score", score: 0, confidence: 1,
      legend: Object.fromEntries(criteria.map((c, i) => [String(i), c])),
      probabilities: Object.fromEntries(criteria.map((_, i) => [String(i), i === 0 ? 1 : 0])),
    } } })
  })
  const evaluator = new Evaluator({ enabled: true, signal: new AbortController().signal, cached: new Map(), save: () => {} })
  const input = (count: number) => ({ state: "state", questions: { score: { type: "score" as const,
    instructions: "Rate the state", criteria: Array.from({ length: count }, (_, i) => `level ${i}`) } } })
  for (const count of [2, 10]) assert.equal((await evaluator.evaluate(input(count))).answers.score?.type, "score")
  for (const count of [1, 11]) await assert.rejects(evaluator.evaluate(input(count)), /invalid_data/)
  assert.equal(calls, 2)
})

test("live Score rounding boundary is accepted without admitting inconsistent scores", () => {
  const questions = { score: { type: "score" as const, instructions: "Read the count", criteria: ["zero", "one", "two"] } }
  const response = { ...result, model: "jev-1.13.0", answers: { score: { type: "score", score: 1.99,
    confidence: 0.99, legend: { "0": "zero", "1": "one", "2": "two" }, probabilities: { "0": 0, "1": 0, "2": 1 },
  } } }
  assert.deepEqual(validateResult(response, questions).answers, response.answers)
  for (const score of [1.989, 1.5, 2.01]) {
    assert.throws(() => validateResult({ ...response, answers: { score: { ...response.answers.score, score } } }, questions), /invalid_data/)
  }
})

test("interrupted HTTP admissions survive resume without recording a fallback failure", async t => {
  setTestEnv(t, { TYPESAFE_API_KEY: "synthetic" })
  const ac = new AbortController()
  const admissions = { requests: 0, bytes: 0 }
  const cached = new Map()
  let calls = 0
  t.mock.method(globalThis, "fetch", async () => { calls++; ac.abort(); throw new Error("transport stopped") })
  await assert.rejects(new Evaluator({ enabled: true, signal: ac.signal, cached, save: () => assert.fail(),
    saveAttempt: bytes => { admissions.requests++; admissions.bytes += bytes }, limits: { maxRequests: 1 },
  }).evaluate(request), AgentInterrupted)
  assert.equal(cached.size, 0)
  assert.equal(admissions.requests, 1)
  await assert.rejects(new Evaluator({ enabled: true, signal: new AbortController().signal, cached,
    save: (_key, receipt) => assert.deepEqual(receipt, { status: "failed", code: "request_cap" }), attempts: admissions, limits: { maxRequests: 1 },
  }).evaluate(request), /request_cap/)
  assert.equal(calls, 1)
})

test("aggregated usage must remain a safe integer across question batches", async t => {
  setTestEnv(t, { TYPESAFE_API_KEY: "synthetic" })
  t.mock.method(globalThis, "fetch", async (_url, opts) => {
    const { questions } = JSON.parse(opts.body)
    return Response.json({ ...result, usage: { input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 1 },
      answers: Object.fromEntries(Object.keys(questions).map(k => [k, { type: "noul", noul: 0.7 }])) })
  })
  const questions = Object.fromEntries(Array.from({ length: 33 }, (_, i) => [String(i), request.questions.privateQuestion]))
  const evaluator = new Evaluator({ enabled: true, signal: new AbortController().signal, cached: new Map(),
    save: (_key, receipt) => assert.deepEqual(receipt, { status: "failed", code: "invalid_data" }),
  })
  await assert.rejects(evaluator.evaluate({ state: "state", questions }), /invalid_data/)
  assert.equal(evaluator.accounting().actual.unknownAttempts, 0)
  assert.equal(evaluator.accounting().actual.reported, null)
  assert.equal(evaluator.accounting().actual.total, null)
  assert.deepEqual(evaluator.accounting().ledger.map(a => a.usage), [
    { input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 1 },
    { input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 1 },
  ])
})

test("alias drift between batches fails deterministically while preserving both usage reports", async t => {
  setTestEnv(t, { TYPESAFE_API_KEY: "synthetic" })
  let calls = 0
  t.mock.method(globalThis, "fetch", async (_url, opts) => {
    calls++
    const { questions } = JSON.parse(opts.body)
    return Response.json({ model: calls === 1 ? "jev-revision-a" : "jev-revision-b",
      answers: Object.fromEntries(Object.keys(questions).map(k => [k, { type: "noul", noul: 0.7 }])),
      usage: { input_tokens: calls * 3, output_tokens: calls },
    })
  })
  const questions = Object.fromEntries(Array.from({ length: 33 }, (_, i) => [String(i), request.questions.privateQuestion]))
  const evaluator = new Evaluator({ enabled: true, signal: new AbortController().signal, cached: new Map(), save: () => {} })
  await assert.rejects(evaluator.evaluate({ state: "state", questions }), /invalid_data/)
  await assert.rejects(evaluator.evaluate({ state: "state", questions }), /invalid_data/)
  assert.equal(calls, 2)
  assert.deepEqual(evaluator.accounting().actual.total, { input_tokens: 9, output_tokens: 3 })
  assert.deepEqual(evaluator.accounting().ledger.map(a => a.model), ["jev-revision-a", "jev-revision-b"])
  assert.equal(evaluator.accounting().replayed.failures, 1)
})

test("snapshots bind mutable input before queueing and alias replay retains the recorded model", async t => {
  setTestEnv(t, { TYPESAFE_API_KEY: "synthetic" })
  const received: unknown[] = []
  t.mock.method(globalThis, "fetch", async (_url, opts) => {
    const body = JSON.parse(opts.body)
    received.push(body)
    return Response.json({ ...result, model: "jev-revision-a" })
  })
  const cached = new Map()
  const evaluator = new Evaluator({ enabled: true, signal: new AbortController().signal, cached, save: () => {} })
  const mutable = structuredClone(request)
  const first = evaluator.evaluate(mutable, { key: "same-key" })
  mutable.state = "changed"
  mutable.questions.privateQuestion.instructions = "changed question"
  assert.equal((await first).model, "jev-revision-a")
  assert.deepEqual(received, [{ ...request, model: "jev-latest" }])
  assert.equal((await evaluator.evaluate(request, { key: "same-key" })).model, "jev-revision-a")
  await evaluator.evaluate(mutable, { key: "same-key" })
  assert.equal(received.length, 2)
  assert.deepEqual(received[1], { ...mutable, model: "jev-latest" })
})
