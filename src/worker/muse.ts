// One fresh Muse exec process per attempt; the shared transport owns cancellation and stalls.
import { randomUUID } from "node:crypto"
import { type Dirent, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { isDeepStrictEqual } from "node:util"
import { homedir, tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { addUsage, emptyUsage, type AgentResult, type AgentSpec, type AgentUsage, type Effort } from "../dsl/types.js"
import { AgentError, AgentInterrupted, type Worker, type WorkerContext } from "./index.js"
import { assertValidSchema, parseJsonLoose, parseValidJson, validate } from "./schema.js"
import { captureStdout, exitError, runJsonlSubprocess, versionAtLeast, type SpawnProcess } from "./subprocess-jsonl.js"

const PROVIDER = "muse" as const
export const MUSE_MIN_VERSION = "1.2.1"
/**
 * Muse's model HTTP stream dies after 180s of silence unless these are set.
 * Max reasoning is silent longer than that. Values are seconds; Muse rejects 0.
 * The OmegaCode stdout watchdog must be at least this long, or a silent think
 * is killed locally before Muse's own stream idle cap can fire.
 */
const STREAM_IDLE_TIMEOUT_ENV = "TBH_STREAM_IDLE_TIMEOUT_SECS"
const STREAM_FIRST_EVENT_TIMEOUT_ENV = "TBH_STREAM_FIRST_EVENT_TIMEOUT_SECS"
const STREAM_TIMEOUT_SECS = "3600"
export const MUSE_DEFAULT_STALL_TIMEOUT_MS = Number(STREAM_TIMEOUT_SECS) * 1000
/** Cheap rewrite of an already-produced answer; must not re-run the original max-effort task. */
const EXTRACTION_MAX_TURNS = 8

function withStreamTimeouts(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...env,
    [STREAM_IDLE_TIMEOUT_ENV]: env[STREAM_IDLE_TIMEOUT_ENV] ?? STREAM_TIMEOUT_SECS,
    [STREAM_FIRST_EVENT_TIMEOUT_ENV]: env[STREAM_FIRST_EVENT_TIMEOUT_ENV] ?? STREAM_TIMEOUT_SECS,
  }
}

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
    this.stallTimeoutMs = opts.stallTimeoutMs ?? MUSE_DEFAULT_STALL_TIMEOUT_MS
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
    const workingSessionId = randomUUID()
    let usage = emptyUsage()
    let usageSessionId = workingSessionId
    try {
      const env = privateConfigEnv(scratch, spec.sandbox === "read-only")
      let prompt = spec.instructions ? `${spec.instructions}\n\n${spec.prompt}` : spec.prompt
      if (spec.schema) prompt += `\n\nReturn ONLY a JSON value conforming to this JSON Schema, without prose or code fences:\n${JSON.stringify(spec.schema)}`
      const working = await this.runExec(spec, {
        prompt, env, scratch, sessionId: workingSessionId, ctx,
        effort: spec.effort, maxTurns: spec.maxTurns, forwardProgress: true,
        onSpawn: (started) => { run = started },
      })
      run = working.run
      let text = working.text
      usage = sessionUsage(workingSessionId, ctx)
      let structured: unknown
      if (spec.schema) {
        structured = parseValidJson(text, spec.schema)
        if (structured === undefined) {
          let errors = "not valid JSON"
          try {
            errors = validate(spec.schema, parseJsonLoose(text)).errors ?? errors
          } catch { /* keep */ }
          const extractSessionId = randomUUID()
          usageSessionId = extractSessionId
          const extractTurns = spec.maxTurns === undefined
            ? EXTRACTION_MAX_TURNS
            : Math.min(EXTRACTION_MAX_TURNS, spec.maxTurns)
          const extraction = await this.runExec(spec, {
            prompt: extractionPrompt(spec, text, errors),
            env, scratch, sessionId: extractSessionId, ctx,
            effort: "low", maxTurns: extractTurns, forwardProgress: false,
            promptFile: "extract.txt", denyTools: true,
            onSpawn: (started) => { run = started },
          })
          run = extraction.run
          text = extraction.text
          usage = addUsage(usage, sessionUsage(extractSessionId, ctx))
          structured = parseValidJson(text, spec.schema)
          if (structured === undefined) {
            try { structured = parseJsonLoose(text) } catch {
              // finalizeResult raises the existing schema error and owns the last-resort full retry.
            }
          }
        }
      }
      ctx.onProgress({ kind: "usage", usage })
      return { text, structured, status: "completed", usage }
    } catch (err) {
      failed = true
      if (err instanceof AgentError && run) {
        await run.closed
        const reported = usageSessionId === workingSessionId
          ? sessionUsage(workingSessionId, ctx)
          : addUsage(usage, sessionUsage(usageSessionId, ctx))
        throw new AgentError({ provider: err.provider, code: err.code, message: err.message, retryable: err.retryable, usage: reported })
      }
      throw err
    } finally {
      await run?.closed
      try { rmSync(scratch, { recursive: true, force: true }) } catch (err) {
        if (!failed) throw err
      }
    }
  }

  private async runExec(spec: AgentSpec, opts: {
    prompt: string
    env: NodeJS.ProcessEnv
    scratch: string
    sessionId: string
    ctx: WorkerContext
    effort?: Effort
    maxTurns?: number
    forwardProgress: boolean
    promptFile?: string
    denyTools?: boolean
    onSpawn?: (run: ReturnType<typeof runJsonlSubprocess>) => void
  }): Promise<{ text: string; run: ReturnType<typeof runJsonlSubprocess> }> {
    const promptPath = join(opts.scratch, opts.promptFile ?? "prompt.txt")
    writeFileSync(promptPath, opts.prompt, { mode: 0o600 })
    const args = [
      "exec", "--json", "--prompt-file", promptPath, "--workspace", spec.cwd,
      "--session-id", opts.sessionId, "--no-foreign-personal-context", "--disable-web-tools",
      "--user-input-auto-resolve",
      ...(spec.sandbox === "read-only"
        ? ["--permission-profile", "omegacode-read-only"]
        : ["--approval-mode", "never", "--approval-judge", "off", "--disable-sandbox", "--disable-approval"]),
      ...(opts.denyTools ? ["--disable-write", "--disable-shell"] : []),
    ]
    if (spec.model) args.push("--model", spec.model)
    if (opts.effort) args.push("--reasoning-effort", opts.effort)
    if (opts.maxTurns !== undefined) args.push("--max-model-steps", String(opts.maxTurns))
    let terminal: { type: string; payload: Record<string, unknown> } | undefined
    const run = runJsonlSubprocess({
      provider: PROVIDER, bin: this.bin, args, cwd: spec.cwd, env: opts.env,
      signal: opts.ctx.signal, spawnProcess: this.spawnProcess, stallTimeoutMs: this.stallTimeoutMs,
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
        } else if (!opts.forwardProgress) {
          return
        } else if (type === "run.output.delta" && typeof payload.text === "string") {
          opts.ctx.onProgress({ kind: "text", text: payload.text })
        } else if (type === "tool.result") {
          const facts = isObject(payload.correlation_facts) ? payload.correlation_facts : {}
          opts.ctx.onProgress({ kind: "tool-result", name: str(facts.tool_name), id: str(payload.call_id),
            output: str(payload.text),
            isError: facts.outcome !== undefined && facts.outcome !== "success" })
        } else if (type === "run.model.configured" && typeof payload.model_id === "string") {
          opts.ctx.onProgress({ kind: "phase", phase: `model: ${payload.model_id}` })
        }
      },
    })
    opts.onSpawn?.(run)
    const exit = await run
    if (opts.ctx.signal.aborted) throw new AgentInterrupted()
    if (terminal && (terminal.type !== "run.terminal.completed" || terminal.payload.terminal !== "completed")) {
      throw new AgentError({ provider: PROVIDER, code: "turn_failed", message: str(terminal.payload.reason) || `Muse terminal: ${String(terminal.payload.terminal)}` })
    }
    if (exit.code !== 0) throw exitError(PROVIDER, this.bin, exit)
    if (!terminal) throw new AgentError({ provider: PROVIDER, code: "turn_incomplete", message: "Muse exited 0 without a terminal event" })
    if (typeof terminal.payload.text !== "string") {
      throw new AgentError({ provider: PROVIDER, code: "turn_failed", message: "Muse completed terminal has no text payload" })
    }
    return { text: terminal.payload.text, run }
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

