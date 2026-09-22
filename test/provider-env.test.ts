// End-to-end factory→spawn→stdin wiring for the subprocess workers: a real workflow run drives a
// real spawned fake binary that records its argv/stdin/env/cwd. Complements the worker unit tests,
// which exercise the same logic only through the injectable spawn seam. POSIX-only (shebang bins).

import { after, before, test } from "node:test"
import assert from "node:assert/strict"
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { runWorkflow } from "../src/runtime/run.ts"
import { JsonRpcStdioClient } from "../src/worker/jsonrpc-stdio.ts"
import { providerEnv } from "../src/worker/provider-env.ts"

const posixOnly = { skip: process.platform === "win32" }
const grokAgentProfile = fileURLToPath(
  new URL("../src/worker/agents/fleet-omegacode-grok-worker.md", import.meta.url),
)

interface Launch {
  argv: string[]
  stdin: string
  prompt?: string
  cwd: string
  env: Record<string, string | undefined>
}

const inheritedTypesafeKey = process.env.TYPESAFE_API_KEY
before(() => { process.env.TYPESAFE_API_KEY = "must-not-reach-provider" })
after(() => { restoreEnv("TYPESAFE_API_KEY", inheritedTypesafeKey) })

/** A fake provider CLI: answers --version, records the run invocation, emits happy events. */
function writeFakeBin(path: string, version: string, eventJson: string | string[]): void {
  const events = Array.isArray(eventJson) ? eventJson : [eventJson]
  writeFileSync(
    path,
    [
      "#!/usr/bin/env node",
      'const fs = require("node:fs");',
      "const args = process.argv.slice(2);",
      'if (args[0] === "--version") { console.log("' + version + '"); process.exit(0); }',
      'let stdin = "";',
      'process.stdin.setEncoding("utf8");',
      'process.stdin.on("data", (c) => (stdin += c));',
      'process.stdin.on("end", () => {',
      '  const promptIndex = args.indexOf("--prompt-file");',
      '  const prompt = promptIndex === -1 ? undefined : fs.readFileSync(args[promptIndex + 1], "utf8");',
      "  fs.writeFileSync(process.env.RECORD, JSON.stringify({ argv: args, stdin, prompt, cwd: process.cwd(), env: { TYPESAFE_API_KEY: process.env.TYPESAFE_API_KEY, OPENCODE_DISABLE_AUTOUPDATE: process.env.OPENCODE_DISABLE_AUTOUPDATE, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, GROK_DISABLE_AUTOUPDATER: process.env.GROK_DISABLE_AUTOUPDATER } }));",
      `  for (const event of ${JSON.stringify(events)}) console.log(event);`,
      "});",
    ].join("\n"),
  )
  chmodSync(path, 0o755)
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

test("pi: overrides.piBin drives a real spawn with the exact argv/stdin contract", posixOnly, async () => {
  const dir = mkdtempSync(join(tmpdir(), "omega-pi-env-"))
  const prev = { OMEGACODE_HOME: process.env.OMEGACODE_HOME, RECORD: process.env.RECORD }
  try {
    const record = join(dir, "record.json")
    const bin = join(dir, "pi-fake.cjs")
    writeFakeBin(
      bin,
      "0.79.1",
      JSON.stringify({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "ok" }], usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { total: 0.01 } }, stopReason: "stop" },
      }).replace(/'/g, "\\'"),
    )
    const wf = join(dir, "pi-env.workflow.js")
    writeFileSync(
      wf,
      `export const meta = { name: "pi-env-smoke", description: "e2e env wiring", defaultProvider: "pi", defaultModel: "openrouter/foo/bar" }\n` +
        `return await agent("hello from workflow", { sandbox: "danger-full-access", effort: "high", instructions: "be terse", cwd: ${JSON.stringify(dir)} })\n`,
    )
    process.env.OMEGACODE_HOME = join(dir, "home")
    process.env.RECORD = record

    const outcome = await runWorkflow({ file: wf, quiet: true, overrides: { piBin: bin } })
    assert.equal(outcome.status, "completed", `error=${outcome.error}`)
    assert.equal(outcome.result, "ok")

    const launch = JSON.parse(readFileSync(record, "utf8")) as Launch
    assert.deepEqual(launch.argv, [
      "--mode",
      "json",
      "--no-session",
      "--model",
      "openrouter/foo/bar",
      "--thinking",
      "high",
      "--append-system-prompt",
      "be terse",
    ])
    assert.equal(launch.stdin, "hello from workflow")
    assert.equal(realpathSync(launch.cwd), realpathSync(dir))
    // The RUN inherits the user's agent dir (auth lives there) — no scratch isolation here.
    assert.equal(launch.env.PI_CODING_AGENT_DIR, undefined)
    assert.equal(launch.env.TYPESAFE_API_KEY, undefined)
  } finally {
    restoreEnv("OMEGACODE_HOME", prev.OMEGACODE_HOME)
    restoreEnv("RECORD", prev.RECORD)
    rmSync(dir, { recursive: true, force: true })
  }
})

