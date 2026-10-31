// A remote agent from the run's side (ADR 0003): RemoteCheckout moves the run's commit and
// branches to the machine and the agent's commits back, and RemoteWorker runs the turn there
// behind the ordinary Worker interface, so the runtime's journal, schema, retry and event paths
// stay the local ones.

import { execFile } from "node:child_process"
import { createHash, randomBytes } from "node:crypto"
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { hostname, tmpdir } from "node:os"
import { basename, join, resolve } from "node:path"
import { promisify } from "node:util"
import type { AgentResult, AgentSpec, ProviderId } from "../dsl/types.js"
import { AgentError, AgentInterrupted, type PreparedAgentCall, type Worker, type WorkerContext } from "../worker/index.js"
import { RemoteConnectionError, RemoteReplyError, remoteCall, remoteCommandLine, type RemoteTransport } from "./client.js"
import { defaultMachineSources, MachineError, resolveMachines, type MachinePlan, type MachineSources, type RemoteMachine } from "./machines.js"
import { PROTOCOL_VERSION, type CollectReply, type HaveReply, type HelloReply, type PrepareReply, type RunReply } from "./protocol.js"

const exec = promisify(execFile)

/** Checkout transfer calls are bounded (and by the agent's deadline); a stuck one is a lost connection. */
const TRANSFER_TIMEOUT_MS = 10 * 60_000
const CLEANUP_TIMEOUT_MS = 2 * 60_000
const HELLO_TIMEOUT_MS = 30_000
/** How long an aborted `run` may take to report before its ssh is killed. */
const RUN_ABORT_GRACE_MS = 15_000
const ZERO_SHA = "0".repeat(40)

/**
 * Resolve the declared machines and prove each remote one answers `hello` in-band with this
 * protocol version and the host id it was chosen as. Runs before the first agent starts; every
 * problem is reported at once.
 */
export async function planMachines(names: string[], transport: RemoteTransport, sources: MachineSources = defaultMachineSources): Promise<MachinePlan> {
  const plan = await resolveMachines(names, sources)
  const problems: string[] = []
  await Promise.all(plan.remotes().map(async (machine) => {
    let hello: HelloReply
    try {
      hello = (await remoteCall({ machine, transport, command: "hello", request: {}, timeoutMs: HELLO_TIMEOUT_MS, abortGraceMs: 0, anyProtocol: true })) as HelloReply
    } catch (err) {
      problems.push(`machine ${machine.label} is unreachable as \`ssh ${machine.ssh}\` running \`${remoteCommandLine("hello")}\`: ${(err as Error).message}`)
      return
    }
    if (hello?.protocol !== PROTOCOL_VERSION) {
      problems.push(`machine ${machine.label} runs OmegaCode ${hello?.version ?? "unknown"} with remote protocol ${hello?.protocol}; this run needs protocol ${PROTOCOL_VERSION} — update OmegaCode there`)
    } else if (hello.hostId !== machine.hostId) {
      problems.push(`\`ssh ${machine.ssh}\` reaches BB machine ${hello.hostId ?? "(unknown host id)"}, not ${machine.label} (${machine.hostId}) — fix its "ssh" entry in the machine table`)
    }
  }))
  if (problems.length > 0) throw new MachineError(problems.join("; "))
  return plan
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 })
  return stdout.trim()
}

/**
 * One cache repository per source repository on each machine: its name, first root commit, and a
 * hash of this host and its Git directory, so two clones never fight over the cache's branches.
 */
export async function repoKey(gitRoot: string): Promise<string> {
  const roots = (await git(gitRoot, ["rev-list", "--max-parents=0", "HEAD"])).split("\n").sort()
  const commonDir = realpathSync(resolve(gitRoot, await git(gitRoot, ["rev-parse", "--git-common-dir"])))
  const source = createHash("sha256").update(`${hostname()}\0${commonDir}`).digest("hex").slice(0, 8)
  const name = basename(gitRoot).replace(/[^A-Za-z0-9._-]/g, "_").replace(/^[._-]+/, "") || "repo"
  return `${name}-${roots[0]!.slice(0, 12)}-${source}`
}

export interface LocalGitLock {
  <T>(fn: () => Promise<T>): Promise<T>
}

export interface RemoteCheckoutArgs {
  machine: RemoteMachine
  transport: RemoteTransport
  gitRoot: string
  runId: string
  index: number
  /** The local branch that receives the agent's commits. */
  branch: string
  /** Serializes this run's mutations of the local repository (the runtime's worktree mutex). */
  lock: LocalGitLock
}

