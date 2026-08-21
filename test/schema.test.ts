import { test } from "node:test"
import assert from "node:assert/strict"
import {
  toCodexOutputSchema,
  toClaudeOutputFormat,
  validate,
  assertValidSchema,
  stripNullOptionals,
  parseJsonLoose,
} from "../src/worker/schema.ts"
import type { JSONSchema } from "../src/dsl/types.ts"

// Helper: assert a strictified schema accepts `value`.
function accepts(strict: JSONSchema, value: unknown): boolean {
  return validate(strict, value).ok
}

test("validate: ok and error reporting", () => {
  const schema: JSONSchema = { type: "object", properties: { a: { type: "string" } }, required: ["a"] }
  assert.equal(validate(schema, { a: "hi" }).ok, true)
  const bad = validate(schema, { a: 1 })
  assert.equal(bad.ok, false)
  assert.match(bad.errors!, /a:/)
})

test("toClaudeOutputFormat wraps the schema verbatim", () => {
  const schema: JSONSchema = { type: "object" }
  const out = toClaudeOutputFormat(schema)
  assert.equal(out.type, "json_schema")
  assert.equal(out.schema, schema)
})

test("assertValidSchema throws on a malformed schema (L8 eager compile)", () => {
  // A bad $ref should throw at compile time, not silently compile.
  assert.throws(() => assertValidSchema({ $ref: "#/does/not/exist" }))
  // A valid schema does not throw.
  assert.doesNotThrow(() => assertValidSchema({ type: "string" }))
})

test("strictify: all keys become required + additionalProperties:false", () => {
  const schema: JSONSchema = { type: "object", properties: { a: { type: "string" }, b: { type: "number" } }, required: ["a"] }
  const strict = toCodexOutputSchema(schema)
  assert.deepEqual([...(strict.required as string[])].sort(), ["a", "b"])
  assert.equal(strict.additionalProperties, false)
})

test("M6: optional typed field gets null escape", () => {
  const schema: JSONSchema = { type: "object", properties: { a: { type: "string" }, b: { type: "number" } }, required: ["a"] }
  const strict = toCodexOutputSchema(schema)
  // b optional → nullable; null must validate.
  assert.equal(accepts(strict, { a: "x", b: null }), true)
  assert.equal(accepts(strict, { a: "x", b: 5 }), true)
})

test("M6: optional enum field gets null member", () => {
  const schema: JSONSchema = { type: "object", properties: { color: { enum: ["red", "green"] } }, required: [] }
  const strict = toCodexOutputSchema(schema)
  assert.equal(accepts(strict, { color: null }), true)
  assert.equal(accepts(strict, { color: "red" }), true)
  assert.equal(accepts(strict, { color: "blue" }), false)
  // the original enum members are preserved
  assert.ok((strict.properties as Record<string, JSONSchema>).color.enum!.includes("red"))
})

test("M6: optional const field gets anyOf null escape", () => {
  const schema: JSONSchema = { type: "object", properties: { kind: { const: "feature" } }, required: [] }
  const strict = toCodexOutputSchema(schema)
  assert.equal(accepts(strict, { kind: null }), true)
  assert.equal(accepts(strict, { kind: "feature" }), true)
  assert.equal(accepts(strict, { kind: "other" }), false)
})

test("M6: optional anyOf composite gets null escape", () => {
  const schema: JSONSchema = {
    type: "object",
    properties: { v: { anyOf: [{ type: "string" }, { type: "number" }] } },
    required: [],
  }
  const strict = toCodexOutputSchema(schema)
  assert.equal(accepts(strict, { v: null }), true)
  assert.equal(accepts(strict, { v: "x" }), true)
  assert.equal(accepts(strict, { v: 1 }), true)
  assert.equal(accepts(strict, { v: true }), false)
})

