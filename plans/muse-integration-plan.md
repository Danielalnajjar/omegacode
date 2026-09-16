# Add Muse as an optional worker provider

## Summary

- Let a caller choose Muse Code wherever Codex, Opus, and Grok are chosen today:
  the OmegaCode `provider` option, the four standalone products (omega-review,
  omega-simplify, workflow-review, workflow-simplify), and later BB children.
- Build the OmegaCode worker on `muse exec --json` through the existing
  subprocess JSONL helper, exactly as the opencode, pi, and grok workers were
  built. No SDK dependency, no long-lived host, no shared session.
- Sequence: value check, read-only gate, skills-checkout admission cleanup,
  OmegaCode worker, four routes, then BB only if still wanted.
- The plan was parked on 2026-09-13, rewritten on 2026-09-15 after a
  plan-hardening review, and updated the same day with the compatibility
  spike's measured results. Nothing here authorizes execution; each slice
  needs its own implementation request.

## Artifact Status

**OmegaCode worker implemented and merged (PR #11); follow-up corrections recorded here** — the spike ran on 2026-09-15 (Spike Results
below) and the owner ratified the per-run private config directory the same
day. Slices 3 and 4 were authorized on 2026-09-15; this document records the as-built OmegaCode slice, not proof of skills-checkout installation or per-product verification. Slice 6 stays deferred.

## Intent Contract

- **Goal:** add `muse` as a worker provider without changing any existing
  default, route, binding, or orchestrator.
- **Success:** a workflow file, a standalone request for any of the four
  products, and (later) a BB spawn can select Muse and produce their normal
  validated artifacts; every existing provider, route, and saved policy or
  binding behaves byte-for-byte as before.
- **Non-goals:** Workflow Cycle and both Plan products; replacing Fable as the
  parent orchestrator; native Muse subagents; a shared Muse abstraction between
  OmegaCode and BB; migrating old Muse terminal sessions; a generic provider
  framework; redesigning the provider architecture.
- **Constraints:** no credential copying; no HOME override; a per-run private
  config directory that symlinks the user's auth file is the one permitted
  config-home override (ratified 2026-09-15); no silent model, effort,
  sandbox, or transport fallback; no weakened read-only guarantee; no second
  retry or schema-correction layer; no compatibility shims or dual paths;
  saved policies and bindings keep their bytes and digests.
- **Destination and format:** this repository-local Compact plan and its
  companion [spike prompt](muse-compatibility-spike-prompt.md). Both are
  self-contained; no chat or thread-storage artifact is a prerequisite.

## Context

The owner wants a fourth worker option for review and simplify lanes and for
BB children. The 2026-09-13 research established feasibility but no runtime
evidence. The hardening review found the earlier draft named the right risks
and left the decisions to the implementer: transport pre-selected on one
cancellation operation, host scope decided by the factory cache, read-only
strategy unstated, an unrepresentable usage claim, and a skills-side routing
change whose acceptance row a Grok misroute would pass. This rewrite decides
those points and reorders the work so the cheapest disqualifying checks run
first.

## Repo Evidence

Installed on 2026-09-15: Muse Code `1.2.1 (1.2.1-R2847.1)`, BB `0.43.1`,
skills checkout HEAD `a95d3a18`, this repo at `ced685e`. Reconfirm on resume.

Muse CLI facts from `muse exec --help` and `muse --help` (installed help, not
web docs):

- `muse exec [OPTIONS] [PROMPT]` with `--json` (JSONL events on stdout),
  `--prompt-file`, `--model <ID>`, `--reasoning-effort
  none|minimal|low|medium|high|xhigh|max|ultra`, `--max-model-steps <N>`,
  `--workspace <PATH>` (policy-gated workspace tools rooted there),
  `--session-id <UUID>`, `--no-session-log`, `--no-foreign-personal-context`,
  `--disable-web-tools`, `--user-input-auto-resolve`.
- Safety flags: `--approval-mode untrusted|on-request|never`,
  `--approval-judge off|on`, `--permission-profile <ID>`, `--disable-write`
  (non-shell workspace writes), `--disable-shell`, `--disable-sandbox`,
  `--sandbox-network restricted|enabled|proxy-only`. Approval and sandbox are
  on by default.
