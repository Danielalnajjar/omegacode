// The far end of a remote agent in tests: the real `omegacode remote` helper, with a scripted
// worker that acts on the prompt inside the remote worktree. Started by the tests' local
// transport in place of `ssh <host> omegacode remote <command>`.
//
//   commit:<file>      write <file> and commit it
//   dirty:<file>       write <file> and leave it uncommitted
//   hang               wait until aborted
//   fail-retryable     fail with a retryable provider error
//   (anything else)    answer with text; structured output when a schema is given
// Each run appends its prompt to $OMEGACODE_HOME/calls.log. `hello` reports $FIXTURE_HOST_ID.

import { execFileSync } from "node:child_process"
import { appendFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { remoteMain } from "../../src/remote/helper.ts"
import { AgentError, AgentInterrupted, type Worker, type WorkerFactory } from "../../src/worker/index.ts"
import { emptyUsage, type AgentSpec } from "../../src/dsl/types.ts"
import { synthesize } from "../../src/worker/fake.ts"

const worker: Worker = {
  id: "codex",
  async runAgent(spec: AgentSpec, ctx) {
    appendFileSync(join(process.env.OMEGACODE_HOME!, "calls.log"), `${spec.prompt}\n`)
    ctx.onProgress({ kind: "text", text: `working on ${spec.prompt} in ${spec.cwd}` })
    const [verb, arg] = spec.prompt.split(":")
    const git = (args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t.t", "-c", "commit.gpgsign=false", ...args], { cwd: spec.cwd })
    if (verb === "commit") {
      writeFileSync(join(spec.cwd, arg!), `${spec.prompt}\n`)
      git(["add", arg!])
      git(["commit", "-q", "-m", `add ${arg}`])
    } else if (verb === "dirty") {
      writeFileSync(join(spec.cwd, arg!), `${spec.prompt}\n`)
    } else if (verb === "hang") {
      await new Promise<void>((resolve) => ctx.signal.addEventListener("abort", () => resolve(), { once: true }))
      throw new AgentInterrupted()
    } else if (verb === "fail-retryable") {
      throw new AgentError({ provider: spec.provider, code: "server_overloaded", message: "busy", retryable: true, usage: { ...emptyUsage(), outputTokens: 3 } })
    }
    const structured = spec.schema ? synthesize(spec.schema) : undefined
    return { text: `did ${spec.prompt}`, ...(structured === undefined ? {} : { structured }), status: "completed", usage: { ...emptyUsage(), outputTokens: 5 } }
  },
  async shutdown() {},
}

const factory: WorkerFactory = { get: () => worker, async shutdownAll() {} }

await remoteMain(process.argv[2], { factory: () => factory, hostId: async () => process.env.FIXTURE_HOST_ID })
