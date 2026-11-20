import { randomUUID } from "node:crypto"
import fs from "node:fs"
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { dirname, isAbsolute, join } from "node:path"
import { emptyUsage, type AgentResult, type AgentSpec } from "../dsl/types.js"
import { encodeNotification, encodeResult, type JsonRpcId } from "./codex-protocol.js"
import { AgentError, AgentInterrupted, type Worker, type WorkerContext } from "./index.js"
import { JsonRpcResponseError, JsonRpcStdioClient, StdioTransportError } from "./jsonrpc-stdio.js"
import { assertValidSchema, parseJsonLoose } from "./schema.js"
import { DEFAULT_KILL_GRACE_MS, DEFAULT_STALL_TIMEOUT_MS } from "./subprocess-jsonl.js"

const PROVIDER = "acp-cursor"
const ASK = "ask"
const SETUP_TIMEOUT_MS = 60_000
const AUTH_REQUIRED = "Cursor ACP requires preconfigured host login or an inherited CURSOR_API_KEY"

export interface CursorAcpWorkerOptions {
  bin?: string
  requestTimeoutMs?: number
  promptTimeoutMs?: number
  killGraceMs?: number
}

export class CursorAcpWorker implements Worker {
  readonly id = PROVIDER
  private readonly active = new Map<AbortController, Promise<AgentResult>>()

  constructor(private readonly opts: CursorAcpWorkerOptions = {}) {}

  async runAgent(spec: AgentSpec, ctx: WorkerContext): Promise<AgentResult> {
    if (ctx.signal.aborted) throw new AgentInterrupted()
    if (spec.sandbox !== "read-only" || spec.approval !== "never" || spec.serviceTier !== undefined) {
      throw failure("unsupported_option", "Cursor ACP requires read-only and unattended approval, without a service tier")
    }
    if (spec.maxTurns !== undefined) throw failure("unsupported_option", "Cursor ACP does not support maxTurns")
    if (!spec.model?.trim() || !spec.effort) {
      throw failure("invalid_config", "Cursor ACP requires an explicit model and effort")
    }
    if (spec.schema) {
      try { assertValidSchema(spec.schema) } catch (err) {
        throw failure("invalid_schema", `output schema does not compile: ${(err as Error).message}`)
      }
    }

    const controller = new AbortController()
    const abort = () => controller.abort()
    ctx.signal.addEventListener("abort", abort, { once: true })
    const attempt = this.runAttempt(spec, spec.model, spec.effort, { ...ctx, signal: controller.signal })
    this.active.set(controller, attempt)
    try {
      return await attempt
    } finally {
      ctx.signal.removeEventListener("abort", abort)
      this.active.delete(controller)
    }
  }

  async shutdown(): Promise<void> {
    for (const controller of this.active.keys()) controller.abort()
    await Promise.allSettled(this.active.values())
  }

