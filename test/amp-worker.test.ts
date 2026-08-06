import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { createServer, type Server, type Socket } from "node:net"

import { AmpWorker } from "../src/worker/amp.js"
import { JsonRpcSocketClient, SocketTransportError } from "../src/worker/jsonrpc-socket.js"
import { DefaultWorkerFactory } from "../src/worker/factory.js"
import { AgentError, AgentInterrupted, type WorkerProgress } from "../src/worker/index.js"
import type { AgentSpec } from "../src/dsl/types.js"

interface RpcMessage {
  jsonrpc: "2.0"
  id?: string | number
  method?: string
  params?: Record<string, unknown>
}

interface ServerHarness {
  socketPath: string
  requests: RpcMessage[]
  notifications: RpcMessage[]
  close(): Promise<void>
}

type Handler = (message: RpcMessage, socket: Socket) => void

/**
 * Start a plugin-side JSON-RPC server. Pass `socketPath` to bind a caller-owned path (the restart
 * test needs two server lifetimes on ONE path); the harness then leaves the directory alone.
 */
async function startServer(handler: Handler, opts: { socketPath?: string } = {}): Promise<ServerHarness> {
  const ownsDir = opts.socketPath === undefined
  const dir = opts.socketPath === undefined ? mkdtempSync(join(tmpdir(), "omegacode-amp-test-")) : dirname(opts.socketPath)
  const socketPath = opts.socketPath ?? join(dir, "rpc.sock")
  rmSync(socketPath, { force: true })
  const sockets = new Set<Socket>()
  const requests: RpcMessage[] = []
  const notifications: RpcMessage[] = []
  const server: Server = createServer((socket) => {
    sockets.add(socket)
    socket.setEncoding("utf8")
    socket.on("close", () => sockets.delete(socket))
    let buf = ""
    socket.on("data", (chunk: string) => {
      buf += chunk
      let nl = buf.indexOf("\n")
      while (nl !== -1) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (line.length > 0) {
          const message = JSON.parse(line) as RpcMessage
          if (message.id === undefined) notifications.push(message)
          else requests.push(message)
          handler(message, socket)
        }
        nl = buf.indexOf("\n")
      }
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(socketPath, resolve)
  })
  return {
    socketPath,
    requests,
    notifications,
    async close(): Promise<void> {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      if (ownsDir) rmSync(dir, { recursive: true, force: true })
    },
  }
}

function reply(socket: Socket, id: string | number, result: unknown): void {
  socket.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n")
}

function notify(socket: Socket, method: string, params: unknown): void {
  socket.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n")
}

function spec(overrides: Partial<AgentSpec> = {}): AgentSpec {
  return {
    prompt: "Investigate the repository",
    provider: "amp",
    model: "xai/grok-4.5",
    effort: "high",
    cwd: "/tmp/project",
    // amp fails closed on anything but danger-full-access: its tools are not OS-confined.
    sandbox: "danger-full-access",
    approval: "never",
    ...overrides,
  }
}

function context(signal = new AbortController().signal): {
  signal: AbortSignal
  onProgress: (event: WorkerProgress) => void
  events: WorkerProgress[]
} {
  const events: WorkerProgress[] = []
  return { signal, onProgress: (event) => events.push(event), events }
}

function waitFor(check: () => boolean, timeoutMs = 1000): Promise<void> {
  const started = Date.now()
  return new Promise((resolve, reject) => {
    const poll = (): void => {
      if (check()) return resolve()
      if (Date.now() - started >= timeoutMs) return reject(new Error("timed out waiting for condition"))
      setTimeout(poll, 5)
    }
    poll()
  })
}

test("happy path composes confinement instructions and surfaces the Amp thread", async (t) => {
  const server = await startServer((message, socket) => {
    if (message.method !== "runAgent" || message.id === undefined) return
    const callId = message.params?.callId
    notify(socket, "agentThread", { callId, threadID: "T-happy" })
    notify(socket, "progress", { callId, kind: "text", text: "partial" })
    notify(socket, "progress", { callId, kind: "tool", id: "tool-1", name: "Read", input: { path: "README.md" } })
    reply(socket, message.id, { text: "done" })
  })
  t.after(() => server.close())
  const worker = new AmpWorker({ socket: server.socketPath })
  t.after(() => worker.shutdown())
  const ctx = context()

  const result = await worker.runAgent(spec({ instructions: "Keep the answer concise." }), ctx)

  assert.equal(result.text, "done")
  assert.deepEqual(result.usage, { inputTokens: 0, outputTokens: 0, costUsd: 0 })
  assert.equal(server.requests.length, 1)
  const params = server.requests[0]!.params!
  assert.equal(params.prompt, "Investigate the repository")
  assert.equal(params.model, "xai/grok-4.5")
  assert.equal(params.effort, "high")
  assert.equal(params.toolPolicy, undefined)
  assert.equal(params.timeoutMs, 30 * 60 * 1000)
  assert.equal(
    params.instructions,
    "Keep the answer concise.\n" +
      "Operate only within `/tmp/project`; treat it as your working directory for every command and file operation.",
  )
  assert.deepEqual(ctx.events, [
    { kind: "phase", phase: "amp-thread:T-happy" },
    { kind: "text", text: "partial" },
    { kind: "tool", id: "tool-1", name: "Read", input: { path: "README.md" } },
  ])
})

test("schema output uses a second low-effort extraction turn and returns parsed JSON", async (t) => {
  let turn = 0
  const server = await startServer((message, socket) => {
    if (message.method !== "runAgent" || message.id === undefined) return
    turn++
    reply(socket, message.id, turn === 1 ? { text: "The answer is 42." } : { text: "```json\n{\"answer\":42}\n```" })
  })
  t.after(() => server.close())
  const worker = new AmpWorker({ socket: server.socketPath })
  t.after(() => worker.shutdown())

  const result = await worker.runAgent(
    spec({ schema: { type: "object", properties: { answer: { type: "number" } }, required: ["answer"] } }),
    context(),
  )

  assert.equal(server.requests.length, 2)
  assert.match(String(server.requests[1]!.params!.prompt), /Earlier you produced this answer:\n\nThe answer is 42\./)
  assert.match(String(server.requests[1]!.params!.prompt), /"answer"/)
  assert.equal(server.requests[1]!.params!.effort, "low")
  assert.equal(server.requests[1]!.params!.toolPolicy, undefined)
  assert.equal(result.text, "```json\n{\"answer\":42}\n```")
  assert.deepEqual(result.structured, { answer: 42 })
})

test("missing socket environment fails with no_socket", async () => {
  const previous = process.env.OMEGACODE_AMP_SOCKET
  delete process.env.OMEGACODE_AMP_SOCKET
  try {
    const worker = new AmpWorker()
    await assert.rejects(
      worker.runAgent(spec(), context()),
      (err: unknown) => err instanceof AgentError && err.code === "no_socket",
    )
  } finally {
    if (previous === undefined) delete process.env.OMEGACODE_AMP_SOCKET
    else process.env.OMEGACODE_AMP_SOCKET = previous
  }
})

test("abort sends cancelAgent and rejects with AgentInterrupted", async (t) => {
  const server = await startServer(() => {})
  t.after(() => server.close())
  const worker = new AmpWorker({ socket: server.socketPath })
  t.after(() => worker.shutdown())
  const ac = new AbortController()
  const run = worker.runAgent(spec(), context(ac.signal))
  await waitFor(() => server.requests.length === 1)

  ac.abort()

  await assert.rejects(run, AgentInterrupted)
  await waitFor(() => server.notifications.some((message) => message.method === "cancelAgent"))
  const cancel = server.notifications.find((message) => message.method === "cancelAgent")!
  assert.equal(cancel.params?.callId, server.requests[0]!.params?.callId)
})

test("notify never silently drops a frame: it delivers or it throws", async (t) => {
  const server = await startServer((message, socket) => {
    if (message.method === "ping" && message.id !== undefined) reply(socket, message.id, {})
  })
  t.after(() => server.close())
  let gone = false
  const client = new JsonRpcSocketClient({ socketPath: server.socketPath, onConnectionGone: () => (gone = true) })
  t.after(() => client.close())

  // Before the dial completes there is nothing to write to. A queued-and-forgotten
  // cancel is exactly the drop this transport must not have, so notify fails loudly
  // (same as JsonRpcStdioClient.send) — and a refused frame must not kill the client.
  assert.throws(
    () => client.notify("cancelAgent", { callId: "c0" }),
    (err: unknown) => err instanceof SocketTransportError && err.code === "not_writable",
  )

  await client.request("ping")
  // A live connection delivers without throwing — the abort path AmpWorker uses.
  client.notify("cancelAgent", { callId: "c1" })
  await waitFor(() => server.notifications.some((message) => message.params?.callId === "c1"))
  assert.equal(gone, false)

  await server.close()
  await waitFor(() => gone)

  assert.throws(
    () => client.notify("cancelAgent", { callId: "c2" }),
    (err: unknown) => err instanceof SocketTransportError && err.code === "not_writable",
  )
})

test("the socket client routes server-initiated requests to onServerRequest", async (t) => {
  const seen: Array<[string | number, string, unknown]> = []
  const server = await startServer((message, socket) => {
    if (message.method !== "ping" || message.id === undefined) return
    socket.write(JSON.stringify({ jsonrpc: "2.0", id: 7, method: "permission/request", params: { callId: "c1" } }) + "\n")
    reply(socket, message.id, { ok: true })
  })
  t.after(() => server.close())
  const client = new JsonRpcSocketClient({
    socketPath: server.socketPath,
    onServerRequest: (id, method, params) => seen.push([id, method, params]),
  })
  t.after(() => client.close())

  await client.request("ping")

  assert.deepEqual(seen, [[7, "permission/request", { callId: "c1" }]])
})

test("server death is retryable and the next run reconnects to a restarted plugin", async (t) => {
  // The test owns the socket path so the plugin can be restarted on it — the retryable transport
  // error we hand the runtime is only honest if a later turn can actually dial a fresh connection.
  const dir = mkdtempSync(join(tmpdir(), "omegacode-amp-restart-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const socketPath = join(dir, "rpc.sock")

  let requests = 0
  const dying = await startServer((message, socket) => {
    if (message.method === "runAgent" && ++requests === 2) socket.destroy()
  }, { socketPath })
  const worker = new AmpWorker({ socket: dying.socketPath })
  t.after(() => worker.shutdown())

  const first = worker.runAgent(spec({ prompt: "first" }), context())
  const second = worker.runAgent(spec({ prompt: "second" }), context())
  const isRetryableTransport = (err: unknown): boolean =>
    err instanceof AgentError && err.code === "transport" && err.retryable
  await assert.rejects(first, isRetryableTransport)
  await assert.rejects(second, isRetryableTransport)
  await dying.close()

  const restarted = await startServer((message, socket) => {
    if (message.method === "runAgent" && message.id !== undefined) reply(socket, message.id, { text: "reconnected" })
  }, { socketPath })
  t.after(() => restarted.close())

  const result = await worker.runAgent(spec({ prompt: "after death" }), context())

  assert.equal(result.text, "reconnected")
  assert.equal(restarted.requests.length, 1)
  assert.equal(restarted.requests[0]!.params!.prompt, "after death")
})

test("a sandbox amp cannot enforce fails closed before any RPC", async (t) => {
  const server = await startServer(() => {})
  t.after(() => server.close())
  const worker = new AmpWorker({ socket: server.socketPath })
  t.after(() => worker.shutdown())

  for (const sandbox of ["read-only", "workspace-write"] as const) {
    await assert.rejects(
      worker.runAgent(spec({ sandbox }), context()),
      (err: unknown) =>
        err instanceof AgentError &&
        err.code === "sandbox_unsupported" &&
        !err.retryable &&
        err.message ===
          `amp cannot enforce sandbox "${sandbox}": Amp agent tools are not OS-confined; set sandbox danger-full-access explicitly to accept unconfined execution`,
    )
  }
  assert.equal(server.requests.length, 0)
})

test("approval on-request and maxTurns fail closed before any RPC", async (t) => {
  const server = await startServer(() => {})
  t.after(() => server.close())
  const worker = new AmpWorker({ socket: server.socketPath })
  t.after(() => worker.shutdown())

  await assert.rejects(
    worker.runAgent(spec({ approval: "on-request" }), context()),
    (err: unknown) => err instanceof AgentError && err.code === "unsupported_option" && !err.retryable && /approval requests/.test(err.message),
  )
  await assert.rejects(
    worker.runAgent(spec({ maxTurns: 3 }), context()),
    (err: unknown) => err instanceof AgentError && err.code === "unsupported_option" && !err.retryable && /does not support maxTurns/.test(err.message),
  )
  assert.equal(server.requests.length, 0)
})

test("JSON-RPC errors preserve the server message as agent_failed", async (t) => {
  const server = await startServer((message, socket) => {
    if (message.method !== "runAgent" || message.id === undefined) return
    socket.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: "Amp thread failed" } }) + "\n")
  })
  t.after(() => server.close())
  const worker = new AmpWorker({ socket: server.socketPath })
  t.after(() => worker.shutdown())

  await assert.rejects(
    worker.runAgent(spec(), context()),
    (err: unknown) => err instanceof AgentError && err.code === "agent_failed" && err.message === "Amp thread failed" && !err.retryable,
  )
})

test("ultra effort maps to Amp max", async (t) => {
  const server = await startServer((message, socket) => {
    if (message.method === "runAgent" && message.id !== undefined) reply(socket, message.id, { text: "ok" })
  })
  t.after(() => server.close())
  const worker = new AmpWorker({ socket: server.socketPath })
  t.after(() => worker.shutdown())

  await worker.runAgent(spec({ effort: "ultra" }), context())

  assert.equal(server.requests[0]!.params!.effort, "max")
})

test("factory forwards ampSocket to AmpWorker", () => {
  const factory = new DefaultWorkerFactory({ ampSocket: "/tmp/amp-test.sock" })
  const worker = factory.get("amp")
  assert.ok(worker instanceof AmpWorker)
  assert.equal(worker.id, "amp")
})
