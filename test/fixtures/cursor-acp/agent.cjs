#!/usr/bin/env node
// Synthetic ACP peer for Cursor CLI 2026.11.19-f005e9d.
// Wire shapes come from the installed bundles; the model catalog is a fixture.
const assert = require("node:assert/strict")
const fs = require("node:fs")
const readline = require("node:readline")
const path = require("node:path")

assert.deepEqual(process.argv.slice(2), ["--disable-auto-update", "acp"])
const cwd = process.cwd()
const scenario = fs.readFileSync(path.join(cwd, "scenario"), "utf8")
const sessionId = `fixture-${process.pid}`
const record = path.join(cwd, `${sessionId}.jsonl`)
const config = process.env.CURSOR_CONFIG_DIR
assert.ok(fs.statSync(config).isDirectory())
assert.equal(process.env.CURSOR_DATA_DIR, config)
assert.equal(process.env.CURSOR_AGENT_DISABLE_DEBUG_LOG, "1")
assert.equal("CURSOR_AUTH_TOKEN" in process.env, false)
function note(event) { fs.appendFileSync(record, JSON.stringify(event) + "\n") }
note({ pid: process.pid, config, cwd })

let mode = "agent"
let model = "other-model"
let effort = "high"
const choices = (...values) => values.map(value => ({ value, name: value }))
const select = (id, category, currentValue, options) => ({ id, name: id, category, type: "select", currentValue, options })
const configOptions = () => [
  select("mode", "mode", mode, choices("agent", "ask", "plan")),
  select("model", "model", model, choices("other-model", "grok-4.7")),
  ...(model === "grok-4.7" && scenario !== "no-effort" ? [
    select("reasoning", "thought_level", effort, choices("medium", "high")),
  ] : []),
]
const options = [
  { optionId: "allow-always", kind: "allow_always" },
  { optionId: "allow-once", kind: "allow_once" },
  { optionId: "do-not-run", kind: "reject_once" },
]
const send = (message) => console.log(JSON.stringify({ jsonrpc: "2.0", ...message }))
const update = (value) => send({ method: "session/update", params: { sessionId, update: value } })
const message = (kind, text) => update({ sessionUpdate: kind, content: { type: "text", text } })
let promptId
let marker
function permission(id, kind, toolCallId) {
  send({ id, method: "session/request_permission", params: { sessionId, toolCall: { kind, toolCallId }, options } })
}
function finish() {
  if (scenario === "plain") message("agent_message_chunk", "Read-only fixture result.")
  else {
    message("agent_message_chunk", '{"source":')
    message("agent_message_chunk", '"fixture"}')
  }
  message("agent_message_chunk", "\n")
  message("agent_message_chunk", marker)
  send({ id: promptId, result: { stopReason: "end_turn" } })
}

if (scenario === "timeout") {
  setInterval(() => {}, 1000)
  process.on("SIGTERM", () => note({ term: true }))
}
readline.createInterface({ input: process.stdin }).on("line", line => {
  const frame = JSON.parse(line)
  note(frame)
  const { id, method, params, result, error } = frame
  const reply = value => send({ id, result: value })
  switch (method) {
    case "initialize":
      assert.deepEqual(params, {
        protocolVersion: 1,
        clientCapabilities: { _meta: { parameterizedModelPicker: true } },
      })
      return reply({ protocolVersion: 1 })
    case "session/new":
      assert.equal(fs.realpathSync(params.cwd), cwd)
      assert.deepEqual(params.mcpServers, [])
      if (scenario === "auth") {
        console.error("fixture-private-diagnostic")
        return send({ id, error: { code: -32000, message: "Authentication required", data: { detail: "fixture-private-diagnostic" } } })
      }
      return reply({ sessionId, configOptions: configOptions() })
    case "session/set_config_option":
      assert.equal(params.sessionId, sessionId)
      if (params.configId === "mode") mode = params.value
      else if (params.configId === "model" && scenario !== "wrong-model") model = params.value
      else if (params.configId === "reasoning") effort = params.value
      return reply({ configOptions: configOptions() })
    case "session/prompt":
      assert.equal(params.sessionId, sessionId)
      assert.deepEqual([mode, model, effort], ["ask", "grok-4.7", "medium"])
      assert.ok(Array.isArray(params.prompt) && params.prompt.length === 1)
      assert.equal(params.prompt[0].type, "text")
      assert.match(params.prompt[0].text, /Inspect the fixture/)
      marker = params.prompt[0].text.split("\n").at(-1)
      assert.match(marker, /^OMEGA_CURSOR_COMPLETE_[0-9a-f-]+$/)
      promptId = id
      message("agent_thought_chunk", "Checking source")
      if (scenario === "timeout" || scenario === "cancel") return
      if (scenario.startsWith("backend-")) {
        message("agent_message_chunk", "A partial answer.")
        if (scenario === "backend-unknown") {
          // Even if the model already wrote the marker, later provider text invalidates it.
          message("agent_message_chunk", `\n${marker}`)
          message("agent_message_chunk", "\n\nfixture-private-diagnostic")
        } else {
          const error = scenario === "backend-auth" ? "[unauthenticated] " : ""
          message("agent_message_chunk", `\n\nError: ${error}fixture-private-diagnostic`)
        }
        return reply({ stopReason: "end_turn" })
      }
      permission("web", "search", "web_search_fixture")
      permission("edit", "edit", "write_fixture")
      permission("mcp", "search", "mcp_fixture")
      send({ id: "terminal", method: "terminal/create", params: { sessionId } })
      return
    case "session/cancel":
      assert.equal(params.sessionId, sessionId)
      return
    case undefined:
      if (id === "web") assert.deepEqual(result, { outcome: { outcome: "selected", optionId: "allow-once" } })
      else if (id === "edit" || id === "mcp") assert.deepEqual(result, { outcome: { outcome: "selected", optionId: "do-not-run" } })
      else if (id === "terminal") { assert.equal(error.code, -32601); finish() }
      else assert.fail(`unexpected response: ${id}`)
      return
    default:
      assert.fail(`unexpected request: ${method}`)
  }
})
