// JsonRpcStdioClient — owns a single child process speaking newline-delimited
// JSON-RPC 2.0 over stdio. The pending-request lifecycle (ids, timeouts,
// dispatch, settle-on-death) lives in JsonRpcPeer; this file owns only what is
// genuinely stdio's: child lifecycle, stdin writes, stderr draining, and the
// process-death signals that feed the shared invariant.
//
// That invariant: NO pending request outlives its process. Whenever the child
// dies (error/exit) or the client is shut down, every pending request is
// rejected, the input buffer is reset, and `send()`/`request()` thereafter fail
// fast instead of silently dropping writes. This is what makes the codex worker
// proof against the "request registered but nothing ever settles" hang.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"

import { JsonRpcPeer, JsonRpcTransportError } from "./jsonrpc-core.js"
import type { JsonRpcId } from "./codex-protocol.js"

/** Raised for stdio transport failures (process gone, write failed, timeout). */
export class StdioTransportError extends JsonRpcTransportError {
  constructor(code: string, message: string) {
    super(code, message)
    this.name = "StdioTransportError"
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

const DEFAULT_STDERR_LIMIT = 16 * 1024

export class JsonRpcStdioClient extends JsonRpcPeer<StdioTransportError> {
  private child: ChildProcessWithoutNullStreams | null = null
  private stderrBuf = ""

  private readonly spawnChild: SpawnChild
  private readonly stderrLimit: number

  constructor(opts: JsonRpcStdioOptions = {}) {
    super({
      requestTimeoutMs: opts.requestTimeoutMs,
      onServerRequest: opts.onServerRequest,
      onNotification: opts.onNotification,
      onDead: opts.onProcessGone,
    })
    const bin = opts.bin ?? "codex"
    const args = opts.args ?? ["app-server"]
    this.spawnChild = opts.spawnChild ?? (() => spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"] }))
    this.stderrLimit = opts.stderrLimit ?? DEFAULT_STDERR_LIMIT
  }

  /** True once the child is spawned and not yet known dead. */
  get alive(): boolean {
    return !this.dead && this.child !== null
  }

  /**
   * Spawn the child and wire its streams. Throws StdioTransportError on spawn
   * failure. A client is single-use: once its child is gone the client stays
   * dead, and the owner constructs a new one (CodexWorker already does).
   */
  start(): void {
    if (this.child) return
    if (this.dead) {
      throw new StdioTransportError("not_writable", "client is dead; construct a new JsonRpcStdioClient")
    }
    let child: ChildProcessWithoutNullStreams
    try {
      child = this.spawnChild()
    } catch (err) {
      throw new StdioTransportError("spawn_failed", `failed to spawn child: ${errMessage(err)}`)
    }
    this.child = child
    this.stderrBuf = ""

    child.stdout.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => this.ingest(chunk))
    // Drain stderr so a chatty child cannot fill the OS pipe and stall, and keep
    // the tail for crash diagnostics.
    child.stderr.setEncoding("utf8")
    child.stderr.on("data", (chunk: string) => this.onStderr(chunk))
    child.on("error", (err) =>
      this.handleGone(new StdioTransportError("process_error", errMessage(err))),
    )
    child.on("exit", (code, signal) =>
      this.handleGone(
        new StdioTransportError(
          "process_exited",
          this.withStderr(`child exited (code=${code ?? "null"} signal=${signal ?? "null"})`),
        ),
      ),
    )
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

  protected writeLine(line: string): void {
    const child = this.child
    if (this.dead || !child || !child.stdin.writable) {
      throw new StdioTransportError("not_writable", "child stdin is not writable (process gone)")
    }
    child.stdin.write(line + "\n", (err) => {
      if (err) this.handleGone(new StdioTransportError("write_failed", errMessage(err)))
    })
  }

  protected transportError(code: string, message: string): StdioTransportError {
    return new StdioTransportError(code, message)
  }

  protected override releaseTransport(): void {
    this.child = null
  }

  private onStderr(chunk: string): void {
    this.stderrBuf += chunk
    if (this.stderrBuf.length > this.stderrLimit) {
      this.stderrBuf = this.stderrBuf.slice(this.stderrBuf.length - this.stderrLimit)
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
