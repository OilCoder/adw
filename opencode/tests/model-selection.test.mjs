import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import {
  configurationCost,
  orderConfigurations,
  selectModel,
  validateRegistry,
} from "../.opencode/codegen/lib/model-selection.mjs"
import { summarizeMetalog } from "../.opencode/codegen/lib/metalog.mjs"
import { summarizeEvents } from "../.opencode/codegen/lib/run-metrics.mjs"

const here = path.dirname(fileURLToPath(import.meta.url))
const registry = JSON.parse(
  await readFile(
    path.join(here, "..", ".opencode", "codegen", "config", "model-pools.json"),
    "utf8",
  ),
)

const byId = (id) => registry.configurations.find((item) => item.configuration_id === id)

test("registry is internally consistent", () => {
  assert.doesNotThrow(() => validateRegistry(registry))
})

test("the order inside a role is price, cheapest first, per provider tier; nobody writes it by hand", () => {
  const result = selectModel(registry, { role: "builder", workClass: "localized-low-risk-code-change", risk: "low", requiresCodeEditing: true })
  assert.equal(result.status, "SELECTED")
  assert.equal(result.selection.configuration_id, "builder-go-qwen3.8-flash")
  assert.equal(result.selection.rank, 1)
  assert.equal(result.selection.provider, "opencode-go")
  assert.equal(result.selection.availability, "not-checked")
  const costs = result.ladder.map((item) => [item.provider, item.cost_per_million])
  const go = costs.filter(([provider]) => provider === "opencode-go").map(([, cost]) => cost)
  const zen = costs.filter(([provider]) => provider === "opencode").map(([, cost]) => cost)
  assert.deepEqual(go, [...go].sort((a, b) => a - b), "Go rungs are cheapest first")
  assert.deepEqual(zen, [...zen].sort((a, b) => a - b), "Zen rungs are cheapest first")
  assert.equal(costs.findIndex(([provider]) => provider === "opencode"), go.length, "every Go rung comes before the first Zen rung")
  assert.deepEqual(configurationCost(byId("builder-go-qwen3.8-flash")), { total: 0.62, input: 0.15, output: 0.47, cached: 0.016 })
})

test("the Planner and the Goal Manager start on the OpenAI tier; every other role never sees it", () => {
  const planner = selectModel(registry, { role: "planner", workClass: "complex-engineering-plan", risk: "medium" })
  assert.equal(planner.selection.configuration_id, "planner-openai-gpt-5.6-sol")
  assert.equal(selectModel(registry, { role: "goal-manager", workClass: "complex-engineering-plan", risk: "medium" }).selection.provider, "openai")
  const researcher = selectModel(registry, { role: "researcher", workClass: "research-synthesis", risk: "medium" })
  assert.ok(researcher.ladder.every((item) => item.provider !== "openai"))
  assert.ok(researcher.rejected.every((item) => !item.reasons.includes("provider:openai")), "the OpenAI planner is not routed for research at all")
})

test("a configuration whose fit check failed is excluded; one demoted by the metalog sinks to the bottom until it succeeds again", () => {
  const request = { role: "builder", workClass: "localized-low-risk-code-change", risk: "low", requiresCodeEditing: true }
  const first = selectModel(registry, request).ladder.map((item) => item.configuration_id)
  const failedFit = summarizeMetalog([{ kind: "fit", configuration_id: first[0], outcome: "fail", reason: "no tool use" }])
  const withoutFirst = selectModel(registry, { ...request, metalog: failedFit })
  assert.equal(withoutFirst.selection.configuration_id, first[1])
  assert.ok(withoutFirst.rejected.some((item) => item.configuration_id === first[0] && item.reasons[0].startsWith("fit-failed:")))

  const failure = (id) => ({ kind: "call", role: "builder", configuration_id: id, outcome: "failure" })
  const demoted = summarizeMetalog([failure(first[0]), failure(first[0])])
  const sunk = selectModel(registry, { ...request, metalog: demoted })
  assert.equal(sunk.selection.configuration_id, first[1])
  assert.equal(sunk.ladder.at(-1).configuration_id, first[0], "two failures in a row sink the rung below every other one, Zen included")
  assert.equal(sunk.ladder.at(-1).consecutive_failures, 2)
  const recovered = summarizeMetalog([failure(first[0]), failure(first[0]), { kind: "call", role: "builder", configuration_id: first[0], outcome: "success" }])
  assert.equal(selectModel(registry, { ...request, metalog: recovered }).selection.configuration_id, first[0], "a success resets the streak")
  const oneFailure = summarizeMetalog([failure(first[0])])
  assert.equal(selectModel(registry, { ...request, metalog: oneFailure }).selection.configuration_id, first[0], "one failure is not repeated failure")
  const otherRole = summarizeMetalog([{ ...failure(first[0]), role: "gate-designer" }, { ...failure(first[0]), role: "gate-designer" }])
  assert.equal(selectModel(registry, { ...request, metalog: otherRole }).selection.configuration_id, first[0], "demotion is per role")
})

