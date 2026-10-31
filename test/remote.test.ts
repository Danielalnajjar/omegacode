// Remote agents (ADR 0003) end to end, with a local process standing in for ssh: machine
// validation, checkout sync of a commit that exists only here, a lost connection, and the
// journal across a remote agent.

import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync, spawn } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { PassThrough } from "node:stream"
import { fileURLToPath } from "node:url"
import { runWorkflow } from "../src/runtime/run.ts"
import { Journal } from "../src/runtime/journal.ts"
import { MachineError, resolveMachines, type LiveMachine, type MachineSources, type RemoteMachine } from "../src/remote/machines.ts"
import { planMachines, RemoteWorker } from "../src/remote/agent.ts"
import { remoteCall, type RemoteTransport } from "../src/remote/client.ts"
import { buildId } from "../src/remote/build.ts"
import type { AgentSpec } from "../src/dsl/types.ts"
import { AgentError } from "../src/worker/index.ts"
import { parseWorkflow, WorkflowSyntaxError } from "../src/runtime/sandbox.ts"

const here = dirname(fileURLToPath(import.meta.url))
const register = join(here, "register.mjs")
const entry = join(here, "fixtures", "remote-entry.ts")

const TABLE = {
  machines: [
    { hostId: "host_local", label: "Local Box", shortLabel: "Here", providers: ["codex", "claude-code"], ssh: "me@here" },
    { hostId: "host_far", label: "Far Machine", shortLabel: "Far", providers: ["codex"], ssh: "me@far" },
    { hostId: "host_off", label: "Offline One", shortLabel: "Off", ssh: "me@off" },
    { hostId: "host_nossh", label: "No SSH", shortLabel: "Box" },
  ],
}

const LIVE: LiveMachine[] = [
  { id: "host_local", name: "Local Box", status: "connected" },
  { id: "host_far", name: "Far Machine (BB)", status: "connected" },
  { id: "host_off", name: "Offline One", status: "disconnected" },
  { id: "host_nossh", name: "No SSH", status: "connected" },
]

interface Fixture {
  root: string
  repo: string
  /** OMEGACODE_HOME of the stand-in remote machine. */
  farHome: string
  sources: MachineSources
  transport: RemoteTransport
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t.t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim()
}

/** Spawns the real helper with the scripted worker, in the stand-in machine's home. */
function localTransport(homeFor: (m: RemoteMachine) => string, wrap?: (command: string, child: ReturnType<typeof spawn>) => void): RemoteTransport {
  return (machine, command) => {
    const child = spawn(process.execPath, ["--import", register, entry, command], {
      env: { ...process.env, OMEGACODE_HOME: homeFor(machine), FIXTURE_HOST_ID: machine.hostId },
      stdio: ["pipe", "pipe", "pipe"],
    })
    wrap?.(command, child)
    return child as ReturnType<RemoteTransport>
  }
}

/**
 * Let the run see only the first `keep(received)` bytes of a reply, then kill the helper: a link
 * that drops at a fixed point however the bytes happen to be chunked. `keep` returns undefined
 * until enough has arrived to decide.
 */
function cutReply(child: ReturnType<typeof spawn>, keep: (received: Buffer) => number | undefined): void {
  const real = child.stdout!
  const visible = new PassThrough()
  Object.defineProperty(child, "stdout", { value: visible })
  let received = Buffer.alloc(0)
  let cut = false
  real.on("data", (chunk: Buffer) => {
    if (cut) return
    received = Buffer.concat([received, chunk])
    const n = keep(received)
    if (n === undefined) return
    cut = true
    visible.write(received.subarray(0, n))
    child.kill("SIGKILL")
  })
  real.on("end", () => visible.end())
}

/** Through the end of the first reply line. */
const firstLine = (received: Buffer): number | undefined => {
  const nl = received.indexOf(10)
  return nl < 0 ? undefined : nl + 1
}

/** The first line (a `bytes` header) and 16 bytes of the segment it announces. */
const intoFirstSegment = (received: Buffer): number | undefined => {
  const nl = received.indexOf(10)
  return nl < 0 || received.length < nl + 17 ? undefined : nl + 17
}

