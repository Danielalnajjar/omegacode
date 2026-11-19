import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { emptyUsage, type AgentResult, type AgentSpec } from "../dsl/types.js"
import { encodeNotification, encodeResult, type JsonRpcId } from "./codex-protocol.js"
import { AgentError, AgentInterrupted, type Worker, type WorkerContext } from "./index.js"
import { JsonRpcResponseError, JsonRpcStdioClient, StdioTransportError } from "./jsonrpc-stdio.js"
import { assertValidSchema, parseJsonLoose } from "./schema.js"
import { DEFAULT_KILL_GRACE_MS, DEFAULT_STALL_TIMEOUT_MS } from "./subprocess-jsonl.js"

const PROVIDER = "acp-cursor"
const ASK = "ask"
const SETUP_TIMEOUT_MS = 60_000

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
    // Cursor persists ACP sessions and model selection. Keep each process's state
    // private; the native CLI can still use inherited auth or its normal login.
    const state = await mkdtemp(join(tmpdir(), "omega-cursor-acp-"))
    const cwd = resolve(spec.cwd)
    let sessionId: string | undefined
    let prompting = false
    let text = ""
    const client = new JsonRpcStdioClient({
      bin: this.opts.bin ?? process.env.CURSOR_AGENT_BIN ?? "cursor-agent",
      args: ["--disable-auto-update", "acp"],
      cwd,
      env: {
        ...process.env,
        CURSOR_CONFIG_DIR: state,
        CURSOR_DATA_DIR: state,
        CURSOR_AGENT_DISABLE_DEBUG_LOG: "1",
      },
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
          text += content.text
          ctx.onProgress({ kind: "text", text: content.text })
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
      if (ctx.signal.aborted) throw new AgentInterrupted()
      ctx.signal.addEventListener("abort", cancel, { once: true })
      client.start()
      const init = asRecord(await client.request("initialize", {
        protocolVersion: 1,
        clientInfo: { name: "omegacode" },
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
        prompt: [{ type: "text", text: researchPrompt(spec) }],
      }, this.opts.promptTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS))
      prompting = false
      if (result?.stopReason !== "end_turn") {
        throw failure("turn_incomplete", "Cursor did not complete the ACP prompt turn")
      }
      if (!text.trim()) throw failure("no_result", "Cursor completed the ACP turn without assistant text")

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
          throw failure("auth_required", "Cursor ACP requires preconfigured host login or an inherited CURSOR_API_KEY", err)
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

function researchPrompt(spec: AgentSpec): string {
  return [
    "Research the task below in read-only mode.",
    spec.instructions,
    spec.prompt,
    spec.schema && `Return only a JSON value conforming to this JSON Schema:\n${JSON.stringify(spec.schema)}`,
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
