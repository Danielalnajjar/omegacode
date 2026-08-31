// Minimal terminal renderer: prints a readable line stream to stderr as events arrive.
// (A live in-place tree is a follow-up; this is correct and dependency-free.)

import type { WorkflowEvent } from "./events.js"

const C = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
}

export class TerminalRenderer {
  private readonly enabled: boolean
  // The runtime re-emits `running` on every tool/usage progress event; only the first transition
  // to running should print a line (otherwise the stream fills with duplicate "·" rows).
  private readonly running = new Set<number>()
  // Terminal rows (done/failed) also print once per agent: worktree teardown runs AFTER the
  // terminal event, so preserved-worktree fields arrive on a trailing event that re-states the
  // terminal state — that trailing event must not duplicate the ✓/✗ row.
  private readonly finished = new Set<number>()
  private readonly worktreeShown = new Set<number>()
  constructor(opts: { enabled?: boolean } = {}) {
    this.enabled = opts.enabled ?? true
  }

  handle = (e: WorkflowEvent): void => {
    if (!this.enabled) return
    switch (e.type) {
      case "run":
        if (e.status === "started") this.write(C.bold(`\n▶ workflow ${e.runId}\n`))
        else this.write((e.status === "completed" ? C.green : C.red)(`\n${e.status === "completed" ? "✓" : "✗"} ${e.status}${e.error ? ": " + e.error : ""}\n`))
        break
      case "phase":
        // Pending events announce declared-but-unreached phases (for the viewer); the header
        // prints when the phase is actually entered, so it lands above its agents in the stream.
        if (!e.pending) this.write(C.cyan(`\n┌ ${e.title}\n`))
        break
      case "log":
        this.write(C.dim(`❯ ${e.message}\n`))
        break
      case "agent":
        if (e.state === "running") {
          if (!this.running.has(e.index)) {
            this.running.add(e.index)
            this.write(C.dim(`  · [${e.index}] ${e.label} (${this.who(e)})…\n`))
          }
        } else if (e.state === "done") {
          if (!this.finished.has(e.index)) {
            this.finished.add(e.index)
            this.running.delete(e.index)
            this.write(`  ${C.green("✓")} [${e.index}] ${e.label}${e.claudeProfileLabel ? C.dim(` · ${e.claudeProfileLabel}`) : ""}${e.cached ? C.dim(" (cached)") : ""} ${C.dim(this.stats(e))}\n`)
          }
        } else if (e.state === "failed") {
          if (!this.finished.has(e.index)) {
            this.finished.add(e.index)
            this.running.delete(e.index)
            this.write(`  ${C.red("✗")} [${e.index}] ${e.label} ${C.red("— " + (e.error ?? "failed"))}\n`)
          }
        }
        this.maybeWorktree(e)
        break
    }
  }

  private who(e: Extract<WorkflowEvent, { type: "agent" }>): string {
    return e.model ? `${e.provider}:${e.model}` : e.provider
  }

  /** Surface where a preserved worktree's edits live (branch + path), once per agent. */
  private maybeWorktree(e: Extract<WorkflowEvent, { type: "agent" }>): void {
    if (!e.worktreeBranch && !e.worktreePath) return
    if (this.worktreeShown.has(e.index)) return
    this.worktreeShown.add(e.index)
    const where = [e.worktreeBranch && `branch ${e.worktreeBranch}`, e.worktreePath && `at ${e.worktreePath}`]
      .filter(Boolean)
      .join(" ")
    this.write(`  ${C.cyan("⎇")} [${e.index}] ${e.label} ${C.dim(`— worktree preserved: ${where}`)}\n`)
  }

  private stats(e: Extract<WorkflowEvent, { type: "agent" }>): string {
    const parts: string[] = []
    if (e.durationMs != null) parts.push(fmtDur(e.durationMs))
    const tok = (e.inputTokens ?? 0) + (e.outputTokens ?? 0)
    if (tok) parts.push(`${tok} tok`)
    return parts.join(" · ")
  }

  private write(s: string): void {
    process.stderr.write(s)
  }

  stop(): void {}
}

export function fmtDur(ms: number | undefined): string {
  if (ms == null) return ""
  if (ms < 1000) return `${ms}ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)}s`
  return `${Math.floor(s / 60)}m${Math.round(s % 60)}s`
}
