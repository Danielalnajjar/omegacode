# Add Muse as an optional provider — deferred plan

## Summary

Preserve a possible future Muse Code integration for OmegaCode, Omega Review,
Omega Simplify, Workflow Review, Workflow Simplify, and BB ACP children/workflows.
The owner deferred this work on 2026-09-13. Nothing in this document authorizes
execution now. Resume only after an explicit request, starting with the
[compatibility-spike prompt](muse-compatibility-spike-prompt.md).

The research supports feasibility, not a working integration. A bounded runtime
spike must settle permissions, credential-preserving configuration control, and
BB continuity before production implementation is approved.

## Artifact Status

**Draft** — deliberately parked; required runtime evidence remains uncollected.

## Intent Contract

- **Goal:** add Muse as an optional worker/provider without changing existing defaults.
- **Success:** all four review/simplify commands produce their normal validated
  artifacts using Muse; BB child/workflow execution preserves selected model,
  permissions, tools, cancellation, and conversation continuity.
- **Non-goals:** Workflow Cycle or Plan modes, replacing the parent orchestrator,
  native Muse subagent parity, migrating old terminal conversations, a new
  subscription-picker product, or redesigning the provider architecture.
- **Constraints:** no credential copying, silent model/transport fallback,
  unreviewed downgrade, weakened read-only guarantees, or mutation of saved
  policies/bindings. Preserve machine-specific package ownership.
- **Destination/format:** this repository-local Compact plan and its companion
  prompt. They are self-contained; old chat or thread-storage artifacts are not
  prerequisites for resumption.

## Context and Research Snapshot

Three librarian lanes examined protocol/lifecycle, ACP/BB, and permissions/auth;
root inspected routing and delivery. The following is historical evidence from
2026-09-13, not a promise about versions available when this work resumes.

| Component | Inspected version/source |
|---|---|
| Muse CLI | `1.2.1-R2847.1`; handshake reports `1.2.1`, build `f9fb6cc3010b20954b48f7f97ee6d0aa6fdbbc71` |
| Official SDK | `0.1.1`, commit `fbce769ccb75ab971d00e01a00fe076de4c773fc` |
| Community ACP adapter | `0.4.1`, commit `ed57631c960b96a88109bb54e9a295239c2b57a9` |
| BB | Installed `0.43.0`, provider-acp plugin `0.1.0`; bridge source-map inspection |
| OmegaCode | `c74da991b6e7a2c9c59e01fc9d3f93b8e14fc4a1` |
| Skills checkout | HEAD `aa60552236fc93351da331122660511e33cf11f9` |
| Environment configuration checkout | HEAD `cd507e175e44c628651881ee470cc9061dd25e00` |

Important findings to retain:

1. Muse exposes headless `exec --json` and `serve` over Muse Session Protocol
   (MSP). Its official SDK is MIT-licensed; that does not establish that the CLI
   itself is open-source.
2. An initialize-only invocation of the installed server, with XDG-only fixture
   paths, no HOME override, no session creation, and no model call, succeeded and
   exited cleanly on EOF. This was not SDK execution or a complete session test.
3. SDK and installed schema fingerprints differed. The SDK warns on mismatch;
   it does not reject it. Installed Muse exposed `max`, while the SDK and adapter
   effort lists omitted it. Verify accepted model/effort values before selection.
4. The community adapter documented this Muse build as unsupported, but its
   runtime checked only `serve --help`, not a rejecting version comparison.
   There is no version guard to remove. Reported failures involved legacy exec
   imports and HTTP MCP diagnostics; their effect on fresh sessions was unproven.
5. The inspected BB bridge injects **stdio MCP**, not HTTP MCP. BB `full`
   automatically answers ACP approval requests but does not disable Muse's
   sandbox. ACP `auto` was rejected; no bridge `session/set_mode` caller was found.
6. BB can recover from a session-load error by creating a fresh session and
   emitting a warning. A successful response alone does not prove continuity.
7. Muse's ordinary sandbox permits workspace writes. `--disable-write` excludes
   shell writes; adapter read-only/plan modes also disable the shell. MCP tools
   are outside the native sandbox. Useful strict read-only operation is unproven.
8. An allowlisted settings inspection found required enabled 1Password MCP and
   native execution capacity 5. Root-inclusive capacity 1 is a documented
   child-spawn suppression candidate, not proof of observer-call suppression.
   Settings isolation that preserves subscription auth was not established.
9. No native ordinary-turn schema-output request was found. JSON transport does
   not guarantee valid findings JSON. Completed message items and matching turn
   terminal must be distinguished; no explicit final-answer channel was found.

