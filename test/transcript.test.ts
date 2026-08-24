import { test, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  AgentTranscript,
  agentTranscriptPath,
  agentTranscriptPathByName,
  agentsDir,
  type ChatChunk,
} from "../src/runtime/transcript.ts"

let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "omega-tx-"))
  process.env.OMEGACODE_HOME = home
})

afterEach(() => {
  delete process.env.OMEGACODE_HOME
  rmSync(home, { recursive: true, force: true })
})

function readLines(path: string): ChatChunk[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as ChatChunk)
}

test("agentTranscriptPath / agentsDir keep their index-based shape (server compatibility)", () => {
  const p = agentTranscriptPath("run1", 3)
  assert.ok(p.endsWith(join("run1", "agents", "3.jsonl")))
  assert.ok(agentsDir("run1").endsWith(join("run1", "agents")))
})

test("a transcript writes a meta + status line and is readable after close", async () => {
  const tx = new AgentTranscript("run1", 0)
  tx.write({ kind: "meta", index: 0, label: "L", provider: "codex", model: "m", prompt: "p" })
  tx.write({ kind: "status", state: "running" })
  await tx.close()
  const lines = readLines(agentTranscriptPath("run1", 0))
  assert.equal(lines[0].kind, "meta")
  assert.equal(lines[1].kind, "status")
  for (const l of lines) assert.equal(typeof l.t, "number")
})

test("text deltas coalesce into a single flushed chunk", async () => {
  const tx = new AgentTranscript("run2", 0)
  tx.write({ kind: "text", text: "Hel" })
  tx.write({ kind: "text", text: "lo " })
  tx.write({ kind: "text", text: "world" })
  await tx.close()
  const lines = readLines(agentTranscriptPath("run2", 0))
  const texts = lines.filter((l) => l.kind === "text")
  assert.equal(texts.length, 1)
  assert.equal((texts[0] as Extract<ChatChunk, { kind: "text" }>).text, "Hello world")
})

test("switching from text to reasoning flushes the pending text first", async () => {
  const tx = new AgentTranscript("run3", 0)
  tx.write({ kind: "text", text: "answer" })
  tx.write({ kind: "reasoning", text: "thinking" })
  await tx.close()
  const lines = readLines(agentTranscriptPath("run3", 0))
  assert.equal(lines[0].kind, "text")
  assert.equal(lines[1].kind, "reasoning")
})

test("phase markers are preserved as durable transcript receipts", async () => {
  const tx = new AgentTranscript("run-phase", 0)
  tx.write({ kind: "phase", phase: "amp-thread:T-child" })
  await tx.close()
  const lines = readLines(agentTranscriptPath("run-phase", 0))
  assert.deepEqual(lines.map(({ t: _t, ...line }) => line), [
    { kind: "phase", phase: "amp-thread:T-child" },
  ])
})

test("a tool chunk flushes pending text before it", async () => {
  const tx = new AgentTranscript("run4", 0)
  tx.write({ kind: "text", text: "before tool" })
  tx.write({ kind: "tool", name: "bash", input: { cmd: "ls" } })
  await tx.close()
  const lines = readLines(agentTranscriptPath("run4", 0))
  assert.equal(lines[0].kind, "text")
  assert.equal(lines[1].kind, "tool")
})

test("large tool output is head+tail truncated with a marker", async () => {
  const tx = new AgentTranscript("run5", 0)
  const big = "x".repeat(64 * 1024)
  tx.write({ kind: "tool-result", name: "bash", output: big })
  await tx.close()
  const lines = readLines(agentTranscriptPath("run5", 0))
  const out = (lines[0] as Extract<ChatChunk, { kind: "tool-result" }>).output!
  assert.ok(out.length < big.length)
  assert.match(out, /chars truncated/)
})