  private async runAttempt(spec: AgentSpec, model: string, effort: string, ctx: WorkerContext): Promise<AgentResult> {
    const cwd = await realpath(spec.cwd).catch(() => {
      throw failure("invalid_config", "Cursor ACP could not resolve the working directory")
    })
    if (ctx.signal.aborted) throw new AgentInterrupted()

    // The managed guest launcher needs the original home to locate its generation;
    // it isolates HOME itself before executing Cursor. Match Skills' guest marker.
    const isolateHome = process.platform === "darwin"
      || (process.platform === "linux" && !fs.existsSync("/etc/thread-vm/base-verified"))
    // Cursor persists ACP sessions and model selection. It also reads user
    // hooks and MCP from its process home, independently of these state dirs.
    const state = await mkdtemp(join(tmpdir(), "omega-cursor-acp-"))
    const hostHome = homedir()
    const launchHome = isolateHome ? state : hostHome
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...(isolateHome ? { HOME: launchHome } : {}),
      CURSOR_CONFIG_DIR: state,
      CURSOR_DATA_DIR: state,
      CURSOR_AGENT_DISABLE_DEBUG_LOG: "1",
    }
    // This token route writes to the native login store, unlike inherited API-key auth.
    delete env.CURSOR_AUTH_TOKEN
    let sessionId: string | undefined
    let prompting = false
    let text = ""
    let lastChunk = ""
    let sawAnswerBytes = false
    const marker = `OMEGA_CURSOR_COMPLETE_${randomUUID()}`
    const client = new JsonRpcStdioClient({
      bin: this.opts.bin ?? process.env.CURSOR_AGENT_BIN ?? "cursor-agent",
      args: ["--disable-auto-update", "--disable-project-configs", "acp"],
      cwd,
      env,
      requestTimeoutMs: this.opts.requestTimeoutMs ?? SETUP_TIMEOUT_MS,
      stderrLimit: 0,
      onServerRequest: (id, method, params) => {
        const frame = serverReply(id, method, params, prompting ? sessionId : undefined)
        // If the pipe broke, the transport owns rejection of pending requests.
        try { client.send(frame) } catch (err) {
          if (!(err instanceof StdioTransportError)) throw err
          void close()
        }
      },
      onNotification: (method, params) => {
        if (!prompting || method !== "session/update") return
        const message = asRecord(params)
        if (!message || message.sessionId !== sessionId) return
        const update = asRecord(message.update)
        const content = asRecord(update?.content)
        if (update?.sessionUpdate === "tool_call" && typeof update.toolCallId === "string") {
          ctx.onProgress({ kind: "tool", id: update.toolCallId, name: typeof update.kind === "string" ? update.kind : "tool" })
        }
        if (content?.type !== "text" || typeof content.text !== "string") return
        if (update?.sessionUpdate === "agent_message_chunk") {
          // Cursor sends backend errors through the same update as answer deltas.
          // Do not publish answer text until we can tell which kind of turn ended.
          lastChunk = content.text
          text += lastChunk
          if (!sawAnswerBytes && lastChunk.trim() && !lastChunk.startsWith("\n\n")) {
            sawAnswerBytes = true
            ctx.onProgress({ kind: "phase", phase: "cursor-response" })
          }
        } else if (update?.sessionUpdate === "agent_thought_chunk") {
          ctx.onProgress({ kind: "reasoning", text: content.text })
        }
      },
    })
    let closePromise: Promise<void> | undefined
    const close = () => closePromise ??= client.close(this.opts.killGraceMs ?? DEFAULT_KILL_GRACE_MS)
    const cancel = () => {
      if (sessionId && prompting && client.alive) {
        try { client.send(encodeNotification("session/cancel", { sessionId })) } catch {
          // Process teardown below does not depend on a delivered notification.
        }
      }
      void close()
    }

    try {
      await assertNoNativeExtensions(cwd, launchHome, env)
      if (isolateHome) await prepareNativeLogin(env, hostHome, launchHome)
      if (ctx.signal.aborted) throw new AgentInterrupted()
      ctx.signal.addEventListener("abort", cancel, { once: true })
      client.start()
      const init = asRecord(await client.request("initialize", {
        protocolVersion: 1,
        // Cursor otherwise advertises opaque expanded variant IDs without a
        // separate reasoning selector. Do not advertise client tools.
        clientCapabilities: { _meta: { parameterizedModelPicker: true } },
      }))
      if (init?.protocolVersion !== 1) throw failure("protocol_error", "Cursor did not negotiate ACP v1")

      const session = asRecord(await client.request("session/new", { cwd, mcpServers: [] }))
      if (typeof session?.sessionId !== "string" || !session.sessionId) {
        throw failure("protocol_error", "Cursor did not return an ACP session ID")
      }
      sessionId = session.sessionId
      const set = async (option: ConfigOption, value: string) => {
        if (!offers(option, value)) throw selectionError(option.id, value)
        const reply = await client.request("session/set_config_option", { sessionId, configId: option.id, value })
        const options = configOptions(reply)
        if (findOption(options, option.id).currentValue !== value) throw selectionError(option.id, value)
        return options
      }

      let options = configOptions(session)
      options = await set(findOption(options, "mode"), ASK)
      options = await set(findOption(options, "model"), model)
      const reasoning = options.find((option) => option.category === "thought_level")
      if (!reasoning) throw failure("invalid_config", "Cursor did not advertise a reasoning selector for the requested model")
      options = await set(reasoning, effort)
      if (findOption(options, "mode").currentValue !== ASK || findOption(options, "model").currentValue !== model) {
        throw failure("invalid_config", "Cursor did not retain the requested Ask mode and model")
      }

      prompting = true
      const result = asRecord(await client.request("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: researchPrompt(spec, marker) }],
      }, this.opts.promptTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS))
      prompting = false
      if (result?.stopReason !== "end_turn") {
        throw failure("turn_incomplete", "Cursor did not complete the ACP prompt turn")
      }
      text = text.trimEnd()
      const end = `\n${marker}`
      if (!text) throw failure("no_result", "Cursor completed the ACP turn without assistant text")
      if (!text.endsWith(end)) {
        // The pinned CLI sends these auth notices as one message chunk.
        if (lastChunk === "\n\nPlease sign in to continue" || lastChunk.startsWith("\n\nError: [unauthenticated] ")) {
          throw failure("auth_required", AUTH_REQUIRED)
        }
        throw failure("provider_error", "Cursor did not return a verifiable complete answer")
      }
      text = text.slice(0, -end.length)
      if (!text.trim()) throw failure("no_result", "Cursor completed the ACP turn without assistant text")
      ctx.onProgress({ kind: "text", text })

