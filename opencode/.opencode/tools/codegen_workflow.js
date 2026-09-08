import { execFile } from "node:child_process"
import path from "node:path"
import { promisify } from "node:util"

import { tool } from "@opencode-ai/plugin"

import { resolveAttachUrl } from "../codegen/lib/agent-run.mjs"

const executeFile = promisify(execFile)
const operations = new Set(["draft", "deliberate", "revise", "approve", "orchestrate", "merge"])

// This tool runs inside the OpenCode runtime, whose own executable path is the
// OpenCode binary itself, so the runners are started through `node` from PATH.
const nodeBinary = process.env.CODEGEN_NODE ?? "node"

// Where the agents are shown is decided here, once, for every runner of the
// operation: attached to the supervisor's live server when the plugin
// published one (the sessions appear in the user's session list), inline
// otherwise. CODEGEN_DISPLAY=inline|tui forces a choice.
export async function chooseDisplay(directory, requested = process.env.CODEGEN_DISPLAY) {
  if (requested === "inline") return { display: "inline", url: null, reason: "CODEGEN_DISPLAY=inline" }
  const { url, published } = await resolveAttachUrl(directory)
  if (url) return { display: "tui", url, reason: `agent sessions attached to ${url}` }
  const why = published
    ? `${published} is published but nothing answers there: start the TUI with \`opencode --port 4096\` so the agents can attach`
    : "no OpenCode server published (.opencode/.codegen-server.json missing)"
  if (requested === "tui") throw new Error(`CODEGEN_DISPLAY=tui but ${why}`)
  const legacy = requested && requested !== "tui" ? `CODEGEN_DISPLAY=${requested} is no longer a display; ` : ""
  return { display: "inline", url: null, reason: `${legacy}${why}; events captured inline` }
}

export default tool({
  description:
    "Run the controlled code-generation workflow. Draft a Goal from user intent; deliberate an open Goal (research pending questions, obtain opinions on blocking questions with options, fold the evidence into the Goal); revise the Goal with the user's answers; approve the existing Goal after explicit user confirmation; orchestrate an approved Goal (on the planned route it stops as PLAN_REVIEW_REQUIRED with a PLAN.md for the user to review; call orchestrate again with `plan` set to the reviewed plan path to build); merge the integration branch of a completed run into the user's branch (fast-forward only) when the user explicitly asks.",
  args: {
    operation: tool.schema.string().describe("draft, deliberate, revise, approve, orchestrate, or merge"),
    plan: tool.schema.string().optional().describe("For orchestrate: path of the plan the user reviewed and approved (the plan_path of a PLAN_REVIEW_REQUIRED stop). Builds that plan instead of asking the Planner."),
    branch: tool.schema.string().optional().describe("Integration branch to merge; defaults to the latest completed run"),
    intent: tool.schema.string().optional().describe("Complete user intent for draft, or the user's answers to open questions for revise"),
    goal: tool.schema.string().optional().describe("Goal path; defaults to .codegen-goal/goal.json"),
  },
  async execute(args, context) {
    if (!operations.has(args.operation)) throw new Error("operation must be draft, deliberate, revise, approve, orchestrate, or merge")
    if (["draft", "revise"].includes(args.operation) && !args.intent?.trim()) throw new Error(`${args.operation} requires non-empty intent`)

    const goal = args.goal ?? ".codegen-goal/goal.json"
    const codegen = path.join(context.directory, ".opencode", "codegen", "scripts")
    const choice = await chooseDisplay(context.directory)
    let script
    let scriptArgs
    if (args.operation === "draft") {
      script = "run-goal.mjs"
      scriptArgs = ["--intent", args.intent, "--output", goal, "--display", choice.display]
    } else if (args.operation === "deliberate") {
      script = "deliberate.mjs"
      scriptArgs = ["--goal", goal, "--display", choice.display]
    } else if (args.operation === "revise") {
      script = "run-goal.mjs"
      scriptArgs = ["--revise", goal, "--intent", args.intent, "--display", choice.display]
    } else if (args.operation === "approve") {
      script = "run-goal.mjs"
      scriptArgs = ["--approve", goal]
    } else if (args.operation === "merge") {
      script = "merge-run.mjs"
      scriptArgs = args.branch ? ["--branch", args.branch] : []
    } else {
      script = "orchestrate.mjs"
      scriptArgs = ["--goal", goal, "--display", choice.display, ...(args.plan ? ["--plan", args.plan] : [])]
    }

    const env = { ...process.env, CODEGEN_DISPLAY: choice.display, ...(choice.url ? { CODEGEN_ATTACH: choice.url } : {}) }
    try {
      const result = await executeFile(nodeBinary, [path.join(codegen, script), ...scriptArgs], {
        cwd: context.directory,
        env,
        maxBuffer: 10 * 1024 * 1024,
        timeout: 60 * 60 * 1000,
      })
      return `display: ${choice.display} (${choice.reason})\n${result.stdout.trim() || JSON.stringify({ result: "OK", operation: args.operation })}`
    } catch (error) {
      const detail = [error.stdout, error.stderr, error.message].filter(Boolean).join("\n").trim()
      throw new Error(`Controlled workflow ${args.operation} failed (display: ${choice.display}):\n${detail}`)
    }
  },
})