- `--provider echo` with `--echo-delay-ms` is a built-in credential-free
  provider, usable for deterministic fixtures.
- The effort menu is identical to `Effort` in `src/dsl/types.ts`. The SDK and
  adapter effort lists omitted `max`; that mismatch is irrelevant to exec.
- No output-schema flag and no per-run MCP flag were found in help. `muse
  config validate --plane <defaults|policy>` and `muse config status` exist.
- `muse serve` (MSP over stdio) and the official SDK exist; this plan does not
  use them.

OmegaCode facts:

- `src/dsl/types.ts`: `PROVIDER_IDS` const tuple (five members), `Sandbox`
  union with `read-only` as the run default, `Effort` union, both-or-neither
  provider/model rule, `AgentUsage` with three required numbers and
  `emptyUsage()`, `DEFAULTS.concurrency` 100.
- `src/worker/factory.ts`: exhaustive switch with a `never` check; one Worker
  cached per `id::serviceTier::codexExecutionProfile` for the run; provider-wide
  launch options only (`grokBin` and friends).
- `src/worker/subprocess-jsonl.ts`: `runJsonlSubprocess` owns spawn, strict-LF
  framing, stderr ring buffer, stall watchdog, SIGTERM then SIGKILL abort,
  `binary_not_found` and `spawn_failed` normalization; `captureStdout`,
  `exitError`, `versionAtLeast`.
- `src/worker/grok.ts`: the closest template. Temp prompt file, streaming
  JSON events, `EFFORT_TO_GROK` and `SANDBOX_TO_GROK` tables, `GROK_MIN_VERSION`
  with a `provider_outdated` error, terminal and `stopReason` discrimination,
  usage preserved on failure.
- `src/runtime/primitives.ts:503-533`: `prepareAgentCall` is gated on
  `claudeProfile`; `withRetry` (four attempts, `src/worker/errors.ts`) and the
  single corrective structured-output attempt both re-invoke `runAgent`.
- `src/runtime/keys.ts`: `KEY_VERSION = "v5"`; keyed fields already include
  provider, model, effort, sandbox, and permission semantics.
- Provider id is duplicated by hand in `src/dsl/ambient.d.ts` (asserted by
  `test/packaging.test.ts:246`), `viewer/src/components/glyphs.tsx`,
  `src/cli.ts` usage and help strings, `cmdDoctor` rows, `cmdCapabilities`,
  `src/runtime/run.ts` env wiring, README.md, DESIGN.md (provider-set note at
  line 21), `skill/SKILL.md`.
- Tests enumerate providers by hand at `test/keys.test.ts:132` and
  `test/cli.test.ts:438`; `viewer/src/components/glyphs.dom.test.tsx` covers
  only grok.
- Repo gate: `pnpm verify:deps` = claude-profile auth check, typecheck, build,
  viewer Vitest, `pnpm test` (node:test, bare glob over `test/*.test.ts`), pack
  dry-run. CI runs the same across ubuntu and macos on Node 20/22/24 with
  Windows lanes on continue-on-error. Nothing in CI has a Muse binary.
- `docs/adr/0001-explicit-claude-profile-routing.md` is the precedent for
  recording a provider-routing decision.

Skills checkout facts (`~/Code/skills`, moves independently; re-verify lines):

- `shared/skills/_shared/workflow-worker-policy/resolve_worker_policy.py`:
  `MODES = ("codex","fast","opus","grok")` at line 19; per-product request
  allowlists `{"codex","opus","grok"}` at ~176-181; `_mapped_provider_route`
  at ~216-226 returns a Grok route for every non-opus provider;
  `selection_kind` computed at ~303 but `_validate_route` at ~333-342 takes no
  selection context and allows `{"codex","claude-code","grok"}`. The request
  token namespace (`opus`) differs from the resolved-route namespace
  (`claude-code`).
- `shared/skills/_shared/workflow-profile-binding/resolve_profile_binding.py`:
  `MODES = _POLICY.MODES` at line 68, checked at ~100, ~149, ~206, and
  `create --mode choices=MODES` at ~308. `validate_binding_against_policy`
  compares `workerPolicyDigest` to the policy digest. The four products require
  `--profile-binding-file` as a sibling of the worker policy, so a Muse
  standalone request cannot validate today.
