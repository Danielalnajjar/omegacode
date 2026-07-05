# Add Native OmegaCode Async Lifecycle

## Summary

- Add first-class OmegaCode async lifecycle commands: `run --detach --json`, `status <runId> --json`, and `wait <runId> --json`.
- Preserve all existing foreground `omegacode run` behavior. Existing callers that do not pass `--detach` must keep receiving final terminal JSON only after the run completes.
- Make native run state the lifecycle authority by reusing the existing `events.jsonl` plus `.heartbeat` model instead of adding per-skill PID polling or chat-turn polling.
- Update Omega skill runners only after the OmegaCode CLI primitives are proven with fake tests, package tests, and one low-credit canary.

## Artifact Status

Ready for implementation.

This plan is decision-complete for v1. The stop/cancel surface is explicitly deferred from v1 and gated before changing Omega skill runners to detached-by-default behavior.

## Intent Contract

- Goal: let Codex and wrapper scripts launch long OmegaCode runs asynchronously, observe durable status, wait for terminal state, and resume closeout without repeated chat polling.
- Success criteria:
  - `omegacode run <workflow> --detach --json` returns immediately with a machine-readable run identity.
  - `omegacode status <runId> --json` reports status from the native run store without requiring the viewer server.
  - `omegacode wait <runId> --json` blocks until a terminal native state and exits with clear success/failure semantics.
  - Existing foreground `omegacode run --json` remains unchanged.
  - Omega skill runners can adopt the native async lifecycle through the shared runner without each skill inventing its own process machinery.
- Non-goals:
  - Do not build a daemon.
  - Do not make the viewer mutate or cancel runs.
  - Do not scan viewer text, infer identity from PID files, or parse native run directories ad hoc in wrappers.
  - Do not change workflow DSL behavior, provider routing, agent caching, worktree semantics, or resume key semantics.
- Constraints:
  - Keep package management under the repo's existing `pnpm` setup.
  - Preserve the current run store under `OMEGACODE_HOME` or `~/.omegacode`.
  - Keep wrapper semantic truth separate from native transport truth.
  - Do not switch Omega skills to detached mode until native CLI behavior is tested and installed.
- Artifact destination: `/Users/danielalnajjar/Code/omegacode/.context/native-async-lifecycle-plan.md`.
- Format: Compact plan.

## Context

Long OmegaCode runs already have durable native artifacts, but the CLI lacks a clean detach-and-wait surface. Today `omegacode run --json --start-json` can emit the run ID before completion, but the foreground process still owns completion and stdout. Omega skill wrappers work around this by launching foreground, capturing `run.started`, writing local coordination artifacts, and advising Codex to use coarse heartbeats when the run is long.

The better architecture is to make OmegaCode itself own the async lifecycle: one native detached launch, one native status command, and one native wait command. Wrapper scripts can then become thinner and stop treating foreground process lifetime as the only completion channel.

## Repo Evidence

