// FxWorker — drives the fx CLI one shot at a time: `fx ask --json --no-save`, prompt on stdin.
//
// Exact FX v0.0.6 only (tag 79666393e5f613c85f2f0b4b65475f1addd55379). Admission proves the
// platform binary SHA-256, a private managed automation HOME (`OMEGACODE_FX_HOME`), non-secret
// `$HOME/.fx/settings.json`, lstat-only `$HOME/.fx/chatgpt-auth.json`, and `fx status --json`
// before any paid ask. `--no-save` is session behavior, not profile isolation.
//
// Safety surface (full-access only): fx ask has no OmegaCode-visible approval prompt, and this
// worker only admits yolo/noninteractive authority. read-only/workspace-write, serviceTier,
// maxTurns, and effort are rejected pre-spawn. Usage is unavailable: numeric zeros are a known
// lower bound marked incomplete, never a measured total.
//
// Structured output: working turn → local schema validation → a second tool-less extraction
// turn. fx has no no-tools flag; extraction prompts forbid tools and nonempty tool_calls fail.

import { createHash } from "node:crypto"
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import {
  lstatSync,
  readFileSync,
  realpathSync,
  type Stats,
} from "node:fs"
import { homedir, tmpdir } from "node:os"
import { isAbsolute, join } from "node:path"
import { addUsage, type AgentResult, type AgentSpec, type AgentUsage } from "../dsl/types.js"
import type { Worker, WorkerContext } from "./index.js"
import { AgentError, AgentInterrupted } from "./index.js"
import { assertValidSchema, parseJsonLoose, parseValidJson } from "./schema.js"
import {
  DEFAULT_KILL_GRACE_MS,
  DEFAULT_STALL_TIMEOUT_MS,
  type SpawnProcess,
} from "./subprocess-jsonl.js"

const PROVIDER = "fx" as const

/** Exact supported CLI version. Later, earlier, and unidentified builds are refused. */
export const FX_VERSION = "0.0.6"

/** Extracted v0.0.6 platform binary SHA-256 digests (coordinator-computed from official archives). */
export const FX_BINARY_DIGESTS = {
  "linux-aarch64": "0838c0313f8a8549948a2407b4dc538609980dbf6375ea77d763d5ab92c6fd38",
  "linux-x86_64": "a4ea16e7869007c48903a469ee7145e83d9d63df315dfffb9013a220368c30ae",
  "macos-aarch64": "d66a86229d882881075e97e04fc043410ef5d7815d502e31db9ce669fecca292",
  "macos-x86_64": "fe7f96d98fb29a5bd567c501af0ecf208251cac7ac10b82a1836edfe6ecf9acc",
} as const

export type FxPlatformId = keyof typeof FX_BINARY_DIGESTS

const AUTH_LABEL = "Codex subscription"
const MODEL_SOURCE_LABEL = "Codex subscription"
const ENV_PASSTHROUGH = [
  "PATH",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TERM",
  "NO_COLOR",
  "USER",
  "LOGNAME",
] as const

export interface FxWorkerOpts {
  bin?: string
  /** Test seam: replaces child_process.spawn for every subprocess. */
  spawnProcess?: SpawnProcess
  /** Test seam: SHA-256 hex of the admitted binary. */
  hashBinary?: (bin: string) => string
  /** Test seam: platform identity used for digest admission. */
  platform?: { os: NodeJS.Platform; arch: string }
  /** Test seam: overrides OMEGACODE_FX_HOME. */
  managedHome?: string
  /** No-output stall watchdog (ms). 0 disables. */
  stallTimeoutMs?: number
  killGraceMs?: number
}

interface TurnOutcome {
  text: string
  usage: AgentUsage
  toolCalls: unknown[]
}

export class FxWorker implements Worker {
  readonly id = PROVIDER
  private readonly bin: string
  private readonly spawnProcess?: SpawnProcess
  private readonly hashBinary: (bin: string) => string
  private readonly platform: { os: NodeJS.Platform; arch: string }
  private readonly managedHomeOverride?: string
  private readonly stallTimeoutMs: number
  private readonly killGraceMs: number

  constructor(opts: FxWorkerOpts = {}) {
    this.bin = opts.bin ?? process.env.FX_BIN ?? "fx"
    this.spawnProcess = opts.spawnProcess
    this.hashBinary = opts.hashBinary ?? defaultHashBinary
    this.platform = opts.platform ?? { os: process.platform, arch: process.arch }
    this.managedHomeOverride = opts.managedHome
    this.stallTimeoutMs = opts.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS
    this.killGraceMs = opts.killGraceMs ?? DEFAULT_KILL_GRACE_MS
  }

