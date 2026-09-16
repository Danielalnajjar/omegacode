import { createHash } from "node:crypto"
import { setTimeout as delay } from "node:timers/promises"
import { Semaphore } from "./runtime/semaphore.js"
import { AgentInterrupted } from "./worker/index.js"
import type { EvaluationRequest, EvaluationOptions, EvaluationResult, EvaluationReceipt, Question } from "./evaluation-types.js"
export const EVALUATION_LIMITS = Object.freeze({
  concurrency: 4, deadlineMs: 30_000, maxCalls: 256, maxRequests: 1024, maxRequestBytes: 16 * 1_048_576,
})
export class EvaluationError extends Error {
  constructor(public readonly code: string) { super(`evaluation: ${code}`) }
}
const MAX_BYTES = 1_048_576
// Conservative network admission under the documented ~32K-token window. UTF-8 bytes
// are not tokenizer accounting; reserve margin and reject, never clip, an oversized state.
export const MAX_NETWORK_BYTES = 24 * 1024
const FAILURE_CODES = new Set(["invalid_data", "invalid_request", "missing_key", "deadline", "request_cap", "transfer_budget", "request_failed", "model_mismatch", "network_budget", "http_401", "http_403", "http_422", "http_429", "http_529", "http_error"])
const object = (v: unknown): v is Record<string, any> => v !== null && typeof v === "object" && !Array.isArray(v)
const content = (v: unknown) => typeof v === "string" || object(v) || Array.isArray(v)
const unit = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1
function check(ok: unknown): asserts ok { if (!ok) throw new EvaluationError("invalid_data") }

// JSON.stringify silently drops undefined/functions and converts NaN to null. Reject those
// rather than evaluating a different state. Read descriptors, never caller getters/toJSON.
function jsonValue(value: unknown, ancestors = new Set<object>(), depth = 0): unknown {
  check(depth <= 64)
  if (value === null || typeof value === "string" || typeof value === "boolean") return value
  if (typeof value === "number") { check(Number.isFinite(value)); return value }
  check(typeof value === "object" && value !== null && !ancestors.has(value))
  const proto = Object.getPrototypeOf(value)
  check(Array.isArray(value) || proto === null || Object.getPrototypeOf(proto) === null)
  ancestors.add(value)
  const descriptors = Object.getOwnPropertyDescriptors(value)
  check(Object.getOwnPropertySymbols(value).length === 0)
  const entries = Object.entries(descriptors).filter(([k]) => !(Array.isArray(value) && k === "length"))
  check(entries.every(([, d]) => d.enumerable && "value" in d))
  const mapped = entries.map(([k, d]) => [k, jsonValue(d.value, ancestors, depth + 1)] as const)
  ancestors.delete(value)
  if (Array.isArray(value)) {
    check(mapped.length === value.length && mapped.every(([k], i) => k === String(i)))
    return mapped.map(([, v]) => v)
  }
  return Object.fromEntries(mapped)
}

/** Snapshot the complete JSON input before awaiting; never clip source to fit a request. */
export function snapshot(input: EvaluationRequest): EvaluationRequest & { model: string } {
  let text: string
  try { text = JSON.stringify(jsonValue(input)) } catch { throw new EvaluationError("invalid_request") }
  check(typeof text === "string" && Buffer.byteLength(text) <= MAX_BYTES)
  const r = JSON.parse(text)
  check(object(r) && content(r.state) && object(r.questions) && Object.keys(r.questions).length > 0 && Object.keys(r.questions).length <= 1024)
  check(Object.keys(r).every(k => ["state", "questions", "model"].includes(k)))
  if (!Object.hasOwn(r, "model")) r.model = "jev-latest"
  check(typeof r.model === "string" && r.model.length > 0 && r.model.length <= 256)
  for (const q of Object.values(r.questions)) {
    check(object(q) && content(q.instructions))
    check(Object.keys(q).every(k => ["type", "instructions", "criteria"].includes(k)))
    if (q.type === "noul") check(q.criteria === undefined || (object(q.criteria) && Object.entries(q.criteria).every(([k, v]) => ["true", "false"].includes(k) && typeof v === "string")))
    else if (q.type === "choice") check(object(q.criteria) && Object.keys(q.criteria).length > 0 && Object.keys(q.criteria).length <= 255 && Object.values(q.criteria).every(v => v === null || typeof v === "string"))
    else if (q.type === "score") check(Array.isArray(q.criteria) && q.criteria.length >= 2 && q.criteria.every((v: unknown) => typeof v === "string"))
    else check(false)
  }
  return r as EvaluationRequest & { model: string }
}