function extractionPrompt(spec: AgentSpec, workingText: string, errors: string): string {
  return (
    `Earlier you produced this answer:\n\n${workingText}\n\n` +
    `It did not match the JSON Schema (${errors}). ` +
    "Return that same answer as a single JSON value that conforms to the following JSON Schema. " +
    "Output ONLY the JSON — no prose, no explanation, no code fences. Do not call tools. " +
    "Keep every finding and recommendation; only fix property names, enums, and required fields.\n\nSchema:\n" +
    JSON.stringify(spec.schema)
  )
}

/** Only settings are copied; all other entries, including auth, remain source-owned symlinks. */
function privateConfigEnv(scratch: string, readOnly: boolean): NodeJS.ProcessEnv {
  const env = { ...process.env }
  const source = resolve(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "muse")
  let settingsText = "{}"
  try { settingsText = readFileSync(join(source, "settings.json"), "utf8") } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      if (!readOnly) return withStreamTimeouts(env)
    } else {
      const cause = err as NodeJS.ErrnoException
      throw new AgentError({ provider: PROVIDER, code: "invalid_config", message: `Muse settings.json could not be read: ${cause.code}: ${cause.message}` })
    }
  }
  let settings: unknown
  try { settings = JSON.parse(settingsText) } catch {
    throw new AgentError({ provider: PROVIDER, code: "invalid_config", message: `Muse settings file is not valid JSON: ${join(source, "settings.json")}` })
  }
  if (!isObject(settings)) throw new AgentError({ provider: PROVIDER, code: "invalid_config", message: "Muse settings.json must contain an object" })
  delete settings.mcpServers
  if (readOnly) {
    const permissions = isObject(settings.permissions) ? settings.permissions : {}
    const profiles = isObject(permissions.profiles) ? permissions.profiles : {}
    settings.schema_version = 1
    settings.permissions = { ...permissions, schema_version: 1, profiles: {
      ...profiles,
      // OmegaCode owns this profile; overwrite any same-named user definition.
      "omegacode-read-only": { extends: ":read-only", approval: "allow_all", reviewer: "none" },
    } }
  }
  const xdg = join(scratch, "xdg")
  const target = join(xdg, "muse")
  mkdirSync(target, { recursive: true, mode: 0o700 })
  writeFileSync(join(target, "settings.json"), JSON.stringify(settings), { mode: 0o600 })
  let entries: Dirent[]
  try { entries = readdirSync(source, { withFileTypes: true }) } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err
    entries = []
  }
  for (const entry of entries) {
    if (entry.name !== "settings.json") symlinkSync(join(source, entry.name), join(target, entry.name), entry.isDirectory() ? "junction" : "file")
  }
  return withStreamTimeouts({ ...env, XDG_CONFIG_HOME: xdg })
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
function str(value: unknown): string | undefined { return typeof value === "string" ? value : undefined }

