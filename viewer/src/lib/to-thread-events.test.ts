import { describe, expect, it } from "vitest"

import { extractCommand, toThreadFeed } from "./to-thread-events"
import type {
  ThreadEventCommandExecutionItem,
  ThreadEventFileChangeItem,
  ThreadEventToolCallItem,
} from "./thread-events"
import type { ChatChunk } from "./types"

describe("extractCommand", () => {
  it("returns a plain string as-is", () => {
    expect(extractCommand("echo hi")).toBe("echo hi")
  })

  it("unwraps a shell -lc script from an argv array", () => {
    expect(extractCommand(["/bin/zsh", "-lc", "ls -la"])).toBe("ls -la")
    expect(extractCommand(["bash", "-c", "grep foo ."])).toBe("grep foo .")
  })

  it("unwraps a shell -lc script from a string", () => {
    expect(extractCommand("/bin/zsh -lc 'ls -la'")).toBe("ls -la")
  })

  it("unwraps a { command: [...] } object", () => {
    expect(extractCommand({ command: ["zsh", "-lc", "pwd"] })).toBe("pwd")
  })

  // Regression (L23): argv with a literal `-c` flag to a NON-shell binary must keep argv[0].
  it("does NOT strip the executable for `python3 -c …`", () => {
    expect(extractCommand(["python3", "-c", "print(1)"])).toBe("python3 -c print(1)")
  })

  it("does NOT strip the executable for `rg -c pattern`", () => {
    expect(extractCommand(["rg", "-c", "pattern", "src"])).toBe("rg -c pattern src")
  })

  it("returns the full argv when argv[0] is not a known shell and has no -c", () => {
    expect(extractCommand(["ls", "-la"])).toBe("ls -la")
  })

  it("returns empty string for null/undefined/unknown shapes", () => {
    expect(extractCommand(null)).toBe("")
    expect(extractCommand(undefined)).toBe("")
    expect(extractCommand(42)).toBe("")
  })
})

function meta(): ChatChunk {
  return { t: 0, kind: "meta", index: 0, label: "agent", provider: "codex", prompt: "do it" }
}

describe("toThreadFeed — meta + text + reasoning", () => {
  it("captures meta and coalesces consecutive text", () => {
    const feed = toThreadFeed([
      meta(),
      { t: 1, kind: "text", text: "Hello " },
      { t: 2, kind: "text", text: "world" },
    ])
    expect(feed.meta?.prompt).toBe("do it")
    expect(feed.items).toHaveLength(1)
    expect(feed.items[0]).toMatchObject({ type: "agentMessage", text: "Hello world" })
  })

  it("flushes text before reasoning and coalesces reasoning", () => {
    const feed = toThreadFeed([
      { t: 1, kind: "text", text: "ans" },
      { t: 2, kind: "reasoning", text: "think " },
      { t: 3, kind: "reasoning", text: "more" },
    ])
    expect(feed.items.map((i) => i.type)).toEqual(["agentMessage", "reasoning"])
    expect(feed.items[1]).toMatchObject({ type: "reasoning", content: ["think more"] })
  })

  it("captures terminal status and error", () => {
    const feed = toThreadFeed([{ t: 1, kind: "status", state: "failed", error: "nope" }])
    expect(feed.status).toBe("failed")
    expect(feed.error).toBe("nope")
  })

  it("surfaces worker phase receipts", () => {
    const feed = toThreadFeed([{ t: 1, kind: "phase", phase: "amp-thread:T-child" }])
    expect(feed.items).toEqual([
      expect.objectContaining({ type: "toolCall", tool: "phase", status: "completed", result: "amp-thread:T-child" }),
    ])
  })
})

describe("toThreadFeed — command tools", () => {
  it("builds a commandExecution item and folds its paired result", () => {
    const feed = toThreadFeed([
      { t: 1, kind: "tool", id: "t1", name: "Bash", input: { command: ["zsh", "-lc", "ls"] } },
      { t: 2, kind: "tool-result", id: "t1", output: "a\nb", isError: false },
    ])
    const cmd = feed.items[0] as ThreadEventCommandExecutionItem
    expect(cmd.type).toBe("commandExecution")
    expect(cmd.command).toBe("ls")
    expect(cmd.status).toBe("completed")
    expect(cmd.aggregatedOutput).toBe("a\nb")
    expect(cmd.exitCode).toBe(0)
  })

  it("marks a failed command with exit code 1", () => {
    const feed = toThreadFeed([
      { t: 1, kind: "tool", id: "t1", name: "Bash", input: "false" },
      { t: 2, kind: "tool-result", id: "t1", isError: true },
    ])
    const cmd = feed.items[0] as ThreadEventCommandExecutionItem
    expect(cmd.status).toBe("failed")
    expect(cmd.exitCode).toBe(1)
  })
})

