import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, readFile, readdir, realpath, rm, rmdir, symlink, writeFile } from "node:fs/promises"
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http"
import { createConnection, createServer } from "node:net"
import { dirname, join } from "node:path"
import { GrokWorker, GROK_AGENT_PROFILE_PATH as AGENT_PROFILE } from "./grok.js"
import { GROK_EXTRACTION_TOOLS, GROK_ISOLATED_TOOLS, isolatedGrokLaunch, loadGrokIsolation, type GrokIsolation } from "./grok-isolation.js"

const PROBE_MODEL = "benchmark-probe"
const BUILTIN_AGENTS = ["general-purpose", "explore", "plan"]
// Grok writes this user layer into its home on first sign-in; it registers the
// official marketplace and installs nothing (plugins and marketplaces stay empty).
const GROK_INIT_CONFIG = ["[marketplace]", "default_skills_installs_purged = true", "official_marketplace_auto_installed = true",
  "[[marketplace.sources]]", "name = \"xAI Official\"", "git = \"https://github.com/xai-org/plugin-marketplace.git\""]
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"

interface Check { label: string; passed: boolean; exitCode?: number | null; output?: string }
interface Step { label: string; tool: string; args: Record<string, unknown> }
type Details = { nodeArgv?: string[]; dependencyLinks?: Array<{ realPath: string; lockRealPath: string; path: string }>; targetedTest?: { cwd: string; args: string[]; env: Record<string, string> } }

function execute(bin: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs = 60000): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(bin, args, { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] })
    let stdout = "", stderr = ""
    const kill = () => { try { process.kill(-child.pid!, "SIGKILL") } catch {} }
    const timer = setTimeout(kill, timeoutMs)
    child.stdout.on("data", chunk => { stdout += chunk; if (stdout.length > 4 * 1024 * 1024) kill() })
    child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-4096) })
    child.once("error", error => { clearTimeout(timer); reject(error) })
    child.once("close", code => { clearTimeout(timer); kill(); resolveResult({ code, stdout, stderr }) })
  })
}

/** Native startup inventory of the live Grok home, taken under the production profile and env. */
export function assessGrokInventory(inventory: Record<string, unknown>, grokHome?: string, userConfig?: string): string[] {
  const failures: string[] = []
  for (const key of ["projectInstructions", "hooks", "skills", "plugins", "marketplaces", "mcpServers", "lspServers"]) {
    if (!Array.isArray(inventory[key])) failures.push(`${key}-missing`)
    else if ((inventory[key] as unknown[]).length !== 0) failures.push(`${key}-present`)
  }
  const agents = inventory.agents
  if (!Array.isArray(agents)) failures.push("agents-missing")
  else if (!agents.every(agent => BUILTIN_AGENTS.includes(agent?.name) && agent?.source?.type === "builtin")) failures.push("non-builtin-agents")
  const layers = (inventory.configSources as { layers?: unknown[] } | undefined)?.layers
  const initLayer = (layer: unknown) => grokHome !== undefined && userConfig !== undefined && (layer as { role?: unknown })?.role === "user" &&
    (layer as { path?: unknown }).path === join(grokHome, "config.toml") && JSON.stringify(userConfig.split("\n").map(line => line.trim()).filter(Boolean)) === JSON.stringify(GROK_INIT_CONFIG)
  if (!Array.isArray(layers) || !(layers.length === 0 || (layers.length === 1 && initLayer(layers[0])))) failures.push("config-layers-present")
  const sources = (inventory.permissions as { sources?: unknown[] } | undefined)?.sources
  if (!Array.isArray(sources) || sources.length !== 0) failures.push("permission-sources-present")
  return failures
}

