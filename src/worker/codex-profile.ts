export const CODEX_EXECUTION_PROFILE_NAMES = [
  "workflow-bulk-v1",
  "workflow-plan-v1",
  "workflow-research-v1",
] as const

export type CodexExecutionProfileName = (typeof CODEX_EXECUTION_PROFILE_NAMES)[number]

export interface CodexExecutionProfileDefinition {
  readonly name: CodexExecutionProfileName
  readonly featureOverrides: readonly { key: string; value: boolean }[]
  readonly mcp: "none" | { readonly allowedServerNames: readonly string[] }
}

const COMMON_DISABLED_FEATURES = [
  "features.apps",
  "features.enable_mcp_apps",
  "features.browser_use",
  "features.browser_use_external",
  "features.browser_use_full_cdp_access",
  "features.in_app_browser",
  "features.computer_use",
  "features.image_generation",
  "features.plugins",
  "features.plugin_sharing",
  "features.remote_plugin",
  "features.shell_snapshot",
  "features.standalone_web_search",
  "features.web_search_cached",
  "features.web_search_request",
] as const

function overrides(
  additions: readonly { key: string; value: boolean }[],
): readonly { key: string; value: boolean }[] {
  return Object.freeze([
    ...COMMON_DISABLED_FEATURES.map((key) => Object.freeze({ key, value: false })),
    ...additions.map((override) => Object.freeze({ ...override })),
  ])
}

function definition(
  name: CodexExecutionProfileName,
  featureOverrides: readonly { key: string; value: boolean }[],
  mcp: CodexExecutionProfileDefinition["mcp"],
): CodexExecutionProfileDefinition {
  return Object.freeze({ name, featureOverrides, mcp })
}

// Profiles own startup cost (MCP subprocesses, feature subsystems, skill
// discovery), never turn behavior: multi_agent stays inherited from the host so
// an ultra-effort worker keeps its subagent mode under every profile.
const PROFILE_DEFINITIONS: Readonly<Record<CodexExecutionProfileName, CodexExecutionProfileDefinition>> = Object.freeze({
  "workflow-bulk-v1": definition("workflow-bulk-v1", overrides([
    { key: "features.goals", value: false },
    { key: "features.hooks", value: false },
    { key: "features.memories", value: false },
    { key: "features.skip_host_skill_discovery", value: true },
  ]), "none"),
  "workflow-plan-v1": definition("workflow-plan-v1", overrides([]), "none"),
  "workflow-research-v1": definition("workflow-research-v1", overrides([]), Object.freeze({
    allowedServerNames: Object.freeze(["btca", "context7", "deepwiki", "exa", "firecrawl", "grok_search", "mintlify"]),
  })),
})

export function resolveCodexExecutionProfile(name: string): CodexExecutionProfileDefinition {
  const profile = PROFILE_DEFINITIONS[name as CodexExecutionProfileName]
  if (!profile) {
    throw new Error(`unknown Codex execution profile "${name}" — must be one of ${CODEX_EXECUTION_PROFILE_NAMES.join(", ")}`)
  }
  return profile
}
