// The remote side: `omegacode remote <command>`, started over SSH by a run on another machine
// (ADR 0003). It owns this machine's cache repositories and worktrees under
// <OMEGACODE_HOME>/remote, and runs agents with this machine's own workers, logins and config.
// Everything it prints to stdout is a protocol line; diagnostics go to stderr.

import { execFile, spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { dataRoot } from "../runtime/journal.js"
import { DefaultWorkerFactory } from "../worker/factory.js"
import { AgentError, AgentInterrupted, type WorkerFactory, type WorkerProgress } from "../worker/index.js"
import { defaultMachineSources } from "./machines.js"
import {
  FrameReader,
  parseReplyLine,
  PROTOCOL_VERSION,
  REMOTE_COMMANDS,
  type CleanupRequest,
  type CollectReply,
  type CollectRequest,
  type HaveReply,
  type HaveRequest,
  type HelloReply,
  type PrepareReply,
  type PrepareRequest,
  type RemoteCommand,
  type ReplyBody,
  type ReplyLine,
  type RunReply,
  type RunRequest,
} from "./protocol.js"

const exec = promisify(execFile)

/** Most negotiation tips `have` returns. More only make the bundle smaller. */
const MAX_TIPS = 1000
const LOCK_WAIT_MS = 120_000
const LOCK_STALE_MS = 10 * 60_000
/** How long an aborted runner may take to stop before its process group is killed. */
const STOP_GRACE_MS = 5_000
/** How long `collect`/`cleanup` wait for a recorded supervisor before killing its group. */
const SUPERVISOR_GRACE_MS = 15_000
/** Set in the runner child that the `run` supervisor starts. */
const RUNNER_ENV = "OMEGACODE_REMOTE_RUNNER"

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/

export function remoteRoot(): string {
  return join(dataRoot(), "remote")
}

function repoPath(repoKey: string): string {
  return join(remoteRoot(), "repos", `${repoKey}.git`)
}

function worktreePath(name: string): string {
  return join(remoteRoot(), "worktrees", name)
}

function pidPath(name: string): string {
  return join(remoteRoot(), "worktrees", `${name}.pid`)
}

/** The internal branch a remote worktree is on; the run's branch name applies only locally. */
function internalBranch(name: string): string {
  return `omegacode/${name}`
}

class HelperError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
  }
}

async function git(cwd: string, args: string[], input?: string): Promise<string> {
  try {
    const run = exec("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 })
    if (input !== undefined) run.child.stdin?.end(input)
    const { stdout } = await run
    return stdout.trim()
  } catch (err) {
    const e = err as { stderr?: string; message: string }
    throw new HelperError("git_failed", `git ${args[0]} failed in ${cwd}: ${(e.stderr || e.message).trim()}`)
  }
}

function requireSafe(field: string, value: unknown, pattern: RegExp): string {
  if (typeof value !== "string" || !pattern.test(value)) throw new HelperError("bad_request", `invalid ${field}: ${JSON.stringify(value)}`)
  return value
}

/** Serialize repository mutations across concurrent helpers (several agents, or several runs). */
async function withRepoLock<T>(repoKey: string, fn: () => Promise<T>): Promise<T> {
  mkdirSync(join(remoteRoot(), "locks"), { recursive: true })
  const lock = join(remoteRoot(), "locks", `${repoKey}.lock`)
  const started = Date.now()
  for (;;) {
    try {
      mkdirSync(lock)
      break
    } catch {
      try {
        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) rmSync(lock, { recursive: true, force: true })
      } catch {
        // raced with its release
      }
      if (Date.now() - started > LOCK_WAIT_MS) throw new HelperError("lock_timeout", `timed out waiting for ${lock}`)
      await new Promise((r) => setTimeout(r, 200))
    }
  }
  try {
    return await fn()
  } finally {
    rmSync(lock, { recursive: true, force: true })
  }
}

function packageVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  for (const candidate of [join(here, "..", "package.json"), join(here, "..", "..", "package.json")]) {
    try {
      const pkg = JSON.parse(readFileSync(candidate, "utf8")) as { name?: string; version?: string }
      if (pkg.name === "omegacode" && pkg.version) return pkg.version
    } catch {
      // next candidate
    }
  }
  return "unknown"
}

async function hasCommit(repo: string, sha: string): Promise<boolean> {
  return exec("git", ["cat-file", "-e", `${sha}^{commit}`], { cwd: repo }).then(() => true, () => false)
}