/** Read only this attempt's logs; never include log bytes in diagnostics. */
function sessionUsage(sessionId: string, ctx: WorkerContext): AgentUsage {
  // Muse 1.2.1 resolves only the XDG data root for session logs; a MUSE_HOME override is ignored (measured).
  const data = process.env.XDG_DATA_HOME ? join(process.env.XDG_DATA_HOME, "muse") : join(homedir(), ".local", "share", "muse")
  const root = join(data, "sessions")
  let path = join(root, sessionId, "session.jsonl")
  try {
    const now = new Date()
    const datePath = (utc: boolean) => join(root, String(utc ? now.getUTCFullYear() : now.getFullYear()),
      String((utc ? now.getUTCMonth() : now.getMonth()) + 1).padStart(2, "0"),
      String(utc ? now.getUTCDate() : now.getDate()).padStart(2, "0"))
    const directories = (parent: string, pattern?: RegExp): string[] => {
      try { return readdirSync(parent, { withFileTypes: true }).filter(e => e.isDirectory() && (!pattern || pattern.test(e.name))).map(e => e.name) }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error }
    }
    let session: string | undefined
    const find = (day: string) => { if (directories(day).includes(sessionId)) session = join(day, sessionId) }
    for (const day of new Set([datePath(false), datePath(true)])) { find(day); if (session) break }
    if (!session) {
      for (const year of directories(root, /^\d{4}$/)) {
        for (const month of directories(join(root, year), /^\d{2}$/)) {
          for (const day of directories(join(root, year, month), /^\d{2}$/)) {
            find(join(root, year, month, day)); if (session) break
          }
          if (session) break
        }
        if (session) break
      }
    }
    if (!session) throw new Error("session log missing")
    const logs = [join(session, "session.jsonl")]
    const collect = (dir: string) => {
      path = dir
      let entries: Dirent[]
      try { entries = readdirSync(dir, { withFileTypes: true }) }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error }
      for (const entry of entries) {
        if (entry.isDirectory()) collect(join(dir, entry.name))
        else if (entry.name === "session.jsonl") logs.push(join(dir, entry.name))
      }
    }
    collect(join(session, "subagent"))
    const usage = emptyUsage()
    let completions = 0
    const number = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined
    for (const log of logs) {
      path = log
      let validLines = 0
      let malformed = false
      for (const line of readFileSync(log, "utf8").split(/\r?\n/)) {
        if (!line.trim()) continue
        let value: unknown
        try { value = JSON.parse(line) } catch { malformed = true; continue }
        if (!isObject(value)) { malformed = true; continue }
        validLines++
        const event = isObject(value.payload) ? value.payload.event : undefined
        if (!isObject(event) || event.kind !== "model_completed" || !isObject(event.usage)) continue
        const raw = event.usage
        completions++
        usage.inputTokens += number(raw.input_tokens) ?? 0
        // Match Grok: reasoning is not added to the reported output total.
        usage.outputTokens += number(raw.output_tokens) ?? 0
        const read = number(raw.cache_read_tokens) ?? number(raw.cached_tokens)
        const write = number(raw.cache_write_tokens)
        if (read !== undefined) usage.cacheReadInputTokens = (usage.cacheReadInputTokens ?? 0) + read
        if (write !== undefined) usage.cacheCreationInputTokens = (usage.cacheCreationInputTokens ?? 0) + write
      }
      if (malformed && !validLines) throw new Error("malformed session log")
    }
    // A completed turn always made at least one model call; a log without one is truncated or reshaped, not free.
    if (!completions) throw new Error("no completion records")
    return usage
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    const reason = code || (error instanceof Error && ["session log missing", "malformed session log", "no completion records"].includes(error.message) ? error.message : "session log unavailable")
    ctx.onProgress({ kind: "phase", phase: `Muse usage unavailable: ${path} (${reason})` })
    return emptyUsage()
  }
}
