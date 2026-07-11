// omegacode-original built-in: one provider proposes a position, the other attacks it, the
// proposer rebuts or concedes, for N rounds — then a judge rules on what actually survived.
// The cross-provider attacker is the point: a model is measurably worse at finding holes in its
// own reasoning than another model is.
// Run with: omegacode run provider-debate --args '"<question>"'
//       or: --args '{"question": "...", "rounds": 2, "proposer": "codex" | "claude-code"}'

export const meta = {
  name: "provider-debate",
  description:
    "Adversarial debate — one provider proposes, the other attacks, N rounds of rebuttal, then a judge rules on what survived, what was conceded, and what to actually do.",
  defaultSandbox: "read-only",
  phases: [
    { title: "Propose", detail: "the proposer takes a concrete position" },
    { title: "Debate", detail: "attack and rebuttal, one exchange per round" },
    { title: "Verdict", detail: "a judge rules: survived, conceded, open, recommendation" },
  ],
}

const PROVIDERS = {
  codex: { provider: "codex", model: "gpt-5.6-sol", name: "Codex" },
  "claude-code": { provider: "claude-code", model: "claude-fable-5", name: "Claude" },
}

const question =
  typeof args === "string" && args.trim()
    ? args.trim()
    : args && typeof args === "object" && typeof args.question === "string" && args.question.trim()
      ? args.question.trim()
      : null
if (!question) {
  throw new Error(`provider-debate needs a question — pass --args '"<question>"' or --args '{"question": "..."}'`)
}

const proposerId = args && typeof args === "object" && args.proposer !== undefined ? args.proposer : "codex"
const proposer = PROVIDERS[proposerId]
if (!proposer) throw new Error(`unknown proposer "${proposerId}" — expected "codex" or "claude-code"`)
const attacker = proposer === PROVIDERS.codex ? PROVIDERS["claude-code"] : PROVIDERS.codex

const rawRounds = args && typeof args === "object" && typeof args.rounds === "number" ? args.rounds : 2
const rounds = Math.max(1, Math.min(5, Math.floor(rawRounds)))

const VERDICT_SCHEMA = {
  type: "object",
  required: ["recommendation", "survived", "conceded", "open", "report"],
  properties: {
    recommendation: { type: "string" },
    survived: { type: "array", items: { type: "string" } },
    conceded: { type: "array", items: { type: "string" } },
    open: { type: "array", items: { type: "string" } },
    report: { type: "string" },
  },
}

const transcriptText = (transcript) =>
  transcript
    .map((t) => `--- Round ${t.round} ---\nObjections:\n${t.critique}\n\nRebuttal:\n${t.rebuttal}`)
    .join("\n\n")

// ---------------------------------------------------------------------------
// Propose — a concrete, attackable position.
// ---------------------------------------------------------------------------
phase("Propose")
log(`debate: ${question} (${proposer.name} proposes, ${attacker.name} attacks, ${rounds} round${rounds === 1 ? "" : "s"})`)

const proposal = await agent(
  `Take a clear position on the following and propose a concrete answer or design:\n\n${question}\n\n` +
    `If this concerns the repository you are in, read the relevant code first and ground your ` +
    `position in it. Make your reasoning, assumptions, and tradeoffs explicit — this proposal will ` +
    `be scrutinized line by line, so vagueness counts against it.`,
  { provider: proposer.provider, model: proposer.model, label: `propose: ${proposer.name}`, phase: "Propose" },
)

// ---------------------------------------------------------------------------
// Debate — each round is one attack/rebuttal exchange. The rebuttal ends with
// the full current proposal, which becomes the target of the next attack.
// ---------------------------------------------------------------------------
phase("Debate")

const transcript = []
let current = proposal

for (let round = 1; round <= rounds; round++) {
  const history = transcript.length > 0 ? `\n\nDebate so far:\n${transcriptText(transcript)}` : ""

  const critique = await agent(
    `You are the adversarial examiner in round ${round} of ${rounds} of a structured debate.\n\n` +
      `Question:\n${question}\n\n` +
      `Current proposal:\n${current}${history}\n\n` +
      `Attack the proposal with the strongest objections you can ground in evidence: flaws in ` +
      `reasoning, missing considerations, risks, and concretely better alternatives. Where the ` +
      `question concerns this repository, verify your objections against the actual code — a ` +
      `refuted attack weakens your side. Do not be agreeable, and do not repeat objections that ` +
      `earlier rebuttals already answered; move to stronger ground instead.`,
    { provider: attacker.provider, model: attacker.model, label: `attack: round ${round}`, phase: "Debate" },
  )

  const rebuttal = await agent(
    `You are the proposer in round ${round} of ${rounds} of a structured debate, defending your proposal.\n\n` +
      `Question:\n${question}\n\n` +
      `Your current proposal:\n${current}${history}\n\n` +
      `New objections:\n${critique}\n\n` +
      `Respond to each objection in turn: defend it with reasoning and evidence (check the code ` +
      `where it applies), or concede it explicitly and revise. Conceding a weak point is better ` +
      `than defending it badly. End with your full current proposal, revised where you conceded.`,
    { provider: proposer.provider, model: proposer.model, label: `rebut: round ${round}`, phase: "Debate" },
  )

  transcript.push({ round, critique, rebuttal })
  current = rebuttal
}

// ---------------------------------------------------------------------------
// Verdict — the judge runs on the run-default provider (override with
// --provider); it rules on the merits, not on who argued better.
// ---------------------------------------------------------------------------
phase("Verdict")

const verdict = await agent(
  `You are the judge of a structured debate. Rule on the merits of the arguments, not the rhetoric.\n\n` +
    `Question:\n${question}\n\n` +
    `Initial proposal:\n${proposal}\n\n` +
    `Full debate:\n${transcriptText(transcript)}\n\n` +
    `Where a decisive claim about this repository can be checked, check it yourself rather than ` +
    `taking either side's word. Deliver:\n` +
    `- recommendation: the position the asker should act on (it may differ from both sides),\n` +
    `- survived: the claims that withstood attack,\n` +
    `- conceded: the points the proposer gave up or clearly lost,\n` +
    `- open: unresolved questions worth investigating before committing,\n` +
    `- report: a concise walkthrough of how you weighed it.`,
  { label: "verdict", phase: "Verdict", schema: VERDICT_SCHEMA },
)

return { question, proposer: proposer.name, attacker: attacker.name, proposal, transcript, verdict }