export function validateResult(raw: unknown, questions: Record<string, Question>): EvaluationResult {
  check(object(raw) && typeof raw.model === "string" && /^[a-zA-Z0-9._:/-]{1,256}$/.test(raw.model) && object(raw.answers) && object(raw.usage))
  check(Object.keys(raw.answers).length === Object.keys(questions).length)
  for (const n of [raw.usage.input_tokens, raw.usage.output_tokens]) check(Number.isSafeInteger(n) && n >= 0)
  for (const [id, q] of Object.entries(questions)) {
    check(Object.hasOwn(raw.answers, id))
    const a = raw.answers[id]
    check(object(a) && a.type === q.type)
    if (q.type === "noul") { check(unit(a.noul)); continue }
    const keys = q.type === "choice" ? Object.keys(q.criteria) : q.criteria.map((_, i) => String(i))
    check(object(a.probabilities) && Object.keys(a.probabilities).length === keys.length && keys.every(k => Object.hasOwn(a.probabilities, k) && unit(a.probabilities[k])))
    check(Math.abs(keys.reduce((sum, k) => sum + a.probabilities[k], 0) - 1) < 0.001 && unit(a.confidence))
    if (q.type === "choice") check(keys.includes(a.choice) && keys.every(k => a.probabilities[a.choice] >= a.probabilities[k]))
    else {
      check(typeof a.score === "number" && Number.isFinite(a.score) && a.score >= 0 && a.score <= keys.length - 1)
      check(object(a.legend) && Object.keys(a.legend).length === keys.length && keys.every(k => Object.hasOwn(a.legend, k) && a.legend[k] === q.criteria[Number(k)]))
      check(Math.abs(a.score - keys.reduce((sum, k) => sum + Number(k) * a.probabilities[k], 0)) < 0.01)
    }
  }
  // Discard extra remote fields: they must not become a journal or error disclosure channel.
  const answers = Object.fromEntries(Object.entries(questions).map(([id, q]) => {
    const a = raw.answers[id]
    return [id, q.type === "noul" ? { type: q.type, noul: a.noul } : q.type === "choice"
      ? { type: q.type, choice: a.choice, probabilities: a.probabilities, confidence: a.confidence }
      : { type: q.type, score: a.score, legend: a.legend, probabilities: a.probabilities, confidence: a.confidence }]
  }))
  return { model: raw.model, answers, usage: { input_tokens: raw.usage.input_tokens, output_tokens: raw.usage.output_tokens } } as EvaluationResult
}

export class Evaluator {
  private readonly sem: Semaphore
  private readonly limits: { [K in keyof typeof EVALUATION_LIMITS]: number }
  private calls = 0
  private requests = 0
  private requestBytes = 0
  private readonly pending = new Map<string, Promise<EvaluationResult>>()
  constructor(private readonly o: {
    enabled: boolean; signal: AbortSignal;
    cached: Map<string, EvaluationReceipt>;
    save: (key: string, result: EvaluationReceipt) => void;
    attempts?: { requests: number; bytes: number };
    saveAttempt?: (bytes: number) => void;
    /** Embedding/test limits; the workflow DSL cannot change these. */
    limits?: Partial<{ [K in keyof typeof EVALUATION_LIMITS]: number }>;
  }) {
    this.limits = { ...EVALUATION_LIMITS, ...o.limits }
    for (const value of Object.values(this.limits)) check(Number.isSafeInteger(value) && value > 0)
    this.sem = new Semaphore(this.limits.concurrency)
    this.requests = o.attempts?.requests ?? 0
    this.requestBytes = o.attempts?.bytes ?? 0
  }

