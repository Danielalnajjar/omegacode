import type {
  EvaluationAnswer,
  EvaluationOptions,
  EvaluationQuestion,
  EvaluationRequest,
  EvaluationResult,
  EvaluationState,
  EvaluationUsage,
} from "../dsl/types.js"
import { Semaphore } from "../runtime/semaphore.js"

export interface EvaluationClient {
  evaluate(
    request: EvaluationRequest,
    signal?: AbortSignal,
  ): Promise<EvaluationResult>
}

export interface TypeSafeClientOptions {
  apiKey?: string
  fetchFn?: typeof fetch
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  fake?: boolean
}

export class EvaluationError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly retryable = false,
    public readonly status?: number,
  ) {
    super(message)
    this.name = "EvaluationError"
  }
}

const DEFAULT_BASE_URL = "https://api.typesafe.ai/v1/systemone"
const RETRYABLE_STATUS = new Set([429, 529])

export class TypeSafeEvaluationClient implements EvaluationClient {
  private readonly apiKey?: string
  private readonly fetchFn: typeof fetch
  private readonly sleepFn: (ms: number, signal?: AbortSignal) => Promise<void>
  private readonly sem = new Semaphore(8)
  private readonly fake: boolean

  constructor(opts: TypeSafeClientOptions = {}) {
    this.apiKey = opts.apiKey ?? process.env.TYPESAFE_API_KEY
    this.fetchFn = opts.fetchFn ?? fetch
    this.sleepFn = opts.sleep ?? abortableSleep
    this.fake = opts.fake === true
  }

  async evaluate(
    request: EvaluationRequest,
    signal?: AbortSignal,
  ): Promise<EvaluationResult> {
    const admitted = admitEvaluation(request)
    if (this.fake) return fakeResult(admitted)
    if (!this.apiKey) {
      throw new EvaluationError("TYPESAFE_API_KEY is required for evaluate()", "missing_api_key")
    }
    return this.sem.run(() => this.send(admitted, signal))
  }

  private async send(request: EvaluationRequest, signal?: AbortSignal): Promise<EvaluationResult> {
    const { state, questions } = request
    const model = request.model ?? "jev-latest"
    const timeoutMs = 10_000
    const maxRetries = 2
    let lastError: EvaluationError | undefined

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (signal?.aborted) throw new EvaluationError("TypeSafe evaluation aborted", "aborted")
      let retryAfter = 0
      const controller = new AbortController()
      const onAbort = () => controller.abort(signal?.reason)
      if (signal?.aborted) controller.abort(signal.reason)
      else signal?.addEventListener("abort", onAbort, { once: true })
      const timeout = setTimeout(() => controller.abort(new Error(`TypeSafe evaluation exceeded ${timeoutMs}ms`)), timeoutMs)
      timeout.unref?.()
      try {
        const response = await this.fetchFn(DEFAULT_BASE_URL, {
          method: "POST",
          redirect: "error",
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ state, model, questions }),
          signal: controller.signal,
        })
        if (!response.ok) {
          const raw = response.headers.get("retry-after")
          retryAfter = raw === null ? 0 : /^\d+(\.\d+)?$/.test(raw) ? Number(raw) * 1000 : Math.max(0, Date.parse(raw) - Date.now())
          await response.body?.cancel()
          throw new EvaluationError(`TypeSafe returned HTTP ${response.status}`, `http_${response.status}`, RETRYABLE_STATUS.has(response.status), response.status)
        }
        const bodyText = await response.text()
        let body: unknown
        try {
          body = bodyText ? JSON.parse(bodyText) : null
        } catch {
          throw new EvaluationError("TypeSafe returned non-JSON output", "invalid_response", false, response.status)
        }
        return validateEvaluationResponse(body, questions, model)
      } catch (error) {
        if (signal?.aborted) throw new EvaluationError("TypeSafe evaluation aborted", "aborted")
        if (error instanceof EvaluationError) lastError = error
        else if (controller.signal.aborted) lastError = new EvaluationError(`TypeSafe evaluation exceeded ${timeoutMs}ms`, "timeout", true)
        else lastError = new EvaluationError("TypeSafe evaluation transport failed", "transport", true)
      } finally {
        clearTimeout(timeout)
        signal?.removeEventListener("abort", onAbort)
      }
      if (!lastError.retryable || attempt === maxRetries) throw lastError
      await this.sleepFn(Math.min(60_000, Math.max(Number.isFinite(retryAfter) ? retryAfter : 0, 250 * 2 ** attempt)), signal)
    }
    throw lastError ?? new EvaluationError("TypeSafe evaluation failed", "unknown")
  }
}