  async runAgent(spec: AgentSpec, ctx: WorkerContext): Promise<AgentResult> {
    if (ctx.signal.aborted) throw new AgentInterrupted()
    rejectUnsupported(spec)
    if (spec.schema) {
      try {
        assertValidSchema(spec.schema)
      } catch (err) {
        throw new AgentError({
          provider: PROVIDER,
          code: "invalid_schema",
          message: `output schema does not compile: ${(err as Error).message}`,
        })
      }
    }
    const model = requiredModel(spec)
    const home = resolveManagedHome(this.managedHomeOverride)
    validateManagedHome(home)
    validateSettings(home, model)
    validateAuthMetadata(home)
    await this.checkBinary()
    const env = scrubbedEnv(home, model)
    await this.checkStatus(spec, env, model, ctx.signal)

    const working = await this.runTurn(spec, env, workingPrompt(spec), ctx, true)
    const usage = unknownUsage()
    if (!spec.schema) return { text: working.text, status: "completed", usage }

    const workingStructured = parseValidJson(working.text, spec.schema)
    if (workingStructured !== undefined) {
      return { text: working.text, structured: workingStructured, status: "completed", usage }
    }

    const extraction = await this.runTurn(spec, env, extractionPrompt(spec, working.text), ctx, false)
    if (extraction.toolCalls.length > 0) {
      throw new AgentError({
        provider: PROVIDER,
        code: "extraction_used_tools",
        message: "fx extraction turn used tools; fx has no no-tools flag and tool_calls must be empty",
        usage: addUsage(usage, unknownUsage()),
      })
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
      usage: addUsage(usage, unknownUsage()),
    }
  }

  async shutdown(): Promise<void> {
    // Spawn-per-call: nothing persistent to tear down.
  }

  private async checkBinary(): Promise<void> {
    const home = resolveManagedHome(this.managedHomeOverride)
    validateManagedHome(home)
    validateBinaryMetadata(this.bin)
    const platformId = platformIdOf(this.platform)
    if (!platformId) {
      throw new AgentError({
        provider: PROVIDER,
        code: "provider_digest",
        message: `fx has no admitted ${FX_VERSION} digest for ${this.platform.os}/${this.platform.arch}`,
      })
    }
    let digest: string
    try {
      digest = this.hashBinary(this.bin)
    } catch (err) {
      throw new AgentError({
        provider: PROVIDER,
        code: "provider_digest",
        message: `cannot hash fx binary "${this.bin}": ${(err as Error).message}`,
      })
    }
    const expected = FX_BINARY_DIGESTS[platformId]
    if (digest !== expected) {
      throw new AgentError({
        provider: PROVIDER,
        code: "provider_digest",
        message: `fx ${FX_VERSION} ${platformId} digest ${digest} is not the admitted ${expected}`,
      })
    }
    const exit = await runFxProcess({
      bin: this.bin,
      args: ["--version"],
      cwd: tmpdir(),
      env: scrubbedEnv(home, "admission"),
      signal: new AbortController().signal,
      stallTimeoutMs: 10_000,
      killGraceMs: 1_000,
      spawnProcess: this.spawnProcess,
    })
    if (exit.signal || (exit.code !== 0 && exit.code !== null)) {
      throw new AgentError({
        provider: PROVIDER,
        code: "provider_exit",
        message: `${this.bin} --version failed (${exit.signal ? `signal ${exit.signal}` : `code ${exit.code}`})`,
      })
    }
    const version = parseExactVersion(exit.stdout)
    if (version !== FX_VERSION) {
      throw new AgentError({
        provider: PROVIDER,
        code: version === undefined ? "provider_unidentified" : "provider_version",
        message:
          version === undefined
            ? `fx produced an unidentified version string ${JSON.stringify(exit.stdout.trim())} — only exact ${FX_VERSION} is supported`
            : `fx ${version} is not the supported exact ${FX_VERSION} — v0.0.5, later versions, and unidentified builds are refused`,
      })
    }
  }

