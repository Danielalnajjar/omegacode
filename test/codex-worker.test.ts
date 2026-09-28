import { after, test } from "node:test"
import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { existsSync } from "node:fs"

import {
  CodexWorker,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_THREAD_EPHEMERAL,
  DEFAULT_THREAD_START_CONCURRENCY,
  DEFAULT_TURN_STALL_TIMEOUT_MS,
  buildCodexAppServerArgs,
  renderTomlDynamicKeySegment,
  selectCodexFeatureOverrides,
  selectCodexLeanMcpServerNames,
  parseCodexPluginInventory,
  parseCodexPluginMarketplaceNames,
  selectCodexProfileMcpServersToDisable,
  selectMissingAllowedMcpServerNames,
} from "../src/worker/codex.js"
import { resolveCodexExecutionProfile, type CodexExecutionProfileName } from "../src/worker/codex-profile.js"
import { JsonRpcStdioClient, StdioTransportError, JsonRpcResponseError } from "../src/worker/jsonrpc-stdio.js"
import { AgentError, AgentInterrupted, type WorkerProgress } from "../src/worker/index.js"
import type { AgentSpec } from "../src/dsl/types.js"

// Several tests await rejections driven by UNREF'D timers (the request timeout, the stall
// watchdog) while the only "process" alive is a FakeChild with no real handles — so nothing
// keeps the event loop referenced. node:test on Node 20/22 then drains the loop mid-await and
// cancels the rest of the file ("Promise resolution is still pending but the event loop has
// already resolved"); Node 24+ pins the loop itself. A ref'd keep-alive makes the file behave
// identically on every supported Node line. (In production the spawned codex child's stdio
// keeps the loop alive, which is exactly why those timers unref.)
const keepAlive = setInterval(() => {}, 60_000)
after(() => clearInterval(keepAlive))

// ---------------------------------------------------------------------------
// A scripted fake child process satisfying the slice of ChildProcessWithoutNullStreams
// that JsonRpcStdioClient touches. Tests drive it: observe the client's writes
// via `onWrite`, and reply by pushing stdout lines or emitting error/exit.
// ---------------------------------------------------------------------------

interface FakeStdin {
  writable: boolean
  write(chunk: string, cb?: (err?: Error | null) => void): boolean
}

class FakeChild extends EventEmitter {
  readonly stdout = new EventEmitter() as EventEmitter & { setEncoding(e: string): void }
  readonly stderr = new EventEmitter() as EventEmitter & { setEncoding(e: string): void }
  readonly stdin: FakeStdin
  writes: string[] = []
  killed = false
  /** Reply callback: called with each parsed JSON object the client writes. */
  onWrite?: (obj: any) => void
  /** Make the next write report this error to its callback. */
  failNextWrite: Error | null = null
  failUnsubscribe = false
  holdUnsubscribe = false

  constructor() {
    super()
    ;(this.stdout as any).setEncoding = () => {}
    ;(this.stderr as any).setEncoding = () => {}
    const self = this
    this.stdin = {
      writable: true,
      write(chunk: string, cb?: (err?: Error | null) => void): boolean {
        self.writes.push(chunk)
        const err = self.failNextWrite
        self.failNextWrite = null
        if (cb) queueMicrotask(() => cb(err))
        if (!err) {
          for (const line of chunk.split("\n")) {
            const t = line.trim()
            if (!t) continue
            try {
              const request = JSON.parse(t)
              self.onWrite?.(request)
              if (request.method === "thread/unsubscribe") {
                if (self.holdUnsubscribe) {
                  continue
                } else if (self.failUnsubscribe) {
                  self.pushLine({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message: "fixture unsubscribe failure" } })
                } else {
                  self.pushLine({ jsonrpc: "2.0", id: request.id, result: { status: "unsubscribed" } })
                  self.pushLine({ jsonrpc: "2.0", method: "thread/closed", params: { threadId: request.params.threadId } })
                }
              }
            } catch {
              // ignore non-JSON
            }
          }
        }
        return true
      },
    }
  }

  pushLine(obj: unknown): void {
    this.stdout.emit("data", JSON.stringify(obj) + "\n")
  }
  pushRaw(s: string): void {
    this.stdout.emit("data", s)
  }
  pushStderr(s: string): void {
    this.stderr.emit("data", s)
  }
  emitExit(code: number | null, signal: string | null = null): void {
    this.emit("exit", code, signal)
  }
  emitError(err: Error): void {
    this.emit("error", err)
  }
  kill(): boolean {
    this.killed = true
    return true
  }
}

/** What the live codex-cli 0.137.0 initialize result looks like (abridged). */
const TEST_UA = "codex/0.0.0-test (fake)"
const INIT_OK = { userAgent: TEST_UA }

function ctx(signal?: AbortSignal): { signal: AbortSignal; onProgress: (e: WorkerProgress) => void; events: WorkerProgress[] } {
  const events: WorkerProgress[] = []
  return {
    signal: signal ?? new AbortController().signal,
    onProgress: (e) => events.push(e),
    events,
  }
}

function spec(over: Partial<AgentSpec> = {}): AgentSpec {
  return {
    prompt: "do the thing",
    provider: "codex",
    cwd: "/tmp/work",
    sandbox: "read-only",
    approval: "never",
    ...over,
  }
}

function mcpInventoryEntry(
  name: string,
  options: { enabled?: boolean; type?: string } = {},
): Record<string, unknown> {
  return {
    name,
    enabled: options.enabled ?? true,
    transport: { type: options.type ?? "stdio" },
  }
}

test("buildCodexAppServerArgs defaults to a fresh stdio app-server", () => {
  assert.deepEqual(buildCodexAppServerArgs(), ["-c", "thread_unload_delay_secs=0", "app-server"])
})

test("buildCodexAppServerArgs honors the env service-tier fallback when no per-worker tier is set", () => {
  const previous = process.env.OMEGACODE_CODEX_SERVICE_TIER
  process.env.OMEGACODE_CODEX_SERVICE_TIER = "flex"
  try {
    assert.deepEqual(buildCodexAppServerArgs(), ["-c", "thread_unload_delay_secs=0", "-c", "service_tier=flex", "app-server"])
  } finally {
    if (previous === undefined) delete process.env.OMEGACODE_CODEX_SERVICE_TIER
    else process.env.OMEGACODE_CODEX_SERVICE_TIER = previous
  }
})

test("buildCodexAppServerArgs prefers an explicit per-worker service tier", () => {
  assert.deepEqual(buildCodexAppServerArgs({ serviceTier: "fast" }), ["-c", "thread_unload_delay_secs=0", "-c", "service_tier=fast", "app-server"])
})

test("lean launch disables every inventoried server in one transport-preserving table", () => {
  assert.deepEqual(buildCodexAppServerArgs({ leanMcpServerNamesToDisable: ["onepassword", "paos-recall-mcp", "dotted.server"] }), [
    "-c", "thread_unload_delay_secs=0", "-c", 'mcp_servers={onepassword={enabled=false},paos-recall-mcp={enabled=false},"dotted.server"={enabled=false}}', "app-server",
  ])
})

test("lean inventory includes stdio, HTTP, legacy SSE, and already-disabled servers", () => {
  const inventory = JSON.stringify([
    mcpInventoryEntry("paos-recall-mcp"),
    mcpInventoryEntry("openaiDeveloperDocs", { type: "streamable_http" }),
    mcpInventoryEntry("node_repl"),
    mcpInventoryEntry("onepassword"),
    // The lean leaf keeps the host transport, so a transport no profile could replace is still disabled.
    mcpInventoryEntry("legacy-sse", { type: "sse" }),
  ])
  assert.deepEqual(selectCodexLeanMcpServerNames(inventory), ["paos-recall-mcp", "openaiDeveloperDocs", "node_repl", "onepassword", "legacy-sse"])
  assert.deepEqual(selectCodexLeanMcpServerNames(JSON.stringify([mcpInventoryEntry("off", { enabled: false })])), ["off"])
})

test("lean MCP selection rejects inventory schema drift", () => {
  assert.throws(() => selectCodexLeanMcpServerNames("{"), /invalid JSON/)
  assert.throws(() => selectCodexLeanMcpServerNames("{}"), /non-array inventory/)
  assert.throws(
    () => selectCodexLeanMcpServerNames(JSON.stringify([{ name: "onepassword", enabled: true }])),
    /no transport type/,
  )
  assert.throws(
    () => selectCodexLeanMcpServerNames(JSON.stringify([mcpInventoryEntry("onepassword"), mcpInventoryEntry("onepassword")])),
    /duplicate name/,
  )
})

test("plugin inventory accepts only installed plugin ids", () => {
  assert.deepEqual(parseCodexPluginInventory([JSON.stringify({ installed: [
    { pluginId: "computer-use@openai-bundled", source: { source: "local", path: "/plugins/computer-use" } },
    { pluginId: "github@openai-curated-remote", source: { source: "remote", id: "plugin_connector_1p_x" } },
  ] })]), [
    { id: "computer-use@openai-bundled", root: "/plugins/computer-use", remote: false },
    { id: "github@openai-curated-remote", remote: true },
  ])
  assert.throws(() => parseCodexPluginInventory(["{}"]), /no installed plugin inventory/)
  assert.throws(() => parseCodexPluginInventory(["{"]), /invalid JSON/)
  assert.throws(() => parseCodexPluginInventory([JSON.stringify({ installed: [{ enabled: true }] })]), /entry 0 has no valid pluginId/)
})

test("plugin inventory unions the default listing with every marketplace listing", () => {
  const listing = (...ids: string[]) => JSON.stringify({ installed: ids.map((pluginId) => ({ pluginId, enabled: true })), available: [] })
  // The default listing omits openai-curated; per-marketplace listings repeat plugins it already has.
  assert.deepEqual(parseCodexPluginInventory([
    listing("computer-use@openai-bundled", "github@openai-curated-remote"),
    listing("computer-use@openai-bundled"),
    listing("build-ios-apps@openai-curated", "linear@openai-curated"),
    listing(),
  ]).map((plugin) => plugin.id), ["computer-use@openai-bundled", "github@openai-curated-remote", "build-ios-apps@openai-curated", "linear@openai-curated"])
  assert.throws(
    () => parseCodexPluginInventory([listing("build-ios-apps@openai-curated", "build-ios-apps@openai-curated")]),
    /duplicate id "build-ios-apps@openai-curated"/,
  )
  assert.throws(() => parseCodexPluginInventory([listing(), "{}"]), /no installed plugin inventory/)
})

test("marketplace inventory yields every configured marketplace name", () => {
  assert.deepEqual(parseCodexPluginMarketplaceNames(JSON.stringify({ marketplaces: [
    { name: "openai-bundled", root: "/b" },
    { name: "openai-curated", root: "/c" },
  ] })), ["openai-bundled", "openai-curated"])
  assert.throws(() => parseCodexPluginMarketplaceNames("[]"), /no marketplace inventory/)
  assert.throws(() => parseCodexPluginMarketplaceNames(JSON.stringify({ marketplaces: [{ root: "/x" }] })), /entry 0 has no valid name/)
})

test("profile MCP selection carries transports for inventory minus the allowlist", () => {
  const inventory = JSON.stringify([
    mcpInventoryEntry("context7", { type: "streamable_http" }),
    mcpInventoryEntry("executor", { type: "streamable_http" }),
    mcpInventoryEntry("node_repl"),
    mcpInventoryEntry("whiteboard", { enabled: false }),
  ])
  assert.deepEqual(selectCodexProfileMcpServersToDisable(inventory, ["context7"]), [
    { name: "executor", transport: "streamable_http" },
    { name: "node_repl", transport: "stdio" },
    { name: "whiteboard", transport: "stdio" },
  ])
  assert.deepEqual(selectCodexProfileMcpServersToDisable(inventory, []), [
    { name: "context7", transport: "streamable_http" },
    { name: "executor", transport: "streamable_http" },
    { name: "node_repl", transport: "stdio" },
    { name: "whiteboard", transport: "stdio" },
  ])
})

test("profile MCP table quotes and escapes dynamic TOML keys", () => {
  assert.equal(renderTomlDynamicKeySegment("plain-name_1"), "plain-name_1")
  assert.equal(renderTomlDynamicKeySegment('odd."name\\server'), '"odd.\\"name\\\\server"')
  assert.deepEqual(buildCodexAppServerArgs({
    profileMcpServersToDisable: [{ name: 'odd."name\\server', transport: "stdio" }],
    profileMcpServerNamesToEnable: ['allowed."name\\server'],
  }), ["-c", "thread_unload_delay_secs=0", "-c", 'mcp_servers={"odd.\\"name\\\\server"={command="",enabled=false},"allowed.\\"name\\\\server"={enabled=true}}', "app-server"])
})

test("profile MCP selection rejects an unsupported transport only when it would be disabled", () => {
  const inventory = JSON.stringify([
    mcpInventoryEntry("allowed-sse", { type: "sse" }),
    mcpInventoryEntry("blocked-sse", { type: "sse" }),
  ])
  assert.throws(
    () => selectCodexProfileMcpServersToDisable(inventory, ["allowed-sse"]),
    /cannot disable Codex MCP server "blocked-sse": unsupported transport "sse"/,
  )
  assert.deepEqual(selectCodexProfileMcpServersToDisable(
    JSON.stringify([mcpInventoryEntry("allowed-sse", { type: "sse" })]),
    ["allowed-sse"],
  ), [])
})

