// The current model id of each family OmegaCode's shipped workflows, skill, and probes name. Workflow
// bodies read them through the injected `models` global (`{ provider: "codex", model: models.sol }`),
// so moving a family to a new model edits this file and its guard in test/model-pins.test.ts only.

export type Models = Readonly<Record<"sol" | "fable" | "opus", string>>

export const MODELS: Models = Object.freeze({
  /** Codex (OpenAI) Sol. */
  sol: "gpt-6.2-sol",
  /** Claude Code Fable. */
  fable: "claude-fable-5-2",
  /** Claude Code Opus; the Claude preflight probe's default. */
  opus: "claude-opus-5-5",
})
