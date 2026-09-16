/** Environment inherited by provider SDKs and subprocesses, minus OmegaCode-only credentials. */
export function providerEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const copy = { ...env }
  for (const key of Object.keys(copy)) if (key.toUpperCase() === "TYPESAFE_API_KEY") delete copy[key]
  return copy
}
