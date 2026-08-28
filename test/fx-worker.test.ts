import { test } from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { EventEmitter } from "node:events"
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { FX_BINARY_DIGESTS, FxWorker } from "../src/worker/fx.ts"
import { AgentError, AgentInterrupted, type WorkerProgress } from "../src/worker/index.ts"
import type { SpawnProcess } from "../src/worker/subprocess-jsonl.ts"
import type { AgentSpec } from "../src/dsl/types.ts"

const MODEL = "gpt-5.6-sol"

class FakeStdin extends EventEmitter {
  chunks: string[] = []
  ended = false
  write(chunk: string, cb?: (err?: Error | null) => void): boolean {
    this.chunks.push(chunk)
    cb?.(null)
    return true
  }
  end(): void {
    this.ended = true
  }
}

class FakeProc extends EventEmitter {
  readonly stdout = new EventEmitter() as EventEmitter & { setEncoding(encoding: string): void }
  readonly stderr = new EventEmitter() as EventEmitter & { setEncoding(encoding: string): void }
  readonly stdin = new FakeStdin()
  readonly kills: string[] = []
  constructor() {
    super()
    this.stdout.setEncoding = () => {}
    this.stderr.setEncoding = () => {}
  }
  output(text: string): void {
    this.stdout.emit("data", text)
  }
  error(text: string): void {
    this.stderr.emit("data", text)
  }
  end(code: number | null, signal: string | null = null): void {
    this.emit("exit", code, signal)
    this.emit("close", code, signal)
  }
  kill(signal?: string): boolean {
    this.kills.push(signal ?? "SIGTERM")
    return true
  }
}

interface SpawnCall {
  bin: string
  args: string[]
  cwd?: string
  env?: NodeJS.ProcessEnv
  proc: FakeProc
}

type Script = (proc: FakeProc, call: SpawnCall) => void

interface Fixture {
  root: string
  home: string
  cwd: string
  bin: string
  cleanup(): void
}

function fixture(settings: Record<string, unknown> = {}, withAuth = true): Fixture {
  const root = mkdtempSync(join(tmpdir(), "omegacode-fx-test-"))
  const home = join(root, "managed-home")
  const cwd = join(root, "project")
  const bin = join(root, "fx")
  mkdirSync(join(home, ".fx"), { recursive: true, mode: 0o700 })
  mkdirSync(cwd, { mode: 0o700 })
  chmodSync(home, 0o700)
  chmodSync(join(home, ".fx"), 0o700)
  writeFileSync(bin, "fake fx binary", { mode: 0o700 })
  chmodSync(bin, 0o700)
  writeFileSync(
    join(home, ".fx", "settings.json"),
    JSON.stringify({
      provider: "codex",
      models: { codex: MODEL },
      permission_mode: "yolo",
      yolo_acknowledged: true,
      fast_mode: false,
      auto_upgrade: false,
      ...settings,
    }),
    { mode: 0o600 },
  )
  chmodSync(join(home, ".fx", "settings.json"), 0o600)
  if (withAuth) {
    writeFileSync(join(home, ".fx", "chatgpt-auth.json"), "test-only opaque auth", { mode: 0o600 })
    chmodSync(join(home, ".fx", "chatgpt-auth.json"), 0o600)
  }
  return { root, home, cwd, bin, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

function spec(f: Fixture, over: Partial<AgentSpec> = {}): AgentSpec {
  return {
    prompt: "inspect the project",
    provider: "fx",
    model: MODEL,
    cwd: f.cwd,
    sandbox: "danger-full-access",
    approval: "never",
    ...over,
  }
}

function status(f: Fixture, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "status",
    model: MODEL,
    model_source: "Codex subscription",
    auth: "Codex subscription",
    auth_refreshable: true,
    connected_providers: ["codex"],
    permission_mode: "yolo",
    workspace: f.cwd,
    ...over,
  }
}

function envelope(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    output: "done",
    exit_code: 0,
    model: MODEL,
    session_id: "",
    steps: 1,
    tool_calls: [],
    ...over,
  }
}

function json(value: unknown): Script {
  return (proc) => {
    proc.output(JSON.stringify(value) + "\n")
    proc.end(0)
  }
}

const version: Script = (proc) => {
  proc.output("0.0.6\n")
  proc.end(0)
}