export function validateEvaluationInput(
  state: EvaluationState,
  questions: Record<string, EvaluationQuestion>,
  opts: EvaluationOptions = {},
): void {
  assertJsonValue(state, "state")
  if (!questions || typeof questions !== "object" || Array.isArray(questions)) {
    throw new EvaluationError("evaluate() questions must be a non-empty object", "invalid_input")
  }
  const entries = Object.entries(questions)
  if (entries.length === 0) throw new EvaluationError("evaluate() questions must not be empty", "invalid_input")
  for (const [id, question] of entries) {
    if (!id.trim()) throw new EvaluationError("evaluate() question ids must be non-empty", "invalid_input")
    if (!question || typeof question !== "object" || Array.isArray(question)) {
      throw new EvaluationError(`evaluate() question ${id} must be an object`, "invalid_input")
    }
    if (!['noul', 'choice', 'score'].includes(question.type)) {
      throw new EvaluationError(`evaluate() question ${id} has invalid type`, "invalid_input")
    }
    assertJsonValue(question.instructions, `questions.${id}.instructions`)
    if (typeof question.instructions === "string" && !question.instructions.trim()) {
      throw new EvaluationError(`evaluate() question ${id} instructions must not be empty`, "invalid_input")
    }
    if (question.type === "noul") {
      if (question.criteria !== undefined) {
        const c = question.criteria
        if (!c || typeof c !== "object" || Array.isArray(c) || Object.keys(c).some((key) => !['true', 'false'].includes(key))) {
          throw new EvaluationError(`evaluate() noul question ${id} criteria must contain only true/false`, "invalid_input")
        }
      }
    } else if (question.type === "choice") {
      if (!question.criteria || typeof question.criteria !== "object" || Array.isArray(question.criteria)) {
        throw new EvaluationError(`evaluate() choice question ${id} criteria must be an object`, "invalid_input")
      }
      const choices = Object.entries(question.criteria)
      if (choices.length < 2 || choices.length > 255) {
        throw new EvaluationError(`evaluate() choice question ${id} must have 2..255 options`, "invalid_input")
      }
      for (const [choice, description] of choices) {
        if (!choice.trim() || (description !== null && typeof description !== "string")) {
          throw new EvaluationError(`evaluate() choice question ${id} has invalid criteria`, "invalid_input")
        }
      }
    } else {
      if (!Array.isArray(question.criteria) || question.criteria.length < 2 || question.criteria.some((item) => typeof item !== "string" || !item.trim())) {
        throw new EvaluationError(`evaluate() score question ${id} criteria must contain at least two non-empty levels`, "invalid_input")
      }
    }
  }
  if (opts.key !== undefined && (typeof opts.key !== "string" || !opts.key.trim())) {
    throw new EvaluationError("evaluate() key must be a non-empty string", "invalid_input")
  }
  if (opts.label !== undefined && (typeof opts.label !== "string" || !opts.label.trim())) {
    throw new EvaluationError("evaluate() label must be a non-empty string", "invalid_input")
  }
}

