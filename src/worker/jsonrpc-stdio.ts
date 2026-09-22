// JsonRpcStdioClient — owns a single child process speaking newline-delimited
// JSON-RPC 2.0 over stdio: child lifecycle, stdout framing, the pending-request
// map, stderr draining, and request timeouts.
//
// The load-bearing invariant: NO pending request outlives its process. Whenever
// the child dies (error/exit) or the client is shut down, every pending request
// is rejected, the stdout buffer is reset, and `send()`/`request()` thereafter
// fail fast instead of silently dropping writes. This is what makes the codex
// worker proof against the "request registered but nothing ever settles" hang.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"

import {
  parseInbound,
  encodeRequest,
  type JsonRpcId,
  type JsonRpcError,
  type InboundMessage,
} from "./codex-protocol.js"
import { providerEnv } from "./provider-env.js"

/** Raised for transport-level failures (process gone, write failed, timeout). */
export class StdioTransportError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = "StdioTransportError"
    this.code = code
  }
}

/** Raised when a JSON-RPC response carries an `error` member. */
export class JsonRpcResponseError extends Error {
  readonly rpc: JsonRpcError
  constructor(rpc: JsonRpcError) {
    super(rpc.message)
    this.name = "JsonRpcResponseError"
    this.rpc = rpc
  }
}

/** Spawns the child. Overridable in tests with a scripted fake process. */
export type SpawnChild = () => ChildProcessWithoutNullStreams

export interface JsonRpcStdioOptions {
  /** Spawn the underlying child. Defaults to `spawn(bin, args, {stdio:["pipe","pipe","pipe"]})`. */
  spawnChild?: SpawnChild
  bin?: string
  args?: string[]
  /** Per-request timeout in ms (0/undefined disables). Rejects the request and is retryable. */
  requestTimeoutMs?: number
  /** Max stderr bytes retained for crash diagnostics (ring buffer). */
  stderrLimit?: number
  /** Inbound server-initiated request (the server expects a response by id). */
  onServerRequest?: (id: JsonRpcId, method: string, params: unknown) => void
  /** Inbound notification (no response expected). */
  onNotification?: (method: string, params: unknown) => void
  /** The process died (error or exit). Called once per death; pending already rejected. */
  onProcessGone?: (err: StdioTransportError) => void
}

interface Pending {
  resolve: (result: unknown) => void
  reject: (err: Error) => void
  timer?: ReturnType<typeof setTimeout>
}

const DEFAULT_STDERR_LIMIT = 16 * 1024

export class JsonRpcStdioClient {
  private child: ChildProcessWithoutNullStreams | null = null
  private stdoutBuf = ""
  private stderrBuf = ""
  private nextId = 1
  private readonly pending = new Map<JsonRpcId, Pending>()
  private dead = false

  private readonly spawnChild: SpawnChild
  private readonly requestTimeoutMs: number
  private readonly stderrLimit: number
  private readonly onServerRequest?: (id: JsonRpcId, method: string, params: unknown) => void
  private readonly onNotification?: (method: string, params: unknown) => void
  private readonly onGone?: (err: StdioTransportError) => void

  constructor(opts: JsonRpcStdioOptions = {}) {
    const bin = opts.bin ?? "codex"
    const args = opts.args ?? ["app-server"]
    this.spawnChild = opts.spawnChild ?? (() => spawn(bin, args, { env: providerEnv(), stdio: ["pipe", "pipe", "pipe"] }))
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 0
    this.stderrLimit = opts.stderrLimit ?? DEFAULT_STDERR_LIMIT
    this.onServerRequest = opts.onServerRequest
    this.onNotification = opts.onNotification
    this.onGone = opts.onProcessGone
  }

  /** True once the child is spawned and not yet known dead. */
  get alive(): boolean {
    return !this.dead && this.child !== null
  }

