// omegacode-original built-in: the same change reviewed twice — once by Codex, once by Claude —
// each over the ENTIRE feature/branch, then a synthesis pass merges both: consensus findings
// (both providers saw it → highest confidence), unique catches, and disagreements called out.
// Run with: omegacode run multi-provider-review [--args '{"target": "<ref|path|diff>"}']

export const meta = {
  name: "multi-provider-review",
  description:
    "Dual-provider review — Codex and Claude each review the full feature/branch independently, then a synthesis merges both: consensus, unique catches, disagreements.",
  defaultSandbox: "read-only",
  phases: [
    { title: "Review", detail: "Codex and Claude each review the entire change independently" },
    { title: "Synthesize", detail: "merge both reviews: consensus, unique findings, ranked report" },
  ],
}

const MAX_FINDINGS_PER_REVIEW = 15

const REVIEWERS = [
  { provider: "codex", model: "gpt-5.6-sol", name: "Codex" },
  { provider: "claude-code", model: "claude-fable-5", name: "Claude" },
]

const target =
  typeof args === "string" && args.trim()
    ? args.trim()
    : args && typeof args === "object" && typeof args.target === "string" && args.target.trim()
      ? args.target.trim()
      : "the current branch in its entirety — every change relative to its merge-base with the " +
        "repository's default branch (git merge-base, then git diff <base>...HEAD), plus any " +
        "uncommitted changes; if already on the default branch, the most recent commit plus any " +
        "uncommitted changes"

const REVIEW_SCHEMA = {
  type: "object",
  required: ["assessment", "findings"],
  properties: {
    assessment: { type: "string" },
    findings: {
      type: "array",
      items: {
        type: "object",
        required: ["file", "title", "why", "severity"],
        properties: {
          file: { type: "string" },
          line: { type: "number" },
          title: { type: "string" },
          why: { type: "string" },
          severity: { type: "string", enum: ["critical", "high", "medium", "low"] },
        },
      },
    },
  },
}

const SYNTHESIS_SCHEMA = {
  type: "object",
  required: ["report", "findings"],
  properties: {
    report: { type: "string" },
    findings: {
      type: "array",
      items: {
        type: "object",
        required: ["file", "title", "why", "severity", "foundBy"],
        properties: {
          file: { type: "string" },
          line: { type: "number" },
          title: { type: "string" },
          why: { type: "string" },
          severity: { type: "string", enum: ["critical", "high", "medium", "low"] },
          foundBy: { type: "array", items: { type: "string", enum: REVIEWERS.map((r) => r.name) } },
        },
      },
    },
  },
}

// ---------------------------------------------------------------------------
// Review — both providers read the same full change, blind to each other.
// The prompts are identical so differences in output reflect the models, not
// the framing; neither is told another reviewer exists.
// ---------------------------------------------------------------------------
phase("Review")
log(`dual-provider review of ${target}`)

const reviewPrompt =
  `You are conducting a complete, independent code review of ${target}. Review the WHOLE change, ` +
  `not a slice of it: read the full diff and enough surrounding code to judge it in context. ` +
  `Cover correctness, security, error handling, concurrency, resource handling, API contracts, ` +
  `performance, and test coverage.\n\n` +
  `Report up to ${MAX_FINDINGS_PER_REVIEW} concrete findings: file, line when you can pinpoint ` +
  `it, a short title, why it is a real problem, and a severity (critical|high|medium|low). Only ` +
  `report issues you can point to in the code — no speculation, no style nits. Also give an ` +
  `overall assessment (2-4 sentences): the state of the change, its main risks, and whether it ` +
  `looks ready to merge.`

const reviews = (
  await parallel(
    REVIEWERS.map((r) => () =>
      agent(reviewPrompt, {
        provider: r.provider,
        model: r.model,
        label: `review: ${r.name}`,
        phase: "Review",
        schema: REVIEW_SCHEMA,
      }).then((review) => ({
        reviewer: r.name,
        assessment: review.assessment,
        findings: (review.findings || []).slice(0, MAX_FINDINGS_PER_REVIEW),
      })),
    ),
  )
).filter(Boolean)

if (reviews.length === 0) throw new Error("both provider reviews failed — nothing to synthesize")
if (reviews.length < REVIEWERS.length)
  log(`warning: only ${reviews.map((r) => r.reviewer).join(", ")} completed — synthesis will lack cross-provider consensus`)
for (const r of reviews) log(`${r.reviewer}: ${r.findings.length} findings`)

// ---------------------------------------------------------------------------
// Synthesize — one agent (run-default provider; override with --provider) sees
// both labeled reviews and merges them into a single ranked picture.
// ---------------------------------------------------------------------------
phase("Synthesize")

const synthesis = await agent(
  `You are synthesizing ${reviews.length} independent full code reviews of ${target}, each from a ` +
    `different model provider. Merge them into one picture:\n` +
    `1. Match findings that describe the same underlying issue — even when worded differently or ` +
    `pointing at slightly different lines — and merge them into one finding with foundBy listing ` +
    `every reviewer that caught it. Consensus findings are the highest-confidence ones; rank them ` +
    `first, then by severity.\n` +
    `2. Keep findings only one reviewer caught, attributed via foundBy. Spot-check any that look ` +
    `dubious against the actual code and drop clear false positives (say so in the report).\n` +
    `3. Where the reviews DISAGREE — about the same code, or in their overall assessments — call ` +
    `the disagreement out explicitly in the report rather than silently picking a side.\n\n` +
    `The report should open with a 2-4 sentence overall verdict that synthesizes both assessments, ` +
    `then note where the reviewers agreed and disagreed, then walk the merged findings in ranked ` +
    `order (severity, foundBy, file:line, what is wrong, fix direction in a sentence).\n\n` +
    `Reviews (JSON):\n${JSON.stringify(reviews, null, 2)}`,
  { label: "synthesize", phase: "Synthesize", schema: SYNTHESIS_SCHEMA },
)

const SEVERITY_RANK = { critical: 0, high: 1, medium: 2, low: 3 }
const findings = (synthesis.findings || [])
  .slice()
  .sort(
    (a, b) =>
      (b.foundBy || []).length - (a.foundBy || []).length ||
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      a.file.localeCompare(b.file),
  )

const consensus = findings.filter((f) => (f.foundBy || []).length > 1).length
log(`${findings.length} merged findings (${consensus} consensus)`)

return {
  reviews: reviews.map((r) => ({ reviewer: r.reviewer, assessment: r.assessment, findingCount: r.findings.length })),
  findings,
  report: synthesis.report,
}