- `/Users/danielalnajjar/Code/omegacode/src/cli.ts` currently dispatches only `run`, `serve`, `runs`, `workflows`, `save`, `validate`, `doctor`, `install-skill`, and `guide`.
- `/Users/danielalnajjar/Code/omegacode/src/cli.ts` keeps boolean CLI flags in `BOOLEAN_FLAGS`; `detach` will need to be added there.
- `/Users/danielalnajjar/Code/omegacode/src/cli.ts` currently awaits `runWorkflow()` in `cmdRun` and prints final JSON only after completion when `--json` is present.
- `/Users/danielalnajjar/Code/omegacode/src/runtime/run.ts` owns `runWorkflow()`, `RunOptions`, `RunOutcome`, run ID generation, signal handling, `.heartbeat`, terminal event emission, and final `result.json` writing.
- `/Users/danielalnajjar/Code/omegacode/src/runtime/events.ts` defines run events with `started`, `completed`, `failed`, and `interrupted`.
- `/Users/danielalnajjar/Code/omegacode/src/server/serve.ts` already folds `events.jsonl` into `started`, `completed`, `failed`, `interrupted`, `unknown`, and `stale`, and already applies a heartbeat deadman.
- `/Users/danielalnajjar/Code/omegacode/test/cli.test.ts` already has temp `OMEGACODE_HOME`, `runCli()`, fake-run JSON assertions, `--start-json` assertions, built-bin tests, and symlinked-bin tests.
- `/Users/danielalnajjar/Code/omegacode/test/serve.test.ts` already has stale heartbeat and cache-staleness fixtures.
- `/Users/danielalnajjar/Code/omegacode/package.json` defines `pnpm test`, `pnpm typecheck`, `pnpm build`, `pnpm pack --dry-run --json`, and `pnpm run verify:deps`.
- `/Users/danielalnajjar/Code/skills/shared/skills/_shared/omega-runner/launch.py` is the shared Omega skill launcher. It builds `omegacode run ... --json --start-json --args-file`, captures `run.started`, waits for process exit, writes `run-result.json`, and updates `run-manifest.json`.
- `/Users/danielalnajjar/Code/skills/shared/skills/_shared/omega-runner/runner.sh` centralizes `omega_launch`, `omega_resume`, and `omega_finalize` for the Omega skill wrappers.
- `/Users/danielalnajjar/Code/skills/shared/skills/_shared/omega-runner/status.py` is the shared read-only status renderer used by the thin skill-specific `status.sh` wrappers.
- `/Users/danielalnajjar/Code/skills/shared/skills/omega-cycle/references/agentic-workflow-routing.md` already separates native transport truth from wrapper semantic truth.

## Existing Reuse

- Reuse the existing `runWorkflow()` path for detached child execution. Do not create a second runtime path.
- Reuse the viewer's event-folding and heartbeat deadman semantics by extracting them into a shared runtime module rather than copying private `serve.ts` logic into CLI commands.
- Reuse `test/cli.test.ts` helpers for temp homes, CLI subprocesses, fake workflows, start-event parsing, and installed-bin behavior.
- Reuse `test/serve.test.ts` stale heartbeat fixtures as the model for `status` and `wait` tests.
- Reuse the shared Omega runner in `Code/skills` as the only integration point for wrapper adoption.

## Chosen Approach

Implement native async lifecycle in OmegaCode first, then update the shared Omega skill runner.

The key design decision is to preallocate the run ID in the parent process for detached runs. `run --detach --json` should not spawn a child and then parse child stderr to discover identity. The parent should generate or accept the run ID, create or know the run directory, spawn a detached child into the same `runWorkflow()` path, and return the identity immediately.

V1 will not include stop/cancel. Stop/cancel depends on a durable control surface, likely PID metadata plus signal semantics or a future control file. That is a separate design. V1 must, however, make the absence explicit and avoid switching skill runners to detached-by-default until the user accepts either:

- no stop surface for now, with `status/wait` and stale detection as the safety model; or
- a follow-up `omegacode stop <runId>` implementation before detached mode becomes the default for expensive Omega skill runs.

Recommended default: ship `detach/status/wait` first, keep foreground fallback, then decide `stop` before broad skill-runner adoption.

## Critical Files for Implementation

- `/Users/danielalnajjar/Code/omegacode/src/cli.ts` - owns command dispatch, CLI flag parsing, foreground `run`, viewer auto-start, and help text.
- `/Users/danielalnajjar/Code/omegacode/src/runtime/run.ts` - owns run ID generation, `RunOptions`, `runWorkflow()`, heartbeat, terminal events, result writing, and signal behavior.
- `/Users/danielalnajjar/Code/omegacode/src/server/serve.ts` - currently owns reusable run snapshot/status folding logic that should move to runtime.
- `/Users/danielalnajjar/Code/omegacode/src/runtime/events.ts` - defines the run event statuses that `status` and `wait` must interpret.
- `/Users/danielalnajjar/Code/omegacode/test/cli.test.ts` - primary CLI behavior, detach, status, wait, built-bin, and JSON contract coverage.
- `/Users/danielalnajjar/Code/omegacode/test/serve.test.ts` - source pattern for stale heartbeat and run-store status fixtures.
- `/Users/danielalnajjar/Code/skills/shared/skills/_shared/omega-runner/launch.py` - later integration point for replacing foreground completion with native detach/wait.
- `/Users/danielalnajjar/Code/skills/shared/skills/_shared/omega-runner/status.py` - later integration point for wrapper status using native `omegacode status`.