  private async checkStatus(
    spec: AgentSpec,
    env: NodeJS.ProcessEnv,
    model: string,
    signal: AbortSignal,
  ): Promise<void> {
    const exit = await runFxProcess({
      bin: this.bin,
      args: ["status", "--json"],
      cwd: spec.cwd,
      env,
      signal,
      stallTimeoutMs: 10_000,
      killGraceMs: 1_000,
      spawnProcess: this.spawnProcess,
    })
    if (signal.aborted) throw new AgentInterrupted()
    if (exit.signal) throw new AgentInterrupted(`fx status interrupted (${exit.signal})`)
    if (exit.code !== 0) {
      throw new AgentError({
        provider: PROVIDER,
        code: "provider_exit",
        message: `${this.bin} status --json exited ${exit.code}${stderrNote(exit.stderrTail)}`,
      })
    }
    const status = parseExactJsonObject(exit.stdout, "status --json")
    const statusModel = strOf(status.model)
    const modelSource = strOf(status.model_source)
    const auth = strOf(status.auth)
    const permission = strOf(status.permission_mode)
    if (status.kind !== "status") {
      throw new AgentError({
        provider: PROVIDER,
        code: "malformed_output",
        message: "fx status --json did not emit a status envelope",
      })
    }
    if (statusModel !== model) {
      throw new AgentError({
        provider: PROVIDER,
        code: "wrong_model",
        message: `fx status model ${JSON.stringify(statusModel)} does not match requested ${JSON.stringify(model)}`,
      })
    }
    if (modelSource !== MODEL_SOURCE_LABEL) {
      throw new AgentError({
        provider: PROVIDER,
        code: "wrong_provider",
        message: `fx status model_source ${JSON.stringify(modelSource)} is not ${JSON.stringify(MODEL_SOURCE_LABEL)}`,
      })
    }
    if (auth !== AUTH_LABEL) {
      throw new AgentError({
        provider: PROVIDER,
        code: "auth_metadata",
        message: `fx status auth ${JSON.stringify(auth)} does not identify ${JSON.stringify(AUTH_LABEL)}`,
      })
    }
    if (status.auth_refreshable !== true) {
      throw new AgentError({
        provider: PROVIDER,
        code: "auth_metadata",
        message: "fx status auth_refreshable is not true",
      })
    }
    if (permission !== "yolo") {
      throw new AgentError({
        provider: PROVIDER,
        code: "wrong_permission",
        message: `fx status permission_mode ${JSON.stringify(permission)} is not "yolo"`,
      })
    }
    if (status.auth_expired === true) {
      throw new AgentError({
        provider: PROVIDER,
        code: "auth_metadata",
        message: "fx status reports that the Codex subscription credential is expired",
      })
    }
    if (status.mcp_config_error !== undefined) {
      throw new AgentError({
        provider: PROVIDER,
        code: "mcp_config_error",
        message: "fx status reports an MCP configuration error",
      })
    }
    const connected = status.connected_providers
    if (!Array.isArray(connected) || !connected.includes("codex")) {
      throw new AgentError({
        provider: PROVIDER,
        code: "wrong_provider",
        message: "fx status does not attest a connected Codex subscription provider",
      })
    }
    const statusWorkspace = strOf(status.workspace)
    if (statusWorkspace === undefined || !sameRealPath(statusWorkspace, spec.cwd)) {
      throw new AgentError({
        provider: PROVIDER,
        code: "wrong_workspace",
        message: "fx status workspace does not match the requested agent cwd",
      })
    }
  }

