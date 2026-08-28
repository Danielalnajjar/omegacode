#!/usr/bin/env node
import { readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const launcherSourcePath = process.argv[2]

const SDK_ROUTING_SELECTORS = [
  "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_ANTHROPIC_AWS", "CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD",
  "CLAUDE_CODE_USE_MANTLE", "CLAUDE_CODE_USE_GATEWAY",
]
const SDK_NON_ROUTING_USE_CONTROLS = [
  "CLAUDE_CODE_USE_COWORK_PLUGINS", "CLAUDE_CODE_USE_NATIVE_FILE_SEARCH",
  "CLAUDE_CODE_USE_POWERSHELL_TOOL",
]
const SDK_DIRECT_BASE_URL_CONFLICTS = ["ANTHROPIC_BASE_URL"]
const SDK_DIRECT_TRANSPORT_CONFLICTS = ["ANTHROPIC_UNIX_SOCKET"]
const SDK_SELECTOR_SCOPED_BASE_URLS = [
  "ANTHROPIC_AWS_BASE_URL", "ANTHROPIC_BEDROCK_BASE_URL", "ANTHROPIC_BEDROCK_MANTLE_BASE_URL",
  "ANTHROPIC_FOUNDRY_BASE_URL", "ANTHROPIC_GOOGLE_CLOUD_BASE_URL", "ANTHROPIC_VERTEX_BASE_URL",
]
const SDK_NON_ROUTING_BASE_URL_CONTROLS = ["_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL"]
const SDK_OAUTH_NON_EMPTY_CONFLICTS = [
  "CLAUDE_CODE_CUSTOM_OAUTH_URL", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
]
const SDK_NON_ROUTING_OAUTH_CONTROLS = [
  "CLAUDE_CODE_DESIGN_OAUTH_CLIENT_ID", "CLAUDE_CODE_OAUTH_401_WAIT_MS", "CLAUDE_CODE_OAUTH_CLIENT_ID",
  "CLAUDE_CODE_OAUTH_REFRESH_TOKEN", "CLAUDE_CODE_OAUTH_SCOPES", "CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH",
]
const SDK_HOST_STRING_CONFLICTS = ["CLAUDE_CODE_HOST_AUTH_ENV_VAR", "CLAUDE_CODE_HOST_CREDS_FILE"]
const SDK_HOST_BOOLEAN_CONFLICTS = ["CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST"]
const SDK_NON_ROUTING_HOST_CONTROLS = [
  "CLAUDE_CODE_HOST_AUTH_REFRESH_TIMEOUT_MS", "CLAUDE_CODE_HOST_PLATFORM",
  "CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH",
]
const SDK_PRESENCE_CONFLICTS = ["CLAUDE_SECURESTORAGE_CONFIG_DIR"]
const SDK_PROFILE_CONFLICTS = ["ANTHROPIC_CONFIG_DIR", "ANTHROPIC_PROFILE"]
const SDK_FEDERATION_CONFLICTS = [
  "ANTHROPIC_FEDERATION_RULE_ID", "ANTHROPIC_IDENTITY_TOKEN", "ANTHROPIC_IDENTITY_TOKEN_FILE",
  "ANTHROPIC_ORGANIZATION_ID", "ANTHROPIC_SCOPE", "ANTHROPIC_SERVICE_ACCOUNT_ID", "ANTHROPIC_WORKSPACE_ID",
]
const SDK_CUSTOM_HEADER_CONFLICTS = ["ANTHROPIC_CUSTOM_HEADERS"]

const omegaSource = readFileSync(join(here, "../src/worker/claude-profile.ts"), "utf8")
const manifestBody = omegaSource.match(/export const CLAUDE_PROFILE_AUTH_CONFLICTS = \{([\s\S]*?)\n\} as const/)?.[1]
if (manifestBody === undefined) throw new Error("could not read Omega CLAUDE_PROFILE_AUTH_CONFLICTS")
const CLAUDE_PROFILE_AUTH_CONFLICTS = {
  defined: quotedPropertyArray(manifestBody, "defined"),
  nonEmpty: quotedPropertyArray(manifestBody, "nonEmpty"),
  truthy: quotedPropertyArray(manifestBody, "truthy"),
}
const manifest = new Set([
  ...CLAUDE_PROFILE_AUTH_CONFLICTS.defined,
  ...CLAUDE_PROFILE_AUTH_CONFLICTS.nonEmpty,
  ...CLAUDE_PROFILE_AUTH_CONFLICTS.truthy,
])

const sdkPath = join(here, "../node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs")
const sdkPackagePath = join(here, "../node_modules/@anthropic-ai/claude-agent-sdk/package.json")
const sdk = readFileSync(sdkPath, "utf8")
const sdkVersion = JSON.parse(readFileSync(sdkPackagePath, "utf8")).version
if (typeof sdkVersion !== "string" || !sdkVersion) throw new Error("could not read installed Agent SDK version")
for (const key of manifest) {
  if (!sdk.includes(key)) throw new Error(`Omega auth control ${key} is absent from installed Agent SDK ${sdkVersion}`)
}

const sdkSelectors = discovered(sdk, /CLAUDE_CODE_USE_[A-Z0-9_]+/g)
assertReviewedClassification("CLAUDE_CODE_USE_* control", sdkSelectors, [...SDK_ROUTING_SELECTORS, ...SDK_NON_ROUTING_USE_CONTROLS])
assertManifestGroup("routing selector", SDK_ROUTING_SELECTORS, CLAUDE_PROFILE_AUTH_CONFLICTS.truthy)
assertManifestExcludes("non-routing CLAUDE_CODE_USE_* control", SDK_NON_ROUTING_USE_CONTROLS, manifest)

const sdkBaseUrls = discovered(sdk, /(?:ANTHROPIC_[A-Z0-9_]*BASE_URL|_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL)/g)
assertReviewedClassification("Anthropic base URL control", sdkBaseUrls, [
  ...SDK_DIRECT_BASE_URL_CONFLICTS,
  ...SDK_SELECTOR_SCOPED_BASE_URLS,
  ...SDK_NON_ROUTING_BASE_URL_CONTROLS,
])
assertManifestGroup("direct base URL conflict", SDK_DIRECT_BASE_URL_CONFLICTS, CLAUDE_PROFILE_AUTH_CONFLICTS.nonEmpty)
assertManifestExcludes("selector-scoped or non-routing base URL", [...SDK_SELECTOR_SCOPED_BASE_URLS, ...SDK_NON_ROUTING_BASE_URL_CONTROLS], manifest)

const sdkTransportControls = discovered(sdk, /ANTHROPIC_[A-Z0-9_]*(?:UNIX_SOCKET|SOCKET)[A-Z0-9_]*/g)
assertReviewedClassification("Anthropic direct transport control", sdkTransportControls, SDK_DIRECT_TRANSPORT_CONFLICTS)
assertManifestGroup("direct transport conflict", SDK_DIRECT_TRANSPORT_CONFLICTS, CLAUDE_PROFILE_AUTH_CONFLICTS.nonEmpty)

const sdkOauthControls = discovered(sdk, /CLAUDE_CODE_[A-Z0-9_]*OAUTH[A-Z0-9_]*/g)
assertReviewedClassification("CLAUDE_CODE_*OAUTH* control", sdkOauthControls, [
  ...SDK_OAUTH_NON_EMPTY_CONFLICTS,
  ...SDK_NON_ROUTING_OAUTH_CONTROLS,
])
assertManifestGroup("OAuth credential or endpoint conflict", SDK_OAUTH_NON_EMPTY_CONFLICTS, CLAUDE_PROFILE_AUTH_CONFLICTS.nonEmpty)
assertManifestExcludes("non-routing OAuth control", SDK_NON_ROUTING_OAUTH_CONTROLS, manifest)

const sdkHostControls = discovered(sdk, /CLAUDE_CODE_(?:PROVIDER_MANAGED_BY_HOST|HOST_[A-Z0-9_]+|SDK_HAS_HOST_AUTH_REFRESH)/g)
assertReviewedClassification("host control", sdkHostControls, [
  ...SDK_HOST_STRING_CONFLICTS,
  ...SDK_HOST_BOOLEAN_CONFLICTS,
  ...SDK_NON_ROUTING_HOST_CONTROLS,
])
assertManifestGroup("host string conflict", SDK_HOST_STRING_CONFLICTS, CLAUDE_PROFILE_AUTH_CONFLICTS.nonEmpty)
assertManifestGroup("host boolean conflict", SDK_HOST_BOOLEAN_CONFLICTS, CLAUDE_PROFILE_AUTH_CONFLICTS.truthy)
assertManifestExcludes("non-routing host control", SDK_NON_ROUTING_HOST_CONTROLS, manifest)

const sdkPresenceControls = discovered(sdk, /CLAUDE_[A-Z0-9_]*SECURESTORAGE[A-Z0-9_]*/g)
assertReviewedClassification("presence-sensitive credential storage control", sdkPresenceControls, SDK_PRESENCE_CONFLICTS)
assertManifestGroup("presence-sensitive credential storage conflict", SDK_PRESENCE_CONFLICTS, CLAUDE_PROFILE_AUTH_CONFLICTS.defined)

const sdkProfileControls = discovered(sdk, /ANTHROPIC_(?:CONFIG_DIR|PROFILE)[A-Z0-9_]*/g)
assertReviewedClassification("Anthropic profile control", sdkProfileControls, SDK_PROFILE_CONFLICTS)
assertManifestGroup("Anthropic profile conflict", SDK_PROFILE_CONFLICTS, CLAUDE_PROFILE_AUTH_CONFLICTS.nonEmpty)

const sdkFederationControls = discovered(sdk, /ANTHROPIC_(?:FEDERATION_RULE_ID|IDENTITY_TOKEN|ORGANIZATION_ID|SCOPE|SERVICE_ACCOUNT_ID|WORKSPACE_ID)[A-Z0-9_]*/g)
assertReviewedClassification("Anthropic federation control", sdkFederationControls, SDK_FEDERATION_CONFLICTS)
assertManifestGroup("Anthropic federation conflict", SDK_FEDERATION_CONFLICTS, CLAUDE_PROFILE_AUTH_CONFLICTS.nonEmpty)

const sdkCustomHeaderControls = discovered(sdk, /ANTHROPIC_CUSTOM_HEADERS[A-Z0-9_]*/g)
assertReviewedClassification("Anthropic custom header control", sdkCustomHeaderControls, SDK_CUSTOM_HEADER_CONFLICTS)
assertManifestGroup("Anthropic custom header conflict", SDK_CUSTOM_HEADER_CONFLICTS, CLAUDE_PROFILE_AUTH_CONFLICTS.nonEmpty)

const launcherControls = new Set()
if (launcherSourcePath) {
  const launcherPath = resolve(launcherSourcePath)
  const launcher = readFileSync(launcherPath, "utf8")
  const contract = readFileSync(join(dirname(launcherPath), "contract.ts"), "utf8")
  const tokenName = contract.match(/export const TOKEN_ENV_NAME = "([A-Z0-9_]+)"/)?.[1]
  if (!tokenName) throw new Error("could not read Subscription Picker TOKEN_ENV_NAME")

  launcherControls.add(tokenName)
  for (const key of quotedArray(launcher, "CREDENTIAL_ENV_KEYS")) launcherControls.add(key)
  for (const key of quotedArray(launcher, "PROVIDER_SELECTOR_ENV_KEYS")) launcherControls.add(key)
  if (!launcher.includes("delete environment.CLAUDE_SECURESTORAGE_CONFIG_DIR")) {
    throw new Error("Subscription Picker launcher no longer clears CLAUDE_SECURESTORAGE_CONFIG_DIR")
  }
  launcherControls.add("CLAUDE_SECURESTORAGE_CONFIG_DIR")
  for (const key of launcherControls) {
    if (!manifest.has(key)) throw new Error(`Subscription Picker launcher control ${key} is absent from Omega's conflict manifest`)
  }
}

console.log(JSON.stringify({
  sdkVersion,
  omegaControls: [...manifest].sort(),
  sdkSelectors,
  sdkBaseUrls,
  sdkTransportControls,
  sdkOauthControls,
  sdkHostControls,
  sdkPresenceControls,
  sdkProfileControls,
  sdkFederationControls,
  sdkCustomHeaderControls,
  launcherChecked: Boolean(launcherSourcePath),
  launcherControls: [...launcherControls].sort(),
}, null, 2))

function discovered(source, pattern) {
  return [...new Set(source.match(pattern) ?? [])].sort()
}

function assertReviewedClassification(label, actual, reviewed) {
  if (new Set(reviewed).size !== reviewed.length) {
    throw new Error(`installed Agent SDK ${label} classifications overlap; review classifications`)
  }
  const expected = [...new Set(reviewed)].sort()
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`installed Agent SDK ${sdkVersion} ${label} discovery changed; review classifications (discovered: ${actual.join(", ") || "none"})`)
  }
}

