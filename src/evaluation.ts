import { createHash } from "node:crypto"
import { setTimeout as delay } from "node:timers/promises"
import { Semaphore } from "./runtime/semaphore.js"
import { AgentInterrupted } from "./worker/index.js"

export type Content = string | { [key: string]: unknown } | unknown[]
export type Question = { instructions: Content } & (
  | { type: "noul"; criteria?: { true?: string; false?: string } }
  | { type: "choice"; criteria: Record<string, string | null> }
  | { type: "score"; criteria: string[] }
)
export interface EvaluationRequest { state: Content; questions: Record<string, Question>; model?: string }
export interface EvaluationOptions { label?: string; key?: string }
export type Answer = { type: "noul"; noul: number }
  | { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: "score"; score: number; legend: Record<string, string>; probabilities: Record<string, number>; confidence: number }
export interface EvaluationResult { model: string; answers: Record<string, Answer>; usage: { input_tokens: number; output_tokens: number } }
export class EvaluationError extends Error {
  constructor(public readonly code: string) { super(`evaluation: ${code}`) }
}
const MAX_BYTES = 1_048_576
const object = (v: unknown): v is Record<string, any> => v !== null && typeof v === "object" && !Array.isArray(v)
const content = (v: unknown) => typeof v === "string" || object(v) || Array.isArray(v)
const unit = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1
function check(ok: unknown): asserts ok { if (!ok) throw new EvaluationError("invalid_data") }

/** Snapshot the complete JSON input before awaiting; never clip source to fit a request. */
export function snapshot(input: EvaluationRequest): EvaluationRequest & { model: string } {
  let text: string
  try { text = JSON.stringify(input) } catch { throw new EvaluationError("invalid_request") }
  check(typeof text === "string" && Buffer.byteLength(text) <= MAX_BYTES)
  const r = JSON.parse(text)
  check(object(r) && content(r.state) && object(r.questions) && Object.keys(r.questions).length > 0 && Object.keys(r.questions).length <= 1024)
  r.model ??= "jev-latest"
  check(typeof r.model === "string" && r.model.length > 0 && r.model.length <= 256)
  for (const q of Object.values(r.questions)) {
    check(object(q) && content(q.instructions))
    if (q.type === "noul") check(q.criteria === undefined || (object(q.criteria) && Object.entries(q.criteria).every(([k, v]) => ["true", "false"].includes(k) && typeof v === "string")))
    else if (q.type === "choice") check(object(q.criteria) && Object.keys(q.criteria).length > 0 && Object.keys(q.criteria).length <= 255 && Object.values(q.criteria).every(v => v === null || typeof v === "string"))
    else if (q.type === "score") check(Array.isArray(q.criteria) && q.criteria.length >= 2 && q.criteria.every((v: unknown) => typeof v === "string"))
    else check(false)
  }
  return r as EvaluationRequest & { model: string }
}

export function validateResult(raw: unknown, questions: Record<string, Question>): EvaluationResult {
  check(object(raw) && typeof raw.model === "string" && raw.model.length > 0 && object(raw.answers) && object(raw.usage))
  check(Object.keys(raw.answers).length === Object.keys(questions).length)
  for (const n of [raw.usage.input_tokens, raw.usage.output_tokens]) check(Number.isSafeInteger(n) && n >= 0)
  for (const [id, q] of Object.entries(questions)) {
    const a = raw.answers[id]
    check(object(a) && a.type === q.type)
    if (q.type === "noul") { check(unit(a.noul)); continue }
    const keys = q.type === "choice" ? Object.keys(q.criteria) : q.criteria.map((_, i) => String(i))
    check(object(a.probabilities) && Object.keys(a.probabilities).length === keys.length && keys.every(k => unit(a.probabilities[k])))
    check(Math.abs(keys.reduce((sum, k) => sum + a.probabilities[k], 0) - 1) < 0.001 && unit(a.confidence))
    if (q.type === "choice") check(keys.includes(a.choice) && keys.every(k => a.probabilities[a.choice] >= a.probabilities[k]))
    else {
      check(typeof a.score === "number" && Number.isFinite(a.score) && a.score >= 0 && a.score <= keys.length - 1)
      check(object(a.legend) && Object.keys(a.legend).length === keys.length && keys.every(k => a.legend[k] === q.criteria[Number(k)]))
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
  private readonly sem = new Semaphore(4)
  private readonly pending = new Map<string, Promise<EvaluationResult>>()
  constructor(private readonly o: {
    enabled: boolean; signal: AbortSignal;
    cached: Map<string, EvaluationResult>;
    save: (key: string, result: EvaluationResult) => void;
  }) {}

  evaluate = async (input: EvaluationRequest, opts?: EvaluationOptions): Promise<EvaluationResult> => {
    if (this.o.signal.aborted) throw new AgentInterrupted()
    if (!this.o.enabled) throw new EvaluationError("disabled")
    const request = snapshot(input)
    const key = createHash("sha256").update(JSON.stringify(["evaluation-v1", opts?.key ?? null, request])).digest("hex")
    const cached = this.o.cached.get(key)
    if (cached) {
      const restored = structuredClone(cached)
      for (const [id, q] of Object.entries(request.questions)) {
        const a = restored.answers[id]
        if (a?.type === "score" && q.type === "score") a.legend = Object.fromEntries(q.criteria.map((v, i) => [String(i), v]))
      }
      return validateResult(restored, request.questions)
    }
    let p = this.pending.get(key)
    if (!p) {
      p = this.execute(request).then(result => {
        const receipt = structuredClone(result)
        for (const a of Object.values(receipt.answers)) if (a.type === "score") a.legend = {}
        this.o.save(key, receipt)
        this.o.cached.set(key, result)
        return result
      })
      this.pending.set(key, p)
      const clear = () => this.pending.delete(key)
      p.then(clear, clear)
    }
    return structuredClone(await p)
  }

  private async execute(request: EvaluationRequest & { model: string }): Promise<EvaluationResult> {
    const signal = AbortSignal.any([this.o.signal, AbortSignal.timeout(30_000)])
    try {
      const token = process.env.TYPESAFE_API_KEY
      if (!token) throw new EvaluationError("missing_key")
      const entries = Object.entries(request.questions)
      const result: EvaluationResult = { model: "", answers: {}, usage: { input_tokens: 0, output_tokens: 0 } }
      for (let i = 0; i < entries.length; i += 32) {
        const questions = Object.fromEntries(entries.slice(i, i + 32))
        const batch = await this.sem.run(async () => {
          const body = JSON.stringify({ state: request.state, model: request.model, questions })
          check(Buffer.byteLength(body) <= MAX_BYTES)
          for (let attempt = 0; ; attempt++) {
            signal.throwIfAborted()
            const response = await fetch("https://api.typesafe.ai/v1/systemone", {
              method: "POST", redirect: "error", signal,
              headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body,
            })
            if (!response.ok) {
              await response.body?.cancel()
              if ((response.status === 429 || response.status === 529) && attempt < 2) {
                const retry = Number(response.headers.get("retry-after"))
                await delay(Math.max(250 * 2 ** attempt, Number.isFinite(retry) ? Math.min(30_000, retry * 1000) : 0), undefined, { signal })
                continue
              }
              throw new EvaluationError(`http_${response.status}`)
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
        })
        signal.throwIfAborted()
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
    }
  }
}