  evaluate = async (input: EvaluationRequest, opts?: EvaluationOptions): Promise<EvaluationResult> => {
    if (this.o.signal.aborted) throw new AgentInterrupted()
    if (!this.o.enabled) throw new EvaluationError("disabled")
    if (++this.calls > this.limits.maxCalls) throw new EvaluationError("call_cap")
    try {
      if (opts !== undefined) opts = jsonValue(opts) as EvaluationOptions
      check(opts === undefined || (object(opts) && Object.keys(opts).every(k => ["key", "label"].includes(k)) && [opts.key, opts.label].every(v => v === undefined || (typeof v === "string" && v.length > 0 && v.length <= 256))))
    } catch { throw new EvaluationError("invalid_options") }
    const request = snapshot(input)
    const key = createHash("sha256").update(JSON.stringify(["evaluation-v2", opts?.key ?? null, request])).digest("hex")
    const cached = this.o.cached.get(key)
    if (cached) {
      if (cached.status === "failed") {
        check(FAILURE_CODES.has(cached.code))
        throw new EvaluationError(cached.code)
      }
      check(cached.status === "completed")
      check(Array.isArray(cached.answers) && cached.answers.length === Object.keys(request.questions).length)
      const answers = Object.fromEntries(Object.entries(request.questions).map(([id, q], i) => {
        const a = cached.answers[i]
        if (q.type === "noul") return [id, { type: q.type, noul: a }]
        check(object(a) && Array.isArray(a.probabilities))
        const keys = q.type === "choice" ? Object.keys(q.criteria) : q.criteria.map((_, j) => String(j))
        check(a.probabilities.length === keys.length)
        const probabilities = Object.fromEntries(keys.map((k, j) => [k, a.probabilities[j]]))
        return [id, q.type === "choice" ? { type: q.type, choice: keys[a.value], probabilities, confidence: a.confidence }
          : { type: q.type, score: a.value, legend: Object.fromEntries(q.criteria.map((v, j) => [String(j), v])), probabilities, confidence: a.confidence }]
      }))
      return validateResult({ model: cached.model, usage: cached.usage, answers }, request.questions)
    }
    let p = this.pending.get(key)
    if (!p) {
      p = this.execute(request).then(result => {
        if (this.o.signal.aborted) throw new AgentInterrupted()
        const receipt: EvaluationReceipt = { status: "completed", model: result.model, usage: result.usage,
          answers: Object.entries(request.questions).map(([id, q]) => {
            const a = result.answers[id]!
            if (a.type === "noul") return a.noul
            const keys = q.type === "choice" ? Object.keys(q.criteria) : (q as Extract<Question, { type: "score" }>).criteria.map((_, i) => String(i))
            return { value: a.type === "choice" ? keys.indexOf(a.choice) : a.score, probabilities: keys.map(k => a.probabilities[k]!), confidence: a.confidence }
          }),
        }
        this.o.save(key, receipt)
        this.o.cached.set(key, receipt)
        return result
      }, error => {
        if (this.o.signal.aborted || error instanceof AgentInterrupted) throw new AgentInterrupted()
        const code = error instanceof EvaluationError && FAILURE_CODES.has(error.code) ? error.code : "request_failed"
        const receipt: EvaluationReceipt = { status: "failed", code }
        this.o.save(key, receipt)
        this.o.cached.set(key, receipt)
        throw new EvaluationError(code)
      })
      this.pending.set(key, p)
      const clear = () => this.pending.delete(key)
      p.then(clear, clear)
    }
    return structuredClone(await p)
  }

