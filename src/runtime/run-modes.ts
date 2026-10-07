/** Resolve opt-in run modes without treating an omitted resume flag as a new denial. */
export interface RunModes {
  fake: boolean
}

export interface RequestedRunModes {
  fake?: boolean
}

export function resolveRunModes(
  requested: RequestedRunModes,
  recorded: RequestedRunModes | undefined,
  resuming: boolean,
): RunModes {
  if (requested.fake !== undefined && typeof requested.fake !== "boolean") {
    throw new Error("invalid --fake: expected a boolean")
  }
  if (resuming && recorded && Object.hasOwn(recorded, "fake") && typeof recorded.fake !== "boolean") {
    throw new Error("cannot resume: invalid recorded --fake")
  }
  if (!resuming) return { fake: requested.fake ?? false }

  // Legacy journals did not pin their fake/live choice, so the resume request decides it.
  const hasRecordedFake = recorded !== undefined && Object.hasOwn(recorded, "fake")
  const fake = hasRecordedFake ? recorded.fake! : requested.fake ?? false
  if (hasRecordedFake && requested.fake !== undefined && requested.fake !== fake) {
    throw new Error("cannot resume: explicit --fake must match the original run")
  }
  return { fake }
}
