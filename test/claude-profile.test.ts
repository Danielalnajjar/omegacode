import { test } from "node:test"
import assert from "node:assert/strict"
import { execFile, execFileSync } from "node:child_process"
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { CLAUDE_PROFILE_AUTH_CONFLICTS, assertNoClaudeProfileAuthConflict, prepareClaudeProfile, resolveClaudeProfile } from "../src/worker/claude-profile.ts"
import { AgentError, AgentInterrupted } from "../src/worker/index.ts"
import type { AgentSpec } from "../src/dsl/types.ts"

const spec: AgentSpec = { prompt: "x", provider: "claude-code", cwd: "/tmp", sandbox: "read-only", approval: "never", claudeProfile: "profile-a" }
const root = join(dirname(fileURLToPath(import.meta.url)), "..")

test("profile preparation binds one immutable environment without mutating the caller", async () => {
  const original: NodeJS.ProcessEnv = { ORDINARY: "kept", CLAUDE_CONFIG_DIR: "/old", CLAUDE_CODE_EXECUTABLE: "/old/claude" }
  let calls = 0
  let release!: () => void
  const resolving = new Promise<void>((resolve) => { release = resolve })
  const pending = prepareClaudeProfile(spec, new AbortController().signal, async (id) => {
    calls++
    await resolving
    return { profileId: id, label: "A", configDir: "/profiles/a", claudeCodeExecutable: "/launchers/claude-a" }
  }, original)
  original.ORDINARY = "changed while resolving"
  original.ANTHROPIC_API_KEY = "late override"
  release()
  const env = await pending
  assert.deepEqual(env, { ORDINARY: "kept", CLAUDE_CONFIG_DIR: "/profiles/a", CLAUDE_CODE_EXECUTABLE: "/launchers/claude-a" })
  assert.deepEqual(original, { ORDINARY: "changed while resolving", CLAUDE_CONFIG_DIR: "/old", CLAUDE_CODE_EXECUTABLE: "/old/claude", ANTHROPIC_API_KEY: "late override" })
  assert.equal(calls, 1)
  assert.ok(Object.isFrozen(env))
})

test("every pinned auth override fails before resolution and never leaks its value", () => {
  for (const key of CLAUDE_PROFILE_AUTH_CONFLICTS.defined) {
    for (const value of ["", "  ", "TOP-SECRET"]) {
      assert.throws(() => assertNoClaudeProfileAuthConflict({ [key]: value }), (error: unknown) => error instanceof AgentError && error.code === "claude_profile_auth_conflict" && !error.message.includes("TOP-SECRET"))
    }
  }
  for (const key of CLAUDE_PROFILE_AUTH_CONFLICTS.nonEmpty) {
    assert.throws(() => assertNoClaudeProfileAuthConflict({ [key]: "TOP-SECRET" }), (error: unknown) => error instanceof AgentError && error.code === "claude_profile_auth_conflict" && !error.message.includes("TOP-SECRET"))
  }
  for (const key of CLAUDE_PROFILE_AUTH_CONFLICTS.truthy) {
    assert.throws(() => assertNoClaudeProfileAuthConflict({ [key]: "true" }), (error: unknown) => error instanceof AgentError && error.code === "claude_profile_auth_conflict")
    assert.doesNotThrow(() => assertNoClaudeProfileAuthConflict({ [key]: "false" }))
  }
})

test("host-managed boolean spellings are enforced at profile preparation", async () => {
  for (const value of ["", "0", "false", "FALSE", "no", "off", "  off  "]) {
    let resolutions = 0
    const env = await prepareClaudeProfile(spec, new AbortController().signal, async (profileId) => {
      resolutions++
      return { profileId, label: "A", configDir: "/profiles/a", claudeCodeExecutable: "/launchers/claude-a" }
    }, { CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: value })
    assert.equal(resolutions, 1, `disabled spelling ${JSON.stringify(value)} blocked resolution`)
    assert.equal(env.CLAUDE_CONFIG_DIR, "/profiles/a")
  }

  for (const value of ["1", "true", "TRUE", "yes", "on", "enabled"]) {
    let resolutions = 0
    await assert.rejects(
      async () => prepareClaudeProfile(spec, new AbortController().signal, async (profileId) => {
        resolutions++
        return { profileId, label: "A", configDir: "/profiles/a", claudeCodeExecutable: "/launchers/claude-a" }
      }, { CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: value }),
      (error: unknown) => error instanceof AgentError && error.code === "claude_profile_auth_conflict",
    )
    assert.equal(resolutions, 0, `enabled spelling ${JSON.stringify(value)} reached resolution`)
  }
})

