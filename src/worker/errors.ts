import { setTimeout as delayAsync } from "node:timers/promises"
import { AgentError, AgentInterrupted, type Worker } from "./index.js"
import type { ProviderId } from "../dsl/types.js"

export interface RetryOptions {
  attempts?: number
  baseMs?: number
  maxMs?: number
  onRetry?: (event: RetryEvent) => void | Promise<void>
}

export interface RetryEvent {
  /** The 1-based attempt number that will run after this backoff. */
  attempt: number
  maxAttempts: number
  delayMs: number
  error: AgentError
}

const CODEX_RECONNECT_WINDOW_MS = 120_000
// At the default backoff this permits probes after 1/2/4/8/16/30/30/29s.
const CODEX_RECONNECT_ATTEMPTS = 9

export function isCodexStreamConnectionError(
  code: string | undefined,
): code is "responseStreamConnectionFailed" | "responseStreamDisconnected" {
  return code === "responseStreamConnectionFailed" || code === "responseStreamDisconnected"
}

function isCodexReconnect(error: AgentError): boolean {
  return error.provider === "codex" && (
    isCodexStreamConnectionError(error.code)
    // Codex also reports request-send failures as a generic stream error or
    // an HTTP connection error. Do not extend retries for an HTTP status.
    || ((error.code === "codex_error" || error.code === "httpConnectionFailed")
      && /^(stream disconnected before completion|connection failed): error sending request\b/i.test(error.message))
  )
}

/** Run `fn`, retrying on retryable AgentErrors with exponential backoff.
 *  App-server ingress overloads use full jitter to avoid synchronized retry waves. */
export async function withRetry<T>(
  fn: () => Promise<T>,
  signal: AbortSignal,
  opts: RetryOptions = {},
): Promise<T> {
  const base = opts.baseMs ?? 1000
  const max = opts.maxMs ?? 30_000
  let reconnectDeadline: number | undefined
  for (let attempt = 1; ; attempt++) {
    if (signal.aborted) throw new AgentInterrupted()
    try {
      return await fn()
    } catch (err) {
      if (!(err instanceof AgentError) || !err.retryable) throw err
      const reconnect = opts.attempts === undefined && isCodexReconnect(err)
      const maxAttempts = opts.attempts ?? (reconnect ? CODEX_RECONNECT_ATTEMPTS : 4)
      if (attempt >= maxAttempts) throw err
      let cappedDelay = Math.min(max, base * 2 ** (attempt - 1))
      if (reconnect) {
        const now = Date.now()
        reconnectDeadline ??= now + CODEX_RECONNECT_WINDOW_MS
        if (now >= reconnectDeadline) throw err
        cappedDelay = Math.min(cappedDelay, reconnectDeadline - now)
      }
      const delay = err.code === "server_overloaded"
        ? Math.max(1, Math.floor(Math.random() * cappedDelay) + 1)
        : cappedDelay
      await opts.onRetry?.({ attempt: attempt + 1, maxAttempts, delayMs: delay, error: err })
      await sleep(delay, signal)
    }
  }
}

/** Abort-aware sleep; rejects with AgentInterrupted if the signal fires (or is already aborted). */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return delayAsync(ms, undefined, { signal }).catch(() => {
    throw new AgentInterrupted()
  })
}

export function notImplemented(provider: ProviderId): Worker {
  return {
    id: provider,
    async runAgent() {
      throw new AgentError({ provider, code: "not_implemented", message: `${provider} worker is not implemented yet` })
    },
    async shutdown() {},
  }
}