export function validateEvaluationResponse(
  body: unknown,
  questions: Record<string, EvaluationQuestion>,
  requestedModel: string,
): EvaluationResult {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw invalidResponse("response must be an object")
  const value = body as Record<string, unknown>
  if (typeof value.model !== "string" || !value.model) throw invalidResponse("response.model is invalid")
  if (value.model !== requestedModel && requestedModel !== "jev-latest") throw invalidResponse("response.model does not match requested model")
  if (!value.answers || typeof value.answers !== "object" || Array.isArray(value.answers)) throw invalidResponse("response.answers is invalid")
  const answers = value.answers as Record<string, unknown>
  const expectedIds = Object.keys(questions).sort()
  const actualIds = Object.keys(answers).sort()
  if (JSON.stringify(actualIds) !== JSON.stringify(expectedIds)) throw invalidResponse("response answers do not exactly match question ids")
  const validatedAnswers: Record<string, EvaluationAnswer> = {}
  for (const id of expectedIds) Object.defineProperty(validatedAnswers, id, { value: validateAnswer(id, answers[id], questions[id]!), enumerable: true })
  if (!value.usage || typeof value.usage !== "object" || Array.isArray(value.usage)) throw invalidResponse("response.usage is invalid")
  const usage = value.usage as Record<string, unknown>
  if (!Number.isInteger(usage.input_tokens) || Number(usage.input_tokens) < 0 || !Number.isInteger(usage.output_tokens) || Number(usage.output_tokens) < 0) {
    throw invalidResponse("response.usage token counts are invalid")
  }
  return { model: value.model, answers: validatedAnswers, usage: { input_tokens: Number(usage.input_tokens), output_tokens: Number(usage.output_tokens) } }
}

function validateAnswer(id: string, raw: unknown, question: EvaluationQuestion): EvaluationAnswer {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw invalidResponse(`answer ${id} must be an object`)
  const answer = raw as Record<string, unknown>
  if (answer.type !== question.type) throw invalidResponse(`answer ${id} type mismatch`)
  if (question.type === "noul") {
    assertProbability(answer.noul, `answer ${id}.noul`)
    return { type: "noul", noul: Number(answer.noul) }
  }
  if (question.type === "choice") {
    if (typeof answer.choice !== "string" || !(answer.choice in question.criteria)) throw invalidResponse(`answer ${id}.choice is invalid`)
    const probabilities = validateProbabilities(answer.probabilities, Object.keys(question.criteria), id)
    assertProbability(answer.confidence, `answer ${id}.confidence`)
    return { type: "choice", choice: answer.choice, probabilities, confidence: Number(answer.confidence) }
  }
  if (typeof answer.score !== "number" || !Number.isFinite(answer.score) || answer.score < 0 || answer.score > question.criteria.length - 1) {
    throw invalidResponse(`answer ${id}.score is invalid`)
  }
  const levelKeys = question.criteria.map((_, index) => String(index))
  const probabilities = validateProbabilities(answer.probabilities, levelKeys, id)
  if (!answer.legend || typeof answer.legend !== "object" || Array.isArray(answer.legend)) throw invalidResponse(`answer ${id}.legend is invalid`)
  const legend = answer.legend as Record<string, unknown>
  if (JSON.stringify(Object.keys(legend).sort()) !== JSON.stringify([...levelKeys].sort())) throw invalidResponse(`answer ${id}.legend keys are invalid`)
  const normalizedLegend: Record<string, string> = {}
  for (const key of levelKeys) {
    if (legend[key] !== question.criteria[Number(key)]) throw invalidResponse(`answer ${id}.legend does not match criteria`)
    normalizedLegend[key] = String(legend[key])
  }
  assertProbability(answer.confidence, `answer ${id}.confidence`)
  return { type: "score", score: answer.score, legend: normalizedLegend, probabilities, confidence: Number(answer.confidence) }
}