  private async runTurn(
    spec: AgentSpec,
    env: NodeJS.ProcessEnv,
    prompt: string,
    ctx: WorkerContext,
    forwardProgress: boolean,
  ): Promise<TurnOutcome> {
    let exit: FxProcessExit
    try {
      exit = await runFxProcess({
        bin: this.bin,
        args: ["ask", "--json", "--no-save"],
        cwd: spec.cwd,
        env,
        stdin: prompt,
        signal: ctx.signal,
        stallTimeoutMs: this.stallTimeoutMs,
        killGraceMs: this.killGraceMs,
        spawnProcess: this.spawnProcess,
      })
    } catch (err) {
      throw withUnknownUsage(err)
    }
    if (ctx.signal.aborted) throw new AgentInterrupted("fx interrupted", unknownUsage())
    if (exit.signal) throw new AgentInterrupted(`fx interrupted (${exit.signal})`, unknownUsage())
    if (exit.code === 130 || exit.code === 143) {
      throw new AgentInterrupted(`fx interrupted (code ${exit.code})`, unknownUsage())
    }
    if (exit.code !== 0) {
      throw new AgentError({
        provider: PROVIDER,
        code: "provider_exit",
        message: `${this.bin} exited code ${exit.code ?? "null"}${stderrNote(exit.stderrTail)}`,
        retryable: false,
        usage: unknownUsage(),
      })
    }
    let envelope: AskEnvelope
    try {
      envelope = parseAskEnvelope(exit.stdout)
    } catch (err) {
      throw withUnknownUsage(err)
    }
    if (envelope.exit_code !== 0) {
      throw new AgentError({
        provider: PROVIDER,
        code: envelopeErrorCode(envelope, "inner_exit"),
        message: innerFailureMessage(envelope),
        usage: unknownUsage(),
      })
    }
    if (hasEnvelopeFailure(envelope)) {
      throw new AgentError({
        provider: PROVIDER,
        code: envelopeErrorCode(envelope, "provider_error"),
        message: innerFailureMessage(envelope),
        usage: unknownUsage(),
      })
    }
    if (envelope.model !== env.FX_MODEL) {
      throw new AgentError({
        provider: PROVIDER,
        code: "wrong_model",
        message: `fx ask model ${JSON.stringify(envelope.model)} does not match requested ${JSON.stringify(env.FX_MODEL)}`,
        usage: unknownUsage(),
      })
    }
    const failedTool = envelope.tool_calls.find(
      (call) => !isObject(call) || typeof call.name !== "string" || call.status !== "success",
    )
    if (failedTool !== undefined) {
      const permission = isObject(failedTool) && typeof failedTool.status === "string" && /permission|approval/i.test(failedTool.status)
      throw new AgentError({
        provider: PROVIDER,
        code: permission ? "permission_required" : "provider_tool_failed",
        message: "fx reported a tool call that did not complete successfully",
        usage: unknownUsage(),
      })
    }
    if (envelope.output.trim().length === 0) {
      throw new AgentError({
        provider: PROVIDER,
        code: "empty_output",
        message: "fx exited 0 without producing any output",
        usage: unknownUsage(),
      })
    }
    if (forwardProgress) {
      ctx.onProgress({ kind: "text", text: envelope.output })
      for (const call of envelope.tool_calls) {
        if (isObject(call) && typeof call.name === "string") {
          ctx.onProgress({ kind: "tool", name: call.name, input: call })
        }
      }
      ctx.onProgress({ kind: "usage", usage: unknownUsage() })
    }
    return { text: envelope.output, usage: unknownUsage(), toolCalls: envelope.tool_calls }
  }
}

export function unknownUsage(): AgentUsage {
  return { inputTokens: 0, outputTokens: 0, costUsd: 0, incomplete: true }
}

export function platformIdOf(platform: { os: NodeJS.Platform; arch: string }): FxPlatformId | undefined {
  if (platform.os === "linux" && platform.arch === "arm64") return "linux-aarch64"
  if (platform.os === "linux" && (platform.arch === "x64" || platform.arch === "x86_64")) return "linux-x86_64"
  if (platform.os === "darwin" && platform.arch === "arm64") return "macos-aarch64"
  if (platform.os === "darwin" && (platform.arch === "x64" || platform.arch === "x86_64")) return "macos-x86_64"
  return undefined
}

function rejectUnsupported(spec: AgentSpec): void {
  if (spec.serviceTier !== undefined) {
    throw new AgentError({
      provider: PROVIDER,
      code: "unsupported_option",
      message: "serviceTier is codex-only; omit it or use the codex provider",
    })
  }
  if (spec.maxTurns !== undefined) {
    throw new AgentError({
      provider: PROVIDER,
      code: "unsupported_option",
      message: "fx has no native turn cap OmegaCode can enforce; omit maxTurns",
    })
  }
  if (spec.effort !== undefined) {
    throw new AgentError({
      provider: PROVIDER,
      code: "unsupported_option",
      message: "fx ask has no prompting/effort flag OmegaCode can pin; omit effort",
    })
  }
  if (spec.sandbox !== "danger-full-access") {
    throw new AgentError({
      provider: PROVIDER,
      code: "unsupported_option",
      message: `fx is admitted only with sandbox: "danger-full-access" (cannot honor "${spec.sandbox}")`,
    })
  }
  if (spec.approval !== "never") {
    throw new AgentError({
      provider: PROVIDER,
      code: "unsupported_option",
      message: `fx runs as a one-shot subprocess and cannot surface approval requests — use approval: "never"`,
    })
  }
}

function requiredModel(spec: AgentSpec): string {
  const model = spec.model?.trim()
  if (!model) {
    throw new AgentError({
      provider: PROVIDER,
      code: "wrong_model",
      message: "fx requires an explicit model (set as FX_MODEL); provider and model are both-or-neither",
    })
  }
  return model
}

export function resolveManagedHome(override?: string): string {
  const raw = override ?? process.env.OMEGACODE_FX_HOME
  if (raw === undefined || raw.trim() === "") {
    throw new AgentError({
      provider: PROVIDER,
      code: "missing_profile",
      message:
        "fx requires OMEGACODE_FX_HOME to an explicit absolute private managed automation HOME (not inherited ~/.fx)",
    })
  }
  return raw
}