function harness(f: Fixture, scripts: Script[], over: Partial<ConstructorParameters<typeof FxWorker>[0]> = {}) {
  const spawned: SpawnCall[] = []
  const queue = [...scripts]
  const spawnProcess: SpawnProcess = (bin, args, opts) => {
    const proc = new FakeProc()
    const call = { bin, args, cwd: opts.cwd, env: opts.env, proc }
    spawned.push(call)
    const script = queue.shift()
    assert.ok(script, `unexpected spawn: ${bin} ${args.join(" ")}`)
    queueMicrotask(() => script(proc, call))
    return proc as never
  }
  const worker = new FxWorker({
    bin: f.bin,
    managedHome: f.home,
    platform: { os: "darwin", arch: "arm64" },
    hashBinary: () => FX_BINARY_DIGESTS["macos-aarch64"],
    spawnProcess,
    ...over,
  })
  return { worker, spawned }
}

function context(signal = new AbortController().signal) {
  const events: WorkerProgress[] = []
  return { signal, events, onProgress: (event: WorkerProgress) => events.push(event) }
}

async function rejectsCode(promise: Promise<unknown>, code: string): Promise<AgentError> {
  let found: AgentError | undefined
  await assert.rejects(promise, (err: unknown) => {
    assert.ok(err instanceof AgentError)
    assert.equal(err.code, code)
    found = err
    return true
  })
  return found!
}

function treeDigest(root: string): string {
  const hash = createHash("sha256")
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name)
      const st = statSync(path)
      hash.update(`${path.slice(root.length)}\0${st.mode & 0o777}\0`)
      if (st.isDirectory()) walk(path)
      else hash.update(readFileSync(path))
    }
  }
  walk(root)
  return hash.digest("hex")
}

test("runs exact v0.0.6 ask contract with an isolated Codex profile and unknown usage", async () => {
  const f = fixture()
  try {
    const h = harness(f, [version, json(status(f)), json(envelope({ tool_calls: [{ name: "list_files", status: "success" }] }))])
    const c = context()
    const result = await h.worker.runAgent(spec(f, { instructions: "be concise" }), c)
    assert.equal(result.text, "done")
    assert.deepEqual(result.usage, { inputTokens: 0, outputTokens: 0, costUsd: 0, incomplete: true })
    assert.deepEqual(h.spawned.map((call) => call.args), [
      ["--version"],
      ["status", "--json"],
      ["ask", "--json", "--no-save"],
    ])
    const ask = h.spawned[2]!
    assert.deepEqual(ask.proc.stdin.chunks, ["<instructions>\nbe concise\n</instructions>\n\ninspect the project"])
    assert.equal(ask.proc.stdin.ended, true)
    assert.equal(ask.env?.HOME, f.home)
    assert.equal(ask.env?.FX_MODEL, MODEL)
    assert.equal(ask.env?.FX_AUTO_UPGRADE, "0")
    assert.equal(ask.env?.FX_DISABLE_KEYCHAIN, "1")
    assert.equal(ask.env?.OPENAI_API_KEY, undefined)
    assert.equal(ask.env?.AI_GATEWAY_API_KEY, undefined)
    assert.deepEqual(c.events.map((event) => event.kind), ["text", "tool", "usage"])
  } finally {
    f.cleanup()
  }
})

test("rechecks the exact binary version and digest before every paid turn", async () => {
  const f = fixture()
  let hashCalls = 0
  try {
    const h = harness(
      f,
      [version, json(status(f)), json(envelope()), version, json(status(f)), json(envelope())],
      {
        hashBinary: () => {
          hashCalls++
          return FX_BINARY_DIGESTS["macos-aarch64"]
        },
      },
    )
    await h.worker.runAgent(spec(f), context())
    await h.worker.runAgent(spec(f), context())
    assert.equal(hashCalls, 2)
    assert.deepEqual(
      h.spawned.map((call) => call.args),
      [
        ["--version"],
        ["status", "--json"],
        ["ask", "--json", "--no-save"],
        ["--version"],
        ["status", "--json"],
        ["ask", "--json", "--no-save"],
      ],
    )
  } finally {
    f.cleanup()
  }
})