function validateProbabilities(raw: unknown, keys: string[], id: string): Record<string, number> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw invalidResponse(`answer ${id}.probabilities is invalid`)
  const value = raw as Record<string, unknown>
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) throw invalidResponse(`answer ${id}.probability keys are invalid`)
  const out: Record<string, number> = {}
  let sum = 0
  for (const key of keys) {
    assertProbability(value[key], `answer ${id}.probabilities.${key}`)
    out[key] = Number(value[key])
    sum += out[key]
  }
  if (Math.abs(sum - 1) > 0.02) throw invalidResponse(`answer ${id}.probabilities must sum to 1`)
  return out
}

function assertProbability(value: unknown, field: string): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) throw invalidResponse(`${field} must be between 0 and 1`)
}

function invalidResponse(message: string): EvaluationError {
  return new EvaluationError(`Invalid TypeSafe response: ${message}`, "invalid_response")
}

function assertJsonValue(value: unknown, path: string, seen = new Set<object>()): void {
  if (value === null) return
  if (["string", "boolean"].includes(typeof value)) return
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new EvaluationError(`${path} contains a non-finite number`, "invalid_input")
    return
  }
  if (typeof value !== "object") throw new EvaluationError(`${path} must be JSON-serializable`, "invalid_input")
  const object = value as object
  const proto = Object.getPrototypeOf(object)
  if (!Array.isArray(value) && proto !== null && Object.getPrototypeOf(proto) !== null) {
    throw new EvaluationError(`${path} must be plain JSON`, "invalid_input")
  }
  if (seen.has(object)) throw new EvaluationError(`${path} contains a circular value`, "invalid_input")
  seen.add(object)
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) assertJsonValue(value[i], `${path}[${i}]`, seen)
  }
  else for (const [key, item] of Object.entries(value as Record<string, unknown>)) assertJsonValue(item, `${path}.${key}`, seen)
  seen.delete(object)
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new EvaluationError("TypeSafe evaluation aborted", "aborted"))
    const cleanup = () => signal?.removeEventListener("abort", onAbort)
    const timer = setTimeout(() => { cleanup(); resolve() }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      cleanup()
      reject(new EvaluationError("TypeSafe evaluation aborted", "aborted"))
    }
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

/** Snapshot before hashing or queueing; never truncate a request to fit the shared budget. */
export function admitEvaluation(input: EvaluationRequest, opts: EvaluationOptions = {}): EvaluationRequest {
  assertJsonValue(input, "request")
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new EvaluationError("evaluate() requires {state,questions,model?}", "invalid_input")
  if (input.model !== undefined && input.model !== "jev-latest") throw new EvaluationError("evaluate() model must be jev-latest", "invalid_input")
  if (typeof input.state !== "string" && (typeof input.state !== "object" || input.state === null)) throw new EvaluationError("state must be string, object or array", "invalid_input")
  validateEvaluationInput(input.state, input.questions, opts)
  const request = JSON.parse(JSON.stringify({ state: input.state, questions: input.questions, model: input.model ?? "jev-latest" })) as EvaluationRequest
  if (JSON.stringify(request).length > 128_000) throw new EvaluationError("evaluate() exceeds conservative 32000-token shared budget; split the request", "request_too_large")
  return request
}

export function freezeEvaluation<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value)
    for (const child of Object.values(value)) freezeEvaluation(child)
  }
  return value
}

function fakeResult(request: EvaluationRequest): EvaluationResult {
  const answers = Object.fromEntries(Object.entries(request.questions).map(([id, q]) => {
    if (q.type === "noul") return [id, { type: "noul", noul: 0.5 }]
    const keys = q.type === "choice" ? Object.keys(q.criteria) : q.criteria.map((_, i) => String(i))
    const probabilities = Object.fromEntries(keys.map(k => [k, 1 / keys.length]))
    return [id, q.type === "choice" ? { type: "choice", choice: keys[0], probabilities, confidence: 0 } : { type: "score", score: (keys.length - 1) / 2, legend: Object.fromEntries(keys.map((k, i) => [k, q.criteria[i]])), probabilities, confidence: 0 }]
  })) as Record<string, EvaluationAnswer>
  return { model: "jev-latest", answers, usage: { input_tokens: 0, output_tokens: 0 } }
}