function validateManagedHome(home: string): void {
  if (!isAbsolute(home)) {
    throw new AgentError({
      provider: PROVIDER,
      code: "unsafe_profile",
      message: `OMEGACODE_FX_HOME must be an absolute path, got ${JSON.stringify(home)}`,
    })
  }
  const interactiveHome = homedir()
  if (home === interactiveHome || home === join(interactiveHome, ".fx")) {
    throw new AgentError({
      provider: PROVIDER,
      code: "unsafe_profile",
      message: "OMEGACODE_FX_HOME must not be the interactive home or ~/.fx",
    })
  }
  let st: ReturnType<typeof lstatSync>
  try {
    st = lstatSync(home)
  } catch {
    throw new AgentError({
      provider: PROVIDER,
      code: "missing_profile",
      message: `OMEGACODE_FX_HOME ${home} does not exist`,
    })
  }
  if (st.isSymbolicLink()) {
    throw new AgentError({
      provider: PROVIDER,
      code: "unsafe_profile",
      message: `OMEGACODE_FX_HOME ${home} must not be a symlink`,
    })
  }
  if (!st.isDirectory()) {
    throw new AgentError({
      provider: PROVIDER,
      code: "unsafe_profile",
      message: `OMEGACODE_FX_HOME ${home} is not a directory`,
    })
  }
  if ((st.mode & 0o077) !== 0) {
    throw new AgentError({
      provider: PROVIDER,
      code: "unsafe_profile",
      message: `OMEGACODE_FX_HOME ${home} must be private (mode 0700)`,
    })
  }
  if (typeof process.getuid === "function" && st.uid !== process.getuid()) {
    throw new AgentError({
      provider: PROVIDER,
      code: "unsafe_profile",
      message: `OMEGACODE_FX_HOME ${home} is not owned by the current user`,
    })
  }
  let canonicalHome: string
  let resolved: string
  try {
    canonicalHome = realpathSync(homedir())
    resolved = realpathSync(home)
  } catch (err) {
    throw new AgentError({
      provider: PROVIDER,
      code: "unsafe_profile",
      message: `cannot resolve OMEGACODE_FX_HOME: ${(err as Error).message}`,
    })
  }
  if (resolved === canonicalHome || resolved === join(canonicalHome, ".fx")) {
    throw new AgentError({
      provider: PROVIDER,
      code: "unsafe_profile",
      message: "OMEGACODE_FX_HOME must not be the interactive home or ~/.fx",
    })
  }
  const fxDir = join(home, ".fx")
  let fxSt: ReturnType<typeof lstatSync>
  try {
    fxSt = lstatSync(fxDir)
  } catch {
    throw new AgentError({
      provider: PROVIDER,
      code: "missing_profile",
      message: `managed fx profile ${fxDir} does not exist`,
    })
  }
  if (fxSt.isSymbolicLink() || !fxSt.isDirectory() || (fxSt.mode & 0o077) !== 0) {
    throw new AgentError({
      provider: PROVIDER,
      code: "unsafe_profile",
      message: `${fxDir} must be a private non-symlink directory (mode 0700)`,
    })
  }
}

function validateSettings(home: string, model: string): void {
  const path = join(home, ".fx", "settings.json")
  const st = lstatOrThrow(path, "settings.json")
  if (st.isSymbolicLink() || !st.isFile() || (st.mode & 0o077) !== 0) {
    throw new AgentError({
      provider: PROVIDER,
      code: "unsafe_profile",
      message: `${path} must be a private regular non-symlink file (mode 0600)`,
    })
  }
  if (typeof process.getuid === "function" && st.uid !== process.getuid()) {
    throw new AgentError({
      provider: PROVIDER,
      code: "unsafe_profile",
      message: `${path} is not owned by the current user`,
    })
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"))
  } catch {
    throw new AgentError({
      provider: PROVIDER,
      code: "auth_metadata",
      message: "managed fx settings.json is missing or not valid JSON",
    })
  }
  if (!isObject(parsed)) {
    throw new AgentError({
      provider: PROVIDER,
      code: "auth_metadata",
      message: "managed fx settings.json must be an object",
    })
  }
  if (parsed.workspaces !== undefined) {
    throw new AgentError({
      provider: PROVIDER,
      code: "unsafe_profile",
      message: "managed fx settings.json must not contain workspace overrides",
    })
  }
  const models = isObject(parsed.models) ? parsed.models : undefined
  const checks: Array<[boolean, string]> = [
    [parsed.provider === "codex", 'provider="codex"'],
    [typeof models?.codex === "string" && models.codex === model, "models.codex matching the requested model"],
    [parsed.permission_mode === "yolo", "permission_mode=yolo"],
    [parsed.yolo_acknowledged === true, "yolo_acknowledged=true"],
    [parsed.fast_mode === false, "fast_mode=false"],
    [parsed.auto_upgrade === false, "auto_upgrade=false"],
  ]
  const missing = checks.filter(([ok]) => !ok).map(([, name]) => name)
  if (missing.length > 0) {
    throw new AgentError({
      provider: PROVIDER,
      code: missing.some((m) => m.startsWith("fast_mode"))
        ? "wrong_fast"
        : missing.some((m) => m.startsWith("auto_upgrade"))
          ? "wrong_auto_upgrade"
          : missing.some((m) => m.startsWith("permission_mode") || m.startsWith("yolo_"))
            ? "wrong_permission"
            : missing.some((m) => m.startsWith("provider"))
              ? "wrong_provider"
              : missing.some((m) => m.startsWith("models.codex"))
                ? "wrong_model"
                : "auth_metadata",
      message: `managed fx settings.json must set ${missing.join(", ")}`,
    })
  }
}

