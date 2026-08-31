import { test } from "node:test"
import assert from "node:assert/strict"
import { TerminalRenderer, fmtDur } from "../src/runtime/progress.ts"
import type { WorkflowEvent } from "../src/runtime/events.ts"

function capture(fn: (r: TerminalRenderer) => void): string {
  const orig = process.stderr.write.bind(process.stderr)
  let out = ""
  // @ts-expect-error narrow override for the test
  process.stderr.write = (s: string) => {
    out += s
    return true
  }
  try {
    fn(new TerminalRenderer())
  } finally {
    process.stderr.write = orig
  }
  return out
}

function agentEvent(over: Partial<Extract<WorkflowEvent, { type: "agent" }>>): WorkflowEvent {
  return {
    t: 0,
    type: "agent",
    index: 0,
    label: "L",
    provider: "codex",
    state: "running",
    ...over,
  } as WorkflowEvent
}

test("done rows include the authored Claude subscription name", () => {
  const out = capture((r) => {
    r.handle(agentEvent({ index: 1, label: "retrieve:Q1", state: "running" }))
    r.handle(agentEvent({ index: 1, label: "retrieve:Q1", state: "done", claudeProfileLabel: "Work Max" }))
  })
  assert.match(out, /retrieve:Q1.*Work Max/)
})

test("M17: only the first running transition prints a line (no duplicate running rows)", () => {
  const out = capture((r) => {
    r.handle(agentEvent({ index: 1, state: "running" }))
    r.handle(agentEvent({ index: 1, state: "running", lastTool: "bash" }))
    r.handle(agentEvent({ index: 1, state: "running", inputTokens: 10, outputTokens: 5 }))
  })
  const runningLines = out.split("\n").filter((l) => l.includes("· [1]"))
  assert.equal(runningLines.length, 1)
})

test("M17: distinct agents each print their own running line", () => {
  const out = capture((r) => {
    r.handle(agentEvent({ index: 1, state: "running" }))
    r.handle(agentEvent({ index: 2, state: "running" }))
    r.handle(agentEvent({ index: 1, state: "running", lastTool: "x" }))
  })
  assert.equal(out.split("\n").filter((l) => l.includes("· [1]")).length, 1)
  assert.equal(out.split("\n").filter((l) => l.includes("· [2]")).length, 1)
})

const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "")

test("done and failed transitions still render once", () => {
  const out = stripAnsi(
    capture((r) => {
      r.handle(agentEvent({ index: 1, state: "running" }))
      r.handle(agentEvent({ index: 1, state: "done", durationMs: 1200 }))
      r.handle(agentEvent({ index: 2, state: "running" }))
      r.handle(agentEvent({ index: 2, state: "failed", error: "boom" }))
    }),
  )
  assert.match(out, /✓ \[1\]/)
  assert.match(out, /✗ \[2\]/)
  assert.match(out, /boom/)
})

test("L14: a preserved worktree's branch and path are surfaced to the user", () => {
  const out = stripAnsi(
    capture((r) => {
      r.handle(agentEvent({ index: 1, state: "running" }))
      r.handle(agentEvent({ index: 1, state: "done", durationMs: 5, worktreeBranch: "aw/run-1", worktreePath: "/tmp/wt/run-1" }))
    }),
  )
  assert.match(out, /worktree preserved: branch aw\/run-1 at \/tmp\/wt\/run-1/)
})

test("L14: a trailing terminal event carrying worktree fields doesn't duplicate the done row", () => {
  // Teardown runs AFTER the terminal event, so the runtime re-states `done` on a trailing event
  // to attach the preserved-worktree fields. Exactly one ✓ row, exactly one worktree row.
  const out = stripAnsi(
    capture((r) => {
      r.handle(agentEvent({ index: 1, state: "running" }))
      r.handle(agentEvent({ index: 1, state: "done", durationMs: 5 }))
      r.handle(agentEvent({ index: 1, state: "done", durationMs: 5, worktreeBranch: "aw/run-1", worktreePath: "/tmp/wt/run-1" }))
    }),
  )
  assert.equal(out.split("\n").filter((l) => l.includes("✓ [1]")).length, 1)
  assert.equal(out.split("\n").filter((l) => l.includes("worktree preserved")).length, 1)
})

