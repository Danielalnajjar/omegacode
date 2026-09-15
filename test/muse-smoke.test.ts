import { test } from "node:test"
import assert from "node:assert/strict"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runEndToEnd, runMuseSmoke } from "../scripts/muse-smoke.mjs"

// Regression: the credential smoke stays injectable and proves a read without any installed Muse.
test("Muse smoke uses a fake binary only", { skip: process.platform === "win32" }, async () => {
  const root = mkdtempSync(join(tmpdir(), "muse-smoke-test-"))
  const previous = process.env.XDG_CONFIG_HOME
  try {
    process.env.XDG_CONFIG_HOME = root
    writeFileSync(join(root, "README.md"), "# Smoke README\n")
    const bin = join(root, "fake-muse")
    writeFileSync(bin, `#!/usr/bin/env node
if (process.argv.includes('--version')) { console.log('1.2.1'); process.exit(0) }
console.log(JSON.stringify({payload_type:'tool.result',payload:{text:'1|# Smoke README',correlation_facts:{tool_name:'read_file',outcome:'success'}}}));
console.log(JSON.stringify({payload_type:'run.terminal.completed',payload:{terminal:'completed',text:'# Smoke README'}}));
`)
    chmodSync(bin, 0o755)
    const result = await runMuseSmoke({ bin, cwd: root })
    assert.equal(result.status, "completed")
    assert.equal(result.text, "# Smoke README")
    assert.equal(result.readFileObserved, true)
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))
    assert.equal(pkg.scripts.test.includes("verify:muse-smoke"), false)
  } finally {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = previous
    rmSync(root, { recursive: true, force: true })
  }
})

// Regression: a completed terminal alone cannot pass a read smoke without tool evidence.
for (const outcome of ["absent", "failed"]) {
  test(`Muse smoke rejects a fake ${outcome} read`, { skip: process.platform === "win32" }, async () => {
    const root = mkdtempSync(join(tmpdir(), "muse-smoke-negative-"))
    const previous = process.env.XDG_CONFIG_HOME
    try {
      process.env.XDG_CONFIG_HOME = root
      writeFileSync(join(root, "README.md"), "# Smoke README\n")
      const bin = join(root, "fake-muse")
      writeFileSync(bin, `#!/usr/bin/env node
if (process.argv.includes('--version')) { console.log('1.2.1'); process.exit(0) }
${outcome === 'failed' ? `console.log(JSON.stringify({payload_type:'tool.result',payload:{text:'denied',correlation_facts:{tool_name:'read_file',outcome:'failed'}}}));` : ''}
console.log(JSON.stringify({payload_type:'run.terminal.completed',payload:{terminal:'completed',text:'# Smoke README'}}));
`)
      chmodSync(bin, 0o755)
      await assert.rejects(runMuseSmoke({ bin, cwd: root }), /did not read the file/)
    } finally {
      if (previous === undefined) delete process.env.XDG_CONFIG_HOME
      else process.env.XDG_CONFIG_HOME = previous
      rmSync(root, { recursive: true, force: true })
    }
  })
}

// Regression: prompt previews and failed reads cannot certify the end-to-end smoke.
for (const outcome of ["absent", "failed", "success"]) {
  test(`Muse end-to-end requires successful structured read evidence: ${outcome}`, () => {
    const heading = readFileSync("README.md", "utf8").split("\n").find(line => line.startsWith("# "))
    const fakeRun = (_bin: string, args: string[], opts: { env: NodeJS.ProcessEnv }) => {
      const workflow = readFileSync(args[2]!, "utf8")
      assert.ok(workflow.includes("read_file"))
      const run = join(opts.env.OMEGACODE_HOME!, "runs", "fake-run")
      mkdirSync(join(run, "agents"), { recursive: true })
      writeFileSync(join(run, "events.jsonl"), JSON.stringify({ prompt: workflow }) + "\n")
      const chunks: unknown[] = [{ kind: "meta", prompt: workflow }, { kind: "text", text: heading }]
      if (outcome !== "absent") chunks.push({ kind: "tool-result", name: "read_file", isError: outcome === "failed" })
      writeFileSync(join(run, "agents", "0.jsonl"), chunks.map(chunk => JSON.stringify(chunk)).join("\n") + "\n")
      return { status: 0, stdout: JSON.stringify({ runId: "fake-run", status: "completed", result: heading }, null, 2), stderr: "" }
    }
    if (outcome === "success") assert.doesNotThrow(() => runEndToEnd("fake-muse", fakeRun))
    else assert.throws(() => runEndToEnd("fake-muse", fakeRun), /no read_file evidence/)
  })
}