async function have(req: HaveRequest): Promise<HaveReply> {
  const repo = repoPath(requireSafe("repoKey", req.repoKey, SAFE_NAME))
  if (!existsSync(join(repo, "HEAD"))) return { tips: [] }
  const out = await git(repo, ["for-each-ref", "--sort=-committerdate", "--format=%(objectname)", "refs/heads/", "refs/omegacode/have/"])
  return { tips: [...new Set(out ? out.split("\n") : [])].slice(0, MAX_TIPS) }
}

async function prepare(req: PrepareRequest, payload: Buffer, signal: AbortSignal): Promise<PrepareReply> {
  const repoKey = requireSafe("repoKey", req.repoKey, SAFE_NAME)
  const name = requireSafe("name", req.name, SAFE_NAME)
  const base = requireSafe("base", req.base, SHA)
  if (!Number.isSafeInteger(req.generation) || req.generation <= 0) throw new HelperError("bad_request", `invalid generation: ${JSON.stringify(req.generation)}`)
  const branches = Object.entries(req.branches ?? {})
  for (const [branch, sha] of branches) {
    requireSafe("branch commit", sha, SHA)
    // Branch names come from `git for-each-ref refs/heads` on the run's side; refuse anything else.
    if (typeof branch !== "string" || !branch || branch.startsWith("-") || branch.includes("..") || /[\s~^:?*[\\]/.test(branch)) {
      throw new HelperError("bad_request", `invalid branch name: ${JSON.stringify(branch)}`)
    }
  }
  if (payload.length > 0 && createHash("sha256").update(payload).digest("hex") !== req.payloadSha256) {
    throw new HelperError("transfer_corrupt", "the checkout bundle failed its integrity check")
  }
  const path = worktreePath(name)
  if (existsSync(path)) throw new HelperError("bad_request", `remote worktree ${path} already exists`)
  await withRepoLock(repoKey, async () => {
    const repo = repoPath(repoKey)
    if (!existsSync(join(repo, "HEAD"))) {
      mkdirSync(repo, { recursive: true })
      await git(repo, ["init", "--bare", "-q"])
    }
    if (payload.length > 0) {
      const file = join(remoteRoot(), "worktrees", `${name}.in.bundle`)
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, payload)
      try {
        // Objects only: the bundle's refs land in a scratch namespace, the manifest sets the names.
        await git(repo, ["fetch", "-q", "--no-tags", file, `+refs/*:refs/omegacode/xfer/${name}/*`])
      } finally {
        rmSync(file, { force: true })
        const scratch = await git(repo, ["for-each-ref", "--format=delete %(refname)", `refs/omegacode/xfer/${name}/`]).catch(() => "")
        if (scratch) await git(repo, ["update-ref", "--stdin"], scratch + "\n").catch(() => {})
      }
    }
    for (const sha of [base, ...branches.map(([, s]) => s)]) {
      if (!(await hasCommit(repo, sha))) throw new HelperError("base_missing", `commit ${sha} is not in ${repo} after the transfer`)
    }
    const updates = [`update refs/omegacode/have/${base} ${base}`]
    // Mirror the run's branches so later agents can name earlier agents' branches, but only from
    // a newer snapshot than the last one applied: a delayed older prepare must not rewind or
    // delete a branch a running agent already reads. Branches checked out by live worktrees
    // (the internal omegacode/* ones, or any an agent switched to) are never touched.
    const applied = Number(await git(repo, ["config", "--get", "omegacode.generation"]).catch(() => "0"))
    if (req.generation > applied) {
      await git(repo, ["worktree", "prune"]).catch(() => {})
      const listing = await git(repo, ["worktree", "list", "--porcelain"])
      const checkedOut = new Set(listing.split("\n").filter((l) => l.startsWith("branch refs/heads/")).map((l) => l.slice("branch refs/heads/".length)))
      const keep = (branch: string): boolean => branch.startsWith("omegacode/") || checkedOut.has(branch)
      const wanted = new Map(branches.filter(([branch]) => !keep(branch)))
      const current = await git(repo, ["for-each-ref", "--format=%(refname:strip=2)", "refs/heads/"])
      for (const branch of current ? current.split("\n") : []) {
        if (!keep(branch) && !wanted.has(branch)) updates.push(`delete refs/heads/${branch}`)
      }
      for (const [branch, sha] of wanted) updates.push(`update refs/heads/${branch} ${sha}`)
    }
    await git(repo, ["update-ref", "--stdin"], updates.join("\n") + "\n")
    if (req.generation > applied) await git(repo, ["config", "omegacode.generation", String(req.generation)])
    // The run gave up (its ssh closed our stdin): add no worktree it cannot clean up.
    if (signal.aborted) throw new HelperError("interrupted", "prepare was abandoned by the run")
    mkdirSync(dirname(path), { recursive: true })
    await git(repo, ["worktree", "add", "-q", "-b", internalBranch(name), path, base])
    if (signal.aborted) {
      await git(repo, ["worktree", "remove", "--force", path]).catch(() => {})
      await git(repo, ["branch", "-D", internalBranch(name)]).catch(() => {})
      throw new HelperError("interrupted", "prepare was abandoned by the run")
    }
  })
  return { path }
}