      let structured: unknown
      if (spec.schema) {
        try { structured = parseJsonLoose(text) } catch {
          // The workflow runtime owns schema validation and its corrective retry.
        }
      }
      return { text, structured, status: "completed", usage: emptyUsage() }
    } catch (err) {
      if (ctx.signal.aborted || err instanceof AgentInterrupted) throw new AgentInterrupted()
      if (err instanceof JsonRpcResponseError) {
        if (err.rpc.code === -32000) {
          throw failure("auth_required", AUTH_REQUIRED, err)
        }
        throw failure("provider_error", "Cursor rejected an ACP request", err)
      }
      if (err instanceof StdioTransportError) {
        if (err.code === "request_timeout") {
          cancel()
          throw failure("request_timeout", err.message)
        }
        throw failure("transport_error", "Cursor ACP stdio failed; check the cursor-agent executable and installation")
      }
      throw err
    } finally {
      ctx.signal.removeEventListener("abort", cancel)
      try {
        await close()
      } finally {
        await rm(state, { recursive: true, force: true })
      }
    }
  }
}

/** Preserve the pinned CLI's native login without importing its user extensions. */
async function prepareNativeLogin(env: NodeJS.ProcessEnv, hostHome: string, launchHome: string): Promise<void> {
  if (!isAbsolute(hostHome)) throw failure("invalid_config", "Cursor ACP requires an absolute host home for native login")
  delete env.XDG_CACHE_HOME
  delete env.XDG_DATA_HOME
  delete env.XDG_STATE_HOME
  if (process.platform === "linux") {
    // File authentication uses XDG, while native extension loaders use HOME,
    // the workspace or machine paths. CLI config/data already point to scratch.
    if (!env.XDG_CONFIG_HOME || !isAbsolute(env.XDG_CONFIG_HOME)) env.XDG_CONFIG_HOME = join(hostHome, ".config")
    return
  }

  delete env.XDG_CONFIG_HOME
  delete env.CFFIXED_USER_HOME
  const keychainPath = join("Library", "Keychains", "login.keychain-db")
  const source = join(hostHome, keychainPath)
  let keychain
  try {
    keychain = await fs.promises.lstat(source)
  } catch (err) {
    if (isMissingPath(err)) return
    throw failure("invalid_config", "Cursor ACP could not inspect the standard login keychain")
  }
  if (!keychain.isFile() || keychain.uid !== process.getuid?.()) return
  // Allow the system Keychain lookup to find the existing login file. Never
  // copy it or expose the enclosing directory to the isolated home.
  try {
    const alias = join(launchHome, keychainPath)
    await mkdir(dirname(alias), { recursive: true, mode: 0o700 })
    await symlink(source, alias)
  } catch {
    throw failure("invalid_config", "Cursor ACP could not expose the standard login keychain to its private home")
  }
}

/** Native MCP startup and hooks run outside ACP tool approvals. Inspect
 * paths only, never config contents. */
