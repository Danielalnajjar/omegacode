// Machine names for agent({ machine }). A name resolves against Crew's machine table (host id,
// label or short label, case-insensitive) and the live BB machine list; the table entry's `ssh`
// field is how the run reaches it. Every machine a workflow declares is checked here before the
// first agent starts (see ADR 0003), so a typo or an offline machine never surfaces mid-run.

import { execFile } from "node:child_process"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import type { ProviderId } from "../dsl/types.js"

const exec = promisify(execFile)

export interface MachineEntry {
  hostId: string
  label: string
  shortLabel?: string
  /** BB provider ids this machine is set up for, when the table lists them. */
  providers?: string[]
  /** SSH destination (`user@host` or an ssh_config alias). Absent: the machine takes no remote agents. */
  ssh?: string
}

/** A validated machine other than the run's own. */
export interface RemoteMachine {
  hostId: string
  label: string
  ssh: string
  providers?: string[]
}

export interface LiveMachine {
  id: string
  name: string
  status: string
}

/** What resolution needs from the outside world. Tests replace every member. */
export interface MachineSources {
  tablePath(): string
  liveMachines(): Promise<LiveMachine[]>
  localHostId(): Promise<string | undefined>
}

export class MachineError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "MachineError"
  }
}

/** Crew's table: $OMEGACODE_MACHINE_TABLE, else the skills checkout's path on macOS, else on WSL. */
export function defaultTablePath(): string {
  const override = process.env.OMEGACODE_MACHINE_TABLE
  if (override) return override
  const tail = join("skills", "shared", "plugins", "crew", "src", "machines.json")
  const mac = join(homedir(), "Code", tail)
  if (existsSync(mac)) return mac
  return join(homedir(), "code", tail)
}

export function loadMachineTable(path: string): MachineEntry[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"))
  } catch (err) {
    throw new MachineError(`cannot read the machine table ${path}: ${(err as Error).message}`)
  }
  const machines = (parsed as { machines?: unknown })?.machines
  if (!Array.isArray(machines)) throw new MachineError(`machine table ${path} has no "machines" array`)
  return machines.filter((m): m is MachineEntry => typeof m?.hostId === "string" && typeof m?.label === "string")
}

function bbBin(): string {
  return process.env.BB_CLI || "bb"
}

async function bbJson(args: string[]): Promise<unknown> {
  const { stdout } = await exec(bbBin(), [...args, "--json"], { timeout: 20_000, maxBuffer: 8 * 1024 * 1024 })
  return JSON.parse(stdout)
}

export const defaultMachineSources: MachineSources = {
  tablePath: defaultTablePath,
  async liveMachines() {
    let value: unknown
    try {
      value = await bbJson(["machine", "list"])
    } catch (err) {
      throw new MachineError(`cannot read the live BB machine list (\`${bbBin()} machine list --json\`): ${firstLine(err)}`)
    }
    if (!Array.isArray(value)) throw new MachineError(`\`${bbBin()} machine list --json\` did not return a list`)
    return value.filter((m): m is LiveMachine => typeof m?.id === "string" && typeof m?.name === "string")
  },
  async localHostId() {
    // Inside a BB thread the environment names its host; outside one, the daemon's host-id file does.
    try {
      const status = await bbJson(["status"]) as { thread?: { environment?: { hostId?: unknown } } }
      const hostId = status?.thread?.environment?.hostId
      if (typeof hostId === "string" && hostId) return hostId
    } catch {
      // fall through to the host-id files
    }
    const candidates = [join(homedir(), ".bb", "host-id")]
    const machinesDir = join(homedir(), ".bb-machines")
    if (existsSync(machinesDir)) {
      for (const name of readdirSync(machinesDir)) candidates.push(join(machinesDir, name, "host-id"))
    }
    for (const file of candidates) {
      try {
        const id = readFileSync(file, "utf8").trim()
        if (id) return id
      } catch {
        // next candidate
      }
    }
    return undefined
  },
}

function matches(entry: MachineEntry, name: string): boolean {
  const n = name.trim().toLowerCase()
  return [entry.hostId, entry.label, entry.shortLabel].some((v) => v !== undefined && v.toLowerCase() === n)
}