test("M6: optional $ref field gets null escape", () => {
  const schema: JSONSchema = {
    type: "object",
    properties: { node: { $ref: "#/$defs/Node" } },
    required: [],
    $defs: { Node: { type: "object", properties: { x: { type: "number" } }, required: ["x"] } },
  }
  const strict = toCodexOutputSchema(schema)
  assert.equal(accepts(strict, { node: null }), true)
  assert.equal(accepts(strict, { node: { x: 1 } }), true)
})

test("M6: optional typeless field gets null escape", () => {
  const schema: JSONSchema = { type: "object", properties: { meta: {} }, required: [] }
  const strict = toCodexOutputSchema(schema)
  // typeless wraps in anyOf:[orig, null]; both null and arbitrary values validate.
  assert.equal(accepts(strict, { meta: null }), true)
  assert.equal(accepts(strict, { meta: { anything: 1 } }), true)
})

test("M6: type-array optional field appends null", () => {
  const schema: JSONSchema = { type: "object", properties: { v: { type: ["string", "number"] } }, required: [] }
  const strict = toCodexOutputSchema(schema)
  assert.equal(accepts(strict, { v: null }), true)
  assert.equal(accepts(strict, { v: "s" }), true)
})

test("M6: required field is NOT made nullable", () => {
  const schema: JSONSchema = { type: "object", properties: { a: { type: "string" } }, required: ["a"] }
  const strict = toCodexOutputSchema(schema)
  assert.equal(accepts(strict, { a: null }), false)
  assert.equal(accepts(strict, { a: "x" }), true)
})

test("L9: a property literally named 'properties' is not corrupted", () => {
  // GeoJSON-style: an object with a property called `properties`.
  const schema: JSONSchema = {
    type: "object",
    properties: {
      type: { const: "Feature" },
      properties: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
    },
    required: ["type", "properties"],
  }
  const strict = toCodexOutputSchema(schema)
  const outer = strict.properties as Record<string, JSONSchema>
  // The outer `properties` key is itself a schema (object with its own `properties`).
  assert.equal(outer.properties.type, "object")
  const inner = outer.properties.properties as Record<string, JSONSchema>
  // The inner `name` property survived recursion (made strict).
  assert.ok(inner.name)
  // Round-trip: a valid Feature validates.
  assert.equal(accepts(strict, { type: "Feature", properties: { name: "x" } }), true)
})

test("strictify recurses into nested objects and arrays", () => {
  const schema: JSONSchema = {
    type: "object",
    properties: {
      list: { type: "array", items: { type: "object", properties: { a: { type: "string" }, b: { type: "number" } }, required: ["a"] } },
    },
    required: ["list"],
  }
  const strict = toCodexOutputSchema(schema)
  const items = ((strict.properties as Record<string, JSONSchema>).list.items) as JSONSchema
  assert.equal(items.additionalProperties, false)
  assert.deepEqual([...(items.required as string[])].sort(), ["a", "b"])
  // optional nested b is nullable
  assert.equal(accepts(strict, { list: [{ a: "x", b: null }] }), true)
})

test("strictify does not mutate the input schema", () => {
  const schema: JSONSchema = { type: "object", properties: { a: { type: "string" } }, required: ["a"] }
  const before = JSON.stringify(schema)
  toCodexOutputSchema(schema)
  assert.equal(JSON.stringify(schema), before)
})

test("L7: stripNullOptionals drops optional+null but keeps author-nullable null", () => {
  const schema: JSONSchema = {
    type: "object",
    properties: {
      // optional, NOT author-nullable → null means "absent" → dropped
      missing: { type: "string" },
      // optional but author-declared nullable → explicit null kept
      explicitlyNull: { type: ["string", "null"] },
      // required → kept regardless
      keep: { type: "string" },
    },
    required: ["keep"],
  }
  const out = stripNullOptionals({ missing: null, explicitlyNull: null, keep: "v" }, schema) as Record<string, unknown>
  assert.equal("missing" in out, false)
  assert.equal("explicitlyNull" in out, true)
  assert.equal(out.explicitlyNull, null)
  assert.equal(out.keep, "v")
})