test("auth verifier reports the installed pinned Agent SDK version", () => {
  const receipt = JSON.parse(execFileSync(process.execPath, [join(root, "scripts", "verify-claude-profile-auth-controls.mjs")], {
    cwd: root,
    encoding: "utf8",
  })) as { sdkVersion: string }
  const installed = JSON.parse(readFileSync(join(root, "node_modules", "@anthropic-ai", "claude-agent-sdk", "package.json"), "utf8")) as { version: string }
  const pinned = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { dependencies: Record<string, string> }
  assert.equal(receipt.sdkVersion, installed.version)
  assert.equal(receipt.sdkVersion, pinned.dependencies["@anthropic-ai/claude-agent-sdk"])
})

test("auth verifier rejects full unreviewed identifiers that extend reviewed controls", () => {
  const temp = mkdtempSync(join(tmpdir(), "omega-auth-verifier-"))
  try {
    const script = join(temp, "scripts", "verify-claude-profile-auth-controls.mjs")
    const workerSource = join(temp, "src", "worker", "claude-profile.ts")
    const sdkRoot = join(temp, "node_modules", "@anthropic-ai", "claude-agent-sdk")
    mkdirSync(dirname(script), { recursive: true })
    mkdirSync(dirname(workerSource), { recursive: true })
    mkdirSync(sdkRoot, { recursive: true })
    cpSync(join(root, "scripts", "verify-claude-profile-auth-controls.mjs"), script)
    cpSync(join(root, "src", "worker", "claude-profile.ts"), workerSource)
    cpSync(join(root, "node_modules", "@anthropic-ai", "claude-agent-sdk", "package.json"), join(sdkRoot, "package.json"))
    const installedSdk = readFileSync(join(root, "node_modules", "@anthropic-ai", "claude-agent-sdk", "sdk.mjs"), "utf8")

    for (const control of ["ANTHROPIC_PROFILE_NAME", "ANTHROPIC_SCOPES", "ANTHROPIC_CUSTOM_HEADERS_FILE"]) {
      writeFileSync(join(sdkRoot, "sdk.mjs"), `${installedSdk}\n${JSON.stringify(control)}\n`)
      assert.throws(
        () => execFileSync(process.execPath, [script], { cwd: temp, encoding: "utf8", stdio: "pipe" }),
        (error: unknown) => {
          const stderr = typeof error === "object" && error !== null && "stderr" in error ? String(error.stderr) : ""
          return stderr.includes("discovery changed") && stderr.includes(control)
        },
        `auth verifier did not reject ${control} by its full identifier`,
      )
    }
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
})

async function withResolverFixture<T>(
  body: string,
  run: (root: string, resolve: typeof resolveClaudeProfile) => Promise<T>,
): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), "omega-profile-resolver-"))
  const fixture = join(root, "bb.cjs")
  writeFileSync(fixture, body)
  const fixtureExec = ((file: string, args: string[], options: unknown, callback: unknown) => {
    assert.equal(file, "bb")
    return execFile(process.execPath, [fixture, ...args], options as never, callback as never)
  }) as typeof execFile
  const resolve: typeof resolveClaudeProfile = (profileId, signal) => resolveClaudeProfile(profileId, signal, fixtureExec)
  try {
    return await run(root, resolve)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test("resolver invokes the exact public bb command and accepts only the strict matching payload", async () => {
  await withResolverFixture(
    `const fs = require("node:fs"); fs.writeFileSync(process.env.ARGV_RECEIPT, JSON.stringify(process.argv.slice(2))); process.stdout.write(JSON.stringify({ profileId: "profile-a", label: "A", configDir: "/profiles/a", claudeCodeExecutable: "/launchers/claude-a" }));`,
    async (root, resolve) => {
      const receipt = join(root, "argv.json")
      process.env.ARGV_RECEIPT = receipt
      try {
        assert.deepEqual(await resolve("profile-a", new AbortController().signal), {
          profileId: "profile-a", label: "A", configDir: "/profiles/a", claudeCodeExecutable: "/launchers/claude-a",
        })
        assert.deepEqual(JSON.parse(readFileSync(receipt, "utf8")), [
          "subscription", "resolve-omega", "--profile-id", "profile-a", "--json",
        ])
      } finally {
        delete process.env.ARGV_RECEIPT
      }
    },
  )
})

test("resolver passes metacharacters as one literal profile-id argument without a shell", async () => {
  await withResolverFixture(
    `const fs = require("node:fs"); fs.writeFileSync(process.env.ARGV_RECEIPT, JSON.stringify(process.argv.slice(2))); process.stdout.write(JSON.stringify({ profileId: process.argv[5], label: "Literal", configDir: "/profiles/literal", claudeCodeExecutable: "/launchers/claude-literal" }));`,
    async (root, resolve) => {
      const receipt = join(root, "argv.json")
      const shellMarker = join(root, "shell-marker")
      const profileId = `profile;$(touch ${shellMarker}) ' quoted`
      process.env.ARGV_RECEIPT = receipt
      try {
        assert.equal((await resolve(profileId, new AbortController().signal)).profileId, profileId)
        assert.deepEqual(JSON.parse(readFileSync(receipt, "utf8")), [
          "subscription", "resolve-omega", "--profile-id", profileId, "--json",
        ])
        assert.equal(existsSync(shellMarker), false)
      } finally {
        delete process.env.ARGV_RECEIPT
      }
    },
  )
})

test("resolver reports missing and arbitrary nonzero commands as unavailable without output leakage", async () => {
  const previousPath = process.env.PATH
  const emptyPath = mkdtempSync(join(tmpdir(), "omega-profile-missing-resolver-"))
  process.env.PATH = emptyPath
  try {
    await assert.rejects(resolveClaudeProfile("profile-a", new AbortController().signal), (error: unknown) =>
      error instanceof AgentError && error.code === "claude_profile_unavailable" && /resolver command failed/.test(error.message) && !error.message.includes("profile-a"))
  } finally {
    if (previousPath === undefined) delete process.env.PATH
    else process.env.PATH = previousPath
    rmSync(emptyPath, { recursive: true, force: true })
  }

  await withResolverFixture(`process.stderr.write("TOP-SECRET-NONZERO"); process.exit(42);`, async (_root, resolve) => {
    await assert.rejects(resolve("profile-a", new AbortController().signal), (error: unknown) =>
      error instanceof AgentError
      && error.code === "claude_profile_unavailable"
      && /resolver command failed/.test(error.message)
      && !error.message.includes("TOP-SECRET-NONZERO")
      && !error.message.includes("profile-a"))
  })
})

for (const [label, payload] of [
  ["wrong id", `{ profileId: "profile-b", label: "A", configDir: "/profiles/a", claudeCodeExecutable: "/launchers/claude-a" }`],
  ["missing executable", `{ profileId: "profile-a", label: "A", configDir: "/profiles/a" }`],
  ["blank executable", `{ profileId: "profile-a", label: "A", configDir: "/profiles/a", claudeCodeExecutable: "  " }`],
  ["extra field", `{ profileId: "profile-a", label: "A", configDir: "/profiles/a", claudeCodeExecutable: "/launchers/claude-a", email: "secret@example.com" }`],
  ["malformed", `null`],
] as const) {
  test(`resolver fails closed on ${label} without exposing output`, async () => {
    await withResolverFixture(
      `process.stdout.write(JSON.stringify(${payload})); process.stderr.write("TOP-SECRET-DIAGNOSTIC");`,
      async (_root, resolve) => {
        await assert.rejects(resolve("profile-a", new AbortController().signal), (error: unknown) =>
          error instanceof AgentError
          && error.code === "claude_profile_unavailable"
          && !error.message.includes("TOP-SECRET-DIAGNOSTIC")
          && !error.message.includes("secret@example.com"))
      },
    )
  })
}

test("resolver bounds output and waits for abort cleanup", async () => {
  await withResolverFixture(`process.stdout.write("x".repeat(70 * 1024));`, async (_root, resolve) => {
    await assert.rejects(resolve("profile-a", new AbortController().signal), (error: unknown) =>
      error instanceof AgentError && error.code === "claude_profile_unavailable" && /exceeded/.test(error.message))
  })
  await withResolverFixture(`setInterval(() => {}, 1000);`, async (_root, resolve) => {
    const ac = new AbortController()
    const pending = resolve("profile-a", ac.signal)
    setTimeout(() => ac.abort(), 25)
    await assert.rejects(pending, (error: unknown) => error instanceof AgentInterrupted)
  })
})
