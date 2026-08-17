import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { runDir } from "./journal.js"

export const BB_ORIGIN_FILENAME = "bb-origin.json"

export interface BbRunOrigin {
  schemaVersion: 1
  threadId: string
  projectId: string | null
  environmentId: string | null
  capturedAt: number
}

/**
 * Persist the bb thread that launched this run when Omega Code inherits bb's
 * standard thread environment. The file is create-only so a resume from a
 * different thread cannot reassign the run's original owner.
 */
export function writeBbOrigin(
  runId: string,
  capturedAt: number,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const threadId = nonEmpty(env.BB_THREAD_ID)
  if (!threadId) return

  const origin: BbRunOrigin = {
    schemaVersion: 1,
    threadId,
    projectId: nonEmpty(env.BB_PROJECT_ID),
    environmentId: nonEmpty(env.BB_ENVIRONMENT_ID),
    capturedAt,
  }

  try {
    writeFileSync(
      join(runDir(runId), BB_ORIGIN_FILENAME),
      `${JSON.stringify(origin, null, 2)}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    )
  } catch (error) {
    if (isAlreadyPresent(error)) return
    // Attribution augments observability; it must never prevent the workflow.
    process.stderr.write(
      `warning: could not write ${BB_ORIGIN_FILENAME} for ${runId}: ${errorMessage(error)}\n`,
    )
  }
}

function nonEmpty(value: string | undefined): string | null {
  const normalized = value?.trim()
  return normalized ? normalized : null
}

function isAlreadyPresent(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST"
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
