/** Environment inherited by provider SDKs and subprocesses, minus OmegaCode-only credentials. */
export function providerEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const copy = { ...env }
  delete copy.TYPESAFE_API_KEY
  return copy
}