test("escalation excludes the rungs already tried and reports them", () => {
  const request = { role: "builder", workClass: "localized-low-risk-code-change", risk: "low", requiresCodeEditing: true }
  const ladder = selectModel(registry, request).ladder.map((item) => item.configuration_id)
  const next = selectModel(registry, { ...request, excludeConfigurations: ladder.slice(0, 2) })
  assert.equal(next.selection.configuration_id, ladder[2])
  assert.equal(next.selection.rank, 3)
  assert.deepEqual(next.rejected.filter((item) => item.reasons.includes("escalated-past")).map((item) => item.configuration_id), ladder.slice(0, 2))
  const exhausted = selectModel(registry, { ...request, excludeConfigurations: ladder })
  assert.equal(exhausted.status, "NO_MATCH")
})

test("the registry refuses hand-written orders and certified role entries", () => {
  const copy = structuredClone(registry)
  copy.runner_policies.builder.configuration_ids = ["builder-go-minimax-m3"]
  assert.throws(() => validateRegistry(copy), /computed from price/)
  const again = structuredClone(registry)
  again.configurations[0].admission.roles = { builder: { status: "qualified" } }
  assert.throws(() => validateRegistry(again), /admission is route membership plus the metalog/)
  const status = structuredClone(registry)
  status.configurations[0].status = "qualified"
  assert.throws(() => validateRegistry(status), /status must be one of active, watch, deprecated/)
  const threshold = structuredClone(registry)
  threshold.selection.demote_after_consecutive_failures = 0
  assert.throws(() => validateRegistry(threshold), /positive integer/)
})

test("the demotion threshold is the registry's number", () => {
  const copy = structuredClone(registry)
  copy.selection.demote_after_consecutive_failures = 3
  const request = { role: "builder", workClass: "localized-low-risk-code-change", risk: "low", requiresCodeEditing: true }
  const first = selectModel(copy, request).selection.configuration_id
  const failure = { kind: "call", role: "builder", configuration_id: first, outcome: "failure" }
  assert.equal(selectModel(copy, { ...request, metalog: summarizeMetalog([failure, failure]) }).selection.configuration_id, first)
  assert.notEqual(selectModel(copy, { ...request, metalog: summarizeMetalog([failure, failure, failure]) }).selection.configuration_id, first)
})

test("a pinned configuration must still pass every admission filter", () => {
  const pinned = selectModel(registry, {
    role: "builder",
    workClass: "localized-low-risk-code-change",
    requiresCodeEditing: true,
    configurationId: "builder-go-mimo-v2.5-pro",
  })
  assert.equal(pinned.selection.configuration_id, "builder-go-mimo-v2.5-pro")
  const tooRisky = selectModel(registry, {
    role: "builder",
    workClass: "localized-low-risk-code-change",
    risk: "medium",
    requiresCodeEditing: true,
    configurationId: "builder-local-gpt-oss-64k",
  })
  assert.equal(tooRisky.status, "NO_MATCH")
  assert.throws(() => selectModel(registry, { workClass: "localized-low-risk-code-change" }), /role must be one of/)
})