async function assertNoNativeExtensions(cwd: string, launchHome: string, env: NodeJS.ProcessEnv): Promise<void> {
  if (env.CURSOR_PRIVATE_INFERENCE_CONFIG?.trim()) {
    throw failure("invalid_config", "Cursor ACP requires a launch without private-inference configuration")
  }

  const managedDir = process.platform === "darwin" ? "/Library/Application Support/Cursor"
    : process.platform === "win32" ? "C:\\ProgramData\\Cursor" : "/etc/cursor"
  const configs = new Set([
    "/etc/cursor/private-inference.toml",
    join(managedDir, "private-inference.toml"),
    join(managedDir, "hooks.json"),
  ])
  const addNativeConfigs = (dir: string, project: boolean) => {
    configs.add(join(dir, ".cursor", "mcp.json"))
    configs.add(join(dir, ".cursor", "hooks.json"))
    configs.add(join(dir, ".claude", "settings.json"))
    if (project) configs.add(join(dir, ".claude", "settings.local.json"))
  }
  addNativeConfigs(launchHome, false)
  addNativeConfigs(cwd, true)
  // Only the nearest git root is a project config source in the CLI.
  for (let dir = cwd; ; dir = dirname(dir)) {
    if (fs.existsSync(join(dir, ".git"))) {
      addNativeConfigs(dir, true)
      break
    }
    const parent = dirname(dir)
    if (parent === dir) break
  }

  for (const path of configs) {
    try {
      await fs.promises.lstat(path)
    } catch (err) {
      if (isMissingPath(err)) continue
    }
    throw failure("invalid_config", "Cursor ACP requires a home and workspace without native MCP, hooks, or private-inference configuration")
  }
}

function isMissingPath(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code
  return code === "ENOENT" || code === "ENOTDIR"
}

function researchPrompt(spec: AgentSpec, marker: string): string {
  return [
    "Research the task below in read-only mode.",
    spec.instructions,
    spec.prompt,
    spec.schema && `Write the answer as a single JSON value conforming to this JSON Schema:\n${JSON.stringify(spec.schema)}`,
    `After the complete answer, add this exact final line, with no formatting or text after it:\n${marker}`,
  ].filter(Boolean).join("\n\n")
}

type ConfigOption = Record<string, unknown> & { id: string }

function configOptions(response: unknown): ConfigOption[] {
  const options = asRecord(response)?.configOptions
  if (!Array.isArray(options)) {
    throw failure("invalid_config", "Cursor did not advertise ACP session config options")
  }
  return options.map(asRecord).filter((option): option is ConfigOption =>
    typeof option?.id === "string" && option.type === "select")
}

function findOption(options: ConfigOption[], id: string): ConfigOption {
  const option = options.find((candidate) => candidate.id === id)
  if (!option) throw failure("invalid_config", `Cursor did not advertise the ACP ${id} selector`)
  return option
}

function offers(option: ConfigOption, value: string): boolean {
  const choices: unknown = option.options
  if (!Array.isArray(choices)) return false
  return choices.some((item: unknown) => {
    const choice = asRecord(item)
    return choice?.value === value || (Array.isArray(choice?.options) &&
      choice.options.some((nested: unknown) => asRecord(nested)?.value === value))
  })
}

function serverReply(id: JsonRpcId, method: string, params: unknown, activeSession?: string): string {
  if (method === "session/request_permission") {
    const request = asRecord(params)
    const call = asRecord(request?.toolCall)
    const options: unknown[] = Array.isArray(request?.options) ? request.options : []
    // Only Cursor's native web tool requests have these IDs. Do not approve
    // general tool categories, shell, MCP, or persistent permission changes.
    const nativeWebRead = activeSession !== undefined && request?.sessionId === activeSession
      && (call?.kind === "search" || call?.kind === "fetch")
      && typeof call.toolCallId === "string" && call.toolCallId.startsWith(`web_${call.kind}_`)
    const wanted = nativeWebRead ? "allow_once" : "reject_once"
    const option = options.map(asRecord).find((candidate) =>
      candidate?.kind === wanted && typeof candidate.optionId === "string")
    return encodeResult(id, { outcome: option ? { outcome: "selected", optionId: option.optionId } : { outcome: "cancelled" } })
  }
  if (method === "cursor/ask_question") return encodeResult(id, { outcome: { outcome: "skipped" } })
  if (method === "cursor/create_plan") return encodeResult(id, { outcome: { outcome: "rejected" } })
  return JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message: "Client method not supported" } })
}

function selectionError(id: string, value: string): AgentError {
  return failure("invalid_config", `Cursor did not offer or retain the requested ${id} value ${JSON.stringify(value)}`)
}

function failure(code: string, message: string, rpc?: JsonRpcResponseError): AgentError {
  return new AgentError({ provider: PROVIDER, code, message: rpc ? `${message} (ACP ${rpc.rpc.code})` : message })
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}
