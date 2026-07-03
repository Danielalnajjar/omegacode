// CodexWorker — drives the local `codex app-server` over newline-delimited
// JSON-RPC 2.0 (stdio). The transport (child process, framing, pending-request
// map, stderr drain, timeouts) lives in JsonRpcStdioClient; this file owns only
// the session semantics: thread/start → turn/start → stream notifications →
// settle on turn/completed (or on an `error` notification, or on process death).

import { copyFile, writeFile } from "node:fs/promises"
import { basename, join } from "node:path"

import type { AgentResult, AgentSpec, AgentUsage } from "../dsl/types.js"
import { emptyUsage } from "../dsl/types.js"
import type { Worker, WorkerContext } from "./index.js"
import { AgentError, AgentInterrupted } from "./index.js"
import { toCodexOutputSchema, parseJsonLoose } from "./schema.js"
import { JsonRpcStdioClient, StdioTransportError, JsonRpcResponseError, type SpawnChild } from "./jsonrpc-stdio.js"
import {
  encodeNotification,
  encodeRequest,
  encodeResult,
  toCodexSandboxMode,
  toCodexSandboxPolicy,
  toCodexApprovalPolicy,
  toCodexEffort,
  readThreadId,
  codexErrorCode,
  isRetryableCodexError,
  readInitializeUserAgent,
  isThreadDelta,
  isThreadItem,
  isTokenUsage,
  isTurnCompleted,
  readErrorNotificationThreadId,
  readErrorNotificationMessage,
  type JsonRpcId,
  type InitializeParams,
  type ThreadStartParams,
  type TurnStartParams,
} from "./codex-protocol.js"

export interface CodexWorkerOpts {
  bin?: string
  /** Override the underlying spawn (tests inject a scripted fake child). */
  spawnChild?: SpawnChild
  /** Per-request timeout (ms). 0 disables. Guards against a wedged app-server. */
  requestTimeoutMs?: number
  /** Per-turn no-progress watchdog (ms). 0 disables. Fails a live turn whose
   *  thread has received NO inbound frame (notification or approval request)
   *  for this long, instead of hanging forever. */
  turnStallTimeoutMs?: number
  /** Start provider Codex threads as ephemeral by default. OmegaCode owns run
   *  artifacts itself; persisting each worker as a normal Codex Desktop thread
   *  creates sidebar noise without helping OmegaCode resume. */
  threadEphemeral?: boolean
}

const PROVIDER = "codex" as const

/** Default per-request timeout — ON in production (the factory passes no opts).
 *  Safe for arbitrarily long turns: every request we issue (initialize,
 *  thread/start, turn/start, turn/interrupt) is acked immediately by a healthy
 *  app-server — turn/start returns its turn object within milliseconds while
 *  the turn itself streams via notifications (verified live against codex-cli
 *  0.137.0; thread/start is the slowest at a few seconds while MCP servers
 *  boot). Only a wedged server fails to ack. (M30) */
export const DEFAULT_REQUEST_TIMEOUT_MS = 60_000

/** Default per-turn no-progress watchdog — ON in production. Sized to exceed
 *  the longest expected silent stretch INSIDE a healthy turn: a quiet command
 *  emits no notifications for its entire runtime (verified live: `sleep 8` →
 *  8s of total silence between item/started and the next frame), so this must
 *  comfortably cover long quiet builds/tests — not chat latency. A real hang
 *  is permanent; detecting it in 30 minutes still beats a run that never
 *  settles. (M30) */
export const DEFAULT_TURN_STALL_TIMEOUT_MS = 30 * 60_000

/** Hard wall-clock ceiling for the silent EXTRACTION turn. Extraction only
 *  reformats content the working turn already produced, so it should finish in
 *  minutes. The stall watchdog alone cannot bound it: a turn that keeps
 *  trickling notifications (reasoning deltas) resets the watchdog forever while
 *  writing nothing to the transcript — observed live as a task stuck "running"
 *  with a text-complete transcript and no answer file. */