test("opencode: OPENCODE_BIN env drives a real spawn with the exact argv/stdin contract", posixOnly, async () => {
  const dir = mkdtempSync(join(tmpdir(), "omega-oc-env-"))
  const prev = { OMEGACODE_HOME: process.env.OMEGACODE_HOME, RECORD: process.env.RECORD, OPENCODE_BIN: process.env.OPENCODE_BIN }
  try {
    const record = join(dir, "record.json")
    const bin = join(dir, "opencode-fake.cjs")
    writeFakeBin(bin, "1.16.2", JSON.stringify({ type: "text", sessionID: "ses_x", part: { text: "ok" } }))
    const wf = join(dir, "oc-env.workflow.js")
    writeFileSync(
      wf,
      `export const meta = { name: "oc-env-smoke", description: "e2e env wiring", defaultProvider: "opencode", defaultModel: "openrouter/foo/bar" }\n` +
        `return await agent("hello from workflow", { sandbox: "danger-full-access", instructions: "be terse", cwd: ${JSON.stringify(dir)} })\n`,
    )
    process.env.OMEGACODE_HOME = join(dir, "home")
    process.env.RECORD = record
    process.env.OPENCODE_BIN = bin

    const outcome = await runWorkflow({ file: wf, quiet: true })
    assert.equal(outcome.status, "completed", `error=${outcome.error}`)
    assert.equal(outcome.result, "ok")

    const launch = JSON.parse(readFileSync(record, "utf8")) as Launch
    assert.deepEqual(launch.argv, ["run", "--format", "json", "--thinking", "--model", "openrouter/foo/bar", "--dangerously-skip-permissions"])
    // Instructions arrive as a delimited stdin preamble (opencode run has no system-prompt flag).
    assert.equal(launch.stdin, "<instructions>\nbe terse\n</instructions>\n\nhello from workflow")
    assert.equal(realpathSync(launch.cwd), realpathSync(dir))
    assert.equal(launch.env.OPENCODE_DISABLE_AUTOUPDATE, "1")
    assert.equal(launch.env.TYPESAFE_API_KEY, undefined)
  } finally {
    restoreEnv("OMEGACODE_HOME", prev.OMEGACODE_HOME)
    restoreEnv("RECORD", prev.RECORD)
    restoreEnv("OPENCODE_BIN", prev.OPENCODE_BIN)
    rmSync(dir, { recursive: true, force: true })
  }
})

test("grok: GROK_BIN env drives a real spawn with prompt-file and policy flags", posixOnly, async () => {
  const dir = mkdtempSync(join(tmpdir(), "omega-grok-env-"))
  const prev = { OMEGACODE_HOME: process.env.OMEGACODE_HOME, RECORD: process.env.RECORD, GROK_BIN: process.env.GROK_BIN }
  try {
    const record = join(dir, "record.json")
    const bin = join(dir, "grok-fake.cjs")
    writeFakeBin(bin, "grok 0.2.121", [
      JSON.stringify({ type: "text", data: "ok" }),
      JSON.stringify({ type: "end", stopReason: "end_turn", sessionId: "ses_grok", usage: { input_tokens: 1, output_tokens: 2 } }),
    ])
    const wf = join(dir, "grok-env.workflow.js")
    writeFileSync(
      wf,
      `export const meta = { name: "grok-env-smoke", description: "e2e env wiring", defaultProvider: "grok", defaultModel: "grok-4.7" }\n` +
        `return await agent("hello from workflow", { effort: "high", instructions: "be terse", cwd: ${JSON.stringify(dir)} })\n`,
    )
    process.env.OMEGACODE_HOME = join(dir, "home")
    process.env.RECORD = record
    process.env.GROK_BIN = bin

    const outcome = await runWorkflow({ file: wf, quiet: true })
    assert.equal(outcome.status, "completed", `error=${outcome.error}`)
    assert.equal(outcome.result, "ok")

    const launch = JSON.parse(readFileSync(record, "utf8")) as Launch
    const promptPath = launch.argv.at(-1)
    assert.deepEqual(launch.argv, [
      "--cwd",
      dir,
      "--sandbox",
      "read-only",
      "--output-format",
      "streaming-json",
      "--no-auto-update",
      "--no-subagents",
      "--agent",
      grokAgentProfile,
      "-m",
      "grok-4.7",
      "--reasoning-effort",
      "high",
      "--rules",
      "be terse",
      "--always-approve",
      "--prompt-file",
      promptPath!,
    ])
    assert.equal(launch.stdin, "")
    assert.equal(launch.prompt, "hello from workflow")
    assert.equal(realpathSync(launch.cwd), realpathSync(dir))
    assert.equal(launch.env.GROK_DISABLE_AUTOUPDATER, "1")
    assert.equal(launch.env.TYPESAFE_API_KEY, undefined)
  } finally {
    restoreEnv("OMEGACODE_HOME", prev.OMEGACODE_HOME)
    restoreEnv("RECORD", prev.RECORD)
    restoreEnv("GROK_BIN", prev.GROK_BIN)
    rmSync(dir, { recursive: true, force: true })
  }
})

