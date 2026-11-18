import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test, type TestContext } from "node:test"
import { fileURLToPath } from "node:url"
import { loadRunStatus } from "../src/runtime/run-store.ts"
import { runWorkflow } from "../src/runtime/run.ts"
import { setTestEnv } from "./test-env.ts"

// Exercise the native worker and journal against a local Codex protocol peer, not a model.
function setup(t: TestContext, afterFanout = "return results") {
  const home = mkdtempSync(join(tmpdir(), "omega-startup-"))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const file = join(home, "startup.workflow.js")
  const codex = join(home, "codex")
  setTestEnv(t, { OMEGACODE_HOME: home, CODEX_BIN: codex })
  writeFileSync(file, `
    export const meta = { name: "startup", description: "test" }
    const results = await parallel([() => agent("cached"), () => agent("fresh"), () => agent("quiet")])
    ${afterFanout}
  `)
  writeFileSync(codex, `#!${process.execPath}
const readline = require("node:readline");
const fs = require("node:fs");
if (process.argv.includes("mcp") && process.argv.includes("list")) {
  console.log("[]");
} else if (process.argv.includes("features") && process.argv.includes("list")) {
  console.log("plugins stable true\\nunbounded_connection_retries stable true");
} else {
  const mode = fs.readFileSync(${JSON.stringify(join(home, "mode"))}, "utf8");
  const send = (frame) => console.log(JSON.stringify({ jsonrpc: "2.0", ...frame }));
  readline.createInterface({ input: process.stdin }).on("line", (line) => {
    const { id, method, params } = JSON.parse(line);
    if (id === undefined) return;
    const threadId = params?.threadId;
    const reply = (result) => send({ id, result });
    const notify = (method, data) => send({ method, params: { threadId, ...data } });
    if (method === "initialize") reply({ userAgent: "test-app-server" });
    else if (method === "thread/start") reply({ thread: { id: "thread-" + id } });
    else if (method === "thread/unsubscribe") reply({ status: "notLoaded" });
    else if (method === "turn/interrupt") reply({});
    else if (method === "turn/start") {
      reply({ turn: { id: "turn-" + id, status: "inProgress" } });
      const prompt = params.input[0].text;
      if (prompt === "cached" || (mode === "progress" && prompt === "fresh")) {
        notify("item/agentMessage/delta", { delta: "actual model work" });
        notify("turn/completed", { turn: { status: "completed" } });
      } else if (mode === "fail" || (mode === "handoff" && prompt === "fresh")) {
        notify("error", { error: { message: "provider rejected startup", codexErrorInfo: "usageLimitExceeded" } });
      } else if (mode === "late-success") {
        if (prompt === "fresh") {
          notify("error", { error: { message: "provider rejected startup", codexErrorInfo: "usageLimitExceeded" } });
        } else {
          const release = ${JSON.stringify(join(home, "release"))};
          const finish = () => {
            if (!fs.existsSync(release)) return;
            fs.unwatchFile(release);
            notify("item/agentMessage/delta", { delta: "sibling work finished" });
            notify("turn/completed", { turn: { status: "completed" } });
          };
          fs.watchFile(release, { interval: 10 }, finish);
          finish();
        }
      } else if (mode === "extract-disconnect" && !params.outputSchema) {
        notify("item/completed", { item: { type: "agentMessage", text: "working turn returned prose" } });
        notify("turn/completed", { turn: { status: "completed" } });
      } else if (mode.endsWith("-disconnect")) {
        if (mode === "tool-disconnect") {
          notify("item/started", { item: { type: "commandExecution", command: "fixture tool" } });
        } else if (mode === "usage-disconnect") {
          notify("thread/tokenUsage/updated", { tokenUsage: { total: { inputTokens: 5, outputTokens: 1 } } });
        }
        notify("error", { error: { message: "connection lost", codexErrorInfo: "responseStreamDisconnected" } });
      } else {
        notify("thread/tokenUsage/updated", { tokenUsage: { total: { inputTokens: 0, outputTokens: 0 } } });
      }
    }
  });
}
`, { mode: 0o700 })
  const mode = (value: string) => writeFileSync(join(home, "mode"), value)
  mode("fail")
  return { file, home, mode }
}