Primary sources to recheck:

- [Official SDK and protocol source](https://github.com/meta-models/muse-code-sdk/tree/fbce769ccb75ab971d00e01a00fe076de4c773fc)
- [ACP adapter and compatibility tests](https://github.com/bex-co/muse-code-acp/tree/ed57631c960b96a88109bb54e9a295239c2b57a9)
- [Muse permissions](https://dev.meta.ai/docs/muse-code/permissions)
- [Muse configuration](https://dev.meta.ai/docs/muse-code/configuration)
- [MCP, skills, and multi-agent behavior](https://dev.meta.ai/docs/muse-code/extending)
- [Subscription behavior](https://dev.meta.ai/docs/muse-code/subscriptions)

Some `.md` documentation URLs returned older content than extensionless pages.
Use installed help/schema and version-matched source for load-bearing claims.

## Repo Evidence and Existing Reuse

- `src/worker/index.ts` defines the worker/result/progress boundary;
  `src/worker/factory.ts` dispatches providers exhaustively.
- `src/dsl/types.ts` owns provider IDs and option/result contracts. Preserve the
  provider/model both-or-neither rule and provider-specific option validation.
- `src/runtime/primitives.ts` owns schema validation and one corrective attempt;
  `src/worker/errors.ts` defaults to four retryable whole-worker attempts. Do not
  add another adapter retry/correction layer.
- `src/runtime/keys.ts` already keys resolved provider/model/effort and permission
  semantics. A new provider alone does not require a journal key-version change.
- Existing workers demonstrate process/result/error normalization. Reuse the
  worker interface, schema helpers, journals, and test-fixture patterns rather
  than introducing a generic provider framework.
- `scripts/refresh-global.sh` owns the tested packed-tarball Bun-global cutover.
  The installed command is not a live link to this worktree.

The four command implementations live in the separate skills checkout. Its
`shared/skills/_shared/workflow-worker-policy/resolve_worker_policy.py` has
per-product allowlists, but `_mapped_provider_route` returns Grok for every
non-Opus input. Existing admission prevents misrouting today; widening admission
alone would route Muse incorrectly. Add explicit Muse dispatch.

That checkout's `shared/skills/_shared/workflow-profile-binding/resolve_profile_binding.py`
aliases cycle `MODES` even for standalone bindings. Separate standalone/binding
admission from Cycle modes; do not add Muse to Cycle to make bindings validate.
Both hazards were confirmed by an isolated import-only probe, not a running
workflow. Existing saved-policy bytes and integrity checks must remain intact.

## Chosen Approach

First evaluate the official **lower-level SDK/MSP connection**. It exposes
explicit terminal, error, usage, and cancellation operations. The high-level
facade alone lacks the required public cancellation operation. For OmegaCode,
own one host and fresh root session per worker attempt; keep worktree selection
and whole-worker retry with OmegaCode. For BB, retain durable multi-turn sessions
through an ACP adapter. These callers need different session lifetimes.

This is a candidate pending runtime proof, not a certified SDK/CLI pair. Compare
exec JSONL only if MSP reveals a material obstacle; choose one tested transport,
never an automatic fallback. Preserve completed-item order, verify final-text
extraction, and return success only after the matching successful terminal.

## Critical Files for Implementation

1. `src/worker/muse.ts` (new), `src/worker/index.ts`, `src/worker/factory.ts` —
   provider implementation and construction.
2. `src/dsl/types.ts`, `src/runtime/run.ts`, `src/cli.ts` — provider admission,
   executable wiring, diagnostics, and help.
3. `src/runtime/primitives.ts`, `src/runtime/keys.ts`, `src/worker/schema.ts` —
   existing ownership boundaries to preserve; modify only if proved necessary.
4. Skills checkout: the shared worker-policy and profile-binding resolvers —
   standalone-only routes and valid integrity bindings.
5. Skills checkout: `shared/skills/omega-{review,simplify}` and
   `claude/skills/workflow-{review,simplify}` — request producers, shell provider
   labels, workflow-local guards, docs, and tests. Keep lead runtime labels
   `codex|claude` distinct from worker provider choice.
6. Skills checkout: `claude/skills/workflow-review/workflow/workflow-review.bb.js`
   and `shared/plugins/omegacode` — optional BB transport projection and catalog
   provenance. The routing studio is cycle-oriented; no Muse cycle column.
7. ACP adapter source and environment-configuration ownership docs — tested BB
   capabilities, configuration, installation, and machine-local authentication.

## Implementation Plan

The following stages are future work, not instructions to start now.

### 1. Close the compatibility gates in a disposable spike

Use the companion prompt. Build runnable synthetic fixtures for configuration,
read-only evidence access, structured results, terminal errors, retry boundaries,
cancellation, parallel isolation, BB-shaped stdio tools, and native-session
continuation. Test settings-path and MCP controls before any model turn. Keep
real subscription smoke tests conditional on established credential routing.

Deliver a PASS/FAIL/UNRUN matrix, pinned versions, tested launch configuration,
cleanup receipts, and a transport decision. A failed gate remains failed. Revise
this plan with the measured answers before requesting implementation approval.

### 2. Add and prove the OmegaCode worker

Implement the selected transport through the existing Worker contract. Forward
instructions, workspace, model, effort, cancellation, authoritative text, and
terminal errors correctly. Use existing structured validation/correction; do not
classify free-text errors or unknown terminal outcomes as successful or safely
retryable. Preserve unavailable usage as unavailable reporting, not a claim of
measured zero cost. Add focused public-contract and failure-path fixtures.

### 3. Add the four standalone routes

Extend only the four intended product allowlists and explicit route mappings.
Separate binding admission from cycle modes. Update shell provider labels,
workflow-local guards, request examples, and affected tests. Retain existing
stage-family semantics, fixed roles, external adjudication, and packet handoffs.
Simplify workers currently perform read-only analysis; this is not an editing
conversion. Regenerate catalog provenance without altering Cycle route values.

### 4. Validate and deliver BB support separately

Repair only required ACP compatibility, mode/configuration, and tool behavior.
Do not assume legacy terminal-history import is required for new BB threads.
Prove selected model/effort, approval outcomes, tools, stop/follow-up, and retained
session identity. Registration and any real BB end-to-end run require a later
explicit integration request; a simulated client is not equivalent evidence.

After source and real-host gates pass, use the existing packed-install owner for
OmegaCode and machine-approved ownership for Muse/adapter installation. Verify
the installed commands and skills, not only worktree tests. No downgrade or
credential copying. Pro-first evidence does not certify Air/WSL readiness.

## Verification

- Synthetic configuration markers prove effective path/merge behavior and no
  unintended real MCP access. No HOME/CODEX_HOME override or undocumented flags.
- Read/search/diff evidence succeeds; direct, shell, symlink, MCP, and descendant
  writes fail or are demonstrably unavailable. No reduction in review coverage.
- Valid partition/findings/packet outputs pass existing schemas; malformed,
  truncated, refused, failed, or unknown outcomes produce incomplete/error state.
- Cancellation and deadlines clean up owned process groups and session leases;
  sibling sessions remain isolated. Journal resume reruns only unfinished work.
- Four standalone products select Muse; Cycle and both Plan products reject it.
  Existing provider defaults, bindings, and routes are unchanged.
- BB-shaped tool/permission/continuation tests and actual BB execution are
  reported separately. A fresh session after failed load is not resume success.
- At implementation time, use `pnpm typecheck`, `pnpm test`, and `pnpm build`
  plus focused provider and skills suites; inspect current package instructions
  for required checks. Browser-verify changed provider UI if any.
- This documentation commit needs link/content checks and `git diff --check`,
  not product test execution or a new Muse call.

## Assumptions and Blockers

- **Technical blocker:** useful shell-enabled strict read-only enforcement is
  unproven. If unavailable, prove equivalent evidence access through safe tools
  and prepared artifacts before choosing a revised design.
- **Technical blocker:** supported configuration isolation that retains existing
  subscription auth and suppresses unwanted MCP/observer/delegation behavior is
  unresolved. Do not fix this with credential copies or replacement API keys.
- **Technical blocker:** complete turns, tool enforcement, cancellation trees,
  concurrency, and BB continuation have not been exercised end to end.
- **Assumption:** retain existing parent/orchestrator and explicit fixed roles;
  choose Muse only through standalone worker/provider selection.
- **Future scope check:** establish the requested host matrix on resumption.
  Work is parked, not promised for all machines or scheduled for execution.

## Handoff Checklist

- [x] Research conclusions and corrections preserved in the repository.
- [x] Resume prompt is repository-local and does not require old chat artifacts.
- [ ] Owner explicitly resumes the compatibility spike.
- [ ] Runtime gates resolve; plan records a tested configuration and transport.
- [ ] Owner separately authorizes production implementation.
- [ ] Actual installed command and BB acceptance completed after implementation.
