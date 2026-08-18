// Packaging contract tests (findings M31, L18, L19).
//
// These assert the PUBLISHED package is real for TypeScript consumers: dts ships, the exports map has
// a "types" condition and a self-contained "./ambient" subpath, the Effort union carries codex's
// "none" level, and the build pipeline is portable (no POSIX-only rm/cp, one coherent package-manager
// story). The pack-contract test runs in an isolated temp package so it is immune to the transient
// type errors other agents introduce while editing the runtime mid-sweep.

import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { after, before, describe, test } from "node:test"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const read = (rel: string) => readFileSync(join(root, rel), "utf8")
const pkg = JSON.parse(read("package.json")) as Record<string, any>

/** Run `pnpm <args>` portably: on Windows pnpm is pnpm.cmd, which only spawns through a shell. */
function pnpm(args: string[], cwd: string): string {
  const win = process.platform === "win32"
  return execFileSync(win ? "pnpm.cmd" : "pnpm", args, { cwd, encoding: "utf8", shell: win })
}

function packEntries(stdout: string): Array<{ path: string }> {
  const parsed = JSON.parse(stdout)
  return (Array.isArray(parsed) ? parsed[0] : parsed).files as Array<{ path: string }>
}

describe("exports / types map (M31)", () => {
  test("declares a top-level types entry", () => {
    assert.equal(pkg.types, "./dist/index.d.ts")
  })

  test('"." export carries a types condition pointing at the dts', () => {
    const dot = pkg.exports["."]
    assert.equal(typeof dot, "object", '"." export must be a conditions object, not a bare string')
    assert.equal(dot.types, "./dist/index.d.ts")
    assert.equal(dot.default, "./dist/index.js")
  })

  test('"./ambient" subpath export exists and points at a dts in dist', () => {
    const amb = pkg.exports["./ambient"]
    assert.ok(amb, '"./ambient" export is missing — /// <reference types="omegacode/ambient" /> is dead')
    assert.equal(amb.types, "./dist/ambient.d.ts")
  })

  test("files whitelist ships dist (and LICENSE) but not src", () => {
    assert.ok(pkg.files.includes("dist"), "dist must be in files")
    assert.ok(pkg.files.includes("LICENSE"), "LICENSE must be in files")
    assert.ok(
      !pkg.files.some((f: string) => f.startsWith("src/")),
      "must not ship src/ files (ambient ships as dist/ambient.d.ts)",
    )
  })
})