function validateAuthMetadata(home: string): void {
  const path = join(home, ".fx", "chatgpt-auth.json")
  let st: ReturnType<typeof lstatSync>
  try {
    st = lstatSync(path)
  } catch {
    throw new AgentError({
      provider: PROVIDER,
      code: "auth_metadata",
      message: "managed fx chatgpt-auth.json is missing",
    })
  }
  if (st.isSymbolicLink()) {
    throw new AgentError({
      provider: PROVIDER,
      code: "unsafe_profile",
      message: `${path} must not be a symlink`,
    })
  }
  if (!st.isFile()) {
    throw new AgentError({
      provider: PROVIDER,
      code: "auth_metadata",
      message: `${path} must be a regular file`,
    })
  }
  if ((st.mode & 0o077) !== 0) {
    throw new AgentError({
      provider: PROVIDER,
      code: "unsafe_profile",
      message: `${path} must not be group/other-accessible`,
    })
  }
  if (typeof process.getuid === "function" && st.uid !== process.getuid()) {
    throw new AgentError({
      provider: PROVIDER,
      code: "unsafe_profile",
      message: `${path} is not owned by the current user`,
    })
  }
}

function lstatOrThrow(path: string, label: string): Stats {
  try {
    return lstatSync(path)
  } catch {
    throw new AgentError({
      provider: PROVIDER,
      code: "auth_metadata",
      message: `managed fx ${label} is missing`,
    })
  }
}

function scrubbedEnv(home: string, model: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    XDG_CACHE_HOME: join(home, ".cache"),
    FX_MODEL: model,
    FX_AUTO_UPGRADE: "0",
    FX_DISABLE_KEYCHAIN: "1",
  }
  for (const key of ENV_PASSTHROUGH) {
    const value = process.env[key]
    if (value !== undefined) env[key] = value
  }
  return env
}

function workingPrompt(spec: AgentSpec): string {
  if (!spec.instructions) return spec.prompt
  return `<instructions>\n${spec.instructions}\n</instructions>\n\n${spec.prompt}`
}

function extractionPrompt(spec: AgentSpec, workingText: string): string {
  const guidance = spec.instructions ? `Caller instructions and corrective guidance:\n${spec.instructions}\n\n` : ""
  return (
    guidance +
    `Earlier you produced this answer:\n\n${workingText}\n\n` +
    "Return that answer as a single JSON value that conforms to the following JSON Schema. " +
    "Output ONLY the JSON — no prose, no explanation, no code fences. " +
    "Do not call tools. Do not use tools. tool_calls must be empty.\n\nSchema:\n" +
    JSON.stringify(spec.schema)
  )
}

interface AskEnvelope {
  output: string
  exit_code: number
  model: string
  session_id: string
  steps: number
  tool_calls: unknown[]
  error?: unknown
  auth_failure?: unknown
  recovery?: unknown
}

