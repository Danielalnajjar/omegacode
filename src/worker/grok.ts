// GrokWorker — drives the Grok CLI one shot at a time: `grok --prompt-file … --output-format streaming-json`.
//
// Grok does not take the prompt on stdin. Each turn writes a temp prompt file and passes
// `--prompt-file`. Live progress comes from streaming-json events. Structured output is a
// second turn that resumes the working session and asks for schema JSON only — `--json-schema`
// is not applied to the tool-using pass (current Grok builds can emit schema-shaped intermediate
// turns and burn the turn budget).
//
// Sandbox is honest OS confinement (Seatbelt/Landlock): read-only, workspace-write, and
// danger-full-access all map. Approval prompts cannot surface to omegacode, so approval must
// be "never". Nested Grok subagents are disabled — OmegaCode owns orchestration.
//
// Verified against grok 0.2.112+ (prompt-file, streaming-json, sandbox profiles, resume).

import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { addUsage, emptyUsage, type AgentResult, type AgentSpec, type AgentUsage, type Effort, type Sandbox } from "../dsl/types.js"
import type { Worker, WorkerContext, WorkerProgress } from "./index.js"
import { AgentError, AgentInterrupted } from "./index.js"
import { assertValidSchema, parseJsonLoose } from "./schema.js"
import {
  captureStdout,
  exitError,
  runJsonlSubprocess,
  versionAtLeast,
  DEFAULT_STALL_TIMEOUT_MS,
  type SpawnProcess,
} from "./subprocess-jsonl.js"

const PROVIDER = "grok" as const
const GROK_AGENT_PROFILE_PATH = fileURLToPath(
  new URL("./agents/fleet-omegacode-grok-worker.md", import.meta.url),
)

/** Minimum CLI whose flags and streaming-json event shapes this worker is verified against. */
export const GROK_MIN_VERSION = "0.2.112"

/** omegacode effort → grok-4.6 menu ids. none/minimal are not on that menu; max/ultra have no extra tier. */
const EFFORT_TO_GROK: Record<Effort, string> = {
  none: "low",
  minimal: "low",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "xhigh",
  ultra: "xhigh",
}

const SANDBOX_TO_GROK: Record<Sandbox, string> = {
  "read-only": "read-only",
  "workspace-write": "workspace",
  "danger-full-access": "off",
}

export interface GrokWorkerOpts {
  bin?: string
  /** Test seam: replaces child_process.spawn for every subprocess (runs AND --version). */
  spawnProcess?: SpawnProcess
  /** Test seam: replaces the regular-file check for the shipped agent profile. */
  agentProfileIsFile?: (path: string) => boolean
  /** No-output stall watchdog (ms). 0 disables. */
  stallTimeoutMs?: number
}

interface TurnOutcome {
  text: string
  usage: AgentUsage
  sessionId?: string
}

export class GrokWorker implements Worker {
  readonly id = PROVIDER
  private readonly bin: string
  private readonly spawnProcess?: SpawnProcess
  private readonly agentProfileIsFile: (path: string) => boolean
  private readonly stallTimeoutMs: number
  private agentProfileChecked = false
  private versionCheck: Promise<void> | null = null

  constructor(opts: GrokWorkerOpts = {}) {
    this.bin = opts.bin ?? "grok"
    this.spawnProcess = opts.spawnProcess
    this.agentProfileIsFile = opts.agentProfileIsFile ?? ((path) => {
      try {
        return statSync(path).isFile()
      } catch {
        return false
      }
    })
    this.stallTimeoutMs = opts.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS
  }

