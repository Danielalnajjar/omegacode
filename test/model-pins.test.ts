// Shipped workflows and the skill name the Codex model literally; this is the one place a model
// migration updates alongside them (see environment-configuration docs/model-pins.md).

import { strict as assert } from "node:assert"
import { readdirSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { test } from "node:test"

const CODEX_MODEL = "gpt-6-sol"
const root = fileURLToPath(new URL("..", import.meta.url))
const files = [
  ...["builtins", "examples"].flatMap((dir) =>
    readdirSync(root + dir).filter((f) => f.endsWith(".workflow.js")).map((f) => `${dir}/${f}`)),
  "skill/SKILL.md",
]

test("every Codex model literal in shipped workflows and the skill names the current Codex model", () => {
  const pins = files.flatMap((file) =>
    [...readFileSync(root + file, "utf8").matchAll(/"(gpt-[^"]+)"/g)].map((m) => `${file}: ${m[1]}`))
  assert.ok(pins.length >= 10, `expected codex pins, found ${pins.length}`)
  assert.deepEqual(pins.filter((pin) => !pin.endsWith(`: ${CODEX_MODEL}`)), [])
})