test("L7: enum-with-null and anyOf-with-null are treated as author-nullable", () => {
  const schema: JSONSchema = {
    type: "object",
    properties: {
      e: { enum: ["a", null] },
      u: { anyOf: [{ type: "string" }, { type: "null" }] },
    },
    required: [],
  }
  const out = stripNullOptionals({ e: null, u: null }, schema) as Record<string, unknown>
  assert.equal("e" in out, true)
  assert.equal("u" in out, true)
})

test("stripNullOptionals recurses into arrays and nested objects", () => {
  const schema: JSONSchema = {
    type: "object",
    properties: {
      items: { type: "array", items: { type: "object", properties: { x: { type: "number" }, y: { type: "string" } }, required: ["x"] } },
    },
    required: ["items"],
  }
  const out = stripNullOptionals({ items: [{ x: 1, y: null }] }, schema) as { items: Array<Record<string, unknown>> }
  assert.equal("y" in out.items[0]!, false)
  assert.equal(out.items[0]!.x, 1)
})

test("stripNullOptionals leaves non-null values and scalars untouched", () => {
  assert.equal(stripNullOptionals("hi", { type: "string" }), "hi")
  assert.equal(stripNullOptionals(5, { type: "number" }), 5)
  assert.equal(stripNullOptionals(null, { type: "null" }), null)
})

test("strictify + stripNullOptionals round-trip restores author-optional semantics", () => {
  const authorSchema: JSONSchema = {
    type: "object",
    properties: { a: { type: "string" }, b: { enum: ["x", "y"] }, c: { type: "number" } },
    required: ["a"],
  }
  const strict = toCodexOutputSchema(authorSchema)
  // Model returns null for the optionals it omitted.
  const modelValue = { a: "hi", b: null, c: null }
  assert.equal(validate(strict, modelValue).ok, true)
  const normalized = stripNullOptionals(modelValue, authorSchema)
  // After normalization the value validates against the ORIGINAL optional schema.
  assert.equal(validate(authorSchema, normalized).ok, true)
  assert.deepEqual(normalized, { a: "hi" })
})

test("parseJsonLoose handles bare JSON and fenced JSON", () => {
  assert.deepEqual(parseJsonLoose('{"a":1}'), { a: 1 })
  assert.deepEqual(parseJsonLoose('```json\n{"a":2}\n```'), { a: 2 })
  assert.deepEqual(parseJsonLoose('```\n[1,2,3]\n```'), [1, 2, 3])
  assert.deepEqual(parseJsonLoose('  \n {"a": "b"}  '), { a: "b" })
})

test("parseJsonLoose prefers the last valid fenced block", () => {
  assert.deepEqual(parseJsonLoose('```json\n{"draft":true}\n```\nfinal:\n```json\n{"draft":false}\n```'), { draft: false })
})

test("parseJsonLoose prefers a later bare value over an earlier fenced example", () => {
  assert.deepEqual(parseJsonLoose('```json\n{"decision":"reject"}\n```\nFinal: {"decision":"accept"}'), { decision: "accept" })
})

test("parseJsonLoose skips an earlier poison fence", () => {
  assert.deepEqual(parseJsonLoose('```json\n{not json}\n```\n```json\n{"ok":true}\n```'), { ok: true })
})

test("parseJsonLoose accepts prose before a bare JSON value", () => {
  assert.deepEqual(parseJsonLoose('Here is the requested value:\n{"ok":true}'), { ok: true })
})

test("parseJsonLoose falls back to the widest balanced JSON span", () => {
  assert.deepEqual(parseJsonLoose('prefix [ignore] then {"outer":{"text":"} [ still text"},"items":[1,2]} suffix'), {
    outer: { text: "} [ still text" },
    items: [1, 2],
  })
})

test("parseJsonLoose still throws on non-JSON garbage", () => {
  assert.throws(() => parseJsonLoose("not json at all"))
})
