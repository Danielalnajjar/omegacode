// JSON Schema → per-provider output-format shapes + client-side validation.
//   Codex:  turn/start.outputSchema = <json schema>
//   Claude: options.outputFormat = { type: "json_schema", schema: <json schema> }
// We always re-validate the returned value client-side regardless of provider enforcement.

import { Ajv, type ValidateFunction } from "ajv"
import type { JSONSchema } from "../dsl/types.js"

const ajv = new Ajv({ allErrors: true, strict: false })
const cache = new WeakMap<JSONSchema, ValidateFunction>()

function compile(schema: JSONSchema): ValidateFunction {
  const existing = cache.get(schema)
  if (existing) return existing
  const fn = ajv.compile(schema)
  cache.set(schema, fn)
  return fn
}

/**
 * Eagerly compile a schema so author errors (bad $ref, typo'd type) surface at spec resolution
 * instead of after a full paid turn. Throws the ajv compile error verbatim.
 */
export function assertValidSchema(schema: JSONSchema): void {
  compile(schema)
}

export interface ValidationResult {
  ok: boolean
  errors?: string
}

export function validate(schema: JSONSchema, value: unknown): ValidationResult {
  const fn = compile(schema)
  if (fn(value)) return { ok: true }
  const errors = (fn.errors ?? [])
    .map((e) => `${e.instancePath || "root"}: ${e.message ?? "invalid"}`)
    .join("; ")
  return { ok: false, errors }
}

/** OpenAI/Codex strict json_schema requires additionalProperties:false + all keys required. */
export function toCodexOutputSchema(schema: JSONSchema): JSONSchema {
  return strictify(schema) as JSONSchema
}

export function toClaudeOutputFormat(schema: JSONSchema): { type: "json_schema"; schema: JSONSchema } {
  return { type: "json_schema", schema }
}

/**
 * Recurse a schema node by JSON Schema *keyword*, not by blindly walking every object value. This
 * keeps `properties` (a map of names→schemas, where a key could literally be "properties") and
 * other keyword maps from being treated as schemas themselves. Returns a deep copy.
 */
function strictify(node: unknown): unknown {
  if (node === null || typeof node !== "object") return node
  if (Array.isArray(node)) return node.map(strictify)
  const obj = node as Record<string, unknown>
  const out: Record<string, unknown> = {}

  // Copy scalars/passthroughs verbatim; recurse only into known schema-bearing positions.
  for (const [k, v] of Object.entries(obj)) {
    if (k === "properties" && v && typeof v === "object" && !Array.isArray(v)) {
      const src = v as Record<string, unknown>
      const dst: Record<string, unknown> = {}
      for (const [name, sub] of Object.entries(src)) dst[name] = strictify(sub)
      out[k] = dst
    } else if (k === "items") {
      out[k] = Array.isArray(v) ? v.map(strictify) : strictify(v)
    } else if (k === "additionalProperties" || k === "patternProperties") {
      // patternProperties is a name→schema map; additionalProperties may be a schema or boolean.
      if (k === "patternProperties" && v && typeof v === "object" && !Array.isArray(v)) {
        const src = v as Record<string, unknown>
        const dst: Record<string, unknown> = {}
        for (const [name, sub] of Object.entries(src)) dst[name] = strictify(sub)
        out[k] = dst
      } else {
        out[k] = strictify(v)
      }
    } else if (k === "anyOf" || k === "oneOf" || k === "allOf") {
      out[k] = Array.isArray(v) ? v.map(strictify) : strictify(v)
    } else if (k === "$defs" || k === "definitions") {
      if (v && typeof v === "object" && !Array.isArray(v)) {
        const src = v as Record<string, unknown>
        const dst: Record<string, unknown> = {}
        for (const [name, sub] of Object.entries(src)) dst[name] = strictify(sub)
        out[k] = dst
      } else {
        out[k] = v
      }
    } else if (k === "not" || k === "if" || k === "then" || k === "else") {
      out[k] = strictify(v)
    } else {
      out[k] = v
    }
  }

  const props = out.properties
  if ((out.type === "object" || props !== undefined) && props && typeof props === "object" && !Array.isArray(props)) {
    const properties = props as Record<string, unknown>
    const keys = Object.keys(properties)
    const originalRequired = new Set(Array.isArray(out.required) ? (out.required as string[]) : [])
    out.additionalProperties = false
    // OpenAI strict mode requires EVERY property in `required`. Keep originally-optional
    // properties semantically optional by giving them a real null escape — the model returns
    // `null` to mean "absent" (restored by stripNullOptionals).
    out.required = keys
    for (const k of keys) {
      if (!originalRequired.has(k)) properties[k] = makeNullable(properties[k])
    }
  }
  return out
}

/**
 * Widen a schema so `null` is an accepted value, regardless of shape:
 *   - typed (`type: "string"` / `["string","number"]`)  → append "null" to the type list
 *   - enum                                               → append null to the enum
 *   - const                                              → wrap in anyOf:[orig, {type:"null"}]
 *   - anyOf/oneOf/$ref/typeless/other                    → wrap in anyOf:[orig, {type:"null"}]
 */