test("feature selection skips keys absent from the local CLI inventory", () => {
  const result = selectCodexFeatureOverrides("apps stable true\nmulti_agent stable true\n", [
    { key: "features.apps", value: false },
    { key: "features.nonexistent_key_xyz", value: false },
    { key: "features.multi_agent", value: true },
  ])
  assert.deepEqual(result, {
    selected: [
      { key: "features.apps", value: false },
      { key: "features.multi_agent", value: true },
    ],
    skippedKeys: ["features.nonexistent_key_xyz"],
  })
})

test("resolveCodexExecutionProfile fails fast with the valid names", () => {
  for (const name of ["workflow-unknown", "toString", "constructor", "__proto__"]) {
    assert.throws(
      () => resolveCodexExecutionProfile(name),
      new RegExp(`unknown Codex execution profile "${name}".*workflow-bulk-v1, workflow-plan-v1, workflow-research-v1`),
    )
  }
})

// ===========================================================================
// JsonRpcStdioClient — transport invariants (H1, M1, M2)
// ===========================================================================

test("JsonRpcStdioClient: request resolves on matching response", async () => {
  const child = new FakeChild()
  const client = new JsonRpcStdioClient({ spawnChild: () => child as any })
  client.start()
  child.onWrite = (req) => child.pushLine({ jsonrpc: "2.0", id: req.id, result: { ok: 1 } })
  const r = await client.request("ping")
  assert.deepEqual(r, { ok: 1 })
})

test("JsonRpcStdioClient: response error → JsonRpcResponseError", async () => {
  const child = new FakeChild()
  const client = new JsonRpcStdioClient({ spawnChild: () => child as any })
  client.start()
  child.onWrite = (req) => child.pushLine({ jsonrpc: "2.0", id: req.id, error: { code: -1, message: "nope" } })
  await assert.rejects(client.request("ping"), (e) => e instanceof JsonRpcResponseError && e.message === "nope")
})

test("H1/M1: process exit rejects all pending requests and resets buffer", async () => {
  const child = new FakeChild()
  let gone: StdioTransportError | undefined
  const client = new JsonRpcStdioClient({ spawnChild: () => child as any, onProcessGone: (e) => (gone = e) })
  client.start()
  // Feed a partial frame so stdoutBuf is non-empty, then kill the process.
  child.pushRaw('{"partial": ')
  const p1 = client.request("a")
  const p2 = client.request("b")
  child.emitExit(1, null)
  await assert.rejects(p1, (e) => e instanceof StdioTransportError && e.code === "process_exited")
  await assert.rejects(p2, (e) => e instanceof StdioTransportError)
  assert.ok(gone)
  // After death the client is not alive and send() fails fast (no silent drop).
  assert.equal(client.alive, false)
  assert.throws(() => client.send("x"), (e) => e instanceof StdioTransportError && e.code === "not_writable")
  // request() after death rejects immediately rather than hanging.
  await assert.rejects(client.request("c"), (e) => e instanceof StdioTransportError)
})

test("H1: send() throws when stdin is not writable (no silent drop)", () => {
  const child = new FakeChild()
  const client = new JsonRpcStdioClient({ spawnChild: () => child as any })
  client.start()
  child.stdin.writable = false
  assert.throws(() => client.send("x"), (e) => e instanceof StdioTransportError && e.code === "not_writable")
})

test("H1: a failed write surfaces as process-gone, not a silent drop", async () => {
  const child = new FakeChild()
  let gone = false
  const client = new JsonRpcStdioClient({ spawnChild: () => child as any, onProcessGone: () => (gone = true) })
  client.start()
  child.failNextWrite = new Error("EPIPE")
  const p = client.request("x")
  await assert.rejects(p, (e) => e instanceof StdioTransportError)
  assert.equal(gone, true)
})

test("M2: stderr is drained into a bounded ring buffer", () => {
  const child = new FakeChild()
  const client = new JsonRpcStdioClient({ spawnChild: () => child as any, stderrLimit: 10 })
  client.start()
  child.pushStderr("0123456789ABCDEF")
  // only the last 10 bytes retained
  assert.equal(client.stderr(), "6789ABCDEF")
})

test("M2: exit error message includes recent stderr tail", async () => {
  const child = new FakeChild()
  const client = new JsonRpcStdioClient({ spawnChild: () => child as any })
  client.start()
  child.pushStderr("panic: boom\n")
  const p = client.request("x")
  child.emitExit(101)
  const err = await p.catch((e) => e)
  assert.ok(err instanceof StdioTransportError)
  assert.match(err.message, /panic: boom/)
})

test("M30: request timeout rejects a wedged request", async () => {
  const child = new FakeChild()
  const client = new JsonRpcStdioClient({ spawnChild: () => child as any, requestTimeoutMs: 30 })
  client.start()
  child.onWrite = () => {} // never reply
  await assert.rejects(client.request("hang"), (e) => e instanceof StdioTransportError && e.code === "request_timeout")
})

test("JsonRpcStdioClient: shutdown rejects pending and kills child (idempotent)", async () => {
  const child = new FakeChild()
  const client = new JsonRpcStdioClient({ spawnChild: () => child as any })
  client.start()
  const p = client.request("x")
  client.shutdown()
  await assert.rejects(p, (e) => e instanceof StdioTransportError && e.code === "shutdown")
  assert.equal(child.killed, true)
  client.shutdown() // no throw
})

test("stdout flushed AFTER process death is not dispatched (no crash, no stale frames)", () => {
  const child = new FakeChild()
  const notes: string[] = []
  const reqs: string[] = []
  const client = new JsonRpcStdioClient({
    spawnChild: () => child as any,
    onNotification: (m) => notes.push(m),
    onServerRequest: (_id, m) => reqs.push(m),
  })
  client.start()
  child.emitExit(1, null)
  // A dying child can flush buffered stdout after 'exit'; replying to this
  // request would throw inside the stream handler on the old code.
  child.pushLine({ jsonrpc: "2.0", id: 1, method: "item/commandExecution/requestApproval", params: { threadId: "t" } })
  child.pushLine({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "t" } })
  assert.deepEqual(reqs, [])
  assert.deepEqual(notes, [])
})

test("JsonRpcStdioClient: dispatches notifications and server requests", () => {
  const child = new FakeChild()
  const notes: Array<[string, unknown]> = []
  const reqs: Array<[unknown, string]> = []
  const client = new JsonRpcStdioClient({
    spawnChild: () => child as any,
    onNotification: (m, p) => notes.push([m, p]),
    onServerRequest: (id, m) => reqs.push([id, m]),
  })
  client.start()
  child.pushLine({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "t" } })
  child.pushLine({ jsonrpc: "2.0", id: 9, method: "item/fileChange/requestApproval", params: {} })
  assert.deepEqual(notes, [["turn/completed", { threadId: "t" }]])
  assert.deepEqual(reqs, [[9, "item/fileChange/requestApproval"]])
})

// ===========================================================================
// CodexWorker — happy path
// ===========================================================================

// Inventory seams for workers launched without appServerArgs, so a test never spawns (or reads the
// config of) whatever codex is installed on the host.
const HERMETIC_INVENTORY = {
  readMcpInventory: async () => "[]",
  readFeatureInventory: async () => "plugins stable true\nplugin_sharing stable true\nremote_plugin stable true\napps stable true\nenable_mcp_apps stable true\ncomputer_use stable true\nbrowser_use stable true\nbrowser_use_external stable true\nin_app_browser stable true",
}

// Helper that attaches the scripted server BEFORE the worker spawns, by
// intercepting spawnChild. Avoids the attach-after-spawn race.
function makeServedWorker(
  turnScript: (req: any, reply: (obj: unknown) => void, turnIndex: number) => void,
  opts: {
    bin?: string
    appServerArgs?: string[]
    serviceTier?: string
    readMcpInventory?: (bin: string) => Promise<string>
    readPluginInventory?: (bin: string) => Promise<string[]>
    executionProfile?: CodexExecutionProfileName
    readFeatureInventory?: (bin: string) => Promise<string>
    logProfileWarning?: (message: string) => void
    requestTimeoutMs?: number
    turnStallTimeoutMs?: number
    threadEphemeral?: boolean
    threadId?: string
    initResult?: unknown
    threadListResult?: unknown | ((params: any) => unknown)
    threadReadResult?: unknown | ((params: any) => unknown)
    onServerReq?: (child: FakeChild, req: any) => void
  } = {},
): { worker: CodexWorker; getChild: () => FakeChild } {
  let child!: FakeChild
  let turnIndex = 0
  const worker = new CodexWorker({
    bin: opts.bin,
    appServerArgs: opts.appServerArgs,
    serviceTier: opts.serviceTier,
    readMcpInventory: opts.readMcpInventory ?? HERMETIC_INVENTORY.readMcpInventory,
    readPluginInventory: opts.readPluginInventory ?? (async () => [JSON.stringify({ installed: [] })]),
    executionProfile: opts.executionProfile,
    readFeatureInventory: opts.readFeatureInventory ?? HERMETIC_INVENTORY.readFeatureInventory,
    logProfileWarning: opts.logProfileWarning,
    requestTimeoutMs: opts.requestTimeoutMs,
    turnStallTimeoutMs: opts.turnStallTimeoutMs,
    threadEphemeral: opts.threadEphemeral,
    spawnChild: () => {
      child = new FakeChild()
      const threadId = opts.threadId ?? "thread-1"
      child.onWrite = (req: any) => {
        opts.onServerReq?.(child, req)
        if (req.method === "initialize") return child.pushLine({ jsonrpc: "2.0", id: req.id, result: opts.initResult ?? INIT_OK })
        if (req.method === "initialized") return
        if (req.method === "thread/start") return child.pushLine({ jsonrpc: "2.0", id: req.id, result: { thread: { id: threadId } } })
        if (req.method === "thread/list") return child.pushLine({
          jsonrpc: "2.0",
          id: req.id,
          result: typeof opts.threadListResult === "function"
            ? opts.threadListResult(req.params)
            : opts.threadListResult ?? { data: [], nextCursor: null, backwardsCursor: null },
        })
        if (req.method === "thread/read") return child.pushLine({
          jsonrpc: "2.0",
          id: req.id,
          result: typeof opts.threadReadResult === "function"
            ? opts.threadReadResult(req.params)
            : opts.threadReadResult ?? {
                thread: {
                  id: req.params.threadId,
                  parentThreadId: null,
                  agentRole: null,
                  turns: [],
                },
              },
        })
        if (req.method === "thread/delete") return child.pushLine({ jsonrpc: "2.0", id: req.id, result: {} })
        if (req.method === "turn/interrupt") return child.pushLine({ jsonrpc: "2.0", id: req.id, result: {} })
        if (req.method === "turn/start") {
          child.pushLine({ jsonrpc: "2.0", id: req.id, result: {} })
          const idx = turnIndex++
          turnScript(req, (obj) => child.pushLine(obj), idx)
          return
        }
      }
      return child as unknown as import("node:child_process").ChildProcessWithoutNullStreams
    },
  })
  return { worker, getChild: () => child }
}

function tick(): Promise<void> {
  return new Promise((r) => setImmediate(r))
}

test("lean worker inventories every MCP transport and disables process features before launch", async () => {
  let inventoryReads = 0
  const { worker } = makeServedWorker(
    (_req, reply) => {
      reply({ jsonrpc: "2.0", method: "item/completed", params: { threadId: "thread-1", item: { type: "agentMessage", text: "done" } } })
      reply({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "thread-1", turn: { status: "completed" } } })
    },
    {
      bin: "/custom/codex",
      serviceTier: "default",
      readMcpInventory: async (bin) => {
        inventoryReads += 1
        assert.equal(bin, "/custom/codex")
        return JSON.stringify([
          mcpInventoryEntry("paos-recall-mcp"),
          mcpInventoryEntry("onepassword"),
          mcpInventoryEntry("node_repl"),
          mcpInventoryEntry("openaiDeveloperDocs", { type: "streamable_http" }),
          mcpInventoryEntry("legacy-sse", { type: "sse" }),
        ])
      },
    },
  )

  await worker.runAgent(spec(), ctx())
  await worker.runAgent(spec(), ctx())
  assert.equal(inventoryReads, 2)
  const launchedArgs = (worker as any).appServerArgs as string[]
  assert.deepEqual(configValues(launchedArgs), [
    "thread_unload_delay_secs=0",
    "service_tier=default",
    "mcp_servers={paos-recall-mcp={enabled=false},onepassword={enabled=false},node_repl={enabled=false},openaiDeveloperDocs={enabled=false},legacy-sse={enabled=false}}",
    ...["plugins", "plugin_sharing", "remote_plugin", "apps", "enable_mcp_apps", "computer_use", "browser_use", "browser_use_external", "in_app_browser"].map((name) => `features.${name}=false`),
  ])
  await worker.shutdown()
})

test("lean worker inventory failure is pre-launch with no global opt-out", async () => {
  let spawned = false
  const worker = new CodexWorker({
    readMcpInventory: async () => {
      throw new Error("inventory timed out")
    },
    spawnChild: () => {
      spawned = true
      return new FakeChild() as any
    },
  })
  await assert.rejects(
    worker.runAgent(spec(), ctx()),
    (error) =>
      error instanceof AgentError &&
      error.code === "mcp_inventory_failed" &&
      error.retryable === false &&
      /cannot inspect Codex MCP configuration/.test(error.message),
  )
  assert.equal(spawned, false)
})

const COMMON_PROFILE_FEATURE_ARGS = [
  "features.apps=false",
  "features.enable_mcp_apps=false",
  "features.browser_use=false",
  "features.browser_use_external=false",
  "features.browser_use_full_cdp_access=false",
  "features.in_app_browser=false",
  "features.computer_use=false",
  "features.image_generation=false",
  "features.plugins=false",
  "features.plugin_sharing=false",
  "features.remote_plugin=false",
  "features.shell_snapshot=false",
  "features.standalone_web_search=false",
  "features.web_search_cached=false",
  "features.web_search_request=false",
] as const

