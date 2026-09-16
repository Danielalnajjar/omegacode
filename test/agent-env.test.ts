import { test } from "node:test"
import assert from "node:assert/strict"
import { agentEnv } from "../src/worker/agent-env.ts"

test("agentEnv clones ordinary variables and removes only TYPESAFE_API_KEY", () => {
  const base = { PATH: "/bin", EMPTY: "", TYPESAFE_API_KEY: "secret" }
  const env = agentEnv(base)

  assert.deepEqual(env, { PATH: "/bin", EMPTY: "" })
  assert.notEqual(env, base)
  assert.equal(base.TYPESAFE_API_KEY, "secret")
})
