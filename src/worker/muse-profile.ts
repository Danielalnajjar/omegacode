export const MUSE_EXECUTION_PROFILE_NAMES = ["workflow-research-v1"] as const

export type MuseExecutionProfileName = (typeof MUSE_EXECUTION_PROFILE_NAMES)[number]

/**
 * MCP servers each profile keeps from the caller's Muse settings; every other server is removed.
 * Same roster as Codex's workflow-research-v1, so a librarian prompt works on either provider.
 */
export const MUSE_PROFILE_MCP_SERVERS: Readonly<Record<MuseExecutionProfileName, readonly string[]>> = Object.freeze({
  "workflow-research-v1": Object.freeze(["btca", "executor_research", "grok_search", "mintlify"]),
})