function parseAskEnvelope(stdout: string): AskEnvelope {
  const value = parseExactJsonObject(stdout, "ask --json")
  if ("final_output" in value) {
    throw new AgentError({
      provider: PROVIDER,
      code: "malformed_output",
      message: "fx ask JSON used final_output; exact v0.0.6 requires output",
    })
  }
  const allowed = new Set([
    "output",
    "exit_code",
    "model",
    "session_id",
    "steps",
    "tool_calls",
    "error",
    "auth_failure",
    "recovery",
  ])
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new AgentError({
      provider: PROVIDER,
      code: "malformed_output",
      message: "fx ask JSON contains fields outside the exact v0.0.6 envelope",
    })
  }
  if (
    typeof value.output !== "string" ||
    !Number.isInteger(value.exit_code) ||
    typeof value.model !== "string" ||
    typeof value.session_id !== "string" ||
    value.session_id !== "" ||
    !Number.isInteger(value.steps) ||
    (value.steps as number) < 0 ||
    !Array.isArray(value.tool_calls) ||
    value.tool_calls.some((call) => !isObject(call)) ||
    (value.error !== undefined && typeof value.error !== "string")
  ) {
    throw new AgentError({
      provider: PROVIDER,
      code: "malformed_output",
      message: "fx ask JSON is missing required v0.0.6 fields (output, exit_code, model, session_id, steps, tool_calls)",
    })
  }
  return {
    output: value.output,
    exit_code: value.exit_code as number,
    model: value.model,
    session_id: value.session_id,
    steps: value.steps as number,
    tool_calls: value.tool_calls,
    error: value.error,
    auth_failure: value.auth_failure,
    recovery: value.recovery,
  }
}

function parseExactJsonObject(stdout: string, what: string): Record<string, unknown> {
  const trimmed = stdout.trim()
  if (!trimmed) {
    throw new AgentError({
      provider: PROVIDER,
      code: "malformed_output",
      message: `fx ${what} produced empty stdout`,
    })
  }
  let value: unknown
  try {
    value = JSON.parse(trimmed)
  } catch {
    throw new AgentError({
      provider: PROVIDER,
      code: "malformed_output",
      message: `fx ${what} did not emit exactly one JSON object`,
    })
  }
  // JSON.parse accepts one value; reject arrays/scalars and require a round-trip of the trimmed
  // text to be a single object (no concatenated documents — JSON.parse throws on those).
  if (!isObject(value)) {
    throw new AgentError({
      provider: PROVIDER,
      code: "malformed_output",
      message: `fx ${what} emitted JSON that is not an object`,
    })
  }
  return value
}

function parseExactVersion(stdout: string): string | undefined {
  const line = stdout.trim().split(/\r?\n/).at(-1)?.trim() ?? ""
  const m = line.match(/^(\d+\.\d+\.\d+)$/)
  return m?.[1]
}

function hasEnvelopeFailure(envelope: AskEnvelope): boolean {
  return (
    envelope.error !== undefined ||
    envelope.auth_failure !== undefined ||
    envelope.recovery !== undefined
  )
}

function envelopeErrorCode(envelope: AskEnvelope, fallback: string): string {
  if (envelope.auth_failure !== undefined) return "provider_auth"
  if (envelope.recovery !== undefined) return "provider_recovery"
  if (typeof envelope.error === "string" && /permission/i.test(envelope.error)) return "permission_required"
  if (typeof envelope.error === "string" && /interrupt/i.test(envelope.error)) return "interrupted"
  return fallback
}

function innerFailureMessage(envelope: AskEnvelope): string {
  if (envelope.auth_failure !== undefined) return "fx ask reported an authentication failure"
  if (envelope.recovery !== undefined) return "fx ask reported internal route recovery; refusing retry-laundered output"
  if (typeof envelope.error === "string" && envelope.error.length > 0) return `fx ask error: ${envelope.error}`
  if (envelope.exit_code !== 0) return `fx ask inner exit_code ${envelope.exit_code}`
  return "fx ask failed"
}

function stderrNote(tail: string): string {
  return tail ? " (stderr withheld to avoid exposing provider or credential data)" : ""
}

function withUnknownUsage(err: unknown): Error {
  if (err instanceof AgentInterrupted) return new AgentInterrupted(err.message, unknownUsage())
  if (err instanceof AgentError) {
    if (err.usage) return err
    return new AgentError({
      provider: err.provider,
      code: err.code,
      message: err.message,
      retryable: false,
      usage: unknownUsage(),
    })
  }
  return err instanceof Error ? err : new Error(String(err))
}

function defaultHashBinary(bin: string): string {
  return createHash("sha256").update(readFileSync(bin)).digest("hex")
}

function validateBinaryMetadata(bin: string): void {
  if (!isAbsolute(bin)) {
    throw new AgentError({
      provider: PROVIDER,
      code: "binary_not_pinned",
      message: "FX_BIN must be an absolute path to the exact admitted v0.0.6 binary",
    })
  }
  let st: Stats
  try {
    st = lstatSync(bin)
  } catch {
    throw new AgentError({
      provider: PROVIDER,
      code: "binary_not_found",
      message: `FX_BIN ${bin} does not exist`,
    })
  }
  if (st.isSymbolicLink() || !st.isFile() || (st.mode & 0o111) === 0 || (st.mode & 0o022) !== 0) {
    throw new AgentError({
      provider: PROVIDER,
      code: "binary_not_pinned",
      message: "FX_BIN must be an executable, non-symlink regular file that is not group/other-writable",
    })
  }
  if (typeof process.getuid === "function" && st.uid !== process.getuid()) {
    throw new AgentError({
      provider: PROVIDER,
      code: "binary_not_pinned",
      message: "FX_BIN must be owned by the current user",
    })
  }
}

