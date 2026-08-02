import type { AgentResult, AgentSpec, AgentUsage, ProviderId } from "../dsl/types.js"

/** Conversation/progress signals a worker emits while a turn runs (drives the live chat feed). */
export type WorkerProgress =
  | { kind: "text"; text: string } // assistant message text (chunk or delta)
  | { kind: "reasoning"; text: string } // thinking / reasoning text
  | { kind: "tool"; id?: string; name: string; input?: unknown } // tool / command / file-change use
  | { kind: "tool-result"; id?: string; name?: string; output?: string; isError?: boolean }
  | { kind: "usage"; usage: Partial<AgentUsage> }
  | { kind: "phase"; phase: string } // worker-internal phase marker (e.g. codex working/extraction turn) for observability; consumers may ignore it

export interface WorkerContext {
  signal: AbortSignal
  onProgress: (e: WorkerProgress) => void
}

/** A provider backend: runs one agent turn to completion. */
export interface Worker {
  readonly id: ProviderId
  runAgent(spec: AgentSpec, ctx: WorkerContext): Promise<AgentResult>
  shutdown(): Promise<void>
}

/** Lazily constructs and caches workers by provider and provider-wide launch options. */
export interface WorkerFactory {
  get(id: ProviderId, serviceTier?: string): Worker
  shutdownAll(): Promise<void>
}

/** A worker raised this when a turn failed for a provider reason (after retries). */
export class AgentError extends Error {
  readonly provider: ProviderId
  readonly code: string
  readonly retryable: boolean
  /** Tokens the failed turn consumed, when the provider reported them — failed turns still bill. */
  readonly usage?: AgentUsage
  constructor(args: { provider: ProviderId; code: string; message: string; retryable?: boolean; usage?: AgentUsage }) {
    super(args.message)
    this.name = "AgentError"
    this.provider = args.provider
    this.code = args.code
    this.retryable = args.retryable ?? false
    this.usage = args.usage
  }
}

/** Raised when an agent turn was interrupted (Ctrl-C, cancel, stall-abort). */
export class AgentInterrupted extends Error {
  constructor(message = "agent interrupted") {
    super(message)
    this.name = "AgentInterrupted"
  }
}
