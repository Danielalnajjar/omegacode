import { test } from "node:test"
import assert from "node:assert/strict"
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runMuseSmoke } from "../scripts/muse-smoke.mjs"

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
test("Muse smoke rejects a fake no-read success", { skip: process.platform === "win32" }, async () => {
  const root = mkdtempSync(join(tmpdir(), "muse-smoke-negative-"))
  const previous = process.env.XDG_CONFIG_HOME
  try {
    process.env.XDG_CONFIG_HOME = root
    writeFileSync(join(root, "README.md"), "# Smoke README\n")
    const bin = join(root, "fake-muse")
    writeFileSync(bin, `#!/usr/bin/env node
if (process.argv.includes('--version')) { console.log('1.2.1'); process.exit(0) }
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
