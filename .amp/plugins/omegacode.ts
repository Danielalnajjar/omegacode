import type { PluginAPI } from "@ampcode/plugin"

import { mkdtemp, rm } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { isAbsolute, join, relative, resolve, sep } from "node:path"
import { createServer, type Server, type Socket } from "node:net"

export const description = "Run omegacode workflows; each agent() becomes an Amp thread."

const DEFAULT_MODEL = "xai/grok-4.5"
const DEFAULT_EFFORT = "medium"
const MAX_RESULT_CHARS = 10_000
const STOP_GRACE_MS = 10_000
const EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max"])

type RpcId = string | number
type AgentThread = Awaited<ReturnType<ReturnType<PluginAPI["createAgent"]>["createThread"]>>

interface RunAgentParams {
  callId: string
  prompt: string
  model: string
  effort?: string
  instructions?: string
  timeoutMs: number
}

interface RpcMessage {
  jsonrpc: "2.0"
  id?: RpcId | null
  method?: string
  params?: unknown
}

interface RunResource {
  stop(): Promise<void>
}

interface RunOutput {
  runId?: string
  status?: string
  result?: unknown
  error?: unknown
}

/** The `run.started` line the CLI writes to stderr under `--start-json`, at launch. */
interface RunStarted {
  runId?: string
  runDir?: string
}

