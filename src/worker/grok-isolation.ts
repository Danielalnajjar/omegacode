import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { isAbsolute, join } from "node:path"
import { canonical, inside, SYSTEM_ROOTS } from "./isolation-paths.js"

export interface GrokIsolation {
  schemaVersion: "grok-isolation.v1"
  /** Canonical grok binary. Seatbelt identifies the API parent by this exact process path. */
  grokExecutable: string
  /** Signed-in Grok state. Readable and writable by the grok process only, never by its tools. */
  grokHome: string
  /** Fresh HOME inside scratch, so no user-level skills, rules, hooks or MCP servers are discovered. */
  home: string
  /** Must not contain hard links to files outside the writable roots: path checks and Seatbelt cannot see a shared inode. */
  workspace: string
  inputs: string
  scratch: string
  readRoots: string[]
  blockedRoots: string[]
  writable: boolean
}

/** Every file operation goes through the confined shell; Grok's in-process file tools are removed. */
export const GROK_ISOLATED_TOOLS = ["run_terminal_command", "todo_write"]
export const GROK_REMOVED_TOOLS = [
  "get_command_or_subagent_output", "kill_command_or_subagent", "wait_commands_or_subagents", "read_file", "search_replace", "list_dir", "grep", "write", "spawn_subagent", "scheduler_create", "scheduler_delete",
  "scheduler_list", "monitor", "search_tool", "use_tool", "workflow", "enter_plan_mode", "exit_plan_mode",
  "ask_user_question", "image_gen", "image_edit", "image_to_video", "reference_to_video", "web_search", "web_fetch",
]
// Homebrew tools and their dylibs, as in a normal developer shell. Its var/
// tree holds service state and logs, so it stays unreadable.
const HOMEBREW = "/opt/homebrew"
const HOMEBREW_STATE = "/opt/homebrew/var"
// Grok snapshots a login shell, where path_helper appends Homebrew after the
// xcrun shims in /usr/bin. Those shims cannot run confined (xcodebuild needs
// Mach services), so Homebrew goes first, which is what `brew shellenv` does.
const SHELL_PROFILE = "# OmegaCode Grok isolation: Homebrew first, as `brew shellenv` does.\nexport PATH=\"/opt/homebrew/bin:/opt/homebrew/sbin:$PATH\"\n"
export function loadGrokIsolation(path: string, cwd?: string): GrokIsolation {
  const value = JSON.parse(readFileSync(path, "utf8")) as GrokIsolation
  if (value.schemaVersion !== "grok-isolation.v1" || typeof value.writable !== "boolean" ||
      !Array.isArray(value.readRoots) || !Array.isArray(value.blockedRoots)) throw new Error("Invalid Grok isolation configuration")
  for (const root of [value.grokExecutable, value.grokHome, value.home, value.workspace, value.inputs, value.scratch, ...value.readRoots, ...value.blockedRoots]) {
    if (typeof root !== "string" || !isAbsolute(root) || /[\n\r\0"\\]/.test(root) || canonical(root) !== root || root === "/") throw new Error("Isolation roots must be canonical absolute paths")
  }
  if (cwd && canonical(cwd) !== value.workspace) throw new Error("Isolation workspace differs from worker cwd")
  if ([value.workspace, value.inputs].some(root => inside(value.scratch, root) || inside(root, value.scratch))) throw new Error("Isolation scratch must be separate")
  if ([...value.readRoots, value.inputs].some(readRoot => [value.workspace, value.scratch].some(writableRoot => inside(readRoot, writableRoot) || inside(writableRoot, readRoot)))) throw new Error("Isolation readRoots and inputs must be separate from writable roots")
  if (!inside(value.home, value.scratch)) throw new Error("Isolated HOME must live in scratch")
  if ([value.workspace, value.inputs, value.scratch, ...value.readRoots].some(root => inside(root, value.grokHome) || inside(value.grokHome, root))) throw new Error("Grok home must be separate from tool-readable roots")
  return value
}

// One profile, two subjects. The grok process keeps provider network and its
// home; every other process (the shell tool and its descendants) gets the
// allowlisted filesystem, no network, no Mach services and cannot exec grok.
// Nested Seatbelt is refused by macOS, so Grok's own --sandbox stays off.
export function grokSeatbeltProfile(config: GrokIsolation, agentProfile: string): string {
  const q = JSON.stringify
  const grok = `(process-path ${q(config.grokExecutable)})`
  const tool = `(require-not ${grok})`
  const subpaths = (roots: string[]) => roots.map(root => `(subpath ${q(root)})`).join(" ")
  const except = (roots: string[]) => roots.map(root => `(require-not (subpath ${q(root)}))`).join(" ")
  const toolRead = [...SYSTEM_ROOTS, HOMEBREW, config.workspace, config.inputs, config.scratch, ...config.readRoots]
  const toolWrite = [config.scratch, ...(config.writable ? [config.workspace] : [])]
  const grokRead = [config.grokHome, config.workspace, config.inputs, config.scratch, ...config.readRoots]
  const grokWrite = [config.grokHome, config.scratch, ...(config.writable ? [config.workspace] : [])]
  return [
    "(version 1)", "(allow default)",
    `(deny network* ${tool})`, `(deny mach-lookup ${tool})`,
    `(deny process-info* (require-all ${tool} (require-not (target self))))`,
    `(deny signal (require-all ${tool} (require-not (target same-sandbox))))`,
    `(deny process-exec (require-all (literal ${q(config.grokExecutable)}) (require-not (process-path "/usr/bin/sandbox-exec"))))`,
    `(deny file-read* (require-all ${tool} ${except(toolRead)}))`,
    `(deny file-read* (require-all ${tool} (subpath ${q(HOMEBREW_STATE)})))`,
    // Grok unpacks its platform skills into the home on first use; keep them undiscoverable.
    `(deny file-read* (require-all ${grok} (subpath ${q(join(config.grokHome, "bundled", "skills"))})))`,
    `(deny file-read* (require-all ${grok} (require-any ${subpaths(config.blockedRoots)}) ${except(grokRead)} (require-not (literal ${q(config.grokExecutable)})) (require-not (literal ${q(agentProfile)}))))`,
    "(allow file-read-metadata)", "(allow file-read* (literal \"/\"))",
    `(deny file-write* (require-all ${tool} (require-not (literal "/dev/null")) ${except(toolWrite)}))`,
    `(deny file-write* (require-all ${grok} (require-any ${subpaths(config.blockedRoots)}) ${except(grokWrite)}))`,
  ].join("\n")
}

/** The login-shell profile of the fresh HOME; rewritten before every launch. */
export function prepareGrokShellHome(config: GrokIsolation): void {
  mkdirSync(config.home, { recursive: true, mode: 0o700 })
  writeFileSync(join(config.home, ".bash_profile"), SHELL_PROFILE, { mode: 0o600 })
}

/** A constructed environment: nothing from the orchestrator (credentials, sockets, host HOME) is inherited. */
export function isolatedGrokEnv(config: GrokIsolation): NodeJS.ProcessEnv {
  return {
    PATH: "/usr/bin:/bin", HOME: config.home, TMPDIR: config.scratch, GROK_HOME: config.grokHome, SHELL: "/bin/bash",
    LANG: "en_US.UTF-8", GROK_DISABLE_AUTOUPDATER: "1",
    ...(process.env.USER ? { USER: process.env.USER, LOGNAME: process.env.USER } : {}),
  }
}

export function isolatedGrokLaunch(config: GrokIsolation, agentProfile: string): { bin: string; prefix: string[]; env: NodeJS.ProcessEnv } {
  return { bin: "/usr/bin/sandbox-exec", prefix: ["-p", grokSeatbeltProfile(config, agentProfile), config.grokExecutable], env: isolatedGrokEnv(config) }
}

/** Grok applies --disallowed-tools only beside a non-empty --tools allowlist; `--tools ""` means
 *  unrestricted and re-adds the shell and spawn_subagent. The tool-less extraction turn therefore
 *  keeps only the inert todo_write. */
export const GROK_EXTRACTION_TOOLS = ["todo_write"]
export function isolatedGrokToolArgs(noTools: boolean): string[] {
  const allowed = noTools ? GROK_EXTRACTION_TOOLS : GROK_ISOLATED_TOOLS
  return ["--no-memory", "--disable-web-search", "--tools", allowed.join(","),
    "--disallowed-tools", [...GROK_REMOVED_TOOLS, ...GROK_ISOLATED_TOOLS.filter(tool => !allowed.includes(tool))].join(",")]
}