test("rejects unset, missing, relative, wrong-digest, unsupported-platform, old, later, and unidentified binaries", async () => {
  const f = fixture()
  try {
    const unset = harness(f, [], { bin: "" })
    await rejectsCode(unset.worker.runAgent(spec(f), context()), "binary_not_pinned")

    const missing = harness(f, [], { bin: join(f.root, "missing") })
    await rejectsCode(missing.worker.runAgent(spec(f), context()), "binary_not_found")

    const relative = harness(f, [], { bin: "fx" })
    await rejectsCode(relative.worker.runAgent(spec(f), context()), "binary_not_pinned")

    const wrongDigest = harness(f, [], { hashBinary: () => "0".repeat(64) })
    await rejectsCode(wrongDigest.worker.runAgent(spec(f), context()), "provider_digest")

    const wrongPlatform = harness(f, [], { platform: { os: "win32", arch: "x64" } })
    await rejectsCode(wrongPlatform.worker.runAgent(spec(f), context()), "provider_digest")

    for (const [reported, code] of [
      ["0.0.5\n", "provider_version"],
      ["0.0.7\n", "provider_version"],
      ["fx development build\n", "provider_unidentified"],
    ] as const) {
      const h = harness(f, [
        (proc) => {
          proc.output(reported)
          proc.end(0)
        },
      ])
      await rejectsCode(h.worker.runAgent(spec(f), context()), code)
      assert.equal(h.spawned.length, 1)
    }
  } finally {
    f.cleanup()
  }
})

test("profile admission rejects missing auth, wrong provider/model, Fast, auto-upgrade, prompting mode, and workspace overrides before spawn", async () => {
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ provider: "gateway" }, "wrong_provider"],
    [{ models: { codex: "gpt-wrong" } }, "wrong_model"],
    [{ fast_mode: true }, "wrong_fast"],
    [{ auto_upgrade: true }, "wrong_auto_upgrade"],
    [{ permission_mode: "ask" }, "wrong_permission"],
    [{ workspaces: { "/tmp/project": { provider: "gateway" } } }, "unsafe_profile"],
  ]
  for (const [settings, code] of cases) {
    const f = fixture(settings)
    try {
      const h = harness(f, [])
      await rejectsCode(h.worker.runAgent(spec(f), context()), code)
      assert.equal(h.spawned.length, 0)
    } finally {
      f.cleanup()
    }
  }

  const f = fixture({}, false)
  try {
    const h = harness(f, [])
    await rejectsCode(h.worker.runAgent(spec(f), context()), "auth_metadata")
    assert.equal(h.spawned.length, 0)
  } finally {
    f.cleanup()
  }
})

test("status attestation rejects wrong route, model, auth, permission, expiry, MCP error, and cwd before ask", async () => {
  const f = fixture()
  try {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ model_source: "Vercel AI Gateway" }, "wrong_provider"],
      [{ model: "gpt-wrong" }, "wrong_model"],
      [{ auth: "AI_GATEWAY_API_KEY" }, "auth_metadata"],
      [{ auth_refreshable: false }, "auth_metadata"],
      [{ permission_mode: "ask" }, "wrong_permission"],
      [{ auth_expired: true }, "auth_metadata"],
      [{ mcp_config_error: "MissingRequiredServer" }, "mcp_config_error"],
      [{ connected_providers: ["vercel-ai-gateway"] }, "wrong_provider"],
      [{ workspace: f.root }, "wrong_workspace"],
    ]
    for (const [statusOverride, code] of cases) {
      const h = harness(f, [version, json(status(f, statusOverride))])
      await rejectsCode(h.worker.runAgent(spec(f), context()), code)
      assert.equal(h.spawned.length, 2)
    }
  } finally {
    f.cleanup()
  }
})