async function withFixture(fn: (f: Fixture) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "omega-remote-"))
  const prevHome = process.env.OMEGACODE_HOME
  process.env.OMEGACODE_HOME = join(root, "local-home")
  try {
    const repo = join(root, "repo")
    mkdirSync(repo)
    git(repo, ["init", "-q", "-b", "main"])
    writeFileSync(join(repo, "a.txt"), "a\n")
    git(repo, ["add", "."])
    git(repo, ["commit", "-q", "-m", "init"])
    // The run's commit exists only here: no remote, never pushed.
    writeFileSync(join(repo, "b.txt"), "local only\n")
    git(repo, ["add", "."])
    git(repo, ["commit", "-q", "-m", "local-only commit"])
    const tablePath = join(root, "machines.json")
    writeFileSync(tablePath, JSON.stringify(TABLE))
    const farHome = join(root, "far-home")
    mkdirSync(farHome)
    const sources: MachineSources = { tablePath: () => tablePath, liveMachines: async () => LIVE, localHostId: async () => "host_local" }
    await fn({ root, repo, farHome, sources, transport: localTransport(() => farHome) })
  } finally {
    if (prevHome === undefined) delete process.env.OMEGACODE_HOME
    else process.env.OMEGACODE_HOME = prevHome
    rmSync(root, { recursive: true, force: true })
  }
}

function workflow(f: Fixture, body: string, machines = `["Far"]`): string {
  const file = join(f.root, `w-${Math.random().toString(36).slice(2)}.workflow.js`)
  writeFileSync(file, `export const meta = { name: "remote-test", description: "test", machines: ${machines} };\n${body}`)
  return file
}

function events(runId: string): Array<Record<string, unknown>> {
  const file = join(process.env.OMEGACODE_HOME!, "runs", runId, "events.jsonl")
  return readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>)
}

function calls(f: Fixture): string[] {
  const file = join(f.farHome, "calls.log")
  return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n") : []
}

// ---- validation -------------------------------------------------------------------------------

test("machine names resolve by host id, label, short label and BB name; the run's own machine is local", async () => {
  await withFixture(async (f) => {
    const plan = await resolveMachines(["host_far", "far machine", "FAR", "Far Machine (BB)", "Here"], f.sources)
    for (const name of ["host_far", "far machine", "FAR", "Far Machine (BB)"]) {
      const m = plan.resolve(name)
      assert.ok(m !== "local" && m.hostId === "host_far" && m.ssh === "me@far")
    }
    assert.equal(plan.resolve("here"), "local")
    assert.throws(() => plan.resolve("Off"), /not declared in meta\.machines/)
  })
})

test("unknown, offline and SSH-less machines fail together with one clear message", async () => {
  await withFixture(async (f) => {
    await assert.rejects(resolveMachines(["Nowhere", "Off", "Box"], f.sources), (err: Error) => {
      assert.ok(err instanceof MachineError)
      assert.match(err.message, /"Nowhere" is not in the machine table/)
      assert.match(err.message, /"Off" \(Offline One\) is disconnected in BB/)
      assert.match(err.message, /"Box" \(No SSH\) has no "ssh" target/)
      return true
    })
  })
})

test("an unreadable live machine list fails validation", async () => {
  await withFixture(async (f) => {
    const sources = { ...f.sources, liveMachines: async () => { throw new MachineError("cannot read the live BB machine list") } }
    await assert.rejects(resolveMachines(["Far"], sources), /cannot read the live BB machine list/)
  })
})

test("a machine whose ssh exits 0 without answering is unreachable, never accepted", async () => {
  await withFixture(async (f) => {
    // Tailscale SSH exits 0 whatever the remote command did; only the in-band reply counts.
    const silent: RemoteTransport = () => spawn(process.execPath, ["-e", "process.stdin.resume(); process.stdin.on('end', () => process.exit(0))"], { stdio: ["pipe", "pipe", "pipe"] }) as ReturnType<RemoteTransport>
    await assert.rejects(planMachines(["Far"], silent, f.sources), (err: Error) => {
      assert.ok(err instanceof MachineError)
      assert.match(err.message, /Far Machine is unreachable/)
      assert.match(err.message, /ended before the remote hello reported a result \(ssh exit 0\)/)
      return true
    })
  })
})

test("a machine on another protocol version is rejected with an update hint", async () => {
  await withFixture(async (f) => {
    const old: RemoteTransport = () => spawn(process.execPath, ["-e", `console.log(JSON.stringify({ ocr: 0, t: "done", value: { protocol: 0, version: "0.0.1", platform: "linux" } }))`], { stdio: ["pipe", "pipe", "pipe"] }) as ReturnType<RemoteTransport>
    await assert.rejects(planMachines(["Far"], old, f.sources), /runs OmegaCode 0\.0\.1 with remote protocol 0; this run needs protocol 1/)
  })
})

