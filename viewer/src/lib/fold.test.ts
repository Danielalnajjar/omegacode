import { describe, expect, it } from "vitest"

import { foldEvents, runBaseName } from "./fold"
import type { WorkflowEvent } from "./types"

const RUN = "run-123"

function ev(e: Partial<WorkflowEvent> & Pick<WorkflowEvent, "type" | "t">): WorkflowEvent {
  return e as WorkflowEvent
}

describe("runBaseName (L25: Windows paths)", () => {
  it("takes the last POSIX segment", () => {
    expect(runBaseName("/home/u/proj/review.workflow.ts")).toBe("review.workflow.ts")
  })

  // Regression: fold.ts used split("/") only, so a Windows absolute path rendered as the full path.
  it("takes the last Windows segment", () => {
    expect(runBaseName("C:\\Users\\me\\proj\\review.workflow.ts")).toBe("review.workflow.ts")
    expect(runBaseName("C:\\Users\\me\\proj\\mixed/seps\\file.ts")).toBe("file.ts")
  })

  it("returns the input when there is no separator", () => {
    expect(runBaseName("file.ts")).toBe("file.ts")
  })
})

describe("foldEvents — basic folding", () => {
  it("derives name from a POSIX workflowFile, stripping the suffix", () => {
    const snap = foldEvents(RUN, [
      ev({ type: "run", t: 1, status: "started", workflowFile: "/a/b/review.workflow.ts" }),
    ])
    expect(snap.name).toBe("review")
    expect(snap.status).toBe("started")
    expect(snap.workflowFile).toBe("/a/b/review.workflow.ts")
  })

  it("derives name from a Windows workflowFile (L25)", () => {
    const snap = foldEvents(RUN, [
      ev({ type: "run", t: 1, status: "started", workflowFile: "C:\\proj\\build.ts" }),
    ])
    expect(snap.name).toBe("build")
  })

  it("records the terminal status, endedAt, and error", () => {
    const snap = foldEvents(RUN, [
      ev({ type: "run", t: 1, status: "started" }),
      ev({ type: "run", t: 5, status: "failed", error: "boom" }),
    ])
    expect(snap.status).toBe("failed")
    expect(snap.startedAt).toBe(1)
    expect(snap.endedAt).toBe(5)
    expect(snap.error).toBe("boom")
  })

  it("keeps the latest agent per index and merges missing fields from prev", () => {
    const snap = foldEvents(RUN, [
      ev({ type: "agent", t: 1, index: 0, label: "a0", provider: "codex", state: "running" }),
      ev({ type: "agent", t: 2, index: 0, state: "running", claudeProfileLabel: "Work Max" }),
      ev({ type: "agent", t: 3, index: 0, state: "done", durationMs: 1200, outputTokens: 5 }),
    ])
    expect(snap.agents).toHaveLength(1)
    const a = snap.agents[0]!
    expect(a.state).toBe("done")
    expect(a.label).toBe("a0") // carried from prev
    expect(a.claudeProfileLabel).toBe("Work Max")
    expect(a.durationMs).toBe(1200)
    expect(a.outputTokens).toBe(5)
  })

  it("groups agents under phases and sorts by index", () => {
    const snap = foldEvents(RUN, [
      ev({ type: "phase", t: 1, index: 0, title: "Phase A" }),
      ev({ type: "agent", t: 2, index: 1, label: "second", provider: "codex", state: "done", phaseIndex: 0 }),
      ev({ type: "agent", t: 3, index: 0, label: "first", provider: "codex", state: "done", phaseIndex: 0 }),
    ])
    expect(snap.phases).toHaveLength(1)
    expect(snap.phases[0]!.title).toBe("Phase A")
    expect(snap.phases[0]!.agents.map((a) => a.index)).toEqual([0, 1])
  })

  it("synthesizes a phase when an agent references an unseen phaseIndex", () => {
    const snap = foldEvents(RUN, [
      ev({ type: "agent", t: 1, index: 0, label: "x", provider: "codex", state: "done", phaseIndex: 2, phaseTitle: "Late" }),
    ])
    expect(snap.phases).toHaveLength(1)
    expect(snap.phases[0]!.index).toBe(2)
    expect(snap.phases[0]!.title).toBe("Late")
  })

  it("collects logs in order", () => {
    const snap = foldEvents(RUN, [
      ev({ type: "log", t: 1, message: "one" }),
      ev({ type: "log", t: 2, message: "two" }),
    ])
    expect(snap.logs).toEqual([
      { t: 1, message: "one" },
      { t: 2, message: "two" },
    ])
  })
})