  /** Spawn the child and wire its streams. Throws StdioTransportError on spawn failure. */
  start(): void {
    if (this.child) return
    let child: ChildProcessWithoutNullStreams
    try {
      child = this.spawnChild()
    } catch (err) {
      throw new StdioTransportError("spawn_failed", `failed to spawn child: ${errMessage(err)}`)
    }
    this.child = child
    this.dead = false
    this.stdoutBuf = ""
    this.stderrBuf = ""

    child.stdout.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => this.onStdout(chunk))
    // Drain stderr so a chatty child cannot fill the OS pipe and stall, and keep
    // the tail for crash diagnostics.
    child.stderr.setEncoding("utf8")
    child.stderr.on("data", (chunk: string) => this.onStderr(chunk))
    child.on("error", (err) =>
      this.handleProcessGone(new StdioTransportError("process_error", errMessage(err))),
    )
    child.on("exit", (code, signal) =>
      this.handleProcessGone(
        new StdioTransportError(
          "process_exited",
          this.withStderr(`child exited (code=${code ?? "null"} signal=${signal ?? "null"})`),
        ),
      ),
    )
  }

  /** Allocate the next request id. */
  allocId(): number {
    return this.nextId++
  }

  /**
   * Write a pre-encoded JSON-RPC frame. Throws StdioTransportError if the child
   * is gone or its stdin is not writable — callers must NOT silently ignore a
   * failed write, or a peer request will register a pending entry that nothing
   * settles.
   */
  send(line: string): void {
    const child = this.child
    if (this.dead || !child || !child.stdin.writable) {
      throw new StdioTransportError("not_writable", "child stdin is not writable (process gone)")
    }
    child.stdin.write(line + "\n", (err) => {
      if (err) this.handleProcessGone(new StdioTransportError("write_failed", errMessage(err)))
    })
  }

  /**
   * Issue a request and resolve with its result. Rejects immediately if the
   * child is gone, rejects with a JsonRpcResponseError if the server returns an
   * error member, and rejects with a timeout if no response arrives in time.
   */
  request(method: string, params?: unknown): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      if (this.dead || !this.child) {
        reject(new StdioTransportError("not_writable", "child is not running"))
        return
      }
      const id = this.allocId()
      const entry: Pending = { resolve, reject }
      this.pending.set(id, entry)
      if (this.requestTimeoutMs > 0) {
        entry.timer = setTimeout(() => {
          if (!this.pending.delete(id)) return
          reject(new StdioTransportError("request_timeout", `request ${method} timed out after ${this.requestTimeoutMs}ms`))
        }, this.requestTimeoutMs)
        // Do not keep the event loop alive purely for a pending timeout.
        entry.timer.unref?.()
      }
      try {
        this.send(encodeRequest(id, method, params))
      } catch (err) {
        this.settlePending(id)
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }

  /**
   * Reject all pending requests, reset buffers, and kill the child. Idempotent.
   * After shutdown the client is dead and `send`/`request` fail fast.
   */
  shutdown(): void {
    const child = this.child
    this.markDead(new StdioTransportError("shutdown", "client shut down"))
    if (child) {
      child.removeAllListeners()
      try {
        child.kill()
      } catch {
        // best-effort
      }
    }
  }

  /** Recent stderr tail (for diagnostics / tests). */
  stderr(): string {
    return this.stderrBuf
  }

  // -------------------------------------------------------------------------

  private onStdout(chunk: string): void {
    // A dying child can flush buffered stdout after 'exit' fired; dispatching
    // those frames would hit a dead client (and any reply send() would throw
    // inside this stream handler — an uncatchable crash).
    if (this.dead) return
    this.stdoutBuf += chunk
    let nl = this.stdoutBuf.indexOf("\n")
    while (nl !== -1) {
      const line = this.stdoutBuf.slice(0, nl)
      this.stdoutBuf = this.stdoutBuf.slice(nl + 1)
      const trimmed = line.trim()
      if (trimmed.length > 0) this.dispatch(trimmed)
      nl = this.stdoutBuf.indexOf("\n")
    }
  }

  private onStderr(chunk: string): void {
    this.stderrBuf += chunk
    if (this.stderrBuf.length > this.stderrLimit) {
      this.stderrBuf = this.stderrBuf.slice(this.stderrBuf.length - this.stderrLimit)
    }
  }

  private dispatch(line: string): void {
    const msg: InboundMessage | null = parseInbound(line)
    if (!msg) return
    switch (msg.kind) {
      case "response": {
        const entry = this.pending.get(msg.id)
        if (!entry) return
        this.settlePending(msg.id)
        if (msg.error) entry.reject(new JsonRpcResponseError(msg.error))
        else entry.resolve(msg.result)
        return
      }
      case "request":
        this.onServerRequest?.(msg.id, msg.method, msg.params)
        return
      case "notification":
        this.onNotification?.(msg.method, msg.params)
        return
    }
  }

  private settlePending(id: JsonRpcId): void {
    const entry = this.pending.get(id)
    if (!entry) return
    this.pending.delete(id)
    if (entry.timer) clearTimeout(entry.timer)
  }

  private handleProcessGone(err: StdioTransportError): void {
    if (this.dead) return
    this.markDead(err)
    this.onGone?.(err)
  }

  /** Reject every pending request, reset framing state, mark dead. */
  private markDead(err: StdioTransportError): void {
    if (this.dead) return
    this.dead = true
    this.child = null
    // Reset framing state so a future client never parses a corrupt first frame.
    this.stdoutBuf = ""
    const entries = [...this.pending.entries()]
    this.pending.clear()
    for (const [, entry] of entries) {
      if (entry.timer) clearTimeout(entry.timer)
      entry.reject(err)
    }
  }

  private withStderr(message: string): string {
    const tail = this.stderrBuf.trim()
    return tail ? `${message}\n--- stderr (tail) ---\n${tail}` : message
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
