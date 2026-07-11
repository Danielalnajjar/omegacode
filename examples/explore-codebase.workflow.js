// Explore a codebase: map the top-level structure, deep-dive each major area in parallel
// (mixing Codex and Claude Code workers), then synthesize an architecture overview.
//
//   omegacode run examples/explore-codebase.workflow.js --open
//   omegacode run examples/explore-codebase.workflow.js --args '{"dir":"/path/to/repo"}'

export const meta = {
  name: "explore-codebase",
  description: "Map a repo, deep-dive each area in parallel (codex + claude), synthesize an architecture overview.",
  phases: [{ title: "Map" }, { title: "Deep dive" }, { title: "Synthesize" }],
}

const dir = (args && args.dir) || "/Users/sawyerhood/omegacode"

const AREAS_SCHEMA = {
  type: "object",
  required: ["areas"],
  properties: {
    areas: {
      type: "array",
      description: "the 4-6 most important source areas to understand",
      items: {
        type: "object",
        required: ["name", "path", "why"],
        properties: {
          name: { type: "string", description: "short area name" },
          path: { type: "string", description: "directory or file, relative to the repo root" },
          why: { type: "string", description: "what this area is responsible for" },
        },
      },
    },
  },
}

// Phase 1 — map the structure (one Codex agent reads the tree + entry files).
phase("Map")
const map = await agent(
  `Explore the codebase at ${dir}. Read the directory tree and the key entry files (package.json, src/ layout).
Identify the 4-6 most important source areas a new engineer should understand. Return them.`,
  { provider: "codex", model: "gpt-5.6-sol", cwd: dir, sandbox: "read-only", schema: AREAS_SCHEMA, label: "map structure" },
)
log(`mapped ${map.areas.length} areas: ${map.areas.map((a) => a.name).join(", ")}`)

// Phase 2 — deep-dive each area in parallel (alternate providers for variety).
phase("Deep dive")
const digs = await parallel(
  map.areas.map((area, i) => () =>
    agent(
      `Deep-dive the "${area.name}" area (${area.path}) of the codebase at ${dir}. Read its files.
Explain concretely, citing files: what it does, its key files/exports, the important types or functions,
and any notable design choices or gotchas.`,
      {
        provider: i % 2 === 0 ? "codex" : "claude-code",
        model: i % 2 === 0 ? "gpt-5.6-sol" : "claude-fable-5",
        cwd: dir,
        sandbox: "read-only",
        label: `dive: ${area.name}`,
      },
    ).then((text) => ({ area: area.name, path: area.path, notes: text })),
  ),
)

// Phase 3 — synthesize an architecture overview from the deep dives.
phase("Synthesize")
const overview = await agent(
  `You are writing an ARCHITECTURE OVERVIEW of the codebase at ${dir} for a new engineer.
Below are deep-dive notes on each major area (JSON). Write a clear, well-structured Markdown overview:
1. A one-paragraph summary of what the project is and how it is organized.
2. A short section per area: its responsibility and key files.
3. How the pieces fit together (the data / control flow at runtime).
4. Where a newcomer should start reading, in order.

Deep-dive notes:

${JSON.stringify(digs, null, 2)}`,
  { provider: "claude-code", model: "claude-fable-5", cwd: dir, sandbox: "read-only", label: "architecture overview" },
)

return overview