- The literal provider set `codex, claude-code, grok` is copied in ten files:
  the resolver, eight `*.workflow.js`/`*.bb.js` files under the review,
  simplify, plan, and discovery-first-plan skills, and
  `shared/plugins/omegacode/src/routing-studio-model.ts` (plus
  `routing-studio.tsx` labels). `workflow-cycle-worker/run_worker.py:1126`
  holds a reverse dict that raises `KeyError` on an unknown provider.
- Tests: `workflow-worker-policy/tests/test_resolve_worker_policy.py` with a
  literal transcribed `EXPECTED_ROUTES` table (92 rows);
  `workflow-profile-binding/tests/test_resolve_profile_binding.py`; per-product
  `scripts/test-*.mjs` under omega-review and omega-simplify and `tests/*.mjs`
  under workflow-review and workflow-simplify. Both runners are invoked file by
  file; no aggregate runner exists.

## Spike Results (2026-09-15)

Run on the Pro against Muse 1.2.1-R2847.1 with the subscription login. Receipt
and 137 fixture files (JSONL transcripts, stderr, prompts, broker-log
snapshots, versions) are in this thread's storage at
`~/.bb/thread-storage/thr_6pypjafdth/muse-prespike/`; selected gate fixtures
are committed in `test/fixtures/muse/`. The historical PASS labels below do not
prove broader predicates that the recorded probes did not exercise.

| Gate | Verdict | Measured fact |
|---|---|---|
| R1 read-only | PASS | `--disable-write --disable-shell` leaves `read_file` and `search`; a review of PR #10 used 10 reads and 3 searches, left the tree untouched, and produced an accurate, specific report. The full R1 predicate also requires an attempted write to be denied; reads plus an unchanged tree alone do not establish that predicate. |
| C1 MCP | PASS (lever 6 only) | Workspace settings, `--permission-profile`, `--agents` overlay, env vars, and defaults/policy documents all failed or could not be applied per run. A private config dir selected by `XDG_CONFIG_HOME`, holding a copy of `settings.json` with the top-level `mcpServers` member removed and every other entry (auth, rules, locks) symlinked, ran with zero broker-log clients and the subscription model configured. The absence of an `mcp.startup.task_handle` event is not evidence; the broker log is. |
| W1 workspace-write | FAIL | Under the default sandbox with `--approval-mode never`, `write_file` succeeded outside the workspace. `workspace-write` is refused pre-spawn. |
| P2 terminals | recorded | `completed` (exit 0); `failed` with reason text (exit 1, bad model); SIGTERM: no terminal, exit 143; missing binary: spawn error. A clarifying-question prompt answered normally, so auto-cancel of `request_user_input` remains unexercised. |
| P3 concurrency | PASS | Two simultaneous runs returned their own texts, both exit 0. This measured independent completion, not the full P3 cancellation-isolation predicate (cancel one while the other finishes). |
| P4 cleanup | PASS | No process-group member survived three seconds after SIGTERM to the `muse` process. The full P4 predicate also covers a stall deadline and descendant cleanup; this observation proves only the SIGTERM case. |
| E1 effort/model | PASS | `--reasoning-effort max --max-model-steps 1` exit 0; `run.model.configured.model_id` = `muse-spark-1.3-contributor`. |

Other measured facts:

- `--session-id` conflicts with `--no-session-log`; let Muse generate the id.
- `--provider echo` cannot run while user settings set `run.parallel_tool_calls`
  (both the setting and its override flag are rejected for echo). Fixtures are
  recorded real transcripts, not echo output.
- `--approval-mode never` auto-approves policy-gated calls (reads and writes
  both succeeded without prompts).
- No usage event exists in the exec stream by design; token accounting lives
  only on the `muse serve` plane. Usage is unreported.
- The earlier "permission profile conflicts with per-run isolation" reading was
  a CLI flag clash with `--approval-mode` / `--sandbox-network` only, not private
  XDG configuration. The follow-up profile spike `~/.bb/thread-storage/thr_crc3gy2ppu/muse-profile-spike/receipt.md` (A/D/E)
  proved shell reads (git diff, rg, git log), direct-write and in/out-of-workspace
  shell-write denials, and a curl failure with a successful unsandboxed control.
  D completed at exit 0 with zero new broker rows. The derived profile extends
  `:read-only` with `approval: "allow_all"` and `reviewer: "none"`.