interface RunRecord {
  supervisor: number
  group?: number
}

function alive(pid: number, group = false): boolean {
  try {
    process.kill(group ? -pid : pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM"
  }
}

async function waitGone(pid: number, group: boolean, ms: number): Promise<boolean> {
  const until = Date.now() + ms
  while (alive(pid, group)) {
    if (Date.now() >= until) return false
    await new Promise((r) => setTimeout(r, 100))
  }
  return true
}

/** Stop a run still recorded for this worktree (a timed-out or disconnected agent). */
async function stopRecordedRun(name: string): Promise<void> {
  let record: RunRecord
  try {
    record = JSON.parse(readFileSync(pidPath(name), "utf8")) as RunRecord
  } catch {
    return
  }
  const { supervisor, group } = record
  if (Number.isInteger(supervisor) && supervisor > 1 && supervisor !== process.pid && alive(supervisor)) {
    // The supervisor stops its own group on SIGTERM; give it that chance first.
    process.kill(supervisor, "SIGTERM")
    if (!(await waitGone(supervisor, false, SUPERVISOR_GRACE_MS))) process.kill(supervisor, "SIGKILL")
  }
  if (group !== undefined && Number.isInteger(group) && group > 1 && alive(group, true)) {
    process.kill(-group, "SIGKILL")
    if (!(await waitGone(group, true, STOP_GRACE_MS))) {
      throw new HelperError("still_running", `processes of the agent in ${worktreePath(name)} did not stop; the worktree is kept`)
    }
  }
  rmSync(pidPath(name), { force: true })
}

async function collect(req: CollectRequest, send: (line: ReplyBody, bytes?: Buffer) => void): Promise<CollectReply> {
  const repoKey = requireSafe("repoKey", req.repoKey, SAFE_NAME)
  const name = requireSafe("name", req.name, SAFE_NAME)
  const base = requireSafe("base", req.base, SHA)
  const path = worktreePath(name)
  if (!existsSync(path)) throw new HelperError("worktree_missing", `remote worktree ${path} does not exist`)
  await stopRecordedRun(name)
  let snapshot = false
  if ((await git(path, ["status", "--porcelain"])).length > 0) {
    await git(path, ["add", "-A"])
    await git(path, [
      "-c", "user.name=OmegaCode", "-c", "user.email=omegacode@localhost", "-c", "commit.gpgsign=false",
      "commit", "-q", "--no-verify", "-m", `omegacode: uncommitted changes left by agent ${req.index}`,
    ])
    snapshot = true
  }
  const head = await git(path, ["rev-parse", "HEAD"])
  const ahead = await git(path, ["rev-list", "--count", `${base}..${head}`])
  if (ahead === "0") return { changed: false, head }
  const ref = `refs/omegacode/out/${name}`
  const file = join(remoteRoot(), "worktrees", `${name}.out.bundle`)
  await withRepoLock(repoKey, async () => {
    await git(path, ["update-ref", ref, head])
    await git(path, ["bundle", "create", "-q", file, ref, `^${base}`])
  })
  try {
    const bytes = readFileSync(file)
    send({ t: "bytes", bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }, bytes)
  } finally {
    rmSync(file, { force: true })
  }
  return { changed: true, head, ref, snapshot }
}

async function cleanup(req: CleanupRequest): Promise<Record<string, never>> {
  const repoKey = requireSafe("repoKey", req.repoKey, SAFE_NAME)
  const name = requireSafe("name", req.name, SAFE_NAME)
  await stopRecordedRun(name)
  const repo = repoPath(repoKey)
  const path = worktreePath(name)
  await withRepoLock(repoKey, async () => {
    if (!existsSync(join(repo, "HEAD"))) return
    await git(repo, ["worktree", "remove", "--force", path]).catch(() => {})
    if (existsSync(path)) rmSync(path, { recursive: true, force: true })
    await git(repo, ["worktree", "prune"]).catch(() => {})
    await git(repo, ["branch", "-D", internalBranch(name)]).catch(() => {})
    await git(repo, ["update-ref", "-d", `refs/omegacode/out/${name}`]).catch(() => {})
  })
  return {}
}

/** Builds this machine's workers for one `run`. Tests substitute a scripted one. */
export type RemoteFactory = (req: RunRequest) => WorkerFactory

const defaultRemoteFactory: RemoteFactory = (req) => new DefaultWorkerFactory({
  fake: req.fake,
  claudeModel: req.claudeModel,
  codexBin: process.env.CODEX_BIN,
  opencodeBin: process.env.OPENCODE_BIN,
  piBin: process.env.PI_BIN,
  museBin: process.env.MUSE_BIN,
  grokBin: process.env.GROK_BIN,
})

function checkRunRequest(req: RunRequest): string {
  const name = requireSafe("name", req.name, SAFE_NAME)
  if (!req.spec || req.spec.cwd !== worktreePath(name)) {
    throw new HelperError("bad_request", `run must target this machine's worktree ${worktreePath(name)}`)
  }
  return name
}

/** The runner child: run the turn with this machine's workers. */
async function runTurn(req: RunRequest, abort: AbortController, send: (line: ReplyBody) => void, makeFactory: RemoteFactory): Promise<RunReply> {
  checkRunRequest(req)
  const spec = req.spec
  const factory = makeFactory(req)
  try {
    const worker = factory.get(spec.provider, spec.serviceTier, spec.codexExecutionProfile)
    const ctx = {
      signal: abort.signal,
      onProgress: (e: WorkerProgress) => send({ t: "progress", e }),
    }
    let call = (s: typeof spec, c: typeof ctx) => worker.runAgent(s, c)
    if (spec.claudeProfile !== undefined) {
      if (!worker.prepareAgentCall) throw new AgentError({ provider: spec.provider, code: "claude_profile_unavailable", message: `Claude profile ${spec.claudeProfile} cannot be prepared by this worker; no fallback occurred` })
      call = await worker.prepareAgentCall(spec, ctx)
    }
    return { result: await call(spec, ctx) }
  } finally {
    await factory.shutdownAll()
  }
}

/**
 * The `run` supervisor: start the runner in its own process group, relay its progress, and write
 * the terminal line only after every process in that group has exited (ADR 0003, Stopping).
 */
async function supervise(req: RunRequest, abort: AbortController, send: (line: ReplyBody) => void): Promise<ReplyBody> {
  const name = checkRunRequest(req)
  const child = spawn(process.execPath, [...process.execArgv, ...process.argv.slice(1)], {
    detached: true,
    stdio: ["pipe", "pipe", "inherit"],
    env: { ...process.env, [RUNNER_ENV]: "1" },
  })
  const group = child.pid
  writeFileSync(pidPath(name), JSON.stringify({ supervisor: process.pid, ...(group ? { group } : {}) } satisfies RunRecord))
  let terminal: ReplyBody | undefined
  const reader = new FrameReader(
    (line) => {
      const msg = parseReplyLine(line)
      if (!msg) return
      if (msg.t === "progress") send({ t: "progress", e: msg.e })
      else if (msg.t === "done" || msg.t === "error") terminal = stripTag(msg)
    },
    () => {},
  )
  child.stdout.on("data", (chunk: Buffer) => reader.push(chunk))
  child.stdin.on("error", () => {})
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()))
  child.stdin.write(JSON.stringify(req) + "\n")
  const stop = async (): Promise<void> => {
    try {
      child.stdin.end(JSON.stringify({ t: "abort" }) + "\n")
    } catch {
      // already closed
    }
    if (group && !(await waitGone(group, true, STOP_GRACE_MS))) {
      try {
        process.kill(-group, "SIGKILL")
      } catch {
        // gone between the check and the kill
      }
    }
  }
  if (abort.signal.aborted) void stop()
  else abort.signal.addEventListener("abort", () => void stop(), { once: true })
  await closed
  // The runner's own exit is not enough: anything it started must be gone too.
  if (group && alive(group, true)) {
    try {
      process.kill(-group, "SIGKILL")
    } catch {
      // already gone
    }
    if (!(await waitGone(group, true, STOP_GRACE_MS))) {
      return { t: "error", code: "still_running", message: `processes of the agent in ${worktreePath(name)} did not stop` }
    }
  }
  rmSync(pidPath(name), { force: true })
  if (terminal) return terminal
  if (abort.signal.aborted) return { t: "error", code: "interrupted", message: "agent interrupted", interrupted: true }
  return { t: "error", code: "remote_runner_exited", message: `the agent process on this machine exited without a result (exit ${child.exitCode ?? child.signalCode})` }
}

