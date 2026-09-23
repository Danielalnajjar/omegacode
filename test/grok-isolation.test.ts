import test from "node:test"
import assert from "node:assert/strict"
import { execFile, execFileSync, spawn, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { GROK_EXTRACTION_TOOLS, GROK_ISOLATED_TOOLS, grokSeatbeltProfile, isolatedGrokToolArgs, loadGrokIsolation, type GrokIsolation } from "../src/worker/grok-isolation.js"
import { assessGrokInventory } from "../src/worker/grok-preflight.js"

// /usr/bin/curl stands in for the grok binary: the profile keys the provider
// parent by exact process path, so any fixed executable exercises the split.
const PARENT = "/usr/bin/curl"
function fixture(t: test.TestContext, over: Partial<GrokIsolation> = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "grok-isolation-test-")))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  for (const name of ["workspace", "inputs", "scratch/home", "grok-home", "deps", "private"]) mkdirSync(join(root, name), { recursive: true })
  const config: GrokIsolation = { schemaVersion: "grok-isolation.v1", grokExecutable: PARENT, grokHome: join(root, "grok-home"), home: join(root, "scratch/home"),
    workspace: join(root, "workspace"), inputs: join(root, "inputs"), scratch: join(root, "scratch"), readRoots: [join(root, "deps")], blockedRoots: [root], writable: true, ...over }
  const file = join(root, "private", "config.json")
  writeFileSync(file, JSON.stringify(config))
  return { root, config, file }
}

test("loader requires canonical roots, HOME in scratch and a Grok home outside tool roots", { skip: process.platform !== "darwin" }, t => {
  const { root, config, file } = fixture(t)
  assert.deepEqual(loadGrokIsolation(file, config.workspace), config)
  assert.throws(() => loadGrokIsolation(file, root), /workspace differs/)
  const bad = (over: Partial<GrokIsolation>, message: RegExp) => { writeFileSync(file, JSON.stringify({ ...config, ...over })); assert.throws(() => loadGrokIsolation(file), message) }
  bad({ home: join(root, "home") }, /HOME must live in scratch/)
  bad({ grokHome: join(config.scratch, "grok") }, /separate from tool-readable roots/)
  bad({ readRoots: [join(root, "grok-home")] }, /separate from tool-readable roots/)
  symlinkSync(join(root, "workspace"), join(root, "workspace-link"))
  bad({ workspace: join(root, "workspace-link") }, /canonical/)
})
test("loader rejects read roots and inputs nested with workspace or scratch in either direction", { skip: process.platform !== "darwin" }, t => {
  const { root, config, file } = fixture(t)
  for (const readRoot of [join(config.workspace, "deps"), join(config.scratch, "deps"), root]) {
    writeFileSync(file, JSON.stringify({ ...config, readRoots: [readRoot] }))
    assert.throws(() => loadGrokIsolation(file), /Isolation readRoots and inputs must be separate from writable roots/)
  }
  for (const inputs of [join(config.workspace, "inputs"), config.workspace]) {
    writeFileSync(file, JSON.stringify({ ...config, inputs }))
    assert.throws(() => loadGrokIsolation(file), /Isolation readRoots and inputs must be separate from writable roots/)
  }
})

test("tool arguments allow only the shell, and the extraction turn only todo_write", () => {
  assert.deepEqual(GROK_ISOLATED_TOOLS, ["run_terminal_command", "todo_write"])
  const main = isolatedGrokToolArgs(false), extraction = isolatedGrokToolArgs(true)
  const after = (args: string[], flag: string) => args[args.indexOf(flag) + 1]!
  assert.equal(after(main, "--tools"), GROK_ISOLATED_TOOLS.join(","))
  assert.equal(after(extraction, "--tools"), GROK_EXTRACTION_TOOLS.join(","))
  assert.ok(after(extraction, "--disallowed-tools").split(",").includes("run_terminal_command"))
  for (const args of [main, extraction]) {
    for (const tool of ["read_file", "search_replace", "write", "list_dir", "grep", "spawn_subagent", "wait_commands_or_subagents", "web_search", "web_fetch", "use_tool", "search_tool", "workflow"]) assert.ok(after(args, "--disallowed-tools").split(",").includes(tool), tool)
    assert.ok(args.includes("--no-memory") && args.includes("--disable-web-search"))
  }
})

test("inventory assessment accepts only built-in agents and empty host surfaces", { skip: process.platform !== "darwin" }, () => {
  const clean = { projectInstructions: [], hooks: [], skills: [], plugins: [], marketplaces: [], mcpServers: [], lspServers: [], configSources: { layers: [] }, permissions: { sources: [] },
    agents: ["general-purpose", "explore", "plan"].map(name => ({ name, source: { type: "builtin" } })) }
  assert.deepEqual(assessGrokInventory(clean), [])
  assert.deepEqual(assessGrokInventory({ ...clean, hooks: [{}], mcpServers: [{ name: "executor" }], projectInstructions: [{ path: "/x/AGENTS.md" }] }), ["projectInstructions-present", "hooks-present", "mcpServers-present"])
  assert.deepEqual(assessGrokInventory({ ...clean, agents: [{ name: "librarian", source: { type: "user" } }] }), ["non-builtin-agents"])
  assert.deepEqual(assessGrokInventory({ ...clean, skills: undefined, configSources: { layers: [{}] } }), ["skills-missing", "config-layers-present"])
  const init = "[marketplace]\ndefault_skills_installs_purged = true\nofficial_marketplace_auto_installed = true\n\n[[marketplace.sources]]\nname = \"xAI Official\"\ngit = \"https://github.com/xai-org/plugin-marketplace.git\"\n"
  const initLayer = { configSources: { layers: [{ role: "user", path: "/g/config.toml" }] } }
  assert.deepEqual(assessGrokInventory({ ...clean, ...initLayer }, "/g", init), [])
  assert.deepEqual(assessGrokInventory({ ...clean, ...initLayer }, "/g", init + "[mcp_servers.x]\ncommand = \"x\"\n"), ["config-layers-present"])
  assert.deepEqual(assessGrokInventory({ ...clean, ...initLayer }), ["config-layers-present"])
})

