import assert from "node:assert/strict"
import test from "node:test"
import { resolveRunModes } from "../src/runtime/run-modes.js"

test("fresh run modes stay off unless explicitly requested", () => {
  assert.deepEqual(resolveRunModes({}, undefined, false), { fake: false })
  assert.deepEqual(resolveRunModes({ fake: true }, undefined, false), { fake: true })
})

test("new journals inherit an omitted mode and reject an explicit contradiction", () => {
  for (const fake of [false, true]) {
    const saved = { fake }
    assert.deepEqual(resolveRunModes({}, saved, true), saved)
    assert.deepEqual(resolveRunModes(saved, saved, true), saved)
    assert.throws(() => resolveRunModes({ fake: !fake }, saved, true), /explicit --fake must match/)
    assert.deepEqual(saved, { fake })
  }
})

test("legacy journals without a recorded fake mode take the resume request", () => {
  for (const saved of [undefined, {}]) {
    assert.deepEqual(resolveRunModes({ fake: true }, saved, true), { fake: true })
    assert.deepEqual(resolveRunModes({ fake: false }, saved, true), { fake: false })
    assert.deepEqual(resolveRunModes({}, saved, true), { fake: false })
  }
})

test("malformed requested or recorded mode values are not silently coerced", () => {
  for (const value of [null, "false", 0, 1]) {
    assert.throws(() => resolveRunModes({ fake: value } as never, undefined, false), /expected a boolean/)
    assert.throws(() => resolveRunModes({}, { fake: value } as never, true), /invalid recorded/)
  }
  assert.throws(() => resolveRunModes({}, { fake: undefined }, true), /invalid recorded/)
})
