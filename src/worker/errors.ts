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

/** Run `fn`, retrying on retryable AgentErrors with exponential backoff. */
export async function withRetry<T>(
  fn: () => Promise<T>,
  signal: AbortSignal,
  opts: RetryOptions = {},
): Promise<T> {
  const attempts = opts.attempts ?? 4
  const base = opts.baseMs ?? 1000
  const max = opts.maxMs ?? 30_000
  let lastErr: unknown
  for (let i = 0; i < attempts; i++) {
    if (signal.aborted) throw new AgentInterrupted()
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      if (!(err instanceof AgentError) || !err.retryable || i === attempts - 1) throw err
      const delay = Math.min(max, base * 2 ** i)
      await opts.onRetry?.({ attempt: i + 2, maxAttempts: attempts, delayMs: delay, error: err })
      await sleep(delay, signal)
    }
  }
  throw lastErr
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