// Regression: Muse env/factory wiring runs one low-effort extraction exec on a schema miss.
test("muse: MUSE_BIN drives schema extraction through a fake executable", posixOnly, async () => {
  const dir = mkdtempSync(join(tmpdir(), "omega-muse-env-"))
  const prev = { OMEGACODE_HOME: process.env.OMEGACODE_HOME, MUSE_BIN: process.env.MUSE_BIN, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME }
  try {
    const record = join(dir, "prompts.json")
    const bin = join(dir, "muse-fake.cjs")
    writeFileSync(bin, `#!/usr/bin/env node
const fs = require('node:fs');
if (process.env.TYPESAFE_API_KEY) { console.error('credential leaked'); process.exit(91); }
if (process.argv.includes('--version')) { console.log('1.3.0'); process.exit(0); }
const record = ${JSON.stringify(record)};
const prompts = fs.existsSync(record) ? JSON.parse(fs.readFileSync(record, 'utf8')) : [];
const path = process.argv[process.argv.indexOf('--prompt-file') + 1];
prompts.push({path, text:fs.readFileSync(path,'utf8')}); fs.writeFileSync(record,JSON.stringify(prompts));
const text = prompts.length === 1 ? '{"ok":"wrong type"}' : '{"ok":true}';
console.log(JSON.stringify({payload_type:'run.terminal.completed',payload:{terminal:'completed',text}}));
`)
    chmodSync(bin, 0o755)
    const wf = join(dir, "muse.workflow.js")
    writeFileSync(wf, `export const meta = { name: "muse-env", description: "schema correction" }\nreturn await agent("read", { provider: "muse", model: "muse-spark-1.3-contributor", schema: { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } }, cwd: ${JSON.stringify(dir)} })\n`)
    process.env.OMEGACODE_HOME = join(dir, "home")
    process.env.XDG_CONFIG_HOME = dir
    process.env.MUSE_BIN = bin
    const outcome = await runWorkflow({ file: wf, quiet: true })
    assert.equal(outcome.status, "completed", outcome.error)
    assert.deepEqual(outcome.result, { ok: true })
    const prompts = JSON.parse(readFileSync(record, "utf8"))
    assert.equal(prompts.length, 2)
    assert.notEqual(prompts[0].path, prompts[1].path)
    assert.match(prompts[1].text, /Earlier you produced this answer/)
    assert.match(prompts[1].text, /must be boolean/)
  } finally {
    for (const [key, value] of Object.entries(prev)) restoreEnv(key, value)
    rmSync(dir, { recursive: true, force: true })
  }
})

test("JSON-RPC default spawn strips TypeSafe credentials and preserves unrelated env", posixOnly, async () => {
  const dir = mkdtempSync(join(tmpdir(), "omega-jsonrpc-env-"))
  const record = join(dir, "record.json")
  const bin = join(dir, "jsonrpc-env.cjs")
  const previousRecord = process.env.RECORD
  const client = new JsonRpcStdioClient({ bin, args: [], requestTimeoutMs: 5000 })
  try {
    writeFileSync(bin, `#!/usr/bin/env node
const fs = require('node:fs');
fs.writeFileSync(process.env.RECORD, JSON.stringify({ typesafe: process.env.TYPESAFE_API_KEY, record: process.env.RECORD }));
require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  console.log(JSON.stringify({ id: request.id, result: { ready: true } }));
});
`)
    chmodSync(bin, 0o755)
    process.env.RECORD = record
    client.start()
    assert.deepEqual(await client.request("ready"), { ready: true })
    assert.deepEqual(JSON.parse(readFileSync(record, "utf8")), { record })
    assert.equal(providerEnv({ TYPESAFE_API_KEY: "secret", KEEP_ME: "yes" }).KEEP_ME, "yes")
  } finally {
    await client.shutdown()
    restoreEnv("RECORD", previousRecord)
    rmSync(dir, { recursive: true, force: true })
  }
})
