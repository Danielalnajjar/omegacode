// JsonRpcPeer — the transport-independent half of omegacode's newline-delimited
// JSON-RPC 2.0 clients (a codex child process over stdio, the Amp plugin over a
// unix socket).
//
// The load-bearing invariant lives HERE, exactly once: NO pending request
// outlives its transport. Id allocation, the pending map, per-request timeouts,
// inbound framing and dispatch, and death propagation are owned by this class;
// a transport supplies only line writing, death detection, its own error type,
// and whatever extras are genuinely its own (stdio's stderr ring buffer). The
// two clients used to carry private copies of all of it, and the copies drifted.

import {
  encodeNotification,
  encodeRequest,
  parseInbound,
  type InboundMessage,
  type JsonRpcError,
  type JsonRpcId,
} from "./codex-protocol.js"

/** Base for transport-level failures (peer gone, write failed, timeout). Each
 *  transport names itself and owns its own `code` vocabulary — a spawn failure
 *  and a failed dial are not the same fault. */
export abstract class JsonRpcTransportError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

/** Raised when a JSON-RPC response carries an `error` member. Transport-agnostic
 *  on purpose: an error member means the peer answered, so it is never a
 *  transport fault and callers classify it the same way on every transport. */
export class JsonRpcResponseError extends Error {
  readonly rpc: JsonRpcError
  constructor(rpc: JsonRpcError) {
    super(rpc.message)
    this.name = "JsonRpcResponseError"
    this.rpc = rpc
  }
}

export interface JsonRpcPeerOptions<E extends JsonRpcTransportError> {
  /** Per-request timeout in ms (0/undefined disables). Rejects the request and is retryable. */
  requestTimeoutMs?: number
  /** Inbound server-initiated request (the server expects a response by id). */
  onServerRequest?: (id: JsonRpcId, method: string, params: unknown) => void
  /** Inbound notification (no response expected). */
  onNotification?: (method: string, params: unknown) => void
  /** The transport died. Called once per death; pending requests are already rejected. */
  onDead?: (err: E) => void
}

interface Pending {
  resolve: (result: unknown) => void
  reject: (err: Error) => void
  timer?: ReturnType<typeof setTimeout>
}

export abstract class JsonRpcPeer<E extends JsonRpcTransportError> {
  private inputBuf = ""
  private nextId = 1
  private readonly pending = new Map<JsonRpcId, Pending>()
  private isDead = false

  private readonly requestTimeoutMs: number
  private readonly onServerRequest?: (id: JsonRpcId, method: string, params: unknown) => void
  private readonly onNotification?: (method: string, params: unknown) => void
  private readonly onDead?: (err: E) => void

  protected constructor(opts: JsonRpcPeerOptions<E> = {}) {
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 0
    this.onServerRequest = opts.onServerRequest
    this.onNotification = opts.onNotification
    this.onDead = opts.onDead
  }

  /** True once the transport is known gone (death or shutdown). Terminal. */
  protected get dead(): boolean {
    return this.isDead
  }

  // ---------------------------------------------------------------------------
  // Transport contract
  // ---------------------------------------------------------------------------

  /**
   * Write one framed line NOW. MUST throw this transport's error when the peer
   * cannot accept it — a silently dropped frame is how a request registers a
   * pending entry that nothing ever settles.
   */
  protected abstract writeLine(line: string): void

  /** Build this transport's error type. */
  protected abstract transportError(code: string, message: string): E

  /** Drop the underlying handle. Called once, inside markDead, before pending
   *  requests are rejected. */
  protected releaseTransport(): void {}

  /**
   * Deliver a request frame. The default writes immediately; a transport that
   * dials asynchronously overrides this to gate on readiness, and the returned
   * promise's rejection settles that one request.
   */
  protected deliver(line: string): void | Promise<void> {
    this.writeLine(line)
  }

  // ---------------------------------------------------------------------------
  // Outbound
  // ---------------------------------------------------------------------------

  /** Allocate the next request id. */
  allocId(): number {
    return this.nextId++
  }

  /** Write a pre-encoded frame. Throws when the transport is not writable. */
  send(line: string): void {
    this.writeLine(line)
  }

  /** Send a notification (no response expected). Throws when the transport is
   *  not writable — a dropped notification is a lost cancel, not a no-op. */
  notify(method: string, params?: unknown): void {
    this.writeLine(encodeNotification(method, params))
  }

  /**
   * Issue a request and resolve with its result. Rejects immediately if the
   * transport is already gone, rejects with a JsonRpcResponseError if the peer
   * returns an error member, and rejects with a timeout if no response arrives.
   */
  request(method: string, params?: unknown): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      if (this.isDead) {
        reject(this.transportError("not_writable", `cannot send ${method}: transport is gone`))
        return
      }
      const id = this.allocId()
      const entry: Pending = { resolve, reject }
      this.pending.set(id, entry)
      if (this.requestTimeoutMs > 0) {
        entry.timer = setTimeout(() => {
          if (!this.pending.delete(id)) return
          reject(this.transportError("request_timeout", `request ${method} timed out after ${this.requestTimeoutMs}ms`))
        }, this.requestTimeoutMs)
        // Do not keep the event loop alive purely for a pending timeout.
        entry.timer.unref?.()
      }
      const fail = (err: unknown): void => {
        if (!this.pending.has(id)) return
        this.settlePending(id)
        reject(err instanceof Error ? err : new Error(String(err)))
      }
      let delivery: void | Promise<void>
      try {
        delivery = this.deliver(encodeRequest(id, method, params))
      } catch (err) {
        fail(err)
        return
      }
      if (delivery) void delivery.catch(fail)
    })
  }

  // ---------------------------------------------------------------------------
  // Inbound
  // ---------------------------------------------------------------------------

  /** Feed raw inbound bytes; splits newline-delimited frames and dispatches them. */
  protected ingest(chunk: string): void {
    // A dying transport can flush buffered bytes after its death event; dispatching
    // those frames would hit a dead peer (and any reply send() would throw inside
    // the stream handler — an uncatchable crash).
    if (this.isDead) return
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

  // ---------------------------------------------------------------------------
  // Death
  // ---------------------------------------------------------------------------

  /** The transport died on its own: mark dead once, then tell the owner. */
  protected handleGone(err: E): void {
    if (this.isDead) return
    this.markDead(err)
    this.onDead?.(err)
  }

  /** Reject every pending request, reset framing state, release the transport,
   *  and mark dead. Idempotent; death is terminal. */
  protected markDead(err: E): void {
    if (this.isDead) return
    this.isDead = true
    // Reset framing state so a future peer never parses a corrupt first frame.
    this.inputBuf = ""
    this.releaseTransport()
    const entries = [...this.pending.values()]
    this.pending.clear()
    for (const entry of entries) {
      if (entry.timer) clearTimeout(entry.timer)
      entry.reject(err)
    }
  }
}