describe("toThreadFeed — file changes (H16: codex bare array)", () => {
  // Regression: the codex worker emits the changes array bare (codexToolInput returns item.changes),
  // so toRecord(array) was undefined → args?.changes missed → every file edit rendered empty.
  it("treats a bare-array tool input as the changes array", () => {
    const feed = toThreadFeed([
      {
        t: 1,
        kind: "tool",
        id: "f1",
        name: "fileChange",
        input: [
          { path: "src/a.ts", diff: "+added" },
          { path: "src/b.ts", diff: "-removed" },
        ],
      },
    ])
    const fc = feed.items[0] as ThreadEventFileChangeItem
    expect(fc.type).toBe("fileChange")
    expect(fc.changes.map((c) => c.path)).toEqual(["src/a.ts", "src/b.ts"])
    expect(fc.changes[0]!.diff).toBe("+added")
  })

  it("still supports an object-wrapped { changes: [...] }", () => {
    const feed = toThreadFeed([
      { t: 1, kind: "tool", id: "f1", name: "fileChange", input: { changes: [{ path: "x.ts" }] } },
    ])
    const fc = feed.items[0] as ThreadEventFileChangeItem
    expect(fc.changes.map((c) => c.path)).toEqual(["x.ts"])
  })

  it("builds a single change from Write content with a synthesized diff", () => {
    const feed = toThreadFeed([
      { t: 1, kind: "tool", id: "w1", name: "Write", input: { file_path: "n.ts", content: "a\nb" } },
    ])
    const fc = feed.items[0] as ThreadEventFileChangeItem
    expect(fc.changes[0]!.path).toBe("n.ts")
    expect(fc.changes[0]!.kind).toBe("add")
    expect(fc.changes[0]!.diff).toBe("+a\n+b")
  })

  it("drops bare-array entries with no path", () => {
    const feed = toThreadFeed([
      { t: 1, kind: "tool", id: "f1", name: "fileChange", input: [{ diff: "+x" }, { path: "ok.ts" }] },
    ])
    const fc = feed.items[0] as ThreadEventFileChangeItem
    expect(fc.changes.map((c) => c.path)).toEqual(["ok.ts"])
  })
})

describe("toThreadFeed — generic tools", () => {
  it("builds a toolCall and folds the result", () => {
    const feed = toThreadFeed([
      { t: 1, kind: "tool", id: "x1", name: "WebSearch", input: { q: "cats" } },
      { t: 2, kind: "tool-result", id: "x1", output: "results" },
    ])
    const tc = feed.items[0] as ThreadEventToolCallItem
    expect(tc.type).toBe("toolCall")
    expect(tc.tool).toBe("WebSearch")
    expect(tc.arguments).toEqual({ q: "cats" })
    expect(tc.status).toBe("completed")
    expect(tc.result).toBe("results")
  })

  it("pairs a result with the most recent unidentified tool when no ids are present", () => {
    const feed = toThreadFeed([
      { t: 1, kind: "tool", name: "Foo" },
      { t: 2, kind: "tool-result", output: "ok" },
    ])
    const tc = feed.items[0] as ThreadEventToolCallItem
    expect(tc.status).toBe("completed")
    expect(tc.result).toBe("ok")
    expect(feed.items).toHaveLength(1)
  })
})

describe("toThreadFeed — orphan / mismatched tool-result (M26)", () => {
  // Regression: a result with an id we never saw fell back to lastTool and clobbered an unrelated
  // tool's status (codex image_generation has no tool chunk → its result overwrote the prior tool).
  it("does NOT clobber the previous tool when an unknown-id result arrives", () => {
    const feed = toThreadFeed([
      { t: 1, kind: "tool", id: "real", name: "Bash", input: "ls" },
      { t: 2, kind: "tool-result", id: "image-xyz", name: "image_generation", output: "img.png" },
    ])
    // The real command must still be pending (unresolved), not flipped by the image result.
    const cmd = feed.items[0] as ThreadEventCommandExecutionItem
    expect(cmd.type).toBe("commandExecution")
    expect(cmd.status).toBe("pending")
    // The orphan result surfaces as its own completed toolCall.
    expect(feed.items).toHaveLength(2)
    const orphan = feed.items[1] as ThreadEventToolCallItem
    expect(orphan.type).toBe("toolCall")
    expect(orphan.tool).toBe("image_generation")
    expect(orphan.status).toBe("completed")
  })

  it("does not re-apply a stray second id-less result to an already-paired tool", () => {
    const feed = toThreadFeed([
      { t: 1, kind: "tool", name: "Foo" },
      { t: 2, kind: "tool-result", output: "first" },
      { t: 3, kind: "tool-result", output: "second" },
    ])
    const tc = feed.items[0] as ThreadEventToolCallItem
    expect(tc.result).toBe("first")
    // The second stray result becomes its own orphan toolCall rather than overwriting.
    expect(feed.items).toHaveLength(2)
    expect((feed.items[1] as ThreadEventToolCallItem).result).toBe("second")
  })

  it("surfaces a fully orphan result (no prior tool) as a completed toolCall", () => {
    const feed = toThreadFeed([{ t: 1, kind: "tool-result", name: "thing", output: "out" }])
    const tc = feed.items[0] as ThreadEventToolCallItem
    expect(tc.type).toBe("toolCall")
    expect(tc.tool).toBe("thing")
    expect(tc.status).toBe("completed")
  })
})