const PROFILE_FEATURE_ARGS: Record<CodexExecutionProfileName, readonly string[]> = {
  "workflow-bulk-v1": [
    ...COMMON_PROFILE_FEATURE_ARGS,
    "features.goals=false",
    "features.hooks=false",
    "features.memories=false",
    "features.skip_host_skill_discovery=true",
  ],
  "workflow-plan-v1": [...COMMON_PROFILE_FEATURE_ARGS],
  "workflow-research-v1": [...COMMON_PROFILE_FEATURE_ARGS],
}

function configValues(args: readonly string[]): string[] {
  return args.flatMap((arg, index) => args[index - 1] === "-c" ? [arg] : [])
}

test("execution profiles build their exact known feature and MCP override sets", async () => {
  const inventory = JSON.stringify([
    mcpInventoryEntry("btca"),
    mcpInventoryEntry("context7", { type: "streamable_http" }),
    mcpInventoryEntry("executor", { type: "streamable_http" }),
    mcpInventoryEntry("executor_research", { enabled: false, type: "streamable_http" }),
    mcpInventoryEntry("grok_search", { type: "streamable_http" }),
    mcpInventoryEntry("mintlify", { type: "streamable_http" }),
    mcpInventoryEntry("node_repl"),
  ])
  for (const executionProfile of ["workflow-bulk-v1", "workflow-plan-v1", "workflow-research-v1"] as const) {
    let featureReads = 0
    const threadStarts: any[] = []
    const { worker } = makeServedWorker(
      (_req, reply) => {
        reply({ jsonrpc: "2.0", method: "item/completed", params: { threadId: "thread-1", item: { type: "agentMessage", text: "done" } } })
        reply({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "thread-1", turn: { status: "completed" } } })
      },
      {
        executionProfile,
        readMcpInventory: async () => inventory,
        readFeatureInventory: async () => {
          featureReads += 1
          return PROFILE_FEATURE_ARGS[executionProfile]
            .map((override) => `${override.slice("features.".length).split("=")[0]} stable true`)
            .join("\n")
        },
        onServerReq: (_child, req) => {
          if (req.method === "thread/start") threadStarts.push(req.params)
        },
      },
    )

    await worker.runAgent(spec(), ctx())
    await worker.runAgent(spec(), ctx())
    assert.equal(featureReads, 1)
    assert.deepEqual(
      threadStarts.map((start) => start.config.mcp_optional_startup_grace_ms),
      executionProfile === "workflow-research-v1" ? [0, 0] : [undefined, undefined],
    )
    const expectedMcp = executionProfile === "workflow-research-v1"
      ? 'mcp_servers={context7={url="http://127.0.0.1:9/omegacode-managed-disabled",enabled=false},executor={url="http://127.0.0.1:9/omegacode-managed-disabled",enabled=false},node_repl={command="",enabled=false},btca={enabled=true},executor_research={enabled=true},grok_search={enabled=true},mintlify={enabled=true}}'
      : 'mcp_servers={btca={command="",enabled=false},context7={url="http://127.0.0.1:9/omegacode-managed-disabled",enabled=false},executor={url="http://127.0.0.1:9/omegacode-managed-disabled",enabled=false},executor_research={url="http://127.0.0.1:9/omegacode-managed-disabled",enabled=false},grok_search={url="http://127.0.0.1:9/omegacode-managed-disabled",enabled=false},mintlify={url="http://127.0.0.1:9/omegacode-managed-disabled",enabled=false},node_repl={command="",enabled=false}}'
    assert.deepEqual(configValues((worker as any).appServerArgs), ["thread_unload_delay_secs=0", expectedMcp, ...PROFILE_FEATURE_ARGS[executionProfile]])
    await worker.shutdown()
  }
})

test("research profile fails before worker launch when executor_research is absent", async () => {
  let featureReads = 0
  let spawned = false
  const worker = new CodexWorker({
    executionProfile: "workflow-research-v1",
    readMcpInventory: async () => JSON.stringify([
      mcpInventoryEntry("btca"),
      mcpInventoryEntry("grok_search", { type: "streamable_http" }),
      mcpInventoryEntry("mintlify", { type: "streamable_http" }),
    ]),
    readFeatureInventory: async () => {
      featureReads += 1
      return PROFILE_FEATURE_ARGS["workflow-research-v1"]
        .map((override) => `${override.slice("features.".length).split("=")[0]} stable true`)
        .join("\n")
    },
    spawnChild: () => {
      spawned = true
      return new FakeChild() as any
    },
  })

  await assert.rejects(
    worker.runAgent(spec(), ctx()),
    (error) => error instanceof AgentError
      && error.code === "mcp_inventory_failed"
      && error.retryable === false
      && /required MCP servers.*executor_research/.test(error.message),
  )
  assert.equal(featureReads, 0)
  assert.equal(spawned, false)
})

test("profile skips unknown local features with one non-fatal warning", async () => {
  const warnings: string[] = []
  const { worker } = makeServedWorker(
    (_req, reply) => {
      reply({ jsonrpc: "2.0", method: "item/completed", params: { threadId: "thread-1", item: { type: "agentMessage", text: "done" } } })
      reply({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "thread-1", turn: { status: "completed" } } })
    },
    {
      executionProfile: "workflow-plan-v1",
      readMcpInventory: async () => "[]",
      readFeatureInventory: async () => PROFILE_FEATURE_ARGS["workflow-plan-v1"]
        .filter((override) => override !== "features.apps=false")
        .map((override) => `${override.slice("features.".length).split("=")[0]} stable true`)
        .join("\n"),
      logProfileWarning: (message) => warnings.push(message),
    },
  )

  await worker.runAgent(spec(), ctx())
  assert.ok(!configValues((worker as any).appServerArgs).includes("features.apps=false"))
  assert.deepEqual(warnings, ["[omegacode] Codex execution profile workflow-plan-v1 skipped unknown features: features.apps"])
  await worker.shutdown()
})

test("profile feature probe failure is pre-launch and honest", async () => {
  let spawned = false
  const worker = new CodexWorker({
    executionProfile: "workflow-bulk-v1",
    readMcpInventory: async () => "[]",
    readFeatureInventory: async () => { throw new Error("feature probe timed out") },
    spawnChild: () => {
      spawned = true
      return new FakeChild() as any
    },
  })
  await assert.rejects(
    worker.runAgent(spec(), ctx()),
    (error) => error instanceof AgentError && error.code === "feature_inventory_failed" && /feature probe timed out/.test(error.message),
  )
  assert.equal(spawned, false)
})

test("profile feature inventory fails closed when empty", async () => {
  let spawned = false
  const worker = new CodexWorker({
    executionProfile: "workflow-plan-v1",
    readMcpInventory: async () => "[]",
    readFeatureInventory: async () => "",
    spawnChild: () => {
      spawned = true
      return new FakeChild() as any
    },
  })
  await assert.rejects(
    worker.runAgent(spec(), ctx()),
    (error) => error instanceof AgentError
      && error.code === "feature_inventory_failed"
      && /zero feature names/.test(error.message),
  )
  assert.equal(spawned, false)
})

test("profile feature inventory fails closed when all override keys are unknown", async () => {
  let spawned = false
  const worker = new CodexWorker({
    executionProfile: "workflow-plan-v1",
    readMcpInventory: async () => "[]",
    readFeatureInventory: async () => "unrelated_feature stable true\n",
    spawnChild: () => {
      spawned = true
      return new FakeChild() as any
    },
  })
  await assert.rejects(
    worker.runAgent(spec(), ctx()),
    (error) => error instanceof AgentError
      && error.code === "feature_inventory_failed"
      && /none of 15 profile feature override keys/.test(error.message),
  )
  assert.equal(spawned, false)
})

test("execution profiles reject explicit app-server args before probing", async () => {
  let probed = false
  let spawned = false
  const worker = new CodexWorker({
    executionProfile: "workflow-plan-v1",
    appServerArgs: ["app-server", "custom"],
    readMcpInventory: async () => {
      probed = true
      return "[]"
    },
    spawnChild: () => {
      spawned = true
      return new FakeChild() as any
    },
  })
  await assert.rejects(
    worker.runAgent(spec(), ctx()),
    (error) => error instanceof AgentError
      && error.code === "profile_explicit_args_unsupported"
      && error.retryable === false
      && /explicit app-server args/.test(error.message),
  )
  assert.equal(probed, false)
  assert.equal(spawned, false)
})

test("one caller aborting shared initialization does not interrupt another caller", async () => {
  const controller = new AbortController()
  let releaseInventory!: (inventory: string) => void
  let inventoryReads = 0
  const inventory = new Promise<string>((resolve) => { releaseInventory = resolve })
  const { worker } = makeServedWorker(
    (_req, reply) => {
      reply({ jsonrpc: "2.0", method: "item/completed", params: { threadId: "thread-1", item: { type: "agentMessage", text: "done" } } })
      reply({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "thread-1", turn: { status: "completed" } } })
    },
    {
      executionProfile: "workflow-plan-v1",
      readMcpInventory: async () => {
        inventoryReads += 1
        return await inventory
      },
      readFeatureInventory: async () => PROFILE_FEATURE_ARGS["workflow-plan-v1"]
        .map((override) => `${override.slice("features.".length).split("=")[0]} stable true`)
        .join("\n"),
    },
  )
  const runA = worker.runAgent(spec(), ctx(controller.signal))
  await tick()
  const runB = worker.runAgent(spec(), ctx())
  controller.abort()
  await assert.rejects(runA, (error) => error instanceof AgentInterrupted)
  releaseInventory("[]")
  assert.equal((await runB).text, "done")
  assert.equal(inventoryReads, 2)
  await worker.shutdown()
})

test("a re-entrant abort during the synchronous startup prologue still interrupts the caller", async () => {
  const controller = new AbortController()
  let releaseInventory!: (inventory: string) => void
  const inventory = new Promise<string>((resolve) => { releaseInventory = resolve })
  const { worker } = makeServedWorker(
    (_req, reply) => {
      reply({ jsonrpc: "2.0", method: "item/completed", params: { threadId: "thread-1", item: { type: "agentMessage", text: "done" } } })
      reply({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "thread-1", turn: { status: "completed" } } })
    },
    {
      executionProfile: "workflow-plan-v1",
      readMcpInventory: async () => {
        // Aborts synchronously inside ensureStarted()'s prologue, before
        // waitForStarted has registered its abort listener.
        controller.abort()
        return await inventory
      },
      readFeatureInventory: async () => PROFILE_FEATURE_ARGS["workflow-plan-v1"]
        .map((override) => `${override.slice("features.".length).split("=")[0]} stable true`)
        .join("\n"),
    },
  )
  await assert.rejects(
    worker.runAgent(spec(), ctx(controller.signal)),
    (error) => error instanceof AgentInterrupted,
  )
  releaseInventory("[]")
  assert.equal((await worker.runAgent(spec(), ctx())).text, "done")
  await worker.shutdown()
})

test("abort settles promptly while shared initialization continues", async () => {
  const controller = new AbortController()
  let releaseInventory!: (inventory: string) => void
  const inventory = new Promise<string>((resolve) => { releaseInventory = resolve })
  const { worker } = makeServedWorker(
    (_req, reply) => {
      reply({ jsonrpc: "2.0", method: "item/completed", params: { threadId: "thread-1", item: { type: "agentMessage", text: "done" } } })
      reply({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "thread-1", turn: { status: "completed" } } })
    },
    {
      executionProfile: "workflow-plan-v1",
      readMcpInventory: async () => await inventory,
      readFeatureInventory: async () => PROFILE_FEATURE_ARGS["workflow-plan-v1"]
        .map((override) => `${override.slice("features.".length).split("=")[0]} stable true`)
        .join("\n"),
    },
  )
  const run = worker.runAgent(spec(), ctx(controller.signal))
  await tick()
  controller.abort()
  const result = await Promise.race([
    run.then(() => "resolved", (error) => error),
    new Promise<"timed-out">((resolve) => setTimeout(() => resolve("timed-out"), 500)),
  ])
  assert.ok(result instanceof AgentInterrupted)
  releaseInventory("[]")
  assert.equal((await worker.runAgent(spec(), ctx())).text, "done")
  await worker.shutdown()
})

test("explicit app-server args bypass inventory", async () => {
  for (const options of [
    { appServerArgs: ["app-server", "custom"], expected: ["-c", "thread_unload_delay_secs=0", "app-server", "custom"] },
  ]) {
    const { worker } = makeServedWorker(
      (_req, reply) => {
        reply({ jsonrpc: "2.0", method: "item/completed", params: { threadId: "thread-1", item: { type: "agentMessage", text: "done" } } })
        reply({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "thread-1", turn: { status: "completed" } } })
      },
      {
        ...options,
        readMcpInventory: async () => {
          throw new Error("inventory must be bypassed")
        },
        readFeatureInventory: async () => {
          throw new Error("feature inventory must be bypassed with explicit args")
        },
      },
    )
    await worker.runAgent(spec(), ctx())
    assert.deepEqual((worker as any).appServerArgs, options.expected)
    await worker.shutdown()
  }
})

