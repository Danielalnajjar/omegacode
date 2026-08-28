export const meta = { name: "claude-profile-routing-smoke", description: "Direct Claude A/B/A routing proof", phases: [{ title: "A/B/A" }] }

phase("A/B/A")
const input = args
if (!input || typeof input !== "object") throw new Error("args must contain profileA, profileB, model, traceRoot, and nonce")
const lanes = [["A1", input.profileA], ["B", input.profileB], ["A2", input.profileA]]
return parallel(lanes.map(([lane, claudeProfile]) => () => agent(`Return exactly the sentinel ${lane}:${input.nonce}`, {
  provider: "claude-code", model: input.model, claudeProfile, label: lane,
  cwd: `${input.traceRoot}/${lane}`, sandbox: "read-only",
})))
