# Run omegacode workflows inside Amp via a custom plugin (new "amp" provider + `.amp/plugins/omegacode.ts`)

This ExecPlan is a living document. The sections `Progress`, `Surprises & Discoveries`, `Decision Log`, and `Outcomes & Retrospective` must be kept up to date as work proceeds. It must be maintained in accordance with `~/.agents/resources/plans.md` (the ExecPlan authoring spec; it is not checked into this repository).

Status: In progress (Milestone 1 completed 2026-08-06; Milestones 2–4 remain unstarted).

## Purpose / Big Picture

After this change, a user running Amp (Sourcegraph's coding agent — as the local `amp` TUI, on ampcode.com, or in an Amp "orb", their cloud sandbox machine) can ask Amp's main agent to run an omegacode workflow, and the workflow's `agent()` calls execute as real Amp threads on Amp-catalog models such as `xai/grok-4.5` and `openai/gpt-5.6-sol`. Each spawned agent appears in the ampcode.com dashboard as a child thread of the invoking thread, labeled `omega`, with Amp handling model access and billing. No Codex/Claude/opencode/pi CLI needs to be installed or authenticated for this lane — which is exactly what makes it work inside orbs, where only Amp itself is authenticated.

Observable outcome: in this repository, start `amp`, type "Use the omegacode_run_workflow tool to run examples/hello.workflow.js with model xai/grok-4.5", and watch the agent call the tool, spawn omegacode, and return a run receipt containing the run id, the child Amp thread ids (viewable at https://ampcode.com/threads/T-...), and the workflow's return value. The same prompt works in an orb thread started from ampcode.com because the plugin and setup script are committed to the repository.

## Progress

- [x] (2026-08-06 09:00Z) M1: `"amp"` provider in omegacode (types, socket transport, worker, factory, unit tests)
- [ ] M2: Amp plugin `.amp/plugins/omegacode.ts` (socket server, run_workflow tool, palette command) + local end-to-end validation
- [ ] M3: Orb enablement (`.agents/setup`, docs) + orb validation
- [ ] M4 (optional): viewer portal via `.amp/services.yaml`, richer per-tool progress

## Surprises & Discoveries

- Observation: Amp's plugin API exposes no token usage for plugin-created agent threads.
  Evidence: `AgentRunResult` is `{ threadID, text }` only, and `ThreadAssistantMessage` carries no usage field (ampcode.com/manual/plugin-api, scraped 2026-08-06). Consequence: the amp worker reports `emptyUsage()`; omegacode `budget` accounting does not see amp-lane tokens (Decision 5).
- Observation: `Agent.run()` returns the thread id only after completion, which would make cancellation and early dash-linking impossible.
  Evidence: plugin-api reference, `AgentRunResult`. Consequence: the plugin uses `createThread()` + `appendUserMessage()` + `waitForResponse()` instead (Decision 6).
- Observation: The exact model ids requested by the user exist in Amp's plugin-agent catalog.
  Evidence: `amp plugins show-agent-options --json` on 2026-08-06 lists `xai/grok-4.5`, `openai/gpt-5.6-sol`, `openai/gpt-5.6-luna`, `openai/gpt-5.6-terra` (plus anthropic, vertexai, fireworks, baseten entries).
- Observation: The M1 worker delivery missed `src/dsl/ambient.d.ts` (`OmegacodeProviderId` is an inlined copy of `PROVIDER_IDS` guarded by `test/packaging.test.ts`), and the packaging suite also compares `dist/ambient.d.ts` bytes — so the fix requires a rebuild before tests pass. Caught in Fable review (the worker receipt had reported a green suite); fixed 2026-08-06.
  Evidence: `pnpm test` failure "OmegacodeProviderId matches PROVIDER_IDS", green after the one-line ambient edit + `pnpm build`.
- Observation: The live environment-to-factory seam is in `src/runtime/run.ts`, not `src/cli.ts` as the original M1 wording stated.
  Evidence: `runWorkflow()` constructs `DefaultWorkerFactory`, and `resolveCodexAppServerSocket()` reads `OMEGACODE_CODEX_APP_SERVER_SOCKET` there; `src/cli.ts` only builds `RunOverrides`. The Amp socket now follows that live seam via `RunOverrides.ampSocket` and `resolveAmpSocket()` while CLI provider help is updated in `src/cli.ts`.

## Decision Log

- Decision 1: Integration direction is Amp → omegacode ("the Amp agent runs workflows"), not omegacode → Amp.
  Rationale: user directive on 2026-08-06 ("I want my amp agent to be able to use omegacode workflows in amp with grok 4.5 or gpt 5.6", "omegacode in amp orbs by us making a custom plugin"). Date/Author: 2026-08-06 / Fable.
- Decision 2: Workflow agents execute through Amp custom agents created by the plugin (`amp.createAgent({ model: ... })`), not through local provider CLIs.
  Rationale: orbs only have Amp authenticated; per-model selection (`xai/grok-4.5`, `openai/gpt-5.6-sol`) is only available to plugin-created custom agents — `amp -x` / the Amp SDK select modes (low/medium/high/ultra), not arbitrary models. Date/Author: 2026-08-06 / Fable.
- Decision 3: The omegacode runtime keeps running as a Node subprocess (spawned by the plugin); the plugin never imports omegacode in-process.
  Rationale: Amp plugins execute under Bun; omegacode's workflow interpreter depends on `node:vm` with `codeGeneration` restrictions (src/runtime/sandbox.ts) that are not trustworthy under Bun. Orbs preinstall Node.js, so spawning `node` works in both environments. Date/Author: 2026-08-06 / Fable.
- Decision 4: Transport between the omegacode worker (client) and the plugin (server) is newline-delimited JSON-RPC 2.0 over a unix domain socket, env var `OMEGACODE_AMP_SOCKET`.
  Rationale: mirrors the existing codex app-server precedent (`OMEGACODE_CODEX_APP_SERVER_SOCKET`, src/worker/jsonrpc-stdio.ts invariants); robust across Bun (server) and Node (client); no stdout pollution. Alternatives weighed: (a) spawning `amp -x --stream-json` per agent — rejected, cannot pick arbitrary models; (b) embedding omegacode in the Bun plugin with an injected WorkerFactory — rejected per Decision 3. Date/Author: 2026-08-06 / Fable.
- Decision 5: The amp worker reports `emptyUsage()` for every turn.
  Rationale: Amp does not expose token usage to plugins (see Surprises). Costs remain visible per-thread in the Amp dashboard. `budget.spent()` therefore under-counts on amp-only runs; documented in README. Date/Author: 2026-08-06 / Fable.
- Decision 6: The plugin fulfills `runAgent` with `createThread({ parentThreadID })` + `appendUserMessage` + `waitForResponse({ timeoutMs })`, holding the thread handle per call.
  Rationale: enables `cancelAgent` (via `thread.cancel()`) and an early `agentThread` notification carrying the thread id so the run journal can record the dash link before completion. Date/Author: 2026-08-06 / Fable.
- Decision 7: Structured output (`agent({ schema })`) follows the existing pi/opencode extraction-turn pattern: a working turn, then a second turn that receives the working text and must answer with JSON only; the worker parses with `parseJsonLoose`, and the runtime keeps owning validation plus its one corrective retry.
  Rationale: Amp threads have no structured-output mode; this pattern is already proven in src/worker/pi.ts and keeps the plugin protocol to a single `runAgent` method. Date/Author: 2026-08-06 / Fable.
- Decision 8: Sandbox mapping for the amp provider: `read-only` excludes Amp's editing tools (`apply_patch`, `create_file`, `edit_file`) via the agent's tool selection and adds a no-writes instruction line (shell can still theoretically write — documented as advisory); `workspace-write` and `danger-full-access` use `tools: 'all'`. `approval` and `maxTurns` are ignored (Amp has no equivalents; `maxTurns` is documented as provider-enforced where supported). `cwd` confinement is instruction-based ("operate only within <cwd>").
  Rationale: Amp has no OS-level sandbox flag; tool exclusion is the strongest available enforcement. Date/Author: 2026-08-06 / Fable.
- Decision 9: Effort mapping is identity for `none|minimal|low|medium|high|xhigh|max`; omegacode's `ultra` maps to `max` (same rule the Claude worker uses).
  Rationale: Amp's `AgentReasoningEffort` union matches exactly except `ultra`. Date/Author: 2026-08-06 / Fable.
- Decision 10: The plugin lives in this repository at `.amp/plugins/omegacode.ts` (project plugin), dogfooded on omegacode itself. Distribution to other repositories is out of scope for this plan.
  Rationale: project plugins load automatically both locally and in orbs because the orb clones the repo. Date/Author: 2026-08-06 / Fable.
- Decision 11: Resolve `OMEGACODE_AMP_SOCKET` in `src/runtime/run.ts` and forward it through `FactoryOpts.ampSocket`, while keeping `AmpWorker`'s direct environment fallback for standalone construction.
  Rationale: this matches the repository's current `OMEGACODE_CODEX_APP_SERVER_SOCKET` ownership and preserves the binding `AmpWorkerOpts.socket ?? process.env.OMEGACODE_AMP_SOCKET` interface. Date/Author: 2026-08-06 / Codex.

## Outcomes & Retrospective

- Milestone 1 (2026-08-06): Added the closed `amp` provider id, shared NDJSON JSON-RPC unix-socket transport, `AmpWorker`, factory/runtime wiring, CLI provider help, and an in-process socket-server test suite. `pnpm typecheck`, the full `pnpm test` suite, and `pnpm build` pass; the built CLI without `OMEGACODE_AMP_SOCKET` prints the specified `no_socket` message and exits 1. Milestones 2–4 remain deliberately unstarted.

## Context and Orientation

omegacode (this repository) is a CLI that runs "workflow" files — plain JavaScript files that begin with an `export const meta = {...}` literal and then use injected globals (`agent`, `parallel`, `pipeline`, `phase`, `log`, `budget`, `args`) to orchestrate fleets of coding agents deterministically. Key paths:

- `src/dsl/types.ts` — shared contracts. `PROVIDER_IDS = ["codex", "claude-code", "opencode", "pi"]` is the closed provider union; `AgentSpec` is the fully-resolved request a worker receives (`prompt, provider, model?, effort?, cwd, sandbox, approval, instructions?, schema?, maxTurns?, serviceTier?`); `AgentResult` is `{ text, structured?, status, usage }`.
- `src/worker/index.ts` — the `Worker` interface (`runAgent(spec, ctx)`, `shutdown()`), `WorkerContext` (`signal`, `onProgress`), the `WorkerProgress` event union, `AgentError`, `AgentInterrupted`.
- `src/worker/factory.ts` — `DefaultWorkerFactory` with an exhaustive switch over `ProviderId`; adding a union member forces a compile error here until handled.
- `src/worker/jsonrpc-stdio.ts` and `src/worker/codex-protocol.ts` — existing newline-delimited JSON-RPC 2.0 client over stdio for the codex app-server, including the framing helpers (`parseInbound`, `encodeRequest`) and the invariant that no pending request outlives its transport.
- `src/worker/pi.ts` and `src/worker/opencode.ts` — subprocess workers showing the schema "extraction turn" pattern and `assertValidSchema` / `parseJsonLoose` from `src/worker/schema.ts`.
- `src/runtime/primitives.ts` — owns schema validation and the single corrective retry; workers only produce text plus a best-effort `structured` value.
- `src/cli.ts` — commands (`run`, `serve`, `workflows`, ...). The `run` command resolves run defaults (provider/model/effort/sandbox) from CLI flags, meta, and config, and already plumbs `OMEGACODE_CODEX_APP_SERVER_SOCKET` from the environment into `FactoryOpts`.
- Build/test: `pnpm build` (tsup + viewer), `pnpm test` (`node --test --import tsx ./test/*.test.ts`), `pnpm typecheck` (`tsc --noEmit`). Node >= 20, pnpm 11.

Amp is Sourcegraph's coding agent. Facts this plan relies on (all verified against ampcode.com/manual, /manual/plugin-api, /manual/orbs, /manual/appendix scraped 2026-08-06, and the locally installed `amp` CLI 0.0.1785529588):

- An Amp plugin is a TypeScript file in `.amp/plugins/*.ts` (project) exporting a default function that receives a `PluginAPI` object. Plugins are long-lived processes executed with Bun. Plugin UI (`ctx.ui.notify/confirm/input/select`) renders in both the TUI and the web.
- `amp.registerTool({ name, description, inputSchema, execute })` adds a tool the main agent can call. `execute(input, ctx)` returns a string (or content blocks); `ctx.thread` is the invoking thread.
- `amp.createAgent({ name?, model, instructions, tools?, reasoningEffort?, display? })` creates a custom agent. `model` is `provider/model`, e.g. `xai/grok-4.5`, `openai/gpt-5.6-sol` (catalog: `amp plugins show-agent-options --json`). `tools` accepts `'all'`, a list, or `{ include, exclude }`. Built-in tool names include `apply_patch, create_file, edit_file, shell_command, Read, finder, glob-like tools, oracle, librarian, web_search` (exact list from the same command).
- An `Agent` handle supports `createThread({ parentThreadID?, executor?, show? })` returning a `PluginThread` with `appendUserMessage()`, `waitForResponse({ timeoutMs })` (default 10 minutes; rejects on thread error/timeout), `cancel()`, `messages()`, plus `run()` as a one-shot convenience. `executor` defaults to `'local'`; `'orb'` targets Amp's cloud sandbox.
- `amp.onDispose(cb)` runs on plugin unload/reload/graceful shutdown (~3s budget) — the backstop for killing child processes.
- Orbs are Debian 12 machines with Node.js, Bun, pnpm, git, ripgrep preinstalled. A repository's committed `.agents/setup` shell script runs while the orb is prepared. Project plugins from the cloned repo load in the orb. `.amp/services.yaml` can declare portal-exposed dev servers.

A "unix domain socket" is a local, filesystem-addressed IPC channel (`node:net` `createServer().listen(path)` / `connect(path)`); both Bun and Node support it. "NDJSON JSON-RPC" means one JSON-RPC 2.0 message per line.

Runtime topology after this plan:

    Amp (TUI/web/orb thread)
      └─ plugin .amp/plugins/omegacode.ts (Bun process)
           ├─ unix socket server  ←── NDJSON JSON-RPC ──┐
           ├─ spawns: node dist/cli.js run <workflow>    │  (env OMEGACODE_AMP_SOCKET=<path>)
           │    └─ omegacode runtime (node:vm sandbox)   │
           │         └─ AmpWorker (socket client) ───────┘
           └─ fulfills runAgent → amp.createAgent(model).createThread({parentThreadID}) → Amp threads

## Plan of Work

### Milestone 1 — `"amp"` provider in omegacode

Scope: after this milestone, `omegacode run <wf> --provider amp --model xai/grok-4.5` fails fast with a clear error when `OMEGACODE_AMP_SOCKET` is unset, and completes against a fake socket server in tests. Nothing Amp-specific is required on the machine.

Edits:

1. `src/dsl/types.ts`: add `"amp"` to `PROVIDER_IDS`. The comment about model strings staying open already covers `provider/model`-style ids.
2. New `src/worker/jsonrpc-socket.ts`: a small JSON-RPC 2.0 client over a unix socket, reusing `parseInbound`/`encodeRequest` from `src/worker/codex-protocol.js`, mirroring `jsonrpc-stdio.ts` semantics: pending-request map, per-request timeout, `onNotification`, and the invariant that connection loss rejects all pending requests and subsequent sends fail fast. Constructor takes `{ socketPath, requestTimeoutMs?, onNotification?, onConnectionGone? }`, exposes `request(method, params)`, `notify(method, params)`, `close()`.
3. New `src/worker/amp.ts`: `AmpWorker implements Worker` (`id: "amp"`).
   - Options `{ socket?: string }`; effective socket path is `opts.socket ?? process.env.OMEGACODE_AMP_SOCKET`; if absent, `runAgent` throws `AgentError({ provider: "amp", code: "no_socket", message: "amp provider requires the Amp omegacode plugin (OMEGACODE_AMP_SOCKET is not set); run this workflow from Amp via the omegacode_run_workflow tool" })`.
   - Lazily connects one shared client per worker. `shutdown()` closes it.
   - `runAgent(spec, ctx)`:
     - Requires `spec.model` (both-or-neither pairing means an amp run always carries one; still guard with `AgentError code "missing_model"`).
     - Composes instruction text: `spec.instructions`, plus a cwd line ("Operate only within `<spec.cwd>`; treat it as your working directory for every command and file operation."), plus for `sandbox: "read-only"` a no-writes line. Maps effort per Decision 9 and tool policy per Decision 8 (`toolPolicy: "all" | "no-edit"`).
     - Sends `runAgent` request: `{ callId, prompt, model, effort?, instructions?, toolPolicy, timeoutMs }` with `timeoutMs` 30 minutes (matches the runtime's stall watchdog ceiling; `waitForResponse` default of 10 minutes is too short for long agents).
     - Handles notifications: `agentThread { callId, threadID }` → `ctx.onProgress({ kind: "phase", phase: "amp-thread:" + threadID })`; optional `progress { callId, kind: "text"|"tool", ... }` events are forwarded when present (M4 may populate them; the worker must tolerate their absence).
     - On `ctx.signal` abort: sends `cancelAgent { callId }` notification, throws `AgentInterrupted`.
     - Response `{ text }` → if no `spec.schema`, resolve `{ text, status: "completed", usage: emptyUsage() }`.
     - If `spec.schema`: `assertValidSchema` first (mirror pi.ts, `AgentError code "invalid_schema"`), then a second `runAgent` request as the extraction turn — prompt built like `pi.ts`'s `extractionPrompt(spec, workingText)` (the schema JSON plus the working text, demanding a JSON-only answer), `toolPolicy: "no-edit"`, same model, effort `low`. Parse with `parseJsonLoose`; return `{ text: extraction.text, structured, status: "completed", usage: emptyUsage() }`. Corrective retry on validation failure stays in the runtime, which re-sends with amended instructions — this already works because the runtime funnels the retry through `spec.instructions`.
     - Map transport/RPC errors to `AgentError` (`code "transport"` retryable, `code "agent_failed"` with the server-provided message otherwise).
4. `src/worker/factory.ts`: `FactoryOpts.ampSocket?: string`; `case "amp": return new AmpWorker({ socket: this.opts.ampSocket })`.
5. `src/cli.ts`: plumb `OMEGACODE_AMP_SOCKET` into `FactoryOpts.ampSocket` exactly where `OMEGACODE_CODEX_APP_SERVER_SOCKET` is read today. Add `amp` to any provider-listing help text discovered there.
6. Tests, `test/amp-worker.test.ts` (node:test + tsx, like existing tests): an in-process `node:net` unix-socket fake server scripted per test (socket path under `fs.mkdtempSync(path.join(os.tmpdir(), "omegacode-amp-test-"))`). Cases: happy path (text turn; asserts instructions composition, effort mapping, `agentThread` → phase progress); schema path (two requests, second is extraction, `parseJsonLoose` result surfaced as `structured`); missing env → `no_socket`; abort → `cancelAgent` sent and `AgentInterrupted` thrown; server death mid-request → retryable transport `AgentError`; `ultra` → `max`.

### Milestone 2 — the Amp plugin and local end-to-end

Scope: after this milestone, in this repository, the Amp TUI can run a workflow end-to-end on `xai/grok-4.5` / `openai/gpt-5.6-sol` threads.

Edits:

1. New `.amp/plugins/omegacode.ts` (Bun process; `import type { PluginAPI } from '@ampcode/plugin'` — type-only, resolved by Amp's loader). Structure:
   - `export const description = 'Run omegacode workflows; each agent() becomes an Amp thread.'`
   - Default export registers:
     - Tool `omegacode_run_workflow` — inputSchema: `{ workflow: string (name or repo-relative path, required), args?: object, model?: string (default "xai/grok-4.5"), effort?: string (default "medium"), maxAgents?: number }`. `execute(input, ctx)`:
       - Resolve repo root from `amp.system.workspaceRoot` (via `amp.helpers.filePathFromURI`); fail with a clear message when null.
       - `mkdtemp` a socket dir; start a `node:net` server on `<dir>/rpc.sock` speaking NDJSON JSON-RPC with methods:
         - `runAgent`: build/cache an agent per `(model, effort, toolPolicy)` with `amp.createAgent({ name: 'omega-worker', model, reasoningEffort, instructions: <from request>, tools: toolPolicy === 'no-edit' ? { exclude: ['apply_patch','create_file','edit_file'] } : 'all', display: { label: 'omega', color: '#7c3aed' } })` (fall back to `amp.experimental.createAgent` if the top-level API is absent); `createThread({ parentThreadID: ctx.thread.id })`; notify `agentThread`; `appendUserMessage({ type: 'user-message', content: prompt })`; `await thread.waitForResponse({ timeoutMs })`; respond `{ text: <joined text blocks of the assistant message> }`. Track `callId → thread` for `cancelAgent` (→ `thread.cancel()`).
         - Errors are returned as JSON-RPC errors with the thrown message.
       - Spawn `Bun.spawn(['node', '<repoRoot>/dist/cli.js', 'run', input.workflow, '--provider', 'amp', '--model', model, ...effort/args/maxAgents flags], { cwd: repoRoot, env: { ...process.env, OMEGACODE_AMP_SOCKET: sockPath } })`. Before writing this call, read `src/cli.ts` to confirm the exact `run` flag names for model/effort/args (the implementer must not guess; `omegacode run --help` output is authoritative) and how the run id / result path appear on stdout, then capture stdout/stderr.
       - On child exit: close the server; return a receipt string — status, run id, each spawned thread as `https://ampcode.com/threads/<id>`, the workflow's result (stdout-derived, truncated to ~10 KB), and the run's journal directory path.
       - Cleanup: kill the child and close the server on execute-abort and in `amp.onDispose`.
     - Command `omegacode: run workflow` (palette): `ctx.ui.input` for the workflow name plus `ctx.ui.select({ allowOther: true })` over models `['xai/grok-4.5','openai/gpt-5.6-sol','openai/gpt-5.6-luna']`; then appends a user message to the active thread asking the agent to call `omegacode_run_workflow` with those parameters (keeps a single execution path through the tool).
   - The plugin must be dependency-free besides `@ampcode/plugin` types and Bun/Node builtins.
2. `tsconfig.json`: exclude `.amp/` from `pnpm typecheck` (Amp's loader owns plugin type-checking; the repo's tsc must not fail on `@ampcode/plugin` resolution). Verify `pnpm pack` file list is unaffected (`files` allowlist already excludes `.amp/`).
3. Docs: README section "Running inside Amp" — what loads where, default models, the usage-accounting caveat (Decision 5), and the read-only advisory caveat (Decision 8).

### Milestone 3 — orb enablement

Scope: after this milestone, an orb thread created from ampcode.com for this repository can run workflows the same way.

1. New executable `.agents/setup` (committed with the executable bit):

       #!/usr/bin/env bash
       set -euo pipefail
       pnpm install --frozen-lockfile
       pnpm build

2. Validation run in an orb (see Validation). Fix whatever the orb surfaces (likely candidates: node path resolution, workspaceRoot shape, build not present until setup runs).
3. AGENTS.md note describing the plugin and socket contract for future agents.

### Milestone 4 (optional, separate decision)

Viewer portal (`.amp/services.yaml` entry running `node dist/cli.js serve --port $PORT`) and richer progress (plugin polls `thread.messages()` during a run and forwards `tool` progress notifications).

## Concrete Steps

Working directory: repo root (`/Users/danielalnajjar/Code/omegacode`).

    pnpm typecheck
    pnpm test
    pnpm build

Expected after M1: all pass; new `test/amp-worker.test.ts` cases listed as passing in the `node --test` summary. Before M1 the new test file fails (provider missing) — that ordering proves the change.

Local E2E after M2 (needs the `amp` CLI signed in; verified installed, v0.0.1785529588):

    pnpm build
    amp
    # in the TUI: run "plugins: list" → omegacode plugin shown with 1 tool
    # prompt: Use omegacode_run_workflow to run examples/hello.workflow.js with model xai/grok-4.5

Expected: tool call visible in the transcript; receipt with run id + at least one `https://ampcode.com/threads/T-...` link; opening that link shows an `omega`-labeled thread on Grok 4.5 parented to the invoking thread.

Orb E2E after M3: from ampcode.com, create a new thread in an orb for this repository (or `amp -ox "..."` with the same prompt). Expected: same receipt; child threads visible in the dash; `amp sync <thread>` optionally mirrors `.omegacode`-adjacent artifacts locally.

## Validation and Acceptance

- Unit: `pnpm test` — every case in `test/amp-worker.test.ts` above passes; no existing test regresses.
- Static: `pnpm typecheck` and `pnpm build` clean; `pnpm pack --dry-run` file list unchanged apart from intended additions.
- Behavior (local): the Local E2E transcript above, including a schema workflow (e.g. a one-off workflow calling `agent(p, { schema })`) returning validated structured output.
- Behavior (orb): the Orb E2E above.
- Failure modes: running `node dist/cli.js run examples/hello.workflow.js --provider amp --model xai/grok-4.5` outside Amp prints the `no_socket` error verbatim and exits non-zero.

## Idempotence and Recovery

Socket paths are per-run temp dirs; re-running the tool never collides. The plugin kills its child and closes its server on abort, reload (`plugins: reload`), and dispose; a crashed plugin leaves at most a stale temp socket file, which a new run never reuses. omegacode's journal/resume machinery is untouched — an interrupted amp-lane run resumes like any other via `resumeFromRunId` semantics, re-running only unjournaled agents. All edits are additive; reverting is `git revert` of the milestone commits.

## Artifacts and Notes

Verified plugin-agent model catalog (2026-08-06, `amp plugins show-agent-options --json`, abridged): `xai/grok-4.5`, `xai/grok-build-0.1`, `openai/gpt-5.6-sol`, `openai/gpt-5.6-luna`, `openai/gpt-5.6-terra`, `openai/gpt-5.5`, `anthropic/claude-fable-5`, `anthropic/claude-opus-5`, `vertexai/gemini-3.5-flash`, `amp/glm-5.2`, ... Built-in tool names: `apply_patch, create_file, edit_file, find_thread, finder, librarian, oracle, painter, Read, read_mcp_resource, read_thread, read_web_page, shell_command, shell_command_status, skill, Task, view_media, web_search`.

Amp doc set snapshots used for this plan live in the session scratchpad (`amp-manual.md`, `amp-plugin-api.md`, `amp-orbs.md`, `amp-appendix.md`, `amp-plugins.md`, `amp-sdk.md`); they are not committed. Key upstream references: ampcode.com/manual#plugins, /manual/plugin-api, /manual/orbs.

Revision note (2026-08-06): Marked Milestone 1 complete, recorded the live runtime env-plumbing seam and resulting decision, and captured the M1 validation outcome; no Milestone 2 or later work was started.

## Interfaces and Dependencies

No new npm dependencies in omegacode (node:net + existing helpers). The plugin depends only on `@ampcode/plugin` types supplied by Amp's loader.

In `src/dsl/types.ts`:

    export const PROVIDER_IDS = ["codex", "claude-code", "opencode", "pi", "amp"] as const

In `src/worker/amp.ts`:

    export interface AmpWorkerOpts { socket?: string }
    export class AmpWorker implements Worker {
      readonly id: ProviderId // "amp"
      constructor(opts?: AmpWorkerOpts)
      runAgent(spec: AgentSpec, ctx: WorkerContext): Promise<AgentResult>
      shutdown(): Promise<void>
    }

Socket protocol (NDJSON JSON-RPC 2.0; client = AmpWorker, server = plugin):

    → request  "runAgent"    { callId: string, prompt: string, model: string,
                               effort?: "none"|"minimal"|"low"|"medium"|"high"|"xhigh"|"max",
                               instructions?: string, toolPolicy: "all"|"no-edit", timeoutMs: number }
    ← response               { text: string }
    ← notification "agentThread" { callId: string, threadID: string }
    ← notification "progress"    { callId: string, kind: "text"|"tool", ... }   // optional, tolerate absence
    → notification "cancelAgent" { callId: string }

Plugin tool input schema (`omegacode_run_workflow`): `{ workflow: string, args?: object, model?: string = "xai/grok-4.5", effort?: string = "medium", maxAgents?: number }`.

## Planning Notes (discovery-first receipts, compact)

Intent contract: goal — Amp's main agent can execute omegacode workflows with workers on `xai/grok-4.5` / `openai/gpt-5.6-*`, locally and in orbs; non-goals — publishing the plugin for other repos, Amp-as-provider-for-local-CLIs beyond this lane, viewer portal (optional M4); user-only decisions — none outstanding (models and direction fixed by the user 2026-08-06). Local exploration: one Explore-agent architecture survey of this repo plus lead rereads of `src/dsl/types.ts`, `src/worker/index.ts`, `src/worker/factory.ts`, schema/extraction call sites, and `package.json` (evidence-equivalent coverage; no unresolved gaps material to this design). Method discovery: Amp plugin API, orbs, CLI/SDK — resolved from live scrapes of the full ampcode.com manual set on 2026-08-06 plus the installed CLI's `show-agent-options` (versions: amp 0.0.1785529588; @ampcode/sdk 0.1.0-20260729105907 examined and rejected as the execution lane because it cannot select arbitrary models — modes only). Design pass: lead-authored; three integration shapes weighed (SDK subprocess, in-plugin embedding, socket bridge) → socket bridge chosen (Decisions 2–4). Lead review: seam signatures re-read against source rather than the survey; remaining risks are runtime behaviors only observable in E2E (waitForResponse long-turn behavior, orb node/pnpm state), each covered by an explicit validation step. Status: Draft.