- The recorded W1 out-of-workspace write landed in the temp area the default
  sandbox documents as writable. `workspace-write` support is a follow-up
  candidate for a later spike; it remains unsupported here.
- Public docs stop at release 0.2.1; the subscriptions page restricts only the
  credential (must be signed in through the CLI), not the mode. The linked
  terms of service were not read.
- Delegation to native subagents is unavailable while the workspace is
  untrusted; the worker never passes `--trust-workspace`.

## Existing Reuse

- `runJsonlSubprocess`, `captureStdout`, `exitError`, `versionAtLeast`,
  `DEFAULT_STALL_TIMEOUT_MS` from `src/worker/subprocess-jsonl.ts`.
- `GrokWorker` in `src/worker/grok.ts` as the structural template, including
  its `SpawnProcess` test seam and version probe.
- `assertValidSchema`, `parseJsonLoose`, `parseValidJson` from
  `src/worker/schema.ts`.
- The scripted `FakeProc` harness in `test/grok-worker.test.ts` and
  `test/pi-worker.test.ts`; the `doctor` stub-binary pattern and `--provider`
  round-trip loop in `test/cli.test.ts`; the fixture and skip conventions in
  `test/claude-profile-smoke.test.ts` and `test/packaging.test.ts`.
- `scripts/claude-profile-smoke.mjs` as the template for a credential-lane
  harness kept out of `pnpm test`.
- Skills side: the `EXPECTED_ROUTES` transcription convention, the
  `env_fixture.py` binding fixtures, and the existing per-product `.mjs` tests.

## Caller Usage

Written first; types and tables below derive from it.

Workflow file:

```js
const out = await agent("Review the diff for correctness bugs.", {
  provider: "muse",
  model: "<muse model id recorded by the spike>",
  effort: "high",
  sandbox: "read-only",
  maxTurns: 40,
  schema: FindingsSchema,
})
```

Standalone request (any of the four products), request-token namespace:

```json
{ "product": "omega-review", "provider": "muse", "unitModel": null, "unitEffort": null }
```

Resolved route emitted by the policy resolver, route namespace:

```json
{ "provider": "muse", "model": "<default muse model id>", "effort": "high" }
```

BB spawn (deferred slice): `bb thread spawn --provider acp-muse ...` through an
ACP adapter; out of scope until the deferred slice is authorized.

Resolved menus: every OmegaCode `Effort` value maps to itself; `maxTurns` maps
to `--max-model-steps`; `sandbox` maps per the table in Chosen Approach.

## Chosen Approach

**Transport: `muse exec --json`, one child process per `runAgent` call.**
Each call writes the prompt to a temp file and spawns
`muse exec --json --prompt-file <f> --model <m> --reasoning-effort <e>
--workspace <cwd> --max-model-steps <n>
--no-session-log --no-foreign-personal-context --disable-web-tools
--user-input-auto-resolve`
plus the sandbox flags below. `runJsonlSubprocess` owns the process lifetime.
There is no shared host, so host scope, session leases, start throttling, and
the `prepareAgentCall` seam do not apply; every whole-worker retry and the one
corrective schema attempt spawn a fresh process with a fresh session id, and
no prior-turn context carries across attempts. The SDK and `muse serve` are
rejected for OmegaCode: they would move stall detection, kill escalation, and
spawn-failure classification to a third party the repo does not own, for a
single caller that never needs a second turn. This decision is recorded in
`docs/adr/0002-muse-exec-transport.md`.

**Sandbox mapping, including the follow-up profile spike:**

| OmegaCode sandbox | Muse flags | Gate |
|---|---|---|
| `read-only` | `--permission-profile omegacode-read-only`; shell enabled, OS filesystem read-only and network restricted | Follow-up profile spike A/D/E above |
| `workspace-write` | refused pre-spawn with non-retryable `unsupported_sandbox` (W1 FAIL) | measured |
| `danger-full-access` | `--approval-mode never --approval-judge off --disable-sandbox --disable-approval` | unchanged |

R1 passed, so `read-only` maps. W1 failed, so `workspace-write` is refused
before spawn with a non-retryable `unsupported_sandbox` error naming the two
supported modes (the opencode and pi precedent at
`src/worker/opencode.ts:82-86`). The four standalone products need only
`read-only` and are unaffected.