test("a resumed fan-out that makes no progress fails, even when a previous lane is cached", { skip: process.platform === "win32", timeout: 10_000 }, async (t) => {
  const { file } = setup(t)
  const first = await runWorkflow({ file, quiet: true })
  assert.equal(first.status, "completed")
  assert.deepEqual(first.agentCounts, { done: 1, failed: 2, skipped: 0, unfinished: 0 })

  const resumed = await runWorkflow({ file, resumeRunId: first.runId, quiet: true })
  assert.equal(resumed.status, "failed")
  assert.equal(resumed.result, undefined)
  const terminal = await loadRunStatus(first.runId)
  assert.equal(terminal?.status, "failed")
  assert.equal(terminal?.errorCode, "agent_restart_failed")
  assert.equal(terminal?.result, undefined, "the prior generation's result does not belong to this failure")
  assert.match(terminal?.error ?? "", /without any provider progress/)
  assert.equal(terminal?.agents.filter((agent) => agent.cached).length, 1)
  const listing = execFileSync(process.execPath, [
    "--import", "tsx", fileURLToPath(new URL("../src/cli.ts", import.meta.url)), "runs",
  ], { encoding: "utf8" })
  assert.match(listing, new RegExp(`^${first.runId}  failed\\b`, "m"))
})

test("a typed restart failure preserves the workflow's own error", { skip: process.platform === "win32", timeout: 10_000 }, async (t) => {
  const { file } = setup(t, 'throw new Error("The workflow could not assemble its report")')
  const first = await runWorkflow({ file, quiet: true })
  const resumed = await runWorkflow({ file, resumeRunId: first.runId, quiet: true })
  assert.equal(resumed.errorCode, "agent_restart_failed")
  assert.match(first.error ?? "", /The workflow could not assemble its report/)
  assert.equal(resumed.error, first.error)
})

test("a sibling that finishes after an early workflow rejection prevents a no-progress code", { skip: process.platform === "win32", timeout: 10_000 }, async (t) => {
  const { file, home, mode } = setup(t)
  writeFileSync(file, `
    export const meta = { name: "early-rejection", description: "test" }
    return await Promise.all([agent("fresh"), agent("quiet")])
  `)
  const first = await runWorkflow({ file, quiet: true })
  assert.equal(first.status, "failed")
  mode("late-success")
  const abort = new AbortController()
  t.after(() => abort.abort())
  const resumed = await runWorkflow({
    file, resumeRunId: first.runId, quiet: true, signal: abort.signal,
    onEvent(event) {
      if (event.type === "agent" && event.label === "fresh" && event.state === "failed") {
        setImmediate(() => writeFileSync(join(home, "release"), ""))
      }
    },
  })
  assert.equal(resumed.status, "failed")
  assert.match(resumed.error ?? "", /provider rejected startup/)
  assert.equal(resumed.agentCounts.done, 1)
  assert.equal(resumed.errorCode, undefined)
})

for (const providerMode of ["silent", "progress"]) {
  test(`heartbeat distinguishes zero usage alone from real provider progress (${providerMode})`, { skip: process.platform === "win32", timeout: 10_000 }, async (t) => {
    const { file, mode } = setup(t)
    const first = await runWorkflow({ file, quiet: true })
    mode(providerMode)
    const abort = new AbortController()
    t.after(() => abort.abort())
    t.mock.timers.enable({ apis: ["Date", "setInterval"], now: Date.now() })
    let observed = 0
    let ready!: () => void
    const bothLanes = new Promise<void>((resolve) => { ready = resolve })
    const resumed = runWorkflow({
      file, resumeRunId: first.runId, quiet: true, signal: abort.signal,
      onEvent(event) {
        if (event.type === "agent" && !event.cached
          && (event.state === "done" || (event.inputTokens === 0 && event.outputTokens === 0))) {
          if (++observed === 2) ready()
        }
      },
    })
    try {
      await bothLanes
      t.mock.timers.tick(300_000)
      const outcome = await Promise.race([resumed, new Promise<null>((resolve) => setTimeout(() => resolve(null), 500))])
      if (providerMode === "silent") {
        assert.equal(outcome?.status, "failed")
        assert.equal(outcome.errorCode, "agent_start_stalled")
        assert.match(outcome.error ?? "", /startup deadlines expired/)
      } else {
        assert.equal(outcome, null, "one genuinely active lane prevents an all-silent failure")
      }
    } finally {
      abort.abort()
      await resumed
    }
  })
}