describe("foldEvents — pending (declared) phases", () => {
  it("creates a pending phase from a pending announcement", () => {
    const snap = foldEvents(RUN, [ev({ type: "phase", t: 1, index: 1, title: "Scan", pending: true })])
    expect(snap.phases).toHaveLength(1)
    expect(snap.phases[0]!.pending).toBe(true)
  })

  it("clears pending when the phase is entered (non-pending re-emit of the same index)", () => {
    const snap = foldEvents(RUN, [
      ev({ type: "phase", t: 1, index: 1, title: "Scan", pending: true }),
      ev({ type: "phase", t: 2, index: 1, title: "Scan" }),
    ])
    expect(snap.phases).toHaveLength(1)
    expect(snap.phases[0]!.pending).toBe(false)
  })

  it("never downgrades a started phase on a later pending announcement (resume replay)", () => {
    const snap = foldEvents(RUN, [
      ev({ type: "phase", t: 1, index: 1, title: "Scan" }),
      ev({ type: "phase", t: 2, index: 1, title: "Scan", pending: true }),
    ])
    expect(snap.phases[0]!.pending).toBe(false)
  })

  it("clears pending on a phase that has agents under it", () => {
    const snap = foldEvents(RUN, [
      ev({ type: "phase", t: 1, index: 1, title: "Scan", pending: true }),
      ev({ type: "agent", t: 2, index: 0, label: "a", provider: "codex", state: "running", phaseIndex: 1 }),
    ])
    expect(snap.phases[0]!.pending).toBe(false)
  })
})

describe("foldEvents — never invents staleness (H19)", () => {
  // Regression: an earlier H19 fix ran a deadman here keyed off the newest EVENT timestamp. But
  // heartbeats live in runs/<id>/.heartbeat — the event stream never carries them — so a healthy
  // run that simply goes quiet between events (one long Bash call) folded "stale", mergeRunStatus
  // kept that over the server's "started", and the latched-off stream never re-armed. The fold
  // must only ever report what the events say; staleness is the server poll's call.
  it("keeps a started run started no matter how old its newest event is", () => {
    const snap = foldEvents(RUN, [
      ev({ type: "run", t: 1_000_000, status: "started" }),
      // Newest activity is an agent event from long before any wall clock "now" — irrelevant:
      // the run's process may be mid-tool-call, beating its heartbeat file the whole time.
      ev({ type: "agent", t: 1_005_000, index: 0, label: "a", provider: "codex", state: "running" }),
    ])
    expect(snap.status).toBe("started")
  })

  // Mid-replay of a large finished run the fold sees old timestamps and no run-end event yet —
  // it must report "started", not "stale", or the tail latch would close the EventSource with
  // replay frames still in flight (frozen agents).
  it("reports started for a partial replay that has not reached the run-end event", () => {
    const snap = foldEvents(RUN, [
      ev({ type: "run", t: 1_000_000, status: "started" }),
      ev({ type: "agent", t: 1_001_000, index: 0, label: "a", provider: "codex", state: "done" }),
    ])
    expect(snap.status).toBe("started")
  })

  it("reports the terminal status once the run-end event folds", () => {
    const snap = foldEvents(RUN, [
      ev({ type: "run", t: 1_000_000, status: "started" }),
      ev({ type: "run", t: 1_000_010, status: "completed" }),
    ])
    expect(snap.status).toBe("completed")
  })
})
