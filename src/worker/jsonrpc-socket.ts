// JsonRpcSocketClient — owns one unix-socket connection speaking newline-delimited
// JSON-RPC 2.0. The pending-request lifecycle (ids, timeouts, dispatch,
// settle-on-death) lives in JsonRpcPeer; this file owns only what is genuinely
// the socket's: dialing, socket writes, and the connection-death signals that
// feed the shared invariant.
//
// That invariant matches JsonRpcStdioClient: NO pending request outlives its
// transport. Connection loss rejects every pending request, resets framing
// state, and makes all subsequent sends fail fast.

import { createConnection, type Socket } from "node:net"

import { JsonRpcPeer, JsonRpcTransportError } from "./jsonrpc-core.js"
import type { JsonRpcId } from "./codex-protocol.js"

/** Raised for socket transport failures (connection gone, write failed, timeout). */
export class SocketTransportError extends JsonRpcTransportError {
  constructor(code: string, message: string) {
    super(code, message)
    this.name = "SocketTransportError"
  }
}

export interface JsonRpcSocketOptions {
  socketPath: string
  /** Per-request timeout in ms (0/undefined disables). */
  requestTimeoutMs?: number
  /** Inbound server-initiated request (the server expects a response by id). */
  onServerRequest?: (id: JsonRpcId, method: string, params: unknown) => void
  onNotification?: (method: string, params: unknown) => void
  /** The connection died. Called once; pending requests are already rejected. */
  onConnectionGone?: (err: SocketTransportError) => void
}

export class JsonRpcSocketClient extends JsonRpcPeer<SocketTransportError> {
  private socket: Socket | null = null
  private connected = false
  private readonly ready: Promise<void>

  constructor(opts: JsonRpcSocketOptions) {
    super({
      requestTimeoutMs: opts.requestTimeoutMs,
      onServerRequest: opts.onServerRequest,
      onNotification: opts.onNotification,
      onDead: opts.onConnectionGone,
    })
    this.ready = this.connect(opts.socketPath)
    // A failed dial is already surfaced through onConnectionGone and through
    // every pending request; an unobserved `ready` must not also crash the
    // process with an unhandled rejection.
    void this.ready.catch(() => {})
  }

  /** Reject all pending requests and destroy the socket. Idempotent. */
  close(): void {
    const socket = this.socket
    this.markDead(new SocketTransportError("shutdown", "client closed"))
    if (socket) {
      socket.removeAllListeners()
      socket.destroy()
    }
  }

  // -------------------------------------------------------------------------

  /** The connection is dialed lazily, so a request issued before 'connect'
   *  waits for it; a failed dial rejects that request. */
  protected override deliver(line: string): Promise<void> {
    return this.ready.then(() => this.writeLine(line))
  }

  protected writeLine(line: string): void {
    const socket = this.socket
    if (this.dead || !this.connected || !socket || !socket.writable) {
      throw new SocketTransportError("not_writable", "socket is not writable (connection gone)")
    }
    socket.write(line + "\n", (err) => {
      if (err) this.handleGone(new SocketTransportError("write_failed", err.message))
    })
  }

  protected transportError(code: string, message: string): SocketTransportError {
    return new SocketTransportError(code, message)
  }

  protected override releaseTransport(): void {
    this.connected = false
    this.socket = null
  }

  private connect(socketPath: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const socket = createConnection(socketPath)
      this.socket = socket
      socket.setEncoding("utf8")
      socket.on("data", (chunk: string) => this.ingest(chunk))
      socket.once("connect", () => {
        if (this.dead) return
        this.connected = true
        resolve()
      })
      socket.on("error", (err) => {
        const transport = new SocketTransportError("connection_error", err.message)
        if (!this.connected) reject(transport)
        this.handleGone(transport)
      })
      socket.on("close", () => {
        this.handleGone(new SocketTransportError("connection_closed", "socket connection closed"))
      })
    })
  }
}
