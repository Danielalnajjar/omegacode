/** Clone an environment for a coding provider without exposing OmegaCode's API credential. */
export function agentEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...base }
  delete env.TYPESAFE_API_KEY
  return env
}
