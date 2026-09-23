import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs"
import { isAbsolute, join, resolve } from "node:path"
import type { Options, PermissionResult } from "@anthropic-ai/claude-agent-sdk"

import type { JSONSchema } from "../dsl/types.js"
import { canonical, inside, SYSTEM_ROOTS } from "./isolation-paths.js"

export interface ClaudeIsolation {
  model?: string
  effort?: "low" | "medium" | "high"
  instructions?: string
  schema?: JSONSchema
  schemaVersion: "claude-isolation.v1"
  workspace: string
  inputs: string
  scratch: string
  readRoots: string[]
  blockedRoots: string[]
  writable: boolean
}
export const ISOLATED_TOOLS = ["Read", "Grep", "Glob", "Bash", "Edit", "Write"]
export const FORBIDDEN_TOOLS = ["Agent", "Task", "WebFetch", "WebSearch", "Skill", "NotebookEdit", "ToolSearch"]
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"
export function loadClaudeIsolation(path: string, cwd?: string): ClaudeIsolation {
  if (process.platform !== "darwin") throw new Error("Claude isolation requires macOS Seatbelt")
  const value = JSON.parse(readFileSync(path, "utf8")) as ClaudeIsolation
  if (value.schemaVersion !== "claude-isolation.v1" || typeof value.writable !== "boolean" ||
      !Array.isArray(value.readRoots) || !Array.isArray(value.blockedRoots)) throw new Error("Invalid Claude isolation configuration")
  for (const root of [value.workspace, value.inputs, value.scratch, ...value.readRoots, ...value.blockedRoots]) {
    if (typeof root !== "string" || !isAbsolute(root) || /[\n\r\0]/.test(root) || canonical(root) !== root || root === "/") throw new Error("Isolation roots must be canonical absolute paths")
  }
  if (cwd && canonical(cwd) !== value.workspace) throw new Error("Isolation workspace differs from worker cwd")
  if ([value.workspace,value.inputs].some(root=>inside(value.scratch,root)||inside(root,value.scratch))) throw new Error("Isolation scratch must be separate")
  if (value.readRoots.some(readRoot => [value.workspace, value.scratch].some(writableRoot => inside(readRoot, writableRoot) || inside(writableRoot, readRoot)))) throw new Error("Isolation readRoots must be separate from writable roots")
  return value
}
export function seatbeltProfile(config: ClaudeIsolation): string {
  const readRoots = [...SYSTEM_ROOTS, config.workspace, config.inputs, config.scratch, ...config.readRoots]
  const writeRoots = [config.scratch, ...(config.writable ? [config.workspace] : [])]
  // Deny predicates exclude only explicit grants, so nested case/dependency roots
  // remain accessible inside otherwise blocked Code/.bb trees. Metadata-only
  // ancestor access permits Node realpath without allowing their contents.
  return ["(version 1)", "(allow default)", "(deny network*)", "(deny mach-lookup)", "(deny process-info*)", "(allow process-info* (target self))",
    "(deny signal (require-not (target same-sandbox)))",
    `(deny file-read* (require-all ${readRoots.map(root=>`(require-not (subpath ${JSON.stringify(root)}))`).join(" ")}))`,
    "(allow file-read-metadata)", "(allow file-read* (literal \"/\"))",
    `(deny file-write* (require-all (require-not (literal \"/dev/null\")) ${writeRoots.map(root=>`(require-not (subpath ${JSON.stringify(root)}))`).join(" ")}))`,
  ].join("\n")
}
export function sandboxedBash(config: ClaudeIsolation, command: string): string {
  return "exec " + ["/usr/bin/sandbox-exec", "-p", seatbeltProfile(config), "/usr/bin/env", "-i",
    `HOME=${config.scratch}`, `TMPDIR=${config.scratch}`, "PATH=/usr/bin:/bin", "LANG=en_US.UTF-8",
    "/bin/bash", "--noprofile", "--norc", "-c", command].map(quote).join(" ")
}
function readable(config: ClaudeIsolation, path: string): boolean {
  return [config.workspace, config.inputs, config.scratch, ...config.readRoots].some(root=>inside(path,root))
}
function safeSearchTree(config: ClaudeIsolation, path: string, seen = new Set<string>()): boolean {
  const real = canonical(path)
  if (!readable(config,real)) return false
  if (seen.has(real)) return true
  // A directory search could otherwise follow a symlink past its approved root.
  const entry = lstatSync(path)
  if (entry.isSymbolicLink()) return !existsSync(real) || safeSearchTree(config, real, seen)
  seen.add(real)
  if (!entry.isDirectory()) return true
  return readdirSync(path).every(name=>safeSearchTree(config,join(path,name),seen))
}
export function isolatedToolPermission(config: ClaudeIsolation, tool: string, input: Record<string, unknown>): PermissionResult {
  const deny = (message: string): PermissionResult => ({behavior:"deny",message})
  if (tool === "StructuredOutput") return { behavior: "allow", updatedInput: input }
  if (!ISOLATED_TOOLS.includes(tool)) return deny("Tool unavailable in isolated Claude worker")
  if (tool === "Bash") {
    if (typeof input.command !== "string" || !input.command || input.run_in_background || input.dangerouslyDisableSandbox) return deny("Bash requires a foreground confined command")
    return {behavior:"allow",updatedInput:{...input,command:sandboxedBash(config,input.command),run_in_background:false}}
  }
  try {
    const raw = tool === "Grep" || tool === "Glob" ? input.path ?? config.workspace : input.file_path
    if (typeof raw !== "string" || !raw || /[\n\r\0]/.test(raw)) return deny("Missing or invalid file path")
    const path = canonical(resolve(config.workspace,raw))
    if (tool === "Edit" || tool === "Write") {
      if (!inside(path,config.scratch) && !(config.writable && inside(path,config.workspace))) return deny("Write outside allowed roots")
    } else {
      if (!readable(config,path)) return deny("Read outside allowed roots")
      if (tool === "Grep" || tool === "Glob") {
        const pattern = tool === "Glob" ? input.pattern : input.glob
        if (pattern !== undefined && (typeof pattern !== "string" || isAbsolute(pattern) || pattern.includes("..") || /[{}\[\]\\]/.test(pattern))) return deny("Search pattern escapes its root")
        if (!safeSearchTree(config,path)) return deny("Search tree contains an unapproved symlink")
      }
    }
    return {behavior:"allow",updatedInput:{...input,[tool === "Grep" || tool === "Glob" ? "path" : "file_path"]:path}}
  } catch { return deny("Cannot establish canonical tool target") }
}
export function isolatedClaudeOptions(config: ClaudeIsolation): Partial<Options> {
  return {
    tools:[...ISOLATED_TOOLS], disallowedTools:[...FORBIDDEN_TOOLS], settingSources:[], skills:[], agents:{},plugins:[],
    mcpServers:{},strictMcpConfig:true,persistSession:false,permissionMode:"default",sandbox:{enabled:false},
    // Ask rules are evaluated before automatic read approval and therefore make
    // this callback mandatory. No user hooks, shell profile, or MCP is needed.
    settings:{permissions:{ask:[...ISOLATED_TOOLS]},disableAllHooks:true,disableBundledSkills:true,autoMemoryEnabled:false,
      allowedMcpServers:[],deniedMcpServers:[{serverName:"*"}]},
    extraArgs:{"disable-slash-commands":null,"no-chrome":null},
    canUseTool:async(tool,input)=>isolatedToolPermission(config,tool,input),
  }
}
