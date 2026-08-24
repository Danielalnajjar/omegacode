// AmpGrokWorker — runs the existing Grok provider through an Amp custom mode in a
// nested `amp --execute --stream-json-thinking` process. This is an explicit transport
// alternative for Amp orbs, where Amp is already authenticated but the Grok CLI is
// intentionally absent.
//
// The child process runs in spec.cwd, so it shares the parent orb checkout. Each
// sandbox maps to a separately registered mode and fail-closes on Amp's init tool
// list. Read-only gets only repository readers. danger-full-access adds the shell
// needed by Omega plan's artifact-writing lanes and the isolated Context Pack tool.

import { addUsage, emptyUsage, type AgentResult, type AgentSpec, type AgentUsage, type Effort } from "../dsl/types.js"
import type { Worker, WorkerContext, WorkerProgress } from "./index.js"
import { AgentError, AgentInterrupted } from "./index.js"
import { assertValidSchema, parseJsonLoose, parseValidJson } from "./schema.js"
import {
  captureStdout,
  exitError,
  runJsonlSubprocess,
  DEFAULT_STALL_TIMEOUT_MS,
  type SpawnProcess,
} from "./subprocess-jsonl.js"

const PROVIDER = "grok" as const
const READ_ONLY_TOOLS = new Set(["Read", "finder"])
const FULL_ACCESS_TOOLS = new Set(["Read", "finder", "shell_command", "verified_context_pack"])
const EXTRACTION_TOOLS = new Set<string>()
type ToolProfile = "read" | "full" | "extract"

const EFFORT_SUFFIX: Record<Effort, string> = {
  none: "low",
  minimal: "low",
  low: "low",
  medium: "med",
  high: "high",
  xhigh: "xhigh",
  max: "xhigh",
  ultra: "xhigh",
}

export interface AmpGrokWorkerOpts {
  bin?: string
  modePrefix?: string
  /** Test seam: replaces child_process.spawn for every subprocess. */
  spawnProcess?: SpawnProcess
  /** No-output stall watchdog (ms). 0 disables. */
  stallTimeoutMs?: number
}

interface TurnOutcome {
  text: string
  usage: AgentUsage
}

export class AmpGrokWorker implements Worker {
  readonly id = PROVIDER
  private readonly bin: string
  private readonly modePrefix: string
  private readonly spawnProcess?: SpawnProcess
  private readonly stallTimeoutMs: number
  private availabilityCheck: Promise<void> | null = null

