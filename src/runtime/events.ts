// The events.jsonl record schema — feeds both the terminal renderer and the viewer server.
// journal.jsonl is the resume log (completed results); events.jsonl is the observability log
// (live state, including in-flight and failed agents).

import type { ProviderId } from "../dsl/types.js"

export type AgentState = "queued" | "running" | "done" | "failed" | "skipped"

export type WorkflowEvent =
  | { t: number; type: "run"; status: "started" | "completed" | "failed" | "interrupted"; runId: string; workflowFile?: string; workflowName?: string; error?: string }
  /**
   * `pending: true` marks a phase declared in meta.phases but not yet entered by phase().
   * Declared phases are announced up front (so the viewer can show the full plan); the same
   * index is re-emitted without `pending` when the workflow actually reaches the phase.
   */
  | { t: number; type: "phase"; index: number; title: string; pending?: boolean }
  | {
      t: number
      type: "agent"
      index: number
      phaseIndex?: number
      phaseTitle?: string
      label: string
      provider: ProviderId
      model?: string
      state: AgentState
      cached?: boolean
      queuedAt?: number
      startedAt?: number
      lastProgressAt?: number
      durationMs?: number
      inputTokens?: number
      outputTokens?: number
      cacheReadInputTokens?: number
      cacheCreationInputTokens?: number
      costUsd?: number
      /** Usage values are known lower bounds because this agent did not report complete usage. */
      usageIncomplete?: true
      lastTool?: string
      promptPreview?: string
      resultPreview?: string
      error?: string
      /**
       * When an agent's worktree is preserved, where its edits live (branch + on-disk path).
       * Teardown runs after the terminal done/failed event, so these typically arrive on a
       * trailing agent event that re-states the terminal state (renderers must not re-print it).
       */
      worktreeBranch?: string
      worktreePath?: string
    }
  | { t: number; type: "log"; message: string }

/** WorkflowEvent without the `t` timestamp — distributive so each variant keeps its own fields. */
export type WorkflowEventInput = WorkflowEvent extends infer E ? (E extends unknown ? Omit<E, "t"> : never) : never

/** Sink the runtime writes events to (one per run). Implemented over an events.jsonl file. */
export interface EventSink {
  emit(event: WorkflowEventInput): void
  close(): Promise<void>
}