describe("ambient d.ts is self-contained (M31)", () => {
  const ambient = read("src/dsl/ambient.d.ts")

  test("compiles standalone with tsc (no resolvable-only-in-repo imports)", () => {
    // Copy the d.ts alone into a temp dir and typecheck a consumer of its globals there. If it
    // imported ./types.js (the original bug) tsc would fail with a module-resolution error.
    const work = mkdtempSync(join(tmpdir(), "omega-ambient-"))
    try {
      writeFileSync(join(work, "ambient.d.ts"), ambient)
      writeFileSync(
        join(work, "user.ts"),
        [
          '/// <reference path="./ambient.d.ts" />',
          "const f = async () => {",
          '  const text = await agent("hi", { provider: "codex", model: "gpt-5.5", effort: "none", worktree: true })',
          "  // @ts-expect-error — provider without model violates the both-or-neither pair type",
          '  void agent("hi", { provider: "codex" })',
          "  // @ts-expect-error — model without provider violates the both-or-neither pair type",
          '  void agent("hi", { model: "gpt-5.5" })',
          "  log(text)",
          '  const xs = await parallel([() => agent("a"), () => agent("b")])',
          '  await pipeline(xs, (prev, item, i) => String(prev) + String(item) + i)',
          '  phase("p")',
          "  return now() + random() + budget.remaining() + Number(budget.total) + xs.length",
          "}",
          "void f",
          "void args",
          "export {}",
        ].join("\n"),
      )
      writeFileSync(
        join(work, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: {
            noEmit: true,
            strict: true,
            target: "es2022",
            // No @types auto-include: the d.ts must stand entirely on its own.
            types: [],
          },
          files: ["ambient.d.ts", "user.ts"],
        }),
      )
      const tsc = join(root, "node_modules", "typescript", "bin", "tsc")
      execFileSync(process.execPath, [tsc, "-p", join(work, "tsconfig.json")], { stdio: "pipe", cwd: work })
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  })

  test("has zero imports / re-exports (would be unresolvable in the tarball)", () => {
    for (const raw of ambient.split("\n")) {
      const code = raw.replace(/\/\/.*/, "").trim()
      assert.ok(!/^import\b/.test(code), `unexpected import in ambient.d.ts: ${raw.trim()}`)
      assert.ok(!/\brequire\s*\(/.test(code), `unexpected require in ambient.d.ts: ${raw.trim()}`)
      assert.ok(
        !/^export\b.*\bfrom\b/.test(code),
        `unexpected re-export in ambient.d.ts: ${raw.trim()}`,
      )
    }
  })

  test("declares the injected globals authors rely on", () => {
    for (const g of [
      "function agent",
      "function parallel",
      "function pipeline",
      "function phase",
      "function log",
      "function now",
      "function random",
      "const budget",
      "const args",
    ]) {
      assert.ok(ambient.includes(g), `ambient.d.ts missing global: ${g}`)
    }
  })

  test("keeps the editor-reference doc line", () => {
    assert.ok(ambient.includes('reference types="omegacode/ambient"'))
  })

  test("inlines the option types (no dependency on ./types) including the none effort (L18)", () => {
    assert.ok(ambient.includes("OmegacodeAgentOpts"))
    assert.match(ambient, /OmegacodeEffort\s*=\s*"none"/)
  })
})

describe('Effort union includes codex "none" (L18)', () => {
  test("declared in dsl/types.ts", () => {
    const types = read("src/dsl/types.ts")
    const m = types.match(/export type Effort\s*=\s*([^\n]+)/)
    assert.ok(m, "Effort type not found in dsl/types.ts")
    const members = m![1]
    for (const lvl of ["none", "minimal", "low", "medium", "high", "xhigh", "max"]) {
      assert.match(members, new RegExp(`"${lvl}"`), `Effort missing "${lvl}"`)
    }
  })
})

describe("ambient inlined types stay in sync with dsl/types.ts (M31 drift guard)", () => {
  const types = read("src/dsl/types.ts")
  const ambient = read("src/dsl/ambient.d.ts")

  const unionMembers = (src: string, name: string) => {
    const m = src.match(new RegExp(`(?:export )?type ${name}\\s*=\\s*([^\\n]+)`))
    assert.ok(m, `union ${name} not found`)
    return [...m![1].matchAll(/"([^"]+)"/g)].map((x) => x[1]).sort()
  }

  // ProviderId is derived from the PROVIDER_IDS tuple (not a literal union) — parse the tuple.
  test("OmegacodeProviderId matches PROVIDER_IDS", () => {
    const m = types.match(/const PROVIDER_IDS\s*=\s*\[([^\]]+)\]/)
    assert.ok(m, "PROVIDER_IDS tuple not found in dsl/types.ts")
    const tuple = [...m![1].matchAll(/"([^"]+)"/g)].map((x) => x[1]).sort()
    assert.deepEqual(unionMembers(ambient, "OmegacodeProviderId"), tuple)
  })

  for (const [canonical, inlined] of [
    ["Sandbox", "OmegacodeSandbox"],
    ["Effort", "OmegacodeEffort"],
    ["Approval", "OmegacodeApproval"],
  ] as const) {
    test(`${inlined} matches ${canonical}`, () => {
      assert.deepEqual(unionMembers(ambient, inlined), unionMembers(types, canonical))
    })
  }

  test("OmegacodeAgentOpts carries the same keys as AgentOpts", () => {
    const interfaceKeys = (src: string, name: string) => {
      const start = src.indexOf(`interface ${name} {`)
      assert.ok(start >= 0, `interface ${name} not found`)
      let depth = 0
      let end = start
      for (let i = src.indexOf("{", start); i < src.length; i++) {
        if (src[i] === "{") depth++
        else if (src[i] === "}" && --depth === 0) {
          end = i
          break
        }
      }
      const body = src.slice(start, end)
      return [...body.matchAll(/^\s+(\w+)\?:/gm)].map((x) => x[1]).sort()
    }
    assert.deepEqual(interfaceKeys(ambient, "OmegacodeAgentBaseOpts"), interfaceKeys(types, "AgentOptsBase"))
    // The provider/model pair rides a both-or-neither union on top of the base opts in BOTH files
    // (see ProviderModelPair) — the base interfaces must not re-grow either key field-wise.
    assert.ok(/type OmegacodeAgentOpts = OmegacodeAgentBaseOpts &/.test(ambient), "ambient pair union missing")
    assert.ok(/\{ provider\?: never; model\?: never \}/.test(ambient), "ambient both-or-neither arm missing")
    assert.ok(/type AgentOpts = AgentOptsBase & ProviderModelPair/.test(types), "types.ts pair union missing")
  })
})