  async runAgent(spec: AgentSpec, ctx: WorkerContext): Promise<AgentResult> {
    if (ctx.signal.aborted) throw new AgentInterrupted()
    if (spec.serviceTier !== undefined) {
      throw new AgentError({
        provider: PROVIDER,
        code: "unsupported_option",
        message: "serviceTier is codex-only; omit it or use the codex provider",
      })
    }
    if (spec.schema) {
      try {
        assertValidSchema(spec.schema)
      } catch (err) {
        throw new AgentError({ provider: PROVIDER, code: "invalid_schema", message: `output schema does not compile: ${(err as Error).message}` })
      }
    }
    if (spec.approval !== "never") {
      throw new AgentError({
        provider: PROVIDER,
        code: "unsupported_option",
        message: `grok runs as a one-shot subprocess and cannot surface approval requests to omegacode — use approval: "never" with provider "grok"`,
      })
    }
    this.ensureAgentProfile()
    await this.ensureVersion()

    const working = await this.runTurn(spec, spec.prompt, ctx, { forwardProgress: true })
    if (!spec.schema) return { text: working.text, status: "completed", usage: working.usage }

    let extraction: TurnOutcome
    try {
      extraction = await this.runTurn(spec, extractionPrompt(spec, working), ctx, {
        forwardProgress: false,
        resume: working.sessionId,
        noTools: true,
      })
    } catch (err) {
      if (err instanceof AgentError) {
        throw new AgentError({
          provider: err.provider,
          code: err.code,
          message: err.message,
          retryable: err.retryable,
          usage: addUsage(working.usage, err.usage ?? emptyUsage()),
        })
      }
      throw err
    }
    let structured: unknown
    try {
      structured = parseJsonLoose(extraction.text)
    } catch {
      structured = undefined
    }
    return {
      text: extraction.text,
      structured,
      status: "completed",
      usage: addUsage(working.usage, extraction.usage),
    }
  }

  async shutdown(): Promise<void> {
    // Spawn-per-call: nothing persistent to tear down.
  }

  private ensureVersion(): Promise<void> {
    if (!this.versionCheck) {
      this.versionCheck = this.checkVersion().catch((err: unknown) => {
        this.versionCheck = null
        throw err
      })
    }
    return this.versionCheck
  }

  private ensureAgentProfile(): void {
    if (this.agentProfileChecked) return
    if (!this.agentProfileIsFile(GROK_AGENT_PROFILE_PATH)) {
      throw new AgentError({
        provider: PROVIDER,
        code: "provider_error",
        message: `shipped Grok agent profile is missing or not a regular file: ${GROK_AGENT_PROFILE_PATH}`,
        retryable: false,
      })
    }
    this.agentProfileChecked = true
  }

  private async checkVersion(): Promise<void> {
    const out = await captureStdout({
      provider: PROVIDER,
      bin: this.bin,
      args: ["--version"],
      env: this.env(),
      spawnProcess: this.spawnProcess,
    })
    if (!versionAtLeast(out, GROK_MIN_VERSION)) {
      throw new AgentError({
        provider: PROVIDER,
        code: "provider_outdated",
        message: `grok ${out || "(unknown version)"} is below the minimum supported ${GROK_MIN_VERSION} — upgrade the grok CLI`,
        retryable: false,
      })
    }
  }

  private env(): NodeJS.ProcessEnv {
    return { ...process.env, GROK_DISABLE_AUTOUPDATER: "1" }
  }

  private baseArgs(spec: AgentSpec, opts: { resume?: string; noTools?: boolean }): string[] {
    const sandbox = SANDBOX_TO_GROK[spec.sandbox]
    const args = [
      "--cwd",
      spec.cwd,
      "--sandbox",
      sandbox,
      "--output-format",
      "streaming-json",
      "--no-auto-update",
      "--no-subagents",
    ]
    if (!opts.resume) args.push("--agent", GROK_AGENT_PROFILE_PATH)
    if (opts.resume) args.push("--resume", opts.resume)
    if (spec.model) args.push("-m", spec.model)
    if (spec.effort) args.push("--reasoning-effort", EFFORT_TO_GROK[spec.effort])
    if (spec.instructions) args.push("--rules", spec.instructions)
    if (spec.maxTurns !== undefined) args.push("--max-turns", String(spec.maxTurns))
    if (opts.noTools) args.push("--tools", "", "--deny", "MCPTool")
    if (spec.sandbox === "read-only") {
      args.push("--permission-mode", "plan")
    } else {
      args.push("--always-approve")
    }
    return args
  }