test("runAgent happy path (served before spawn): resolves with usage", async () => {
  const { worker } = makeServedWorker((_req, reply) => {
    reply({ jsonrpc: "2.0", method: "item/completed", params: { threadId: "thread-1", item: { type: "agentMessage", text: "done" } } })
    reply({
      jsonrpc: "2.0",
      method: "thread/tokenUsage/updated",
      params: {
        threadId: "thread-1",
        tokenUsage: {
          total: { inputTokens: 50, cachedInputTokens: 40, outputTokens: 10 },
          last: { inputTokens: 50, cachedInputTokens: 40, outputTokens: 10 },
        },
      },
    })
    reply({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "thread-1", turn: { status: "completed" } } })
  })
  const res = await worker.runAgent(spec(), ctx())
  assert.equal(res.text, "done")
  assert.equal(res.usage.inputTokens, 50)
  assert.equal(res.usage.outputTokens, 10)
  assert.equal(res.usage.cacheReadInputTokens, 40)
  assert.equal(res.usage.cacheCreationInputTokens, undefined)
  await worker.shutdown()
})

test("CodexWorker passes max effort through to turn/start", async () => {
  const turnStarts: any[] = []
  const { worker } = makeServedWorker(
    (_req, reply) => {
      reply({ jsonrpc: "2.0", method: "item/completed", params: { threadId: "thread-1", item: { type: "agentMessage", text: "done" } } })
      reply({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "thread-1", turn: { status: "completed" } } })
    },
    {
      onServerReq: (_child, req) => {
        if (req.method === "turn/start") turnStarts.push(req.params)
      },
    },
  )

  await worker.runAgent(spec({ effort: "max" }), ctx())
  assert.equal(turnStarts.length, 1)
  assert.equal(turnStarts[0].effort, "max")
  await worker.shutdown()
})

test("CodexWorker maps web search to thread config and network access to the turn sandbox", async () => {
  const threadStarts: any[] = []
  const turnStarts: any[] = []
  const { worker } = makeServedWorker(
    (_req, reply) => {
      reply({ jsonrpc: "2.0", method: "item/completed", params: { threadId: "thread-1", item: { type: "agentMessage", text: "done" } } })
      reply({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "thread-1", turn: { status: "completed" } } })
    },
    {
      onServerReq: (_child, req) => {
        if (req.method === "thread/start") threadStarts.push(req.params)
        if (req.method === "turn/start") turnStarts.push(req.params)
      },
    },
  )
  await worker.runAgent(spec({ codexWebSearch: "live", codexNetworkAccess: true }), ctx())
  assert.deepEqual(threadStarts[0].config, { "features.context_management": false, web_search: "live" })
  assert.equal(turnStarts[0].sandboxPolicy.networkAccess, true)
  assert.deepEqual(turnStarts[0].sandboxPolicy, { type: "readOnly", networkAccess: true })
  await worker.shutdown()
})

/** A `codex plugin list` entry for a local plugin whose root holds `manifest` and any extra files. */
async function localPlugin(pluginId: string, manifest: unknown, files: Record<string, string> = {}) {
  const root = await mkdtemp(join(tmpdir(), "codex-plugin-"))
  await mkdir(join(root, ".codex-plugin"))
  await writeFile(join(root, ".codex-plugin", "plugin.json"), JSON.stringify(manifest))
  for (const [name, contents] of Object.entries(files)) {
    await mkdir(dirname(join(root, name)), { recursive: true })
    await writeFile(join(root, name), contents)
  }
  return { pluginId, source: { source: "local", path: root } }
}

function toolWorker(threadStarts: any[], over: Parameters<typeof makeServedWorker>[1] = {}) {
  return makeServedWorker(
    (_req, reply) => {
      reply({ jsonrpc: "2.0", method: "item/completed", params: { threadId: "thread-1", item: { type: "agentMessage", text: "done" } } })
      reply({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "thread-1", turn: { status: "completed" } } })
    },
    {
      readMcpInventory: async () => JSON.stringify([
        mcpInventoryEntry("btca"),
        mcpInventoryEntry("paos-recall-mcp"),
        mcpInventoryEntry("node_repl"),
        mcpInventoryEntry("dotted.server"),
        mcpInventoryEntry("executor", { type: "streamable_http" }),
      ]),
      readPluginInventory: async () => [
        JSON.stringify({ installed: [
          await localPlugin("computer-use@openai-bundled", { name: "computer-use", skills: "./skills/" }),
          await localPlugin("computer-history@openai-bundled", { name: "computer-history", skills: "./skills/", mcpServers: "./.mcp.json" }),
          await localPlugin("messages@openai-bundled", { name: "messages", mcpServers: "./.mcp.json" }),
        ] }),
        JSON.stringify({ installed: [
          await localPlugin("build-ios-apps@openai-curated", { name: "build-ios-apps", skills: "./skills/", mcpServers: "./.mcp.json" }),
        ] }),
      ],
      onServerReq: (_child, req) => {
        if (req.method === "thread/start") threadStarts.push(req.params)
      },
      ...over,
    },
  )
}

test("per-agent Codex tool opt-ins become leaf thread/start overrides for that thread only", async () => {
  const threadStarts: any[] = []
  const { worker } = toolWorker(threadStarts)
  await worker.runAgent(spec({ codexMcpServers: ["paos-recall-mcp", "executor"] }), ctx())
  await worker.runAgent(spec({ codexPlugins: ["computer-history@openai-bundled"] }), ctx())
  await worker.runAgent(spec({ codexPlugins: ["computer-use@openai-bundled"] }), ctx())
  await worker.runAgent(spec({ codexPlugins: ["build-ios-apps@openai-curated"] }), ctx())
  await worker.runAgent(spec(), ctx())
  assert.deepEqual(threadStarts.map((start) => start.config), [
    {
      "features.context_management": false,
      mcp_optional_startup_grace_ms: 0,
      "mcp_servers.paos-recall-mcp.enabled": true,
      "mcp_servers.executor.enabled": true,
    },
    {
      "features.context_management": false,
      mcp_optional_startup_grace_ms: 0,
      "features.plugins": true,
      "plugins.computer-use@openai-bundled.enabled": false,
      "plugins.computer-history@openai-bundled.enabled": true,
      "plugins.messages@openai-bundled.enabled": false,
      "plugins.build-ios-apps@openai-curated.enabled": false,
    },
    {
      "features.context_management": false,
      mcp_optional_startup_grace_ms: 0,
      "features.plugins": true,
      "plugins.computer-use@openai-bundled.enabled": true,
      "plugins.computer-history@openai-bundled.enabled": false,
      "plugins.messages@openai-bundled.enabled": false,
      "plugins.build-ios-apps@openai-curated.enabled": false,
      "features.computer_use": true,
      "mcp_servers.node_repl.enabled": true,
    },
    {
      "features.context_management": false,
      mcp_optional_startup_grace_ms: 0,
      "features.plugins": true,
      "plugins.computer-use@openai-bundled.enabled": false,
      "plugins.computer-history@openai-bundled.enabled": false,
      "plugins.messages@openai-bundled.enabled": false,
      "plugins.build-ios-apps@openai-curated.enabled": true,
    },
    { "features.context_management": false },
  ])
  // A parent table would replace the launch-time mcp_servers table instead of merging into it.
  for (const start of threadStarts) assert.ok(!("mcp_servers" in start.config) && !("plugins" in start.config))
  await worker.shutdown()
})

test("project-only MCP servers are disabled or selected per cwd, with one inventory read per cwd", async () => {
  const starts: any[] = []
  const reads: string[] = []
  const host = JSON.stringify([mcpInventoryEntry("host")])
  const project = JSON.stringify([mcpInventoryEntry("host"), mcpInventoryEntry("project_only")])
  const { worker } = toolWorker(starts, {
    readMcpInventory: async (_bin, cwd) => {
      reads.push(cwd)
      return cwd === "/project" ? project : host
    },
  })
  await worker.runAgent(spec({ cwd: "/project" }), ctx())
  await worker.runAgent(spec({ cwd: "/project", codexMcpServers: ["project_only"] }), ctx())
  await worker.runAgent(spec({ cwd: "/other" }), ctx())
  assert.deepEqual(starts.map((start) => start.config["mcp_servers.project_only.enabled"]), [false, true, undefined])
  assert.deepEqual(reads, [tmpdir(), "/project", "/other"])
  assert.ok(!configValues((worker as any).appServerArgs).some((value) => value.includes("project_only")))
  await worker.shutdown()
})

test("a dotted project-only MCP name fails before thread/start, including on a lean thread", async () => {
  const starts: any[] = []
  const { worker } = toolWorker(starts, {
    readMcpInventory: async (_bin, cwd) => JSON.stringify(cwd === "/project" ? [mcpInventoryEntry("dotted.project")] : []),
  })
  await assert.rejects(worker.runAgent(spec({ cwd: "/project" }), ctx()), /project MCP server "dotted.project" contains "\."/)
  assert.equal(starts.length, 0)
  await worker.shutdown()
})

test("an execution profile disables project-only MCP servers outside its allowlist", async () => {
  const starts: any[] = []
  const { worker } = toolWorker(starts, {
    executionProfile: "workflow-plan-v1",
    readMcpInventory: async (_bin, cwd) => JSON.stringify(cwd === "/project" ? [mcpInventoryEntry("project_only")] : []),
    readFeatureInventory: async () => PROFILE_FEATURE_ARGS["workflow-plan-v1"]
      .map((override) => `${override.slice("features.".length).split("=")[0]} stable true`).join("\n"),
  })
  await worker.runAgent(spec({ cwd: "/project" }), ctx())
  assert.equal(starts[0].config["mcp_servers.project_only.enabled"], false)
  await worker.shutdown()
})

test("lean Codex agent sends no optional MCP startup grace override", async () => {
  const threadStarts: any[] = []
  const { worker } = toolWorker(threadStarts)
  await worker.runAgent(spec(), ctx())
  assert.equal(threadStarts.length, 1)
  assert.ok(!Object.hasOwn(threadStarts[0].config, "mcp_optional_startup_grace_ms"))
  await worker.shutdown()
})

test("unknown or unaddressable Codex tool names fail before thread/start", async () => {
  const threadStarts: any[] = []
  const { worker } = toolWorker(threadStarts)
  for (const [over, code, message] of [
    [{ codexMcpServers: ["btca", "missing"] }, "unknown_mcp_server", /codexMcpServers names MCP server "missing", which is not in the Codex MCP inventory for \/tmp\/work/],
    [{ codexPlugins: ["build-ios-apps@openai-curated-remote"] }, "unknown_plugin", /codexPlugins names "build-ios-apps@openai-curated-remote", which is not an installed Codex plugin/],
    [{ codexPlugins: ["build-web-apps@openai-curated"] }, "unknown_plugin", /codexPlugins names "build-web-apps@openai-curated"/],
    [{ codexMcpServers: ["dotted.server"] }, "unsupported_option", /"dotted.server" contains "\." and cannot be addressed by a per-thread override/],
  ] as const) {
    await assert.rejects(
      worker.runAgent(spec(over), ctx()),
      (error: unknown) => error instanceof AgentError && error.code === code && error.retryable === false && message.test(error.message),
    )
  }
  assert.equal(threadStarts.length, 0)
  await worker.shutdown()
})

test("plugins that need the app or remote-plugin gate, or have no readable manifest, fail before thread/start", async () => {
  const threadStarts: any[] = []
  const apps = JSON.stringify({ apps: { vercel: { id: "connector_vercel" } } })
  const noManifest = await localPlugin("broken@local", {})
  const { worker } = toolWorker(threadStarts, {
    readPluginInventory: async () => [JSON.stringify({ installed: [
      await localPlugin("vercel@openai-curated", { name: "vercel", skills: "./skills/", apps: "./.app.json" }, { ".app.json": apps }),
      // Codex reads a root .app.json when the manifest names no apps file.
      await localPlugin("convex@openai-curated", { name: "convex" }, { ".app.json": apps }),
      await localPlugin("linear@openai-curated", { name: "linear", mcpServers: "./.mcp.json", apps: "./.app.json" }),
      { pluginId: "github@openai-curated-remote", source: { source: "remote", id: "plugin_connector_1p_github" } },
      { ...noManifest, source: { source: "local", path: join(noManifest.source.path, "missing") } },
      { pluginId: "pathless@local", source: { source: "local" } },
    ] })],
  })
  for (const [id, code, message] of [
    ["vercel@openai-curated", "unsupported_plugin", /codexPlugins names "vercel@openai-curated", whose manifest declares apps; a lean thread cannot enable features\.apps for one plugin/],
    ["convex@openai-curated", "unsupported_plugin", /"convex@openai-curated", whose manifest declares apps/],
    ["linear@openai-curated", "unsupported_plugin", /"linear@openai-curated", whose manifest declares apps/],
    ["github@openai-curated-remote", "unsupported_plugin", /"github@openai-curated-remote", a remote plugin; a lean thread cannot enable features\.remote_plugin/],
    ["broken@local", "plugin_inventory_failed", /cannot read the manifest or hooks of Codex plugin "broken@local": .*ENOENT/],
    ["pathless@local", "plugin_inventory_failed", /gives no local source path for "pathless@local"/],
  ] as const) {
    await assert.rejects(
      worker.runAgent(spec({ codexPlugins: [id] }), ctx()),
      (error: unknown) => error instanceof AgentError && error.code === code && error.retryable === false && message.test(error.message),
    )
  }
  assert.equal(threadStarts.length, 0)
  await worker.shutdown()
})

/** A hooks file whose events call each server through an `mcp_tool` handler, beside a command hook. */
function mcpToolHooks(...servers: string[]) {
  return {
    hooks: {
      Stop: servers.map((server) => ({ hooks: [{ type: "mcp_tool", server, tool: "turn_ended" }] })),
      SessionStart: [{ hooks: [{ type: "command", command: "echo ready" }] }],
    },
  }
}