test("a failed earlier dispatch does not age a lane that has not reached its provider", { skip: process.platform === "win32", timeout: 10_000 }, async (t) => {
  const { file, mode } = setup(t)
  const first = await runWorkflow({ file, quiet: true })
  mode("handoff")
  const abort = new AbortController()
  t.after(() => abort.abort())
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: Date.now() })
  const resumed = await runWorkflow({
    file, resumeRunId: first.runId, quiet: true, signal: abort.signal,
    overrides: { concurrency: 1 },
    onEvent(event) {
      if (event.type !== "agent" || event.label !== "quiet" || event.state !== "running") return
      if (event.startedAt !== undefined) {
        // The old lane failed, and this event occurs before the new provider dispatch.
        t.mock.timers.tick(300_000)
      } else if (event.inputTokens === 0 && event.outputTokens === 0) {
        // Reaching the provider proves the previous lane's age did not cancel this one.
        abort.abort()
      }
    },
  })
  assert.equal(resumed.status, "interrupted")
  assert.equal(resumed.errorCode, undefined)
})

test("a silent Codex lane does not shorten a sibling Muse startup window", { skip: process.platform === "win32", timeout: 10_000 }, async (t) => {
  const { file, home, mode } = setup(t)
  mode("silent")
  const muse = join(home, "muse-fake")
  writeFileSync(muse, `#!${process.execPath}
if (process.argv.includes("--version")) console.log("1.3.0");
else setInterval(() => {}, 1000);
`, { mode: 0o700 })
  process.env.MUSE_BIN = muse
  process.env.XDG_CONFIG_HOME = home
  writeFileSync(file, `
    export const meta = { name: "mixed-startup", description: "test" }
    return await parallel([
      () => agent("quiet"),
      () => agent("reason", { provider: "muse", model: "muse-spark-1.3-contributor", effort: "max" }),
    ])
  `)
  const abort = new AbortController()
  t.after(() => abort.abort())
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: Date.now() })
  let museFailure: string | undefined
  const outcome = await runWorkflow({
    file, quiet: true, signal: abort.signal,
    onEvent(event) {
      if (event.type === "agent" && event.provider === "muse" && event.state === "failed") {
        museFailure = event.error
      }
      if (event.type === "agent" && event.provider === "codex" && event.state === "running"
        && event.inputTokens === 0 && event.outputTokens === 0) {
        t.mock.timers.tick(300_000)
        abort.abort()
      }
    },
  })
  assert.equal(outcome.status, "interrupted", `${outcome.error}; Muse: ${museFailure}`)
  assert.equal(outcome.errorCode, undefined)
})

for (const [modeName, attempts] of [
  ["startup-disconnect", 9],
  ["tool-disconnect", 4],
  ["usage-disconnect", 4],
  ["extract-disconnect", 4],
] as const) {
  test(`Codex keeps the longer reconnect window only before work (${modeName})`, { skip: process.platform === "win32", timeout: 10_000 }, async (t) => {
    const { file, mode } = setup(t)
    mode(modeName)
    const options = modeName === "extract-disconnect" ? ', { schema: { type: "object" } }' : ""
    writeFileSync(file, `
      export const meta = { name: "retry-progress", description: "test" }
      return await agent("live"${options})
    `)
    const abort = new AbortController()
    t.after(() => abort.abort())
    let retry: string | undefined
    const outcome = await runWorkflow({
      file, quiet: true, signal: abort.signal,
      onEvent(event) {
        if (event.type === "log" && event.message.includes("retrying after responseStreamDisconnected")) {
          retry = event.message
          abort.abort()
        }
      },
    })
    assert.equal(outcome.status, "interrupted", outcome.error)
    assert.match(retry ?? "", new RegExp(`attempt 2/${attempts},`))
  })
}