test("L14: a failed agent's preserved worktree is surfaced without duplicating the ✗ row", () => {
  const out = stripAnsi(
    capture((r) => {
      r.handle(agentEvent({ index: 2, state: "running" }))
      r.handle(agentEvent({ index: 2, state: "failed", error: "boom" }))
      r.handle(agentEvent({ index: 2, state: "failed", error: "boom", worktreeBranch: "aw/run-2", worktreePath: "/tmp/wt/run-2" }))
    }),
  )
  assert.equal(out.split("\n").filter((l) => l.includes("✗ [2]")).length, 1)
  assert.match(out, /worktree preserved: branch aw\/run-2 at \/tmp\/wt\/run-2/)
})

test("L14: the worktree row prints once even if the fields repeat across events", () => {
  const out = stripAnsi(
    capture((r) => {
      r.handle(agentEvent({ index: 1, state: "done", worktreeBranch: "aw/x", worktreePath: "/p" }))
      r.handle(agentEvent({ index: 1, state: "done", worktreeBranch: "aw/x", worktreePath: "/p" }))
    }),
  )
  assert.equal(out.split("\n").filter((l) => l.includes("worktree preserved")).length, 1)
})

test("L14: agents without worktree fields print no worktree row (clean teardown)", () => {
  const out = stripAnsi(
    capture((r) => {
      r.handle(agentEvent({ index: 1, state: "running" }))
      r.handle(agentEvent({ index: 1, state: "done", durationMs: 5 }))
    }),
  )
  assert.doesNotMatch(out, /worktree preserved/)
})

test("a disabled renderer prints nothing", () => {
  const orig = process.stderr.write.bind(process.stderr)
  let out = ""
  // @ts-expect-error test override
  process.stderr.write = (s: string) => {
    out += s
    return true
  }
  try {
    const r = new TerminalRenderer({ enabled: false })
    r.handle(agentEvent({ index: 1, state: "running" }))
    r.handle({ t: 0, type: "log", message: "x" })
  } finally {
    process.stderr.write = orig
  }
  assert.equal(out, "")
})

test("run / phase / log events render", () => {
  const out = capture((r) => {
    r.handle({ t: 0, type: "run", status: "started", runId: "wf_1" })
    r.handle({ t: 0, type: "phase", index: 1, title: "Plan" })
    r.handle({ t: 0, type: "log", message: "note" })
    r.handle({ t: 0, type: "run", status: "completed", runId: "wf_1" })
  })
  assert.match(out, /workflow wf_1/)
  assert.match(out, /Plan/)
  assert.match(out, /note/)
  assert.match(out, /completed/)
})

test("pending phase announcements don't print; the actual entry does", () => {
  const out = capture((r) => {
    r.handle({ t: 0, type: "phase", index: 1, title: "Plan", pending: true })
    r.handle({ t: 0, type: "phase", index: 2, title: "Build", pending: true })
    r.handle({ t: 0, type: "phase", index: 1, title: "Plan" })
  })
  // Build was only declared, never entered — no header. Plan prints exactly once, on entry.
  assert.doesNotMatch(out, /Build/)
  assert.equal(out.split("\n").filter((l) => l.includes("Plan")).length, 1)
})

test("fmtDur formats sub-second, seconds, and minutes", () => {
  assert.equal(fmtDur(undefined), "")
  assert.equal(fmtDur(500), "500ms")
  assert.equal(fmtDur(1500), "1.5s")
  assert.equal(fmtDur(65000), "1m5s")
})