test("MCP servers a selected plugin's hooks call are enabled for that thread only", async () => {
  const threadStarts: any[] = []
  const { worker } = toolWorker(threadStarts, {
    readPluginInventory: async () => [JSON.stringify({ installed: [
      await localPlugin("browser@openai-bundled", { name: "browser", hooks: mcpToolHooks("node_repl") }),
      await localPlugin("filed@local", { name: "filed", hooks: "./hooks.json" }, { "hooks.json": JSON.stringify(mcpToolHooks("btca")) }),
      await localPlugin("several@local", { name: "several", hooks: ["./a.json", mcpToolHooks("paos-recall-mcp")] }, { "a.json": JSON.stringify(mcpToolHooks("btca", "node_repl")) }),
      // Codex reads hooks/hooks.json when the manifest names no hooks.
      await localPlugin("defaulted@local", { name: "defaulted" }, { "hooks/hooks.json": JSON.stringify(mcpToolHooks("executor")) }),
      await localPlugin("commands@local", { name: "commands", hooks: { hooks: { Stop: [{ hooks: [{ type: "command", command: "true" }] }] } } }),
    ] })],
  })
  const servers = async (plugins: string[]) => {
    await worker.runAgent(spec({ codexPlugins: plugins }), ctx())
    const config = threadStarts.at(-1).config
    return Object.keys(config).filter((key) => key.startsWith("mcp_servers.") && config[key] === true)
  }
  assert.deepEqual(await servers(["browser@openai-bundled"]), ["mcp_servers.node_repl.enabled"])
  assert.deepEqual(await servers(["filed@local"]), ["mcp_servers.btca.enabled"])
  assert.deepEqual(await servers(["several@local"]), ["mcp_servers.btca.enabled", "mcp_servers.node_repl.enabled", "mcp_servers.paos-recall-mcp.enabled"])
  assert.deepEqual(await servers(["defaulted@local"]), ["mcp_servers.executor.enabled"])
  assert.deepEqual(await servers(["commands@local"]), [])
  await worker.runAgent(spec(), ctx())
  assert.deepEqual(threadStarts.at(-1).config, { "features.context_management": false })
  await worker.shutdown()
})

test("a plugin hook server missing from the host, or an unreadable hooks file, fails before thread/start", async () => {
  const threadStarts: any[] = []
  const { worker } = toolWorker(threadStarts, {
    readPluginInventory: async () => [JSON.stringify({ installed: [
      await localPlugin("absent-server@local", { name: "absent-server", hooks: mcpToolHooks("node_repl", "ghost") }),
      await localPlugin("missing-file@local", { name: "missing-file", hooks: "./hooks.json" }),
      await localPlugin("bad-file@local", { name: "bad-file" }, { "hooks/hooks.json": "{" }),
    ] })],
  })
  for (const [id, code, message] of [
    ["absent-server@local", "unknown_mcp_server", /codexPlugins entry "absent-server@local" requires MCP server "ghost", which is not in the Codex MCP inventory for \/tmp\/work/],
    ["missing-file@local", "plugin_inventory_failed", /cannot read the manifest or hooks of Codex plugin "missing-file@local": .*ENOENT.*hooks\.json/],
    ["bad-file@local", "plugin_inventory_failed", /"bad-file@local": .*hooks\.json is not valid JSON/],
  ] as const) {
    await assert.rejects(
      worker.runAgent(spec({ codexPlugins: [id] }), ctx()),
      (error: unknown) => error instanceof AgentError && error.code === code && error.retryable === false && message.test(error.message),
    )
  }
  assert.equal(threadStarts.length, 0)
  await worker.shutdown()
})

test("a fresh app-server gets the service tier at launch, not on thread/start", async () => {
  const freshStarts: any[] = []
  const fresh = toolWorker(freshStarts, { serviceTier: "flex" })
  await fresh.worker.runAgent(spec(), ctx())
  assert.deepEqual(configValues((fresh.worker as any).appServerArgs).slice(0, 2), ["thread_unload_delay_secs=0", "service_tier=flex"])
  assert.ok(!("serviceTier" in freshStarts[0]))
  await fresh.worker.shutdown()
})

test("a plugin inventory failure is non-retryable and happens before thread/start", async () => {
  const threadStarts: any[] = []
  const { worker } = toolWorker(threadStarts, {
    readPluginInventory: async () => [JSON.stringify({ installed: [] }), "{"],
  })
  await assert.rejects(
    worker.runAgent(spec({ codexPlugins: ["build-ios-apps@openai-curated"] }), ctx()),
    (error: unknown) => error instanceof AgentError && error.code === "plugin_inventory_failed" && error.retryable === false && /invalid JSON/.test(error.message),
  )
  assert.equal(threadStarts.length, 0)
  await worker.shutdown()
})

test("execution profiles reject plugins and non-allowlisted MCP opt-ins before launch", async () => {
  let spawned = false
  const worker = new CodexWorker({
    executionProfile: "workflow-research-v1",
    readMcpInventory: async () => { throw new Error("inventory must not be read") },
    spawnChild: () => {
      spawned = true
      throw new Error("must not spawn")
    },
  })
  await assert.rejects(worker.runAgent(spec({ codexPlugins: ["computer-use@openai-bundled"] }), ctx()), /codexPlugins cannot be used with Codex execution profile workflow-research-v1/)
  await assert.rejects(worker.runAgent(spec({ codexMcpServers: ["executor"] }), ctx()), /does not allow codexMcpServers "executor"/)
  assert.equal(spawned, false)
})

test("CodexWorker proves the exact listed child role and deletes the temporary durable subtree", async () => {
  const threadStarts: any[] = []
  const listRequests: any[] = []
  const readRequests: any[] = []
  const deleteRequests: any[] = []
  const { worker } = makeServedWorker(
    (_req, reply) => {
      reply({ jsonrpc: "2.0", method: "item/completed", params: { threadId: "thread-1", item: { type: "agentMessage", text: "done" } } })
      reply({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "thread-1", turn: { status: "completed" } } })
    },
    {
      threadListResult: {
        data: [{ id: "child-1", parentThreadId: "thread-1", agentRole: "librarian" }],
        nextCursor: null,
        backwardsCursor: null,
      },
      threadReadResult: {
        thread: {
          id: "child-1",
          parentThreadId: "thread-1",
          agentRole: "librarian",
          turns: [{ status: "completed" }],
        },
      },
      onServerReq: (_child, req) => {
        if (req.method === "thread/start") threadStarts.push(req.params)
        if (req.method === "thread/list") listRequests.push(req.params)
        if (req.method === "thread/read") readRequests.push(req.params)
        if (req.method === "thread/delete") deleteRequests.push(req.params)
      },
    },
  )
  const result = await worker.runAgent(spec({ codexChildRole: "librarian" }), ctx())
  assert.equal(result.text, "done")
  assert.equal(threadStarts[0].ephemeral, false)
  assert.deepEqual(listRequests, [{ parentThreadId: "thread-1", limit: 100 }])
  assert.deepEqual(readRequests, [{ threadId: "child-1", includeTurns: true }])
  assert.deepEqual(deleteRequests, [{ threadId: "thread-1" }])
  await worker.shutdown()
})

for (const scenario of ["absent", "failed", "in-progress", "mismatched-role", "unrelated-child"] as const) {
  test(`CodexWorker rejects ${scenario} child-role evidence`, async () => {
    const { worker } = makeServedWorker(
      (_req, reply) => {
        reply({ jsonrpc: "2.0", method: "item/completed", params: { threadId: "thread-1", item: { type: "agentMessage", text: "claimed success" } } })
        reply({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "thread-1", turn: { status: "completed" } } })
      },
      {
        threadListResult: {
          data: scenario === "absent"
            ? []
            : [{ id: "child-1", parentThreadId: "thread-1", agentRole: "librarian" }],
          nextCursor: null,
          backwardsCursor: null,
        },
        threadReadResult: {
          thread: {
            id: "child-1",
            parentThreadId: scenario === "unrelated-child" ? "other-root" : "thread-1",
            agentRole: scenario === "mismatched-role" ? "explorer" : "librarian",
            turns: [{
              status: scenario === "failed" ? "failed" : scenario === "in-progress" ? "inProgress" : "completed",
            }],
          },
        },
      },
    )
    await assert.rejects(
      worker.runAgent(spec({ codexChildRole: "librarian" }), ctx()),
      (error: unknown) => error instanceof AgentError && error.code === "child_role_unproven" && error.retryable === false,
    )
    await worker.shutdown()
  })
}

test("concurrent root turns cannot cross-correlate child-role evidence", async () => {
  let child!: FakeChild
  let nextThread = 0
  const pendingRoots: string[] = []
  const worker = new CodexWorker({
    ...HERMETIC_INVENTORY,
    spawnChild: () => {
      child = new FakeChild()
      child.onWrite = (req: any) => {
        if (req.method === "initialize") return child.pushLine({ jsonrpc: "2.0", id: req.id, result: INIT_OK })
        if (req.method === "thread/start") {
          const id = `root-${++nextThread}`
          return child.pushLine({ jsonrpc: "2.0", id: req.id, result: { thread: { id } } })
        }
        if (req.method === "turn/start") {
          child.pushLine({ jsonrpc: "2.0", id: req.id, result: {} })
          pendingRoots.push(req.params.threadId)
          if (pendingRoots.length !== 2) return
          const [rootOne, rootTwo] = pendingRoots
          // The matching-role child belongs to root two. Exact per-root metadata must prevent root
          // one from accepting it even if the provider returns it in root one's filtered list.
          for (const root of [rootOne, rootTwo]) {
            child.pushLine({ jsonrpc: "2.0", method: "item/completed", params: { threadId: root, item: { type: "agentMessage", text: "done" } } })
            child.pushLine({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: root, turn: { status: "completed" } } })
          }
        }
        if (req.method === "thread/list") child.pushLine({
          jsonrpc: "2.0",
          id: req.id,
          result: {
            data: req.params.parentThreadId === "root-1"
              ? [{ id: "child-cross", parentThreadId: "root-2", agentRole: "librarian" }]
              : [],
            nextCursor: null,
            backwardsCursor: null,
          },
        })
        if (req.method === "thread/delete") child.pushLine({ jsonrpc: "2.0", id: req.id, result: {} })
      }
      return child as any
    },
  })
  const results = await Promise.allSettled([
    worker.runAgent(spec({ codexChildRole: "librarian" }), ctx()),
    worker.runAgent(spec({ codexChildRole: "librarian" }), ctx()),
  ])
  assert.ok(results.every((result) => result.status === "rejected" && result.reason instanceof AgentError && result.reason.code === "child_role_unproven"))
  await worker.shutdown()
})

test("CodexWorker starts Codex provider threads as ephemeral by default", async () => {
  const threadStarts: any[] = []
  const unsubscribeRequests: any[] = []
  const { worker } = makeServedWorker(
    (_req, reply) => {
      reply({ jsonrpc: "2.0", method: "item/completed", params: { threadId: "thread-1", item: { type: "agentMessage", text: "done" } } })
      reply({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "thread-1", turn: { status: "completed" } } })
    },
    {
      onServerReq: (_child, req) => {
        if (req.method === "thread/start") threadStarts.push(req.params)
        if (req.method === "thread/unsubscribe") unsubscribeRequests.push(req.params)
      },
    },
  )

  assert.equal(DEFAULT_THREAD_EPHEMERAL, true)
  await worker.runAgent(spec(), ctx())
  assert.equal(threadStarts.length, 1)
  assert.equal(threadStarts[0].ephemeral, true)
  assert.deepEqual(unsubscribeRequests, [{ threadId: "thread-1" }])
  // Every unit pins classic compaction regardless of the host's context_management flag.
  assert.deepEqual(threadStarts[0].config, { "features.context_management": false })
  await worker.shutdown()
})

test("CodexWorker reports an ephemeral thread release error without failing its agent", async () => {
  const context = ctx()
  const { worker } = makeServedWorker(
    (_req, reply) => {
      reply({ jsonrpc: "2.0", method: "item/completed", params: { threadId: "thread-1", item: { type: "agentMessage", text: "done" } } })
      reply({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "thread-1", turn: { status: "completed" } } })
    },
    { onServerReq: (child, req) => { if (req.method === "thread/unsubscribe") child.failUnsubscribe = true } },
  )
  assert.equal((await worker.runAgent(spec(), context)).text, "done")
  assert.ok(context.events.some((event) => event.kind === "tool-result" && event.name === "codex-thread-cleanup" && event.isError))
  await worker.shutdown()
})

test("CodexWorker bounds release when unsubscribe never responds", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const context = ctx()
  const { worker } = makeServedWorker(
    (_req, reply) => {
      reply({ jsonrpc: "2.0", method: "item/completed", params: { threadId: "thread-1", item: { type: "agentMessage", text: "done" } } })
      reply({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "thread-1", turn: { status: "completed" } } })
    },
    {
      requestTimeoutMs: 0,
      onServerReq: (child, req) => { if (req.method === "thread/unsubscribe") child.holdUnsubscribe = true },
    },
  )
  try {
    const result = worker.runAgent(spec(), context)
    await tick()
    t.mock.timers.tick(15_000)
    const settled = await Promise.race([
      result.then((value) => value.text),
      new Promise<string>((resolve) => setImmediate(() => resolve("still waiting"))),
    ])
    assert.equal(settled, "done")
    assert.ok(context.events.some((event) => event.kind === "tool-result"
      && event.name === "codex-thread-cleanup"
      && event.isError
      && event.output?.includes("timed out waiting for thread/closed")))
  } finally {
    await worker.shutdown()
  }
})

