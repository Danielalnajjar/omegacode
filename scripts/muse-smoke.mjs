#!/usr/bin/env node
// Opt-in credential lane. Tests inject a fake executable; pnpm test never launches Muse.
import { spawnSync } from "node:child_process"
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { MuseWorker } from "../src/worker/muse.ts"

export async function runMuseSmoke({ bin, cwd = process.cwd(), timeoutMs = 120_000 }) {
  if (!bin) throw new Error("Muse smoke requires an explicit binary")
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const worker = new MuseWorker({ bin })
  const events = []
  try {
    const result = await worker.runAgent({
      provider: "muse", model: "muse-spark-1.3-contributor", effort: "low",
      sandbox: "read-only", approval: "never", maxTurns: 4, cwd,
      prompt: "Read README.md with read_file. Return its first heading exactly, without any other text.",
    }, { signal: controller.signal, onProgress: event => events.push(event) })
    const heading = readFileSync(join(cwd, "README.md"), "utf8").split("\n").find(line => line.startsWith("# "))
    if (!heading || !result.text.includes(heading)) throw new Error(`Muse smoke did not return README heading: ${result.text}`)
    if (!events.some(event => event.kind === "tool-result" && event.name === "read_file" && event.isError === false)) throw new Error("Muse smoke did not read the file")
    if (!(result.usage.inputTokens > 0 && result.usage.outputTokens > 0)) throw new Error("Muse smoke requires positive token usage")
    return { status: result.status, text: result.text, usage: result.usage, readFileObserved: true }
  } finally {
    clearTimeout(timer)
    await worker.shutdown()
  }
}

export function runEndToEnd(bin, spawnProcess = spawnSync) {
  const scratch = mkdtempSync(join(tmpdir(), "omega-muse-e2e-"))
  try {
    const file = join(scratch, "muse.workflow.js")
    writeFileSync(file, `export const meta = { name: "muse-e2e", description: "Read README through Muse" }\nreturn await agent("Read README.md with read_file and return its first heading exactly, without other text.", { provider: "muse", model: "muse-spark-1.3-contributor", sandbox: "read-only", effort: "low", maxTurns: 4, cwd: ${JSON.stringify(process.cwd())} })\n`)
    const args = ["dev", "run", file, "--no-serve", "--json"]
    process.stderr.write(`End-to-end command: pnpm ${args.join(" ")}\n`)
    const child = spawnProcess("pnpm", args, {
      env: { ...process.env, MUSE_BIN: bin, OMEGACODE_HOME: join(scratch, "omega-home") },
      encoding: "utf8", timeout: 180_000, maxBuffer: 2 * 1024 * 1024,
    })
    process.stdout.write(child.stdout ?? "")
    process.stderr.write(child.stderr ?? "")
    if (child.error) throw child.error
    if (child.status !== 0) throw new Error(`Muse end-to-end exited ${child.status}`)
    // pnpm prints a script banner before the CLI JSON.
    const lines = child.stdout.split(/\r?\n/)
    let outcome
    for (let start = lines.length - 1; start >= 0 && !outcome; start--) {
      if (lines[start] !== "{") continue
      for (let end = lines.length - 1; end > start; end--) {
        if (lines[end] !== "}") continue
        try { outcome = JSON.parse(lines.slice(start, end + 1).join("\n")); break } catch {}
      }
    }
    if (!outcome) throw new Error("Muse end-to-end stdout has no complete JSON object")
    const heading = readFileSync("README.md", "utf8").split("\n").find(line => line.startsWith("# "))
    if (outcome.status !== "completed" || typeof outcome.result !== "string" || !outcome.result.includes(heading)) throw new Error("Muse end-to-end did not complete with README text")
    const agents = join(scratch, "omega-home", "runs", outcome.runId, "agents")
    const events = readdirSync(agents).filter(name => name.endsWith(".jsonl")).flatMap(name =>
      readFileSync(join(agents, name), "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)))
    if (!events.some(event => event.kind === "tool-result" && event.name === "read_file" && event.isError === false)) throw new Error("Muse end-to-end has no read_file evidence")
    const journal = readFileSync(join(scratch, "omega-home", "runs", outcome.runId, "journal.jsonl"), "utf8")
      .split("\n").filter(Boolean).map(line => JSON.parse(line))
    const journalUsage = journal.filter(entry => entry.type === "result" && entry.provider === "muse").map(entry => entry.usage)
    if (!journalUsage.some(usage => usage.inputTokens > 0 && usage.outputTokens > 0)) throw new Error("Muse end-to-end requires positive journal token usage")
    console.log(JSON.stringify({ journalUsage }))
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2).filter(arg => arg !== "--")
  const index = args.indexOf("--bin")
  const bin = index >= 0 ? args[index + 1] : process.env.MUSE_BIN ?? "muse"
  try {
    if (args.includes("--e2e")) runEndToEnd(bin)
    else console.log(JSON.stringify(await runMuseSmoke({ bin }), null, 2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
