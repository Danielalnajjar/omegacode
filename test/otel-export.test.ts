import { strict as assert } from "node:assert"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { after, before, test } from "node:test"
import { projectRunToOtlp, type OtlpAttribute, type OtlpSpan } from "../src/otel/export.ts"
import {
  GEN_AI_AGENT_NAME,
  GEN_AI_PROVIDER_NAME,
  GEN_AI_REQUEST_MODEL,
  GEN_AI_TOOL_NAME,
  GEN_AI_USAGE_CACHE_CREATION_INPUT_TOKENS,
  GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS,
  GEN_AI_USAGE_INPUT_TOKENS,
} from "../src/otel/genai-attrs.ts"

const RUN_ID = "wf_otel_fixture"
const CLI_ENTRY = fileURLToPath(new URL("../src/cli.ts", import.meta.url))
let home = ""
let previousHome: string | undefined

before(() => {
  home = mkdtempSync(join(tmpdir(), "omegacode-otel-"))
  previousHome = process.env.OMEGACODE_HOME
  process.env.OMEGACODE_HOME = home
  const run = join(home, "runs", RUN_ID)
  mkdirSync(join(run, "agents"), { recursive: true })
  writeFileSync(
    join(run, "journal.jsonl"),
    [
      { type: "meta", runId: RUN_ID, workflowFile: "/fixture.workflow.js", fileHash: "abc", args: null, seed: 1, createdAt: 900, keyVersion: "v2" },
      { type: "started", key: "k1", index: 1, label: "reviewer", provider: "claude-code" },
      {
        type: "result",
        key: "k1",
        index: 1,
        status: "completed",
        result: "done",
        provider: "claude-code",
        durationMs: 200,
        usage: { inputTokens: 100, outputTokens: 20, costUsd: 0.01, cacheReadInputTokens: 25, cacheCreationInputTokens: 5, incomplete: true },
      },
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n",
  )
  writeFileSync(
    join(run, "agents", "1.jsonl"),
    [
      { t: 1000, kind: "meta", index: 1, label: "reviewer", provider: "claude-code", model: "claude-opus-4-6", prompt: "review" },
      { t: 1050, kind: "tool", id: "tool-1", name: "Read", input: { file_path: "README.md" } },
      { t: 1075, kind: "tool-result", id: "tool-1", name: "Read", output: "ok", isError: false },
      { t: 1100, kind: "tool", id: "tool-2", name: "Bash", input: { command: "false" } },
      { t: 1125, kind: "tool-result", id: "tool-2", name: "Bash", output: "failed", isError: true },
      { t: 1200, kind: "status", state: "done" },
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n",
  )
})

after(() => {
  if (previousHome === undefined) delete process.env.OMEGACODE_HOME
  else process.env.OMEGACODE_HOME = previousHome
  rmSync(home, { recursive: true, force: true })
})

test("projection emits valid OTLP/HTTP JSON with cache subsets and transcript tool spans", () => {
  const payload = projectRunToOtlp(RUN_ID)
  const spans = payload.resourceSpans[0]!.scopeSpans[0]!.spans
  assert.equal(spans.length, 4)
  for (const span of spans) {
    assert.match(span.traceId, /^[0-9a-f]{32}$/)
    assert.match(span.spanId, /^[0-9a-f]{16}$/)
    if (span.parentSpanId !== undefined) assert.match(span.parentSpanId, /^[0-9a-f]{16}$/)
    assert.equal(Number.isInteger(span.kind), true)
    assert.equal(span.kind, 1)
    assert.match(span.startTimeUnixNano, /^\d+$/)
    assert.match(span.endTimeUnixNano, /^\d+$/)
  }

  const root = spans[0]!
  const agent = spans.find((span) => attributeString(span, GEN_AI_AGENT_NAME) === "reviewer")!
  assert.equal(agent.parentSpanId, root.spanId)
  assert.equal(attributeString(agent, GEN_AI_PROVIDER_NAME), "claude-code")
  assert.equal(attributeString(agent, GEN_AI_REQUEST_MODEL), "claude-opus-4-6")
  assert.equal(attributeInt(agent, "omegacode.duration_ms"), 200)

  const input = attributeInt(agent, GEN_AI_USAGE_INPUT_TOKENS)
  const cacheRead = attributeInt(agent, GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS)
  const cacheCreation = attributeInt(agent, GEN_AI_USAGE_CACHE_CREATION_INPUT_TOKENS)
  assert.equal(input, 100)
  assert.equal(cacheRead, 25)
  assert.equal(cacheCreation, 5)
  assert.ok(cacheRead + cacheCreation <= input)
  assert.equal(attributeBool(agent, "omegacode.usage.incomplete"), true)

  const tools = spans.filter((span) => attributeString(span, GEN_AI_TOOL_NAME) !== undefined)
  assert.deepEqual(tools.map((span) => attributeString(span, GEN_AI_TOOL_NAME)), ["Read", "Bash"])
  assert.ok(tools.every((span) => span.parentSpanId === agent.spanId))
  assert.equal(tools[0]!.endTimeUnixNano, "1075000000")
  assert.equal(attributeBool(tools[0]!, "omegacode.tool.is_error"), false)
  assert.equal(attributeBool(tools[1]!, "omegacode.tool.is_error"), true)
  assert.equal(tools[1]!.status.code, 2)
  assert.equal(attributeString(tools[1]!, "error.type"), "tool_error")

  // OTLP JSON maps protobuf int64 values to decimal strings, including integer attributes.
  for (const span of spans) {
    for (const attribute of span.attributes) {
      if ("intValue" in attribute.value) assert.equal(typeof attribute.value.intValue, "string")
    }
  }
})

test("projection derives identical trace and span ids across repeated exports", () => {
  const first = projectRunToOtlp(RUN_ID).resourceSpans[0]!.scopeSpans[0]!.spans
  const second = projectRunToOtlp(RUN_ID).resourceSpans[0]!.scopeSpans[0]!.spans
  assert.deepEqual(first.map(ids), second.map(ids))
})

test("otel-export command writes the OTLP JSON projection to stdout with --endpoint -", () => {
  const stdout = execFileSync(process.execPath, ["--import", "tsx", CLI_ENTRY, "otel-export", RUN_ID, "--endpoint", "-"], {
    env: { ...process.env, OMEGACODE_HOME: home },
    encoding: "utf8",
  })
  const payload = JSON.parse(stdout) as ReturnType<typeof projectRunToOtlp>
  assert.equal(payload.resourceSpans[0]!.scopeSpans[0]!.spans.length, 4)
})

function ids(span: OtlpSpan): { traceId: string; spanId: string; parentSpanId?: string } {
  return { traceId: span.traceId, spanId: span.spanId, ...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}) }
}

function attribute(span: OtlpSpan, key: string): OtlpAttribute | undefined {
  return span.attributes.find((entry) => entry.key === key)
}

function attributeString(span: OtlpSpan, key: string): string | undefined {
  const value = attribute(span, key)?.value
  return value && "stringValue" in value ? value.stringValue : undefined
}

function attributeInt(span: OtlpSpan, key: string): number {
  const value = attribute(span, key)?.value
  assert.ok(value && "intValue" in value, `missing int attribute ${key}`)
  return Number(value.intValue)
}

function attributeBool(span: OtlpSpan, key: string): boolean {
  const value = attribute(span, key)?.value
  assert.ok(value && "boolValue" in value, `missing bool attribute ${key}`)
  return value.boolValue
}
