// omegacode-original built-in: both providers implement the same task in isolated worktrees, then
// blind judges from both providers score the two diffs (neutral A/B labels, shuffled per run, so
// neither judge knows whose work is whose), a tie-break settles splits, and the closing report
// says what to graft from the loser. Both worktree branches are preserved for the user.
// Run with: omegacode run bake-off --args '"<task>"'   (or --args '{"task": "..."}')

export const meta = {
  name: "bake-off",
  description:
    "Implementation bake-off — Codex and Claude each build the same task in isolated worktrees, blind cross-provider judges score the diffs, tie-break on splits, report with graft suggestions.",
  defaultSandbox: "read-only",
  phases: [
    { title: "Implement", detail: "each provider builds the task in its own git worktree" },
    { title: "Judge", detail: "blind A/B scoring by one judge per provider; tie-break on splits" },
    { title: "Report", detail: "verdict, preserved branches, what to graft from the loser" },
  ],
}

const CONTENDERS = [
  { provider: "codex", model: "gpt-5.6-sol", name: "Codex" },
  { provider: "claude-code", model: "claude-fable-5", name: "Claude" },
]

const task =
  typeof args === "string" && args.trim()
    ? args.trim()
    : args && typeof args === "object" && typeof args.task === "string" && args.task.trim()
      ? args.task.trim()
      : null
if (!task) throw new Error(`bake-off needs a task — pass --args '"<task>"' or --args '{"task": "..."}'`)

// Neutral, unique-per-run branch names (now() is resume-stable) with a shuffled provider→slot
// mapping, so the judges' A/B labels carry no provider hint. Best-effort blinding: the diff
// itself can still hint at a model's style, so judges are told to score only the code.
const stamp = now().toString(36)
const shuffled = random() < 0.5 ? [CONTENDERS[1], CONTENDERS[0]] : [...CONTENDERS]
const slots = shuffled.map((c, i) => ({
  ...c,
  slot: i === 0 ? "A" : "B",
  branch: `bake-off/${stamp}-${i === 0 ? "a" : "b"}`,
}))

const IMPL_SCHEMA = {
  type: "object",
  required: ["approach", "tested"],
  properties: { approach: { type: "string" }, tested: { type: "string" } },
}

const JUDGE_SCHEMA = {
  type: "object",
  required: ["winner", "scoreA", "scoreB", "reasoning"],
  properties: {
    winner: { type: "string", enum: ["A", "B", "tie"] },
    scoreA: { type: "number" },
    scoreB: { type: "number" },
    reasoning: { type: "string" },
  },
}

// ---------------------------------------------------------------------------
// Implement — same prompt, separate worktrees. Committing is mandatory: the
// judges read each entry as `git diff HEAD...<branch>`, so uncommitted work
// is invisible to them (and an untouched worktree is auto-removed).
// ---------------------------------------------------------------------------
phase("Implement")
log(`bake-off: ${task}`)

const built = (
  await parallel(
    slots.map((s) => () =>
      agent(
        `Implement the following task in this repository, completely:\n\n${task}\n\n` +
          `Match the existing code style and conventions. Run the project's relevant tests or build ` +
          `if available and make them pass. COMMIT all of your work to the current branch with clear ` +
          `messages — uncommitted changes will not be judged. Do not push.\n\n` +
          `When done, summarize your approach and exactly what you verified (tests run, manual checks).`,
        { provider: s.provider, model: s.model, label: `implement: ${s.name}`, phase: "Implement", worktree: s.branch, schema: IMPL_SCHEMA },
      ).then((r) => ({ ...s, approach: r.approach, tested: r.tested })),
    ),
  )
).filter(Boolean)

if (built.length === 0) throw new Error("both implementations failed — nothing to judge")

// ---------------------------------------------------------------------------
// Judge — one judge per provider scores both diffs blind. Agreement on a
// non-tie winner decides it; a split or all-tie goes to a tie-break judge
// who also sees the first judges' reasoning.
// ---------------------------------------------------------------------------
let verdicts = []
let winnerSlot = null