export default function omegacodePlugin(amp: PluginAPI): void {
  const activeRuns = new Set<RunResource>()
  const agentCache = new Map<string, ReturnType<PluginAPI["createAgent"]>>()

  const createAgent = (config: Parameters<PluginAPI["createAgent"]>[0]): ReturnType<PluginAPI["createAgent"]> => {
    if (typeof amp.createAgent === "function") return amp.createAgent(config)
    if (typeof amp.experimental?.createAgent === "function") return amp.experimental.createAgent(config)
    throw new Error("This Amp version does not expose createAgent")
  }

  // Amp threads always run with the full tool set: the worker requires sandbox
  // "danger-full-access" precisely because Amp offers no enforceable confinement,
  // so a partial tool exclusion would only pretend to be a sandbox.
  const cachedAgent = (model: string, effort: string | undefined) => {
    const key = JSON.stringify([model, effort ?? null])
    let agent = agentCache.get(key)
    if (!agent) {
      agent = createAgent({
        name: "omega-worker",
        model,
        ...(effort ? { reasoningEffort: effort as Parameters<PluginAPI["createAgent"]>[0]["reasoningEffort"] } : {}),
        instructions: "Follow the per-turn instructions and task exactly.",
        tools: "all",
        display: { label: "omega", color: "#7c3aed" },
      })
      agentCache.set(key, agent)
    }
    return agent
  }

  amp.registerTool({
    name: "omegacode_run_workflow",
    description:
      "Run an omegacode workflow locally. Workflow agent() calls whose opts pin provider \"amp\" — or omit provider and so inherit this run's default — become child Amp threads. Agents that pin another provider (codex, claude-code, opencode, pi) spawn that CLI instead and need it installed and authenticated on this machine. Amp threads run with the full Amp tool set and no sandbox confinement: omegacode's read-only/workspace-write modes are rejected for the amp provider rather than faked.",
    inputSchema: {
      type: "object",
      properties: {
        workflow: { type: "string", description: "Saved workflow name or repository-relative workflow path" },
        args: { type: "object", description: "Optional JSON object exposed to the workflow as args" },
        model: { type: "string", description: `Amp plugin-agent model (default ${DEFAULT_MODEL})` },
        effort: { type: "string", enum: [...EFFORTS], description: `Reasoning effort (default ${DEFAULT_EFFORT})` },
        maxAgents: { type: "number", minimum: 1, description: "Maximum concurrent workflow agents" },
      },
      required: ["workflow"],
      additionalProperties: false,
    },
    async execute(input, ctx) {
      const workspaceURI = amp.system.workspaceRoot
      if (!workspaceURI) return "OmegaCode cannot run because Amp has no active workspace."
      const repoRoot = amp.helpers.filePathFromURI(workspaceURI)
      const workflow = requiredString(input.workflow, "workflow")
      validateWorkflow(workflow, repoRoot)
      const model = optionalString(input.model, "model") ?? DEFAULT_MODEL
      const effort = optionalString(input.effort, "effort") ?? DEFAULT_EFFORT
      if (!EFFORTS.has(effort)) throw new Error(`effort must be one of ${[...EFFORTS].join(", ")}`)
      const maxAgents = optionalPositiveInteger(input.maxAgents, "maxAgents")
      const args = optionalObject(input.args, "args")

      const socketDir = await mkdtemp(join(tmpdir(), "omegacode-amp-"))
      const socketPath = join(socketDir, "rpc.sock")
      const threadIDs: string[] = []
      const activeThreads = new Map<string, AgentThread>()
      const cancelledCalls = new Set<string>()
      const sockets = new Set<Socket>()
      let child: ReturnType<typeof Bun.spawn> | undefined
      let stopped: Promise<void> | undefined
      let server: Server

      const resource: RunResource = {
        stop(): Promise<void> {
          if (stopped) return stopped
          stopped = (async () => {
            // Cancel the child threads first so they stop billing before the CLI dies, then
            // wait for the CLI itself: tearing the socket down under a live child would only
            // strand it. SIGTERM lets it flush its journal; SIGKILL is the 10s backstop.
            for (const thread of activeThreads.values()) void thread.cancel().catch(() => undefined)
            const proc = child
            if (proc) {
              if (proc.exitCode === null) proc.kill("SIGTERM")
              await raceExit(proc.exited, STOP_GRACE_MS)
              if (proc.exitCode === null) {
                proc.kill("SIGKILL")
                await proc.exited.catch(() => undefined)
              }
            }
            for (const socket of sockets) socket.destroy()
            await closeServer(server)
            await rm(socketDir, { recursive: true, force: true })
          })()
          return stopped
        },
      }

      server = createServer((socket) => {
        sockets.add(socket)
        socket.setEncoding("utf8")
        socket.on("close", () => sockets.delete(socket))
        let buffer = ""
        socket.on("data", (chunk: string) => {
          buffer += chunk
          let newline = buffer.indexOf("\n")
          while (newline !== -1) {
            const line = buffer.slice(0, newline).trim()
            buffer = buffer.slice(newline + 1)
            if (line) void handleLine(line, socket)
            newline = buffer.indexOf("\n")
          }
        })
      })

      const handleLine = async (line: string, socket: Socket): Promise<void> => {
        let message: RpcMessage
        try {
          message = JSON.parse(line) as RpcMessage
        } catch {
          writeRpc(socket, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } })
          return
        }
        if (message.method === "cancelAgent" && message.id === undefined) {
          const callId = objectParams(message.params).callId
          if (typeof callId === "string") {
            cancelledCalls.add(callId)
            const thread = activeThreads.get(callId)
            if (thread) void thread.cancel().catch(() => undefined)
          }
          return
        }
        if (message.method !== "runAgent" || message.id === undefined || message.id === null) {
          if (message.id !== undefined) {
            writeRpc(socket, { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } })
          }
          return
        }

        // Every exit path after createThread must cancel the thread it made: an
        // appendUserMessage throw or a waitForResponse rejection (timeout included) would
        // otherwise leave a live, billing Amp thread behind once the finally drops our handle.
        let created: AgentThread | undefined
        try {
          const params = parseRunAgentParams(message.params)
          const agent = cachedAgent(params.model, params.effort)
          const prompt = params.instructions ? `${params.instructions}\n\n${params.prompt}` : params.prompt
          const thread = await agent.createThread({ parentThreadID: ctx.thread.id })
          created = thread
          activeThreads.set(params.callId, thread)
          threadIDs.push(thread.id)
          writeRpc(socket, {
            jsonrpc: "2.0",
            method: "agentThread",
            params: { callId: params.callId, threadID: thread.id },
          })
          if (cancelledCalls.has(params.callId)) {
            // Cancelled while the thread was being created — never send it a turn.
            void thread.cancel().catch(() => undefined)
            writeRpc(socket, { jsonrpc: "2.0", id: message.id, error: { code: -32000, message: "cancelled before start" } })
            return
          }
          const responsePromise = thread.waitForResponse({ timeoutMs: params.timeoutMs })
          void responsePromise.catch(() => undefined)
          await thread.appendUserMessage({ type: "user-message", content: prompt })
          const response = await responsePromise
          const text = response.content
            .filter((block): block is Extract<(typeof response.content)[number], { type: "text" }> => block.type === "text")
            .map((block) => block.text)
            .join("\n")
          writeRpc(socket, { jsonrpc: "2.0", id: message.id, result: { text } })
        } catch (error) {
          if (created) void created.cancel().catch(() => undefined)
          writeRpc(socket, {
            jsonrpc: "2.0",
            id: message.id,
            error: { code: -32000, message: error instanceof Error ? error.message : String(error) },
          })
        } finally {
          const callId = objectParams(message.params).callId
          if (typeof callId === "string") {
            activeThreads.delete(callId)
            cancelledCalls.delete(callId)
          }
        }
      }

      activeRuns.add(resource)
      const signal = toolAbortSignal(ctx)
      const onAbort = (): void => void resource.stop()
      signal?.addEventListener("abort", onAbort, { once: true })
      try {
        await listen(server, socketPath)
        const cliArgs = [
          "node",
          join(repoRoot, "dist", "cli.js"),
          "run",
          workflow,
          "--provider",
          "amp",
          "--model",
          model,
          "--effort",
          effort,
          // The amp worker fails closed on anything narrower — Amp threads have no OS sandbox.
          "--sandbox",
          "danger-full-access",
          "--json",
          "--start-json",
          "--no-serve",
        ]
        if (args !== undefined) cliArgs.push("--args", JSON.stringify(args))
        if (maxAgents !== undefined) cliArgs.push("--concurrency", String(maxAgents))

        child = Bun.spawn(cliArgs, {
          cwd: repoRoot,
          env: { ...process.env, OMEGACODE_AMP_SOCKET: socketPath },
          stdout: "pipe",
          stderr: "pipe",
        })
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ])
        const output = parseRunOutput(stdout)
        return formatReceipt({ workflow, output, started: parseRunStarted(stderr), stdout, stderr, exitCode, threadIDs })
      } finally {
        signal?.removeEventListener("abort", onAbort)
        activeRuns.delete(resource)
        await resource.stop()
      }
    },
  })

  amp.registerCommand(
    "omegacode-run-workflow",
    {
      title: "run workflow",
      category: "omegacode",
      description: "Ask the active Amp thread to run an omegacode workflow",
    },
    async (ctx) => {
      const workflow = await ctx.ui.input({ title: "OmegaCode workflow", helpText: "Saved name or repository-relative path" })
      if (!workflow) return
      const model = await ctx.ui.select({
        title: "Amp model",
        allowOther: true,
        initialValue: DEFAULT_MODEL,
        options: [DEFAULT_MODEL, "openai/gpt-5.6-sol", "openai/gpt-5.6-luna"],
      })
      if (!model) return
      if (!ctx.thread) {
        await ctx.ui.notify("Start or open a thread before running an omegacode workflow.")
        return
      }
      await ctx.thread.appendUserMessage({
        type: "user-message",
        content: `Use the omegacode_run_workflow tool with ${JSON.stringify({ workflow, model })}. Report the tool result verbatim.`,
      })
    },
  )

  amp.onDispose(async () => {
    await Promise.all([...activeRuns].map((run) => run.stop()))
  })
}

