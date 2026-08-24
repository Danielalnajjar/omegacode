// Adapter: omegacode `ChatChunk[]` → bb-shaped `ThreadEventItem[]`.
//
// The viewer drives bb's leaf timeline components from this item list. Mapping
// (per the port plan):
//   meta            → userMessage          (the instruction/prompt)
//   text            → agentMessage         (consecutive text coalesced)
//   reasoning       → reasoning            (consecutive reasoning coalesced)
//   command tool    → commandExecution     {command, status, aggregatedOutput, exitCode}
//   file tool       → fileChange           {changes:[{path,kind,diff}], status}
//   other tool      → toolCall             {tool, arguments, result, status}
//   status          → drives the trailing completion/working state (returned separately)
//
// tool-result chunks are folded into the tool item they pair with (by id, else
// the most recent unpaired tool), matching bb's exec/tool lifecycle.

import type { ChatChunk, ProviderId } from "./types"
import type {
  ThreadEventFileChange,
  ThreadEventFileChangeKind,
  ThreadEventItem,
  ThreadEventItemStatus,
} from "./thread-events"

export interface ThreadFeedMeta {
  index: number
  label: string
  provider: ProviderId
  model?: string
  prompt: string
}

export interface ThreadFeed {
  meta?: ThreadFeedMeta
  items: ThreadEventItem[]
  status?: "running" | "done" | "failed"
  error?: string
}

const COMMAND_TOOL_NAMES = new Set(["command", "commandExecution", "Bash", "bash", "shell", "exec"])
const FILE_TOOL_NAMES = new Set([
  "fileChange",
  "filechange",
  "Edit",
  "edit",
  "Write",
  "write",
  "MultiEdit",
  "multiedit",
  "ApplyPatch",
  "apply_patch",
  "applypatch",
  "str_replace_editor",
])

const SHELL_NAMES = new Set(["zsh", "bash", "sh", "dash", "ksh", "fish"])

/** Final path segment of an executable token (`/bin/zsh` → `zsh`). */
function baseExecutable(token: string): string {
  const segments = token.split(/[/\\]/)
  return segments[segments.length - 1] ?? token
}

function isCommandTool(name: string): boolean {
  return COMMAND_TOOL_NAMES.has(name)
}

function isFileTool(name: string): boolean {
  return FILE_TOOL_NAMES.has(name)
}

