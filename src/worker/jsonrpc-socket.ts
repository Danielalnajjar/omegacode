// JsonRpcSocketClient — owns one unix-socket connection speaking newline-delimited
// JSON-RPC 2.0: connection lifecycle, framing, pending requests, and timeouts.
//
// The load-bearing invariant matches JsonRpcStdioClient: NO pending request
// outlives its transport. Connection loss rejects every pending request, resets
// framing state, and makes all subsequent sends fail fast.

import { createConnection, type Socket } from "node:net"

import {
  encodeNotification,
  encodeRequest,
  parseInbound,
  type InboundMessage,
  type JsonRpcError,
  type JsonRpcId,
} from "./codex-protocol.js"

/** Raised for transport-level failures (connection gone, write failed, timeout). */
export class SocketTransportError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = "SocketTransportError"
    this.code = code
  }
}

/** Raised when a JSON-RPC response carries an `error` member. */
export class SocketRpcResponseError extends Error {
  readonly rpc: JsonRpcError
  constructor(rpc: JsonRpcError) {
    super(rpc.message)
    this.name = "SocketRpcResponseError"
    this.rpc = rpc
  }
}

export interface JsonRpcSocketOptions {
  socketPath: string
  /** Per-request timeout in ms (0/undefined disables). */
  requestTimeoutMs?: number
  onNotification?: (method: string, params: unknown) => void
  /** The connection died. Called once; pending requests are already rejected. */
  onConnectionGone?: (err: SocketTransportError) => void
}

interface Pending {
  resolve: (result: unknown) => void
  reject: (err: Error) => void
  timer?: ReturnType<typeof setTimeout>
}

export class JsonRpcSocketClient {
  private socket: Socket | null = null
  private inputBuf = ""
  private nextId = 1
  private readonly pending = new Map<JsonRpcId, Pending>()
  private connected = false
  private dead = false
  private readonly ready: Promise<void>

  private readonly requestTimeoutMs: number
  private readonly onNotification?: (method: string, params: unknown) => void
  private readonly onGone?: (err: SocketTransportError) => void

  constructor(opts: JsonRpcSocketOptions) {
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 0
    this.onNotification = opts.onNotification
    this.onGone = opts.onConnectionGone
    this.ready = this.connect(opts.socketPath)
  }

  request(method: string, params?: unknown): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      if (this.dead) {
        reject(new SocketTransportError("not_writable", "socket is not connected"))
        return
      }
      const id = this.nextId++
      const entry: Pending = { resolve, reject }
      this.pending.set(id, entry)
      if (this.requestTimeoutMs > 0) {
        entry.timer = setTimeout(() => {
          if (!this.pending.delete(id)) return
          reject(new SocketTransportError("request_timeout", `request ${method} timed out after ${this.requestTimeoutMs}ms`))
        }, this.requestTimeoutMs)
        entry.timer.unref?.()
      }
      void this.ready.then(
        () => this.write(encodeRequest(id, method, params)),
        (err: unknown) => {
          if (!this.pending.has(id)) return
          this.settlePending(id)
          reject(err instanceof Error ? err : new Error(String(err)))
        },
      ).catch((err: unknown) => {
        if (!this.pending.has(id)) return
        this.settlePending(id)
        reject(err instanceof Error ? err : new Error(String(err)))
      })
    })
  }

  notify(method: string, params?: unknown): void {
    if (this.dead) throw new SocketTransportError("not_writable", "socket is not connected")
    void this.ready.then(() => this.write(encodeNotification(method, params))).catch(() => {
      // Connection/write failure is surfaced to every pending request by markDead.
    })
  }

  close(): void {
    const socket = this.socket
    this.markDead(new SocketTransportError("shutdown", "client closed"))
    if (socket) {
      socket.removeAllListeners()
      socket.destroy()
    }
  }

  private connect(socketPath: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const socket = createConnection(socketPath)
      this.socket = socket
      socket.setEncoding("utf8")
      socket.on("data", (chunk: string) => this.onData(chunk))
      socket.once("connect", () => {
        if (this.dead) return
        this.connected = true
        resolve()
      })
      socket.on("error", (err) => {
        const transport = new SocketTransportError("connection_error", err.message)
        if (!this.connected) reject(transport)
        this.handleConnectionGone(transport)
      })
      socket.on("close", () => {
        this.handleConnectionGone(new SocketTransportError("connection_closed", "socket connection closed"))
      })
    })
  }

  private write(line: string): void {
    const socket = this.socket
    if (this.dead || !this.connected || !socket || !socket.writable) {
      const err = new SocketTransportError("not_writable", "socket is not writable (connection gone)")
      this.handleConnectionGone(err)
      throw err
    }
    socket.write(line + "\n", (err) => {
      if (err) this.handleConnectionGone(new SocketTransportError("write_failed", err.message))
    })
  }

  private onData(chunk: string): void {
    if (this.dead) return
    this.inputBuf += chunk
    let nl = this.inputBuf.indexOf("\n")
    while (nl !== -1) {
      const line = this.inputBuf.slice(0, nl).trim()
      this.inputBuf = this.inputBuf.slice(nl + 1)
      if (line.length > 0) this.dispatch(line)
      nl = this.inputBuf.indexOf("\n")
    }
  }

  private dispatch(line: string): void {
    const msg: InboundMessage | null = parseInbound(line)
    if (!msg) return
    if (msg.kind === "notification") {
      this.onNotification?.(msg.method, msg.params)
      return
    }
    if (msg.kind !== "response") return
    const entry = this.pending.get(msg.id)
    if (!entry) return
    this.settlePending(msg.id)
    if (msg.error) entry.reject(new SocketRpcResponseError(msg.error))
    else entry.resolve(msg.result)
  }

  private settlePending(id: JsonRpcId): void {
    const entry = this.pending.get(id)
    if (!entry) return
    this.pending.delete(id)
    if (entry.timer) clearTimeout(entry.timer)
  }

  private handleConnectionGone(err: SocketTransportError): void {
    if (this.dead) return
    this.markDead(err)
    this.onGone?.(err)
  }

  private markDead(err: SocketTransportError): void {
    if (this.dead) return
    this.dead = true
    this.connected = false
    this.socket = null
    this.inputBuf = ""
    const entries = [...this.pending.values()]
    this.pending.clear()
    for (const entry of entries) {
      if (entry.timer) clearTimeout(entry.timer)
      entry.reject(err)
    }
  }
}