test("CodexWorker can explicitly disable ephemeral thread/start for debugging", async () => {
  const threadStarts: any[] = []
  const { worker } = makeServedWorker(
    (_req, reply) => {
      reply({ jsonrpc: "2.0", method: "item/completed", params: { threadId: "thread-1", item: { type: "agentMessage", text: "done" } } })
      reply({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "thread-1", turn: { status: "completed" } } })
    },
    {
      threadEphemeral: false,
      onServerReq: (_child, req) => {
        if (req.method === "thread/start") threadStarts.push(req.params)
      },
    },
  )

  await worker.runAgent(spec(), ctx())
  assert.equal(threadStarts.length, 1)
  assert.equal(threadStarts[0].ephemeral, false)
  await worker.shutdown()
})

test("CodexWorker gates thread/start without reducing concurrent model turns", async () => {
  let child!: FakeChild
  let activeStarts = 0
  let maxActiveStarts = 0
  const worker = new CodexWorker({
    ...HERMETIC_INVENTORY,
    threadStartConcurrency: 2,
    spawnChild: () => {
      child = new FakeChild()
      child.onWrite = (req: any) => {
        if (req.method === "initialize") return child.pushLine({ jsonrpc: "2.0", id: req.id, result: INIT_OK })
        if (req.method === "thread/start") {
          activeStarts++
          maxActiveStarts = Math.max(maxActiveStarts, activeStarts)
          setTimeout(() => {
            activeStarts--
            child.pushLine({ jsonrpc: "2.0", id: req.id, result: { thread: { id: `t-${req.id}` } } })
          }, 10)
          return
        }
        if (req.method === "turn/start") {
          const threadId = req.params.threadId
          child.pushLine({ jsonrpc: "2.0", id: req.id, result: {} })
          child.pushLine({ jsonrpc: "2.0", method: "item/completed", params: { threadId, item: { type: "agentMessage", text: "done" } } })
          child.pushLine({ jsonrpc: "2.0", method: "turn/completed", params: { threadId, turn: { status: "completed" } } })
        }
      }
      return child as any
    },
  })

  assert.equal(DEFAULT_THREAD_START_CONCURRENCY, 16)
  await Promise.all(Array.from({ length: 6 }, () => worker.runAgent(spec(), ctx())))
  assert.equal(maxActiveStarts, 2)
  await worker.shutdown()
})

test("CodexWorker does not retry an ambiguously timed-out thread/start", async () => {
  const worker = new CodexWorker({
    ...HERMETIC_INVENTORY,
    requestTimeoutMs: 10,
    spawnChild: () => {
      const child = new FakeChild()
      child.onWrite = (req: any) => {
        if (req.method === "initialize") child.pushLine({ jsonrpc: "2.0", id: req.id, result: INIT_OK })
      }
      return child as any
    },
  })

  await assert.rejects(
    worker.runAgent(spec(), ctx()),
    (error) => error instanceof AgentError && error.code === "thread_start_unknown" && error.retryable === false,
  )
  await worker.shutdown()
})

test("CodexWorker classifies app-server ingress overload as retryable", async () => {
  const worker = new CodexWorker({
    ...HERMETIC_INVENTORY,
    spawnChild: () => {
      const child = new FakeChild()
      child.onWrite = (req: any) => {
        if (req.method === "initialize") child.pushLine({ jsonrpc: "2.0", id: req.id, result: INIT_OK })
        if (req.method === "thread/start") {
          child.pushLine({ jsonrpc: "2.0", id: req.id, error: { code: -32001, message: "Server overloaded; retry later." } })
        }
      }
      return child as any
    },
  })

  await assert.rejects(
    worker.runAgent(spec(), ctx()),
    (error) => error instanceof AgentError && error.code === "server_overloaded" && error.retryable === true,
  )
  await worker.shutdown()
})

// ===========================================================================
// H5 — schema two-turn usage. Verified semantics (codex-rs TokenUsageInfo):
// `last` = the last model REQUEST (one of many per tool-using turn);
// `total` = THREAD-cumulative (total += last on every request).
// The agent's true usage is therefore the extraction turn's final `total`.
// ===========================================================================

test("H5: schema agent reports the extraction turn's cumulative total exactly once", async () => {
  // Working turn makes TWO model requests (tool round + final message):
  //   request 1: last={in:60,out:10}  total={in:60,out:10}
  //   request 2: last={in:40,out:10}  total={in:100,out:20}
  // Extraction turn (same thread), one request:
  //   request 3: last={in:30,out:5}   total={in:130,out:25}
  // Correct usage = 130 in / 25 out.
  //   summing per-turn `total` (original bug)  → 230 in / 45 out (double-count)
  //   summing per-turn final `last`            →  70 in / 15 out (undercount)
  const { worker } = makeServedWorker((_req, reply, idx) => {
    if (idx === 0) {
      reply({
        jsonrpc: "2.0",
        method: "thread/tokenUsage/updated",
        params: { threadId: "thread-1", tokenUsage: { total: { inputTokens: 60, outputTokens: 10 }, last: { inputTokens: 60, outputTokens: 10 } } },
      })
      reply({ jsonrpc: "2.0", method: "item/completed", params: { threadId: "thread-1", item: { type: "agentMessage", text: "working" } } })
      reply({
        jsonrpc: "2.0",
        method: "thread/tokenUsage/updated",
        params: { threadId: "thread-1", tokenUsage: { total: { inputTokens: 100, outputTokens: 20 }, last: { inputTokens: 40, outputTokens: 10 } } },
      })
      reply({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "thread-1", turn: { status: "completed" } } })
    } else {
      reply({ jsonrpc: "2.0", method: "item/completed", params: { threadId: "thread-1", item: { type: "agentMessage", text: '{"answer": 42}' } } })
      reply({
        jsonrpc: "2.0",
        method: "thread/tokenUsage/updated",
        params: { threadId: "thread-1", tokenUsage: { total: { inputTokens: 130, outputTokens: 25 }, last: { inputTokens: 30, outputTokens: 5 } } },
      })
      reply({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "thread-1", turn: { status: "completed" } } })
    }
  })
  const res = await worker.runAgent(spec({ schema: { type: "object", properties: { answer: { type: "number" } }, required: ["answer"] } }), ctx())
  assert.deepEqual(res.structured, { answer: 42 })
  assert.equal(res.usage.inputTokens, 130, "input must not double-count the working turn nor drop earlier requests")
  assert.equal(res.usage.outputTokens, 25)
  await worker.shutdown()
})

test("H5: working-turn usage survives an extraction turn that emits no tokenUsage update", async () => {
  const { worker } = makeServedWorker((_req, reply, idx) => {
    if (idx === 0) {
      reply({
        jsonrpc: "2.0",
        method: "thread/tokenUsage/updated",
        params: { threadId: "thread-1", tokenUsage: { total: { inputTokens: 100, outputTokens: 20 }, last: { inputTokens: 100, outputTokens: 20 } } },
      })
      reply({ jsonrpc: "2.0", method: "item/completed", params: { threadId: "thread-1", item: { type: "agentMessage", text: "working" } } })
      reply({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "thread-1", turn: { status: "completed" } } })
    } else {
      reply({ jsonrpc: "2.0", method: "item/completed", params: { threadId: "thread-1", item: { type: "agentMessage", text: '{"answer": 1}' } } })
      // no tokenUsage update at all
      reply({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "thread-1", turn: { status: "completed" } } })
    }
  })
  const res = await worker.runAgent(spec({ schema: { type: "object", properties: { answer: { type: "number" } }, required: ["answer"] } }), ctx())
  assert.equal(res.usage.inputTokens, 100, "seeded working-turn usage must not be dropped")
  assert.equal(res.usage.outputTokens, 20)
  await worker.shutdown()
})

test("H5: non-schema single turn reports its final cumulative total (multi-request turn)", async () => {
  const { worker } = makeServedWorker((_req, reply) => {
    reply({
      jsonrpc: "2.0",
      method: "thread/tokenUsage/updated",
      params: { threadId: "thread-1", tokenUsage: { total: { inputTokens: 10, outputTokens: 2 }, last: { inputTokens: 10, outputTokens: 2 } } },
    })
    reply({
      jsonrpc: "2.0",
      method: "thread/tokenUsage/updated",
      params: { threadId: "thread-1", tokenUsage: { total: { inputTokens: 35, outputTokens: 9 }, last: { inputTokens: 25, outputTokens: 7 } } },
    })
    reply({ jsonrpc: "2.0", method: "item/completed", params: { threadId: "thread-1", item: { type: "agentMessage", text: "ok" } } })
    reply({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "thread-1", turn: { status: "completed" } } })
  })
  const res = await worker.runAgent(spec(), ctx())
  assert.equal(res.usage.inputTokens, 35)
  assert.equal(res.usage.outputTokens, 9)
  await worker.shutdown()
})

// ===========================================================================
// H2 — error notification settles the turn
// ===========================================================================

test("H2: an `error` notification (no turn/completed) rejects the turn", async () => {
  const { worker } = makeServedWorker((_req, reply) => {
    reply({ jsonrpc: "2.0", method: "error", params: { threadId: "thread-1", message: "model exploded" } })
    // deliberately NO turn/completed
  })
  await assert.rejects(worker.runAgent(spec(), ctx()), (e) => e instanceof AgentError && /model exploded/.test(e.message) && e.retryable === true)
  await worker.shutdown()
})

test("a usage-limit `error` notification is terminal and non-retryable", async () => {
  const { worker } = makeServedWorker((_req, reply) => {
    reply({
      jsonrpc: "2.0",
      method: "error",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        willRetry: false,
        error: {
          message: "You've hit your usage limit.",
          codexErrorInfo: "usageLimitExceeded",
          additionalDetails: null,
        },
      },
    })
  })
  await assert.rejects(
    worker.runAgent(spec(), ctx()),
    (e) => e instanceof AgentError && e.code === "usageLimitExceeded" && e.retryable === false,
  )
  await worker.shutdown()
})

test("a transient `error` notification with willRetry keeps the turn alive", async () => {
  const { worker } = makeServedWorker((_req, reply) => {
    reply({
      jsonrpc: "2.0",
      method: "error",
      params: { threadId: "thread-1", turnId: "turn-1", willRetry: true, error: { message: "Reconnecting... 1/5" } },
    })
    reply({ jsonrpc: "2.0", method: "item/completed", params: { threadId: "thread-1", item: { type: "agentMessage", text: "recovered" } } })
    reply({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "thread-1", turn: { status: "completed" } } })
  })
  const result = await worker.runAgent(spec(), ctx())
  assert.equal(result.text, "recovered")
  await worker.shutdown()
})

test("a malformed willRetry notification without correlation fails the live turn", async () => {
  const { worker } = makeServedWorker((_req, reply) => {
    reply({ jsonrpc: "2.0", method: "error", params: { willRetry: true, error: { message: "uncorrelated retry" } } })
  })
  await assert.rejects(worker.runAgent(spec(), ctx()), (e) => e instanceof AgentError && /uncorrelated retry/.test(e.message))
  await worker.shutdown()
})

test("H2: error notification without threadId settles all live turns", async () => {
  const { worker } = makeServedWorker((_req, reply) => {
    reply({ jsonrpc: "2.0", method: "error", params: { message: "global failure" } })
  })
  await assert.rejects(worker.runAgent(spec(), ctx()), (e) => e instanceof AgentError && /global failure/.test(e.message))
  await worker.shutdown()
})

// ===========================================================================
// H1 (worker level) — process death mid-turn rejects, does not hang
// ===========================================================================

test("H1: child crash mid-turn rejects runAgent (no hang)", async () => {
  let theChild!: FakeChild
  const worker = new CodexWorker({
    ...HERMETIC_INVENTORY,
    spawnChild: () => {
      theChild = new FakeChild()
      theChild.onWrite = (req: any) => {
        if (req.method === "initialize") return theChild.pushLine({ jsonrpc: "2.0", id: req.id, result: INIT_OK })
        if (req.method === "thread/start") return theChild.pushLine({ jsonrpc: "2.0", id: req.id, result: { thread: { id: "t" } } })
        if (req.method === "turn/start") {
          theChild.pushLine({ jsonrpc: "2.0", id: req.id, result: {} })
          // crash instead of completing the turn
          queueMicrotask(() => theChild.emitExit(139, "SIGSEGV"))
        }
      }
      return theChild as any
    },
  })
  await assert.rejects(worker.runAgent(spec(), ctx()), (e) => e instanceof AgentError && e.code === "process_exited")
  await worker.shutdown()
})

test("an app-server that exits with \"not found\" on stderr stays a retryable process_exited", async () => {
  let theChild!: FakeChild
  const worker = new CodexWorker({
    ...HERMETIC_INVENTORY,
    spawnChild: () => {
      theChild = new FakeChild()
      theChild.onWrite = (req: any) => {
        if (req.method === "initialize") return theChild.pushLine({ jsonrpc: "2.0", id: req.id, result: INIT_OK })
        if (req.method === "thread/start") {
          theChild.stderr.emit("data", "Error: model not found\n")
          queueMicrotask(() => theChild.emitExit(1, null))
        }
      }
      return theChild as any
    },
  })
  await assert.rejects(
    worker.runAgent(spec(), ctx()),
    (e) => e instanceof AgentError && e.code === "process_exited" && e.retryable === true && /model not found/.test(e.message),
  )
  await worker.shutdown()
})

