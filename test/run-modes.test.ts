import assert from "node:assert/strict"
import test from "node:test"
import { resolveRunModes } from "../src/runtime/run-modes.js"

test("fresh run modes stay off unless explicitly requested", () => {
  assert.deepEqual(resolveRunModes({}, undefined, false), { fake: false, typesafe: false })
  assert.deepEqual(resolveRunModes({ typesafe: true }, undefined, false), { fake: false, typesafe: true })
  assert.deepEqual(resolveRunModes({ fake: true, typesafe: true }, undefined, false), { fake: true, typesafe: true })
})

test("new journals inherit omitted modes and reject every explicit contradiction", () => {
  for (const fake of [false, true]) for (const typesafe of [false, true]) {
    const saved = { fake, typesafe }
    assert.deepEqual(resolveRunModes({}, saved, true), saved)
    assert.deepEqual(resolveRunModes(saved, saved, true), saved)
    assert.throws(() => resolveRunModes({ fake: !fake }, saved, true), /explicit --fake must match/)
    assert.throws(() => resolveRunModes({ typesafe: !typesafe }, saved, true), /explicit --typesafe must match/)
    assert.deepEqual(saved, { fake, typesafe })
  }
})

test("legacy fake journals remain resumable without inventing a TypeSafe grant", () => {
  for (const saved of [undefined, {}, { typesafe: false }]) {
    assert.deepEqual(resolveRunModes({ fake: true }, saved, true), { fake: true, typesafe: false })
    assert.deepEqual(resolveRunModes({ fake: false }, saved, true), { fake: false, typesafe: false })
    assert.deepEqual(resolveRunModes({}, saved, true), { fake: false, typesafe: false })
    assert.throws(() => resolveRunModes({ typesafe: true }, saved, true), /explicit --typesafe must match/)
  }
})

test("malformed requested or recorded mode values are not silently coerced", () => {
  for (const key of ["fake", "typesafe"]) for (const value of [null, "false", 0, 1]) {
    assert.throws(() => resolveRunModes({ [key]: value } as never, undefined, false), /expected a boolean/)
    assert.throws(() => resolveRunModes({}, { [key]: value } as never, true), /invalid recorded/)
  }
  assert.throws(() => resolveRunModes({}, { fake: undefined }, true), /invalid recorded/)
})