function stripTag(line: ReplyLine): ReplyBody {
  const { ocr: _ocr, ...body } = line
  return body as ReplyBody
}

export interface RemoteMainOpts {
  factory?: RemoteFactory
  /** This machine's BB host id, reported by `hello` so the run can confirm where SSH landed. */
  hostId?: () => Promise<string | undefined>
}

/** Entry point for `omegacode remote <command>`. Exits after the terminal line is flushed. */
export async function remoteMain(command: string | undefined, opts: RemoteMainOpts = {}): Promise<void> {
  // Workers and libraries may log; only protocol lines may reach stdout.
  console.log = (...args: unknown[]) => console.error(...args)
  const out = process.stdout
  out.on("error", () => {})
  const send = (line: ReplyBody, bytes?: Buffer): void => {
    out.write(JSON.stringify({ ocr: PROTOCOL_VERSION, ...line }) + "\n")
    if (bytes) out.write(bytes)
  }
  const finish = async (line: ReplyBody): Promise<void> => {
    await new Promise<void>((resolve) => out.write(JSON.stringify({ ocr: PROTOCOL_VERSION, ...line }) + "\n", () => resolve()))
  }
  if (!REMOTE_COMMANDS.includes(command as RemoteCommand)) {
    await finish({ t: "error", code: "bad_request", message: `unknown remote command: ${command}` })
    process.exit(0)
  }
  const abort = new AbortController()
  let request: unknown
  let payload: Buffer = Buffer.alloc(0)
  await new Promise<void>((resolve, reject) => {
    let gotRequest = false
    const reader = new FrameReader(
      (line) => {
        if (!gotRequest) {
          gotRequest = true
          try {
            request = JSON.parse(line)
          } catch {
            reject(new HelperError("bad_request", "the request line is not JSON"))
            return
          }
          const bytes = (request as { payloadBytes?: unknown })?.payloadBytes
          if (typeof bytes === "number" && bytes > 0) reader.expectBytes(bytes)
          else resolve()
          return
        }
        // Control lines after the request (`run` and `prepare` read them).
        try {
          if ((JSON.parse(line) as { t?: string }).t === "abort") abort.abort()
        } catch {
          // ignore
        }
      },
      (bytes) => {
        payload = bytes
        resolve()
      },
    )
    process.stdin.on("data", (chunk: Buffer) => reader.push(chunk))
    process.stdin.on("end", () => {
      // EOF before the request completed is a broken call; after it, EOF aborts a running agent.
      if (!gotRequest || reader.inSegment()) reject(new HelperError("bad_request", "the request ended early"))
      abort.abort()
    })
  }).catch(async (err: Error) => {
    await finish({ t: "error", code: err instanceof HelperError ? err.code : "bad_request", message: err.message })
    process.exit(0)
  })
  for (const signal of ["SIGTERM", "SIGHUP", "SIGINT"] as const) process.once(signal, () => abort.abort())
  try {
    let value: unknown
    switch (command as RemoteCommand) {
      case "hello":
        value = { protocol: PROTOCOL_VERSION, version: packageVersion(), platform: process.platform, hostId: await (opts.hostId ?? defaultMachineSources.localHostId)() } satisfies HelloReply
        break
      case "have":
        value = await have(request as HaveRequest)
        break
      case "prepare":
        value = await prepare(request as PrepareRequest, payload, abort.signal)
        break
      case "run":
        if (process.env[RUNNER_ENV] === "1") {
          value = await runTurn(request as RunRequest, abort, send, opts.factory ?? defaultRemoteFactory)
          break
        }
        await finish(await supervise(request as RunRequest, abort, send))
        process.exit(0)
      case "collect":
        value = await collect(request as CollectRequest, send)
        break
      case "cleanup":
        value = await cleanup(request as CleanupRequest)
        break
    }
    await finish({ t: "done", value })
  } catch (err) {
    if (err instanceof AgentInterrupted) {
      await finish({ t: "error", code: "interrupted", message: err.message, interrupted: true })
    } else if (err instanceof AgentError) {
      await finish({ t: "error", code: err.code, message: err.message, retryable: err.retryable, ...(err.usage ? { usage: err.usage } : {}) })
    } else {
      await finish({ t: "error", code: err instanceof HelperError ? err.code : "remote_failed", message: (err as Error).message ?? String(err) })
    }
  }
  // Workers can leave handles open; the reply is flushed, so leave now.
  process.exit(0)
}