export interface CollectResult {
  changed: boolean
  /** The local branch now holding the agent's commits (only when changed). */
  branch?: string
  head?: string
}

export class RemoteCheckout {
  private constructor(
    private readonly a: RemoteCheckoutArgs,
    readonly repoKey: string,
    /** This attempt's worktree name on the machine. */
    readonly name: string,
    readonly base: string,
    /** The local branch's tip when the agent started (ZERO_SHA when absent): the publish's expected old value. */
    private readonly expectedTip: string,
    readonly path: string,
  ) {}

  get branch(): string {
    return this.a.branch
  }

  get where(): string {
    return `${this.a.machine.label}:${this.path}`
  }

  /** Send the run's HEAD and branches to the machine and add this attempt's worktree there. */
  static async prepare(a: RemoteCheckoutArgs, signal: AbortSignal): Promise<RemoteCheckout> {
    // A fresh name per attempt: a worktree kept after a failed collection is never reused.
    const name = `${a.runId}-${a.index}-${randomBytes(3).toString("hex")}`
    const key = await repoKey(a.gitRoot)
    const call = (command: "have" | "prepare", request: unknown, payload?: Buffer) =>
      remoteCall({ machine: a.machine, transport: a.transport, command, request, payload, signal, timeoutMs: TRANSFER_TIMEOUT_MS, abortGraceMs: 0 })
    const { tips } = (await call("have", { repoKey: key })) as HaveReply
    const bundleRef = `refs/omegacode/xfer/${name}`
    const { base, branches, expectedTip, payload } = await a.lock(async () => {
      const base = await git(a.gitRoot, ["rev-parse", "HEAD"])
      const listed = await git(a.gitRoot, ["for-each-ref", "--format=%(objectname) %(refname:strip=2)", "refs/heads/"])
      const branches: Record<string, string> = {}
      for (const line of listed ? listed.split("\n") : []) {
        const space = line.indexOf(" ")
        branches[line.slice(space + 1)] = line.slice(0, space)
      }
      const expectedTip = branches[a.branch] ?? ZERO_SHA
      // Negate every tip the machine reported that this repository also has, so only missing
      // history travels. A tip unknown here is skipped; the bundle is then merely larger.
      const negatives: string[] = []
      for (const tip of tips) {
        if (/^[0-9a-f]{40,64}$/.test(tip) && await git(a.gitRoot, ["cat-file", "-e", `${tip}^{commit}`]).then(() => true, () => false)) negatives.push(`^${tip}`)
      }
      const dir = mkdtempSync(join(tmpdir(), "omegacode-bundle-"))
      try {
        await git(a.gitRoot, ["update-ref", bundleRef, base])
        const file = join(dir, "out.bundle")
        const created = await git(a.gitRoot, ["bundle", "create", "-q", file, "--branches", bundleRef, ...negatives]).then(() => true, (err: { stderr?: string }) => {
          // The machine already has every object; the branch manifest alone moves the names.
          if (String(err.stderr).includes("empty bundle")) return false
          throw err
        })
        return { base, branches, expectedTip, payload: created ? readFileSync(file) : undefined }
      } finally {
        await git(a.gitRoot, ["update-ref", "-d", bundleRef]).catch(() => {})
        rmSync(dir, { recursive: true, force: true })
      }
    })
    const prepared = (await call("prepare", {
      repoKey: key,
      name,
      base,
      branches,
      payloadBytes: payload?.length ?? 0,
      ...(payload ? { payloadSha256: createHash("sha256").update(payload).digest("hex") } : {}),
    }, payload)) as PrepareReply
    return new RemoteCheckout(a, key, name, base, expectedTip, prepared.path)
  }