if (built.length === 1) {
  winnerSlot = built[0].slot
  log(`only ${built[0].name} finished — wins by default`)
} else {
  phase("Judge")
  const [a, b] = built[0].slot === "A" ? built : [built[1], built[0]]
  const judgePrompt =
    `Two competing implementations of the same task exist as branches in this repository.\n\n` +
    `Task:\n${task}\n\n` +
    `Implementation A: branch ${a.branch}\nImplementation B: branch ${b.branch}\n\n` +
    `Review each with \`git diff HEAD...<branch>\` and read enough surrounding code to judge it in ` +
    `context. Judge ONLY the code — ignore commit authorship, message style, and anything else ` +
    `that hints at who wrote it. Score each implementation 0-10 weighing correctness, ` +
    `completeness against the task, code quality, and test coverage, then pick a winner — "tie" ` +
    `only when they are genuinely inseparable. Be specific about what decided it.`

  verdicts = (
    await parallel(
      CONTENDERS.map((j) => () =>
        agent(judgePrompt, { provider: j.provider, model: j.model, label: `judge: ${j.name}`, phase: "Judge", schema: JUDGE_SCHEMA }).then(
          (v) => ({ judge: j.name, ...v }),
        ),
      ),
    )
  ).filter(Boolean)

  const calls = verdicts.map((v) => v.winner).filter((w) => w !== "tie")
  if (verdicts.length > 0 && calls.length > 0 && new Set(calls).size === 1) {
    winnerSlot = calls[0]
  } else if (verdicts.length === 0) {
    log("both judges failed — reporting without a verdict")
  } else {
    log(`judges split (${verdicts.map((v) => `${v.judge}: ${v.winner}`).join(", ")}) — tie-break`)
    const tiebreak = await agent(
      `${judgePrompt}\n\nTwo judges already scored these and could not agree:\n` +
        `${JSON.stringify(verdicts.map((v) => ({ winner: v.winner, scoreA: v.scoreA, scoreB: v.scoreB, reasoning: v.reasoning })), null, 2)}\n\n` +
        `You are the tie-break. Weigh their reasoning against the actual diffs and make the final ` +
        `call — "tie" only as a last resort.`,
      { label: "tie-break", phase: "Judge", effort: "xhigh", schema: JUDGE_SCHEMA },
    )
    verdicts.push({ judge: "tie-break", ...tiebreak })
    winnerSlot = tiebreak.winner === "tie" ? null : tiebreak.winner
  }
}

// ---------------------------------------------------------------------------
// Report — the A/B mapping is revealed only here, after all judging is done.
// ---------------------------------------------------------------------------
phase("Report")

const winner = winnerSlot ? built.find((c) => c.slot === winnerSlot) : null
log(winner ? `winner: ${winner.name} (${winner.branch})` : "verdict: tie")

const report = await agent(
  `Write the closing report for an implementation bake-off.\n\n` +
    `Task:\n${task}\n\n` +
    `Contenders (the judges saw only the A/B labels):\n` +
    `${JSON.stringify(built.map((c) => ({ slot: c.slot, provider: c.name, branch: c.branch, approach: c.approach, tested: c.tested })), null, 2)}\n\n` +
    `Judge verdicts:\n${JSON.stringify(verdicts, null, 2)}\n\n` +
    `Verdict: ${winner ? `${winner.name} (slot ${winner.slot}) won` : "tie / no verdict"}.\n\n` +
    `Cover: the verdict and the decisive reasons; concrete strengths of the winner; anything in the ` +
    `other implementation worth grafting — read its diff (git diff HEAD...<branch>) and name ` +
    `specific files or ideas; and exact next steps (git commands to inspect each branch, merge the ` +
    `winner, cherry-pick grafts). Both worktree branches are preserved.`,
  { label: "report", phase: "Report" },
)

return {
  winner: winner ? winner.name : "tie",
  branches: Object.fromEntries(built.map((c) => [c.name, c.branch])),
  judges: verdicts,
  report,
}