  constructor(opts: AmpGrokWorkerOpts = {}) {
    this.bin = opts.bin ?? "amp"
    this.modePrefix = opts.modePrefix ?? "omega-grok"
    this.spawnProcess = opts.spawnProcess
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
    if (spec.approval !== "never") {
      throw new AgentError({
        provider: PROVIDER,
        code: "unsupported_option",
        message: "Amp-hosted Grok cannot surface approval requests to OmegaCode; use approval: \"never\"",
      })
    }
    if (spec.sandbox === "workspace-write") {
      throw new AgentError({
        provider: PROVIDER,
        code: "unsupported_option",
        message: "Amp-hosted Grok cannot enforce workspace-write confinement; use read-only or danger-full-access",
      })
    }
    if (spec.maxTurns !== undefined) {
      throw new AgentError({
        provider: PROVIDER,
        code: "unsupported_option",
        message: "Amp execute mode has no enforceable turn cap; omit maxTurns when using Amp-hosted Grok",
      })
    }
    if (spec.model !== undefined && spec.model !== "grok-4.6") {
      throw new AgentError({
        provider: PROVIDER,
        code: "unsupported_option",
        message: `Amp-hosted Grok is pinned to grok-4.6; received model \"${spec.model}\"`,
      })
    }
    if (spec.schema) {
      try {
        assertValidSchema(spec.schema)
      } catch (err) {
        throw new AgentError({ provider: PROVIDER, code: "invalid_schema", message: `output schema does not compile: ${(err as Error).message}` })
      }
    }

    await this.ensureAvailable()
    const workingProfile = spec.sandbox === "read-only" ? "read" : "full"
    const working = await this.runTurn(spec, withInstructions(spec, spec.prompt), ctx, workingProfile, true)
    if (!spec.schema) return { text: working.text, status: "completed", usage: working.usage }

    const workingStructured = parseValidJson(working.text, spec.schema)
    if (workingStructured !== undefined) {
      return { text: working.text, structured: workingStructured, status: "completed", usage: working.usage }
    }

    let extraction: TurnOutcome
    try {
      extraction = await this.runTurn(spec, extractionPrompt(spec, working.text), ctx, "extract", false)
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

  private ensureAvailable(): Promise<void> {
    if (!this.availabilityCheck) {
      this.availabilityCheck = captureStdout({
        provider: PROVIDER,
        bin: this.bin,
        args: ["--version"],
        env: this.env(),
        spawnProcess: this.spawnProcess,
      }).then((version) => {
        if (!version) {
          throw new AgentError({
            provider: PROVIDER,
            code: "provider_error",
            message: "amp --version returned no version",
          })
        }
      }).catch((err: unknown) => {
        this.availabilityCheck = null
        throw err
      })
    }
    return this.availabilityCheck
  }

  private mode(spec: AgentSpec, profile: ToolProfile): string {
    const mode = `${this.modePrefix}-${profile}-${EFFORT_SUFFIX[spec.effort ?? "medium"]}`
    if (mode.length > 24) {
      throw new AgentError({
        provider: PROVIDER,
        code: "unsupported_option",
        message: `Amp agent mode key exceeds its 24-character limit: \"${mode}\"; use a shorter mode prefix`,
      })
    }
    return mode
  }

  private env(): NodeJS.ProcessEnv {
    return { ...process.env, AMP_SKIP_UPDATE_CHECK: "1" }
  }

  private async runTurn(
    spec: AgentSpec,
    prompt: string,
    ctx: WorkerContext,
    profile: ToolProfile,
    forwardProgress: boolean,
  ): Promise<TurnOutcome> {
    let sawInit = false
    let sawResult = false
    let text = ""
    let usage = emptyUsage()
    let usageReported = false
    let resultError: string | undefined
    const forward = (event: WorkerProgress): void => {
      if (forwardProgress) ctx.onProgress(event)
    }

    const exit = await runJsonlSubprocess({
      provider: PROVIDER,
      bin: this.bin,
      args: [
        "--mode",
        this.mode(spec, profile),
        "--execute",
        "--stream-json-thinking",
        "--plugin-ready-timeout",
        "30",
        "--label",
        "omega",
      ],
      cwd: spec.cwd,
      env: this.env(),
      stdin: prompt,
      signal: ctx.signal,
      stallTimeoutMs: this.stallTimeoutMs,
      spawnProcess: this.spawnProcess,
      onValue: (value) => {
        if (!isObject(value)) return
        if (value.type === "system" && value.subtype === "init") {
          sawInit = true
          assertTools(profile, value.tools)
          const threadId = strOf(value.session_id)
          // Every nested execute creates a durable Amp thread, including silent
          // schema extraction turns. Preserve every ID even when other extraction
          // progress is intentionally hidden.
          if (threadId) ctx.onProgress({ kind: "phase", phase: `amp-thread:${threadId}` })
          return
        }
        if (value.type === "assistant" && isObject(value.message)) {
          for (const block of arrayOfObjects(value.message.content)) {
            if (block.type === "text" && typeof block.text === "string") {
              forward({ kind: "text", text: block.text })
            } else if (block.type === "thinking" && typeof block.thinking === "string") {
              forward({ kind: "reasoning", text: block.thinking })
            } else if (block.type === "tool_use") {
              forward({
                kind: "tool",
                id: strOf(block.id),
                name: strOf(block.name) ?? "tool",
                input: block.input,
              })
            }
          }
          const next = usageFromAmp(value.message)
          if (next) {
            usage = addUsage(usage, next)
            usageReported = true
            forward({ kind: "usage", usage })
          }
          return
        }
        if (value.type === "user" && isObject(value.message)) {
          for (const block of arrayOfObjects(value.message.content)) {
            if (block.type !== "tool_result") continue
            forward({
              kind: "tool-result",
              id: strOf(block.tool_use_id),
              output: stringifyUnknown(block.content),
              isError: block.is_error === true,
            })
          }
          return
        }
        if (value.type === "result") {
          sawResult = true
          const result = strOf(value.result)
          if (value.subtype !== "success" || value.is_error === true || !result) {
            resultError = strOf(value.error) ?? result ?? `amp returned result subtype ${String(value.subtype)}`
          } else {
            text = result
          }
        }
      },
    })

    if (ctx.signal.aborted) throw new AgentInterrupted()
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
    if (!sawInit) {
      throw new AgentError({ provider: PROVIDER, code: "protocol_drift", message: "amp exited 0 without an init event" })
    }
    if (!sawResult) {
      throw new AgentError({ provider: PROVIDER, code: "protocol_drift", message: "amp exited 0 without a terminal result event" })
    }
    if (resultError) {
      throw new AgentError({
        provider: PROVIDER,
        code: "provider_error",
        message: resultError,
        ...(usageReported ? { usage } : {}),
      })
    }
    if (!text) {
      throw new AgentError({ provider: PROVIDER, code: "no_result", message: "amp completed without assistant text" })
    }
    return { text, usage }
  }
}

function assertTools(profile: ToolProfile, value: unknown): void {
  if (!Array.isArray(value) || !value.every((tool) => typeof tool === "string")) {
    throw new AgentError({
      provider: PROVIDER,
      code: "protocol_drift",
      message: "amp init event did not report its tool list",
    })
  }
  const required = profile === "read" ? READ_ONLY_TOOLS : profile === "full" ? FULL_ACCESS_TOOLS : EXTRACTION_TOOLS
  const actual = new Set(value)
  const missing = [...required].filter((tool) => !actual.has(tool))
  const extra = [...actual].filter((tool) => !required.has(tool))
  if (missing.length || extra.length) {
    throw new AgentError({
      provider: PROVIDER,
      code: "sandbox_mismatch",
      message: `Amp-hosted Grok ${profile} mode has the wrong tool surface (missing: ${missing.join(", ") || "none"}; extra: ${extra.join(", ") || "none"})`,
    })
  }
}

function withInstructions(spec: AgentSpec, prompt: string): string {
  if (!spec.instructions) return prompt
  return `<instructions>\n${spec.instructions}\n</instructions>\n\n${prompt}`
}

function extractionPrompt(spec: AgentSpec, workingText: string): string {
  return (
    `Earlier you produced this answer:\n\n${workingText}\n\n` +
    "Return the answer as a single JSON value that conforms to the following JSON Schema. " +
    "Output ONLY JSON — no prose, explanation, or code fences. Do not call tools.\n\nSchema:\n" +
    JSON.stringify(spec.schema)
  )
}

function usageFromAmp(message: Record<string, unknown>): AgentUsage | undefined {
  const raw = isObject(message.usage) ? message.usage : undefined
  if (!raw) return undefined
  const direct = numOf(raw.input_tokens) ?? 0
  const cacheRead = numOf(raw.cache_read_input_tokens)
  const cacheCreate = numOf(raw.cache_creation_input_tokens)
  return {
    inputTokens: direct + (cacheRead ?? 0) + (cacheCreate ?? 0),
    outputTokens: numOf(raw.output_tokens) ?? 0,
    costUsd: 0,
    ...(cacheRead === undefined ? {} : { cacheReadInputTokens: cacheRead }),
    ...(cacheCreate === undefined ? {} : { cacheCreationInputTokens: cacheCreate }),
  }
}

function arrayOfObjects(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isObject) : []
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function strOf(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

function numOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function stringifyUnknown(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value)
  } catch {
    return undefined
  }
}