  /**
   * Bring the agent's commits (and a snapshot commit of anything left uncommitted) into the local
   * repository on the agent's branch. Throws when they did not arrive intact or the branch moved.
   */
  async collect(signal: AbortSignal): Promise<CollectResult> {
    let bundle: Buffer | undefined
    const reply = (await remoteCall({
      machine: this.a.machine,
      transport: this.a.transport,
      command: "collect",
      request: { repoKey: this.repoKey, name: this.name, base: this.base, index: this.a.index },
      signal,
      timeoutMs: TRANSFER_TIMEOUT_MS,
      abortGraceMs: 0,
      onBytes: (bytes) => { bundle = bytes },
    })) as CollectReply
    if (!reply.changed) return { changed: false }
    if (!bundle || !reply.head || !reply.ref) throw new RemoteConnectionError(`${this.where} reported changes but sent no bundle`)
    const head = reply.head
    const ref = reply.ref
    await this.a.lock(async () => {
      const dir = mkdtempSync(join(tmpdir(), "omegacode-bundle-"))
      const incoming = `refs/omegacode/incoming/${this.name}`
      let published = false
      try {
        const file = join(dir, "in.bundle")
        writeFileSync(file, bundle!)
        await git(this.a.gitRoot, ["bundle", "verify", "-q", file])
        await git(this.a.gitRoot, ["fetch", "-q", "--no-tags", file, `+${ref}:${incoming}`])
        const fetched = await git(this.a.gitRoot, ["rev-parse", incoming])
        if (fetched !== head) throw new RemoteConnectionError(`${this.where} sent ${fetched}, expected ${head}`)
        const worktrees = await git(this.a.gitRoot, ["worktree", "list", "--porcelain"])
        if (worktrees.split("\n").includes(`branch refs/heads/${this.a.branch}`)) {
          throw new Error(`branch ${this.a.branch} is checked out in a local worktree; the agent's commits are kept at ${incoming}`)
        }
        // A collection that lost the deadline race must not publish after the failure is journaled.
        if (signal.aborted) throw new AgentInterrupted()
        // Compare-and-swap against the tip recorded when the agent started.
        await git(this.a.gitRoot, ["update-ref", `refs/heads/${this.a.branch}`, head, this.expectedTip]).catch(() => {
          throw new Error(`branch ${this.a.branch} moved while the agent ran; the agent's commits are kept at ${incoming}`)
        })
        published = true
      } finally {
        if (published) await git(this.a.gitRoot, ["update-ref", "-d", incoming]).catch(() => {})
        rmSync(dir, { recursive: true, force: true })
      }
    })
    return { changed: true, branch: this.a.branch, head }
  }

  async cleanup(): Promise<void> {
    await remoteCall({
      machine: this.a.machine,
      transport: this.a.transport,
      command: "cleanup",
      request: { repoKey: this.repoKey, name: this.name },
      timeoutMs: CLEANUP_TIMEOUT_MS,
    })
  }
}

export interface RemoteWorkerOpts {
  machine: RemoteMachine
  transport: RemoteTransport
  provider: ProviderId
  /** Worktree name on the machine, so a later collect can stop this run. */
  name: string
  fake: boolean
  claudeModel?: string
}

/** Runs each attempt as one `remote run` call on the machine. */
export class RemoteWorker implements Worker {
  readonly id: ProviderId
  constructor(private readonly o: RemoteWorkerOpts) {
    this.id = o.provider
  }

  async runAgent(spec: AgentSpec, ctx: WorkerContext): Promise<AgentResult> {
    if (ctx.signal.aborted) throw new AgentInterrupted()
    try {
      const reply = (await remoteCall({
        machine: this.o.machine,
        transport: this.o.transport,
        command: "run",
        request: { spec, name: this.o.name, fake: this.o.fake, ...(this.o.claudeModel ? { claudeModel: this.o.claudeModel } : {}) },
        signal: ctx.signal,
        abortGraceMs: RUN_ABORT_GRACE_MS,
        onProgress: ctx.onProgress,
      })) as RunReply
      if (!reply?.result || typeof reply.result.text !== "string") {
        throw new AgentError({ provider: this.id, code: "remote_protocol", message: `${this.o.machine.label} returned a malformed agent result` })
      }
      return reply.result
    } catch (err) {
      if (err instanceof RemoteReplyError) {
        if (err.interrupted) throw new AgentInterrupted(err.message)
        throw new AgentError({ provider: this.id, code: err.code, message: `${err.message} (on ${this.o.machine.label})`, retryable: err.retryable, usage: err.usage })
      }
      if (ctx.signal.aborted) throw new AgentInterrupted()
      if (err instanceof RemoteConnectionError) {
        throw new AgentError({ provider: this.id, code: "remote_connection_lost", message: err.message, retryable: false })
      }
      throw err
    }
  }

  /** A pinned profile is resolved on the machine, at each attempt (ADR 0003, Transport). */
  async prepareAgentCall(): Promise<PreparedAgentCall> {
    return (spec, ctx) => this.runAgent(spec, ctx)
  }

  async shutdown(): Promise<void> {}
}