test("strict ask envelope rejects OS/inner failures, typed errors, wrong model, empty output, failed tools, and malformed stdout", async () => {
  const f = fixture()
  try {
    const cases: Array<[Script, string]> = [
      [
        (proc) => {
          proc.error("sensitive stderr must not surface")
          proc.end(2)
        },
        "provider_exit",
      ],
      [json(envelope({ exit_code: 1 })), "inner_exit"],
      [json(envelope({ error: "PermissionRequired" })), "permission_required"],
      [json(envelope({ error: "" })), "provider_error"],
      [json(envelope({ auth_failure: { kind: "expired" } })), "provider_auth"],
      [json(envelope({ recovery: { state: "recovered" } })), "provider_recovery"],
      [json(envelope({ model: "gpt-wrong" })), "wrong_model"],
      [json(envelope({ session_id: "unexpected-saved-session" })), "malformed_output"],
      [json(envelope({ output: "  " })), "empty_output"],
      [json(envelope({ tool_calls: [{ name: "bash", status: "error" }] })), "provider_tool_failed"],
      [json(envelope({ tool_calls: [{ name: "bash", status: "permission_required" }] })), "permission_required"],
      [
        (proc) => {
          proc.output("diagnostic\n" + JSON.stringify(envelope()))
          proc.end(0)
        },
        "malformed_output",
      ],
      [
        (proc) => {
          proc.output(JSON.stringify(envelope()) + "\n" + JSON.stringify(envelope()))
          proc.end(0)
        },
        "malformed_output",
      ],
      [json({ final_output: "drift", exit_code: 0, model: MODEL, session_id: "s", steps: 0, tool_calls: [] }), "malformed_output"],
      [json(envelope({ extra: true })), "malformed_output"],
      [
        (proc) => {
          proc.end(0)
        },
        "malformed_output",
      ],
    ]
    for (const [ask, code] of cases) {
      const h = harness(f, [version, json(status(f)), ask])
      const err = await rejectsCode(h.worker.runAgent(spec(f), context()), code)
      assert.deepEqual(err.usage, { inputTokens: 0, outputTokens: 0, costUsd: 0, incomplete: true })
      assert.doesNotMatch(err.message, /sensitive stderr/)
    }
  } finally {
    f.cleanup()
  }
})

test("structured output validates locally and leaves misses for the runtime corrective retry", async () => {
  const f = fixture()
  try {
    const schema = { type: "object", properties: { answer: { type: "number" } }, required: ["answer"] }
    const h = harness(f, [version, json(status(f)), json(envelope({ output: '{"answer":42}' }))])
    const result = await h.worker.runAgent(spec(f, { schema, instructions: "Follow the caller constraint" }), context())
    assert.deepEqual(result.structured, { answer: 42 })
    assert.deepEqual(result.usage, { inputTokens: 0, outputTokens: 0, costUsd: 0, incomplete: true })
    assert.equal(h.spawned.length, 3)
    const prompt = h.spawned[2]!.proc.stdin.chunks[0]!
    assert.match(prompt, /<instructions>\nFollow the caller constraint\n<\/instructions>/)
    assert.match(prompt, /Output ONLY the JSON/)
    assert.match(prompt, /"answer"/)

    const invalid = harness(f, [version, json(status(f)), json(envelope({ output: "not json" }))])
    const invalidResult = await invalid.worker.runAgent(spec(f, { schema }), context())
    assert.equal(invalidResult.structured, undefined)
    assert.equal(invalid.spawned.length, 3)

    const corrective = harness(f, [
      version,
      json(status(f)),
      json(envelope({ output: '{"answer":42}' })),
    ])
    const correctiveInstructions =
      "Follow the caller constraint\n\nYour previous response did not match the required JSON schema. Respond again with ONLY a JSON value."
    const corrected = await corrective.worker.runAgent(
      spec(f, { schema, instructions: correctiveInstructions }),
      context(),
    )
    assert.deepEqual(corrected.structured, { answer: 42 })
    assert.match(corrective.spawned[2]!.proc.stdin.chunks[0]!, /Follow the caller constraint/)
    assert.match(corrective.spawned[2]!.proc.stdin.chunks[0]!, /previous response did not match/)
  } finally {
    f.cleanup()
  }
})

test("rejects unsupported authority and turn controls before spawning", async () => {
  const f = fixture()
  try {
    const cases: Array<Partial<AgentSpec>> = [
      { sandbox: "read-only" },
      { sandbox: "workspace-write" },
      { approval: "prompt" },
      { maxTurns: 2 },
      { effort: "high" },
      { serviceTier: "fast" },
    ]
    for (const options of cases) {
      const h = harness(f, [])
      await rejectsCode(h.worker.runAgent(spec(f, options), context()), "unsupported_option")
      assert.equal(h.spawned.length, 0)
    }
  } finally {
    f.cleanup()
  }
})

