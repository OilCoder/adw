import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import {
  classifyExecution,
  runBuilderExecution,
  selectBuilderExecutionPlan,
  selectExecutionPlan,
} from "../.opencode/codegen/lib/builder-runner.mjs"
import { classifyBuilderOutcome } from "../.opencode/codegen/lib/orchestrator.mjs"

const here = path.dirname(fileURLToPath(import.meta.url))
const registry = JSON.parse(
  await readFile(
    path.join(here, "..", ".opencode", "codegen", "config", "model-pools.json"),
    "utf8",
  ),
)

function errorEvent(statusCode, message, name = "APIError") {
  return `${JSON.stringify({
    type: "error",
    error: { name, data: { statusCode, message, isRetryable: true } },
  })}\n`
}

test("Builder plan selects the cheapest admitted Go configuration, with its rank and the whole ladder", () => {
  const plan = selectBuilderExecutionPlan(registry, {
    workClass: "localized-low-risk-code-change",
    risk: "low",
  })

  assert.equal(plan.status, "READY")
  assert.equal(plan.primary.configuration_id, "builder-go-glm-5.3-flash")
  assert.equal(plan.primary.rank, 1)
  assert.equal(plan.ladder[0], "builder-go-glm-5.3-flash")
  assert.ok(plan.ladder.length > 5)
  assert.equal("fallback" in plan, false)
  // Escalation excludes the rungs already tried; the rank still counts from the top.
  const next = selectBuilderExecutionPlan(registry, { workClass: "localized-low-risk-code-change", risk: "low", excludeConfigurations: [plan.ladder[0]] })
  assert.equal(next.primary.configuration_id, plan.ladder[1])
  assert.equal(next.primary.rank, 2)
})

test("Planner plan starts on the user's OpenAI subscription and falls to Go after it", () => {
  const plan = selectExecutionPlan(registry, "planner", {
    workClass: "complex-engineering-plan",
    risk: "medium",
    requiresTools: true,
    requiresCodeEditing: false,
  })

  assert.equal(plan.status, "READY")
  assert.equal(plan.primary.configuration_id, "planner-openai-gpt-5.6-sol")
  assert.equal(plan.primary.provider, "openai")
  assert.equal(plan.ladder[1], "planner-openai-gpt-5.6-terra", "the subscription models tie at zero cost; the tie breaks by id")
  assert.equal(plan.ladder[2], "builder-go-glm-5.3-flash", "the cheapest Go planner is the first Go rung")
  assert.equal("fallback" in plan, false)
})

test("Builder plan for high risk selects the cheapest Go configuration admitted at high risk", () => {
  const plan = selectBuilderExecutionPlan(registry, {
    workClass: "repository-code-change",
    risk: "high",
  })

  assert.equal(plan.status, "READY")
  assert.equal(plan.primary.configuration_id, "builder-go-gpt-5.6-luna")
  assert.equal(plan.primary.provider, "opencode-go")
  assert.equal("fallback" in plan, false)
})

test("provider limits and availability errors are classified without fallback", () => {
  const cases = [
    [402, "Go usage limit reached", "GO_USAGE_LIMIT"],
    [429, "Too many requests", "PROVIDER_RATE_LIMIT"],
    [503, "Service unavailable", "PROVIDER_UNAVAILABLE"],
  ]

  for (const [statusCode, message, expected] of cases) {
    const result = classifyExecution({
      exitCode: 1,
      eventsText: errorEvent(statusCode, message),
    })
    assert.equal(result.classification, expected)
  }
})

test("an exhausted Zen balance requests a recharge", () => {
  const result = classifyExecution({
    exitCode: 1,
    eventsText: errorEvent(402, "Insufficient credit balance. Add credits to continue."),
  })

  assert.equal(result.classification, "ZEN_BALANCE_EXHAUSTED")
  assert.match(result.user_action, /Recharge the Zen balance/)
})

test("auth, configuration, local timeout, and partial execution stop cleanly", () => {
  const cases = [
    { exitCode: 1, eventsText: errorEvent(401, "Unauthorized"), expected: "AUTH_ERROR" },
    { exitCode: 1, eventsText: errorEvent(404, "Unknown model"), expected: "MODEL_CONFIG_ERROR" },
    { exitCode: 124, expected: "LOCAL_RUNNER_ERROR" },
    {
      exitCode: 1,
      eventsText: errorEvent(503, "Service unavailable"),
      changedFiles: ["src/app.js"],
      expected: "PARTIAL_EXECUTION",
    },
  ]

  for (const { expected, ...execution } of cases) {
    const result = classifyExecution(execution)
    assert.equal(result.classification, expected)
    assert.equal(result.user_action, null)
  }
})

test("Runner stops after one Go call when the Zen balance is exhausted", async () => {
  const plan = selectBuilderExecutionPlan(registry, {
    workClass: "localized-low-risk-code-change",
  })
  const calls = []
  const result = await runBuilderExecution({
    plan,
    execute: async (configuration) => {
      calls.push(configuration.provider)
      return { exitCode: 1, eventsText: errorEvent(402, "Insufficient credit balance") }
    },
  })

  assert.deepEqual(calls, ["opencode-go"])
  assert.equal(result.status, "ZEN_BALANCE_EXHAUSTED")
  assert.match(result.user_action, /Recharge/)
})

test("Runner executes a single Go call after a non-provider failure", async () => {
  const plan = selectBuilderExecutionPlan(registry, {
    workClass: "localized-low-risk-code-change",
  })
  let calls = 0
  const result = await runBuilderExecution({
    plan,
    execute: async () => {
      calls += 1
      return { exitCode: 1, eventsText: errorEvent(401, "Unauthorized") }
    },
  })

  assert.equal(calls, 1)
  assert.equal(result.status, "AUTH_ERROR")
})

test("orchestrator stops for user action instead of retrying an empty Zen balance", () => {
  assert.deepEqual(
    classifyBuilderOutcome("ZEN_BALANCE_EXHAUSTED", { attempt: 1, maxAttempts: 2 }),
    { disposition: "STOP", status: "USER_ACTION_REQUIRED", reason: "ZEN_BALANCE_EXHAUSTED" },
  )
})

test("a runner without an admitted builder stops the contract as BLOCKED", async () => {
  const { classifyBuilderOutcome } = await import("../.opencode/codegen/lib/orchestrator.mjs")
  assert.deepEqual(classifyBuilderOutcome("NO_BUILDER_ADMITTED", { attempt: 1, maxAttempts: 2 }), { disposition: "STOP", status: "BLOCKED", reason: "NO_BUILDER_ADMITTED" })
})
