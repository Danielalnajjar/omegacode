import { existsSync } from "node:fs"
import { readFile, readdir, stat } from "node:fs/promises"
import { basename, join } from "node:path"
import type { ProviderId } from "../dsl/types.js"
import type { AgentState, WorkflowEvent } from "./events.js"
import { dataRoot, runDir } from "./journal.js"

export type AgentSnapshot = {
  index: number
  phaseIndex?: number
  phaseTitle?: string
  label: string
  provider: ProviderId
  model?: string
  state: AgentState
  cached?: boolean
  durationMs?: number
  inputTokens?: number
  outputTokens?: number
  costUsd?: number
  lastTool?: string
  promptPreview?: string
  resultPreview?: string
  error?: string
  t: number
}

export type RunStatus = "started" | "completed" | "failed" | "interrupted" | "unknown" | "stale"

export interface PhaseSnapshot {
  index: number
  title: string
  /** Declared in meta.phases but not yet entered by phase() (no agents have run under it). */
  pending?: boolean
  agents: AgentSnapshot[]
}

export interface RunSnapshot {
  runId: string
  status: RunStatus
  name?: string
  workflowFile?: string
  error?: string
  startedAt?: number
  endedAt?: number
  phases: PhaseSnapshot[]
  agents: AgentSnapshot[]
  logs: Array<{ t: number; message: string }>
}

export interface RunSummary {
  runId: string
  name?: string
  status: RunStatus
  agents: number
  startedAt?: number
  endedAt?: number
}

export interface RunStatusSnapshot extends RunSnapshot {
  runDir: string
  logPath: string
  result?: unknown
}

/** A "started" run whose heartbeat is older than this is treated as dead. */
export const STALE_MS = 20_000

export function runsDir(): string {
  return join(dataRoot(), "runs")
}

/** A run id is one path segment, no separators or traversal. */
export function isValidRunId(id: string): boolean {
  return id.length > 0 && !id.includes("/") && !id.includes("\\") && !id.includes("..") && !id.includes("\0")
}

/** Parse a JSONL blob into WorkflowEvents, skipping blank/unparseable lines. */
export function parseEvents(text: string): WorkflowEvent[] {
  const out: WorkflowEvent[] = []
  for (const line of text.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      out.push(JSON.parse(trimmed) as WorkflowEvent)
    } catch {
      // skip a partial / malformed line
    }
  }
  return out
}

/** Read events.jsonl for a run; returns [] if the file is missing/unreadable. */
export async function readEvents(runId: string): Promise<WorkflowEvent[]> {
  try {
    const text = await readFile(join(runsDir(), runId, "events.jsonl"), "utf8")
    return parseEvents(text)
  } catch {
    return []
  }
}

/** Fold a run's events into a full snapshot with raw status, so the result is cacheable. */
export function foldSnapshotRaw(runId: string, events: WorkflowEvent[]): RunSnapshot {
  return foldSnapshot(runId, events, undefined, true)
}

/**
 * Fold a run's events into a full snapshot: latest agent per index + phases + logs.
 * `lastBeat` is the run's most recent heartbeat mtime (ms); when omitted, staleness falls
 * back to `startedAt`. Pass `raw=true` to skip the deadman entirely.
 */
export function foldSnapshot(runId: string, events: WorkflowEvent[], lastBeat?: number, raw = false): RunSnapshot {
  const agentByIndex = new Map<number, AgentSnapshot>()
  const phaseByIndex = new Map<number, PhaseSnapshot>()
  const logs: Array<{ t: number; message: string }> = []
  let status: RunStatus = "unknown"
  let startedAt: number | undefined
  let endedAt: number | undefined
  let workflowFile: string | undefined
  let workflowName: string | undefined
  let error: string | undefined

  for (const ev of events) {
    switch (ev.type) {
      case "run": {
        if (ev.status === "started") {
          status = "started"
          if (startedAt === undefined) startedAt = ev.t
          if (ev.workflowFile) workflowFile = ev.workflowFile
          if (ev.workflowName) workflowName = ev.workflowName
        } else {
          status = ev.status
          endedAt = ev.t
          if (ev.error) error = ev.error
        }
        break
      }
      case "phase": {
        const existing = phaseByIndex.get(ev.index)
        if (existing) {
          existing.title = ev.title
          if (!ev.pending) existing.pending = false
        } else {
          phaseByIndex.set(ev.index, { index: ev.index, title: ev.title, pending: ev.pending === true, agents: [] })
        }
        break
      }
      case "agent": {
        const prev = agentByIndex.get(ev.index)
        const next: AgentSnapshot = {
          index: ev.index,
          phaseIndex: ev.phaseIndex ?? prev?.phaseIndex,
          phaseTitle: ev.phaseTitle ?? prev?.phaseTitle,
          label: ev.label ?? prev?.label ?? "",
          provider: ev.provider ?? prev?.provider ?? "codex",
          model: ev.model ?? prev?.model,
          state: ev.state,
          cached: ev.cached ?? prev?.cached,
          durationMs: ev.durationMs ?? prev?.durationMs,
          inputTokens: ev.inputTokens ?? prev?.inputTokens,
          outputTokens: ev.outputTokens ?? prev?.outputTokens,
          costUsd: ev.costUsd ?? prev?.costUsd,
          lastTool: ev.lastTool ?? prev?.lastTool,
          promptPreview: ev.promptPreview ?? prev?.promptPreview,
          resultPreview: ev.resultPreview ?? prev?.resultPreview,
          error: ev.error ?? prev?.error,
          t: ev.t,
        }
        agentByIndex.set(ev.index, next)
        break
      }
      case "log": {
        logs.push({ t: ev.t, message: ev.message })
        break
      }
    }
  }

  const agents = [...agentByIndex.values()].sort((a, b) => a.index - b.index)
  for (const a of agents) {
    if (a.phaseIndex !== undefined && !phaseByIndex.has(a.phaseIndex)) {
      phaseByIndex.set(a.phaseIndex, { index: a.phaseIndex, title: a.phaseTitle ?? `Phase ${a.phaseIndex}`, agents: [] })
    }
  }
  for (const a of agents) {
    if (a.phaseIndex !== undefined) phaseByIndex.get(a.phaseIndex)?.agents.push(a)
  }
  const phases = [...phaseByIndex.values()].sort((p, q) => p.index - q.index)
  for (const p of phases) {
    p.agents.sort((a, b) => a.index - b.index)
    if (p.agents.length > 0) p.pending = false
  }

  const name = workflowName ?? (workflowFile ? basename(workflowFile).replace(/\.workflow\.[cm]?[jt]s$/i, "").replace(/\.[cm]?[jt]s$/i, "") : undefined)
  const finalStatus = raw ? status : applyDeadman(status, startedAt, lastBeat)
  return { runId, status: finalStatus, name, workflowFile, error, startedAt, endedAt, phases, agents, logs }
}

