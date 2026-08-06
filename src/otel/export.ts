import { createHash } from "node:crypto"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { AgentUsage } from "../dsl/types.js"
import { JournalNotFoundError, journalPath, listRunIds, runDir, type JournalEntry, type JournalMeta, type JournalResult } from "../runtime/journal.js"
import type { ChatChunk } from "../runtime/transcript.js"
import {
  GEN_AI_AGENT_NAME,
  GEN_AI_OPERATION_NAME,
  GEN_AI_PROVIDER_NAME,
  GEN_AI_REQUEST_MODEL,
  GEN_AI_TOOL_NAME,
  GEN_AI_USAGE_CACHE_CREATION_INPUT_TOKENS,
  GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS,
  GEN_AI_USAGE_INPUT_TOKENS,
  GEN_AI_USAGE_OUTPUT_TOKENS,
} from "./genai-attrs.js"

const INTERNAL_SPAN_KIND = 1
const STATUS_UNSET = 0
const STATUS_ERROR = 2

type OtlpValue = { stringValue: string } | { intValue: string } | { boolValue: boolean }

export interface OtlpAttribute {
  key: string
  value: OtlpValue
}

export interface OtlpSpan {
  traceId: string
  spanId: string
  parentSpanId?: string
  name: string
  kind: number
  startTimeUnixNano: string
  endTimeUnixNano: string
  attributes: OtlpAttribute[]
  status: { code: number }
}

export interface OtlpTraces {
  resourceSpans: Array<{
    resource: { attributes: OtlpAttribute[] }
    scopeSpans: Array<{ scope: { name: string }; spans: OtlpSpan[] }>
  }>
}

interface AgentTranscript {
  meta?: Extract<ChatChunk, { kind: "meta" }>
  chunks: ChatChunk[]
}

/** Project one native run into the OTLP/HTTP JSON-protobuf traces shape. */
export function projectRunToOtlp(runId: string): OtlpTraces {
  const path = journalPath(runId)
  if (!existsSync(path)) throw new JournalNotFoundError(runId, listRunIds())

  const journal = readJsonl<JournalEntry>(path)
  const runMeta = journal.find((entry): entry is JournalMeta => entry.type === "meta")
  const startedLabels = new Map<number, string>()
  const results = new Map<number, JournalResult>()
  for (const entry of journal) {
    if (entry.type === "started") startedLabels.set(entry.index, entry.label)
    if (entry.type === "result") results.set(entry.index, entry)
  }

  const transcripts = readTranscripts(runId)
  const transcriptStarts = [...transcripts.values()]
    .map((transcript) => transcript.meta?.t)
    .filter((value): value is number => isFiniteNumber(value))
  const runStartMs = isFiniteNumber(runMeta?.createdAt)
    ? runMeta.createdAt
    : transcriptStarts.length > 0
      ? Math.min(...transcriptStarts)
      : 0
  const traceId = stableHex(`omegacode:${runId}:trace`, 32)
  const rootSpanId = stableHex(`omegacode:${runId}:root`, 16)
  const childSpans: OtlpSpan[] = []

  for (const [index, result] of [...results].sort(([a], [b]) => a - b)) {
    const transcript = transcripts.get(index)
    const agentSpanId = stableHex(`omegacode:${runId}:agent:${index}`, 16)
    const startMs = isFiniteNumber(transcript?.meta?.t) ? transcript.meta.t : runStartMs
    const durationMs = isFiniteNumber(result.durationMs) ? Math.max(0, result.durationMs) : 0
    const attributes = [
      stringAttribute(GEN_AI_OPERATION_NAME, "invoke_agent"),
      stringAttribute(GEN_AI_AGENT_NAME, transcript?.meta?.label ?? startedLabels.get(index) ?? `agent ${index}`),
      stringAttribute(GEN_AI_PROVIDER_NAME, result.provider),
      intAttribute("omegacode.duration_ms", durationMs),
      ...usageAttributes(result.usage),
    ]
    if (transcript?.meta?.model) attributes.push(stringAttribute(GEN_AI_REQUEST_MODEL, transcript.meta.model))

    childSpans.push({
      traceId,
      spanId: agentSpanId,
      parentSpanId: rootSpanId,
      name: `invoke_agent ${transcript?.meta?.label ?? startedLabels.get(index) ?? `agent ${index}`}`,
      kind: INTERNAL_SPAN_KIND,
      startTimeUnixNano: unixNanos(startMs),
      endTimeUnixNano: unixNanos(startMs + durationMs),
      attributes,
      status: { code: result.status === "completed" ? STATUS_UNSET : STATUS_ERROR },
    })

    if (transcript) childSpans.push(...toolSpans(runId, index, traceId, agentSpanId, transcript.chunks))
  }

  const runEndMs = Math.max(
    runStartMs,
    ...childSpans.map((span) => Number(BigInt(span.endTimeUnixNano) / 1_000_000n)),
  )
  const rootSpan: OtlpSpan = {
    traceId,
    spanId: rootSpanId,
    name: "omegacode.run",
    kind: INTERNAL_SPAN_KIND,
    startTimeUnixNano: unixNanos(runStartMs),
    endTimeUnixNano: unixNanos(runEndMs),
    attributes: [],
    status: { code: STATUS_UNSET },
  }

  return {
    resourceSpans: [
      {
        resource: { attributes: [stringAttribute("service.name", "omegacode")] },
        scopeSpans: [{ scope: { name: "omegacode" }, spans: [rootSpan, ...childSpans] }],
      },
    ],
  }
}

