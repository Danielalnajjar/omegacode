// omegacode-original built-in: ask both providers cheaply; if they agree, merge and return — if
// they disagree, escalate both to deep effort with the other's answer in hand, then adjudicate.
// Disagreement-triggered escalation: consensus-grade confidence at roughly half the cost of
// always running the full panel.
// Run with: omegacode run second-opinion --args '"<question>"'

export const meta = {
  name: "second-opinion",
  description:
    "Cheap consensus check — Codex and Claude answer at low effort; agreement returns a merged answer, disagreement escalates both to deep effort and adjudicates.",
  defaultSandbox: "read-only",
  phases: [
    { title: "Ask", detail: "both providers answer independently at low effort" },
    { title: "Compare", detail: "do the answers materially agree?" },
    { title: "Escalate", detail: "deep reconsideration of the disagreements — only on a split" },
    { title: "Answer", detail: "merge the consensus, or adjudicate the split" },
  ],
}

const PROVIDERS = [
  { provider: "codex", model: "gpt-5.6-sol", name: "Codex" },
  { provider: "claude-code", model: "claude-fable-5", name: "Claude" },
]

const question =
  typeof args === "string" && args.trim()
    ? args.trim()
    : args && typeof args === "object" && typeof args.question === "string" && args.question.trim()
      ? args.question.trim()
      : null
if (!question) {
  throw new Error(`second-opinion needs a question — pass --args '"<question>"' or --args '{"question": "..."}'`)
}

const ANSWER_SCHEMA = {
  type: "object",
  required: ["answer", "keyPoints"],
  properties: { answer: { type: "string" }, keyPoints: { type: "array", items: { type: "string" } } },
}

// ---------------------------------------------------------------------------
// Ask — identical prompts, low effort, blind to each other.
// ---------------------------------------------------------------------------
phase("Ask")
log(`asking both providers: ${question}`)

const asked = (
  await parallel(
    PROVIDERS.map((p) => () =>
      agent(
        `Answer this question concretely and commit to a position:\n\n${question}\n\n` +
          `If it concerns the repository you are in, ground your answer in the actual code. Give ` +
          `your answer plus the key points it rests on.`,
        { provider: p.provider, model: p.model, effort: "low", label: `ask: ${p.name}`, phase: "Ask", schema: ANSWER_SCHEMA },
      ).then((a) => ({ name: p.name, provider: p.provider, model: p.model, answer: a.answer, keyPoints: a.keyPoints })),
    ),
  )
).filter(Boolean)

if (asked.length === 0) throw new Error("both providers failed to answer")
if (asked.length === 1) {
  log(`warning: only ${asked[0].name} answered — no second opinion to compare`)
  return { answer: asked[0].answer, agreed: null, escalated: false, answers: asked }
}

// ---------------------------------------------------------------------------
// Compare — agreement on substance, not wording. A failed comparator counts
// as disagreement: escalating needlessly costs tokens, trusting a missing
// comparison costs correctness.
// ---------------------------------------------------------------------------
phase("Compare")

const cmp = await agent(
  `Two independent answers to the same question:\n\nQuestion:\n${question}\n\n` +
    `Answer 1 (${asked[0].name}):\n${asked[0].answer}\nKey points: ${asked[0].keyPoints.join("; ")}\n\n` +
    `Answer 2 (${asked[1].name}):\n${asked[1].answer}\nKey points: ${asked[1].keyPoints.join("; ")}\n\n` +
    `Do they reach the same substantive conclusion? Ignore wording, structure, and depth — flag ` +
    `only material disagreements that would change what the asker does.`,
  {
    effort: "low",
    label: "compare",
    phase: "Compare",
    schema: {
      type: "object",
      required: ["agree", "disagreements"],
      properties: { agree: { type: "boolean" }, disagreements: { type: "array", items: { type: "string" } } },
    },
  },
)

const agree = cmp ? cmp.agree : false
const disagreements = cmp ? cmp.disagreements : ["comparison agent failed — treating the answers as unverified"]

if (agree) {
  phase("Answer")
  log("answers agree — merging")
  const merged = await agent(
    `Two independent analyses of this question reached the same conclusion. Merge them into one ` +
      `answer — keep the strongest specifics of each, no filler.\n\nQuestion:\n${question}\n\n` +
      `${asked.map((a) => `Answer (${a.name}):\n${a.answer}`).join("\n\n")}`,
    { effort: "low", label: "merge", phase: "Answer" },
  )
  return { answer: merged, agreed: true, escalated: false, answers: asked }
}

// ---------------------------------------------------------------------------
// Escalate — each provider reconsiders at deep effort with the other's answer
// and the specific disagreements in hand.
// ---------------------------------------------------------------------------
phase("Escalate")
log(`answers disagree — escalating: ${disagreements.join("; ")}`)

const finals = (
  await parallel(
    asked.map((a, i) => () => {
      const other = asked[1 - i]
      return agent(
        `You previously answered this question:\n\n${question}\n\nYour answer:\n${a.answer}\n\n` +
          `An equally capable independent analysis disagreed. Its answer:\n${other.answer}\n\n` +
          `The material disagreements:\n${disagreements.map((d) => `- ${d}`).join("\n")}\n\n` +
          `Reconsider at full depth: verify the contested points yourself (read the code, check the ` +
          `claims) rather than restating your position. Then either defend your answer with ` +
          `evidence or change it. Changing your mind on the evidence is success, not failure. ` +
          `State your final answer.`,
        { provider: a.provider, model: a.model, effort: "xhigh", label: `reconsider: ${a.name}`, phase: "Escalate", schema: { type: "object", required: ["answer", "changed"], properties: { answer: { type: "string" }, changed: { type: "boolean" } } } },
      ).then((f) => ({ name: a.name, answer: f.answer, changed: f.changed }))
    }),
  )
).filter(Boolean)

// ---------------------------------------------------------------------------
// Answer — adjudicate what remains. Runs on the run-default provider
// (override with --provider).
// ---------------------------------------------------------------------------
phase("Answer")

const adj = await agent(
  `You are the final adjudicator. Two analyses answered the same question, disagreed, and each ` +
    `reconsidered at full depth with the other's answer in hand.\n\nQuestion:\n${question}\n\n` +
    `Initial disagreements:\n${disagreements.map((d) => `- ${d}`).join("\n")}\n\n` +
    `Final positions:\n${finals.map((f) => `${f.name}${f.changed ? " (revised)" : " (held)"}:\n${f.answer}`).join("\n\n")}\n\n` +
    `Write the single answer the asker should act on. If the deep passes converged, merge them; if ` +
    `not, decide on the merits — verify the decisive points yourself where feasible. Note anything ` +
    `that remains genuinely unresolved.`,
  {
    effort: "xhigh",
    label: "adjudicate",
    phase: "Answer",
    schema: {
      type: "object",
      required: ["answer", "resolution", "unresolved"],
      properties: {
        answer: { type: "string" },
        resolution: { type: "string", enum: ["consensus", "adjudicated"] },
        unresolved: { type: "array", items: { type: "string" } },
      },
    },
  },
)

return {
  answer: adj.answer,
  agreed: false,
  escalated: true,
  resolution: adj.resolution,
  unresolved: adj.unresolved,
  disagreements,
  positions: finals,
}