test("Seatbelt gives the provider parent network and its home while its children get neither", { skip: process.platform !== "darwin" }, async t => {
  const { root, config } = fixture(t)
  writeFileSync(join(config.grokHome, "auth.json"), "synthetic-credential")
  mkdirSync(join(config.grokHome, "bundled", "skills"), { recursive: true })
  writeFileSync(join(config.grokHome, "bundled", "skills", "SKILL.md"), "bundled")
  writeFileSync(join(root, "private", "secret"), "private")
  writeFileSync(join(config.workspace, "source"), "source")
  writeFileSync(join(config.readRoots[0]!, "dep"), "dep")
  symlinkSync(join(root, "private", "secret"), join(config.workspace, "escape"))
  const profile = grokSeatbeltProfile(config, "/dev/null")
  let connections = 0
  const listener = createServer(socket => { connections++; socket.end() })
  await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve))
  t.after(() => listener.close())
  const port = (listener.address() as { port: number }).port
  // Async: the listener shares this event loop, so a blocking spawn could never be accepted.
  const run = (args: string[]) => new Promise<{ status: number | null; stdout: string; stderr: string }>(resolve =>
    execFile("/usr/bin/sandbox-exec", ["-p", profile, ...args], { cwd: config.workspace, env: { PATH: "/usr/bin:/bin" }, encoding: "utf8", timeout: 10000 },
      (error, stdout, stderr) => resolve({ status: error ? (typeof error.code === "number" ? error.code : -1) : 0, stdout, stderr })))
  const child = (command: string) => run(["/bin/bash", "--noprofile", "--norc", "-c", command])
  const parent = (...args: string[]) => run([PARENT, ...args])

  assert.equal((await parent("-s", `file://${join(config.grokHome, "auth.json")}`)).stdout, "synthetic-credential")
  assert.equal((await parent("-s", `file://${join(root, "private", "secret")}`)).status, 37)
  assert.equal((await parent("-s", `file://${join(config.grokHome, "bundled", "skills", "SKILL.md")}`)).status, 37)
  assert.notEqual((await parent("-s", "-m", "3", `http://127.0.0.1:${port}/`)).status, 7)
  assert.equal(connections, 1)

  assert.equal((await child("cat source")).stdout, "source")
  assert.equal((await child(`cat ${join(config.readRoots[0]!, "dep")}`)).stdout, "dep")
  for (const command of [`cat ${join(config.grokHome, "auth.json")}`, `ls ${config.grokHome}`, `cat ${join(root, "private", "secret")}`, "cat escape",
    `ln ${join(config.grokHome, "auth.json")} hardlink`, `touch ${join(root, "outside")}`, `touch ${join(config.readRoots[0]!, "new")}`]) {
    const result = await child(command)
    assert.notEqual(result.status, 0, command)
    assert.match(result.stderr, /Operation not permitted|Permission denied/, command)
  }
  assert.equal((await child(`touch new && touch ${join(config.scratch, "new")}`)).status, 0)
  const outside = spawn("/bin/sleep", ["5"])
  t.after(() => outside.kill())
  assert.notEqual((await child(`kill -0 ${outside.pid}`)).status, 0)
  assert.equal((await child("sleep 5 & kill $!")).status, 0)
  assert.notEqual((await child(`/usr/bin/nc -z -w 1 127.0.0.1 ${port}`)).status, 0)
  assert.match((await child(`${PARENT} -s http://127.0.0.1:${port}/`)).stderr, /Operation not permitted/)
  assert.equal(connections, 1)
  // Homebrew tools run, as in a developer shell; Homebrew's service state does not.
  if (existsSync("/opt/homebrew/bin/rg")) {
    assert.equal((await child("/opt/homebrew/bin/rg --version >/dev/null && ls /opt/homebrew/bin >/dev/null")).status, 0)
    assert.match((await child("ls /opt/homebrew/var")).stderr, /Operation not permitted/)
  }
  writeFileSync(join(config.workspace, "readonly"), "")
  const readOnly = grokSeatbeltProfile({ ...config, writable: false }, "/dev/null")
  assert.notEqual(spawnSync("/usr/bin/sandbox-exec", ["-p", readOnly, "/usr/bin/touch", join(config.workspace, "readonly")]).status, 0)
  assert.equal(execFileSync("/bin/cat", [join(config.workspace, "source")], { encoding: "utf8" }), "source")
})