  private async execute(request: EvaluationRequest & { model: string }): Promise<EvaluationResult> {
    const deadline = new AbortController()
    const timer = setTimeout(() => deadline.abort(), this.limits.deadlineMs)
    timer.unref()
    const signal = AbortSignal.any([this.o.signal, deadline.signal])
    const expires = performance.now() + this.limits.deadlineMs
    try {
      const token = process.env.TYPESAFE_API_KEY
      if (!token) throw new EvaluationError("missing_key")
      const entries = Object.entries(request.questions)
      const batches: Record<string, Question>[] = []
      let packed: Array<[string, Question]> = []
      const fits = (items: Array<[string, Question]>) => Buffer.byteLength(JSON.stringify({ state: request.state, model: request.model, questions: Object.fromEntries(items) })) <= MAX_NETWORK_BYTES
      for (const entry of entries) {
        if (!fits([entry])) throw new EvaluationError("network_budget")
        if (packed.length === 32 || !fits([...packed, entry])) { batches.push(Object.fromEntries(packed)); packed = [] }
        packed.push(entry)
      }
      if (packed.length) batches.push(Object.fromEntries(packed))
      const result: EvaluationResult = { model: "", answers: Object.create(null), usage: { input_tokens: 0, output_tokens: 0 } }
      for (const questions of batches) {
        const batch = await this.sem.run(async () => {
          const body = JSON.stringify({ state: request.state, model: request.model, questions })
          check(Buffer.byteLength(body) <= MAX_BYTES)
          for (let attempt = 0; ; attempt++) {
            signal.throwIfAborted()
            if (this.requests >= this.limits.maxRequests) throw new EvaluationError("request_cap")
            const outgoingBytes = Buffer.byteLength(body)
            if (this.requestBytes + outgoingBytes > this.limits.maxRequestBytes) throw new EvaluationError("transfer_budget")
            this.o.saveAttempt?.(outgoingBytes) // durable admission before HTTP, including interrupted attempts
            this.requests++
            this.requestBytes += outgoingBytes
            const response = await fetch("https://api.typesafe.ai/v1/systemone", {
              method: "POST", redirect: "error", signal,
              headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body,
            })
            if (!response.ok) {
              await response.body?.cancel()
              if ((response.status === 429 || response.status === 529) && attempt < 2) {
                const header = response.headers.get("retry-after")
                const seconds = header !== null && /^\d+(\.\d+)?$/.test(header.trim()) ? Number(header) : NaN
                const retry = Number.isFinite(seconds) ? seconds * 1000 : header ? Date.parse(header) - Date.now() : 0
                const wait = Math.max(250 * 2 ** attempt, Number.isFinite(retry) ? retry : 0)
                if (wait >= expires - performance.now()) throw new EvaluationError("deadline")
                await delay(wait, undefined, { signal })
                continue
              }
              const code = `http_${response.status}`
              throw new EvaluationError(FAILURE_CODES.has(code) ? code : "http_error")
            }
            const reader = response.body?.getReader()
            check(reader)
            const chunks: Uint8Array[] = []
            let bytes = 0
            try {
              for (;;) {
                const { value, done } = await reader.read()
                if (done) break
                bytes += value.byteLength
                check(bytes <= MAX_BYTES)
                chunks.push(value)
              }
            } finally { await reader.cancel() }
            return validateResult(JSON.parse(Buffer.concat(chunks).toString("utf8")), questions)
          }
        }, signal)
        signal.throwIfAborted()
        if (request.model !== "jev-latest" && batch.model !== request.model) throw new EvaluationError("model_mismatch")
        check(!result.model || result.model === batch.model)
        result.model = batch.model
        Object.assign(result.answers, batch.answers)
        result.usage.input_tokens += batch.usage.input_tokens
        result.usage.output_tokens += batch.usage.output_tokens
      }
      return result
    } catch (error) {
      if (this.o.signal.aborted) throw new AgentInterrupted()
      if (signal.aborted) throw new EvaluationError("deadline")
      throw error instanceof EvaluationError ? error : new EvaluationError("request_failed")
    } finally {
      clearTimeout(timer)
    }
  }
}
