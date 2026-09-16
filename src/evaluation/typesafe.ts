import type { EvaluationAnswer, EvaluationOptions, EvaluationQuestion, EvaluationRequest, EvaluationResult, EvaluationState, EvaluationUsage } from "../dsl/types.js"

export interface EvaluationAttempt {
  phase: "started" | "finished"
  batch: number
  attempt: number
  requestBytes: number
  usage?: EvaluationUsage
  errorCode?: string
}

export interface EvaluationClient {
  evaluate(request: EvaluationRequest, signal?: AbortSignal, onAttempt?: (attempt: EvaluationAttempt) => void): Promise<EvaluationResult>
}

export interface TypeSafeClientOptions {
  apiKey?: string
  fetchFn?: typeof fetch
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  fake?: boolean
  /** Host/testing seam. The production default is one 10 second end-to-end deadline. */
  deadlineMs?: number
}

export class EvaluationError extends Error {
  constructor(message: string, public readonly code: string, public readonly retryable = false, public readonly status?: number) {
    super(message); this.name = "EvaluationError"
  }
}

const URL = "https://api.typesafe.ai/v1/systemone"
const WIRE_LIMIT = 32_000
const TOTAL_LIMIT = 2 * 1024 * 1024
const BODY_LIMIT = 1024 * 1024
const MAX_QUESTIONS = 4096
const MAX_BATCHES = 32
const encoder = new TextEncoder()

class CancellableGate {
  private active = 0
  private queue: Array<{ resolve: (release: () => void) => void; reject: (e: unknown) => void; signal?: AbortSignal; abort?: () => void }> = []
  constructor(private readonly limit: number) {}
  acquire(signal: AbortSignal, deadline: number): Promise<() => void> {
    if (signal.aborted) return Promise.reject(aborted())
    if (Date.now() >= deadline) return Promise.reject(timeout())
    if (this.active < this.limit) { this.active++; return Promise.resolve(this.release()) }
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, signal } as (typeof this.queue)[number]
      const abort = () => { clearTimeout(timer); const i = this.queue.indexOf(waiter); if (i >= 0) this.queue.splice(i, 1); reject(Date.now() >= deadline ? timeout() : aborted()) }
      waiter.abort = abort; signal.addEventListener("abort", abort, { once: true }); this.queue.push(waiter)
      const ms = deadline - Date.now()
      const timer = setTimeout(() => { const i = this.queue.indexOf(waiter); if (i >= 0) { this.queue.splice(i, 1); signal.removeEventListener("abort", abort); reject(timeout()) } }, ms)
      const original = waiter.resolve
      waiter.resolve = release => { clearTimeout(timer); signal.removeEventListener("abort", abort); original(release) }
    })
  }
  private release(): () => void {
    let done = false
    return () => { if (done) return; done = true; const next = this.queue.shift(); if (next) next.resolve(this.release()); else this.active-- }
  }
}