## Implementation Plan

### 1. Add a shared run-store module in OmegaCode

- Create a runtime-owned helper, for example `/Users/danielalnajjar/Code/omegacode/src/runtime/run-store.ts`.
- Move or duplicate only after extraction:
  - run ID validation;
  - run directory lookup;
  - `events.jsonl` reading;
  - event parsing with partial-line tolerance;
  - latest run status folding;
  - heartbeat mtime lookup;
  - deadman status calculation;
  - optional `result.json` loading.
- Update `/Users/danielalnajjar/Code/omegacode/src/server/serve.ts` to call the shared helper instead of owning private, divergent folding logic.
- Preserve the existing viewer API response shape unless the tests intentionally update it.

### 2. Add explicit run ID control to `runWorkflow()`

- Add `runId?: string` to `RunOptions`.
- Export or centralize run ID generation and validation.
- Reject incompatible inputs:
  - `runId` plus `resumeRunId`;
  - invalid run ID strings;
  - run ID collision with an existing run directory unless this is a controlled internal child start.
- Preserve current resume behavior: `resumeRunId` continues to target the existing journal and preconditions.

### 3. Add `run --detach --json`

- Add `detach` to `BOOLEAN_FLAGS`.
- Preserve normal foreground behavior for every command that omits `--detach`.
- For `run --detach --json`:
  - resolve workflow and args exactly as foreground `run` does;
  - start or reuse viewer exactly like foreground unless `--no-serve` is passed;
  - preallocate the run ID and run directory;
  - spawn a detached child process using the installed CLI entrypoint, not the TypeScript source path in packaged mode;
  - pass an internal child-only run ID flag or internal child command that invokes `runWorkflow({ runId })`;
  - redirect detached child stdout/stderr to `runs/<runId>/run.log`;
  - return immediate JSON on stdout:

```json
{
  "runId": "wf_...",
  "status": "started",
  "detached": true,
  "runDir": "/abs/path/to/runs/wf_...",
  "url": "http://127.0.0.1:4123/#/run/wf_..."
}
```

- `--detach` without `--json` may print the same information in human text, but `--detach --json` is the contract wrappers should use.

### 4. Add `omegacode status <runId> --json`

- Add `status` to `main()` dispatch.
- Require a run ID positional.
- Default to human output only if useful, but the plan's hard contract is `--json`.
- Read status from the run store, not from the viewer HTTP API.
- Return JSON that includes:
  - `runId`;
  - `runDir`;
  - `status`: `started`, `completed`, `failed`, `interrupted`, `unknown`, or `stale`;
  - `workflowFile` when known;
  - `startedAt` and `endedAt` when known;
  - `error` when known;
  - `result` only when `result.json` exists and is parseable;
  - `logPath` when `run.log` exists or is expected.
- Exit nonzero for missing run ID, invalid run ID, missing run directory, and unreadable/corrupt required metadata. Print JSON errors when `--json` is set.

### 5. Add `omegacode wait <runId> --json`

- Add `wait` to `main()` dispatch.
- Poll the same run-store helper used by `status`.
- Treat terminal statuses as:
  - success exit `0`: `completed`;
  - failure exit nonzero: `failed`, `interrupted`, `stale`, invalid run, missing run, or corrupt state.
- Treat `stale` as terminal because the existing deadman means the process died without a terminal event.
- Add optional low-risk flags only if they help tests and automation:
  - `--poll-ms <N>` with a sane default;
  - `--timeout-ms <N>` defaulting to no timeout or a long timeout.
- Do not require the viewer server for `wait`.

### 6. Stop/cancel decision gate