**Effort:** direct pass-through of `spec.effort` to `--reasoning-effort`; no mapping or downgrade table is implemented.

**Structured output:** single turn, schema instructions appended to the prompt
as grok does, parsed with `parseJsonLoose` and `assertValidSchema`. A parse or
validation failure throws the existing schema `AgentError`; the corrective
attempt in `src/runtime/primitives.ts` is the only retry. No resume-based
extraction turn in v1.

**Usage:** the exec stream emits no usage event. Return the zero-valued
`emptyUsage()` shape and emit no usage progress event; downstream totals cannot
distinguish unknown usage from zero. The earlier "unavailable, not zero" claim is withdrawn as
unrepresentable in the result contract; DESIGN.md records that Muse cost is
unreported when the CLI does not report it.

**Authentication and configuration:** the worker runs as the logged-in OS
user with the existing `muse login`. Because Muse has no per-run MCP control,
each `runAgent` call builds a private config directory in its temp dir: resolve
the source config dir (`$XDG_CONFIG_HOME/muse` if set, else
`~/.config/muse`); full-access runs without source `settings.json` retain no
override. Read-only always writes private settings. Create `<tmp>/xdg/muse` (mode 0700), write `settings.json` (mode
0600) as the source JSON with the top-level `mcpServers` member removed and
for read-only merge the authoritative `omegacode-read-only` profile under
`permissions.profiles`, preserving other profiles and permissions fields, with
`schema_version: 1` at the top level and inside `permissions`. Without source
settings, write only the schema and permissions fields. Symlink every other
entry when the source dir exists, and
spawn with `XDG_CONFIG_HOME=<tmp>/xdg`. In `finally`, await the subprocess
`closed` fence (including kill escalation) before removing the directory and
prompt file; preserve the original classified run error if removal fails. Never copy `auth.json`; never override
HOME. Per-run flags stay: `--no-foreign-personal-context`, `--no-session-log`,
`--disable-web-tools`, `--user-input-auto-resolve`.

**Provider-wide options only:** `museBin` joins `FactoryOpts` and `MUSE_BIN`
joins the env wiring in `src/runtime/run.ts`. No Muse-specific spec option
exists in v1, so `KeyedFields` and `KEY_VERSION` are unchanged. The factory
cache key is unchanged.

**Skills side:** `resolve_worker_policy.py` becomes the single owner of two
provider sets, `CYCLE_PROVIDERS = {codex, claude-code, grok}` and
`STANDALONE_PROVIDERS = CYCLE_PROVIDERS | {muse}`, with explicit per-provider
dispatch and a raising default. This cleanup lands before Muse and is correct
without it.

**BB:** deferred and independent. No shared Muse module exists between the
OmegaCode worker and any ACP path; the community adapter is not owned by this
repo and any repair to it is an upstream or fork decision.

## Critical Files for Implementation

OmegaCode:

- `src/worker/muse.ts` (new) — `MuseWorker`, `MUSE_MIN_VERSION = "1.2.1"`,
  direct effort pass-through, sandbox flags, event mapping, terminal detection.
- `src/worker/factory.ts`, `src/worker/index.ts` — `museBin` option and the
  `case "muse"` branch; the `never` check forces it.
- `src/dsl/types.ts`, `src/dsl/ambient.d.ts` — add `"muse"` to `PROVIDER_IDS`
  and the hand-copied `OmegacodeProviderId` union.
- `src/runtime/run.ts` — `museBin` override and `MUSE_BIN` env.
- `src/cli.ts` — `--provider` usage and help strings, `doctor` row with
  `MUSE_MIN_VERSION`, `capabilities` output.
- `viewer/src/components/glyphs.tsx` — Muse provider mark.
- `test/muse-worker.test.ts` (new), `test/fixtures/muse/*.jsonl` (new,
  recorded), `test/factory.test.ts`, `test/cli.test.ts`, `test/keys.test.ts`,
  `test/provider-env.test.ts`, `test/packaging.test.ts`,
  `viewer/src/components/glyphs.dom.test.tsx`.
- `scripts/muse-smoke.mjs` (new) and a `verify:muse-smoke` package script —
  the only place a real Muse binary is ever invoked.