describe("index.ts exports the public types (M31)", () => {
  const index = read("src/index.ts")
  for (const t of [
    "WorkflowBudget",
    "EventListener",
    "WorkerProgress",
    "WorkflowGlobals",
    "Effort",
    "EventSink",
    "WorkflowEvent",
  ]) {
    test(`re-exports ${t}`, () => {
      assert.ok(index.includes(t), `src/index.ts does not export ${t}`)
    })
  }
})

describe("build pipeline is portable (L19, M31)", () => {
  const tsup = read("tsup.config.ts")

  test("tsup enables dts for the public entry", () => {
    assert.match(tsup, /dts:\s*\{[^}]*entry:\s*["']src\/index\.ts["']/)
    assert.ok(!/dts:\s*false/.test(tsup), "dts must not be false")
  })

  test("tsup no longer uses POSIX rm -rf / cp -r in onSuccess", () => {
    assert.ok(!/rm\s+-rf/.test(tsup), "rm -rf is POSIX-only; use the node postbuild helper")
    assert.ok(!/cp\s+-r/.test(tsup), "cp -r is POSIX-only; use the node postbuild helper")
  })

  test("build script uses the pnpm workspace viewer build plus node postbuild (no POSIX copy)", () => {
    const build = pkg.scripts.build as string
    assert.ok(build.includes("pnpm --filter viewer build"), "build must use the viewer workspace package")
    assert.ok(build.includes("scripts/postbuild.mjs"), "build must run the portable postbuild helper")
    assert.ok(build.includes("tsup"), "build must run tsup")
    assert.ok(!/rm\s+-rf/.test(build) && !/cp\s+-r/.test(build), "build must not use POSIX rm/cp")
    assert.ok(!build.includes("scripts/build-viewer.mjs"), "old npm-to-pnpm viewer bridge must stay deleted")
  })

  test("prepublishOnly builds (so the published tarball is fresh)", () => {
    assert.ok((pkg.scripts.prepublishOnly as string).includes("build"))
  })

  test("the build helper scripts parse as valid ESM", () => {
    for (const s of ["scripts/install-safe.mjs", "scripts/postbuild.mjs"]) {
      // node --check throws (non-zero exit) on a syntax error.
      execFileSync(process.execPath, ["--check", join(root, s)])
    }
  })
})

describe("postbuild helper behavior (L19)", () => {
  let work: string

  before(() => {
    work = mkdtempSync(join(tmpdir(), "omega-postbuild-"))
  })
  after(() => {
    rmSync(work, { recursive: true, force: true })
  })

  test("copies viewer, ambient types, and the Grok agent profile into dist", () => {
    // Stage a fake project with all postbuild inputs and a stale dist/web.
    mkdirSync(join(work, "scripts"), { recursive: true })
    cpSync(join(root, "scripts", "postbuild.mjs"), join(work, "scripts", "postbuild.mjs"))
    mkdirSync(join(work, "src", "dsl"), { recursive: true })
    cpSync(join(root, "src", "dsl", "ambient.d.ts"), join(work, "src", "dsl", "ambient.d.ts"))
    mkdirSync(join(work, "src", "worker", "agents"), { recursive: true })
    cpSync(
      join(root, "src", "worker", "agents", "fleet-omegacode-grok-worker.md"),
      join(work, "src", "worker", "agents", "fleet-omegacode-grok-worker.md"),
    )
    mkdirSync(join(work, "viewer", "dist", "assets"), { recursive: true })
    writeFileSync(join(work, "viewer", "dist", "index.html"), "<html></html>")
    writeFileSync(join(work, "viewer", "dist", "assets", "app.js"), "console.log(1)")
    // Pre-existing stale dist/web with a file that must be wiped.
    mkdirSync(join(work, "dist", "web"), { recursive: true })
    writeFileSync(join(work, "dist", "web", "STALE.txt"), "old")

    execFileSync(process.execPath, [join(work, "scripts", "postbuild.mjs")])

    assert.ok(existsSync(join(work, "dist", "web", "index.html")), "viewer index.html not copied")
    assert.ok(
      existsSync(join(work, "dist", "web", "assets", "app.js")),
      "viewer asset not copied recursively",
    )
    assert.ok(!existsSync(join(work, "dist", "web", "STALE.txt")), "stale web file not removed")
    const ambient = readFileSync(join(work, "dist", "ambient.d.ts"), "utf8")
    assert.ok(ambient.includes("function agent"), "ambient.d.ts not written to dist")
    assert.equal(
      readFileSync(join(work, "dist", "agents", "fleet-omegacode-grok-worker.md"), "utf8"),
      read("src/worker/agents/fleet-omegacode-grok-worker.md"),
    )
  })

  test("fails loudly when viewer/dist is missing", () => {
    const w2 = mkdtempSync(join(tmpdir(), "omega-postbuild-nov-"))
    try {
      mkdirSync(join(w2, "scripts"), { recursive: true })
      cpSync(join(root, "scripts", "postbuild.mjs"), join(w2, "scripts", "postbuild.mjs"))
      mkdirSync(join(w2, "src", "dsl"), { recursive: true })
      cpSync(join(root, "src", "dsl", "ambient.d.ts"), join(w2, "src", "dsl", "ambient.d.ts"))
      assert.throws(() => execFileSync(process.execPath, [join(w2, "scripts", "postbuild.mjs")], {
        stdio: "pipe",
      }))
    } finally {
      rmSync(w2, { recursive: true, force: true })
    }
  })

  test("rejects an ambient.d.ts that re-introduces an import (self-containment guard)", () => {
    const w3 = mkdtempSync(join(tmpdir(), "omega-postbuild-imp-"))
    try {
      mkdirSync(join(w3, "scripts"), { recursive: true })
      cpSync(join(root, "scripts", "postbuild.mjs"), join(w3, "scripts", "postbuild.mjs"))
      mkdirSync(join(w3, "src", "dsl"), { recursive: true })
      writeFileSync(
        join(w3, "src", "dsl", "ambient.d.ts"),
        'import type { Foo } from "./types.js"\ndeclare global {}\nexport {}\n',
      )
      mkdirSync(join(w3, "viewer", "dist"), { recursive: true })
      writeFileSync(join(w3, "viewer", "dist", "index.html"), "<html></html>")
      assert.throws(
        () => execFileSync(process.execPath, [join(w3, "scripts", "postbuild.mjs")], { stdio: "pipe" }),
        /self-contained/,
      )
    } finally {
      rmSync(w3, { recursive: true, force: true })
    }
  })
})

describe("pnpm pack tarball contract (M31)", () => {
  // Build an isolated package from the real package.json + a synthetic dist matching the files
  // whitelist, then run `pnpm pack --dry-run --json` there. This asserts the packaging CONTRACT
  // without depending on the repo's dist (which other agents may have left half-built mid-sweep).
  let stage: string
  let entries: Array<{ path: string }>

  before(() => {
    stage = mkdtempSync(join(tmpdir(), "omega-pack-"))
    writeFileSync(join(stage, "package.json"), read("package.json"))
    cpSync(join(root, "LICENSE"), join(stage, "LICENSE"))
    cpSync(join(root, "README.md"), join(stage, "README.md"))
    // Synthetic dist mirroring what the real build emits.
    mkdirSync(join(stage, "dist", "web", "assets"), { recursive: true })
    writeFileSync(join(stage, "dist", "index.js"), "export {}\n")
    writeFileSync(join(stage, "dist", "cli.js"), "#!/usr/bin/env node\n")
    writeFileSync(join(stage, "dist", "index.d.ts"), "export type Effort = 'none'\n")
    writeFileSync(join(stage, "dist", "ambient.d.ts"), "declare global {}\nexport {}\n")
    mkdirSync(join(stage, "dist", "agents"), { recursive: true })
    writeFileSync(
      join(stage, "dist", "agents", "fleet-omegacode-grok-worker.md"),
      "---\nname: fleet-omegacode-grok-worker\ndescription: test\n---\n",
    )
    writeFileSync(join(stage, "dist", "index.js.map"), "{}\n")
    writeFileSync(join(stage, "dist", "cli.js.map"), "{}\n")
    writeFileSync(join(stage, "dist", "web", "index.html"), "<html></html>")
    writeFileSync(join(stage, "dist", "web", "assets", "app.js"), "console.log(1)")
    // skill/ and builtins/ are also in files.
    mkdirSync(join(stage, "skill"), { recursive: true })
    writeFileSync(join(stage, "skill", "SKILL.md"), "# skill\n")
    mkdirSync(join(stage, "builtins"), { recursive: true })
    writeFileSync(join(stage, "builtins", "deep-research.workflow.js"), "export const meta = {}\n")
    // Decoys that MUST NOT end up in the tarball.
    mkdirSync(join(stage, "src", "dsl"), { recursive: true })
    writeFileSync(join(stage, "src", "dsl", "ambient.d.ts"), "export {}\n")
    writeFileSync(join(stage, "secret.env"), "TOKEN=xxx\n")

    const out = pnpm(["pack", "--dry-run", "--json"], stage)
    entries = packEntries(out)
  })
  after(() => {
    rmSync(stage, { recursive: true, force: true })
  })

  const has = (p: string) => entries.some((e) => e.path === p)

  test("includes the dts entrypoints", () => {
    assert.ok(has("dist/index.d.ts"), "dist/index.d.ts must ship")
    assert.ok(has("dist/ambient.d.ts"), "dist/ambient.d.ts must ship")
  })

  test("includes the js entrypoints and viewer web assets", () => {
    assert.ok(has("dist/index.js"))
    assert.ok(has("dist/cli.js"))
    assert.ok(entries.some((e) => e.path.startsWith("dist/web/")), "viewer web assets must ship")
    assert.ok(has("dist/agents/fleet-omegacode-grok-worker.md"), "Grok fleet profile must ship")
  })

  test("includes LICENSE, the skill, and the builtin workflows", () => {
    assert.ok(has("LICENSE"))
    assert.ok(entries.some((e) => e.path.startsWith("skill/")))
    assert.ok(entries.some((e) => e.path.startsWith("builtins/")), "builtin workflows must ship")
  })

  test("does NOT ship src/ or stray dotfiles (no surprises)", () => {
    assert.ok(!entries.some((e) => e.path.startsWith("src/")), "src/ leaked into the tarball")
    assert.ok(!has("secret.env"), "stray file leaked into the tarball")
    assert.ok(!entries.some((e) => e.path.endsWith(".test.ts")), "test files leaked into the tarball")
  })
})

describe("real pnpm pack tarball (M31, post-build)", () => {
  // Runs against the actual repo dist when it exists. Skipped when dist hasn't been built in this
  // checkout (the synthetic contract suite above still covers the packaging rules).
  const built = existsSync(join(root, "dist", "index.d.ts")) &&
    existsSync(join(root, "dist", "agents", "fleet-omegacode-grok-worker.md"))

  test("built dist packs the dts, ambient, web assets, LICENSE — and nothing unexpected", { skip: !built }, () => {
    const out = pnpm(["pack", "--dry-run", "--json"], root)
    const entries = packEntries(out)
    const paths = entries.map((e) => e.path)
    for (const required of [
      "LICENSE",
      "README.md",
      "package.json",
      "dist/index.js",
      "dist/index.d.ts",
      "dist/ambient.d.ts",
      "dist/cli.js",
      "dist/agents/fleet-omegacode-grok-worker.md",
      "skill/SKILL.md",
      "builtins/deep-research.workflow.js",
      "builtins/code-review.workflow.js",
      "builtins/multi-provider-review.workflow.js",
      "builtins/bake-off.workflow.js",
      "builtins/provider-debate.workflow.js",
      "builtins/second-opinion.workflow.js",
    ]) {
      assert.ok(paths.includes(required), `tarball missing ${required}`)
    }
    assert.ok(paths.some((p) => p.startsWith("dist/web/")), "tarball missing viewer assets dist/web/")
    const allowed = /^(LICENSE|README\.md|package\.json|dist\/|skill\/|builtins\/)/
    const surprises = paths.filter((p) => !allowed.test(p))
    assert.deepEqual(surprises, [], `unexpected files in tarball: ${surprises.join(", ")}`)
    // Every exports target must actually exist in the tarball.
    assert.ok(paths.includes("dist/index.d.ts") && paths.includes("dist/ambient.d.ts"))
  })

  test("dist/ambient.d.ts (when built) is byte-identical to the source ambient", { skip: !built }, () => {
    assert.equal(read("dist/ambient.d.ts"), read("src/dsl/ambient.d.ts"))
  })
})

describe("one coherent package-manager story (L19)", () => {
  const workspace = read("pnpm-workspace.yaml")

  test("root package declares pnpm ownership and engines", () => {
    assert.equal(pkg.packageManager, "pnpm@11.8.0")
    assert.equal(pkg.engines.node, ">=20")
    assert.equal(pkg.engines.pnpm, ">=11.4.0 <12")
  })

  test("one root pnpm workspace and lockfile own root plus viewer", () => {
    assert.ok(existsSync(join(root, "pnpm-workspace.yaml")), "root pnpm-workspace.yaml must exist")
    assert.ok(existsSync(join(root, "pnpm-lock.yaml")), "root pnpm-lock.yaml must exist")
    assert.match(workspace, /packages:\r?\n\s+- "\."\r?\n\s+- "viewer"/)
    assert.match(workspace, /minimumReleaseAge:\s*1440/)
    assert.match(workspace, /strictDepBuilds:\s*true/)
    assert.match(workspace, /trustPolicy:\s*no-downgrade/)
  })

  test("stale split-lockfile and npm bridge artifacts are gone", () => {
    assert.ok(!existsSync(join(root, "package-lock.json")), "root package-lock.json must be removed")
    assert.ok(!existsSync(join(root, "viewer", "pnpm-lock.yaml")), "viewer-local lockfile must be removed")
    assert.ok(!existsSync(join(root, "viewer", "pnpm-workspace.yaml")), "viewer-local workspace must be removed")
    assert.ok(!existsSync(join(root, "scripts", "build-viewer.mjs")), "npx/self-install viewer bridge must be removed")
  })

  test("scripts are pnpm-only and route viewer commands through workspace filters", () => {
    for (const [name, value] of Object.entries(pkg.scripts as Record<string, string>)) {
      assert.ok(!/\bnpm\s+run\b/.test(value), `${name} must not invoke npm run`)
      assert.ok(!/\bnpx\b/.test(value), `${name} must not invoke npx`)
      assert.ok(!/\bpnpm\s+-C\b/.test(value), `${name} must use workspace filters instead of pnpm -C`)
    }
    assert.equal(pkg.scripts["viewer:build"], "pnpm --filter viewer build")
    assert.equal(pkg.scripts["viewer:dev"], "pnpm --filter viewer dev")
    assert.match(pkg.scripts["verify:deps"], /pnpm pack --dry-run --json/)
  })
})
