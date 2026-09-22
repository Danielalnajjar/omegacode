/** Resolve opt-in run modes without treating an omitted resume flag as a new denial. */
export interface RunModes {
  fake: boolean
  typesafe: boolean
}

export interface RequestedRunModes {
  fake?: boolean
  typesafe?: boolean
}

export function resolveRunModes(
  requested: RequestedRunModes,
  recorded: RequestedRunModes | undefined,
  resuming: boolean,
): RunModes {
  for (const key of ["fake", "typesafe"] as const) {
    if (requested[key] !== undefined && typeof requested[key] !== "boolean") {
      throw new Error(`invalid --${key}: expected a boolean`)
    }
    if (resuming && recorded && Object.hasOwn(recorded, key) && typeof recorded[key] !== "boolean") {
      throw new Error(`cannot resume: invalid recorded --${key}`)
    }
  }
  if (!resuming) return { fake: requested.fake ?? false, typesafe: requested.typesafe ?? false }

  // Legacy journals never granted TypeSafe access. Do not introduce source disclosure
  // while resuming one, even though their fake/live choice was historically unpinned.
  const typesafe = recorded?.typesafe ?? false
  if (requested.typesafe !== undefined && requested.typesafe !== typesafe) {
    throw new Error("cannot resume: explicit --typesafe must match the original run")
  }
  const hasRecordedFake = recorded !== undefined && Object.hasOwn(recorded, "fake")
  const fake = hasRecordedFake ? recorded.fake! : requested.fake ?? false
  if (hasRecordedFake && requested.fake !== undefined && requested.fake !== fake) {
    throw new Error("cannot resume: explicit --fake must match the original run")
  }
  return { fake, typesafe }
}
