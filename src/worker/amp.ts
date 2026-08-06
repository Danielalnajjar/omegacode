// AmpWorker — sends agent turns to the Amp omegacode plugin over its unix
// socket. Amp owns model access and threads; omegacode owns orchestration,
// schema validation, retries, and the durable run journal.

import { randomUUID } from "node:crypto"

import { emptyUsage, type AgentResult, type AgentSpec, type Effort, type ProviderId } from "../dsl/types.js"
import type { Worker, WorkerContext } from "./index.js"
import { AgentError, AgentInterrupted } from "./index.js"
import { JsonRpcResponseError } from "./jsonrpc-core.js"
import { JsonRpcSocketClient, SocketTransportError } from "./jsonrpc-socket.js"
import { assertValidSchema, parseJsonLoose } from "./schema.js"

const PROVIDER = "amp" as const
const AGENT_TIMEOUT_MS = 30 * 60 * 1000

type AmpEffort = Exclude<Effort, "ultra">

export interface AmpWorkerOpts {
  socket?: string
}

interface ActiveCall {
  ctx: WorkerContext
}

export class AmpWorker implements Worker {
  readonly id: ProviderId = PROVIDER
  private readonly socket?: string
  private client: JsonRpcSocketClient | null = null
  private readonly active = new Map<string, ActiveCall>()

  constructor(opts: AmpWorkerOpts = {}) {
    this.socket = opts.socket ?? process.env.OMEGACODE_AMP_SOCKET
  }

  async runAgent(spec: AgentSpec, ctx: WorkerContext): Promise<AgentResult> {
    if (ctx.signal.aborted) throw new AgentInterrupted()
    if (!this.socket) {
      throw new AgentError({
        provider: PROVIDER,
        code: "no_socket",
        message: "amp provider requires the Amp omegacode plugin (OMEGACODE_AMP_SOCKET is not set); run this workflow from Amp via the omegacode_run_workflow tool",
      })
    }
    if (!spec.model) {
      throw new AgentError({ provider: PROVIDER, code: "missing_model", message: "amp provider requires a model" })
    }
    // Fail closed on everything this backend cannot honestly enforce. The Amp plugin runs the turn
    // inside the user's Amp CLI: there is no OS confinement to hand it, no approval channel back to
    // omegacode, and no turn cap — so accept only the spec that matches what actually happens.
    if (spec.sandbox !== "danger-full-access") {
      throw new AgentError({
        provider: PROVIDER,
        code: "sandbox_unsupported",
        message: `amp cannot enforce sandbox "${spec.sandbox}": Amp agent tools are not OS-confined; set sandbox danger-full-access explicitly to accept unconfined execution`,
        retryable: false,
      })
    }
    if (spec.approval !== "never") {
      throw new AgentError({
        provider: PROVIDER,
        code: "unsupported_option",
        message: `amp turns run inside the Amp CLI and cannot surface approval requests to omegacode — use approval: "never" with provider "amp"`,
        retryable: false,
      })
    }
    if (spec.maxTurns !== undefined) {
      throw new AgentError({
        provider: PROVIDER,
        code: "unsupported_option",
        message: "amp does not support maxTurns; omit it or use the claude-code provider",
        retryable: false,
      })
    }
    if (spec.schema) {
      try {
        assertValidSchema(spec.schema)
      } catch (err) {
        throw new AgentError({ provider: PROVIDER, code: "invalid_schema", message: `output schema does not compile: ${(err as Error).message}` })
      }
    }

    const working = await this.runTurn({
      callId: randomUUID(),
      prompt: spec.prompt,
      model: spec.model,
      effort: mapEffort(spec.effort),
      instructions: composeInstructions(spec),
    }, ctx)
    if (!spec.schema) return { text: working, status: "completed", usage: emptyUsage() }

    const extraction = await this.runTurn({
      callId: randomUUID(),
      prompt: extractionPrompt(spec, working),
      model: spec.model,
      effort: "low",
      instructions: composeInstructions(spec),
    }, ctx)
    let structured: unknown
    try {
      structured = parseJsonLoose(extraction)
    } catch {
      structured = undefined
    }
    return { text: extraction, structured, status: "completed", usage: emptyUsage() }
  }

