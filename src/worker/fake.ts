// A deterministic in-process worker for smoke tests and `--provider fake`. Never calls a real
// provider: it echoes a canned answer derived from the prompt, and for schema'd calls synthesizes a
// value that satisfies the schema (enum/const/bounds/minItems honored).

import { createHash } from "node:crypto"
import { setTimeout as sleep } from "node:timers/promises"
import { emptyUsage, type AgentResult, type AgentSpec, type JSONSchema } from "../dsl/types.js"
import { validate } from "./schema.js"
import type { PreparedAgentCall, Worker, WorkerContext } from "./index.js"
import { AgentError, AgentInterrupted } from "./index.js"

export class FakeWorker implements Worker {
  readonly id = "codex" as const // satisfies ProviderId; selected only via the explicit registry
  private readonly delayMs: number
  constructor(opts: { delayMs?: number } = {}) {
    this.delayMs = opts.delayMs ?? 0
  }

  async prepareAgentCall(): Promise<PreparedAgentCall> {
    return (spec, ctx) => this.runAgent(spec, ctx)
  }

  async runAgent(spec: AgentSpec, ctx: WorkerContext): Promise<AgentResult> {
    if (ctx.signal.aborted) throw new AgentInterrupted()
    if (this.delayMs) {
      try {
        await sleep(this.delayMs, undefined, { signal: ctx.signal })
      } catch {
        throw new AgentInterrupted()
      }
    }
    ctx.onProgress({ kind: "reasoning", text: `(fake) considering: ${firstLine(spec.prompt)}` })

    if (spec.schema) {
      const structured = synthesize(spec.schema)
      const check = validate(spec.schema, structured)
      if (!check.ok) {
        throw new AgentError({
          provider: spec.provider,
          code: "fake_schema_unsatisfiable",
          message: `FakeWorker could not synthesize a value satisfying the schema: ${check.errors}`,
        })
      }
      const text = JSON.stringify(structured, null, 2)
      ctx.onProgress({ kind: "text", text })
      return {
        text,
        structured,
        status: "completed",
        usage: { ...emptyUsage(), inputTokens: spec.prompt.length, outputTokens: 16 },
      }
    }

    const id = createHash("sha256").update(spec.prompt).digest("hex").slice(0, 8)
    const text = `[fake:${spec.provider}] ${firstLine(spec.prompt)} (#${id})`
    ctx.onProgress({ kind: "text", text })
    return {
      text,
      status: "completed",
      usage: { ...emptyUsage(), inputTokens: spec.prompt.length, outputTokens: text.length },
    }
  }

  async shutdown(): Promise<void> {}
}

function firstLine(s: string): string {
  const line = s.split("\n").find((l) => l.trim().length > 0) ?? s
  return line.length > 80 ? line.slice(0, 79) + "…" : line
}

/** Synthesize a value that satisfies `schema` as far as the common keywords reach. */
export function synthesize(schema: JSONSchema): unknown {
  if (!schema || typeof schema !== "object") return "fake"

  // const pins the exact value.
  if ("const" in schema) return schema.const
  // enum: pick the first member.
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0]
  // composites: satisfy the first branch.
  for (const key of ["anyOf", "oneOf", "allOf"] as const) {
    const branch = schema[key]
    if (Array.isArray(branch) && branch.length > 0) return synthesize(branch[0] as JSONSchema)
  }

  const type = Array.isArray(schema.type) ? firstNonNullType(schema.type) : schema.type

  if (type === "string") return synthString(schema)
  if (type === "integer") return synthNumber(schema, true)
  if (type === "number") return synthNumber(schema, false)
  if (type === "boolean") return false
  if (type === "null") return null
  if (type === "array") return synthArray(schema)
  if (type === "object" || schema.properties) return synthObject(schema)

  // typeless / unknown: a string is the most broadly valid scalar.
  return "fake"
}

function firstNonNullType(types: unknown[]): unknown {
  return types.find((t) => t !== "null") ?? types[0]
}

function synthString(schema: JSONSchema): string {
  let s = "fake"
  const min = numOpt(schema.minLength)
  const max = numOpt(schema.maxLength)
  if (min !== undefined && s.length < min) s = s.padEnd(min, "x")
  if (max !== undefined && s.length > max) s = s.slice(0, max)
  return s
}

function synthNumber(schema: JSONSchema, integer: boolean): number {
  let n = 0
  const min = numOpt(schema.minimum) ?? numOpt(schema.exclusiveMinimum)
  const max = numOpt(schema.maximum) ?? numOpt(schema.exclusiveMaximum)
  if (min !== undefined && n < min) n = min
  if (max !== undefined && n > max) n = max
  // exclusive bounds: nudge inside the open interval.
  const exMin = numOpt(schema.exclusiveMinimum)
  if (exMin !== undefined && n <= exMin) n = integer ? exMin + 1 : exMin + 1e-6
  const exMax = numOpt(schema.exclusiveMaximum)
  if (exMax !== undefined && n >= exMax) n = integer ? exMax - 1 : exMax - 1e-6
  if (integer) n = Math.round(n)
  const mult = numOpt(schema.multipleOf)
  if (mult !== undefined && mult > 0) {
    // Round UP to the nearest multiple so we never drop below `minimum`/`exclusiveMinimum`.
    let k = Math.ceil(n / mult)
    n = k * mult
    // Respect an exclusive lower bound landed on exactly.
    if (exMin !== undefined && n <= exMin) n = ++k * mult
    if (integer) n = Math.round(n)
  }
  return n
}

function synthArray(schema: JSONSchema): unknown[] {
  const itemSchema = (Array.isArray(schema.items) ? schema.items[0] : schema.items) as JSONSchema | undefined
  const min = numOpt(schema.minItems) ?? 1
  const count = Math.max(min, 1)
  const out: unknown[] = []
  for (let i = 0; i < count; i++) out.push(synthesize(itemSchema ?? {}))
  return out
}

function synthObject(schema: JSONSchema): Record<string, unknown> {
  const props = (schema.properties as Record<string, JSONSchema> | undefined) ?? {}
  const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : [])
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(props)) {
    // Always populate required; populate optionals too (harmless and keeps the value rich).
    out[k] = synthesize(v)
  }
  // A required key with no declared property schema still needs a value.
  for (const k of required) {
    if (!(k in out)) out[k] = "fake"
  }
  return out
}

function numOpt(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined
}