test("M1: after a crash with a stale partial frame, the worker recovers on the next runAgent", async () => {
  // Old bug: stdoutBuf was a worker field surviving process death, so the
  // restarted handshake parsed a corrupted first frame and initialize never
  // resolved. Now framing state dies with its transport.
  let spawnCount = 0
  const worker = new CodexWorker({
    ...HERMETIC_INVENTORY,
    spawnChild: () => {
      const child = new FakeChild()
      const isFirst = spawnCount++ === 0
      child.onWrite = (req: any) => {
        if (req.method === "initialize") return child.pushLine({ jsonrpc: "2.0", id: req.id, result: INIT_OK })
        if (req.method === "thread/start") return child.pushLine({ jsonrpc: "2.0", id: req.id, result: { thread: { id: `t${spawnCount}` } } })
        if (req.method === "turn/start") {
          child.pushLine({ jsonrpc: "2.0", id: req.id, result: {} })
          if (isFirst) {
            // leave a partial frame in the buffer, then die
            child.pushRaw('{"jsonrpc":"2.0","method":"item/agentMess')
            queueMicrotask(() => child.emitExit(1, null))
          } else {
            child.pushLine({ jsonrpc: "2.0", method: "item/completed", params: { threadId: "t2", item: { type: "agentMessage", text: "recovered" } } })
            child.pushLine({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "t2", turn: { status: "completed" } } })
          }
        }
      }
      return child as any
    },
  })
  await assert.rejects(worker.runAgent(spec(), ctx()), (e) => e instanceof AgentError && e.retryable === true)
  const res = await worker.runAgent(spec(), ctx())
  assert.equal(res.text, "recovered")
  assert.equal(spawnCount, 2, "a fresh child must be spawned after the crash")
  await worker.shutdown()
})

test("worker shutdown settles in-flight turns with a retryable AgentError", async () => {
  const { worker } = makeServedWorker(() => {
    // never complete the turn
  })
  const run = worker.runAgent(spec(), ctx())
  await tick()
  await worker.shutdown()
  await assert.rejects(run, (e) => e instanceof AgentError && e.code === "shutdown" && e.retryable === true)
})

// ===========================================================================
// H3 — fail-closed approvals
// ===========================================================================

/** Wire-level reply the worker sends for an approval request targeting a LIVE
 *  turn running under `sandbox`. */
async function approvalDecision(sandbox: AgentSpec["sandbox"], method: string): Promise<unknown> {
  let child!: FakeChild
  const decisions: unknown[] = []
  const worker = new CodexWorker({
    ...HERMETIC_INVENTORY,
    spawnChild: () => {
      child = new FakeChild()
      child.onWrite = (req: any) => {
        if (req.result && (req.result.decision !== undefined || req.result.permissions !== undefined)) {
          decisions.push(req.result)
        }
        if (req.method === "initialize") return child.pushLine({ jsonrpc: "2.0", id: req.id, result: INIT_OK })
        if (req.method === "thread/start") return child.pushLine({ jsonrpc: "2.0", id: req.id, result: { thread: { id: "t" } } })
        if (req.method === "turn/start") {
          child.pushLine({ jsonrpc: "2.0", id: req.id, result: {} })
          child.pushLine({ jsonrpc: "2.0", id: 77, method, params: { threadId: "t" } })
          child.pushLine({ jsonrpc: "2.0", method: "item/completed", params: { threadId: "t", item: { type: "agentMessage", text: "x" } } })
          child.pushLine({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "t", turn: { status: "completed" } } })
        }
      }
      return child as any
    },
  })
  await worker.runAgent(spec({ sandbox }), ctx())
  await worker.shutdown()
  return decisions[0]
}

test("H3: read-only declines command approval; non-read-only accepts (capture writes)", async () => {
  assert.deepEqual(await approvalDecision("read-only", "item/commandExecution/requestApproval"), { decision: "decline" })
  assert.deepEqual(await approvalDecision("read-only", "item/fileChange/requestApproval"), { decision: "decline" })
  assert.deepEqual(await approvalDecision("workspace-write", "item/commandExecution/requestApproval"), { decision: "accept" })
  assert.deepEqual(await approvalDecision("workspace-write", "item/fileChange/requestApproval"), { decision: "accept" })
})

test("H3: permissions approval grants nothing for ANY sandbox (wire-level reply shape)", async () => {
  // Permission grants take a grant-shaped reply, not a decision — fail closed
  // means an EMPTY grant even for writable sandboxes: the worker never widens
  // permissions beyond what the sandbox policy already granted.
  assert.deepEqual(await approvalDecision("read-only", "item/permissions/requestApproval"), { permissions: {}, scope: "turn" })
  assert.deepEqual(await approvalDecision("workspace-write", "item/permissions/requestApproval"), { permissions: {}, scope: "turn" })
  assert.deepEqual(await approvalDecision("danger-full-access", "item/permissions/requestApproval"), { permissions: {}, scope: "turn" })
})

/** Wire-level reply the worker sends for an approval request referencing a
 *  thread it has NO TurnState for (e.g. the approval raced the turn settling).
 *  The agent itself runs writable, so a decline can only come from the
 *  missing-TurnState branch — never the read-only one. */
async function orphanApprovalReply(method: string): Promise<unknown> {
  let child!: FakeChild
  const replies: unknown[] = []
  const worker = new CodexWorker({
    ...HERMETIC_INVENTORY,
    spawnChild: () => {
      child = new FakeChild()
      child.onWrite = (req: any) => {
        if (req.id === 88 && req.result !== undefined) replies.push(req.result)
        if (req.method === "initialize") return child.pushLine({ jsonrpc: "2.0", id: req.id, result: INIT_OK })
        if (req.method === "thread/start") return child.pushLine({ jsonrpc: "2.0", id: req.id, result: { thread: { id: "t" } } })
        if (req.method === "turn/start") {
          child.pushLine({ jsonrpc: "2.0", id: req.id, result: {} })
          // approval references a thread the worker has no state for
          child.pushLine({ jsonrpc: "2.0", id: 88, method, params: { threadId: "UNKNOWN" } })
          child.pushLine({ jsonrpc: "2.0", method: "item/completed", params: { threadId: "t", item: { type: "agentMessage", text: "x" } } })
          child.pushLine({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "t", turn: { status: "completed" } } })
        }
      }
      return child as any
    },
  })
  await worker.runAgent(spec({ sandbox: "workspace-write" }), ctx())
  await worker.shutdown()
  return replies[0]
}

test("H3: approvals with NO matching TurnState fail closed for EVERY approval method", async () => {
  assert.deepEqual(await orphanApprovalReply("item/commandExecution/requestApproval"), { decision: "decline" })
  assert.deepEqual(await orphanApprovalReply("item/fileChange/requestApproval"), { decision: "decline" })
  // permissions takes the grant-shaped reply; fail closed = grant nothing.
  assert.deepEqual(await orphanApprovalReply("item/permissions/requestApproval"), { permissions: {}, scope: "turn" })
})

// ===========================================================================
// M32 — maxTurns rejected (not silently ignored)
// ===========================================================================

test("M32: codex rejects maxTurns explicitly", async () => {
  const { worker } = makeServedWorker(() => {})
  await assert.rejects(
    worker.runAgent(spec({ maxTurns: 5 }), ctx()),
    (e) => e instanceof AgentError && e.code === "unsupported_option",
  )
  await worker.shutdown()
})

// ===========================================================================
// M3 — image generation: read-only skip, basename sanitization, awaited write
// ===========================================================================

test("M3: imageGeneration writes to cwd, sanitizes id, and is awaited before settle", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-img-"))
  const b64 = Buffer.from("PNGDATA").toString("base64")
  const { worker } = makeServedWorker((_req, reply) => {
    reply({
      jsonrpc: "2.0",
      method: "item/completed",
      params: { threadId: "thread-1", item: { type: "imageGeneration", id: "../../escape", result: b64 } },
    })
    reply({ jsonrpc: "2.0", method: "item/completed", params: { threadId: "thread-1", item: { type: "agentMessage", text: "made an image" } } })
    reply({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "thread-1", turn: { status: "completed" } } })
  })
  await worker.runAgent(spec({ sandbox: "workspace-write", cwd: dir }), ctx())
  // id "../../escape" must be basename'd to "escape.png" inside cwd — no escape.
  const written = join(dir, "escape.png")
  assert.equal(existsSync(written), true, "image written under cwd with sanitized name")
  assert.equal(existsSync(join(dir, "..", "..", "escape.png")), false)
  const contents = await readFile(written)
  assert.equal(contents.toString(), "PNGDATA")
  await worker.shutdown()
})

test("M3: imageGeneration is SKIPPED for read-only sandboxes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-img-ro-"))
  const b64 = Buffer.from("DATA").toString("base64")
  const { worker } = makeServedWorker((_req, reply) => {
    reply({
      jsonrpc: "2.0",
      method: "item/completed",
      params: { threadId: "thread-1", item: { type: "imageGeneration", id: "pic", result: b64 } },
    })
    reply({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "thread-1", turn: { status: "completed" } } })
  })
  await worker.runAgent(spec({ sandbox: "read-only", cwd: dir }), ctx())
  assert.equal(existsSync(join(dir, "pic.png")), false, "read-only must not write artifacts")
  await worker.shutdown()
})

test("M3: copyFile path used when savedPath present, awaited before settle", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-img-copy-"))
  const srcPath = join(dir, "src.png")
  await writeFile(srcPath, "FROM-SAVED-PATH")
  const { worker } = makeServedWorker((_req, reply) => {
    reply({
      jsonrpc: "2.0",
      method: "item/completed",
      params: { threadId: "thread-1", item: { type: "imageGeneration", id: "out", savedPath: srcPath } },
    })
    reply({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "thread-1", turn: { status: "completed" } } })
  })
  await worker.runAgent(spec({ sandbox: "workspace-write", cwd: dir }), ctx())
  const dest = join(dir, "out.png")
  assert.equal(existsSync(dest), true)
  assert.equal((await readFile(dest)).toString(), "FROM-SAVED-PATH")
  await worker.shutdown()
})

// ===========================================================================
// M30 — initialize version check + malformed-notification resilience
// ===========================================================================

test("M30: non-object initialize result fails the handshake (no silent hang)", async () => {
  let child!: FakeChild
  const worker = new CodexWorker({
    ...HERMETIC_INVENTORY,
    spawnChild: () => {
      child = new FakeChild()
      child.onWrite = (req: any) => {
        if (req.method === "initialize") child.pushLine({ jsonrpc: "2.0", id: req.id, result: "not-an-object" })
      }
      return child as any
    },
  })
  await assert.rejects(worker.runAgent(spec(), ctx()), (e) => e instanceof AgentError && e.code === "initialize_failed")
  await worker.shutdown()
})

test("M30: malformed notifications are ignored, turn still completes", async () => {
  const { worker } = makeServedWorker((_req, reply) => {
    // garbage shapes the guards must reject without throwing
    reply({ jsonrpc: "2.0", method: "item/agentMessage/delta", params: { threadId: 123, delta: "x" } })
    reply({ jsonrpc: "2.0", method: "thread/tokenUsage/updated", params: { threadId: "thread-1", tokenUsage: 5 } })
    reply({ jsonrpc: "2.0", method: "item/started", params: { threadId: "thread-1", item: "nope" } })
    reply({ jsonrpc: "2.0", method: "item/completed", params: { threadId: "thread-1", item: { type: "agentMessage", text: "survived" } } })
    reply({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "thread-1", turn: { status: "completed" } } })
  })
  const res = await worker.runAgent(spec(), ctx())
  assert.equal(res.text, "survived")
  await worker.shutdown()
})

test("M30: production construction (factory passes no timeout opts) arms BOTH watchdogs", () => {
  // factory.ts constructs `new CodexWorker({ bin })` — production safety must
  // come from the defaults, not from opts nobody passes.
  assert.ok(DEFAULT_REQUEST_TIMEOUT_MS > 0, "request watchdog must default ON")
  assert.ok(DEFAULT_TURN_STALL_TIMEOUT_MS > 0, "turn stall watchdog must default ON")
  const worker = new CodexWorker({ bin: "codex" })
  assert.equal((worker as any).requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS)
  assert.equal((worker as any).turnStallTimeoutMs, DEFAULT_TURN_STALL_TIMEOUT_MS)
  // 0 stays an explicit opt-out, not a fall-through to the default.
  const off = new CodexWorker({ requestTimeoutMs: 0, turnStallTimeoutMs: 0 })
  assert.equal((off as any).requestTimeoutMs, 0)
  assert.equal((off as any).turnStallTimeoutMs, 0)
})

test("M30: a turn that goes silent after the turn/start ack is failed as stalled (no permanent hang)", async () => {
  // The request timeout cannot catch this: turn/start IS acked; the server
  // then simply never sends another frame.
  const { worker, getChild } = makeServedWorker(
    () => {
      // total silence: no items, no usage, no turn/completed
    },
    { turnStallTimeoutMs: 50 },
  )
  await assert.rejects(
    worker.runAgent(spec(), ctx()),
    (e) => e instanceof AgentError && e.code === "turn_stalled" && e.retryable === true,
  )
  // best-effort turn/interrupt was sent so a half-alive server stops burning tokens
  assert.ok(getChild().writes.some((w) => w.includes("turn/interrupt")))
  await worker.shutdown()
})

test("M30: notification activity re-arms the stall watchdog (a slow turn with steady progress completes)", async () => {
  // Total turn time (~400ms) far exceeds the stall window (250ms), but no
  // inter-frame gap does — only a watchdog that re-arms on activity survives.
  const { worker } = makeServedWorker(
    (_req, reply) => {
      const delta = (text: string) =>
        reply({ jsonrpc: "2.0", method: "item/agentMessage/delta", params: { threadId: "thread-1", delta: text } })
      setTimeout(() => delta("a"), 100)
      setTimeout(() => delta("b"), 200)
      setTimeout(() => delta("c"), 300)
      setTimeout(() => reply({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "thread-1", turn: { status: "completed" } } }), 400)
    },
    { turnStallTimeoutMs: 250 },
  )
  const res = await worker.runAgent(spec(), ctx())
  assert.equal(res.text, "abc")
  await worker.shutdown()
})