/** Unwrap a shell command from a string or array input (e.g. ["/bin/zsh","-lc","<script>"]). */
export function extractCommand(input: unknown): string {
  let parts: string[] | null = null
  if (Array.isArray(input)) {
    parts = input.map(String)
  } else if (input && typeof input === "object" && Array.isArray((input as Record<string, unknown>).command)) {
    parts = ((input as Record<string, unknown>).command as unknown[]).map(String)
  }
  if (parts) {
    // Only unwrap `<shell> -lc "<script>"` shapes: argv[0] must be a known shell, else a literal
    // `-c` flag to another binary (`python3 -c …`, `rg -c …`) would wrongly strip the executable (L23).
    const exe = parts[0] !== undefined ? baseExecutable(parts[0]) : ""
    if (SHELL_NAMES.has(exe)) {
      const ci = parts.findIndex((p) => p === "-lc" || p === "-c" || p === "-ic" || p === "-lic")
      if (ci >= 0 && parts[ci + 1] !== undefined) return parts.slice(ci + 1).join(" ")
    }
    return parts.join(" ")
  }
  const s =
    typeof input === "string"
      ? input
      : input && typeof input === "object" && typeof (input as Record<string, unknown>).command === "string"
        ? ((input as Record<string, unknown>).command as string)
        : null
  if (s == null) return ""
  const m = /^(?:\S*\/)?(?:zsh|bash|sh)\s+-[lic]+c?\s+(['"]?)([\s\S]*)\1\s*$/.exec(s.trim())
  return m ? m[2]! : s
}

function toRecord(input: unknown): Record<string, unknown> | undefined {
  if (input && typeof input === "object" && !Array.isArray(input)) {
    return input as Record<string, unknown>
  }
  if (input === undefined || input === null) return undefined
  return { input }
}

function fileChangeKind(name: string, args: Record<string, unknown> | undefined): ThreadEventFileChangeKind {
  const n = name.toLowerCase()
  if (n.includes("write") || n.includes("create") || n.includes("add")) return "add"
  if (n.includes("delete") || n.includes("remove") || n.includes("rm")) return "delete"
  if (args) {
    const k = String(args.kind ?? args.type ?? args.action ?? "").toLowerCase()
    if (k.includes("add") || k.includes("create")) return "add"
    if (k.includes("delete") || k.includes("remove")) return "delete"
  }
  return "update"
}

function buildFileChanges(name: string, input: unknown): ThreadEventFileChange[] {
  const args = toRecord(input)
  // A pre-shaped `changes` array (bb fileChange items already carry this). The codex worker emits
  // the changes array *bare* (codexToolInput returns item.changes), so accept either an `input`
  // that is the array itself or an object wrapping it (H16).
  const rawChanges = Array.isArray(input) ? input : args?.changes
  if (Array.isArray(rawChanges)) {
    return rawChanges
      .map((c): ThreadEventFileChange | null => {
        const rec = toRecord(c)
        const path = String(rec?.path ?? rec?.file_path ?? rec?.filePath ?? "")
        if (!path) return null
        return {
          path,
          kind: fileChangeKind(name, rec),
          movePath: rec?.movePath ? String(rec.movePath) : undefined,
          diff: typeof rec?.diff === "string" ? rec.diff : undefined,
        }
      })
      .filter((c): c is ThreadEventFileChange => c !== null)
  }

  const path = String(args?.path ?? args?.file_path ?? args?.filePath ?? "")
  if (!path) return []
  const diff = buildDiffFromArgs(name, args)
  return [
    {
      path,
      kind: fileChangeKind(name, args),
      diff,
    },
  ]
}

/** Synthesize a unified-ish diff from common edit-tool argument shapes. */
function buildDiffFromArgs(name: string, args: Record<string, unknown> | undefined): string | undefined {
  if (!args) return undefined
  if (typeof args.diff === "string") return args.diff
  if (typeof args.patch === "string") return args.patch
  // Write/create: whole file content becomes additions.
  const content = args.content ?? args.contents ?? args.text ?? args.new_str ?? args.file_text
  if (typeof content === "string" && (name.toLowerCase().includes("write") || name.toLowerCase().includes("create"))) {
    return content
      .split("\n")
      .map((line) => `+${line}`)
      .join("\n")
  }
  // Edit: old_string → new_string.
  const oldStr = args.old_string ?? args.old_str ?? args.oldText
  const newStr = args.new_string ?? args.new_str ?? args.newText
  if (typeof oldStr === "string" || typeof newStr === "string") {
    const removed =
      typeof oldStr === "string"
        ? oldStr
            .split("\n")
            .map((line) => `-${line}`)
            .join("\n")
        : ""
    const added =
      typeof newStr === "string"
        ? newStr
            .split("\n")
            .map((line) => `+${line}`)
            .join("\n")
        : ""
    return [removed, added].filter(Boolean).join("\n")
  }
  return undefined
}

interface PendingTool {
  item: ThreadEventItem
  kind: "command" | "file" | "tool"
}

function applyResult(pending: PendingTool, output: string | undefined, isError: boolean | undefined): void {
  const status: ThreadEventItemStatus = isError ? "failed" : "completed"
  switch (pending.kind) {
    case "command": {
      const cmd = pending.item as Extract<ThreadEventItem, { type: "commandExecution" }>
      cmd.status = status
      if (output && output.length > 0) cmd.aggregatedOutput = output
      cmd.exitCode = isError ? 1 : 0
      break
    }
    case "file": {
      const fc = pending.item as Extract<ThreadEventItem, { type: "fileChange" }>
      fc.status = status
      break
    }
    case "tool": {
      const tc = pending.item as Extract<ThreadEventItem, { type: "toolCall" }>
      tc.status = status
      if (output !== undefined) tc.result = output
      if (isError && output) tc.error = output
      break
    }
  }
}

export function toThreadFeed(chunks: ChatChunk[]): ThreadFeed {
  let meta: ThreadFeedMeta | undefined
  let status: "running" | "done" | "failed" | undefined
  let error: string | undefined
  const items: ThreadEventItem[] = []
  const toolById = new Map<string, PendingTool>()
  let lastTool: PendingTool | null = null

  let textBuf = ""
  let reasonBuf = ""
  let autoId = 0
  const nextId = (prefix: string) => `${prefix}-${autoId++}`

  const flushText = () => {
    if (textBuf) {
      items.push({ type: "agentMessage", id: nextId("msg"), text: textBuf })
      textBuf = ""
    }
  }
  const flushReason = () => {
    if (reasonBuf) {
      items.push({ type: "reasoning", id: nextId("reason"), summary: [], content: [reasonBuf] })
      reasonBuf = ""
    }
  }

  for (const c of chunks) {
    switch (c.kind) {
      case "meta":
        meta = { index: c.index, label: c.label, provider: c.provider, model: c.model, prompt: c.prompt }
        break
      case "text":
        flushReason()
        textBuf += c.text
        break
      case "reasoning":
        flushText()
        reasonBuf += c.text
        break
      case "phase":
        flushText()
        flushReason()
        items.push({
          type: "toolCall",
          id: nextId("phase"),
          tool: "phase",
          status: "completed",
          result: c.phase,
        })
        break
      case "tool": {
        flushText()
        flushReason()
        const id = c.id ?? nextId("tool")
        let pending: PendingTool
        if (isCommandTool(c.name)) {
          pending = {
            kind: "command",
            item: {
              type: "commandExecution",
              id,
              command: extractCommand(c.input),
              cwd: "",
              status: "pending",
            },
          }
        } else if (isFileTool(c.name)) {
          pending = {
            kind: "file",
            item: {
              type: "fileChange",
              id,
              changes: buildFileChanges(c.name, c.input),
              status: "pending",
            },
          }
        } else {
          pending = {
            kind: "tool",
            item: {
              type: "toolCall",
              id,
              tool: c.name,
              arguments: toRecord(c.input),
              status: "pending",
            },
          }
        }
        items.push(pending.item)
        if (c.id) toolById.set(c.id, pending)
        lastTool = pending
        break
      }
      case "tool-result": {
        // A result with an id we never saw is its own thing (e.g. codex image_generation has no
        // tool chunk) — don't fall back to lastTool, that clobbers an unrelated tool's status (M26).
        const matched = c.id ? toolById.get(c.id) : undefined
        const target: PendingTool | null = matched ?? (c.id ? null : lastTool)
        if (target) {
          applyResult(target, c.output, c.isError)
          // Consume the pairing so a stray second result can't re-apply to the same tool (M26).
          if (c.id) toolById.delete(c.id)
          if (target === lastTool) lastTool = null
        } else {
          // Orphan result — surface it as a completed tool call.
          flushText()
          flushReason()
          items.push({
            type: "toolCall",
            id: c.id ?? nextId("tool"),
            tool: c.name ?? "result",
            status: c.isError ? "failed" : "completed",
            result: c.output,
            error: c.isError ? c.output : undefined,
          })
        }
        break
      }
      case "status":
        status = c.state
        if (c.error) error = c.error
        break
    }
  }

  flushText()
  flushReason()
  return { meta, items, status, error }
}