/** Scripted local chat-completions endpoint. It never forwards anything and records every request. */
function scriptedModel(steps: Step[]) {
  const results = new Map<string, string>()
  const offeredTools: string[][] = []
  const sideTools: string[][] = []
  const extractionTools: string[][] = []
  let next = 0
  const server = createHttpServer((req: IncomingMessage, res: ServerResponse) => {
    let body = ""
    req.on("data", chunk => { body += chunk })
    req.on("end", () => {
      if (!req.url?.includes("chat/completions")) {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ object: "list", data: [{ id: PROBE_MODEL, object: "model" }] }))
        return
      }
      const request = JSON.parse(body) as { stream?: boolean; tools?: Array<{ function?: { name?: string } }>; messages?: Array<{ role: string; content: unknown; tool_call_id?: string }> }
      const names = (request.tools ?? []).map(tool => String(tool.function?.name))
      const lastMessage = request.messages?.at(-1)
      // Grok also asks the model for a session title and a status line; those are not agent turns.
      const side = (names.length === 1 && names[0] === "session_title") || JSON.stringify(lastMessage ?? "").includes("dashboard line")
      let reply: { tool?: string; args?: Record<string, unknown>; text?: string }
      if (side) { sideTools.push(names); reply = { text: "probe" } }
      // The schema-extraction turn resumes the session with every tool removed.
      else if (JSON.stringify(lastMessage ?? "").includes("Output ONLY the JSON")) { extractionTools.push(names); reply = { text: JSON.stringify({ probe: "complete" }) } }
      else {
        offeredTools.push(names)
        if (lastMessage?.role === "tool" && next > 0) {
          const content = lastMessage.content
          results.set(steps[next - 1]!.label, typeof content === "string" ? content : JSON.stringify(content))
        }
        reply = next < steps.length ? steps[next]! : { text: "probe complete" }
        next++
      }
      const id = `call_${next}`
      const delta = reply.tool
        ? { role: "assistant", tool_calls: [{ index: 0, id, type: "function", function: { name: reply.tool, arguments: JSON.stringify(reply.args) } }] }
        : { role: "assistant", content: reply.text }
      const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
      const chunk = (choice: unknown, extra = {}) => "data: " + JSON.stringify({ id: `probe-${next}`, object: "chat.completion.chunk", created: 0, model: PROBE_MODEL, choices: [choice], ...extra }) + "\n\n"
      if (request.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" })
        res.write(chunk({ index: 0, delta, finish_reason: null }))
        res.write(chunk({ index: 0, delta: {}, finish_reason: reply.tool ? "tool_calls" : "stop" }, { usage }))
        res.end("data: [DONE]\n\n")
      } else {
        res.writeHead(200, { "content-type": "application/json" })
        const message = reply.tool ? { role: "assistant", content: null, tool_calls: delta.tool_calls } : { role: "assistant", content: reply.text }
        res.end(JSON.stringify({ id: `probe-${next}`, object: "chat.completion", created: 0, model: PROBE_MODEL, choices: [{ index: 0, message, finish_reason: reply.tool ? "tool_calls" : "stop" }], usage }))
      }
    })
  })
  return { server, results, offeredTools, sideTools, extractionTools, answered: () => next }
}

