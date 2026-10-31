// The run's side of a remote call: spawn `ssh <target> <omegacode> remote <command>`, write the
// request (and payload), read framed replies, and settle only on the in-band terminal line. The
// SSH exit code is never consulted for success (ADR 0003).

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { createHash } from "node:crypto"
import type { RemoteMachine } from "./machines.js"
import { FrameReader, parseReplyLine, PROTOCOL_VERSION, type RemoteCommand, type ReplyLine } from "./protocol.js"
import type { WorkerProgress } from "../worker/index.js"
import type { AgentUsage } from "../dsl/types.js"

/** Starts the remote helper for one call. Tests substitute a local process. */
export type RemoteTransport = (machine: RemoteMachine, command: RemoteCommand) => ChildProcessWithoutNullStreams

/** SSH options: never prompt, and notice a dead link within about a minute. */
export const SSH_OPTIONS = ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=4"]

export function remoteCommandLine(command: RemoteCommand): string {
  // Run through the remote login shell so the machine's own PATH (mise, ~/.local/bin) applies.
  return `${process.env.OMEGACODE_REMOTE_COMMAND || "omegacode"} remote ${command}`
}

export const sshTransport: RemoteTransport = (machine, command) =>
  spawn("ssh", [...SSH_OPTIONS, machine.ssh, "--", remoteCommandLine(command)], { stdio: ["pipe", "pipe", "pipe"] })

/** A remote call ended without a terminal line, or its framing was broken. */
export class RemoteConnectionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "RemoteConnectionError"
  }
}

/** The helper answered with an `error` line. */
export class RemoteReplyError extends Error {
  readonly code: string
  readonly retryable: boolean
  readonly usage?: AgentUsage
  readonly interrupted: boolean
  constructor(line: Extract<ReplyLine, { t: "error" }>) {
    super(line.message)
    this.name = "RemoteReplyError"
    this.code = line.code
    this.retryable = line.retryable === true
    this.usage = line.usage
    this.interrupted = line.interrupted === true
  }
}

export interface RemoteCallOpts {
  machine: RemoteMachine
  transport: RemoteTransport
  command: RemoteCommand
  request: unknown
  payload?: Buffer
  signal?: AbortSignal
  /** Fail as a lost connection when no terminal line arrives in this long. */
  timeoutMs?: number
  onProgress?: (e: WorkerProgress) => void
  /** Called with each verified raw segment the helper sends. */
  onBytes?: (bytes: Buffer) => void
  /** Grace after an abort line before the SSH process is killed. */
  abortGraceMs?: number
  /** Accept a terminal line from another protocol version (hello only). */
  anyProtocol?: boolean
}

const STDERR_LIMIT = 8 * 1024

/** Run one remote call; resolves with the `done` value. */
export function remoteCall(o: RemoteCallOpts): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const where = `${o.machine.label} (${o.machine.ssh})`
    let child: ChildProcessWithoutNullStreams
    try {
      child = o.transport(o.machine, o.command)
    } catch (err) {
      reject(new RemoteConnectionError(`cannot start ssh to ${where}: ${(err as Error).message}`))
      return
    }
    let settled = false
    let stderr = ""
    let segmentSha: string | undefined
    let killTimer: ReturnType<typeof setTimeout> | undefined
    let deadline: ReturnType<typeof setTimeout> | undefined
    const stderrTail = (): string => {
      const tail = stderr.trim().split("\n").slice(-5).join(" | ")
      return tail ? `; ssh stderr: ${tail}` : ""
    }
    const finish = (err: Error | undefined, value?: unknown): void => {
      if (settled) return
      settled = true
      if (deadline) clearTimeout(deadline)
      o.signal?.removeEventListener("abort", onAbort)
      child.stdin.end()
      if (err) {
        // A failed call must not leave its ssh behind.
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM")
        reject(err)
      } else {
        resolve(value)
      }
    }
    const reader = new FrameReader(
      (line) => {
        const msg = parseReplyLine(line)
        if (!msg || settled) return
        if (msg.ocr !== PROTOCOL_VERSION && !o.anyProtocol) {
          finish(new RemoteConnectionError(`${where} speaks OmegaCode remote protocol ${msg.ocr}; this run needs ${PROTOCOL_VERSION}. Update OmegaCode on that machine.`))
          return
        }
        switch (msg.t) {
          case "progress":
            o.onProgress?.(msg.e)
            break
          case "bytes":
            segmentSha = msg.sha256
            reader.expectBytes(msg.bytes)
            break
          case "done":
            finish(undefined, msg.value)
            break
          case "error":
            finish(new RemoteReplyError(msg))
            break
        }
      },
      (bytes) => {
        const sha = createHash("sha256").update(bytes).digest("hex")
        if (sha !== segmentSha) {
          finish(new RemoteConnectionError(`data from ${where} failed its integrity check`))
          return
        }
        o.onBytes?.(bytes)
      },
    )
    child.stdout.on("data", (chunk: Buffer) => reader.push(chunk))
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-STDERR_LIMIT)
    })
    child.on("error", (err) => finish(new RemoteConnectionError(`ssh to ${where} failed: ${err.message}`)))
    child.on("close", (code, signal) => {
      if (killTimer) clearTimeout(killTimer)
      const truncated = reader.inSegment() ? " in the middle of a data transfer" : ""
      finish(new RemoteConnectionError(
        `connection to ${where} ended${truncated} before the remote ${o.command} reported a result (ssh ${signal ? `signal ${signal}` : `exit ${code}`})${stderrTail()}`,
      ))
    })
    // A closed stdin on the far side must not crash the run.
    child.stdin.on("error", () => {})
    const onAbort = (): void => {
      if (settled) return
      try {
        child.stdin.write(JSON.stringify({ t: "abort" }) + "\n")
        child.stdin.end()
      } catch {
        // already closed
      }
      killTimer ??= setTimeout(() => child.kill("SIGKILL"), o.abortGraceMs ?? 10_000)
      killTimer.unref?.()
    }
    if (o.signal?.aborted) {
      finish(new RemoteConnectionError(`remote ${o.command} on ${where} was aborted before it started`))
      return
    }
    o.signal?.addEventListener("abort", onAbort, { once: true })
    if (o.timeoutMs) {
      deadline = setTimeout(() => finish(new RemoteConnectionError(`no reply from ${where} within ${o.timeoutMs}ms for remote ${o.command}${stderrTail()}`)), o.timeoutMs)
      deadline.unref?.()
    }
    child.stdin.write(JSON.stringify(o.request) + "\n")
    if (o.payload && o.payload.length > 0) child.stdin.write(o.payload)
    // `run` keeps stdin open: closing it is how the helper learns the run gave up.
    if (o.command !== "run") child.stdin.end()
  })
}