test("M30/H3: inbound approval REQUESTS re-arm the stall watchdog (approval-only traffic keeps a turn alive)", async () => {
  // An approval-gated stretch can emit no notifications at all — the only
  // inbound frames are server-initiated approval requests. Each must count as
  // turn progress (touchTurn on the approval path) or the watchdog would kill
  // a healthy turn mid-approval. Total turn time (~400ms) exceeds the stall
  // window (250ms); no inter-frame gap does.
  const { worker, getChild } = makeServedWorker(
    (_req, reply) => {
      const approval = (id: number) =>
        reply({ jsonrpc: "2.0", id, method: "item/commandExecution/requestApproval", params: { threadId: "thread-1" } })
      setTimeout(() => approval(101), 100)
      setTimeout(() => approval(102), 200)
      setTimeout(() => approval(103), 300)
      setTimeout(() => reply({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "thread-1", turn: { status: "completed" } } }), 400)
    },
    { turnStallTimeoutMs: 250 },
  )
  const res = await worker.runAgent(spec(), ctx())
  assert.equal(res.status, "completed")
  // The approvals were really answered on the wire (read-only → decline) —
  // liveness came from the approval handler, not from dropped frames.
  assert.equal(getChild().writes.filter((w) => w.includes('"decline"')).length, 3)
  await worker.shutdown()
})

test("M30: drifted streaming payloads still count as liveness — no false stall, no hang", async () => {
  // The delta payload shape drifted (no `delta` field) but the threadId is
  // intact: the shape guard must drop the payload while the watchdog still
  // treats the frames as proof of progress.
  const { worker } = makeServedWorker(
    (_req, reply) => {
      const junk = () => reply({ jsonrpc: "2.0", method: "item/agentMessage/delta", params: { threadId: "thread-1", textDelta: "drifted" } })
      setTimeout(junk, 100)
      setTimeout(junk, 200)
      setTimeout(junk, 300)
      setTimeout(() => reply({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "thread-1", turn: { status: "completed" } } }), 400)
    },
    { turnStallTimeoutMs: 250 },
  )
  const res = await worker.runAgent(spec(), ctx())
  assert.equal(res.status, "completed")
  await worker.shutdown()
})

test("M30: drifted turn/completed (no `turn` member) settles the turn with protocol_drift — not a hang", async () => {
  const { worker } = makeServedWorker((_req, reply) => {
    // hypothetical v3 shape: status hoisted out of the `turn` object
    reply({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "thread-1", status: "completed" } })
  })
  await assert.rejects(
    worker.runAgent(spec(), ctx()),
    (e) => e instanceof AgentError && e.code === "protocol_drift" && e.retryable === false && /0\.0\.0-test/.test(e.message),
  )
  await worker.shutdown()
})

test("M30: turn/completed with an unreadable threadId settles ALL live turns with protocol_drift", async () => {
  const { worker } = makeServedWorker((_req, reply) => {
    // even the threadId drifted — there is no way to match a specific turn
    reply({ jsonrpc: "2.0", method: "turn/completed", params: { thread: "thread-1", turn: { status: "completed" } } })
  })
  await assert.rejects(worker.runAgent(spec(), ctx()), (e) => e instanceof AgentError && e.code === "protocol_drift")
  await worker.shutdown()
})

test("M30: initialize result WITHOUT a userAgent fails the handshake (not an app-server)", async () => {
  let child!: FakeChild
  const worker = new CodexWorker({
    ...HERMETIC_INVENTORY,
    spawnChild: () => {
      child = new FakeChild()
      child.onWrite = (req: any) => {
        if (req.method === "initialize") child.pushLine({ jsonrpc: "2.0", id: req.id, result: { somethingElse: true } })
      }
      return child as any
    },
  })
  await assert.rejects(
    worker.runAgent(spec(), ctx()),
    (e) => e instanceof AgentError && e.code === "initialize_failed" && e.retryable === false,
  )
  await worker.shutdown()
})

test("M30: a pre-v2 app-server (initialize ok, thread/start unknown) fails loudly — behavioral version negotiation", async () => {
  // Old servers DO answer initialize (with a userAgent), so the version
  // mismatch surfaces at the first v2 method: a method-not-found rpc_error,
  // never a hang.
  let child!: FakeChild
  const worker = new CodexWorker({
    ...HERMETIC_INVENTORY,
    spawnChild: () => {
      child = new FakeChild()
      child.onWrite = (req: any) => {
        if (req.method === "initialize") return child.pushLine({ jsonrpc: "2.0", id: req.id, result: { userAgent: "codex/0.20.0 (old)" } })
        if (req.method === "thread/start")
          return child.pushLine({ jsonrpc: "2.0", id: req.id, error: { code: -32601, message: "Method not found: thread/start" } })
      }
      return child as any
    },
  })
  await assert.rejects(
    worker.runAgent(spec(), ctx()),
    (e) => e instanceof AgentError && e.code === "rpc_error" && /Method not found/.test(e.message),
  )
  await worker.shutdown()
})

// ===========================================================================
// Turn failure / interrupt semantics
// ===========================================================================

test("turn/completed with status=failed → AgentError with codex code + retryable", async () => {
  const releases: string[] = []
  const { worker } = makeServedWorker((_req, reply) => {
    reply({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { status: "failed", error: { message: "overloaded", codexErrorInfo: { serverOverloaded: {} } } } },
    })
  }, { onServerReq: (_child, req) => { if (req.method === "thread/unsubscribe") releases.push(req.params.threadId) } })
  await assert.rejects(
    worker.runAgent(spec(), ctx()),
    (e) => e instanceof AgentError && e.code === "serverOverloaded" && e.retryable === true,
  )
  assert.deepEqual(releases, ["thread-1"])
  await worker.shutdown()
})

test("turn/completed status=interrupted → AgentInterrupted", async () => {
  const releases: string[] = []
  const { worker } = makeServedWorker((_req, reply) => {
    reply({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "thread-1", turn: { status: "interrupted" } } })
  }, { onServerReq: (_child, req) => { if (req.method === "thread/unsubscribe") releases.push(req.params.threadId) } })
  await assert.rejects(worker.runAgent(spec(), ctx()), (e) => e instanceof AgentInterrupted)
  assert.deepEqual(releases, ["thread-1"])
  await worker.shutdown()
})

test("pre-aborted signal throws AgentInterrupted before spawning", async () => {
  const ac = new AbortController()
  ac.abort()
  const worker = new CodexWorker({ ...HERMETIC_INVENTORY, spawnChild: () => new FakeChild() as any })
  await assert.rejects(worker.runAgent(spec(), ctx(ac.signal)), (e) => e instanceof AgentInterrupted)
  await worker.shutdown()
})

test("abort mid-turn interrupts and settles", async () => {
  const ac = new AbortController()
  const { worker } = makeServedWorker((_req, _reply) => {
    // never complete; rely on abort to settle
  })
  const run = worker.runAgent(spec(), ctx(ac.signal))
  await tick()
  ac.abort()
  await assert.rejects(run, (e) => e instanceof AgentInterrupted)
  await worker.shutdown()
})

test("L2: async ENOENT spawn error → non-retryable binary_not_found", async () => {
  let child!: FakeChild
  const worker = new CodexWorker({
    ...HERMETIC_INVENTORY,
    spawnChild: () => {
      child = new FakeChild()
      // emit the ENOENT the way Node does for a missing binary (async 'error')
      queueMicrotask(() => child.emitError(new Error("spawn codex ENOENT")))
      return child as any
    },
  })
  await assert.rejects(
    worker.runAgent(spec(), ctx()),
    (e) => e instanceof AgentError && e.code === "binary_not_found" && e.retryable === false,
  )
  await worker.shutdown()
})

test("L2: sync spawn throw → non-retryable binary_not_found", async () => {
  const worker = new CodexWorker({
    ...HERMETIC_INVENTORY,
    spawnChild: () => {
      throw new Error("spawn codex ENOENT")
    },
  })
  await assert.rejects(
    worker.runAgent(spec(), ctx()),
    (e) => e instanceof AgentError && e.code === "binary_not_found" && e.retryable === false,
  )
  await worker.shutdown()
})

test("L2: a missing codex binary fails the default MCP inventory read as non-retryable binary_not_found", async () => {
  const worker = new CodexWorker({
    bin: join(tmpdir(), "omegacode-missing-codex", "codex"),
    spawnChild: () => { throw new Error("must not launch the app-server") },
  })
  await assert.rejects(
    worker.runAgent(spec(), ctx()),
    (e) => e instanceof AgentError && e.code === "binary_not_found" && e.retryable === false && /mcp list/.test(e.message),
  )
  await worker.shutdown()
})

test("L2: a non-executable codex binary fails the default feature inventory read as non-retryable binary_not_found", { skip: process.platform === "win32" }, async () => {
  const bin = join(await mkdtemp(join(tmpdir(), "codex-noexec-")), "codex")
  await writeFile(bin, "#!/bin/sh\n", { mode: 0o644 })
  const worker = new CodexWorker({
    bin,
    readMcpInventory: HERMETIC_INVENTORY.readMcpInventory,
    spawnChild: () => { throw new Error("must not launch the app-server") },
  })
  await assert.rejects(
    worker.runAgent(spec(), ctx()),
    (e) => e instanceof AgentError && e.code === "binary_not_found" && e.retryable === false && /features list/.test(e.message),
  )
  await worker.shutdown()
})

test("an inventory read where codex ran and failed stays mcp_inventory_failed even when stderr says not found", async () => {
  const worker = new CodexWorker({
    ...HERMETIC_INVENTORY,
    // execFile's shape for a child that exited nonzero: numeric exit code, stderr in the message.
    readMcpInventory: async () => { throw Object.assign(new Error("Command failed: codex mcp list --json\nconfig profile not found"), { code: 1 }) },
    spawnChild: () => { throw new Error("must not launch the app-server") },
  })
  await assert.rejects(
    worker.runAgent(spec(), ctx()),
    (e) => e instanceof AgentError && e.code === "mcp_inventory_failed" && e.retryable === false,
  )
  await worker.shutdown()
})

test("unknown server-initiated request gets an empty result (server not left blocking)", async () => {
  let child!: FakeChild
  const replies: any[] = []
  const worker = new CodexWorker({
    ...HERMETIC_INVENTORY,
    spawnChild: () => {
      child = new FakeChild()
      child.onWrite = (req: any) => {
        if (req.id === 99 && req.result !== undefined) replies.push(req)
        if (req.method === "initialize") return child.pushLine({ jsonrpc: "2.0", id: req.id, result: INIT_OK })
        if (req.method === "thread/start") return child.pushLine({ jsonrpc: "2.0", id: req.id, result: { thread: { id: "t" } } })
        if (req.method === "turn/start") {
          child.pushLine({ jsonrpc: "2.0", id: req.id, result: {} })
          child.pushLine({ jsonrpc: "2.0", id: 99, method: "some/future/method", params: {} })
          child.pushLine({ jsonrpc: "2.0", method: "item/completed", params: { threadId: "t", item: { type: "agentMessage", text: "x" } } })
          child.pushLine({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "t", turn: { status: "completed" } } })
        }
      }
      return child as any
    },
  })
  await worker.runAgent(spec(), ctx())
  await worker.shutdown()
  assert.equal(replies.length, 1)
  assert.deepEqual(replies[0].result, {})
})

test("thread/start with no thread id → AgentError", async () => {
  let child!: FakeChild
  const worker = new CodexWorker({
    ...HERMETIC_INVENTORY,
    spawnChild: () => {
      child = new FakeChild()
      child.onWrite = (req: any) => {
        if (req.method === "initialize") return child.pushLine({ jsonrpc: "2.0", id: req.id, result: INIT_OK })
        if (req.method === "thread/start") return child.pushLine({ jsonrpc: "2.0", id: req.id, result: {} })
      }
      return child as any
    },
  })
  await assert.rejects(worker.runAgent(spec(), ctx()), (e) => e instanceof AgentError && e.code === "no_thread_id")
  await worker.shutdown()
})

test("research profile identifies every allowlisted MCP server missing from the host inventory", () => {
  const inventory = JSON.stringify([mcpInventoryEntry("btca"), mcpInventoryEntry("executor", { type: "streamable_http" })])
  assert.deepEqual(selectMissingAllowedMcpServerNames(inventory, ["btca", "context7", "exa"]), ["context7", "exa"])
  assert.deepEqual(selectMissingAllowedMcpServerNames(inventory, ["btca"]), [])
})


test("CodexWorker uses named permissions exclusively on thread, working, and extraction requests", async () => {
  const requests: any[] = []
  let turn = 0
  const { worker } = makeServedWorker(
    (_req, reply) => {
      turn++
      reply({ jsonrpc: "2.0", method: "item/completed", params: { threadId: "thread-1", item: { type: "agentMessage", text: turn === 1 ? "work complete" : '{"ok":true}' } } })
      reply({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "thread-1", turn: { status: "completed" } } })
    },
    { onServerReq: (_child, req) => { if (req.method === "thread/start" || req.method === "turn/start") requests.push(req) } },
  )
  try {
    const result = await worker.runAgent(spec({ codexPermissions: "research", sandbox: "read-only", schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] } }), ctx())
    assert.deepEqual(result.structured, { ok: true })
    assert.deepEqual(requests.map(req => req.method), ["thread/start", "turn/start", "turn/start"])
    for (const request of requests) {
      assert.equal(request.params.permissions, "research")
      assert.equal(Object.hasOwn(request.params, "sandbox"), false)
      assert.equal(Object.hasOwn(request.params, "sandboxPolicy"), false)
    }
  } finally { await worker.shutdown() }
})