  async shutdown(): Promise<void> {
    this.client?.close()
    this.client = null
    this.active.clear()
  }

  private async runTurn(
    request: {
      callId: string
      prompt: string
      model: string
      effort?: AmpEffort
      instructions?: string
    },
    ctx: WorkerContext,
  ): Promise<string> {
    const client = this.getClient()
    this.active.set(request.callId, { ctx })
    let onAbort: (() => void) | undefined
    const abort = new Promise<never>((_, reject) => {
      onAbort = (): void => {
        try {
          client.notify("cancelAgent", { callId: request.callId })
        } catch {
          // The interrupted result remains authoritative if the transport died concurrently.
        }
        reject(new AgentInterrupted())
      }
      ctx.signal.addEventListener("abort", onAbort, { once: true })
    })
    try {
      const result = await Promise.race([
        client.request("runAgent", { ...request, timeoutMs: AGENT_TIMEOUT_MS }),
        abort,
      ])
      if (!isObject(result) || typeof result.text !== "string") {
        throw new AgentError({ provider: PROVIDER, code: "agent_failed", message: "amp plugin returned an invalid runAgent response" })
      }
      return result.text
    } catch (err) {
      if (err instanceof AgentInterrupted || err instanceof AgentError) throw err
      if (err instanceof SocketTransportError) {
        throw new AgentError({ provider: PROVIDER, code: "transport", message: err.message, retryable: true })
      }
      if (err instanceof JsonRpcResponseError) {
        throw new AgentError({ provider: PROVIDER, code: "agent_failed", message: err.message })
      }
      throw new AgentError({ provider: PROVIDER, code: "agent_failed", message: err instanceof Error ? err.message : String(err) })
    } finally {
      if (onAbort) ctx.signal.removeEventListener("abort", onAbort)
      this.active.delete(request.callId)
    }
  }

  private getClient(): JsonRpcSocketClient {
    if (this.client) return this.client
    const client: JsonRpcSocketClient = new JsonRpcSocketClient({
      socketPath: this.socket!,
      requestTimeoutMs: AGENT_TIMEOUT_MS + 5000,
      onNotification: (method, params) => this.onNotification(method, params),
      // A dead connection must not poison the worker (mirrors CodexWorker.onProcessGone): drop the
      // client so the NEXT runAgent dials the socket again. Without this, every later turn hits the
      // same dead client and the retryable transport error we report can never actually recover.
      // Guarded on identity so a late 'close' from a superseded client cannot clear a live one.
      onConnectionGone: () => {
        if (this.client === client) this.client = null
      },
    })
    this.client = client
    return client
  }

  private onNotification(method: string, params: unknown): void {
    if (!isObject(params) || typeof params.callId !== "string") return
    const active = this.active.get(params.callId)
    if (!active) return
    if (method === "agentThread" && typeof params.threadID === "string") {
      active.ctx.onProgress({ kind: "phase", phase: `amp-thread:${params.threadID}` })
    } else if (method === "progress" && params.kind === "text" && typeof params.text === "string") {
      active.ctx.onProgress({ kind: "text", text: params.text })
    } else if (method === "progress" && params.kind === "tool") {
      active.ctx.onProgress({
        kind: "tool",
        ...(typeof params.id === "string" ? { id: params.id } : {}),
        name: typeof params.name === "string" ? params.name : "tool",
        ...(params.input === undefined ? {} : { input: params.input }),
      })
    }
  }
}

function mapEffort(effort: Effort | undefined): AmpEffort | undefined {
  return effort === "ultra" ? "max" : effort
}

function composeInstructions(spec: AgentSpec): string {
  const lines = [
    spec.instructions,
    `Operate only within \`${spec.cwd}\`; treat it as your working directory for every command and file operation.`,
  ]
  return lines.filter((line): line is string => line !== undefined && line.length > 0).join("\n")
}

function extractionPrompt(spec: AgentSpec, workingText: string): string {
  return (
    `Earlier you produced this answer:\n\n${workingText}\n\n` +
    "Return that answer as a single JSON value that conforms to the following JSON Schema. " +
    "Output ONLY the JSON — no prose, no explanation, no code fences.\n\nSchema:\n" +
    JSON.stringify(spec.schema)
  )
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
