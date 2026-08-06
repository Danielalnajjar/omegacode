// Per-agent transcript: the streaming conversation of one agent, written to
// runs/<runId>/agents/<index>.jsonl (or a journal-key-derived filename). This is the source for the
// viewer's live chat-feed drilldown (observability only — distinct from journal.jsonl, which stores
// the final result for resume).

import { join } from "node:path"
import type { ProviderId } from "../dsl/types.js"
import { JsonlWriter } from "./jsonl-writer.js"
import { runDir } from "./journal.js"

export type ChatChunk =
  | { t: number; kind: "meta"; index: number; label: string; provider: ProviderId; model?: string; prompt: string }
  | { t: number; kind: "text"; text: string }
  | { t: number; kind: "reasoning"; text: string }
  | { t: number; kind: "tool"; id?: string; name: string; input?: unknown }
  | { t: number; kind: "tool-result"; id?: string; name?: string; output?: string; isError?: boolean }
  | { t: number; kind: "status"; state: "running" | "done" | "failed"; error?: string; cached?: boolean }
  // Worker-internal phase marker (amp's thread id, codex's working/extraction turns): journaled for
  // observability so the provider-side thread an agent ran on stays recoverable after the run.
  | { t: number; kind: "phase"; phase: string }

/** A ChatChunk without the `t` timestamp — distributive so each variant keeps its own fields. */
export type ChatChunkInput = ChatChunk extends infer E ? (E extends unknown ? Omit<E, "t"> : never) : never

export function agentsDir(runId: string): string {
  return join(runDir(runId), "agents")
}

export function agentTranscriptPath(runId: string, index: number): string {
  return join(agentsDir(runId), `${index}.jsonl`)
}

/** Path for a transcript named by an opaque file stem (e.g. a journal key) rather than an index. */
export function agentTranscriptPathByName(runId: string, name: string): string {
  return join(agentsDir(runId), `${sanitizeName(name)}.jsonl`)
}

// Coalescing + truncation keep transcripts from exploding (Codex streams token-level text deltas —
// thousands of one-line chunks per answer). Text/reasoning deltas are buffered and flushed as one
// chunk on a boundary; large tool I/O is head+tail truncated.
const TEXT_FLUSH_MS = 120
const TEXT_FLUSH_BYTES = 2048
const TOOL_OUTPUT_MAX = 32 * 1024
const TOOL_INPUT_MAX = 8 * 1024

/** Optional way to override the transcript filename (runtime-core may key it by journal key). */
export interface AgentTranscriptOpts {
  /** Explicit filename stem under runs/<runId>/agents/ (no extension). */
  name?: string
}

export class AgentTranscript {
  private readonly writer: JsonlWriter
  private pending: { kind: "text" | "reasoning"; text: string } | null = null
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(runId: string, index: number, opts: AgentTranscriptOpts = {}) {
    const path = opts.name ? agentTranscriptPathByName(runId, opts.name) : agentTranscriptPath(runId, index)
    // Truncate: a (re-)run of this agent replaces any partial transcript from a prior attempt.
    // Disk errors degrade to best-effort and never crash the run (it's observability-only).
    this.writer = new JsonlWriter(path, { flags: "w" })
  }

  write(chunk: ChatChunkInput): void {
    if (chunk.kind === "text" || chunk.kind === "reasoning") {
      if (this.pending && this.pending.kind !== chunk.kind) this.flushPending()
      if (!this.pending) this.pending = { kind: chunk.kind, text: "" }
      this.pending.text += chunk.text
      if (this.pending.text.length >= TEXT_FLUSH_BYTES) this.flushPending()
      else this.arm()
      return
    }
    this.flushPending()
    if (chunk.kind === "tool-result" && typeof chunk.output === "string") {
      this.writeLine({ ...chunk, output: truncate(chunk.output, TOOL_OUTPUT_MAX) })
    } else if (chunk.kind === "tool" && chunk.input !== undefined) {
      this.writeLine({ ...chunk, input: capInput(chunk.input, TOOL_INPUT_MAX) })
    } else {
      this.writeLine(chunk)
    }
  }

  close(): Promise<void> {
    this.flushPending()
    return this.writer.close()
  }

  private arm(): void {
    if (this.timer) return
    this.timer = setTimeout(() => this.flushPending(), TEXT_FLUSH_MS)
    this.timer.unref?.()
  }

  private flushPending(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (!this.pending) return
    const p = this.pending
    this.pending = null
    this.writeLine({ kind: p.kind, text: p.text })
  }

  private writeLine(chunk: ChatChunkInput): void {
    this.writer.writeRecord({ ...chunk, t: Date.now() } as ChatChunk)
  }
}

/** Head+tail truncation with a marker for large strings. */
function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  const head = Math.floor(max * 0.75)
  const tail = max - head
  return `${s.slice(0, head)}\n…[${s.length - max} chars truncated]…\n${s.slice(s.length - tail)}`
}

/** Cap a (possibly structured) tool input; if its JSON is too big, store a truncated string. */
function capInput(input: unknown, max: number): unknown {
  let s: string
  try {
    s = JSON.stringify(input)
  } catch {
    // Unserializable input (cycles/BigInt) — substitute a placeholder so writeLine never re-throws.
    return "[unserializable tool input]"
  }
  if (typeof s !== "string") return "[unserializable tool input]"
  if (s.length <= max) return input
  return truncate(s, max)
}

/** Keep a key-derived name to a safe single path segment (no separators / traversal). */
function sanitizeName(name: string): string {
  // Map anything outside a safe set to "_", then strip leading dots so the result can never be
  // "."/".." or a hidden-dotfile traversal. The result is always a single path segment.
  const cleaned = name.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "")
  return cleaned.length > 0 ? cleaned : "agent"
}
