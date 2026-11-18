// src/dsl/models.ts owns the current model id of each family; shipped workflows and the skill read
// it through the injected `models` global. A model move edits that file and the one literal guard
// per family below, nothing else (see environment-configuration docs/model-pins.md).

import { strict as assert } from "node:assert"
import { readdirSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { test } from "node:test"
import { MODELS } from "../src/dsl/models.ts"
import { parseWorkflow, runInSandbox } from "../src/runtime/sandbox.ts"
import type { WorkflowGlobals } from "../src/dsl/types.ts"

const root = fileURLToPath(new URL("..", import.meta.url))

test("the Sol family is GPT-6.2 Sol", () => {
  assert.equal(MODELS.sol, "gpt-6.2-sol")
})

test("the Fable family is Fable 5.2", () => {
  assert.equal(MODELS.fable, "claude-fable-5-2")
})

test("the Opus family is Opus 5.5", () => {
  assert.equal(MODELS.opus, "claude-opus-5-5")
})

test("shipped workflows, the skill, and the README read model ids from `models` instead of retyping them", () => {
  const files = [
    ...["builtins", "examples"].flatMap((dir) =>
      readdirSync(root + dir).filter((f) => f.endsWith(".workflow.js")).map((f) => `${dir}/${f}`)),
    "skill/SKILL.md",
    "README.md",
  ]
  const literals = files.flatMap((file) =>
    [...readFileSync(root + file, "utf8").matchAll(/\b(gpt-\d[\w.-]*|claude-(?:fable|opus)-\d[\w-]*)/g)].map((m) => `${file}: ${m[1]}`))
  assert.deepEqual(literals, [])
  const readers = files.filter((file) => /model: models\.(sol|fable)\b/.test(readFileSync(root + file, "utf8"))).sort()
  assert.deepEqual(readers, [
    "README.md",
    "builtins/bake-off.workflow.js",
    "builtins/multi-provider-review.workflow.js",
    "builtins/provider-debate.workflow.js",
    "builtins/second-opinion.workflow.js",
    "examples/explore-codebase.workflow.js",
    "examples/parity-audit.workflow.js",
    "skill/SKILL.md",
  ], "every file that pins a model must read it from `models`")
})

test("the ambient `models` declaration names exactly the families in src/dsl/models.ts", () => {
  const ambient = readFileSync(root + "src/dsl/ambient.d.ts", "utf8")
  const decl = /const models: \{([^}]*)\}/.exec(ambient)
  assert.ok(decl, "ambient.d.ts must declare the injected models global")
  const declared = [...decl[1]!.matchAll(/readonly (\w+): string/g)].map((m) => m[1]).sort()
  assert.deepEqual(declared, Object.keys(MODELS).sort())
})

test("runInSandbox supplies the canonical models when an embedder's globals omit them", async () => {
  const body = parseWorkflow(
    `export const meta = { name: "n", description: "d" }\nreturn models.opus\n`,
  ).body
  const globals = {} as WorkflowGlobals // a pre-`models` embedder's globals object
  assert.equal(await runInSandbox({ body, filename: "wf.js", globals }), MODELS.opus)
  assert.equal(Object.getPrototypeOf(MODELS), null, "the shared map must not carry a mutable host prototype")
})

test("a workflow body reads the injected models and cannot change them", async () => {
  const body = parseWorkflow(
    `export const meta = { name: "n", description: "d" }\n` +
      `let threw = false\ntry { models.sol = "other" } catch { threw = true }\nreturn { sol: models.sol, threw }\n`,
  ).body
  const globals = { models: MODELS } as WorkflowGlobals
  const out = (await runInSandbox({ body, filename: "wf.js", globals })) as { sol: string; threw: boolean }
  assert.equal(out.sol, MODELS.sol)
  assert.equal(out.threw, true)
})
