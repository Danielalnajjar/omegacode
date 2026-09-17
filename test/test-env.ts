import type { TestContext } from "node:test"

/** Replace (never merge) the environment with explicitly named test values. */
export function setTestEnv(t: TestContext, env: NodeJS.ProcessEnv): void {
  const previous = process.env
  t.after(() => { process.env = previous })
  process.env = { ...env }
}