export async function proveGrokIsolation(configFile: string) {
  const config = loadGrokIsolation(configFile)
  const details = JSON.parse(await readFile(configFile, "utf8")) as Details
  const checks: Check[] = []
  const receipt: { passed: boolean; modelCalls: number; authCopied: boolean; authRead: boolean; inferencePreventedBy: string; checks: Check[]; inventory?: unknown; nativeTools?: unknown; error?: string } =
    { passed: false, modelCalls: 0, authCopied: false, authRead: false, inferencePreventedBy: "tool probes use an unauthenticated probe home whose only model is a local scripted endpoint; the live home is only inspected", checks }
  const assert = (label: string, passed: boolean, exitCode?: number | null, output?: string) => {
    checks.push({ label, passed, ...(exitCode === undefined ? {} : { exitCode }), ...(output === undefined ? {} : { output: output.slice(-2000) }) })
    if (!passed) throw new Error(`Grok preflight failed: ${label}`)
  }
  const files: string[] = []
  let connections = 0
  const listener = createServer(socket => { connections++; socket.end() })
  const probeHome = join(dirname(configFile), `grok-probe-home-${randomUUID()}`)
  const probeConfigFile = join(dirname(configFile), `grok-probe-isolation-${randomUUID()}.json`)
  let model: ReturnType<typeof scriptedModel> | undefined
  const poison = process.env.BENCHMARK_POISON
  try {
    if (process.platform !== "darwin") throw new Error("Grok isolation requires macOS Seatbelt")
    await mkdir(config.home, { recursive: true, mode: 0o700 })

    // 1. Native startup inventory of the live, signed-in home: no hooks, skills,
    // agents, plugins, MCP/LSP servers, instructions, config layers or rules.
    const live = isolatedGrokLaunch(config, AGENT_PROFILE)
    const inspect = await execute(live.bin, [...live.prefix, "inspect", "--json"], config.workspace, live.env)
    let inventory: Record<string, unknown> | undefined
    try { inventory = JSON.parse(inspect.stdout) } catch {}
    assert("live-home-inspect", inspect.code === 0 && inventory !== undefined, inspect.code, inspect.stderr)
    receipt.inventory = { cwd: inventory!.cwd, projectRoot: inventory!.projectRoot, projectInstructions: inventory!.projectInstructions, hooks: inventory!.hooks, skills: inventory!.skills,
      agents: (inventory!.agents as Array<{ name: string; source: unknown }>).map(agent => ({ name: agent.name, source: agent.source })), plugins: inventory!.plugins,
      mcpServers: inventory!.mcpServers, lspServers: inventory!.lspServers, configSources: inventory!.configSources, permissionSources: (inventory!.permissions as { sources?: unknown }).sources }
    const userConfig = await readFile(join(config.grokHome, "config.toml"), "utf8").catch(() => undefined)
    const failures = assessGrokInventory(inventory!, config.grokHome, userConfig)
    assert(`live-home-inventory-clean${failures.length ? `:${failures.join(",")}` : ""}`, failures.length === 0)

    // 2. Tool probes through the production worker path with an unauthenticated probe home.
    const marker = async (root: string, contents: string, suffix = "") => {
      const path = join(root, `.grok-preflight-${randomUUID()}${suffix}`)
      await writeFile(path, contents, { flag: "wx", mode: 0o600 }); files.push(path); return path
    }
    const source = await marker(config.workspace, "workspace-readable")
    const input = await marker(config.inputs, "inputs-readable")
    const privateFile = await marker(dirname(configFile), "private-denied-marker")
    const outside = join(dirname(configFile), `.outside-${randomUUID()}`); files.push(outside)
    const insideFile = join(config.workspace, `.inside-${randomUUID()}`); files.push(insideFile)
    const scratchFile = join(config.scratch, `.scratch-${randomUUID()}`); files.push(scratchFile)
    const symlinkPath = join(config.workspace, `.escape-${randomUUID()}`); files.push(symlinkPath)
    await symlink(privateFile, symlinkPath)
    const hardlinkPath = join(config.workspace, `.hardlink-${randomUUID()}`); files.push(hardlinkPath)
    const authFile = join(config.grokHome, "auth.json")
    const steps: Step[] = []
    const expect = new Map<string, { allowed: boolean; expected?: string }>()
    const shell = (label: string, command: string, allowed: boolean, expected?: string, timeout?: number) => {
      steps.push({ label, tool: "run_terminal_command", args: { command: `${command}\nprintf '\\n__exit=%s\\n' "$?"`, description: label, ...(timeout ? { timeout } : {}) } })
      expect.set(label, { allowed, ...(expected === undefined ? {} : { expected }) })
    }
    shell("workspace-read", `/bin/cat ${quote(source)}`, true, "workspace-readable")
    shell("input-read", `/bin/cat ${quote(input)}`, true, "inputs-readable")
    shell("environment-clean", `test -z "\${BENCHMARK_POISON:-}\${XAI_API_KEY:-}\${GROK_AUTH:-}\${CODEX_HOME:-}\${OMEGACODE_GROK_ISOLATION_CONFIG:-}"`, true)
    shell("private-read-denied", `/bin/cat ${quote(privateFile)}`, false)
    for (const [i, root] of config.blockedRoots.entries()) shell(`blocked-root-list-${i}`, `/bin/ls -A ${quote(root)}`, false)
    shell("grok-home-list-denied", `/bin/ls -A ${quote(config.grokHome)}`, false)
    // Output is discarded: a failure of this probe must never print credentials.
    if (existsSync(authFile)) shell("grok-auth-read-denied", `/bin/cat ${quote(authFile)} >/dev/null`, false)
    if (existsSync(authFile)) shell("grok-auth-hardlink-denied", `/bin/ln ${quote(authFile)} ${quote(hardlinkPath)}`, false)
    shell("grok-executable-exec-denied", `${quote(config.grokExecutable)} --version`, false)
    shell("outside-write-denied", `/usr/bin/touch ${quote(outside)}`, false)
    shell("workspace-write-policy", `/usr/bin/touch ${quote(insideFile)}`, config.writable)
    shell("scratch-write", `/usr/bin/touch ${quote(scratchFile)}`, true)
    shell("symlink-escape-denied", `/bin/cat ${quote(symlinkPath)}`, false)
    if (details.dependencyLinks) {
      for (const [i, dep] of details.dependencyLinks.entries()) {
        const target = join(dep.realPath, `.probe-${randomUUID()}`)
        shell(`dependency-read-${i}`, `/bin/cat ${quote(dep.lockRealPath)} >/dev/null`, true)
        shell(`dependency-write-denied-${i}`, `/usr/bin/touch ${quote(target)}`, false)
        shell(`dependency-alias-write-denied-${i}`, `/usr/bin/touch ${quote(join(config.workspace, dep.path, target.slice(dep.realPath.length + 1)))}`, false)
      }
      let runner: string | undefined
      for (const dep of details.dependencyLinks) { try { runner = await realpath(join(config.workspace, dep.path, "vitest/vitest.mjs")); break } catch {} }
      assert("linked-vitest-present", Boolean(runner && details.nodeArgv))
      const testFile = await marker(config.workspace, `import {test,expect} from ${JSON.stringify(join(runner!, "..", "dist/index.js"))};test('confined dependency execution',()=>expect(2+2).toBe(4));`, ".test.mjs")
      const testConfig = await marker(config.inputs, `export default {test:{include:[${JSON.stringify(testFile)}],watch:false,cache:false}};`, ".config.mjs")
      shell("dependency-vitest-targeted", [...details.nodeArgv!, runner!, "run", testFile, "--config", testConfig, "--configLoader", "runner", "--no-cache"].map(quote).join(" "), true, undefined, 600000)
    }
    const listDirectories = async () => new Set((await readdir(config.workspace, { recursive: true, withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => join(entry.parentPath, entry.name)))
    const beforeDirectories = await listDirectories()
    if (details.targetedTest) {
      const target = details.targetedTest
      steps.push({ label: "case-targeted-vitest", tool: "run_terminal_command", args: { description: "case-targeted-vitest", timeout: 600000,
        command: `cd ${quote(join(config.workspace, target.cwd))} && ` + [...Object.entries(target.env).map(([key, value]) => `${key}=${quote(value)}`), ...details.nodeArgv!.map(quote), ...target.args.map(quote)].join(" ") + `\nprintf '\\n__exit=%s\\n' "$?"` } })
    }
    await new Promise<void>((resolve, reject) => { listener.once("error", reject); listener.listen(0, "127.0.0.1", resolve) })
    const port = (listener.address() as { port: number }).port
    await new Promise<void>((resolve, reject) => { const socket = createConnection({ host: "127.0.0.1", port }); socket.once("error", reject); socket.once("end", resolve); socket.resume() })
    assert("network-positive-control", connections === 1)
    // Bare tools resolve through Grok's login-shell snapshot, not the launch PATH.
    shell("tool-resolution", "command -v grep rg git python3 node; type grep | head -1; printf '%s\\n' \"$PATH\"", true)
    shell("bare-grep", `grep -c workspace-readable ${quote(source)}`, true, "1")
    shell("bare-rg", `rg -c workspace-readable ${quote(source)}`, true, "1")
    shell("git-version", "git --version", true, "git version")
    shell("python3-version", "python3 --version", true, "Python 3")
    shell("bare-node-version", "node --version", true, "v")
    if (details.nodeArgv) shell("case-node-version", `cd ${quote(join(config.workspace, details.targetedTest?.cwd ?? "."))} && ${details.nodeArgv.map(quote).join(" ")} --version`, true, "v")
    steps.push({ label: "exit-visibility", tool: "run_terminal_command", args: { command: "echo exit-visibility-marker; exit 7", description: "exit-visibility" } })
    shell("network-local-listener-denied", `/usr/bin/nc -z -v -w 2 127.0.0.1 ${port}`, false)
    shell("network-internet-denied", "/usr/bin/curl -sS -m 5 -o /dev/null https://api.x.ai/", false)
    const refused = ["read_file", "search_replace", "write", "list_dir", "grep", "spawn_subagent", "web_search", "web_fetch", "use_tool", "search_tool"]
    for (const tool of refused) steps.push({ label: `${tool}-refused`, tool, args: tool === "spawn_subagent" ? { prompt: "probe", description: "probe" } : { target_file: privateFile, file_path: privateFile, target_directory: dirname(privateFile), path: privateFile, pattern: "private", query: "probe", url: "http://127.0.0.1:1/", content: "x", old_string: "private", new_string: "x" } })

    await mkdir(probeHome, { mode: 0o700 })
    model = scriptedModel(steps)
    await new Promise<void>((resolve, reject) => { model!.server.once("error", reject); model!.server.listen(0, "127.0.0.1", resolve) })
    const modelPort = (model.server.address() as { port: number }).port
    await writeFile(join(probeHome, "config.toml"), [`[model.${PROBE_MODEL}]`, `model = "${PROBE_MODEL}"`, `base_url = "http://127.0.0.1:${modelPort}/v1"`,
      `api_key = "probe-not-a-credential"`, `api_backend = "chat_completions"`, "context_window = 100000", ""].join("\n"), { mode: 0o600 })
    const probeConfig: GrokIsolation = { ...config, grokHome: await realpath(probeHome) }
    await writeFile(probeConfigFile, JSON.stringify(probeConfig), { flag: "wx", mode: 0o600 })
    process.env.BENCHMARK_POISON = "must-not-inherit"
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 900000)
    const progress: Array<{ kind: string; output?: string; isError?: boolean }> = []
    let outcome: { structured?: unknown; error?: string }
    try {
      const result = await new GrokWorker({ isolationFile: probeConfigFile }).runAgent({ prompt: "Isolation probe.", provider: "grok", model: PROBE_MODEL, effort: "low", cwd: config.workspace,
        sandbox: config.writable ? "workspace-write" : "read-only", approval: "never",
        schema: { type: "object", properties: { probe: { type: "string" } }, required: ["probe"], additionalProperties: false } }, { signal: controller.signal, onProgress: event => { progress.push(event as { kind: string; output?: string; isError?: boolean }) } })
      outcome = { structured: result.structured }
    } catch (error) { outcome = { error: error instanceof Error ? error.message : String(error) } }
    finally { clearTimeout(timer) }
    assert("probe-session-completed", model.answered() === steps.length + 1, null, outcome.error)
    assert("schema-extraction-turn-completed", JSON.stringify(outcome.structured) === JSON.stringify({ probe: "complete" }) && model.extractionTools.length === 1, null, outcome.error)

    for (const [label, rule] of expect) {
      const output = model.results.get(label) ?? ""
      const exit = /__exit=(\d+)/.exec(output)
      const code = exit ? Number(exit[1]) : null
      const passed = rule.allowed
        ? code === 0 && (rule.expected === undefined || output.includes(rule.expected))
        : code !== null && code !== 0 && /Operation not permitted|Permission denied|Could not resolve host|Couldn't resolve/.test(output)
      assert(label, passed, code, output)
    }
    if (details.targetedTest) {
      const output = model.results.get("case-targeted-vitest") ?? ""
      const code = Number(/__exit=(\d+)/.exec(output)?.[1] ?? NaN)
      // A pre-existing assertion failure is recorded, not relabeled as an isolation failure.
      assert("case-targeted-vitest-executed", (code === 0 || code === 1) && /Test Files/.test(output) && /Tests/.test(output), code, output)
      const afterDirectories = await listDirectories()
      for (const directory of [...afterDirectories].filter(path => !beforeDirectories.has(path)).sort((a, b) => b.length - a.length)) {
        try { await rmdir(directory) } catch (error) { if (!["ENOTEMPTY", "ENOENT"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error }
      }
    }
    assert("network-listener-unreached", connections === 1)
    // A failing command must be visible both to the model and in Omega's recorded tool result.
    const visible = model.results.get("exit-visibility") ?? ""
    const recorded = progress.filter(event => event.kind === "tool-result" && event.output?.includes("exit-visibility-marker"))
    assert("nonzero-exit-visible", /exit: 7|"exit_code":7/.test(visible) && recorded.length > 0 && recorded.every(event => event.isError === true), null, visible + JSON.stringify(recorded).slice(0, 500))
    for (const tool of refused) {
      const output = model.results.get(`${tool}-refused`) ?? ""
      assert(`${tool}-refused`, output.length > 0 && !output.includes("private-denied-marker") && !/__exit=/.test(output), null, output)
    }
    const expected = [...GROK_ISOLATED_TOOLS].sort()
    receipt.nativeTools = { agentTurns: model.offeredTools.length, offered: [...new Set(model.offeredTools.map(names => [...names].sort().join(",")))], sideRequests: model.sideTools.length, sideTools: [...new Set(model.sideTools.flat())], extractionTurnTools: model.extractionTools }
    assert("native-tool-list-exact", model.offeredTools.length > 0 && model.offeredTools.every(names => JSON.stringify([...names].sort()) === JSON.stringify(expected)))
    assert("extraction-turn-tools-inert", model.extractionTools.every(names => names.every(name => GROK_EXTRACTION_TOOLS.includes(name))))
    assert("side-requests-no-extra-tools", model.sideTools.every(names => names.every(name => name === "session_title" || GROK_ISOLATED_TOOLS.includes(name))), null, JSON.stringify(model.sideTools))
    receipt.passed = true
  } catch (error) { receipt.error = error instanceof Error ? error.message : "Grok preflight failed" }
  finally {
    if (poison === undefined) delete process.env.BENCHMARK_POISON
    else process.env.BENCHMARK_POISON = poison
    if (listener.listening) await new Promise<void>(resolve => listener.close(() => resolve()))
    if (model?.server.listening) await new Promise<void>(resolve => model!.server.close(() => resolve()))
    await Promise.all([...files, probeConfigFile, probeHome ].map(path => rm(path, { recursive: true, force: true })))
  }
  return receipt
}
