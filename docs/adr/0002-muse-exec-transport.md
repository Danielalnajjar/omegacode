# Run Muse workers through one-shot exec with private configuration

OmegaCode runs each Muse agent call through `muse exec --json`, using the existing subprocess JSONL helper for framing, stall detection, cancellation escalation, and spawn failures. Each attempt writes a fresh prompt file and starts a fresh process; Muse generates the session id because the measured CLI rejects `--session-id` together with `--no-session-log`. The SDK and an MSP `muse serve` host are rejected: this single-turn caller needs neither shared sessions nor a second process-lifetime owner.

Each call resolves the source configuration at `$XDG_CONFIG_HOME/muse`, or `~/.config/muse` when unset. When source `settings.json` exists, the call creates a private `<tmp>/xdg/muse` directory (0700), writes the settings (0600) with only the top-level `mcpServers` member removed, and symlinks every other source entry. Authentication is never copied, HOME is never overridden, and only the child receives the private XDG_CONFIG_HOME. Without source settings there is no override. The private directory and prompt are removed in `finally` only after the subprocess `closed` fence resolves, including SIGTERM-to-SIGKILL escalation on cancellation or stall. Transport rejection remains immediate; only cleanup awaits close, and cleanup failures do not replace the original run error. The Muse 1.2.1-R2847.1 spike measured zero broker clients with this configuration; workspace settings, permission profiles, agents overlays, environment flags, and defaults/policy documents did not provide usable per-run MCP isolation.

| OmegaCode sandbox | Muse behavior | Measured evidence |
| --- | --- | --- |
| read-only | `--disable-write --disable-shell` | R1 passed: read_file and search remained available for review. |
| workspace-write | Non-retryable `unsupported_sandbox`, before spawn | W1 failed: default sandbox plus approval-never allowed write_file outside the workspace. |
| danger-full-access | `--disable-sandbox --disable-approval` | Explicit unrestricted mode; not a confinement claim. |

Permission profiles are rejected: the accepted `:read-only` profile conflicts with the disable flags. Headless calls use approval-never, approval-judge off, no foreign personal context, no session log, disabled web tools, and automatic user-input resolution; they never trust the workspace implicitly.

| Terminal or process outcome | Classification |
| --- | --- |
| run.terminal.completed with terminal completed, string payload.text, and exit 0 | Success; payload.text is authoritative. |
| Conflicting second terminal, or completed terminal without string text | Non-retryable turn_failed. |
| Completed terminal followed by nonzero exit | Shared exitError classification. |
| Any other terminal value | Non-retryable turn_failed carrying payload.reason. |
| No terminal, own abort | AgentInterrupted. |
| No terminal, exit 0 | Non-retryable turn_incomplete. |
| No terminal, nonzero exit | Shared exitError classification. |
| Stall | Retryable turn_stalled, owned by the subprocess helper. |
| Missing executable | Non-retryable binary_not_found. |
| Unsupported sandbox or version | Non-retryable unsupported_sandbox or provider_outdated before the agent process starts. |

The exec stream emits no usage event, so results report the zero-valued `emptyUsage()` shape and emit no usage progress; downstream totals cannot distinguish unknown usage from zero. Structured output is requested in the prompt and parsed and validated locally; the runtime retains ownership of its single corrective schema attempt. The terminal mapping for auto-resolved `request_user_input` remains unverified because the probe answered normally. There is no Muse extraction turn or retry layer. Existing provider defaults, cache identity, and keys remain unchanged.
