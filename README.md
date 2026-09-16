![omegacode](omega-logos/header.png)

# omegacode

[![CI](https://github.com/SawyerHood/omegacode/actions/workflows/ci.yml/badge.svg)](https://github.com/SawyerHood/omegacode/actions/workflows/ci.yml)

An **agent-agnostic implementation of Claude Code's Workflows**. omegacode runs JavaScript workflow
files that orchestrate fleets of coding agents with a small deterministic DSL — `agent()` /
`parallel()` / `pipeline()` / `phase()` — and the workers are pluggable: the same workflow can
drive **Claude Code**, **Codex**, **OpenCode**, **pi**, **Grok**, and **Muse** in a single run.

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
`grok` (≥ 0.2.112), and/or `muse` (≥ 1.2.1). Run
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

Plain JavaScript, no imports — the DSL is injected. `evaluate({state, questions, model?}, {label?, key?})` is a separate
System One primitive for fast typed judgments through TypeSafe Jev; it is **not** an agent provider and never
inherits coding-agent model/effort settings. It batches Choice/Score/Noul questions against one state, reads
`TYPESAFE_API_KEY` only in the host process, journals both successes and failures for deterministic resume,
and retries only transient 429/529/transport failures. Enable it explicitly with `--typesafe`; permission
is pinned on resume, and legacy runs remain disabled. `--fake --typesafe` never calls the API.
The result is `{model, answers, usage: {input_tokens, output_tokens}}` with raw token counts, not estimated
currency. `model` defaults to `jev-latest`; explicit identifiers up to 256 UTF-8 bytes permit pinned revisions.
`runWorkflow().evaluationUsage` separates reported actual from replayed usage; `unknownAttempts` counts
current-process attempts without reported token usage. Zero reported tokens do not prove zero billing.
Each call partitions independent questions into at most 32 requests of 32,000 UTF-8 JSON bytes each
(a local byte limit, not a tokenizer measurement). State or individual questions that cannot fit fail
without truncation. Admission allows 2 MiB and 4,096 questions per call; a run allows 4,096 evaluation
calls independently of agent limits. One 10-second total deadline covers queueing, all partitions,
body reads, and up to three attempts per partition, with eight concurrent evaluation slots and a 1 MiB
response limit. Retry-After is never shortened; a delay outside the deadline fails to caller fallback.
Attempt admissions and receipts are journaled before/after HTTP, including unknown usage. Ambiguous
attempts may be repeated on resume; this is not exactly-once execution. There is no endpoint override;
redirects are refused. Worker environments strip the host key, but an already-running shared Codex socket
server has its own environment: this process cannot sanitize it. Start that external server without the key.
Workflows
should catch evaluation failure and preserve their existing reasoning path when Jev is optional.

Each `agent()` spawns a real Codex, Claude
Code, OpenCode, pi, Grok, or Muse agent; omit `provider`/`model` to inherit whatever the run was started with
(`--provider --model`, default `codex`), or pin them per call when you want cross-provider
diversity. Provider and model are **both-or-neither** at every site (per-call, meta defaults,
CLI flags): a lone `provider:` or `model:` is rejected, so a model meant for one provider can
never silently ride another provider's call.

Provider-native options stay deliberately provider-specific:
- Claude Code: `claudeAgent` selects a user-level custom agent. OmegaCode loads only the user
  setting source for that call; ordinary calls continue to load no settings sources.
- Claude Code: `claudeProfile` selects a stable Subscription Picker profile ID for a new direct
  Agent SDK call. Resolve names with `bb subscription resolve-omega --reference ... --json`, persist
  only `profileId`, and never use an `acp-sub-*` route. At runtime the strict resolver also returns
  `configDir` and `claudeCodeExecutable`; OmegaCode binds both to that call without changing the
  parent process. The profile joins cache identity so it can accompany `claudeAgent`; the named
  agent then loads from the selected home. The viewer shows that profile's authored subscription
  name, not the stable id.
- Codex: `codexChildRole` uses provider thread metadata to prove an exact native child role completed,
  then deletes that temporary provider thread subtree; `codexWebSearch` is `"disabled"`, `"cached"`, or `"live"`;
  and `codexNetworkAccess` controls network access inside read-only/workspace-write sandboxes.
  `codexPermissions` selects a non-empty named permission profile in the caller-owned Codex
  configuration (Codex 0.153.4+). It replaces legacy sandbox fields on thread and every turn;
  the profile owns filesystem and network policy, so it cannot accompany `codexNetworkAccess`.
  Keep `sandbox` aligned with the profile: it still governs OmegaCode approval/write bookkeeping,
  not the named profile’s actual permissions. Omitting `codexPermissions` preserves legacy behavior.
  Integrations can require `omegacode capabilities --json` to return
  `{ "schemaVersion": 1, "codexPermissions": true }` before preparing credentials or running.
  This static check reports OmegaCode bridge support; it does not probe the installed Codex or profile.
  These options affect resume identity and are rejected when paired with another provider.
- Codex's `workflow-research-v1` execution profile exposes only `btca`, `executor_research`,
  `grok_search`, and `mintlify`. It explicitly disables the full `executor` server and fails before
  worker launch if any allowlisted server is absent from the host inventory.

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

### Muse workers

Muse uses the existing CLI login and one `muse exec --json` process per attempt. Select `provider: "muse"` together with a model (for example `muse-spark-1.3-contributor`). Effort values pass through unchanged; `maxTurns` sets the model-step limit. Read-only selects the private `omegacode-read-only` permission profile: shell reads remain enabled, direct writes are denied, and the OS sandbox enforces read-only filesystem and restricted network access; full access is explicit; workspace-write is rejected because confinement failed the spike. Per-run private settings remove MCP servers and symlink authentication without copying credentials. Token usage is reported from the session log; subscription cost remains unpriced (`costUsd: 0`). Muse’s sandbox denies the per-user cache, so read-only Muse workers cannot compile Swift or Clang projects; Node and Python test runs worked in live product runs. `MUSE_BIN` overrides the executable. Run `pnpm verify:muse-smoke -- --bin /path/to/muse` for the opt-in real-binary smoke; ordinary tests use fakes.
