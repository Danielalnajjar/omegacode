// @vitest-environment jsdom
//
// StatusGlyph regressions (L26): "unknown" is a reachable run status (a run dir whose events file
// has no started/terminal event yet), and the old catch-all rendered it — and any future status
// variant — as a green done-check. Both must render neutral.

import { cleanup, render } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"

import { ProviderIcon, StatusGlyph } from "./glyphs"
import type { RunStatus } from "@/lib/types"

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

afterEach(() => cleanup())

/** Render a glyph and return its icon element (or null when the glyph renders nothing). */
function glyph(state: Parameters<typeof StatusGlyph>[0]["state"], quiet?: boolean): Element | null {
  return render(<StatusGlyph state={state} quiet={quiet} />).container.querySelector("[data-icon]")
}

describe("StatusGlyph (L26: unknown / future statuses must not look done)", () => {
  it('renders "unknown" as a neutral info glyph, not a done check', () => {
    const icon = glyph("unknown")
    expect(icon?.getAttribute("data-icon")).toBe("Info")
    expect(icon?.getAttribute("aria-label")).toBe("unknown")
  })

  // The exhaustiveness guard: a status variant added server-side before the viewer learns about it
  // must degrade to neutral — the old catch-all showed a misleading green check.
  it("renders a future status variant as neutral, not a done check", () => {
    const icon = glyph("paused" as RunStatus)
    expect(icon?.getAttribute("data-icon")).toBe("Info")
    expect(icon?.getAttribute("data-icon")).not.toBe("CircleCheck")
  })

  it("still renders the done check for genuinely terminal-success states", () => {
    expect(glyph("done")?.getAttribute("data-icon")).toBe("CircleCheck")
    expect(glyph("completed")?.getAttribute("data-icon")).toBe("CircleCheck")
  })

  it("suppresses the done check when quiet (run-list rows)", () => {
    expect(glyph("done", true)).toBeNull()
  })

  it("renders stale as the deadman alert, not a spinner or check", () => {
    const icon = glyph("stale")
    expect(icon?.getAttribute("data-icon")).toBe("AlertCircle")
    expect(icon?.getAttribute("aria-label")).toBe("stale (run died)")
  })

  it("renders running/started as the in-progress spinner", () => {
    expect(glyph("running")?.getAttribute("aria-label")).toBe("in progress")
    expect(glyph("started")?.getAttribute("aria-label")).toBe("in progress")
  })

  it("renders nothing for skipped", () => {
    expect(glyph("skipped")).toBeNull()
  })
})

describe("ProviderIcon", () => {
  it("renders Grok with its own monogram instead of the unknown-provider mark", () => {
    const { container } = render(<ProviderIcon provider="grok" />)
    expect(container.textContent).toBe("G")
  })

  it("keeps unknown providers visually neutral", () => {
    const { container } = render(<ProviderIcon provider="future-provider" />)
    expect(container.textContent).toBe("·")
  })
})