function makeNullable(schema: unknown): unknown {
  if (schema === null || typeof schema !== "object") {
    // bare scalar schema (rare) — wrap it
    return { anyOf: [schema, { type: "null" }] }
  }
  const s = schema as Record<string, unknown>
  if (Array.isArray(schema)) return { anyOf: [schema, { type: "null" }] }

  const t = s.type
  if (typeof t === "string") {
    if (t === "null") return s
    const next: Record<string, unknown> = { ...s, type: [t, "null"] }
    if (Array.isArray(s.enum) && !s.enum.includes(null)) next.enum = [...s.enum, null]
    return next
  }
  if (Array.isArray(t)) {
    const next: Record<string, unknown> = t.includes("null") ? { ...s } : { ...s, type: [...t, "null"] }
    if (Array.isArray(s.enum) && !s.enum.includes(null)) next.enum = [...s.enum, null]
    return next
  }
  // typeless: enum without a type still gets a null member
  if (Array.isArray(s.enum)) {
    return s.enum.includes(null) ? { ...s } : { ...s, enum: [...s.enum, null] }
  }
  // const / $ref / anyOf / oneOf / allOf / typeless object → wrap so null is a valid alternative
  return { anyOf: [s, { type: "null" }] }
}

/**
 * Normalize structured output before validation: drop `null` values for properties that are NOT
 * required AND whose author schema does NOT itself permit null. Codex's strict `outputSchema`
 * forces every key to be present, so we express optional fields as nullable — the model returns
 * `null` to mean "absent". This restores that semantics so the value validates against the author's
 * original (optional) schema, while preserving author-declared explicit nulls. Harmless for Claude.
 */
export function stripNullOptionals(value: unknown, schema: JSONSchema): unknown {
  if (value === null || typeof value !== "object") return value
  if (Array.isArray(value)) {
    const itemSchema = (schema.items as JSONSchema | undefined) ?? {}
    return value.map((v) => stripNullOptionals(v, itemSchema))
  }
  const props = (schema.properties as Record<string, JSONSchema> | undefined) ?? {}
  const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : [])
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const propSchema = props[k]
    // Only treat null as "absent" when the field is optional AND the author didn't declare it
    // nullable. A field the author made nullable keeps its explicit null.
    if (v === null && !required.has(k) && !allowsNull(propSchema)) continue
    out[k] = stripNullOptionals(v, propSchema ?? {})
  }
  return out
}

/** Does the author's original schema permit a literal null at this node? */
function allowsNull(schema: JSONSchema | undefined): boolean {
  if (!schema || typeof schema !== "object") return false
  const t = schema.type
  if (t === "null") return true
  if (Array.isArray(t) && t.includes("null")) return true
  if (Array.isArray(schema.enum) && schema.enum.includes(null)) return true
  for (const key of ["anyOf", "oneOf", "allOf"] as const) {
    const branch = schema[key]
    if (Array.isArray(branch) && branch.some((b) => allowsNull(b as JSONSchema))) return true
  }
  return false
}

/** Best-effort: parse a model's text output as JSON, including fenced or prose-wrapped values. */
export function parseJsonLoose(text: string): unknown {
  const trimmed = text.trim()
  let initialError: unknown
  try {
    return JSON.parse(trimmed)
  } catch (error) {
    initialError = error
  }

  const candidates = [
    ...[...trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((match) => ({
      text: match[1]!,
      end: match.index + match[0].length,
    })),
    ...balancedJsonSpans(trimmed),
  ].sort((a, b) => b.end - a.end || b.text.length - a.text.length)

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate.text)
    } catch {
      // Keep looking: models often quote an earlier example before emitting the final value.
    }
  }

  throw initialError
}

/** Return positioned object/array spans, ignoring delimiters inside JSON strings. */
function balancedJsonSpans(text: string): Array<{ text: string; end: number }> {
  const spans: Array<{ text: string; end: number }> = []
  const stack: Array<{ char: "{" | "["; index: number }> = []
  let inString = false
  let escaped = false

  for (let index = 0; index < text.length; index++) {
    const char = text[index]!
    if (inString) {
      if (escaped) escaped = false
      else if (char === "\\") escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
      continue
    }
    if (char === "{" || char === "[") {
      stack.push({ char, index })
      continue
    }
    if (char !== "}" && char !== "]") continue

    const expected = char === "}" ? "{" : "["
    const opening = stack.at(-1)
    if (!opening || opening.char !== expected) {
      stack.length = 0
      continue
    }
    stack.pop()
    spans.push({ text: text.slice(opening.index, index + 1), end: index + 1 })
  }

  return spans
}

/** Parse and validate a main-turn answer before paying for a separate extraction turn. */
export function parseValidJson(text: string, schema: JSONSchema): unknown | undefined {
  try {
    const parsed = parseJsonLoose(text)
    const normalized = stripNullOptionals(parsed, schema)
    return validate(schema, normalized).ok ? parsed : undefined
  } catch {
    return undefined
  }
}
