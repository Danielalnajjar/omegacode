// @vitest-environment jsdom
//
// RunDetail behavioral regressions:
// - L28: PhaseGroup's collapse toggle was a no-op while the phase contained the selected agent
//   (open derived `containsActive || userOpen`), then the phase snapped closed later from the
//   stale `userOpen`. An explicit user toggle must win immediately and stay authoritative.
// - H19: a dead run (stale/terminal) can't have a running agent — its events stream just stopped
//   before the agent settled. Rows must surface the run's fate, not a perpetual live spinner.

import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { afterEach, describe, expect, it } from "vitest"

import { RunDetail } from "./RunDetail"
import type { AgentSnapshot, RunSnapshot } from "@/lib/types"

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

afterEach(() => cleanup())

function makeAgent(over: Partial<AgentSnapshot> = {}): AgentSnapshot {
  return { index: 0, phaseIndex: 0, label: `agent-${over.index ?? 0}`, provider: "codex", state: "done", t: 1, ...over }
}

function makeSnap(agents: AgentSnapshot[], over: Partial<RunSnapshot> = {}): RunSnapshot {
  return {
    runId: "r1",
    status: "started",
    phases: [{ index: 0, title: "Phase A", agents }],
    agents,
    logs: [],
    ...over,
  }
}

function renderDetail(snap: RunSnapshot, path = "/run/r1") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/run/:id" element={<RunDetail snap={snap} />} />
        <Route path="/run/:id/agent/:index" element={<RunDetail snap={snap} />} />
      </Routes>
    </MemoryRouter>,
  )
}

const phaseHeader = (): HTMLElement => {
  const header = screen.getByText("Phase A").closest("button")
  if (!header) throw new Error("phase header button not found")
  return header
}

describe("PhaseGroup collapse toggle (L28)", () => {
  it("collapses a phase containing the selected agent on an explicit toggle (was a no-op)", () => {
    const agents = [makeAgent({ index: 0, state: "running" }), makeAgent({ index: 1, state: "running" })]
    renderDetail(makeSnap(agents), "/run/r1/agent/0")
    // Holding the open agent ⇒ defaults to shown.
    expect(screen.getByText("agent-0")).toBeTruthy()

    fireEvent.click(phaseHeader())
    expect(screen.queryByText("agent-0")).toBeNull()

    fireEvent.click(phaseHeader())
    expect(screen.getByText("agent-0")).toBeTruthy()
  })

  it("keeps the user's explicit collapse when props change (no snap-back from stale state)", () => {
    const running = [makeAgent({ index: 0, state: "running" })]
    const view = renderDetail(makeSnap(running), "/run/r1/agent/0")
    fireEvent.click(phaseHeader())
    expect(screen.queryByText("agent-0")).toBeNull()

    // The run keeps streaming: same phase, fresh snapshot objects. The collapse must hold.
    view.rerender(
      <MemoryRouter initialEntries={["/run/r1/agent/0"]}>
        <Routes>
          <Route path="/run/:id/agent/:index" element={<RunDetail snap={makeSnap([makeAgent({ index: 0, state: "running", lastTool: "Bash" })])} />} />
        </Routes>
      </MemoryRouter>,
    )
    expect(screen.queryByText("agent-0")).toBeNull()
  })

  it("auto-collapses a cleanly completed phase; the toggle opens it", () => {
    renderDetail(makeSnap([makeAgent({ index: 0, state: "done" })]))
    expect(screen.queryByText("agent-0")).toBeNull()
    fireEvent.click(phaseHeader())
    expect(screen.getByText("agent-0")).toBeTruthy()
  })

  it("defaults a still-running phase to open", () => {
    renderDetail(makeSnap([makeAgent({ index: 0, state: "running" })]))
    expect(screen.getByText("agent-0")).toBeTruthy()
  })
})

describe("pending (declared) phases", () => {
  it("renders a declared-but-unstarted phase dimmed with a 'pending' tag, no agent count", () => {
    const snap = makeSnap([], { phases: [{ index: 0, title: "Phase A", pending: true, agents: [] }] })
    renderDetail(snap)
    expect(screen.getByText("Phase A")).toBeTruthy()
    expect(screen.getByText("pending")).toBeTruthy()
    expect(screen.queryByText("0/0")).toBeNull()
    // The full plan is on screen — no "No agents yet." placeholder under it.
    expect(screen.queryByText("No agents yet.")).toBeNull()
  })

  it("labels a pending phase 'not run' once the run is terminal", () => {
    const snap = makeSnap([], { phases: [{ index: 0, title: "Phase A", pending: true, agents: [] }], status: "failed" })
    renderDetail(snap)
    expect(screen.getByText("not run")).toBeTruthy()
    expect(screen.queryByText("pending")).toBeNull()
  })

  it("renders a started phase normally even when the snapshot still carries pending agents elsewhere", () => {
    const agents = [makeAgent({ index: 0, state: "running" })]
    const snap = makeSnap(agents, {
      phases: [
        { index: 0, title: "Phase A", agents },
        { index: 1, title: "Phase B", pending: true, agents: [] },
      ],
    })
    renderDetail(snap)
    expect(screen.getByText("0/1")).toBeTruthy()
    expect(screen.getByText("pending")).toBeTruthy()
  })
})

describe("agent glyph overlay on dead runs (H19)", () => {
  it("shows the run's fate instead of a spinner for a running agent in a stale run", () => {
    const { container } = renderDetail(makeSnap([makeAgent({ index: 0, state: "running" })], { status: "stale" }))
    // Header glyph, phase rollup, and the agent row all overlay the deadman verdict.
    expect(container.querySelector('[aria-label="in progress"]')).toBeNull()
    expect(container.querySelectorAll('[aria-label="stale (run died)"]').length).toBeGreaterThan(0)
  })

  it("keeps the live spinner for a running agent in a live run", () => {
    const { container } = renderDetail(makeSnap([makeAgent({ index: 0, state: "running" })], { status: "started" }))
    expect(container.querySelectorAll('[aria-label="in progress"]').length).toBeGreaterThan(0)
  })
})

describe("incomplete usage", () => {
  it("labels zero token lower bounds as partial rather than measured zero", () => {
    const { container } = renderDetail(makeSnap([makeAgent({ inputTokens: 0, outputTokens: 0, usageIncomplete: true })]))
    fireEvent.click(phaseHeader())
    expect(container.textContent).toContain("≥0 tok (partial)")
    expect(container.textContent).toContain("≥$0.0000 (partial)")
  })
})
