# omegacode — agent guidance

Build: `pnpm build` (tsup + viewer). Test: `pnpm test` (node:test via tsx). Typecheck: `pnpm typecheck`. Node >= 20, pnpm 11. Never use npm.

## Running inside Amp

This repo ships an Amp project plugin, `.amp/plugins/omegacode.ts`, exposing the `omegacode_run_workflow` tool. It spawns `node dist/cli.js run <workflow> --provider amp --model <amp model> --sandbox danger-full-access --json --start-json --no-serve` with `OMEGACODE_AMP_SOCKET` pointing at a per-run unix socket, and serves that socket by turning each workflow `agent()` call into a child Amp thread (default model `xai/grok-4.5`). The wire protocol lives in `src/worker/amp.ts` (client) and the plugin (server); it is documented in `plans/omegacode-amp-plugin.md` §Interfaces and Dependencies. `dist/` must exist first — in orbs, `.agents/setup` handles install + build.

The amp provider is full-access-only and fails closed: Amp offers plugin threads no OS-level sandbox, so `read-only`/`workspace-write` are rejected instead of simulated, and child threads are created with the full Amp tool set. `--start-json` gives the plugin the runId/runDir on stderr at launch, so an aborted or crashed run still gets an identified receipt with a `--resume` line.

Headless `amp -x` cannot create plugin child threads; use the interactive TUI or an orb thread. Amp-lane turns report zero token usage to omegacode's `budget` (Amp does not expose usage to plugins), so a `--budget` ceiling never fires on amp work; costs appear per-thread in the Amp dashboard instead.