test("a machine running a different OmegaCode build is refused", async () => {
  await withFixture(async (f) => {
    const other: RemoteTransport = () => spawn(process.execPath, ["-e", `console.log(JSON.stringify({ ocr: 1, t: "done", value: { protocol: 1, version: "0.0.6", build: "0000000000000000", platform: "linux", hostId: "host_far" } }))`], { stdio: ["pipe", "pipe", "pipe"] }) as ReturnType<RemoteTransport>
    await assert.rejects(planMachines(["Far"], other, f.sources), new RegExp(`Far Machine runs a different OmegaCode build \\(0\\.0\\.6 build 0000000000000000; this run is build ${buildId()}\\)`))
    // The same build passes.
    const plan = await planMachines(["Far"], f.transport, f.sources)
    assert.equal(plan.remotes().length, 1)
  })
})

test("a machine refuses an agent option it does not understand rather than run without it", async () => {
  await withFixture(async (f) => {
    const machine: RemoteMachine = { hostId: "host_far", label: "Far Machine", ssh: "me@far" }
    const cwd = join(f.farHome, "remote", "worktrees", "r-3")
    mkdirSync(cwd, { recursive: true })
    const worker = new RemoteWorker({ machine, transport: f.transport, provider: "codex", name: "r-3", fake: false })
    // A newer build's restriction, such as a permission profile, must never be silently dropped.
    const spec = { prompt: "hi", provider: "codex", cwd, sandbox: "read-only", approval: "never", codexFutureRestriction: "strict" } as AgentSpec
    await assert.rejects(worker.runAgent(spec, { signal: new AbortController().signal, onProgress: () => {} }), (err: Error) => {
      assert.ok(err instanceof AgentError)
      assert.equal(err.code, "bad_request")
      assert.match(err.message, /does not understand agent option codexFutureRestriction; install the run's OmegaCode build here/)
      return true
    })
    assert.deepEqual(calls(f), [])
    await assert.rejects(
      remoteCall({ machine, transport: f.transport, command: "cleanup", request: { repoKey: "r", name: "n", keepEverything: true } }),
      /does not understand cleanup request field keepEverything/,
    )
  })
})

test("a run naming a bad machine fails before any agent starts", async () => {
  await withFixture(async (f) => {
    const file = workflow(f, `return await agent("commit:x.txt", { machine: "Off" })`, `["Off"]`)
    await assert.rejects(runWorkflow({ file, quiet: true, cwd: f.repo, machineSources: f.sources, remoteTransport: f.transport } as never), /disconnected in BB/)
    assert.deepEqual(calls(f), [])
    assert.ok(!existsSync(join(process.env.OMEGACODE_HOME!, "runs")) || readdirSync(join(process.env.OMEGACODE_HOME!, "runs")).length === 0)
  })
})

test("meta.machines must be a list of names", () => {
  assert.throws(() => parseWorkflow(`export const meta = { name: "x", description: "y", machines: "Far" };\nreturn 1`), WorkflowSyntaxError)
})

test("an agent naming an undeclared machine aborts the run", async () => {
  await withFixture(async (f) => {
    const file = workflow(f, `return await parallel([() => agent("commit:x.txt", { machine: "Off" })])`)
    const out = await runWorkflow({ file, quiet: true, overrides: { cwd: f.repo }, machineSources: f.sources, remoteTransport: f.transport })
    assert.equal(out.status, "failed")
    assert.match(out.error ?? "", /machine "Off" is not declared in meta\.machines/)
  })
})

test("a provider the machine table does not list for that machine fails the agent", async () => {
  await withFixture(async (f) => {
    const file = workflow(f, `return await parallel([() => agent("hi", { machine: "Far", provider: "claude-code", model: "x" })])`)
    const out = await runWorkflow({ file, quiet: true, overrides: { cwd: f.repo }, machineSources: f.sources, remoteTransport: f.transport })
    assert.equal(out.status, "completed")
    assert.deepEqual(out.result, [null])
    assert.deepEqual(calls(f), [])
  })
})

// ---- checkout sync ----------------------------------------------------------------------------

test("a remote agent starts from a local-only commit and its commit comes back on its branch", async () => {
  await withFixture(async (f) => {
    const base = git(f.repo, ["rev-parse", "HEAD"])
    const file = workflow(f, `
      const a = await agent("commit:remote.txt", { machine: "Far", worktree: "feat/remote" })
      const b = await agent("dirty:left.txt", { machine: "Far" })
      const c = await agent("nothing", { machine: "Far" })
      return [a, b, c]`)
    const out = await runWorkflow({ file, quiet: true, overrides: { cwd: f.repo }, machineSources: f.sources, remoteTransport: f.transport })
    assert.equal(out.status, "completed", out.error)

    // The commit came back on the named branch, on top of the commit that never left this machine.
    assert.equal(git(f.repo, ["rev-parse", "feat/remote^"]), base)
    assert.equal(git(f.repo, ["show", "feat/remote:remote.txt"]), "commit:remote.txt")
    assert.equal(git(f.repo, ["show", "feat/remote:b.txt"]), "local only")
    // Uncommitted work comes back as a labelled snapshot commit on the default branch name.
    const snapshotBranch = `aw/${out.runId}-2`
    assert.match(git(f.repo, ["log", "-1", "--format=%s", snapshotBranch]), /^omegacode: uncommitted changes left by agent 2$/)
    assert.equal(git(f.repo, ["show", `${snapshotBranch}:left.txt`]), "dirty:left.txt")
    // An agent that changed nothing leaves no branch, as a clean local worktree does.
    assert.equal(git(f.repo, ["branch", "--list", `aw/${out.runId}-3`]), "")

    // Remote worktrees are cleaned up; the main checkout is untouched.
    assert.deepEqual(readdirSync(join(f.farHome, "remote", "worktrees")), [])
    assert.equal(git(f.repo, ["rev-parse", "HEAD"]), base)
    assert.equal(git(f.repo, ["status", "--porcelain"]), "")
    assert.equal(git(f.repo, ["for-each-ref", "refs/omegacode/"]), "")

    // The journal and events carry the branch and the machine.
    const results = [...Journal.load(out.runId).results.values()]
    assert.deepEqual(results.map((r) => r.worktreeBranch), ["feat/remote", snapshotBranch, undefined])
    const agentEvents = events(out.runId).filter((e) => e.type === "agent")
    assert.ok(agentEvents.every((e) => e.machine === "Far Machine"))
  })
})

test("a second agent on the same machine transfers only the missing history", async () => {
  await withFixture(async (f) => {
    const file = workflow(f, `return await agent("nothing", { machine: "Far" })`)
    const first = await runWorkflow({ file, quiet: true, overrides: { cwd: f.repo }, machineSources: f.sources, remoteTransport: f.transport })
    assert.equal(first.status, "completed", first.error)
    writeFileSync(join(f.repo, "c.txt"), "next\n")
    git(f.repo, ["add", "."])
    git(f.repo, ["commit", "-q", "-m", "another local commit"])
    const head = git(f.repo, ["rev-parse", "HEAD"])
    const sizes: number[] = []
    const transport = localTransport(() => f.farHome, (command, child) => {
      if (command !== "prepare") return
      const write = child.stdin!.write.bind(child.stdin!)
      child.stdin!.write = ((chunk: Buffer | string, ...rest: unknown[]) => {
        if (typeof chunk === "string" && chunk.startsWith("{")) sizes.push((JSON.parse(chunk) as { payloadBytes: number }).payloadBytes)
        return write(chunk as never, ...(rest as []))
      }) as typeof child.stdin.write
    })
    const second = await runWorkflow({ file: workflow(f, `return await agent("nothing again", { machine: "Far" })`), quiet: true, overrides: { cwd: f.repo }, machineSources: f.sources, remoteTransport: transport })
    assert.equal(second.status, "completed", second.error)
    const repoDir = readdirSync(join(f.farHome, "remote", "repos"))[0]!
    execFileSync("git", ["cat-file", "-e", `${head}^{commit}`], { cwd: join(f.farHome, "remote", "repos", repoDir) })
    // A thin bundle: the new commit only, so close to a one-commit bundle and under a full one.
    assert.equal(sizes.length, 1)
    const thin = execFileSync("git", ["bundle", "create", "-", "HEAD", "^HEAD~1"], { cwd: f.repo }).length
    const full = execFileSync("git", ["bundle", "create", "-", "--branches"], { cwd: f.repo }).length
    assert.ok(sizes[0]! < full && sizes[0]! <= thin + 200, `prepare sent ${sizes[0]} bytes; a one-commit bundle is ${thin}, a full one ${full}`)
  })
})

test("a delayed older branch manifest neither rewinds nor deletes the machine's branches", async () => {
  await withFixture(async (f) => {
    const machine: RemoteMachine = { hostId: "host_far", label: "Far Machine", ssh: "me@far" }
    const oldTip = git(f.repo, ["rev-parse", "HEAD~1"])
    const newTip = git(f.repo, ["rev-parse", "HEAD"])
    // Give the machine every object once, through an ordinary run.
    const seeded = await runWorkflow({ file: workflow(f, `return await agent("nothing", { machine: "Far" })`), quiet: true, overrides: { cwd: f.repo }, machineSources: f.sources, remoteTransport: f.transport })
    assert.equal(seeded.status, "completed", seeded.error)
    const repoKey = readdirSync(join(f.farHome, "remote", "repos"))[0]!.replace(/\.git$/, "")
    const cache = join(f.farHome, "remote", "repos", `${repoKey}.git`)
    const prepare = (name: string, generation: number, branches: Record<string, string>) =>
      remoteCall({ machine, transport: f.transport, command: "prepare", request: { repoKey, name, base: oldTip, generation, branches, payloadBytes: 0 } })
    await prepare("newer-1", 2_000_000_000_000, { main: newTip, "feat/a": newTip })
    // The older snapshot predates feat/a and has main one commit back.
    await prepare("older-1", 1_000_000_000_000, { main: oldTip })
    assert.equal(git(cache, ["rev-parse", "main"]), newTip)
    assert.equal(git(cache, ["rev-parse", "feat/a"]), newTip)
    // Both attempts still got their worktrees.
    assert.ok(existsSync(join(f.farHome, "remote", "worktrees", "newer-1")))
    assert.ok(existsSync(join(f.farHome, "remote", "worktrees", "older-1")))
  })
})

test("a branch renamed from feat to feat/x still mirrors to the machine", async () => {
  await withFixture(async (f) => {
    git(f.repo, ["branch", "feat"])
    const first = await runWorkflow({ file: workflow(f, `return await agent("nothing", { machine: "Far" })`), quiet: true, overrides: { cwd: f.repo }, machineSources: f.sources, remoteTransport: f.transport })
    assert.equal(first.status, "completed", first.error)
    git(f.repo, ["branch", "-D", "feat"])
    git(f.repo, ["branch", "feat/x"])
    const second = await runWorkflow({ file: workflow(f, `return await agent("commit:y.txt", { machine: "Far" })`), quiet: true, overrides: { cwd: f.repo }, machineSources: f.sources, remoteTransport: f.transport })
    assert.equal(second.status, "completed", second.error)
    const cache = join(f.farHome, "remote", "repos", readdirSync(join(f.farHome, "remote", "repos"))[0]!)
    assert.equal(git(cache, ["for-each-ref", "--format=%(refname)", "refs/heads/feat", "refs/heads/feat/"]), "refs/heads/feat/x")
  })
})

test("eight agents fanned out to one machine at once all run and all come back", async () => {
  await withFixture(async (f) => {
    const file = workflow(f, `return await parallel(Array.from({ length: 8 }, (_, i) => () => agent("commit:f" + i + ".txt", { machine: "Far" })))`)
    const out = await runWorkflow({ file, quiet: true, overrides: { cwd: f.repo }, machineSources: f.sources, remoteTransport: f.transport })
    assert.equal(out.status, "completed", out.error)
    assert.deepEqual(out.result, Array.from({ length: 8 }, (_, i) => `did commit:f${i}.txt`))
    const branches = git(f.repo, ["for-each-ref", "--format=%(refname:short)", "refs/heads/aw/"]).split("\n")
    assert.equal(branches.length, 8)
    const files = branches.map((b) => git(f.repo, ["diff", "--name-only", "main", b])).sort()
    assert.deepEqual(files, Array.from({ length: 8 }, (_, i) => `f${i}.txt`).sort())
    assert.deepEqual(readdirSync(join(f.farHome, "remote", "worktrees")), [])
  })
})

test("the next setup on a machine removes worktrees left by a run that died, and only those", async () => {
  await withFixture(async (f) => {
    const machine: RemoteMachine = { hostId: "host_far", label: "Far Machine", ssh: "me@far" }
    const seeded = await runWorkflow({ file: workflow(f, `return await agent("nothing", { machine: "Far" })`), quiet: true, overrides: { cwd: f.repo }, machineSources: f.sources, remoteTransport: f.transport })
    assert.equal(seeded.status, "completed", seeded.error)
    const repoKey = readdirSync(join(f.farHome, "remote", "repos"))[0]!.replace(/\.git$/, "")
    const base = git(f.repo, ["rev-parse", "HEAD"])
    for (const name of ["crashed-1", "recent-1"]) {
      await remoteCall({ machine, transport: f.transport, command: "prepare", request: { repoKey, name, base, generation: 1, branches: {}, payloadBytes: 0 } })
    }
    // crashed-1's run died two days ago: its lease was never renewed.
    const twoDaysAgo = (Date.now() - 2 * 24 * 60 * 60_000) / 1000
    utimesSync(join(f.farHome, "remote", "worktrees", "crashed-1.lease"), twoDaysAgo, twoDaysAgo)
    const next = await runWorkflow({ file: workflow(f, `return await agent("nothing again", { machine: "Far" })`), quiet: true, overrides: { cwd: f.repo }, machineSources: f.sources, remoteTransport: f.transport })
    assert.equal(next.status, "completed", next.error)
    const left = readdirSync(join(f.farHome, "remote", "worktrees")).sort()
    assert.deepEqual(left, ["recent-1", "recent-1.base", "recent-1.lease"])
    const cache = join(f.farHome, "remote", "repos", `${repoKey}.git`)
    assert.equal(git(cache, ["for-each-ref", "--format=%(refname)", "refs/heads/omegacode/"]), "refs/heads/omegacode/recent-1")
    // crashed-1 held nothing beyond its base, so nothing was kept for it.
    assert.equal(git(cache, ["for-each-ref", "refs/omegacode/salvage/"]), "")
  })
})

test("sweeping an abandoned attempt keeps its uncollected work on a salvage ref", async () => {
  await withFixture(async (f) => {
    const machine: RemoteMachine = { hostId: "host_far", label: "Far Machine", ssh: "me@far" }
    const seeded = await runWorkflow({ file: workflow(f, `return await agent("nothing", { machine: "Far" })`), quiet: true, overrides: { cwd: f.repo }, machineSources: f.sources, remoteTransport: f.transport })
    assert.equal(seeded.status, "completed", seeded.error)
    const repoKey = readdirSync(join(f.farHome, "remote", "repos"))[0]!.replace(/\.git$/, "")
    const base = git(f.repo, ["rev-parse", "HEAD"])
    await remoteCall({ machine, transport: f.transport, command: "prepare", request: { repoKey, name: "dirty-1", base, generation: 1, branches: {}, payloadBytes: 0 } })
    // The agent changed a tracked file and wrote a new one, then its run died and was never collected.
    const wt = join(f.farHome, "remote", "worktrees", "dirty-1")
    writeFileSync(join(wt, "a.txt"), "edited by the agent\n")
    writeFileSync(join(wt, "new.txt"), "written by the agent\n")
    const twoDaysAgo = (Date.now() - 2 * 24 * 60 * 60_000) / 1000
    utimesSync(join(f.farHome, "remote", "worktrees", "dirty-1.lease"), twoDaysAgo, twoDaysAgo)
    const next = await runWorkflow({ file: workflow(f, `return await agent("nothing again", { machine: "Far" })`), quiet: true, overrides: { cwd: f.repo }, machineSources: f.sources, remoteTransport: f.transport })
    assert.equal(next.status, "completed", next.error)
    // The checkout and its internal branch are gone; the work is on the salvage ref.
    assert.deepEqual(readdirSync(join(f.farHome, "remote", "worktrees")), [])
    const cache = join(f.farHome, "remote", "repos", `${repoKey}.git`)
    assert.equal(git(cache, ["for-each-ref", "refs/heads/omegacode/"]), "")
    const salvaged = "refs/omegacode/salvage/dirty-1"
    assert.equal(git(cache, ["rev-parse", `${salvaged}^`]), base)
    assert.equal(git(cache, ["show", `${salvaged}:a.txt`]), "edited by the agent")
    assert.equal(git(cache, ["show", `${salvaged}:new.txt`]), "written by the agent")
    assert.equal(git(cache, ["log", "-1", "--format=%s", salvaged]), "omegacode: uncommitted changes left by an abandoned agent")
  })
})

test("two collections of one attempt run one after the other, so a salvage never collides with the first", async () => {
  await withFixture(async (f) => {
    const machine: RemoteMachine = { hostId: "host_far", label: "Far Machine", ssh: "me@far" }
    const seeded = await runWorkflow({ file: workflow(f, `return await agent("nothing", { machine: "Far" })`), quiet: true, overrides: { cwd: f.repo }, machineSources: f.sources, remoteTransport: f.transport })
    assert.equal(seeded.status, "completed", seeded.error)
    const repoKey = readdirSync(join(f.farHome, "remote", "repos"))[0]!.replace(/\.git$/, "")
    const base = git(f.repo, ["rev-parse", "HEAD"])
    await remoteCall({ machine, transport: f.transport, command: "prepare", request: { repoKey, name: "twice-1", base, generation: 1, branches: {}, payloadBytes: 0 } })
    const wt = join(f.farHome, "remote", "worktrees", "twice-1")
    for (let i = 0; i < 300; i++) writeFileSync(join(wt, `left-${i}.txt`), `${i}\n`)
    const collect = () => remoteCall({ machine, transport: f.transport, command: "collect", request: { repoKey, name: "twice-1", base, index: 1 }, onBytes: () => {} })
    const [a, b] = (await Promise.all([collect(), collect()])) as Array<{ changed: boolean; head: string; snapshot?: boolean }>
    assert.ok(a.changed && b.changed)
    assert.equal(a.head, b.head)
    // Exactly one of them made the snapshot commit.
    assert.deepEqual([a.snapshot, b.snapshot].sort(), [false, true])
  })
})

test("a prepare whose reply is lost leaves no worktree behind", async () => {
  await withFixture(async (f) => {
    // The helper finishes and answers, but the answer never reaches the run.
    const transport = localTransport(() => f.farHome, (command, child) => {
      if (command !== "prepare") return
      const on = child.stdout!.on.bind(child.stdout!)
      child.stdout!.on = ((event: string, fn: (...args: unknown[]) => void) => on(event, event === "data" ? () => {} : fn)) as typeof child.stdout.on
    })
    const file = workflow(f, `return await parallel([() => agent("commit:x.txt", { machine: "Far" })])`)
    const out = await runWorkflow({ file, quiet: true, overrides: { cwd: f.repo }, machineSources: f.sources, remoteTransport: transport })
    assert.deepEqual(out.result, [null])
    const failed = events(out.runId).find((e) => e.type === "agent" && e.state === "failed")
    assert.match(String(failed?.error), /could not prepare a checkout on Far Machine/)
    assert.deepEqual(calls(f), [])
    assert.deepEqual(readdirSync(join(f.farHome, "remote", "worktrees")).filter((n) => !n.endsWith(".pid")), [])
    const cache = join(f.farHome, "remote", "repos", readdirSync(join(f.farHome, "remote", "repos"))[0]!)
    assert.equal(git(cache, ["for-each-ref", "refs/heads/omegacode/"]), "")
  })
})

test("structured output from a remote agent is validated by the run", async () => {
  await withFixture(async (f) => {
    const file = workflow(f, `return await agent("report", { machine: "Far", schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] } })`)
    const out = await runWorkflow({ file, quiet: true, overrides: { cwd: f.repo }, machineSources: f.sources, remoteTransport: f.transport })
    assert.equal(out.status, "completed", out.error)
    assert.deepEqual(out.result, { ok: false })
  })
})

// ---- failures ---------------------------------------------------------------------------------

test("a connection lost mid-turn fails the agent with a clear error and keeps nothing half-done", async () => {
  await withFixture(async (f) => {
    // Drop the link as soon as the turn reports progress; the helper's "exit" looks like success to ssh.
    const transport = localTransport(() => f.farHome, (command, child) => {
      if (command === "run") cutReply(child, firstLine)
    })
    const file = workflow(f, `return await parallel([() => agent("hang", { machine: "Far" })])`)
    const out = await runWorkflow({ file, quiet: true, overrides: { cwd: f.repo }, machineSources: f.sources, remoteTransport: transport })
    assert.equal(out.status, "completed")
    assert.deepEqual(out.result, [null])
    const failed = events(out.runId).find((e) => e.type === "agent" && e.state === "failed")
    assert.match(String(failed?.error), /connection to Far Machine \(me@far\) ended before the remote run reported a result/)
    const [result] = [...Journal.load(out.runId).results.values()]
    assert.equal(result?.status, "failed")
    // The salvage collect stopped the orphaned helper and cleaned the worktree.
    assert.deepEqual(readdirSync(join(f.farHome, "remote", "worktrees")), [])
  })
})

test("a connection lost while bringing changes back fails the agent instead of journaling success", async () => {
  await withFixture(async (f) => {
    let collects = 0
    const transport = localTransport(() => f.farHome, (command, child) => {
      // The first collect is cut off inside its bundle; the salvage collect then succeeds.
      if (command === "collect" && collects++ === 0) cutReply(child, intoFirstSegment)
    })
    const file = workflow(f, `return await parallel([() => agent("commit:x.txt", { machine: "Far", worktree: "feat/x" })])`)
    const out = await runWorkflow({ file, quiet: true, overrides: { cwd: f.repo }, machineSources: f.sources, remoteTransport: transport })
    assert.deepEqual(out.result, [null])
    const failed = events(out.runId).find((e) => e.type === "agent" && e.state === "failed")
    assert.match(String(failed?.error), /ended in the middle of a data transfer before the remote collect reported a result/)
    const [result] = [...Journal.load(out.runId).results.values()]
    assert.equal(result?.status, "failed")
    // Like a preserved local worktree, the failed agent's commit still comes back.
    assert.equal(git(f.repo, ["show", "feat/x:x.txt"]), "commit:x.txt")
  })
})

test("an agent timeout stops the remote turn and still collects", async () => {
  await withFixture(async (f) => {
    const file = workflow(f, `return await parallel([() => agent("hang", { machine: "Far" })])`)
    const out = await runWorkflow({ file, quiet: true, overrides: { cwd: f.repo, agentTimeoutMs: 8000 }, machineSources: f.sources, remoteTransport: f.transport })
    assert.deepEqual(out.result, [null])
    const failed = events(out.runId).find((e) => e.type === "agent" && e.state === "failed")
    assert.match(String(failed?.error), /exceeded wall-clock limit/)
    assert.deepEqual(readdirSync(join(f.farHome, "remote", "worktrees")), [])
  })
})

test("a remote provider error keeps its code, retryable flag and usage", async () => {
  await withFixture(async (f) => {
    const machine: RemoteMachine = { hostId: "host_far", label: "Far Machine", ssh: "me@far" }
    // A worktree the helper accepts as this run's target.
    const cwd = join(f.farHome, "remote", "worktrees", "r-1")
    mkdirSync(cwd, { recursive: true })
    const worker = new RemoteWorker({ machine, transport: f.transport, provider: "codex", name: "r-1", fake: false })
    await assert.rejects(
      worker.runAgent({ prompt: "fail-retryable", provider: "codex", cwd, sandbox: "read-only", approval: "never" }, { signal: new AbortController().signal, onProgress: () => {} }),
      (err: Error) => {
        assert.ok(err instanceof AgentError)
        assert.equal(err.code, "server_overloaded")
        assert.equal(err.retryable, true)
        assert.equal(err.usage?.outputTokens, 3)
        return true
      },
    )
  })
})

test("the machine enforces the agent's time limit even when the run cannot stop it", async () => {
  await withFixture(async (f) => {
    const machine: RemoteMachine = { hostId: "host_far", label: "Far Machine", ssh: "me@far" }
    const cwd = join(f.farHome, "remote", "worktrees", "r-2")
    mkdirSync(cwd, { recursive: true })
    // The run never aborts this call: only the machine's own deadline can end the turn.
    const worker = new RemoteWorker({ machine, transport: f.transport, provider: "codex", name: "r-2", fake: false, deadlineAt: Date.now() + 1500 })
    await assert.rejects(
      worker.runAgent({ prompt: "hang", provider: "codex", cwd, sandbox: "read-only", approval: "never" }, { signal: new AbortController().signal, onProgress: () => {} }),
      (err: Error) => {
        assert.ok(err instanceof AgentError)
        assert.equal(err.code, "agent_timeout")
        assert.match(err.message, /time limit on this machine/)
        return true
      },
    )
  })
})

// ---- journal ----------------------------------------------------------------------------------

test("resume replays a completed remote agent without contacting the machine's worker", async () => {
  await withFixture(async (f) => {
    const file = workflow(f, `
      const a = await agent("commit:r.txt", { machine: "Far", worktree: "feat/r" })
      const b = await agent("after", { machine: "Far" })
      return [a, b]`)
    const first = await runWorkflow({ file, quiet: true, overrides: { cwd: f.repo }, machineSources: f.sources, remoteTransport: f.transport })
    assert.equal(first.status, "completed", first.error)
    assert.deepEqual(calls(f), ["commit:r.txt", "after"])
    const resumed = await runWorkflow({ file, resumeRunId: first.runId, quiet: true, overrides: { cwd: f.repo }, machineSources: f.sources, remoteTransport: f.transport })
    assert.equal(resumed.status, "completed", resumed.error)
    // Workflow results are sandbox-realm values; compare their JSON.
    assert.equal(JSON.stringify(resumed.result), JSON.stringify(["did commit:r.txt", "did after"]))
    assert.deepEqual(calls(f), ["commit:r.txt", "after"])
    const cached = events(first.runId).filter((e) => e.type === "agent" && e.cached === true)
    assert.equal(cached.length, 2)
    assert.ok(cached.every((e) => e.machine === "Far Machine"))
  })
})

test("resume re-runs a remote agent whose connection was lost", async () => {
  await withFixture(async (f) => {
    const dropping = localTransport(() => f.farHome, (command, child) => {
      if (command === "run") cutReply(child, firstLine)
    })
    const file = workflow(f, `return await parallel([() => agent("commit:again.txt", { machine: "Far", worktree: "feat/again" })])`)
    const first = await runWorkflow({ file, quiet: true, overrides: { cwd: f.repo }, machineSources: f.sources, remoteTransport: dropping })
    assert.deepEqual(first.result, [null])
    const resumed = await runWorkflow({ file, resumeRunId: first.runId, quiet: true, overrides: { cwd: f.repo }, machineSources: f.sources, remoteTransport: f.transport })
    assert.equal(resumed.status, "completed", resumed.error)
    assert.deepEqual(resumed.result, ["did commit:again.txt"])
    assert.equal(git(f.repo, ["show", "feat/again:again.txt"]), "commit:again.txt")
    assert.equal([...Journal.load(first.runId).results.values()].at(-1)?.status, "completed")
  })
})