  private async runTurn(
    spec: AgentSpec,
    prompt: string,
    ctx: WorkerContext,
    opts: { forwardProgress: boolean; resume?: string; noTools?: boolean },
  ): Promise<TurnOutcome> {
    const scratch = mkdtempSync(join(tmpdir(), "omegacode-grok-"))
    const promptPath = join(scratch, "prompt.txt")
    writeFileSync(promptPath, prompt, "utf8")
    const args = [...this.baseArgs(spec, opts), "--prompt-file", promptPath]

    let text = ""
    let usage = emptyUsage()
    let usageReported = false
    let sessionId: string | undefined
    let streamErrorMessage: string | undefined
    let sawEnd = false
    let stopReason: string | undefined
    let sawMaxTurns = false
    const forward = (e: WorkerProgress): void => {
      if (opts.forwardProgress) ctx.onProgress(e)
    }

    try {
      const exit = await runJsonlSubprocess({
        provider: PROVIDER,
        bin: this.bin,
        args,
        cwd: spec.cwd,
        env: this.env(),
        signal: ctx.signal,
        stallTimeoutMs: this.stallTimeoutMs,
        spawnProcess: this.spawnProcess,
        onValue: (value) => {
          if (!isObject(value)) return
          if (sessionId === undefined && typeof value.sessionId === "string") sessionId = value.sessionId
          switch (value.type) {
            case "text": {
              const t = strOf(value.data)
              if (t !== undefined) {
                text += t
                forward({ kind: "text", text: t })
              }
              return
            }
            case "thought": {
              const t = strOf(value.data)
              if (t !== undefined) forward({ kind: "reasoning", text: t })
              return
            }
            case "tool_call": {
              forward({
                kind: "tool",
                id: strOf(value.toolCallId),
                name: strOf(value.toolName) ?? "tool",
                input: value.rawInput,
              })
              return
            }
            case "tool_call_update": {
              const status = strOf(value.status)
              if (status !== "completed" && status !== "error" && status !== "failed") return
              forward({
                kind: "tool-result",
                id: strOf(value.toolCallId),
                name: strOf(value.toolName),
                output: stringifyUnknown(value.rawOutput) ?? strOf(value.message),
                isError: status !== "completed",
              })
              return
            }
            case "usage": {
              const next = usageFromGrok(value)
              if (next) {
                usage = addUsage(usage, next)
                usageReported = true
                forward({
                  kind: "usage",
                  usage: {
                    inputTokens: usage.inputTokens,
                    outputTokens: usage.outputTokens,
                    ...(usage.cacheReadInputTokens === undefined ? {} : { cacheReadInputTokens: usage.cacheReadInputTokens }),
                    ...(usage.cacheCreationInputTokens === undefined ? {} : { cacheCreationInputTokens: usage.cacheCreationInputTokens }),
                  },
                })
              }
              return
            }
            case "end": {
              sawEnd = true
              stopReason = strOf(value.stopReason)
              const next = usageFromGrok(value)
              if (next) {
                // Terminal usage is aggregate for the whole prompt, so it supersedes the
                // per-response usage events accumulated above.
                usage = next
                usageReported = true
                forward({
                  kind: "usage",
                  usage: {
                    inputTokens: usage.inputTokens,
                    outputTokens: usage.outputTokens,
                    ...(usage.cacheReadInputTokens === undefined ? {} : { cacheReadInputTokens: usage.cacheReadInputTokens }),
                    ...(usage.cacheCreationInputTokens === undefined ? {} : { cacheCreationInputTokens: usage.cacheCreationInputTokens }),
                  },
                })
              }
              return
            }
            case "max_turns_reached": {
              sawMaxTurns = true
              return
            }
            case "error": {
              streamErrorMessage ??= strOf(value.message) ?? "grok reported an error"
              const next = usageFromGrok(value)
              if (next) {
                // Error usage is also aggregate and is the best available billed total.
                usage = next
                usageReported = true
              }
              return
            }
            default:
              return
          }
        },
      })

      if (streamErrorMessage) {
        throw new AgentError({
          provider: PROVIDER,
          code: "provider_error",
          message: streamErrorMessage,
          retryable: false,
          ...(usageReported ? { usage } : {}),
        })
      }
      if (ctx.signal.aborted) throw new AgentInterrupted()
      if (sawMaxTurns) {
        throw new AgentError({
          provider: PROVIDER,
          code: "error_max_turns",
          message: "grok reached the configured maximum turn count before completing",
          retryable: false,
          ...(usageReported ? { usage } : {}),
        })
      }
      if (sawEnd && stopReason === undefined) {
        throw new AgentError({
          provider: PROVIDER,
          code: "protocol_drift",
          message: "grok emitted a terminal end event without a stopReason",
          retryable: false,
          ...(usageReported ? { usage } : {}),
        })
      }
      if (sawEnd && stopReason !== "end_turn") {
        throw new AgentError({
          provider: PROVIDER,
          code: "incomplete_result",
          message: `grok stopped with ${stopReason} before completing the turn`,
          retryable: false,
          ...(usageReported ? { usage } : {}),
        })
      }
      if (exit.code !== 0) {
        const err = exitError(PROVIDER, this.bin, exit)
        throw new AgentError({
          provider: err.provider,
          code: err.code,
          message: err.message,
          retryable: err.retryable,
          ...(usageReported ? { usage } : {}),
        })
      }
      if (!sawEnd) {
        throw new AgentError({
          provider: PROVIDER,
          code: "protocol_drift",
          message: "grok exited 0 without a terminal end event",
          retryable: false,
          ...(usageReported ? { usage } : {}),
        })
      }
      if (text.length === 0) {
        throw new AgentError({ provider: PROVIDER, code: "no_result", message: "grok exited 0 without producing any assistant text" })
      }
      return { text, usage, sessionId }
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  }
}

function extractionPrompt(spec: AgentSpec, working: TurnOutcome): string {
  const context = working.sessionId ? "" : `Earlier you produced this answer:\n\n${working.text}\n\n`
  return (
    context +
    "Return your final answer as a single JSON value that conforms to the following JSON Schema. " +
    "Output ONLY the JSON — no prose, no explanation, no code fences. Do not call tools.\n\nSchema:\n" +
    JSON.stringify(spec.schema)
  )
}

function usageFromGrok(value: Record<string, unknown>): AgentUsage | undefined {
  const raw = isObject(value.usage) ? value.usage : undefined
  if (!raw) return undefined
  const cacheRead = numOf(raw.cache_read_input_tokens)
  const cacheCreate = numOf(raw.cache_creation_input_tokens)
  const input = (numOf(raw.input_tokens) ?? 0) + (cacheRead ?? 0) + (cacheCreate ?? 0)
  // Grok reports reasoning_tokens as a subset of output_tokens.
  const output = numOf(raw.output_tokens) ?? 0
  const cost = numOf(value.total_cost_usd) ?? numOf(raw.cost_usd) ?? 0
  return {
    inputTokens: input,
    outputTokens: output,
    costUsd: cost,
    ...(cacheRead === undefined ? {} : { cacheReadInputTokens: cacheRead }),
    ...(cacheCreate === undefined ? {} : { cacheCreationInputTokens: cacheCreate }),
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v)
}

function strOf(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined
}

function numOf(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined
}

function stringifyUnknown(v: unknown): string | undefined {
  if (v === undefined) return undefined
  if (typeof v === "string") return v
  try {
    return JSON.stringify(v)
  } catch {
    return undefined
  }
}