function sameRealPath(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b)
  } catch {
    return false
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v)
}

function strOf(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined
}

interface FxProcessExit {
  code: number | null
  signal: string | null
  stdout: string
  stderrTail: string
}

function runFxProcess(o: {
  bin: string
  args: string[]
  cwd?: string
  env: NodeJS.ProcessEnv
  stdin?: string
  signal: AbortSignal
  stallTimeoutMs: number
  killGraceMs: number
  spawnProcess?: SpawnProcess
}): Promise<FxProcessExit> {
  return new Promise<FxProcessExit>((resolve, reject) => {
    if (o.signal.aborted) {
      reject(new AgentInterrupted())
      return
    }
    const spawnProcess: SpawnProcess =
      o.spawnProcess ??
      ((bin, args, opts) => spawn(bin, args, { cwd: opts.cwd, env: opts.env, stdio: ["pipe", "pipe", "pipe"] }))
    let child: ChildProcessWithoutNullStreams
    try {
      child = spawnProcess(o.bin, o.args, { cwd: o.cwd, env: o.env })
    } catch (err) {
      reject(spawnFailure(o.bin, err))
      return
    }

    const stderrLimit = 16 * 1024
    let settled = false
    let stdout = ""
    let stderrBuf = ""
    let watchdog: ReturnType<typeof setTimeout> | undefined
    let killTimer: ReturnType<typeof setTimeout> | undefined

    const settle = (fn: () => void): void => {
      if (settled) return
      settled = true
      if (watchdog) clearTimeout(watchdog)
      o.signal.removeEventListener("abort", onAbort)
      fn()
    }

    const killWithGrace = (): void => {
      try {
        child.kill("SIGTERM")
      } catch {
        // best-effort
      }
      if (killTimer) return
      killTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL")
        } catch {
          // best-effort
        }
      }, o.killGraceMs)
      killTimer.unref?.()
    }

    const onAbort = (): void => {
      killWithGrace()
      settle(() => reject(new AgentInterrupted()))
    }

    const touch = (): void => {
      if (o.stallTimeoutMs <= 0 || settled) return
      if (watchdog) clearTimeout(watchdog)
      watchdog = setTimeout(() => {
        killWithGrace()
        settle(() =>
          reject(
            new AgentError({
              provider: PROVIDER,
              code: "turn_stalled",
              message: `${o.bin} produced no output for ${o.stallTimeoutMs}ms — failing instead of hanging forever`,
              retryable: false,
            }),
          ),
        )
      }, o.stallTimeoutMs)
      watchdog.unref?.()
    }

    child.stdout.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => {
      if (settled) return
      touch()
      stdout += chunk
    })
    child.stderr.setEncoding("utf8")
    child.stderr.on("data", (chunk: string) => {
      stderrBuf += chunk
      if (stderrBuf.length > stderrLimit) stderrBuf = stderrBuf.slice(stderrBuf.length - stderrLimit)
    })
    child.on("error", (err) => {
      settle(() => reject(spawnFailure(o.bin, err)))
    })
    child.on("exit", () => {
      if (killTimer) clearTimeout(killTimer)
    })
    child.on("close", (code, signal) => {
      if (killTimer) clearTimeout(killTimer)
      settle(() => resolve({ code, signal: signal ?? null, stdout, stderrTail: stderrBuf.trim() }))
    })

    o.signal.addEventListener("abort", onAbort, { once: true })
    touch()
    child.stdin.on?.("error", () => {})
    if (o.stdin !== undefined) child.stdin.write(o.stdin, () => {})
    child.stdin.end?.()
  })
}

function spawnFailure(bin: string, err: unknown): AgentError {
  const message = err instanceof Error ? err.message : String(err)
  const notFound = /ENOENT|not found|not recognized|EACCES/i.test(message)
  return new AgentError({
    provider: PROVIDER,
    code: notFound ? "binary_not_found" : "spawn_failed",
    message: notFound
      ? `cannot execute "${bin}" — is the fx CLI installed and on PATH? (${message})`
      : `failed to spawn ${bin}: ${message}`,
    retryable: false,
  })
}