function requiredString(value: unknown, name: string): string {
  const result = optionalString(value, name)
  if (result === undefined) throw new Error(`${name} is required`)
  return result
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${name} must be a non-empty string`)
  return value.trim()
}

function optionalPositiveInteger(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`)
  return value
}

function optionalObject(value: unknown, name: string): Record<string, unknown> | undefined {
  if (value === undefined) return undefined
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`)
  return value as Record<string, unknown>
}

function validateWorkflow(workflow: string, repoRoot: string): void {
  if (isAbsolute(workflow)) throw new Error("workflow must be a saved name or repository-relative path")
  if (!workflow.includes("/") && !workflow.includes("\\") && !workflow.endsWith(".js")) return
  const resolved = resolve(repoRoot, workflow)
  const rel = relative(repoRoot, resolved)
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error("workflow path must stay within the Amp workspace")
  }
}

function objectParams(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function parseRunAgentParams(value: unknown): RunAgentParams {
  const params = objectParams(value)
  const callId = requiredString(params.callId, "callId")
  const prompt = requiredString(params.prompt, "prompt")
  const model = requiredString(params.model, "model")
  const effort = optionalString(params.effort, "effort")
  if (effort && !EFFORTS.has(effort)) throw new Error("invalid effort")
  const instructions = optionalString(params.instructions, "instructions")
  const timeoutMs = params.timeoutMs
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("invalid timeoutMs")
  // Anything else on the request (a toolPolicy from an older worker, say) is ignored:
  // Amp threads are always created with the full tool set.
  return { callId, prompt, model, effort, instructions, timeoutMs }
}

function writeRpc(socket: Socket, message: unknown): void {
  if (!socket.destroyed) socket.write(`${JSON.stringify(message)}\n`)
}

function listen(server: Server, socketPath: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const onError = (error: Error): void => reject(error)
    server.once("error", onError)
    server.listen(socketPath, () => {
      server.off("error", onError)
      resolvePromise()
    })
  })
}

/** Wait for the child to exit, giving up after `graceMs` so a wedged CLI can't block teardown. */
function raceExit(exited: Promise<number>, graceMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const grace = new Promise<void>((resolvePromise) => {
    timer = setTimeout(resolvePromise, graceMs)
  })
  return Promise.race([exited.then(() => undefined, () => undefined), grace]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve()
  return new Promise((resolvePromise) => server.close(() => resolvePromise()))
}

function parseRunOutput(stdout: string): RunOutput {
  try {
    const parsed = JSON.parse(stdout) as unknown
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as RunOutput : {}
  } catch {
    return {}
  }
}

/**
 * Recover the run's identity from the `--start-json` line the CLI emits on stderr at launch.
 * Terminal stdout JSON is absent whenever the run is aborted, killed, or crashes — that is
 * exactly when the receipt still needs a runId to point at.
 */
function parseRunStarted(stderr: string): RunStarted {
  for (const line of stderr.split("\n")) {
    if (!line.includes("run.started")) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line.trim()) as unknown
    } catch {
      continue
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) continue
    const record = parsed as Record<string, unknown>
    if (record.type !== "run.started") continue
    return {
      ...(typeof record.runId === "string" ? { runId: record.runId } : {}),
      ...(typeof record.runDir === "string" ? { runDir: record.runDir } : {}),
    }
  }
  return {}
}

/** stderr is diagnostics, not output — the machine-readable launch line never belongs in `result`. */
function stripStartJson(stderr: string): string {
  return stderr
    .split("\n")
    .filter((line) => !(line.includes("run.started") && line.trim().startsWith("{")))
    .join("\n")
    .trim()
}

function formatReceipt(input: {
  workflow: string
  output: RunOutput
  started: RunStarted
  stdout: string
  stderr: string
  exitCode: number
  threadIDs: string[]
}): string {
  const knownRunId = typeof input.output.runId === "string" ? input.output.runId : input.started.runId
  const runId = knownRunId ?? "unknown"
  const status = typeof input.output.status === "string"
    ? input.output.status
    : input.exitCode === 0 ? "unknown" : `failed (exit ${input.exitCode})`
  const result = input.output.result !== undefined
    ? printable(input.output.result)
    : input.output.error !== undefined
      ? printable(input.output.error)
      : input.stdout.trim() || stripStartJson(input.stderr) || "(no result)"
  const root = process.env.OMEGACODE_HOME ?? join(homedir(), ".omegacode")
  const journalDir = input.started.runDir ?? (knownRunId ? join(root, "runs", knownRunId) : "unknown")
  const uniqueThreads = [...new Set(input.threadIDs)]
  return [
    "OmegaCode workflow receipt",
    `status: ${status}`,
    `run id: ${runId}`,
    "threads:",
    ...(uniqueThreads.length > 0 ? uniqueThreads.map((id) => `- https://ampcode.com/threads/${id}`) : ["- (none)"]),
    "result:",
    truncate(result, MAX_RESULT_CHARS),
    `journal dir: ${journalDir}`,
    ...(status !== "completed" && knownRunId ? [`resume: omegacode run ${input.workflow} --resume ${knownRunId}`] : []),
  ].join("\n")
}

function printable(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2)
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value
  return `${value.slice(0, maxChars)}\n… [truncated ${value.length - maxChars} characters]`
}

function toolAbortSignal(ctx: unknown): AbortSignal | undefined {
  if (ctx === null || typeof ctx !== "object" || !("signal" in ctx)) return undefined
  const signal = (ctx as { signal?: unknown }).signal
  return signal instanceof AbortSignal ? signal : undefined
}