export class TypeSafeEvaluationClient implements EvaluationClient {
  private readonly apiKey?: string
  private readonly fetchFn: typeof fetch
  private readonly sleepFn: (ms: number, signal?: AbortSignal) => Promise<void>
  private readonly fake: boolean
  private readonly deadlineMs: number
  private readonly gate = new CancellableGate(8)
  constructor(opts: TypeSafeClientOptions = {}) {
    this.apiKey = opts.apiKey ?? process.env.TYPESAFE_API_KEY; this.fetchFn = opts.fetchFn ?? fetch
    this.sleepFn = opts.sleep ?? abortableSleep; this.fake = opts.fake === true; this.deadlineMs = opts.deadlineMs ?? 10_000
    if (!Number.isFinite(this.deadlineMs) || this.deadlineMs <= 0) throw new RangeError("evaluation deadlineMs must be positive and finite")
  }
  async evaluate(input: EvaluationRequest, signal?: AbortSignal, onAttempt?: (attempt: EvaluationAttempt) => void): Promise<EvaluationResult> {
    const deadline = Date.now() + this.deadlineMs
    const request = admitEvaluation(input)
    const batches = partition(request)
    if (this.fake) { if (signal?.aborted) throw aborted(); return fakeResult(request) }
    if (!this.apiKey) throw new EvaluationError("TYPESAFE_API_KEY is required for evaluate()", "missing_api_key")
    const combined = linkedSignal(signal, deadline)
    let release: (() => void) | undefined
    try {
      release = await this.gate.acquire(combined.signal, deadline)
      const results: EvaluationResult[] = []
      for (let i = 0; i < batches.length; i++) results.push(await this.send(batches[i]!, i + 1, deadline, combined.signal, onAttempt))
      const model = results[0]!.model
      if (results.some(r => r.model !== model)) throw invalidResponse("partition models do not match")
      const answers: Record<string, EvaluationAnswer> = Object.create(null)
      let input_tokens = 0, output_tokens = 0
      for (const result of results) { for (const [id, answer] of Object.entries(result.answers)) define(answers, id, answer); input_tokens += result.usage.input_tokens; output_tokens += result.usage.output_tokens }
      ensureTime(deadline, combined.signal)
      return { model, answers, usage: { input_tokens, output_tokens } }
    } finally { release?.(); combined.cleanup() }
  }
  private async send(request: EvaluationRequest, batch: number, deadline: number, signal: AbortSignal, callback?: (a: EvaluationAttempt) => void): Promise<EvaluationResult> {
    const body = JSON.stringify(request), requestBytes = bytes(body)
    let last: EvaluationError = new EvaluationError("TypeSafe evaluation failed", "transport", true)
    for (let attempt = 1; attempt <= 3; attempt++) {
      ensureTime(deadline, signal)
      try { callback?.({ phase: "started", batch, attempt, requestBytes }) } catch { throw new EvaluationError("Evaluation attempt callback failed", "callback_error") }
      let usage: EvaluationUsage | undefined, error: EvaluationError | undefined, retryAfter = 0
      try {
        const response = await raceDeadline(this.fetchFn(URL, { method: "POST", redirect: "error", headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" }, body, signal }), signal, deadline)
        if (!response.ok) {
          retryAfter = parseRetryAfter(response.headers.get("retry-after"))
          void response.body?.cancel().catch(() => undefined)
          throw new EvaluationError(`TypeSafe returned HTTP ${response.status}`, `http_${response.status}`, response.status === 429 || response.status === 529, response.status)
        }
        const text = await readBounded(response, signal, deadline)
        let raw: unknown
        try { raw = text ? JSON.parse(text) : null } catch { throw invalidResponse("response is not JSON") }
        usage = rawUsage(raw)
        const result = validateEvaluationResponse(raw, request.questions, request.model!)
        try { callback?.({ phase: "finished", batch, attempt, requestBytes, usage }) }
        catch { throw new EvaluationError("Evaluation attempt callback failed", "callback_error") }
        return result
      } catch (caught) {
        error = normalizeError(caught, signal)
        if (error.code === "callback_error") throw error
        last = error
        try { callback?.({ phase: "finished", batch, attempt, requestBytes, ...(usage ? { usage } : {}), errorCode: error.code }) }
        catch { throw new EvaluationError("Evaluation attempt callback failed", "callback_error") }
      }
      if (!error.retryable || attempt === 3) throw error
      const delay = Math.max(retryAfter, 250 * 2 ** (attempt - 1))
      if (delay >= deadline - Date.now()) throw timeout()
      await raceDeadline(this.sleepFn(delay, signal), signal, deadline)
    }
    throw last
  }
}

export function validateEvaluationInput(state: EvaluationState, questions: Record<string, EvaluationQuestion>, opts: EvaluationOptions = {}): void {
  if (!isRecord(questions) || Object.keys(questions).length === 0) throw new EvaluationError("evaluate() questions must not be empty", "invalid_input")
  assertState(state, "state", true)
  const entries = Object.entries(questions)
  if (entries.length > MAX_QUESTIONS) throw new EvaluationError("evaluate() has too many questions", "invalid_input")
  for (const [id, q] of entries) {
    if (!boundedIdentifier(id) || !isRecord(q) || !exactKeys(q as unknown as Record<string, unknown>, ["type", "instructions", "criteria"])) throw new EvaluationError("evaluate() contains an invalid question", "invalid_input")
    if (q.type !== "noul" && q.type !== "choice" && q.type !== "score") throw new EvaluationError("evaluate() question type is invalid", "invalid_input")
    assertState(q.instructions, "instructions", true)
    if (typeof q.instructions === "string" && !q.instructions.trim()) throw new EvaluationError("evaluate() instructions must not be empty", "invalid_input")
    if (q.type === "noul") {
      if (q.criteria !== undefined && (!isRecord(q.criteria) || !exactKeys(q.criteria, ["true", "false"]) || Object.values(q.criteria).some(v => typeof v !== "string"))) throw new EvaluationError("evaluate() noul criteria is invalid", "invalid_input")
    } else if (q.type === "choice") {
      if (!isRecord(q.criteria)) throw new EvaluationError("evaluate() choice criteria is invalid", "invalid_input")
      const choices = Object.entries(q.criteria)
      if (choices.length < 2 || choices.length > 255 || choices.some(([k, v]) => !boundedIdentifier(k) || (v !== null && typeof v !== "string"))) throw new EvaluationError("evaluate() choice must have 2..255 valid options", "invalid_input")
    } else if (!Array.isArray(q.criteria) || q.criteria.length < 2 || q.criteria.some(v => typeof v !== "string" || !v.trim())) throw new EvaluationError("evaluate() score criteria must contain at least two non-empty levels", "invalid_input")
  }
  if (!isRecord(opts) || !exactKeys(opts as Record<string, unknown>, ["key", "label"])) throw new EvaluationError("evaluate() options contain unknown fields", "invalid_input")
  for (const value of [opts.key, opts.label]) if (value !== undefined && !boundedIdentifier(value)) throw new EvaluationError("evaluate() option must be a bounded non-empty string", "invalid_input")
}

export function validateEvaluationResponse(body: unknown, questions: Record<string, EvaluationQuestion>, requestedModel: string): EvaluationResult {
  if (!isRecord(body) || !exactKeys(body, ["model", "answers", "usage"]) || typeof body.model !== "string" || !body.model) throw invalidResponse("response envelope is invalid")
  if (requestedModel !== "jev-latest" && body.model !== requestedModel) throw invalidResponse("response model does not match")
  if (!isRecord(body.answers) || !sameKeys(body.answers, questions)) throw invalidResponse("response answers do not exactly match question ids")
  const answers: Record<string, EvaluationAnswer> = Object.create(null)
  for (const id of Object.keys(questions)) define(answers, id, validateAnswer(body.answers[id], questions[id]!))
  const usage = rawUsage(body); if (!usage) throw invalidResponse("response usage is invalid")
  return { model: body.model, answers, usage }
}

function validateAnswer(raw: unknown, q: EvaluationQuestion): EvaluationAnswer {
  if (!isRecord(raw) || raw.type !== q.type) throw invalidResponse("answer is invalid")
  if (q.type === "noul") { if (!exactKeys(raw, ["type", "noul"])) throw invalidResponse("answer fields are invalid"); probability(raw.noul); return { type: "noul", noul: Number(raw.noul) } }
  if (q.type === "choice") {
    if (!exactKeys(raw, ["type", "choice", "probabilities", "confidence"]) || typeof raw.choice !== "string" || !own(q.criteria, raw.choice)) throw invalidResponse("choice answer is invalid")
    return { type: "choice", choice: raw.choice, probabilities: probabilities(raw.probabilities, Object.keys(q.criteria)), confidence: checkedProbability(raw.confidence) }
  }
  if (!exactKeys(raw, ["type", "score", "legend", "probabilities", "confidence"]) || typeof raw.score !== "number" || !Number.isFinite(raw.score) || raw.score < 0 || raw.score > q.criteria.length - 1) throw invalidResponse("score answer is invalid")
  const keys = q.criteria.map((_, i) => String(i)); if (!isRecord(raw.legend) || !sameKeyList(raw.legend, keys) || keys.some(k => raw.legend[k] !== q.criteria[Number(k)])) throw invalidResponse("score legend is invalid")
  const legend: Record<string, string> = Object.create(null); keys.forEach(k => define(legend, k, q.criteria[Number(k)]!))
  return { type: "score", score: raw.score, legend, probabilities: probabilities(raw.probabilities, keys), confidence: checkedProbability(raw.confidence) }
}

function probabilities(raw: unknown, keys: string[]): Record<string, number> {
  if (!isRecord(raw) || !sameKeyList(raw, keys)) throw invalidResponse("probability keys are invalid")
  const out: Record<string, number> = Object.create(null); let sum = 0
  for (const key of keys) { const n = checkedProbability(raw[key]); define(out, key, n); sum += n }
  if (Math.abs(sum - 1) > 0.0200000001) throw invalidResponse("probabilities must sum to 1")
  return out
}
function probability(v: unknown): void { checkedProbability(v) }
function checkedProbability(v: unknown): number { if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1) throw invalidResponse("probability is invalid"); return v }

export function admitEvaluation(input: EvaluationRequest, opts: EvaluationOptions = {}): EvaluationRequest {
  input = snapshotJson(input) as EvaluationRequest
  opts = snapshotJson(opts) as EvaluationOptions
  if (!isRecord(input) || !exactKeys(input as unknown as Record<string, unknown>, ["state", "questions", "model"])) throw new EvaluationError("evaluate() request fields are invalid", "invalid_input")
  const model = input.model === undefined ? "jev-latest" : input.model
  if (!boundedIdentifier(model)) throw new EvaluationError("evaluate() model is invalid", "invalid_input")
  validateEvaluationInput(input.state, input.questions, opts)
  const serialized = safeStringify({ state: input.state, questions: input.questions, model })
  if (bytes(serialized) > TOTAL_LIMIT) throw new EvaluationError("evaluate() exceeds the 2MiB request limit", "request_too_large")
  return JSON.parse(serialized) as EvaluationRequest
}

function partition(request: EvaluationRequest): EvaluationRequest[] {
  const batches: EvaluationRequest[] = []; let current: Record<string, EvaluationQuestion> = Object.create(null)
  const make = (q: Record<string, EvaluationQuestion>) => ({ state: request.state, model: request.model, questions: q })
  if (bytes(JSON.stringify(make(current))) > WIRE_LIMIT) throw new EvaluationError("evaluate() state exceeds the wire byte budget", "request_too_large")
  for (const [id, question] of Object.entries(request.questions)) {
    define(current, id, question)
    if (bytes(JSON.stringify(make(current))) > WIRE_LIMIT) {
      delete current[id]
      if (!Object.keys(current).length) throw new EvaluationError("evaluate() question cannot fit the wire limit", "request_too_large")
      batches.push(make(current)); current = Object.create(null); define(current, id, question)
      if (bytes(JSON.stringify(make(current))) > WIRE_LIMIT) throw new EvaluationError("evaluate() question cannot fit the wire limit", "request_too_large")
    }
  }
  if (Object.keys(current).length) batches.push(make(current))
  if (batches.length > MAX_BATCHES) throw new EvaluationError("evaluate() requires too many partitions", "request_too_large")
  return batches
}

export function freezeEvaluation<T>(value: T): T { if (value && typeof value === "object") { Object.freeze(value); for (const child of Object.values(value)) freezeEvaluation(child) } return value }
function fakeResult(request: EvaluationRequest): EvaluationResult {
  const answers: Record<string, EvaluationAnswer> = Object.create(null)
  for (const [id, q] of Object.entries(request.questions)) {
    if (q.type === "noul") define(answers, id, { type: "noul", noul: 0.5 })
    else { const keys = q.type === "choice" ? Object.keys(q.criteria) : q.criteria.map((_, i) => String(i)); const p = Object.fromEntries(keys.map(k => [k, 1 / keys.length])); define(answers, id, q.type === "choice" ? { type: "choice", choice: keys[0]!, probabilities: p, confidence: 0 } : { type: "score", score: (keys.length - 1) / 2, legend: Object.fromEntries(keys.map((k, i) => [k, q.criteria[i]!])), probabilities: p, confidence: 0 }) }
  }
  return { model: request.model!, answers, usage: { input_tokens: 0, output_tokens: 0 } }
}

async function readBounded(response: Response, signal: AbortSignal, deadline: number): Promise<string> {
  if (!response.body) return ""
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0
  try { while (true) { const part = await raceDeadline(reader.read(), signal, deadline); if (part.done) break; size += part.value.byteLength; if (size > BODY_LIMIT) throw new EvaluationError("TypeSafe response body is too large", "response_too_large"); chunks.push(part.value) } }
  finally { void reader.cancel().catch(() => undefined); reader.releaseLock() }
  const all = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.length } return new TextDecoder().decode(all)
}
function linkedSignal(parent: AbortSignal | undefined, deadline: number) { const c = new AbortController(); const abort = () => c.abort(); if (parent?.aborted) abort(); else parent?.addEventListener("abort", abort, { once: true }); const timer = setTimeout(() => c.abort(), Math.max(0, deadline - Date.now())); return { signal: c.signal, cleanup: () => { clearTimeout(timer); parent?.removeEventListener("abort", abort) } } }
function raceDeadline<T>(promise: Promise<T>, signal: AbortSignal, deadline: number): Promise<T> { return new Promise((resolve, reject) => { if (signal.aborted) return reject(Date.now() >= deadline ? timeout() : aborted()); const timer = setTimeout(() => finish(() => reject(timeout())), Math.max(0, deadline - Date.now())); const onAbort = () => finish(() => reject(Date.now() >= deadline ? timeout() : aborted())); const finish = (fn: () => void) => { clearTimeout(timer); signal.removeEventListener("abort", onAbort); fn() }; signal.addEventListener("abort", onAbort, { once: true }); promise.then(v => finish(() => resolve(v)), e => finish(() => reject(e))) }) }
function ensureTime(deadline: number, signal: AbortSignal) { if (signal.aborted) throw Date.now() >= deadline ? timeout() : aborted(); if (Date.now() >= deadline) throw timeout() }
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> { return new Promise((resolve, reject) => { if (signal?.aborted) return reject(aborted()); const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve() }, ms); const onAbort = () => { clearTimeout(timer); reject(aborted()) }; signal?.addEventListener("abort", onAbort, { once: true }) }) }
function parseRetryAfter(raw: string | null): number { if (!raw) return 0; if (/^\d+(?:\.\d+)?$/.test(raw.trim())) return Number(raw) * 1000; const date = Date.parse(raw); return Number.isFinite(date) ? Math.max(0, date - Date.now()) : 0 }
function rawUsage(raw: unknown): EvaluationUsage | undefined { if (!isRecord(raw) || !isRecord(raw.usage)) return; const i = raw.usage.input_tokens, o = raw.usage.output_tokens; return Number.isInteger(i) && Number(i) >= 0 && Number.isInteger(o) && Number(o) >= 0 ? { input_tokens: Number(i), output_tokens: Number(o) } : undefined }
function normalizeError(e: unknown, signal: AbortSignal): EvaluationError { if (e instanceof EvaluationError) return e; return signal.aborted ? aborted() : new EvaluationError("TypeSafe evaluation transport failed", "transport", true) }
function invalidResponse(message: string) { return new EvaluationError(`Invalid TypeSafe response: ${message}`, "invalid_response") }
function timeout() { return new EvaluationError("TypeSafe evaluation deadline exceeded", "timeout") }
function aborted() { return new EvaluationError("TypeSafe evaluation aborted", "aborted") }
function bytes(s: string) { return encoder.encode(s).byteLength }
function boundedIdentifier(v: unknown): v is string { return typeof v === "string" && v.trim().length > 0 && bytes(v) <= 256 }
function isRecord(v: unknown): v is Record<string, any> { if (!v || typeof v !== "object" || Array.isArray(v)) return false; const p = Object.getPrototypeOf(v); return p === null || Object.getPrototypeOf(p) === null }
function exactKeys(v: Record<string, unknown>, allowed: string[]) { return Reflect.ownKeys(v).every(k => typeof k === "string" && allowed.includes(k)) }
function sameKeys(a: Record<string, unknown>, b: Record<string, unknown>) { return sameKeyList(a, Object.keys(b)) }
function sameKeyList(a: Record<string, unknown>, keys: string[]) { const actual = Object.keys(a); return actual.length === keys.length && keys.every(k => own(a, k)) }
function own(v: object, key: PropertyKey) { return Object.prototype.hasOwnProperty.call(v, key) }
function define<T>(target: Record<string, T>, key: string, value: T) { Object.defineProperty(target, key, { value, enumerable: true, configurable: true, writable: true }) }
function assertState(v: unknown, path: string, top = false, seen = new Set<object>()): asserts v is EvaluationState { if (typeof v === "string" || (!top && (v === null || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v))))) return; if (!v || typeof v !== "object") throw new EvaluationError(`${path} must be a string, object, or array`, "invalid_input"); if (!Array.isArray(v) && !isRecord(v)) throw new EvaluationError(`${path} must be plain JSON`, "invalid_input"); if (seen.has(v)) throw new EvaluationError(`${path} contains a circular value`, "invalid_input"); seen.add(v); for (const child of Array.isArray(v) ? v : Object.values(v)) assertState(child, path, false, seen); seen.delete(v) }
function safeStringify(v: unknown) { try { return JSON.stringify(v) } catch { throw new EvaluationError("evaluate() request is not JSON-safe", "invalid_input") } }

/** Read descriptors rather than executing getters/toJSON supplied by a workflow. */
function snapshotJson(value: unknown, seen = new Set<object>(), depth = 0): unknown {
  if (depth > 100) throw new EvaluationError("evaluate() JSON nesting exceeds limit", "invalid_input")
  if (value === null || typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return value
  if (!value || typeof value !== "object" || (!Array.isArray(value) && !isRecord(value))) throw new EvaluationError("evaluate() requires plain JSON", "invalid_input")
  if (seen.has(value)) throw new EvaluationError("evaluate() JSON contains a cycle", "invalid_input")
  seen.add(value)
  try {
    const out: Record<string, unknown> | unknown[] = Array.isArray(value) ? [] : Object.create(null)
    const keys = Array.isArray(value) ? Array.from({ length: value.length }, (_, i) => String(i)) : Reflect.ownKeys(value)
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (typeof key !== "string" || !descriptor || !("value" in descriptor) || !descriptor.enumerable) throw new EvaluationError("evaluate() requires JSON data properties", "invalid_input")
      define(out as Record<string, unknown>, key, snapshotJson(descriptor.value, seen, depth + 1))
    }
    return out
  } finally { seen.delete(value) }
}
