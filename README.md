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
`grok` (≥ 0.2.112), and/or `muse` (≥ 1.3.0). Run
`omegacode doctor` to check — it flags binaries below the minimum versions, which the workers
refuse at runtime.

> **Note on opencode/pi sandboxing:** neither CLI can enforce a confined sandbox, so omegacode
> accepts them **only** with an explicit `sandbox: "danger-full-access"` (per call or via
> `--sandbox`). The default `read-only` sandbox is rejected with an error naming the remedy —
> a deliberate fail-closed choice. Model strings pass through verbatim to the backend (e.g.
> `agent("…", { provider: "opencode", model: "openrouter/anthropic/claude-sonnet-4.5", sandbox: "danger-full-access" })`).

> **Note on Grok:** Grok maps all three OmegaCode sandbox modes onto its OS sandbox profiles. That sandbox hides gh's keychain login, so sandboxed Grok calls receive the caller's `gh auth token` as `GH_TOKEN`.
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
directory remains the durable record. Each provider thread releases its MCP processes when its
agent ends, while the app-server stays available for sibling agents.

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
  (issue) => agent(`Try to refute: ${issue.desc}`, { provider: "claude-code", model: "claude-fable-5-1", schema: VERDICT }),
)
```

Plain JavaScript, no imports — the DSL is injected. Each `agent()` spawns a real Codex, Claude
Code, OpenCode, pi, Grok, or Muse agent; omit `provider`/`model` to inherit whatever the run was started with
(`--provider --model`, default `codex`), or pin them per call when you want cross-provider
diversity. Provider and model are **both-or-neither** at every site (per-call, meta defaults,
CLI flags): a lone `provider:` or `model:` is rejected, so a model meant for one provider can
never silently ride another provider's call.

Provider-native options stay deliberately provider-specific:
- Claude Code: `claudeAgent` selects a user-level custom agent. OmegaCode loads only the user
  setting source for that call; ordinary calls continue to load no settings sources.
- Grok: `grokAgent` selects a user-level agent by name (for example `"librarian"`), loading
  its prompt, tools, disallowed tools, and MCP servers. Isolated Grok runs reject this option.
- Claude Code: on macOS, a call without `claudeProfile` launches through
  `~/.local/libexec/claude-with-executor-mcp` when that launcher is installed. It is the launcher
  BB's Claude routes run and a profile's launcher chains to, so Claude workers reach Executor
  unless the run sets an explicit executable. Isolated calls keep the SDK default and no MCP servers.
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
- Codex: `codexMcpServers: ["btca"]` enables named MCP servers from the agent cwd's Codex config for one
  thread; `codexPlugins: ["build-ios-apps@openai-curated"]` enables only the listed installed
  plugins for one thread and switches every other installed plugin off there. Plugin ids come
  from the host's inventory across every configured marketplace (`codex plugin marketplace list
  --json`, then `codex plugin list --marketplace <name> --json`), and differ between hosts.
  `computer-use@openai-bundled` also enables the `node_repl` server it runs through, and a plugin
  whose manifest hooks call an MCP server (`browser@openai-bundled` calls `node_repl`) enables that
  server. Unknown names, names containing `.` (Codex request overrides cannot address them), a hook
  server missing from that cwd's MCP inventory, remote plugins, and plugins whose manifest declares
  apps fail before `thread/start`: Codex's remote-plugin gate
  replaces the host's local curated plugins, and its app gate exposes every app connected to the
  ChatGPT account rather than one plugin's. Without these options every MCP server and the process-spawning
  plugin/app/browser features are off; web search and image generation keep their host settings.
  Execution profiles keep their dedicated app-server boundary: MCP names must be
  profile-allowlisted, and plugins are rejected.
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

### Agent time limits and failures

Every started `agent()` call has a two-hour wall-clock limit across provider preparation,
backoff retries, and the corrective structured-output retry. Set `--agent-timeout-ms N`
for a run (`0` disables it); the value is journaled and inherited when a resume omits
the flag. On expiry OmegaCode aborts that provider call and raises non-retryable
`AgentError` code `agent_timeout`, naming the limit. Parallel and pipeline siblings
continue, and the failed agent is recorded in the journal, transcript, and events.
Run cancellation remains a distinct interruption.

Claude Code also has a 30-minute no-message watchdog on its SDK query stream,
matching the Codex and Grok silence guards. It aborts the query and raises retryable
`AgentError` code `turn_stalled`, naming the silence interval; each incoming SDK
message resets the interval. The programmatic `ClaudeWorker` option
`stallTimeoutMs` overrides it (`0` disables it). The wall-clock limit still applies
when messages keep arriving.

### Muse workers

Muse uses the existing CLI login and one `muse exec --json` process per attempt. Select `provider: "muse"` together with a model (for example `muse-spark-1.3-contributor`). Effort values pass through unchanged; `maxTurns` sets the model-step limit. Read-only selects the private `omegacode-read-only` permission profile: shell reads remain enabled, direct writes are denied, and the OS sandbox enforces read-only filesystem and restricted network access; full access is explicit; workspace-write is rejected because confinement failed the spike. Per-run private settings remove MCP servers and symlink authentication without copying credentials. `museExecutionProfile: "workflow-research-v1"` instead keeps `btca`, `executor_research`, `grok_search`, and `mintlify` from the caller's Muse settings, re-enables them, and expands `${VAR}` in their `headers` and `env` (Muse itself does not); a missing server or unset variable fails with `invalid_config` before launch. Under read-only it also enables shell network (writes stay denied) and passes `gh auth token` as `GH_TOKEN`, since the sandbox hides gh's keychain login. This is the Muse librarian route: native Muse subagents stay unavailable because the workspace is untrusted. Token usage is reported from the session log; subscription cost remains unpriced (`costUsd: 0`). Muse’s sandbox denies the per-user cache, so read-only Muse workers cannot compile Swift or Clang projects; Node and Python test runs worked in live product runs. Each child gets `TBH_STREAM_IDLE_TIMEOUT_SECS` and `TBH_STREAM_FIRST_EVENT_TIMEOUT_SECS` of 3600 so max reasoning is not killed by Muse's 180s silent-stream default; OmegaCode's stdout stall watchdog uses the same one-hour bound. Set either variable to override. Schema calls always pass `exec --output-schema` (meta provider, terminal text). A remaining Ajv miss still runs one low-effort extraction exec of that answer; the runtime's full-task schema retry is last-resort. `MUSE_BIN` overrides the executable. Run `pnpm verify:muse-smoke -- --bin /path/to/muse` for the opt-in real-binary smoke; ordinary tests use fakes.