/**
 * The machines a run may place agents on. `resolve(name)` answers "local" for the run's own
 * machine, the RemoteMachine for a validated other machine, and throws for anything undeclared.
 */
export class MachinePlan {
  constructor(
    private readonly byName: Map<string, RemoteMachine | "local">,
  ) {}

  static empty(): MachinePlan {
    return new MachinePlan(new Map())
  }

  resolve(name: string): RemoteMachine | "local" {
    const found = this.byName.get(name.trim().toLowerCase())
    if (found === undefined) {
      const declared = [...this.byName.keys()]
      throw new MachineError(
        `machine "${name}" is not declared in meta.machines${declared.length ? ` (declared: ${declared.join(", ")})` : ""} — declare every machine the workflow uses so the run can check it before any agent starts`,
      )
    }
    return found
  }

  remotes(): RemoteMachine[] {
    const seen = new Map<string, RemoteMachine>()
    for (const m of this.byName.values()) if (m !== "local") seen.set(m.hostId, m)
    return [...seen.values()]
  }
}

/**
 * Resolve every declared name against the table and the live BB list. Throws one MachineError
 * listing every problem, so a run with two bad names reports both at once.
 */
export async function resolveMachines(names: string[], sources: MachineSources = defaultMachineSources): Promise<MachinePlan> {
  if (names.length === 0) return MachinePlan.empty()
  const tablePath = sources.tablePath()
  const table = loadMachineTable(tablePath)
  const [live, localId] = await Promise.all([sources.liveMachines(), sources.localHostId()])
  if (!localId) throw new MachineError("cannot tell which BB machine this run is on (no hostId from `bb status --json` and no ~/.bb/host-id or ~/.bb-machines/*/host-id)")
  const problems: string[] = []
  const byName = new Map<string, RemoteMachine | "local">()
  for (const name of names) {
    // A BB machine name (from `bb machine list`) may differ from the table label; accept either.
    const liveHit = live.find((m) => m.id.toLowerCase() === name.trim().toLowerCase() || m.name.toLowerCase() === name.trim().toLowerCase())
    const entry = table.find((e) => matches(e, name)) ?? (liveHit ? table.find((e) => e.hostId === liveHit.id) : undefined)
    if (!entry) {
      const known = table.map((e) => [e.label, e.shortLabel].filter(Boolean).join("/")).join(", ")
      problems.push(`machine "${name}" is not in the machine table ${tablePath} (known: ${known})`)
      continue
    }
    if (entry.hostId === localId) {
      byName.set(name.trim().toLowerCase(), "local")
      continue
    }
    const liveEntry = live.find((m) => m.id === entry.hostId)
    if (!liveEntry) {
      problems.push(`machine "${name}" (${entry.label}, ${entry.hostId}) is not in the live BB machine list`)
      continue
    }
    if (liveEntry.status !== "connected") {
      problems.push(`machine "${name}" (${entry.label}) is ${liveEntry.status} in BB, not connected`)
      continue
    }
    if (!entry.ssh) {
      problems.push(`machine "${name}" (${entry.label}) has no "ssh" target in ${tablePath}, so it cannot run remote agents`)
      continue
    }
    byName.set(name.trim().toLowerCase(), { hostId: entry.hostId, label: entry.label, ssh: entry.ssh, ...(entry.providers ? { providers: entry.providers } : {}) })
  }
  if (problems.length > 0) throw new MachineError(problems.join("; "))
  return new MachinePlan(byName)
}

/** Codex and Claude Code are BB providers too; when the table lists a machine's providers, honor it. */
export function providerUnavailable(machine: RemoteMachine, provider: ProviderId): string | undefined {
  if (provider !== "codex" && provider !== "claude-code") return undefined
  if (!machine.providers || machine.providers.includes(provider)) return undefined
  return `machine ${machine.label} is not set up for ${provider} (the machine table lists ${machine.providers.join(", ")})`
}

function firstLine(err: unknown): string {
  const e = err as { stderr?: string; message?: string }
  const text = (e.stderr && e.stderr.trim()) || e.message || String(err)
  return text.split("\n")[0]!
}
