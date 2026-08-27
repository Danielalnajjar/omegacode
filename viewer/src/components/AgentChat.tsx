import { useMemo } from "react"
import { useNavigate, useParams } from "react-router-dom"

import { ProviderIcon, StatusGlyph } from "@/components/glyphs"
import { ConversationMessageContent } from "@/components/timeline/ConversationMessageContent"
import { ThreadTimelineFeed } from "@/components/timeline/ThreadTimelineFeed"
import { useStickyBottomScroll } from "@/components/timeline/useStickyBottomScroll"
import { useAgentStream } from "@/lib/hooks"
import { fmtCost, fmtDuration, fmtTokens } from "@/lib/format"
import { toThreadFeed } from "@/lib/to-thread-events"
import { type AgentSnapshot, isTerminalAgent, isTerminalRun, type RunStatus } from "@/lib/types"

export function AgentChat({ agent, runStatus }: { agent?: AgentSnapshot; runStatus?: RunStatus }) {
  const { id, index } = useParams<{ id: string; index: string }>()
  const navigate = useNavigate()
  const idx = index != null ? Number(index) : null
  const { chunks, live } = useAgentStream(id ?? null, idx, agent?.state)
  const { meta, items, status, error } = useMemo(() => toThreadFeed(chunks), [chunks])

  // Stick to the bottom while streaming, but stop force-scrolling once the user scrolls up so the
  // scrollback stays readable during a live run (M29) — instead of yanking to the bottom every chunk.
  const scroll = useStickyBottomScroll<HTMLDivElement>({ contentKey: String(chunks.length), streaming: live })

  const provider = agent?.provider ?? meta?.provider ?? "codex"
  const label = agent?.label ?? meta?.label ?? `agent ${idx ?? ""}`
  const model = agent?.model ?? meta?.model
  const state = agent?.state ?? (status === "done" ? "done" : status === "failed" ? "failed" : "running")
  // Run-level deadman (H19): a SIGKILLed/finished run's agents may never receive a terminal chunk,
  // so an agent stuck "running" inside a dead run renders the run's fate, not a live spinner.
  const runDead = runStatus !== undefined && isTerminalRun(runStatus)
  const glyphState = runDead && state === "running" ? runStatus : state
  const stats = [
    agent?.outputTokens || agent?.usageIncomplete
      ? `${agent?.usageIncomplete ? "≥" : ""}${fmtTokens((agent?.inputTokens ?? 0) + (agent?.outputTokens ?? 0))} tok${agent?.usageIncomplete ? " (partial)" : ""}`
      : null,
    fmtDuration(agent?.durationMs),
    agent?.costUsd || agent?.usageIncomplete
      ? `${agent?.usageIncomplete ? "≥" : ""}${fmtCost(agent?.costUsd) || "$0.0000"}${agent?.usageIncomplete ? " (partial)" : ""}`
      : null,
  ].filter(Boolean)

  // Working indicator: show while live and not yet terminal. "Thinking" when the
  // last activity was reasoning, "Working" otherwise — matching bb. A dead run (H19) or an agent
  // the run fold already settled (e.g. a cached hit with no transcript) is never "working".
  const showWorking = live && status !== "done" && status !== "failed" && !runDead && !(agent && isTerminalAgent(agent.state))
  const workingIsThinking = items.length > 0 && items[items.length - 1]?.type === "reasoning"

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <header className="flex items-center gap-2 border-b border-border px-4 py-2.5">
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{label}</span>
        <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
          <ProviderIcon provider={provider} />
          {provider}
          {model && <span className="text-subtle-foreground">· {model}</span>}
        </span>
        {stats.length > 0 && <span className="shrink-0 font-mono text-[11px] text-subtle-foreground">{stats.join(" · ")}</span>}
        <StatusGlyph state={glyphState} className="shrink-0" />
        <button
          onClick={() => navigate(`/run/${id}`)}
          className="ml-2 shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-state-hover hover:text-foreground"
          aria-label="Close"
        >
          ✕
        </button>
      </header>

      <div
        ref={scroll.ref}
        onScroll={scroll.onScroll}
        onWheel={scroll.onWheel}
        onTouchStart={scroll.onTouchStart}
        onTouchMove={scroll.onTouchMove}
        onPointerDown={scroll.onPointerDown}
        className="scroll-bottom-anchor-content min-h-0 flex-1 overflow-auto px-4 py-3"
      >
        {meta?.prompt ? (
          <div className="mb-4">
            <ConversationMessageContent role="user" text={meta.prompt} />
          </div>
        ) : null}

        <ThreadTimelineFeed
          items={items}
          streaming={live}
          showWorking={showWorking}
          workingIsThinking={workingIsThinking}
        />

        {state === "failed" && error ? (
          <div className="mt-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {error}
          </div>
        ) : null}
      </div>
    </div>
  )
}