- `docs/adr/0002-muse-exec-transport.md` (new), README.md, DESIGN.md,
  `skill/SKILL.md`, `package.json` keywords.

Skills checkout:

- `shared/skills/_shared/workflow-worker-policy/resolve_worker_policy.py` and
  `tests/test_resolve_worker_policy.py` — provider-set ownership, explicit
  dispatch, selection-aware route validation, Muse routes.
- `shared/skills/_shared/workflow-profile-binding/resolve_profile_binding.py`
  and `tests/test_resolve_profile_binding.py` — selection-aware mode admission.
- The eight workflow files and `routing-studio-model.ts` holding the literal
  provider set; `workflow-cycle-worker/run_worker.py:1126`.
- Per-product tests: `shared/skills/omega-{review,simplify}/scripts/test-*.mjs`,
  `claude/skills/workflow-{review,simplify}/tests/*.mjs`; the products'
  `SKILL.md` and README request examples and shell provider labels.

## Implementation Plan

### 0. Value check (one real call, owner-judged)

- Run `muse exec --json --prompt-file` at effort `high` with the read-only
  flags above against a diff the owner has already had reviewed by Astra and
  Opus with known findings. Record the JSONL transcript and the findings.
- Owner compares the findings. If Muse is not competitive, stop; nothing
  further is built. This is one of the two real calls the spike may make.

### 1. Compatibility spike (disposable, no production changes)

Run the [spike prompt](muse-compatibility-spike-prompt.md). Gates, each with an
observable predicate:

- **R1 read-only evidence.** With `--disable-write --disable-shell`, the echo
  provider and one real turn can read a file, search the workspace, and read a
  prepared diff file; a write attempt through any tool is denied; no file
  under the workspace changes (hash before and after).
- **W1 workspace-write confinement.** Under the default sandbox a shell write
  inside `--workspace` succeeds and one outside it is denied.
- **C1 configuration and MCP.** A fake stdio MCP server registered in the
  user-level Muse configuration writes a marker on launch; an exec run with the
  flags above must not produce the marker. Foreign rules and skills are absent
  from the turn. No credential is read from anywhere but the existing login.
- **P1 protocol vocabulary.** From the echo provider and the recorded real
  turn: the event names for session start, message items, tool calls, usage,
  and the turn terminal; whether the final text is a distinct event or the last
  message item; the exit code on success, on model error, and on a cancelled
  turn. Commit the recorded transcripts under `test/fixtures/muse/` with the
  CLI version and build hash beside them.
- **P2 failure paths.** Missing binary, nonzero exit, truncated stream at EOF,
  malformed line, and a turn that ends without a terminal event, each produced
  through the echo provider or a wrapper script, with the observed output.
- **P3 concurrency.** Two concurrent exec runs with distinct session ids
  complete independently; cancelling one leaves the other's output intact.
- **P4 cleanup.** After SIGTERM mid-turn and after a stall deadline, no Muse
  descendant process survives (enumerate by process group before and after).
  If descendants survive, record that the worker must spawn detached and kill
  the group.
- **E1 effort and model.** The second real call: a trivial prompt at
  `--reasoning-effort max` with `--max-model-steps 1`; record acceptance and
  the model id the session reports. That id becomes the policy default model.

Deliver the PASS/FAIL/UNRUN matrix (gate id, probe path, predicate, artifact,
verdict), the recorded fixtures, and a draft of ADR-0002. An unobserved
predicate is UNRUN, never PASS. A false predicate is FAIL and cannot be
re-scored with a relaxed predicate.

### 2. Skills-checkout admission cleanup (prerequisite, independent of Muse)

- In `resolve_worker_policy.py`: define `CYCLE_PROVIDERS` and
  `STANDALONE_PROVIDERS`; convert `_mapped_provider_route` to explicit
  per-provider dispatch whose default raises `PolicyError("unsupported
  provider ...")`, deleting the Grok fallback; pass `selection_kind` into
  `_validate_route` so cycle policies accept `CYCLE_PROVIDERS` and standalone
  policies accept `STANDALONE_PROVIDERS`; rename `_OPUS_CYCLE` and
  `_GROK_CYCLE` to selection-neutral names.