function assertManifestGroup(label, keys, group) {
  for (const key of keys) {
    if (!group.includes(key)) throw new Error(`installed Agent SDK ${sdkVersion} ${label} ${key} is absent from Omega's matching conflict controls`)
  }
}

function assertManifestExcludes(label, keys, controls) {
  for (const key of keys) {
    if (controls.has(key)) throw new Error(`installed Agent SDK ${sdkVersion} ${label} ${key} must not be blocked by Omega's conflict manifest`)
  }
}

function quotedArray(source, name) {
  const body = source.match(new RegExp(`export const ${name} = \\[([\\s\\S]*?)\\] as const;`))?.[1]
  if (body === undefined) throw new Error(`could not read Subscription Picker ${name}`)
  return [...body.matchAll(/"([A-Z0-9_]+)"/g)].map((match) => match[1])
}

function quotedPropertyArray(source, name) {
  const body = source.match(new RegExp(`\\b${name}: \\[([\\s\\S]*?)\\],`))?.[1]
  if (body === undefined) throw new Error(`could not read Omega auth control group ${name}`)
  const values = [...body.matchAll(/"([A-Z0-9_]+)"/g)].map((match) => match[1])
  const residue = body.replaceAll(/"[A-Z0-9_]+"/g, "").replaceAll(/[\s,]/g, "")
  if (!values.length || residue) throw new Error(`Omega auth control group ${name} is not a quoted literal array`)
  return values
}
