import { readFile } from "node:fs/promises"
import path from "node:path"
import { tool } from "@opencode-ai/plugin"

import { loadMetalogSummary } from "../codegen/lib/metalog.mjs"
import { ROLES, selectModel } from "../codegen/lib/model-selection.mjs"

export default tool({
  description:
    "Show the ordered list of configurations admitted for one role and work class: cheapest first inside each provider tier (OpenAI for the Planner and Goal Manager, then OpenCode Go, then Zen), with this project's metalog applied (failed fits excluded, repeated failures demoted). This does not check live provider availability.",
  args: {
    role: tool.schema.string().describe(`Role requesting the model: ${ROLES.join(", ")}`),
    workClass: tool.schema.string().describe("Work class declared in config/model-pools.json"),
    risk: tool.schema.string().optional().describe("low, medium, or high; defaults to low"),
    requiredContext: tool.schema
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe("Minimum context tokens required by the work"),
    requiresTools: tool.schema.boolean().optional().describe("Require tool calling; defaults to true"),
    requiresCodeEditing: tool.schema
      .boolean()
      .optional()
      .describe("Require demonstrated code-editing capability"),
    excludeFamily: tool.schema
      .string()
      .optional()
      .describe("Exclude a model family to preserve independent review"),
  },
  async execute(args, context) {
    const registryPath = path.join(
      context.directory,
      ".opencode",
      "codegen",
      "config",
      "model-pools.json",
    )
    const registry = JSON.parse(await readFile(registryPath, "utf8"))
    const metalog = await loadMetalogSummary(context.directory)
    return JSON.stringify(selectModel(registry, { ...args, metalog }), null, 2)
  },
})