- In `resolve_profile_binding.py`: keep the binding schema and the `mode`
  field name so saved bindings keep their bytes and digests. `create --mode`
  accepts `MODES` plus the standalone request tokens; validation checks the
  value against the policy's own `selection.kind` (cycle: `MODES`; standalone:
  the request-token set) instead of the global `MODES` alias. Delete the alias.
- Add a unittest that reads each of the ten literal-set files and asserts the
  literal equals the resolver's published set for that file's product family
  (cycle and plan files stay on `CYCLE_PROVIDERS` deliberately). Replace the
  `run_worker.py` reverse-dict `KeyError` with a typed policy error.
- Add a binding-continuity test: a binding and policy pair committed verbatim
  from before this change validates against its own recorded policy and
  resolves byte-identical routes.
- Run the two Python suites and every per-product `.mjs` test.

### 3. OmegaCode worker

- `src/worker/muse.ts` following `grok.ts`: version probe with
  `MUSE_MIN_VERSION`, temp prompt file, flag assembly from the tables above,
  event mapping to `WorkerProgress`, success only on the matching terminal
  event plus exit 0 and string payload.text; pre-terminal progress only,
  authoritative final text from the terminal, zero-valued usage, structured output per the
  decided path.
- Terminal and error classification, each a required test with expected
  `code` and `retryable`: `run.terminal.completed` with `terminal:
  "completed"`, exit 0, and string `payload.text` → result with that text as authoritative; conflicting later terminals → `turn_failed`;
  `terminal: "failed"` (or any other value) → non-retryable `turn_failed`
  carrying `payload.reason`; process exit without a terminal event → on our
  own abort `AgentInterrupted`, otherwise non-retryable `turn_incomplete`
  (exit 0) or `exitError` (nonzero); stall → retryable `turn_stalled`
  (helper-owned); missing binary → `binary_not_found`; unsupported sandbox or
  version → non-retryable pre-spawn rejection. No terminal value is retryable
  until a measured transient failure shows one. Muse emits no usage event, so no usage-preservation path is implemented.
- Provider id in `PROVIDER_IDS`, `ambient.d.ts`, factory, `run.ts`, CLI
  strings, `doctor`, `capabilities`, viewer glyph, README, DESIGN.md
  provider-set note (six providers), `skill/SKILL.md`, ADR-0002.
- Tests: replay the recorded fixtures through the `SpawnProcess` seam; convert
  `test/keys.test.ts:132`, `test/cli.test.ts:438`, and the glyph DOM test to
  iterate `PROVIDER_IDS`; add the `doctor` stub row; each new or materially
  changed test carries a one-line row naming the regression it catches.
  `scripts/muse-smoke.mjs` takes an injectable binary path;
  `test/muse-smoke.test.ts` exercises it against a fake binary only; the real
  lane runs only via `pnpm verify:muse-smoke`. Fixtures that need a POSIX shell
  use the existing `{ skip: process.platform === "win32" }` guard.

### 4. Four standalone routes

- Add `muse` to the four products' request allowlists only; `omega-plan`,
  `claude-workflow-plan`, and Cycle keep their sets.
- Add a `muse` branch to the explicit dispatch: `_route("muse",
  "muse-spark-1.3-contributor", <identity effort map>)`. `unitModel` and
  `unitEffort` stay codex-only in v1.
- Update the four products' request examples, shell provider labels, and
  workflow-local guards; regenerate catalog provenance without a Muse cycle
  column; the routing studio is deliberately unchanged, with a test asserting
  its provider list.
- Tests: literal Muse rows in `EXPECTED_ROUTES` for every lane and band of the
  four products; a negative test that no Muse request resolves to a `grok` or
  `claude-code` route; tests that the two Plan products and Cycle reject
  `muse` with the specific `PolicyError` message; per-product `.mjs` tests gain
  a Muse request case and a Muse first-provider-failure case.
- Install through `scripts/refresh-global.sh` and verify the installed command,
  not only the worktree.

### 5. BB children (deferred)

Authorize separately, and only after Muse has been used in the four lanes and
is still wanted. Scope when authorized: an ACP adapter for `muse serve`,
proving selected model and effort, approval outcomes under BB `full`, stdio
MCP tools, stop and follow-up, and retained session identity across restart
using a planted-nonce oracle (session id byte-identical and the nonce
reproduced unprompted; a fresh session after a failed load is a FAIL).
Simulated-client evidence and actual BB execution are reported as separate
rows. No OmegaCode file changes for this slice.