- Do not implement stop/cancel in v1.
- Before broad skill-runner adoption, make a decision:
  - If detached runs remain opt-in, no stop command is required for v1.
  - If detached runs become the default for expensive Omega skills, add either `omegacode stop <runId>` or a documented manual kill path backed by durable child PID metadata.
- If stop is added later, it must use `runWorkflow()`'s existing SIGTERM/SIGINT abort path when possible and report `interrupted` through normal terminal events.

### 7. Update OmegaCode docs and help

- Update `printHelp()` in `/Users/danielalnajjar/Code/omegacode/src/cli.ts`.
- Update `/Users/danielalnajjar/.agents/skills/omegacode/SKILL.md` only through the package's installed skill generation or documented install path, not by manually drifting the installed skill away from source.
- Update README or design docs only where they are package source of truth.
- Document the key distinction:
  - `run --json` is terminal foreground JSON;
  - `run --detach --json` is immediate launch JSON;
  - `wait --json` is terminal detached JSON.

### 8. Update Omega skill runner integration after OmegaCode passes

- Patch `/Users/danielalnajjar/Code/skills/shared/skills/_shared/omega-runner/launch.py` first.
  - Prefer native `omegacode run --detach --json`.
  - Persist returned `runId`, `runDir`, `url`, `processModel: "detached"`, and launch command in `run-manifest.json`.
  - Use `omegacode wait <runId> --json` when the wrapper wants to block for completion.
  - Continue writing `run-result.json` only from terminal native JSON.
- Patch `/Users/danielalnajjar/Code/skills/shared/skills/_shared/omega-runner/status.py`.
  - If no `run-result.json` exists and a native `runId` exists, call or mirror `omegacode status <runId> --json`.
  - Keep `status.sh` read-only.
  - Keep `run.sh finalize <artifacts-dir>` as the semantic closeout path.
- Patch closeout assumptions that hard-fail non-foreground process models.
  - Start with `/Users/danielalnajjar/Code/skills/shared/skills/omega-simplify/scripts/closeout.sh`.
  - Then adjust `omega-plan`, `omega-implement`, and `omega-review` closeout logic as needed.
- Patch SKILL docs for `omega-plan`, `omega-review`, `omega-implement`, `omega-simplify`, and `omega-cycle` after behavior changes are verified.

## Implementation Slices

### Slice 1: OmegaCode run-store extraction

- Suggested route: direct.
- Scope and oracle: `serve.ts`, CLI status, and tests all fold the same run events and heartbeat into the same status values.
- Automated verification: `node --test --import tsx ./test/serve.test.ts ./test/cli.test.ts`.
- Real-surface QA path: start `omegacode serve` and confirm an existing run still renders in the viewer.
- Adversarial cases: corrupt JSONL line, missing `events.jsonl`, missing heartbeat, stale heartbeat, terminal failed event.
- Cleanup/receipt expectation: no writes outside temp `OMEGACODE_HOME` during tests.
- Ownership boundary: OmegaCode repo only.
- Stop/ask condition: extraction changes existing viewer response shape unexpectedly.

### Slice 2: `run --detach --json`

- Suggested route: direct.
- Scope and oracle: parent returns launch JSON immediately; child continues to terminal state in native run dir.
- Automated verification: CLI fake tests using temp `OMEGACODE_HOME`.
- Real-surface QA path: detached fake workflow plus viewer URL if not `--no-serve`.
- Adversarial cases: child exits before start event, invalid args, invalid workflow, `--no-serve`, symlinked built bin, packaged `dist/cli.js`.
- Cleanup/receipt expectation: kill or reap detached children in test teardown; remove temp homes.
- Ownership boundary: OmegaCode CLI and runtime only.
- Stop/ask condition: implementation requires long-lived daemon state or viewer mutation.

### Slice 3: `status --json` and `wait --json`

