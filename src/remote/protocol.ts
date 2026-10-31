// Wire format between a run and `omegacode remote <command>` on another machine (ADR 0003).
//
// Requests: one JSON line on stdin, then the raw bytes the request declares (`payloadBytes`), then,
// for `run` and `prepare`, control lines such as {"t":"abort"}. The run keeps their stdin open
// until it has the reply, so EOF there means the run gave up and aborts them.
// Replies: JSON lines on stdout, each tagged `ocr: PROTOCOL_VERSION` so a stray line from a login
// shell can never be mistaken for one. A `bytes` line is followed by exactly that many raw bytes.
// Every call ends with exactly one `done` or `error` line; a stream that ends without one is a lost
// connection, whatever the SSH exit code says (Tailscale SSH exits 0 regardless).

import type { AgentResult, AgentSpec, AgentUsage } from "../dsl/types.js"
import type { WorkerProgress } from "../worker/index.js"

export const PROTOCOL_VERSION = 1

export const REMOTE_COMMANDS = ["hello", "have", "prepare", "run", "collect", "cleanup"] as const
export type RemoteCommand = (typeof REMOTE_COMMANDS)[number]

export interface HaveRequest { repoKey: string }
/** Commit ids at the cache's ref tips, newest first; the run negates the ones it has. */
export interface HaveReply { tips: string[] }

export interface PrepareRequest {
  repoKey: string
  /** This attempt's worktree name, `<runId>-<index>-<nonce>`; its internal branch is `omegacode/<name>`. */
  name: string
  base: string
  /** When the run took its branch snapshot; the machine applies a manifest only if it is newer. */
  generation: number
  /** The run repository's branches: the cache's branches are set to these, so names resolve there. */
  branches: Record<string, string>
  /** Bundle bytes following this line (0 when the machine already has every object). */
  payloadBytes: number
  payloadSha256?: string
}
export interface PrepareReply { path: string }

export interface RunRequest {
  spec: AgentSpec
  /** Worktree name, so `collect` can stop a run still going in it. */
  name: string
  fake: boolean
  claudeModel?: string
  /** What is left of the agent's time limit; the machine stops the turn when it runs out. */
  timeoutMs?: number
}
export interface RunReply { result: AgentResult }

export interface CollectRequest { repoKey: string; name: string; base: string; index: number }
/** `changed` replies are preceded by a `bytes` line carrying a bundle of `ref` minus the base. */
export interface CollectReply { changed: boolean; head?: string; ref?: string; snapshot?: boolean }

export interface CleanupRequest { repoKey: string; name: string }

export interface HelloReply {
  protocol: number
  version: string
  /** `buildId()` of the helper's code; the run refuses a machine whose build differs. */
  build: string
  platform: string
  hostId?: string
}

/**
 * The request fields each command understands. The helper refuses any other field, so a request
 * from a newer build can never lose a restriction the older helper would silently drop.
 */
export const REQUEST_KEYS: Record<RemoteCommand, readonly string[]> = {
  hello: [],
  have: ["repoKey"],
  prepare: ["repoKey", "name", "base", "generation", "branches", "payloadBytes", "payloadSha256"],
  run: ["spec", "name", "fake", "claudeModel", "timeoutMs"],
  collect: ["repoKey", "name", "base", "index"],
  cleanup: ["repoKey", "name"],
} satisfies { [C in RemoteCommand]: readonly (keyof RequestOf<C> & string)[] }

type RequestOf<C extends RemoteCommand> = {
  hello: Record<string, never>
  have: HaveRequest
  prepare: PrepareRequest
  run: RunRequest
  collect: CollectRequest
  cleanup: CleanupRequest
}[C]

/** Every AgentSpec field; the compile-time check below fails when a new field is not listed. */
export const AGENT_SPEC_KEYS = [
  "prompt", "provider", "model", "effort", "cwd", "sandbox", "approval", "instructions", "schema", "maxTurns",
  "serviceTier", "codexExecutionProfile", "museExecutionProfile", "claudeAgent", "grokAgent", "claudeProfile",
  "codexChildRole", "codexWebSearch", "codexNetworkAccess", "codexMcpServers", "codexPlugins", "codexPermissions",
] as const satisfies readonly (keyof AgentSpec)[]
type UnlistedSpecKey = Exclude<keyof AgentSpec, (typeof AGENT_SPEC_KEYS)[number]>
const allSpecKeysListed: [UnlistedSpecKey] extends [never] ? true : UnlistedSpecKey = true
void allSpecKeysListed

/** Fields of `value` not in `allowed`. */
export function unknownKeys(value: unknown, allowed: readonly string[]): string[] {
  if (!value || typeof value !== "object") return []
  return Object.keys(value).filter((key) => !allowed.includes(key))
}

/** A reply line before the protocol tag is added. */
export type ReplyBody = ReplyLine extends infer L ? (L extends unknown ? Omit<L, "ocr"> : never) : never

export type ReplyLine =
  | { ocr: number; t: "progress"; e: WorkerProgress }
  | { ocr: number; t: "bytes"; bytes: number; sha256: string }
  | { ocr: number; t: "done"; value: unknown }
  | { ocr: number; t: "error"; code: string; message: string; retryable?: boolean; usage?: AgentUsage; interrupted?: boolean }

/**
 * Splits a byte stream into JSON lines and declared raw-byte segments. `expectBytes(n)` switches the
 * next n bytes to a raw segment; framing resumes after it. Used on both ends of the connection.
 */
export class FrameReader {
  private buf: Buffer = Buffer.alloc(0)
  private pendingBytes = 0
  private segment: Buffer[] = []
  private segmentLength = 0

  constructor(
    private readonly onLine: (line: string) => void,
    private readonly onBytes: (bytes: Buffer) => void,
  ) {}

  expectBytes(n: number): void {
    this.pendingBytes = n
    this.segment = []
    this.segmentLength = 0
    if (n === 0) this.onBytes(Buffer.alloc(0))
  }

  /** True while a declared raw segment is still incomplete. */
  inSegment(): boolean {
    return this.pendingBytes > 0
  }

  push(chunk: Buffer): void {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk])
    while (this.buf.length > 0) {
      if (this.pendingBytes > 0) {
        const take = Math.min(this.pendingBytes, this.buf.length)
        this.segment.push(this.buf.subarray(0, take))
        this.segmentLength += take
        this.pendingBytes -= take
        this.buf = this.buf.subarray(take)
        if (this.pendingBytes === 0) {
          const bytes = Buffer.concat(this.segment, this.segmentLength)
          this.segment = []
          this.onBytes(bytes)
        }
        continue
      }
      const nl = this.buf.indexOf(0x0a)
      if (nl < 0) return
      const line = this.buf.subarray(0, nl).toString("utf8")
      this.buf = this.buf.subarray(nl + 1)
      // onLine may call expectBytes, which takes effect for the bytes that follow this line.
      this.onLine(line)
    }
  }
}

/** Parse a reply line; undefined for anything that is not a protocol line. */
export function parseReplyLine(line: string): ReplyLine | undefined {
  const trimmed = line.trim()
  if (!trimmed.startsWith("{")) return undefined
  try {
    const value = JSON.parse(trimmed) as { ocr?: unknown; t?: unknown }
    if (typeof value?.ocr !== "number" || typeof value.t !== "string") return undefined
    return value as ReplyLine
  } catch {
    return undefined
  }
}
