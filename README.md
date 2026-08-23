![omegacode](omega-logos/header.png)

# omegacode

[![CI](https://github.com/SawyerHood/omegacode/actions/workflows/ci.yml/badge.svg)](https://github.com/SawyerHood/omegacode/actions/workflows/ci.yml)

An **agent-agnostic implementation of Claude Code's Workflows**. omegacode runs JavaScript workflow
files that orchestrate fleets of coding agents with a small deterministic DSL — `agent()` /
`parallel()` / `pipeline()` / `phase()` — and the workers are pluggable: the same workflow can
drive **Claude Code**, **Codex**, **OpenCode**, **pi**, and **Grok** in a single run.

## Install

```bash
bun add -g omegacode
omegacode install-skill
```

`install-skill` teaches your agents how to author and run workflows by copying the skill into
`~/.claude/skills/` (Claude Code) and `~/.agents/skills/` (Codex and other agents). Pass
`--claude` or `--agents` to install to just one.

You'll need Node 20+ and at least one worker installed: `codex` (the default provider), `claude`,
`opencode` (≥ 1.16.2), `pi` (≥ 0.79.1, `bun add -g @earendil-works/pi-coding-agent`),
and/or `grok` (≥ 0.2.112). Run
`omegacode doctor` to check — it flags binaries below the minimum versions, which the workers
refuse at runtime.

> **Note on opencode/pi sandboxing:** neither CLI can enforce a confined sandbox, so omegacode
> accepts them **only** with an explicit `sandbox: "danger-full-access"` (per call or via
> `--sandbox`). The default `read-only` sandbox is rejected with an error naming the remedy —
> a deliberate fail-closed choice. Model strings pass through verbatim to the backend (e.g.
> `agent("…", { provider: "opencode", model: "openrouter/anthropic/claude-sonnet-4.5", sandbox: "danger-full-access" })`).

> **Note on Grok:** Grok maps all three OmegaCode sandbox modes onto its OS sandbox profiles.
> Its one-shot subprocess cannot surface approval prompts, so calls use `approval: "never"`
> (the default). Structured output resumes the working session for a tool-less formatting turn.

## Use it

With the skill installed, just ask your agent:

> use omegacode to adversarially review this PR with both claude code and codex

It will author a workflow — finders fan out in parallel, a cross-provider skeptic pass tries to
refute each finding, a synthesizer merges what survives — then run it and report back. Runs are
journaled and resumable, and `omegacode serve` opens a live dashboard of every agent as it works.
When the Codex provider is used, the provider-side Codex worker threads are started as ephemeral
threads so they do not persist as normal Codex Desktop sidebar sessions; OmegaCode's own run
directory remains the durable record.

## What a workflow looks like

```js
export const meta = { name: "adversarial-review", description: "find bugs, cross-examine them" }
// FINDINGS and VERDICT are plain JSON Schemas, elided here

phase("Find")
const findings = await parallel(
  ["correctness", "security", "performance"].map((lens) => () =>
    agent(`Review the diff through the ${lens} lens. List concrete issues.`, { schema: FINDINGS })),
)

phase("Verify")
return await pipeline(
  findings.filter(Boolean).flatMap((f) => f.issues),
  (issue) => agent(`Try to refute: ${issue.desc}`, { provider: "claude-code", model: "claude-fable-5", schema: VERDICT }),
)
```

Plain JavaScript, no imports — the DSL is injected. Each `agent()` spawns a real Codex, Claude
Code, OpenCode, pi, or Grok agent; omit `provider`/`model` to inherit whatever the run was started with
(`--provider --model`, default `codex`), or pin them per call when you want cross-provider
diversity. Provider and model are **both-or-neither** at every site (per-call, meta defaults,
CLI flags): a lone `provider:` or `model:` is rejected, so a model meant for one provider can
never silently ride another provider's call.

Provider-native options stay deliberately provider-specific:
- Claude Code: `claudeAgent` selects a user-level custom agent. OmegaCode loads only the user
  setting source for that call; ordinary calls continue to load no settings sources.
- Codex: `codexChildRole` uses provider thread metadata to prove an exact native child role completed,
  then deletes that temporary provider thread subtree; `codexWebSearch` is `"disabled"`, `"cached"`, or `"live"`;
  and `codexNetworkAccess` controls network access inside read-only/workspace-write sandboxes.
  These options affect resume identity and are rejected when paired with another provider.

## CLI

```
omegacode run <file.workflow.js | name>   # run a workflow (auto-starts the live viewer)
omegacode serve                           # read-only dashboard over all runs
omegacode run <name> --resume <runId>     # resume — only the changed suffix re-runs
omegacode run <name> --detach --json      # launch in background and print run metadata immediately
omegacode status <runId> --json           # read native status from events.jsonl + heartbeat
omegacode wait <runId> --json             # wait for terminal native JSON
omegacode doctor                          # check all provider binaries + minimum versions
omegacode guide                           # print the full authoring guide
```

`run` also accepts saved workflow names. Six built-ins ship with the package:
`deep-research`, `code-review`, and four multi-provider workflows that put the two
models' decorrelated errors to work — `multi-provider-review` (both review the same
branch independently, then a synthesis merges both), `bake-off` (both implement the
same task in isolated worktrees, blind cross-provider judges pick a winner),
`provider-debate` (propose → attack → rebut for N rounds, then a judge rules), and
`second-opinion` (both answer cheap; agreement returns merged, disagreement escalates
to deep effort and adjudicates). Try `omegacode run deep-research --args '"your
question"'`, or `omegacode workflows` to list them. See `omegacode guide` for the
complete authoring reference.