## Implementation Slices

1. **Value check** — route: direct, owner-attended. Oracle: recorded findings
   compared against the known Astra and Opus findings. Stop: owner says not
   competitive.
2. **Spike** — route: direct, disposable directory under thread storage.
   Oracle: the matrix with every predicate observed. Cleanup: kill every probe
   process, remove the fake MCP registration, keep only fixtures and receipts.
   Stop: R1 FAIL (owner go/no-go) or C1 FAIL (owner decision on MCP exposure).
3. **Skills cleanup** — route: omega-implement in the skills checkout.
   Oracle: all Python and `.mjs` suites green; binding-continuity test green;
   no route value changed for any existing request (the 92-row table is
   unchanged). Ownership: one writer in the skills checkout.
4. **OmegaCode worker** — route: omega-implement. Oracle: `pnpm verify:deps`
   green on a machine without Muse; `pnpm verify:muse-smoke` green on the Pro;
   the recorded-fixture replay tests fail if terminal detection is inverted.
   Adversarial: message item after terminal, terminal with no items, exit 0
   with no terminal, two concurrent calls with interleaved stderr.
5. **Four routes** — route: omega-implement in the skills checkout, after
   slice 4 is installed globally. Oracle: `EXPECTED_ROUTES` Muse rows,
   negative misroute test, per-product tests, one real omega-review run with
   `provider: muse` producing the normal validated artifact.
6. **BB** — deferred; not scheduled.

## Verification

- OmegaCode: `pnpm verify:deps` (auth check, typecheck, build, viewer Vitest,
  `pnpm test`, pack dry-run) must pass on a machine with no Muse binary.
  `pnpm verify:muse-smoke` is the only real-binary lane and is never reachable
  from `pnpm test`.
- Skills checkout: `python3 -m unittest` for both resolver suites (run from
  each `tests/` directory as the existing tests are), and `node` on each
  per-product test file named in Critical Files. Record the exact invocations
  used in the slice receipt.
- Public-surface proof: `omegacode run` with `--provider muse --model <id>
  --fake` round-trips; `omegacode doctor` shows the Muse row with version and
  OUTDATED formatting; one real standalone product run per product after
  slice 5.
- Journal resume: a run journal containing Muse results replays only
  unfinished work; keys for `muse` differ from every other provider's keys.
- Saved policies and bindings: pre-change fixture bytes validate unchanged.

## Assumptions And Blockers

- **Unverified:** the terminal produced when `--user-input-auto-resolve`
  cancels a model question. The worker treats every non-`completed` terminal
  as a non-retryable failure, so the classification is safe either way.
- **Unverified:** the Meta subscription terms of service for automated use;
  the subscriptions page itself imposes no mode restriction.
- **Scrap trigger:** redesign before continuing if any two of these appear
  independently: a second Muse-specific field is needed in `AgentSpec` or
  `KeyedFields`; a Muse-specific positional argument is needed on
  `WorkerFactory.get` or the cache key; a Muse-specific branch is needed inside
  `src/runtime/primitives.ts` or `src/runtime/run.ts`; the same workaround
  shape appears in both the worker and the skills resolvers. The redesign to
  consider is a per-provider options bag, not a generic provider framework.

## Handoff Checklist

- [x] Research conclusions, hardening-review amendments, and installed CLI
      facts preserved in the repository.
- [x] Spike prompt is repository-local and does not require old chat artifacts.
- [x] Owner authorized the value check and spike; both ran 2026-09-15.
- [x] Spike matrix recorded; R1 PASS, C1 PASS via private config directory,
      W1 FAIL (workspace-write refused).
- [x] Owner ratified the private config directory (2026-09-15).
- [x] ADR-0002 written for slice 4 and reconciled with the as-built worker.
- [x] OmegaCode provider wiring, worker, recorded-fixture tests, and opt-in smoke implemented (PR #11).
- [x] Owner authorized slices 3 and 4 (2026-09-15); slice 5 after slice 4.
- [ ] Installed command and one real run per product verified.
- [ ] BB slice authorized separately, if ever.