test("L15: an unserializable tool input becomes a placeholder, not a crash", async () => {
  const tx = new AgentTranscript("run6", 0)
  const cyclic: Record<string, unknown> = {}
  cyclic.self = cyclic
  // Must not throw and must still emit a usable tool line.
  assert.doesNotThrow(() => tx.write({ kind: "tool", name: "weird", input: cyclic }))
  await tx.close()
  const lines = readLines(agentTranscriptPath("run6", 0))
  const tool = lines.find((l) => l.kind === "tool") as Extract<ChatChunk, { kind: "tool" }>
  assert.ok(tool, "the tool chunk is preserved")
  assert.equal(tool.input, "[unserializable tool input]")
})

test("L15/H11: a BigInt-bearing chunk does not throw out of write()", async () => {
  const tx = new AgentTranscript("run7", 0)
  // BigInt makes JSON.stringify throw; the writer must swallow it best-effort.
  assert.doesNotThrow(() => tx.write({ kind: "tool", name: "n", input: { v: 10n } as unknown }))
  await tx.close()
  // file exists and prior/other writes still work
  const tx2 = new AgentTranscript("run7b", 0)
  tx2.write({ kind: "text", text: "still works" })
  await tx2.close()
  const lines = readLines(agentTranscriptPath("run7b", 0))
  assert.equal((lines[0] as Extract<ChatChunk, { kind: "text" }>).text, "still works")
})

test("H11: a stream error on the transcript file degrades to best-effort, never a crash", async () => {
  // Regression: pre-create the transcript path as a DIRECTORY so the write stream errors (EISDIR).
  // On the old code the unhandled 'error' event crashed the run process.
  mkdirSync(agentTranscriptPath("run-broken", 0), { recursive: true })
  let crashed = false
  const onUncaught = (): void => {
    crashed = true
  }
  process.on("uncaughtException", onUncaught)
  try {
    const tx = new AgentTranscript("run-broken", 0)
    assert.doesNotThrow(() => tx.write({ kind: "text", text: "doomed but harmless" }))
    await new Promise((r) => setTimeout(r, 50))
    await tx.close()
  } finally {
    process.removeListener("uncaughtException", onUncaught)
  }
  assert.equal(crashed, false)
})

test("API stability: a journal-key-derived filename can be supplied without breaking the index API", async () => {
  const tx = new AgentTranscript("run8", 0, { name: "k_abc123" })
  tx.write({ kind: "text", text: "keyed" })
  await tx.close()
  const keyedPath = agentTranscriptPathByName("run8", "k_abc123")
  assert.ok(existsSync(keyedPath))
  // index-based path is NOT created when a name is given
  assert.ok(!existsSync(agentTranscriptPath("run8", 0)))
  const lines = readLines(keyedPath)
  assert.equal((lines[0] as Extract<ChatChunk, { kind: "text" }>).text, "keyed")
})

test("key-derived filenames are sanitized to a single safe path segment", () => {
  const dir = agentsDir("run9")
  const p = agentTranscriptPathByName("run9", "../../etc/passwd")
  // stays inside the agents dir and the name has no path separators (no traversal possible)
  assert.ok(p.startsWith(dir + "/") || p.startsWith(dir + "\\"))
  const name = p.slice(dir.length + 1)
  assert.ok(!name.includes("/"))
  assert.ok(!name.includes("\\"))
})

test("close resolves even if nothing was written", async () => {
  const tx = new AgentTranscript("run10", 0)
  await tx.close()
  assert.ok(existsSync(agentTranscriptPath("run10", 0)))
})

test("re-running an agent truncates the prior transcript (flags 'w')", async () => {
  const tx1 = new AgentTranscript("run11", 0)
  tx1.write({ kind: "text", text: "first attempt long content" })
  await tx1.close()
  const tx2 = new AgentTranscript("run11", 0)
  tx2.write({ kind: "text", text: "second" })
  await tx2.close()
  const lines = readLines(agentTranscriptPath("run11", 0))
  assert.equal(lines.length, 1)
  assert.equal((lines[0] as Extract<ChatChunk, { kind: "text" }>).text, "second")
})