export const DEFAULT_EXTRACTION_TURN_TIMEOUT_MS = 15 * 60_000

/** Provider-side Codex threads are an implementation detail of an OmegaCode run.
 *  Keeping them ephemeral prevents worker sessions from being persisted into the
 *  user's normal Codex Desktop thread store while preserving OmegaCode's own
 *  events/journal/transcripts/result files. */
export const DEFAULT_THREAD_EPHEMERAL = true

/** The silent second-turn prompt that extracts the final structured answer. */
const EXTRACTION_PROMPT =
  "Now return your final answer as a single JSON value that conforms to the required output schema. Output only the JSON — no prose, no explanation, no code fences."

function textInput(text: string): TurnStartParams["input"] {
  return [{ type: "text", text, text_elements: [] }]
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

/** Per-thread turn state accumulated while a turn streams. */
interface TurnState {
  threadId: string
  deltaText: string
  finalMessage?: string
  usage: AgentUsage
  resolve: (result: AgentResult) => void
  reject: (err: Error) => void
  settled: boolean
  ctx: WorkerContext
  sandbox: AgentSpec["sandbox"]
  cwd: string
  /** Pending best-effort host-side writes (e.g. image artifacts) to await before settling. */
  pendingWrites: Array<Promise<void>>
  /** Whether to forward this turn's messages to the live transcript. The silent
   *  schema-extraction turn (two-phase structured output) sets this false. */
  forwardProgress: boolean
  /** No-progress watchdog: re-armed on every inbound frame that touches this
   *  turn's thread, cleared on settle. Fires → the turn fails as stalled. (M30) */
  watchdog?: ReturnType<typeof setTimeout>
}

export class CodexWorker implements Worker {
  readonly id = PROVIDER
  private readonly bin: string
  private readonly spawnChild?: SpawnChild
  private readonly requestTimeoutMs: number
  private readonly turnStallTimeoutMs: number
  private readonly threadEphemeral: boolean
  private client: JsonRpcStdioClient | null = null
  private initPromise: Promise<void> | null = null
  /** The handshaked server's userAgent ("…/0.137.0 (…)") — quoted in drift and
   *  stall errors so a protocol mismatch names the exact server build. (M30) */
  private serverUserAgent: string | null = null
  /** Active turns keyed by providerThreadId. */
  private readonly turns = new Map<string, TurnState>()
  private shuttingDown = false

  constructor(opts: CodexWorkerOpts = {}) {
    this.bin = opts.bin ?? "codex"
    this.spawnChild = opts.spawnChild
    this.requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    this.turnStallTimeoutMs = opts.turnStallTimeoutMs ?? DEFAULT_TURN_STALL_TIMEOUT_MS
    this.threadEphemeral = opts.threadEphemeral ?? DEFAULT_THREAD_EPHEMERAL
  }

  async runAgent(spec: AgentSpec, ctx: WorkerContext): Promise<AgentResult> {
    if (ctx.signal.aborted) throw new AgentInterrupted()
    // codex maps reasoning effort, sandbox, approval and schema; it has no
    // turn-cap concept. Reject maxTurns explicitly rather than silently ignore it.
    if (spec.maxTurns !== undefined) {
      throw new AgentError({
        provider: PROVIDER,
        code: "unsupported_option",
        message: "codex does not support maxTurns; omit it or use the claude-code provider",
      })
    }
    await this.ensureStarted()

    // 1. thread/start → obtain providerThreadId.
    const startParams: ThreadStartParams = {
      cwd: spec.cwd,
      ...(spec.model ? { model: spec.model } : {}),
      approvalPolicy: toCodexApprovalPolicy(spec.sandbox, spec.approval),
      sandbox: toCodexSandboxMode(spec.sandbox),
      ...(spec.instructions ? { developerInstructions: spec.instructions } : {}),
      experimentalRawEvents: false,
      persistExtendedHistory: false,
      ephemeral: this.threadEphemeral,
    }
    const startResult = await this.request("thread/start", startParams)
    const threadId = readThreadId(startResult)
    if (!threadId) {
      throw new AgentError({
        provider: PROVIDER,
        code: "no_thread_id",
        message: "codex thread/start did not return a thread id",
      })
    }

    // 2. Two-phase structured output — match the native Claude SDK behavior.
    //    A free-form WORKING turn (no schema → prose + tools, streamed to the
    //    transcript), then — only when a schema is set — a silent EXTRACTION turn
    //    constrained by outputSchema that emits just the final JSON. Codex's
    //    outputSchema otherwise constrains EVERY assistant message in the turn.
    const baseTurn = {
      threadId,
      approvalPolicy: toCodexApprovalPolicy(spec.sandbox, spec.approval),
      sandboxPolicy: toCodexSandboxPolicy(spec.sandbox, spec.cwd),
      ...(spec.model ? { model: spec.model } : {}),
      ...(toCodexEffort(spec.effort) ? { effort: toCodexEffort(spec.effort) } : {}),
    }

    const working = await this.runTurn(ctx, spec.sandbox, spec.cwd, { ...baseTurn, input: textInput(spec.prompt) }, true)
    if (!spec.schema) return working

    // The extraction turn runs under its own hard deadline (see the constant's
    // doc comment). On expiry the turn is interrupted and surfaced as a
    // retryable AgentError so the schema-repair/retry ladder gets a fresh
    // attempt instead of the task hanging as "running" forever.
    const extractionController = new AbortController()
    let extractionTimedOut = false
    const onParentAbort = () => extractionController.abort(ctx.signal.reason)
    if (ctx.signal.aborted) extractionController.abort(ctx.signal.reason)
    else ctx.signal.addEventListener("abort", onParentAbort)
    const extractionTimer = setTimeout(() => {
      extractionTimedOut = true
      extractionController.abort(new Error("extraction turn deadline"))
    }, DEFAULT_EXTRACTION_TURN_TIMEOUT_MS)
    let extraction: AgentResult
    try {
      extraction = await this.runTurn(
        { ...ctx, signal: extractionController.signal },
        spec.sandbox,
        spec.cwd,
        { ...baseTurn, input: textInput(EXTRACTION_PROMPT), outputSchema: toCodexOutputSchema(spec.schema) },
        false,
        // Seed with the working turn's usage so it is not lost if the extraction
        // turn emits no tokenUsage update of its own (see H5 note below).
        working.usage,
      )
    } catch (error) {
      if (extractionTimedOut && error instanceof AgentInterrupted) {
        throw new AgentError({
          provider: PROVIDER,
          code: "extraction_stall",
          message: `codex extraction turn produced no completion within ${DEFAULT_EXTRACTION_TURN_TIMEOUT_MS}ms — failing instead of hanging forever`,
          retryable: true,
          usage: working.usage,
        })
      }
      throw error
    } finally {
      clearTimeout(extractionTimer)
      ctx.signal.removeEventListener("abort", onParentAbort)
    }
    let structured: unknown
    try {
      structured = parseJsonLoose(extraction.text)
    } catch {
      structured = undefined
    }
    // Token usage (H5) — semantics verified against codex-rs protocol.rs
    // TokenUsageInfo: `tokenUsage.last` is the LAST MODEL REQUEST's usage (a
    // turn with tool calls makes many requests, one update each) and
    // `tokenUsage.total` is THREAD-cumulative (append_last_usage: total += last;
    // last = clone). Each turn's `usage` here carries the thread-cumulative
    // `total` as of that turn's end, so the extraction turn's usage already
    // includes the working turn — report it alone. Summing the two turns would
    // double-count `total`; summing `last` would undercount multi-request turns.
    return {
      text: extraction.text,
      structured,
      status: "completed",
      usage: extraction.usage,
    }
  }

  /** Run one codex turn on an existing thread; resolves on turn completion. */
  private runTurn(
    ctx: WorkerContext,
    sandbox: AgentSpec["sandbox"],
    cwd: string,
    turnParams: TurnStartParams,
    forwardProgress: boolean,
    seedUsage?: AgentUsage,
  ): Promise<AgentResult> {
    const { threadId } = turnParams
    let onAbort: (() => void) | undefined
    const p = new Promise<AgentResult>((resolve, reject) => {
      const state: TurnState = {
        threadId,
        deltaText: "",
        usage: seedUsage ?? emptyUsage(),
        resolve,
        reject,
        settled: false,
        ctx,
        sandbox,
        cwd,
        pendingWrites: [],
        forwardProgress,
      }
      this.turns.set(threadId, state)
      // Arm the no-progress watchdog for the whole turn lifetime — the
      // request timeout only guards the turn/start ack, not the (arbitrarily
      // long) ack→turn/completed gap that notifications must keep alive. (M30)
      this.touchTurn(state)
      onAbort = () => {
        try {
          this.send(encodeRequest(this.client?.allocId() ?? 0, "turn/interrupt", { threadId }))
        } catch {
          // child already gone; the reject below settles the turn anyway
        }
        this.settleReject(threadId, new AgentInterrupted())
      }
      if (ctx.signal.aborted) {
        onAbort()
        return
      }
      ctx.signal.addEventListener("abort", onAbort)
      this.request("turn/start", turnParams).catch((err: unknown) => {
        this.settleReject(threadId, this.toAgentError(err))
      })
    })
    return p.finally(() => {
      this.turns.delete(threadId)
      if (onAbort) ctx.signal.removeEventListener("abort", onAbort)
    })
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true
    const client = this.client
    this.client = null
    this.initPromise = null
    const closeErr = new AgentError({
      provider: PROVIDER,
      code: "shutdown",
      message: "codex worker shut down",
      retryable: true,
    })
    // Settle in-flight turns first, then tear down the transport (which rejects
    // any remaining pending requests).
    for (const threadId of [...this.turns.keys()]) {
      this.settleReject(threadId, closeErr)
    }
    if (client) client.shutdown()
  }

  // -------------------------------------------------------------------------
  // Process lifecycle + handshake
  // -------------------------------------------------------------------------

  private ensureStarted(): Promise<void> {
    if (this.initPromise) return this.initPromise
    this.initPromise = this.startAndHandshake().catch((err: unknown) => {
      this.initPromise = null
      throw err
    })
    return this.initPromise
  }

  private async startAndHandshake(): Promise<void> {
    const client = new JsonRpcStdioClient({
      bin: this.bin,
      args: ["app-server"],
      spawnChild: this.spawnChild,
      requestTimeoutMs: this.requestTimeoutMs,
      onServerRequest: (id, method, params) => this.handleServerRequest(id, method, params),
      onNotification: (method, params) => this.handleNotification(method, params),
      onProcessGone: (err) => this.onProcessGone(err),
    })
    this.client = client
    this.shuttingDown = false
    this.serverUserAgent = null

    try {
      client.start()
    } catch (err) {
      this.client = null
      throw this.spawnError(err)
    }

    const initParams: InitializeParams = {
      clientInfo: { name: "omegacode", version: "0.0.1" },
      capabilities: { experimentalApi: true },
    }
    const initResult = await this.request("initialize", initParams)
    // Version check (M30): the InitializeResponse's one stable surface is
    // `userAgent` ("…/<server version> (…)"); the protocol has no version
    // field or capability echo to negotiate on (verified live against
    // codex-cli 0.137.0). Require it — a peer that answers initialize without
    // a userAgent is not a codex app-server — and keep it so later drift and
    // stall failures name the exact server build. A server too old for the v2
    // thread API still passes this check, but then fails loudly at
    // thread/start with a method-not-found rpc_error rather than hanging.
    const userAgent = readInitializeUserAgent(initResult)
    if (!userAgent) {
      throw new AgentError({
        provider: PROVIDER,
        code: "initialize_failed",
        message: "codex app-server returned an initialize result without a userAgent (protocol mismatch?) — upgrade the codex CLI or pin one compatible with omegacode",
        retryable: false,
      })
    }
    this.serverUserAgent = userAgent
    try {
      this.send(encodeNotification("initialized"))
    } catch (err) {
      throw this.toAgentError(err)
    }
  }

  /** Classify any spawn/process error. A missing or non-executable binary
   *  (ENOENT, Windows .cmd shim, "not recognized") is a CONFIG error, not a
   *  transient one — retrying never helps, so it is non-retryable. (L2) */
  private spawnError(err: unknown): AgentError {
    const message = err instanceof Error ? err.message : String(err)
    const code = err instanceof StdioTransportError ? err.code : "spawn_failed"
    const notFound = /ENOENT|not found|not recognized|EACCES/i.test(message)
    return new AgentError({
      provider: PROVIDER,
      code: notFound ? "binary_not_found" : code,
      message: notFound
        ? `cannot execute "${this.bin} app-server" — is the codex CLI installed and on PATH? (${message})`
        : `failed to spawn ${this.bin} app-server: ${message}`,
      retryable: !notFound,
    })
  }

  private onProcessGone(err: StdioTransportError): void {
    if (this.shuttingDown) return
    // Route through spawnError so an ENOENT arriving as an async 'error' event
    // is classified as a non-retryable binary_not_found, same as a sync spawn
    // throw. (L2)
    const wrapped = this.spawnError(err)
    this.client = null
    this.initPromise = null
    // The transport already rejected its pending requests; settle live turns.
    for (const threadId of [...this.turns.keys()]) {
      this.settleReject(threadId, wrapped)
    }
  }

  // -------------------------------------------------------------------------
  // Server-initiated requests (approvals) — FAIL CLOSED.
  // -------------------------------------------------------------------------

  private handleServerRequest(id: JsonRpcId, method: string, params: unknown): void {
    // Replies are best-effort: if the transport died between the server asking
    // and us answering, there is nobody left to answer — never throw from here
    // (we are inside the transport's dispatch path).
    const reply = (result: unknown) => {
      try {
        this.send(encodeResult(id, result))
      } catch {
        // transport gone
      }
    }
    switch (method) {
      case "item/commandExecution/requestApproval":
      case "item/fileChange/requestApproval":
      case "item/permissions/requestApproval": {
        const p = isObject(params) ? params : {}
        const state = typeof p.threadId === "string" ? this.turns.get(p.threadId) : undefined
        // A server-initiated approval is turn progress — re-arm the stall watchdog.
        if (state) this.touchTurn(state)
        // Fail closed: a missing TurnState means we cannot reason about the
        // sandbox this approval belongs to, so decline. (H3)
        if (!state) {
          if (method === "item/permissions/requestApproval") reply({ permissions: {}, scope: "turn" })
          else reply({ decision: "decline" })
          return
        }
        const readOnly = state.sandbox === "read-only"
        // Under codex's on-request policy, a commandExecution approval is the
        // server asking to escalate OUTSIDE the sandbox — declining it for a
        // read-only agent keeps the read-only guarantee real. fileChange and
        // permission grants are write actions, also declined when read-only. (H3)
        const decline = readOnly
        if (method === "item/permissions/requestApproval") {
          // Permission grants take a grant-shaped response; grant nothing extra.
          reply({ permissions: {}, scope: "turn" })
        } else {
          reply({ decision: decline ? "decline" : "accept" })
        }
        return
      }
      default:
        // Unknown server request: answer with an empty result so the server
        // does not block waiting on us.
        reply({})
        return
    }
  }

  // -------------------------------------------------------------------------
  // Notifications
  // -------------------------------------------------------------------------

  private handleNotification(method: string, params: unknown): void {
    // Any notification addressed to a live turn's thread is proof the server is
    // making progress — re-arm that turn's stall watchdog BEFORE shape-checking,
    // so payload drift in a streaming method can never masquerade as a stall.
    // (Thread-less traffic like account/rateLimits/updated is not progress.) (M30)
    if (isObject(params) && typeof params.threadId === "string") {
      const live = this.turns.get(params.threadId)
      if (live) this.touchTurn(live)
    }
    switch (method) {
      case "item/agentMessage/delta": {
        if (!isThreadDelta(params)) return
        const state = this.turns.get(params.threadId)
        if (!state) return
        state.deltaText += params.delta
        if (state.forwardProgress) state.ctx.onProgress({ kind: "text", text: params.delta })
        return
      }
      case "item/reasoning/summaryTextDelta":
      case "item/reasoning/textDelta": {
        if (!isThreadDelta(params)) return
        const state = this.turns.get(params.threadId)
        if (state && state.forwardProgress) state.ctx.onProgress({ kind: "reasoning", text: params.delta })
        return
      }
      case "item/started": {
        if (!isThreadItem(params)) return
        const state = this.turns.get(params.threadId)
        if (!state) return
        const item = params.item
        const name = toolName(item)
        if (name && state.forwardProgress)
          state.ctx.onProgress({ kind: "tool", id: typeof item.id === "string" ? item.id : undefined, name, input: codexToolInput(item) })
        return
      }
      case "item/completed": {
        if (!isThreadItem(params)) return
        const state = this.turns.get(params.threadId)
        if (!state) return
        const item = params.item
        if (item.type === "agentMessage" && typeof item.text === "string") {
          state.finalMessage = item.text
          return
        }
        // Built-in hosted image_generation tool: the host saved a PNG (savedPath) under
        // CODEX_HOME; copy it into the agent's cwd and surface it. (result is raw base64 PNG.)
        if (item.type === "imageGeneration") {
          this.handleImageGeneration(state, item)
          return
        }
        const name = toolName(item)
        if (name && state.forwardProgress) {
          const output =
            typeof item.aggregatedOutput === "string" ? item.aggregatedOutput : typeof item.result === "string" ? item.result : undefined
          state.ctx.onProgress({
            kind: "tool-result",
            id: typeof item.id === "string" ? item.id : undefined,
            name,
            output,
            isError: item.status === "failed" || typeof item.error === "string",
          })
        }
        return
      }
      case "thread/tokenUsage/updated": {
        if (!isTokenUsage(params)) return
        const state = this.turns.get(params.threadId)
        if (!state) return
        // Track the THREAD-cumulative `total` with replace semantics (H5; see
        // the runAgent note). `total` is monotonic per thread, so replacing is
        // idempotent against repeated updates and exact across the many
        // per-request updates a tool-using turn emits — unlike `last`, which
        // only covers the most recent model request.
        const total = params.tokenUsage.total
        if (isObject(total)) {
          state.usage = {
            inputTokens: numberOr(total.inputTokens, state.usage.inputTokens),
            outputTokens: numberOr(total.outputTokens, state.usage.outputTokens),
            costUsd: state.usage.costUsd,
          }
          if (state.forwardProgress)
            state.ctx.onProgress({
              kind: "usage",
              usage: { inputTokens: state.usage.inputTokens, outputTokens: state.usage.outputTokens },
            })
        }
        return
      }
      case "turn/completed": {
        if (!isTurnCompleted(params)) {
          // Drift on the ONE notification that settles a turn: silently
          // dropping it would strand the turn as a permanent hang. (M30)
          this.onTurnCompletedDrift(params)
          return
        }
        this.onTurnCompleted(params)
        return
      }
      case "error": {
        // An `error` notification with no following turn/completed would leave
        // the turn forever unsettled. Settle the matching turn (or all live
        // turns if no threadId is carried). (H2)
        const threadId = readErrorNotificationThreadId(params)
        const message = readErrorNotificationMessage(params)
        const err = new AgentError({ provider: PROVIDER, code: "codex_error", message, retryable: true })
        if (threadId && this.turns.has(threadId)) {
          this.settleReject(threadId, err)
        } else {
          for (const tid of [...this.turns.keys()]) this.settleReject(tid, err)
        }
        return
      }
      default:
        return
    }
  }

  /** Host-side image artifact copy. Awaited before the turn settles so the file
   *  exists by the time the result is journaled; skipped for read-only sandboxes;
   *  the server-supplied id is basename'd so it cannot escape cwd. (M3) */
  private handleImageGeneration(state: TurnState, item: Record<string, unknown>): void {
    if (state.sandbox === "read-only") return
    const rawId = typeof item.id === "string" && item.id.length > 0 ? item.id : "image"
    const id = basename(rawId) || "image"
    const savedPath = typeof item.savedPath === "string" ? item.savedPath : undefined
    const b64 = typeof item.result === "string" ? item.result : undefined
    const dest = join(state.cwd, `${id}.png`)
    const write = (async () => {
      try {
        if (savedPath) await copyFile(savedPath, dest)
        else if (b64) await writeFile(dest, Buffer.from(b64, "base64"))
        else return
        if (state.forwardProgress) state.ctx.onProgress({ kind: "tool-result", id, name: "image_generation", output: `saved image → ${dest}` })
      } catch {
        // best-effort; the agent may also place the file itself
      }
    })()
    state.pendingWrites.push(write)
  }

  private onTurnCompleted(p: { threadId: string; turn: Record<string, unknown> }): void {
    const state = this.turns.get(p.threadId)
    if (!state) return
    const status = typeof p.turn.status === "string" ? p.turn.status : undefined
    if (status === "completed") {
      const result: AgentResult = {
        text: state.finalMessage ?? state.deltaText,
        status: "completed",
        usage: state.usage,
      }
      // Await any in-flight host-side writes (e.g. image artifacts) before
      // resolving so the artifact exists when the result is journaled.
      const writes = state.pendingWrites
      if (writes.length === 0) {
        this.settleResolve(p.threadId, result)
      } else {
        void Promise.allSettled(writes).then(() => this.settleResolve(p.threadId, result))
      }
      return
    }
    if (status === "interrupted") {
      this.settleReject(p.threadId, new AgentInterrupted())
      return
    }
    // failed (or unexpected) → AgentError.
    const turnError = p.turn.error
    const info = isObject(turnError) ? turnError.codexErrorInfo : undefined
    const code = codexErrorCode(info) ?? "turn_failed"
    const message = (isObject(turnError) && typeof turnError.message === "string" && turnError.message) || `codex turn ${status ?? "failed"}`
    this.settleReject(
      p.threadId,
      new AgentError({
        provider: PROVIDER,
        code,
        message,
        retryable: isRetryableCodexError(codexErrorCode(info)),
      }),
    )
  }

  /** A turn/completed we cannot read is protocol drift on the exact frame that
   *  settles a turn. Settle the matching turn — or every live turn when even
   *  the threadId is unreadable — instead of dropping the frame and hanging
   *  forever. Non-retryable: the same binary drifts the same way again. (M30) */
  private onTurnCompletedDrift(params: unknown): void {
    const err = new AgentError({
      provider: PROVIDER,
      code: "protocol_drift",
      message: `codex sent turn/completed in an unrecognized shape (server: ${this.serverUserAgent ?? "unknown"}) — upgrade omegacode or pin a compatible codex CLI`,
      retryable: false,
    })
    const threadId = isObject(params) && typeof params.threadId === "string" ? params.threadId : undefined
    if (threadId !== undefined) {
      this.settleReject(threadId, err)
      return
    }
    for (const tid of [...this.turns.keys()]) this.settleReject(tid, err)
  }

  /** (Re)arm a turn's no-progress watchdog: called at turn start and on every
   *  inbound frame touching the turn's thread; cleared when the turn settles.
   *  Fires only after turnStallTimeoutMs of TOTAL inbound silence — sized to
   *  exceed a long quiet command run, which emits nothing until output/exit. */
  private touchTurn(state: TurnState): void {
    if (this.turnStallTimeoutMs <= 0 || state.settled) return
    if (state.watchdog) clearTimeout(state.watchdog)
    state.watchdog = setTimeout(() => this.onTurnStalled(state.threadId), this.turnStallTimeoutMs)
    // Do not keep the event loop alive purely for a pending watchdog.
    state.watchdog.unref?.()
  }

  private onTurnStalled(threadId: string): void {
    const state = this.turns.get(threadId)
    if (!state || state.settled) return
    // Best-effort interrupt so a half-alive server stops burning tokens.
    try {
      this.send(encodeRequest(this.client?.allocId() ?? 0, "turn/interrupt", { threadId }))
    } catch {
      // child already gone; the reject below settles the turn anyway
    }
    this.settleReject(
      threadId,
      new AgentError({
        provider: PROVIDER,
        code: "turn_stalled",
        message: `codex turn received no notifications for ${this.turnStallTimeoutMs}ms (server: ${this.serverUserAgent ?? "unknown"}) — failing instead of hanging forever`,
        retryable: true,
      }),
    )
  }

  private settleResolve(threadId: string, result: AgentResult): void {
    const state = this.turns.get(threadId)
    if (!state || state.settled) return
    state.settled = true
    if (state.watchdog) clearTimeout(state.watchdog)
    state.resolve(result)
  }

  private settleReject(threadId: string, err: Error): void {
    const state = this.turns.get(threadId)
    if (!state || state.settled) return
    state.settled = true
    if (state.watchdog) clearTimeout(state.watchdog)
    state.reject(err)
  }

  // -------------------------------------------------------------------------
  // Low-level send / request (delegate to the transport)
  // -------------------------------------------------------------------------

  private send(line: string): void {
    const client = this.client
    if (!client) throw new StdioTransportError("not_writable", "codex transport is gone")
    client.send(line)
  }

  private request(method: string, params?: unknown): Promise<unknown> {
    const client = this.client
    if (!client) {
      return Promise.reject(
        new AgentError({ provider: PROVIDER, code: "process_exited", message: "codex transport is gone", retryable: true }),
      )
    }
    return client.request(method, params).catch((err: unknown) => {
      throw this.toAgentError(err)
    })
  }

  private toAgentError(err: unknown): AgentError {
    if (err instanceof AgentError) return err
    if (err instanceof JsonRpcResponseError) {
      return new AgentError({ provider: PROVIDER, code: "rpc_error", message: err.message })
    }
    if (err instanceof StdioTransportError) {
      // A missing/non-executable binary surfacing through any transport path is a
      // non-retryable config error (handshake request rejected by the async
      // ENOENT 'error' event). (L2)
      if (/ENOENT|not found|not recognized|EACCES/i.test(err.message)) return this.spawnError(err)
      // Timeouts and dropped writes are retryable transport faults.
      return new AgentError({ provider: PROVIDER, code: err.code, message: err.message, retryable: true })
    }
    return new AgentError({
      provider: PROVIDER,
      code: "transport",
      message: err instanceof Error ? err.message : String(err),
      retryable: true,
    })
  }
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback
}

function toolName(item: Record<string, unknown>): string | undefined {
  switch (item.type) {
    case "commandExecution":
      return "command"
    case "mcpToolCall":
      return typeof item.tool === "string" ? item.tool : "mcpToolCall"
    case "dynamicToolCall":
      return typeof item.tool === "string" ? item.tool : "dynamicToolCall"
    case "webSearch":
      return "webSearch"
    case "fileChange":
      return "fileChange"
    default:
      return undefined
  }
}

/** Best-effort extraction of a tool/command item's "input" for the chat feed. */
function codexToolInput(item: Record<string, unknown>): unknown {
  if (typeof item.command === "string" || Array.isArray(item.command)) return item.command
  if (item.arguments !== undefined) return item.arguments
  if (Array.isArray(item.changes)) return item.changes
  if (Array.isArray(item.queries)) return item.queries
  return undefined
}
