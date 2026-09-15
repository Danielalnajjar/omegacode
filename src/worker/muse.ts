// One fresh Muse exec process per attempt; the shared transport owns cancellation and stalls.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { isDeepStrictEqual } from "node:util"
import { homedir, tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { emptyUsage, type AgentResult, type AgentSpec } from "../dsl/types.js"
import { AgentError, AgentInterrupted, type Worker, type WorkerContext } from "./index.js"
import { assertValidSchema, parseJsonLoose } from "./schema.js"
import { captureStdout, DEFAULT_STALL_TIMEOUT_MS, exitError, runJsonlSubprocess, versionAtLeast, type SpawnProcess } from "./subprocess-jsonl.js"

const PROVIDER = "muse" as const
export const MUSE_MIN_VERSION = "1.2.1"

export interface MuseWorkerOpts {
  bin?: string
  /** Replaces spawn for both version probes and agent processes. */
  spawnProcess?: SpawnProcess
  stallTimeoutMs?: number
}

export class MuseWorker implements Worker {
  readonly id = PROVIDER
  private readonly bin: string
  private readonly spawnProcess?: SpawnProcess
  private readonly stallTimeoutMs: number
  private versionCheck: Promise<void> | null = null

  constructor(opts: MuseWorkerOpts = {}) {
    this.bin = opts.bin ?? "muse"
    this.spawnProcess = opts.spawnProcess
    this.stallTimeoutMs = opts.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS
  }

  async runAgent(spec: AgentSpec, ctx: WorkerContext): Promise<AgentResult> {
    if (ctx.signal.aborted) throw new AgentInterrupted()
    if (spec.sandbox === "workspace-write") {
      throw new AgentError({ provider: PROVIDER, code: "unsupported_sandbox", message: 'Muse supports only "read-only" and "danger-full-access"; workspace-write confinement failed verification' })
    }
    if (spec.serviceTier !== undefined || spec.approval !== "never") {
      throw new AgentError({ provider: PROVIDER, code: "unsupported_option", message: 'Muse requires approval: "never" and does not support codex-only serviceTier' })
    }
    if (spec.schema) {
      try { assertValidSchema(spec.schema) } catch (err) {
        throw new AgentError({ provider: PROVIDER, code: "invalid_schema", message: `output schema does not compile: ${(err as Error).message}` })
      }
    }
    try { await this.ensureVersion(ctx.signal) } catch (err) {
      if (!(err instanceof AgentInterrupted) || ctx.signal.aborted) throw err
      await this.ensureVersion(ctx.signal)
    }
    const scratch = mkdtempSync(join(tmpdir(), "omegacode-muse-"))
    let run: ReturnType<typeof runJsonlSubprocess> | undefined
    let failed = false
    try {
      const env = privateConfigEnv(scratch)
      const promptPath = join(scratch, "prompt.txt")
      let prompt = spec.instructions ? `${spec.instructions}\n\n${spec.prompt}` : spec.prompt
      if (spec.schema) prompt += `\n\nReturn ONLY a JSON value conforming to this JSON Schema, without prose or code fences:\n${JSON.stringify(spec.schema)}`
      writeFileSync(promptPath, prompt, { mode: 0o600 })
      const args = [
        "exec", "--json", "--prompt-file", promptPath, "--workspace", spec.cwd,
        "--no-session-log", "--no-foreign-personal-context", "--disable-web-tools",
        "--user-input-auto-resolve", "--approval-mode", "never", "--approval-judge", "off",
        ...(spec.sandbox === "read-only" ? ["--disable-write", "--disable-shell"] : ["--disable-sandbox", "--disable-approval"]),
      ]
      // Muse generates the fresh id: --session-id conflicts with --no-session-log in 1.2.1.
      if (spec.model) args.push("--model", spec.model)
      // The Muse effort menu equals OmegaCode's.
      if (spec.effort) args.push("--reasoning-effort", spec.effort)
      if (spec.maxTurns !== undefined) args.push("--max-model-steps", String(spec.maxTurns))
      let terminal: { type: string; payload: Record<string, unknown> } | undefined
      run = runJsonlSubprocess({
        provider: PROVIDER, bin: this.bin, args, cwd: spec.cwd, env,
        signal: ctx.signal, spawnProcess: this.spawnProcess, stallTimeoutMs: this.stallTimeoutMs,
        onValue: (value) => {
          if (!isObject(value) || !isObject(value.payload)) return
          const payload = value.payload
          const type = value.payload_type
          if (typeof type === "string" && type.startsWith("run.terminal.")) {
            if (terminal && (terminal.type !== type || !isDeepStrictEqual(terminal.payload, payload))) {
              throw new AgentError({ provider: PROVIDER, code: "turn_failed", message: "Muse emitted conflicting terminal records" })
            }
            terminal = { type, payload }
          } else if (terminal) {
            return
          } else if (type === "run.output.delta" && typeof payload.text === "string") {
            ctx.onProgress({ kind: "text", text: payload.text })
          } else if (type === "tool.result") {
            const facts = isObject(payload.correlation_facts) ? payload.correlation_facts : {}
            ctx.onProgress({ kind: "tool-result", name: str(facts.tool_name), id: str(payload.call_id),
              output: str(payload.text),
              isError: facts.outcome !== undefined && facts.outcome !== "success" })
          } else if (type === "run.model.configured" && typeof payload.model_id === "string") {
            ctx.onProgress({ kind: "phase", phase: `model: ${payload.model_id}` })
          }
        },
      })
      const exit = await run
      if (ctx.signal.aborted) throw new AgentInterrupted()
      if (terminal && (terminal.type !== "run.terminal.completed" || terminal.payload.terminal !== "completed")) {
        throw new AgentError({ provider: PROVIDER, code: "turn_failed", message: str(terminal.payload.reason) || `Muse terminal: ${String(terminal.payload.terminal)}` })
      }
      if (exit.code !== 0) throw exitError(PROVIDER, this.bin, exit)
      if (!terminal) throw new AgentError({ provider: PROVIDER, code: "turn_incomplete", message: "Muse exited 0 without a terminal event" })
      if (typeof terminal.payload.text !== "string") {
        throw new AgentError({ provider: PROVIDER, code: "turn_failed", message: "Muse completed terminal has no text payload" })
      }
      const text = terminal.payload.text
      let structured: unknown
      if (spec.schema) {
        try { structured = parseJsonLoose(text) } catch {
          // finalizeResult raises the existing schema error and owns the single corrective attempt.
        }
      }
      return { text, structured, status: "completed", usage: emptyUsage() }
    } catch (err) {
      failed = true
      throw err
    } finally {
      await run?.closed
      try { rmSync(scratch, { recursive: true, force: true }) } catch (err) {
        if (!failed) throw err
      }
    }
  }

  async shutdown(): Promise<void> {}

  private ensureVersion(signal: AbortSignal): Promise<void> {
    if (!this.versionCheck) {
      this.versionCheck = captureStdout({ provider: PROVIDER, bin: this.bin, args: ["--version"], signal, spawnProcess: this.spawnProcess })
        .then((version) => {
          if (!versionAtLeast(version, MUSE_MIN_VERSION)) {
            throw new AgentError({ provider: PROVIDER, code: "provider_outdated", message: `Muse ${version || "(unknown version)"} is below minimum ${MUSE_MIN_VERSION}; upgrade the Muse CLI` })
          }
        }).catch((err: unknown) => { this.versionCheck = null; throw err })
    }
    return this.versionCheck
  }
}

/** Only settings are copied; all other entries, including auth, remain source-owned symlinks. */
function privateConfigEnv(scratch: string): NodeJS.ProcessEnv {
  const env = { ...process.env }
  const source = resolve(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "muse")
  let settingsText: string
  try { settingsText = readFileSync(join(source, "settings.json"), "utf8") } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return env
    const cause = err as NodeJS.ErrnoException
    throw new AgentError({ provider: PROVIDER, code: "invalid_config", message: `Muse settings.json could not be read: ${cause.code}: ${cause.message}` })
  }
  let settings: unknown
  try { settings = JSON.parse(settingsText) } catch {
    throw new AgentError({ provider: PROVIDER, code: "invalid_config", message: `Muse settings file is not valid JSON: ${join(source, "settings.json")}` })
  }
  if (!isObject(settings)) throw new AgentError({ provider: PROVIDER, code: "invalid_config", message: "Muse settings.json must contain an object" })
  delete settings.mcpServers
  const xdg = join(scratch, "xdg")
  const target = join(xdg, "muse")
  mkdirSync(target, { recursive: true, mode: 0o700 })
  writeFileSync(join(target, "settings.json"), JSON.stringify(settings), { mode: 0o600 })
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (entry.name !== "settings.json") symlinkSync(join(source, entry.name), join(target, entry.name), entry.isDirectory() ? "junction" : "file")
  }
  return { ...env, XDG_CONFIG_HOME: xdg }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
function str(value: unknown): string | undefined { return typeof value === "string" ? value : undefined }