test("watch status, risk, and context filters remove insufficient configurations", () => {
  const result = selectModel(registry, {
    role: "builder",
    workClass: "localized-low-risk-code-change",
    risk: "medium",
    requiredContext: 150000,
    requiresCodeEditing: true,
  })
  assert.equal(result.status, "SELECTED")
  assert.ok(result.rejected.some((item) => item.configuration_id === "builder-go-qwen3.8-flash" && item.reasons.includes("risk-ceiling:low")))
  assert.ok(result.rejected.some((item) => item.configuration_id === "builder-go-mimo-v2.5-pro" && item.reasons.includes("context:131072")))
  const analysis = selectModel(registry, { role: "advisor", workClass: "independent-analysis", risk: "medium" })
  assert.ok(analysis.rejected.some((item) => item.configuration_id === "analyst-go-kimi-k3" && item.reasons.includes("status:watch")))
})

test("automatic routes contain Go and Zen but exclude OpenRouter", () => {
  const zen = registry.configurations.find(
    ({ configuration_id }) => configuration_id === "builder-zen-minimax-m3",
  )
  assert.equal(zen.provider, "opencode")
  assert.match(zen.opencode_model, /^opencode\//)
  assert.equal(registry.configurations.filter((item) => item.provider === "openrouter").length, 0)
  const routedProviders = Object.values(registry.routes).flat().map((id) =>
    registry.configurations.find((item) => item.configuration_id === id).provider,
  )
  assert.ok(routedProviders.includes("opencode-go"))
  assert.ok(routedProviders.includes("opencode"))
  assert.ok(!routedProviders.includes("openrouter"))
})

test("high-risk work escalates to a Zen-only model when Go models are insufficient", () => {
  const result = selectModel(registry, {
    role: "builder",
    workClass: "repository-code-change",
    risk: "high",
    requiresCodeEditing: true,
  })
  assert.equal(result.status, "SELECTED")
  assert.equal(result.selection.configuration_id, "builder-zen-claude-opus-5")
  assert.equal(result.selection.provider, "opencode")
})

test("Zen routing omits GPT Sol when authenticated OpenAI already supplies it", () => {
  assert.ok(!registry.configurations.some((item) => item.opencode_model === "opencode/gpt-5.6-sol"))
  assert.ok(registry.configurations.some((item) => item.opencode_model === "openai/gpt-5.6-sol"))
})

test("family exclusion preserves independent analysis", () => {
  const result = selectModel(registry, {
    role: "advisor",
    workClass: "independent-analysis",
    risk: "medium",
    excludeFamily: "mimo",
  })
  assert.equal(result.status, "SELECTED")
  assert.equal(result.selection.configuration_id, "builder-go-gpt-5.6-luna")
  assert.notEqual(result.selection.family, "mimo")
  assert.deepEqual(orderConfigurations(registry, "advisor", [byId("builder-go-gpt-5.6-luna"), byId("builder-go-mimo-v2.5-pro")]).map((c) => c.configuration_id), ["builder-go-mimo-v2.5-pro", "builder-go-gpt-5.6-luna"])
})

test("unknown work classes fail explicitly", () => {
  assert.throws(
    () => selectModel(registry, { role: "builder", workClass: "invented-work" }),
    /Unknown workClass/,
  )
})

test("OpenCode events are summarized without retaining provider headers", () => {
  const summary = summarizeEvents(
    [
      JSON.stringify({
        type: "step_finish",
        part: {
          cost: 0.25,
          tokens: {
            input: 100,
            output: 20,
            reasoning: 5,
            cache: { read: 10, write: 2 },
          },
        },
      }),
      JSON.stringify({ type: "text", part: { text: "Final safe status" } }),
      JSON.stringify({
        type: "error",
        error: {
          name: "APIError",
          data: {
            statusCode: 401,
            message: "User not found.",
            isRetryable: false,
            responseHeaders: { "set-cookie": "must-not-be-retained" },
          },
        },
      }),
    ].join("\n"),
  )

  assert.equal(summary.steps, 1)
  assert.equal(summary.input_tokens, 100)
  assert.equal(summary.reported_cost, 0.25)
  assert.equal(summary.final_text, "Final safe status")
  assert.deepEqual(summary.errors, [
    {
      name: "APIError",
      status_code: 401,
      message: "User not found.",
      retryable: false,
    },
  ])
  assert.equal(JSON.stringify(summary).includes("set-cookie"), false)
})