test("stall, provider signal deaths, and caller cancellation terminate without retries and mark usage incomplete", async () => {
  const f = fixture()
  try {
    const stalled = harness(f, [version, json(status(f)), () => {}], { stallTimeoutMs: 5, killGraceMs: 1 })
    const stallErr = await rejectsCode(stalled.worker.runAgent(spec(f), context()), "turn_stalled")
    assert.equal(stallErr.retryable, false)
    assert.equal(stallErr.usage?.incomplete, true)
    assert.deepEqual(stalled.spawned[2]!.proc.kills, ["SIGTERM"])

    for (const signal of ["SIGINT", "SIGTERM", "SIGKILL"] as const) {
      const h = harness(f, [
        version,
        json(status(f)),
        (proc) => proc.end(null, signal),
      ])
      const err = await rejectsCode(h.worker.runAgent(spec(f), context()), "provider_exit")
      assert.equal(err.retryable, false)
      assert.equal(err.usage?.incomplete, true)
    }

    for (const code of [130, 143]) {
      const h = harness(f, [version, json(status(f)), (proc) => proc.end(code)])
      const err = await rejectsCode(h.worker.runAgent(spec(f), context()), "provider_exit")
      assert.equal(err.retryable, false)
      assert.equal(err.usage?.incomplete, true)
    }

    const versionAc = new AbortController()
    const cancelledVersion = harness(f, [
      () => queueMicrotask(() => versionAc.abort()),
    ])
    await assert.rejects(
      cancelledVersion.worker.runAgent(spec(f), context(versionAc.signal)),
      AgentInterrupted,
    )
    assert.equal(cancelledVersion.spawned.length, 1)
    assert.deepEqual(cancelledVersion.spawned[0]!.proc.kills, ["SIGTERM"])

    const ac = new AbortController()
    const cancelled = harness(f, [
      version,
      json(status(f)),
      () => queueMicrotask(() => ac.abort()),
    ])
    await assert.rejects(cancelled.worker.runAgent(spec(f), context(ac.signal)), (err: unknown) => {
      assert.ok(err instanceof AgentInterrupted)
      assert.equal(err.usage?.incomplete, true)
      return true
    })
    assert.deepEqual(cancelled.spawned[2]!.proc.kills, ["SIGTERM"])
  } finally {
    f.cleanup()
  }
})

test("worker neither reads interactive ~/.fx nor mutates managed or canonical profile fixtures", async () => {
  const f = fixture()
  const canonical = join(f.root, "canonical-home")
  mkdirSync(join(canonical, ".fx"), { recursive: true, mode: 0o700 })
  writeFileSync(join(canonical, ".fx", "sentinel"), "unchanged", { mode: 0o600 })
  const beforeManaged = treeDigest(f.home)
  const beforeCanonical = treeDigest(canonical)
  const previousHome = process.env.HOME
  process.env.HOME = canonical
  try {
    const h = harness(f, [version, json(status(f)), json(envelope())])
    await h.worker.runAgent(spec(f), context())
    assert.equal(treeDigest(f.home), beforeManaged)
    assert.equal(treeDigest(canonical), beforeCanonical)
    assert.ok(h.spawned.every((call) => call.env?.HOME === f.home))
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    f.cleanup()
  }
})

test("managed auth metadata cannot alias another profile through a hard link", async () => {
  const f = fixture()
  const managedAuth = join(f.home, ".fx", "chatgpt-auth.json")
  const interactiveAuth = join(f.root, "interactive-chatgpt-auth.json")
  try {
    rmSync(managedAuth)
    writeFileSync(interactiveAuth, "{}", { mode: 0o600 })
    linkSync(interactiveAuth, managedAuth)
    const h = harness(f, [])
    await rejectsCode(h.worker.runAgent(spec(f), context()), "unsafe_profile")
    assert.equal(h.spawned.length, 0)
  } finally {
    f.cleanup()
  }
})

test("missing auth remains missing and is not created as a side effect", async () => {
  const f = fixture({}, false)
  const authPath = join(f.home, ".fx", "chatgpt-auth.json")
  try {
    const h = harness(f, [])
    await rejectsCode(h.worker.runAgent(spec(f), context()), "auth_metadata")
    assert.throws(() => statSync(authPath))
    assert.equal(h.spawned.length, 0)
  } finally {
    f.cleanup()
  }
})