- Suggested route: direct.
- Scope and oracle: status and wait report terminal state from `events.jsonl` plus `.heartbeat`.
- Automated verification: fake completed, fake failed, interrupted or stale, unknown run, invalid run ID.
- Real-surface QA path: run detached canary, then `status`, then `wait`.
- Adversarial cases: stale run with no terminal event, terminal failed event with no `result.json`, malformed result, missing run dir.
- Cleanup/receipt expectation: no real `~/.omegacode` writes in tests; use temp `OMEGACODE_HOME`.
- Ownership boundary: OmegaCode CLI/runtime only.
- Stop/ask condition: `wait` would need to parse viewer HTTP/SSE rather than file-backed run state.

### Slice 4: Shared Omega runner adoption

- Suggested route: direct or `omega-implement` after OmegaCode primitives are installed.
- Scope and oracle: one shared runner path can launch, inspect, wait, finalize, and validate a detached native OmegaCode run without per-skill duplicated process code.
- Automated verification: shared runner fixture tests plus one representative wrapper fake run.
- Real-surface QA path: one low-cost Omega wrapper canary after CLI install.
- Adversarial cases: native run started but no terminal result yet, native stale, native failed, closeout before terminal, resume after failed launch.
- Cleanup/receipt expectation: artifacts under `~/.omegacode/skill-runs` include manifest, run ID, native run dir, terminal result, and final report.
- Ownership boundary: `Code/skills` shared runner first, skill docs last.
- Stop/ask condition: detached mode would become default for expensive real workers before stop/cancel decision is made.

## Verification

Run from `/Users/danielalnajjar/Code/omegacode`:

```bash
node --test --import tsx ./test/cli.test.ts ./test/serve.test.ts ./test/resume.test.ts ./test/packaging.test.ts
pnpm typecheck
pnpm build
pnpm pack --dry-run --json
pnpm run verify:deps
```

Low-credit canary only after fake/package tests pass:

```bash
cd /Users/danielalnajjar/Code/omegacode
tmp="$(mktemp -d)"
cat > "$tmp/canary.workflow.js" <<'EOF'
export const meta = { name: "detach-canary", description: "one tiny detached canary" }
return await agent("Reply with exactly: omegacode detach canary ok", { effort: "none", maxTurns: 1 })
EOF
OMEGACODE_HOME="$tmp/home" node dist/cli.js run "$tmp/canary.workflow.js" --detach --json --no-serve --budget 2000
OMEGACODE_HOME="$tmp/home" node dist/cli.js status <runId> --json
OMEGACODE_HOME="$tmp/home" node dist/cli.js wait <runId> --json
```

After Omega skill runner adoption, run focused shared runner tests and one representative wrapper test:

```bash
cd /Users/danielalnajjar/Code/skills
rg -n "processModel|foreground|run-result.json|start-json|status.sh|finalize" shared/skills/_shared/omega-runner shared/skills/omega-*
```

Then use the wrapper's existing test scripts for the modified runner and the first patched skill. Do not run a broad expensive Omega worker fleet until the fake runner and one low-credit native canary pass.

## Assumptions And Blockers

Assumptions:

- It is acceptable for v1 to ship without `omegacode stop <runId>` as long as detached mode remains opt-in for real paid runs until the stop/cancel decision is made.
- `stale` is a terminal failure state for `wait`.
- `status` and `wait` should not require `omegacode serve`.
- Skill runner adoption should happen in `Code/skills` only after the installed/global `omegacode` command exposes the new primitives.

Blockers:

- Before changing Omega skills to detached-by-default behavior for expensive worker fleets, decide whether `omegacode stop <runId>` is required.
- If package tests reveal the detached child cannot reliably locate the packaged CLI entrypoint, fix packaging/entrypoint behavior before touching `Code/skills`.
- If `wait` cannot distinguish `unknown but just-started` from `unknown and dead`, add a bounded timeout or child-start marker instead of letting automation hang forever.

## Final Validation Checklist

- The plan preserves foreground `run --json` behavior.
- `run --detach --json` returns launch JSON, not terminal JSON.
- `wait --json` is the detached terminal JSON surface.
- `status` and `wait` both use the same run-store folding logic as the viewer.
- Stop/cancel is not silently omitted; it is a named adoption gate.
- Omega skill updates go through the shared runner first.
- Wrapper semantic closeout remains wrapper-owned and is not moved into OmegaCode.