/** Send the already-projected payload to an exact OTLP/HTTP traces endpoint. */
export async function postOtlpTraces(endpoint: string, payload: OtlpTraces): Promise<void> {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  })
  if (!response.ok) {
    const detail = (await response.text()).trim()
    throw new Error(`OTLP endpoint returned ${response.status}${detail ? `: ${detail}` : ""}`)
  }
}

function readTranscripts(runId: string): Map<number, AgentTranscript> {
  const dir = join(runDir(runId), "agents")
  const transcripts = new Map<number, AgentTranscript>()
  if (!existsSync(dir)) return transcripts
  for (const name of readdirSync(dir).filter((entry) => entry.endsWith(".jsonl")).sort()) {
    const chunks = readJsonl<ChatChunk>(join(dir, name))
    const meta = chunks.find((chunk): chunk is Extract<ChatChunk, { kind: "meta" }> => chunk.kind === "meta")
    if (meta && Number.isInteger(meta.index)) transcripts.set(meta.index, { meta, chunks })
  }
  return transcripts
}

function toolSpans(runId: string, agentIndex: number, traceId: string, parentSpanId: string, chunks: ChatChunk[]): OtlpSpan[] {
  const pending: Array<{ chunk: Extract<ChatChunk, { kind: "tool" }>; ordinal: number }> = []
  const spans: OtlpSpan[] = []
  let ordinal = 0
  for (const chunk of chunks) {
    if (chunk.kind === "tool") {
      pending.push({ chunk, ordinal: ordinal++ })
      continue
    }
    if (chunk.kind !== "tool-result") continue
    const pendingIndex = matchingToolIndex(pending, chunk)
    if (pendingIndex < 0) continue
    const matched = pending.splice(pendingIndex, 1)[0]!
    const { chunk: tool, ordinal: toolOrdinal } = matched
    const startMs = isFiniteNumber(tool.t) ? tool.t : 0
    const endMs = isFiniteNumber(chunk.t) ? Math.max(startMs, chunk.t) : startMs
    const isError = chunk.isError === true
    spans.push({
      traceId,
      spanId: stableHex(`omegacode:${runId}:agent:${agentIndex}:tool:${toolOrdinal}`, 16),
      parentSpanId,
      name: `execute_tool ${tool.name}`,
      kind: INTERNAL_SPAN_KIND,
      startTimeUnixNano: unixNanos(startMs),
      endTimeUnixNano: unixNanos(endMs),
      attributes: [
        stringAttribute(GEN_AI_OPERATION_NAME, "execute_tool"),
        stringAttribute(GEN_AI_TOOL_NAME, tool.name),
        boolAttribute("omegacode.tool.is_error", isError),
        ...(isError ? [stringAttribute("error.type", "tool_error")] : []),
      ],
      status: { code: isError ? STATUS_ERROR : STATUS_UNSET },
    })
  }
  return spans
}

function matchingToolIndex(
  pending: Array<{ chunk: Extract<ChatChunk, { kind: "tool" }> }>,
  result: Extract<ChatChunk, { kind: "tool-result" }>,
): number {
  if (result.id !== undefined) return pending.findIndex(({ chunk }) => chunk.id === result.id)
  if (result.name !== undefined) {
    const byName = pending.findIndex(({ chunk }) => chunk.name === result.name)
    if (byName >= 0) return byName
  }
  return pending.length > 0 ? 0 : -1
}

function usageAttributes(usage: AgentUsage): OtlpAttribute[] {
  const attributes = [
    intAttribute(GEN_AI_USAGE_INPUT_TOKENS, usage.inputTokens),
    intAttribute(GEN_AI_USAGE_OUTPUT_TOKENS, usage.outputTokens),
  ]
  if (usage.cacheReadInputTokens !== undefined) {
    attributes.push(intAttribute(GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS, usage.cacheReadInputTokens))
  }
  if (usage.cacheCreationInputTokens !== undefined) {
    attributes.push(intAttribute(GEN_AI_USAGE_CACHE_CREATION_INPUT_TOKENS, usage.cacheCreationInputTokens))
  }
  return attributes
}

function readJsonl<T>(path: string): T[] {
  const out: T[] = []
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line) as T)
    } catch {
      // Match the native journal/transcript readers: ignore torn or unparseable lines.
    }
  }
  return out
}

function stableHex(input: string, length: number): string {
  return createHash("sha256").update(input).digest("hex").slice(0, length)
}

function unixNanos(ms: number): string {
  return (BigInt(Math.max(0, Math.trunc(ms))) * 1_000_000n).toString()
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

function stringAttribute(key: string, value: string): OtlpAttribute {
  return { key, value: { stringValue: value } }
}

function intAttribute(key: string, value: number): OtlpAttribute {
  return { key, value: { intValue: String(Math.trunc(value)) } }
}

function boolAttribute(key: string, value: boolean): OtlpAttribute {
  return { key, value: { boolValue: value } }
}
