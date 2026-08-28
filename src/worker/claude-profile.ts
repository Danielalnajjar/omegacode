import { execFile, type ExecFileException } from "node:child_process"
import type { AgentSpec } from "../dsl/types.js"
import { AgentError, AgentInterrupted } from "./index.js"

export const CLAUDE_PROFILE_AUTH_CONFLICTS = {
  defined: ["CLAUDE_SECURESTORAGE_CONFIG_DIR"],
  nonEmpty: [
    "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR", "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
    "ANTHROPIC_BASE_URL", "ANTHROPIC_UNIX_SOCKET", "CLAUDE_CODE_CUSTOM_OAUTH_URL", "CLAUDE_CODE_HOST_AUTH_ENV_VAR",
    "CLAUDE_CODE_HOST_CREDS_FILE",
    "ANTHROPIC_CONFIG_DIR", "ANTHROPIC_PROFILE",
    "ANTHROPIC_FEDERATION_RULE_ID", "ANTHROPIC_ORGANIZATION_ID", "ANTHROPIC_WORKSPACE_ID",
    "ANTHROPIC_SERVICE_ACCOUNT_ID", "ANTHROPIC_IDENTITY_TOKEN", "ANTHROPIC_IDENTITY_TOKEN_FILE", "ANTHROPIC_SCOPE",
    "ANTHROPIC_CUSTOM_HEADERS",
  ],
  truthy: [
    "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST",
    "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY",
    "CLAUDE_CODE_USE_ANTHROPIC_AWS", "CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD",
    "CLAUDE_CODE_USE_MANTLE", "CLAUDE_CODE_USE_GATEWAY",
  ],
} as const

const truthy = (value: string | undefined): boolean => value !== undefined && !/^(?:|0|false|no|off)$/i.test(value.trim())

export function assertNoClaudeProfileAuthConflict(env: NodeJS.ProcessEnv): void {
  const key = CLAUDE_PROFILE_AUTH_CONFLICTS.defined.find((name) => env[name] !== undefined)
    ?? CLAUDE_PROFILE_AUTH_CONFLICTS.nonEmpty.find((name) => Boolean(env[name]?.trim()))
    ?? CLAUDE_PROFILE_AUTH_CONFLICTS.truthy.find((name) => truthy(env[name]))
  if (key) throw new AgentError({
    provider: "claude-code", code: "claude_profile_auth_conflict",
    message: `${key} overrides selected-profile authentication; remove or disable it for this run. No fallback occurred`,
  })
}

export interface OmegaProfile { profileId: string; label: string; configDir: string }
export type ClaudeProfileResolver = (profileId: string, signal: AbortSignal) => Promise<OmegaProfile>

export function resolveClaudeProfile(profileId: string, signal: AbortSignal, runExecFile: typeof execFile = execFile): Promise<OmegaProfile> {
  return new Promise((resolve, reject) => {
    let callbackDone = false
    let closeDone = false
    let outcome: { error: ExecFileException | null; stdout: string; stderr: string } | undefined
    const settle = () => {
      if (!callbackDone || !closeDone || !outcome) return
      if (signal.aborted || outcome.error?.code === "ABORT_ERR") return reject(new AgentInterrupted())
      if (outcome.error) {
        const cause = outcome.error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ? "resolver output exceeded its limit" : "resolver command failed"
        return reject(unavailable(cause))
      }
      try {
        const value: unknown = JSON.parse(outcome.stdout)
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error()
        const record = value as Record<string, unknown>
        if (Object.keys(record).sort().join(",") !== "configDir,label,profileId"
          || typeof record.profileId !== "string" || typeof record.label !== "string" || typeof record.configDir !== "string"
          || !record.label.trim() || !record.configDir.trim() || record.profileId !== profileId) throw new Error()
        resolve({ profileId: record.profileId, label: record.label, configDir: record.configDir })
      } catch {
        reject(unavailable("resolver returned an invalid response"))
      }
    }
    let child
    try {
      child = runExecFile("bb", ["subscription", "resolve-omega", "--profile-id", profileId, "--json"], {
        shell: false, signal, killSignal: "SIGKILL", maxBuffer: 64 * 1024, timeout: 10_000, encoding: "utf8",
      }, (error, stdout, stderr) => { outcome = { error, stdout, stderr }; callbackDone = true; settle() })
    } catch {
      reject(unavailable("resolver command failed"))
      return
    }
    child.once("close", () => { closeDone = true; settle() })
  })
}

function unavailable(cause: string): AgentError {
  return new AgentError({ provider: "claude-code", code: "claude_profile_unavailable", message: `Selected Claude profile is unavailable: ${cause}. Repair it with Subscription Picker; no fallback occurred` })
}

export function prepareClaudeProfile(spec: AgentSpec, signal: AbortSignal, resolver: ClaudeProfileResolver, env = process.env): Promise<NodeJS.ProcessEnv> {
  if (!spec.claudeProfile) throw new Error("claudeProfile is required")
  const snapshot = { ...env }
  assertNoClaudeProfileAuthConflict(snapshot)
  return resolver(spec.claudeProfile, signal).then(({ configDir }) => Object.freeze({ ...snapshot, CLAUDE_CONFIG_DIR: configDir }))
}