export function applyDeadman(status: RunStatus, startedAt: number | undefined, lastBeat: number | undefined): RunStatus {
  if (status !== "started") return status
  const beat = Math.max(startedAt ?? 0, lastBeat ?? 0)
  if (beat > 0 && Date.now() - beat > STALE_MS) return "stale"
  return status
}

/** Most recent heartbeat mtime (ms) for a run, or 0 if there is no heartbeat file. */
export async function heartbeatMtime(runId: string): Promise<number> {
  try {
    return (await stat(join(runsDir(), runId, ".heartbeat"))).mtimeMs
  } catch {
    return 0
  }
}

export async function runExists(runId: string): Promise<boolean> {
  try {
    await stat(runDir(runId))
    return true
  } catch {
    return false
  }
}

/** Load one status snapshot directly from native run artifacts. */
export async function loadRunStatus(runId: string): Promise<RunStatusSnapshot | null> {
  if (!(await runExists(runId))) return null
  const events = await readEvents(runId)
  const snapshot = foldSnapshot(runId, events, await heartbeatMtime(runId))
  const logPath = join(runDir(runId), "run.log")
  let result: unknown
  try {
    result = JSON.parse(await readFile(join(runDir(runId), "result.json"), "utf8"))
  } catch {
    result = undefined
  }
  return { ...snapshot, runDir: runDir(runId), logPath, result }
}

/** Summarize a run for list views (raw status; caller applies the deadman). */
export function foldSummary(runId: string, events: WorkflowEvent[]): RunSummary {
  const snap = foldSnapshotRaw(runId, events)
  return {
    runId,
    name: snap.name,
    status: snap.status,
    agents: snap.agents.length,
    startedAt: snap.startedAt,
    endedAt: snap.endedAt,
  }
}

interface CachedSummary {
  size: number
  mtimeMs: number
  summary: RunSummary
}

const summaryCache = new Map<string, CachedSummary>()

/** List all runs (newest first), folding each run's events.jsonl into a summary. */
export async function listRuns(): Promise<RunSummary[]> {
  let entries: Array<{ name: string; isDirectory: () => boolean }>
  try {
    entries = await readdir(runsDir(), { withFileTypes: true })
  } catch {
    return []
  }
  const seen = new Set<string>()
  const summaries: Array<{ summary: RunSummary; mtime: number }> = []
  for (const ent of entries) {
    if (!ent.isDirectory()) continue
    const runId = ent.name
    seen.add(runId)

    let eventsStat: { size: number; mtimeMs: number } | undefined
    try {
      eventsStat = await stat(join(runsDir(), runId, "events.jsonl"))
    } catch {
      eventsStat = undefined
    }

    let rawSummary: RunSummary | undefined
    if (eventsStat) {
      const cached = summaryCache.get(runId)
      if (cached && cached.size === eventsStat.size && cached.mtimeMs === eventsStat.mtimeMs) {
        rawSummary = cached.summary
      }
    }

    if (!rawSummary) {
      const events = await readEvents(runId)
      if (events.length === 0) {
        let mtime = 0
        try {
          mtime = (await stat(runDir(runId))).mtimeMs
        } catch {
          // ignore
        }
        summaries.push({ summary: { runId, status: "unknown", agents: 0 }, mtime })
        continue
      }
      rawSummary = foldSummary(runId, events)
      if (eventsStat) summaryCache.set(runId, { size: eventsStat.size, mtimeMs: eventsStat.mtimeMs, summary: rawSummary })
    }

    let summary = rawSummary
    if (rawSummary.status === "started") {
      const status = applyDeadman("started", rawSummary.startedAt, await heartbeatMtime(runId))
      if (status !== "started") summary = { ...rawSummary, status }
    }
    summaries.push({ summary, mtime: summary.startedAt ?? 0 })
  }

  for (const key of summaryCache.keys()) if (!seen.has(key)) summaryCache.delete(key)

  summaries.sort((a, b) => {
    const ta = a.summary.startedAt ?? a.mtime
    const tb = b.summary.startedAt ?? b.mtime
    return tb - ta
  })
  return summaries.map((s) => s.summary)
}

export function expectedLogPath(runId: string): string {
  return join(runDir(runId), "run.log")
}

export function resultFileExists(runId: string): boolean {
  return existsSync(join(runDir(runId), "result.json"))
}
