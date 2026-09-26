// OS-sandboxed workers (Grok, Muse) cannot read gh's keychain login, so gh inside them runs
// unauthenticated: 401 on search and private reads, and the anonymous rate limit on the rest.
// The caller's token travels to those children as GH_TOKEN instead.
import type { ProviderId } from "../dsl/types.js"
import { AgentInterrupted } from "./index.js"
import { providerEnv } from "./provider-env.js"
import { captureStdout, type SpawnProcess } from "./subprocess-jsonl.js"

export type ReadGithubToken = (signal: AbortSignal) => Promise<string | undefined>

/** `gh auth token`, or undefined when gh is missing, logged out, or prints nothing. */
export function githubTokenReader(provider: ProviderId, spawnProcess?: SpawnProcess): ReadGithubToken {
  return async (signal) => {
    try {
      const token = (await captureStdout({ provider, bin: "gh", args: ["auth", "token"], env: providerEnv(), signal, spawnProcess })).trim()
      return token || undefined
    } catch (err) {
      if (err instanceof AgentInterrupted) throw err
      return undefined
    }
  }
}

/** Whether the child environment already carries a token gh will use. */
export function hasGithubToken(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.GH_TOKEN || env.GITHUB_TOKEN)
}
