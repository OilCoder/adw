import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

import {
  pathPatternsOverlap,
  planCoverage,
  validatePlan,
} from "../.opencode/codegen/lib/plan-validation.mjs"

function contract(contractId, allowedPath, { covers = [] } = {}) {
  return {
    contract_id: contractId,
    objective: `Implement ${contractId}`,
    work_class: "repository-code-change",
    risk: "medium",
    read: [allowedPath],
    allowed_to_modify: [allowedPath],
    forbidden: ["opencode.json", ".opencode/**"],
    requirements: [{ id: "R1", statement: `${contractId} behaves as specified`, kind: "change", verification: "automated", covers }],
    verification: {
      checks: [{ id: "C1", covers: ["R1"], command: "npm test" }],
      invariants: ["No files outside the contract change"],
    },
    budgets: {
      max_builder_attempts: 2,
      max_contract_revisions: 1,
      max_unplanned_scope_expansion: 0,
    },
    response: ["status", "changed files", "verification"],
  }
}

function validPlan() {
  return {
    schema_version: 1,
    plan_id: "parallel-example",
    objective: "Build two independent components and integrate them",
    base_revision: "0123456789abcdef",
    phases: [
      {
        phase_id: "users",
        objective: "Build users",
        depends_on: [],
        contracts: [contract("users-service", "src/users/service.js", { covers: ["REQ-1", "ACC-1"] })],
      },
      {
        phase_id: "products",
        objective: "Build products",
        depends_on: [],
        contracts: [contract("products-service", "src/products/service.js", { covers: ["REQ-2"] })],
      },
      {
        phase_id: "integration",
        objective: "Integrate both components",
        depends_on: ["users", "products"],
        contracts: [contract("integration-api", "src/api.js", { covers: ["REQ-1", "ACC-1"] })],
      },
    ],
  }
}

function goal() {
  return {
    goal_id: "g1",
    requirements: [
      { id: "REQ-1", statement: "Users can register", priority: "must" },
      { id: "REQ-2", statement: "Products are listed", priority: "must" },
      { id: "REQ-3", statement: "Nice to have", priority: "could" },
    ],
    acceptance_criteria: [
      { id: "ACC-1", criterion: "npm test passes", verification_type: "automated" },
      { id: "ACC-2", criterion: "Looks right in the browser", verification_type: "manual" },
    ],
  }
}

const workClasses = new Set(["repository-code-change"])

test("valid plan exposes parallel execution waves", () => {
  const result = validatePlan(validPlan(), { workClasses })

  assert.equal(result.valid, true, result.errors.join("\n"))
  assert.deepEqual(result.execution_waves, [["users", "products"], ["integration"]])
  assert.equal(result.coverage, null)
})

test("validator rejects overlapping contracts that could run concurrently", () => {
  const plan = validPlan()
  plan.phases[1].contracts[0].allowed_to_modify = ["src/users/**"]
  const result = validatePlan(plan, { workClasses })

  assert.equal(result.valid, false)
  assert.match(result.errors.join("\n"), /parallel contracts .* overlap/)
})

test("validator rejects cycles, unknown work classes, and unsafe paths", () => {
  const plan = validPlan()
  plan.phases[0].depends_on = ["integration"]
  plan.phases[0].contracts[0].work_class = "invented-work"
  plan.phases[0].contracts[0].read = ["../secret"]
  const result = validatePlan(plan, { workClasses })

  assert.equal(result.valid, false)
  assert.match(result.errors.join("\n"), /dependency graph contains a cycle/)
  assert.match(result.errors.join("\n"), /unknown work_class invented-work/)
  assert.match(result.errors.join("\n"), /unsupported path pattern in \w+: \.\.\/secret/)
})

test("path overlap is conservative for recursive directory patterns", () => {
  assert.equal(pathPatternsOverlap("src/users/**", "src/users/service.js"), true)
  assert.equal(pathPatternsOverlap("src/users/**", "src/products/service.js"), false)
})

test("validator accepts final_verification and can cap contracts per route", () => {
  const plan = validPlan()
  plan.final_verification = { commands: ["npm test"] }
  assert.equal(validatePlan(plan).valid, true)

  const capped = validatePlan(validPlan(), { maxContracts: 1 })
  assert.equal(capped.valid, false)
  assert.ok(capped.errors.some((error) => error.includes("allows at most 1")))

  const badFinal = { ...validPlan(), final_verification: { commands: [""] } }
  assert.ok(validatePlan(badFinal).errors.includes("final_verification.commands must be an array of commands"))
})

test("requirements carry ids and kinds; every automated requirement needs a check; manual ones get none", () => {
  const plan = validPlan()
  const c = plan.phases[0].contracts[0]

  // A second automated requirement without a check is rejected.
  c.requirements.push({ id: "R2", statement: "Also does the other thing", kind: "change", verification: "automated" })
  let errors = validatePlan(plan, { workClasses }).errors
  assert.ok(errors.some((e) => e.includes("requirement R2 has no check")), errors.join("\n"))

  // A manual requirement needs no check, but a check may not claim it.
  c.requirements[1].verification = "manual"
  assert.equal(validatePlan(plan, { workClasses }).valid, true)
  c.verification.checks[0].covers = ["R1", "R2"]
  errors = validatePlan(plan, { workClasses }).errors
  assert.ok(errors.some((e) => e.includes("manual requirement R2 is covered by check C1")), errors.join("\n"))
  c.verification.checks[0].covers = ["R1"]

  // Everything manual leaves nothing to gate.
  c.requirements[0].verification = "manual"
  c.verification.checks = [{ id: "C1", covers: ["R2"], command: "npm test" }]
  errors = validatePlan(plan, { workClasses }).errors
  assert.ok(errors.some((e) => e.includes("at least one requirement must be automated")), errors.join("\n"))

  // Old shape and declared baselines are named errors.
  const legacy = validPlan()
  legacy.phases[0].contracts[0].requirements = ["a plain string"]
  legacy.phases[0].contracts[0].verification = { commands: ["npm test"], invariants: [], expected_baseline: "pass" }
  errors = validatePlan(legacy, { workClasses }).errors
  assert.ok(errors.some((e) => e.includes("every requirement is an object")))
  assert.ok(errors.some((e) => e.includes("verification.commands was replaced by verification.checks")))
  assert.ok(errors.some((e) => e.includes("expected_baseline is not declared")))

  // Kinds and verification modes are closed sets; duplicate ids are rejected;
  // checks must cover known requirements and never call the wrapper.
  const bad = validPlan()
  const b = bad.phases[0].contracts[0]
  b.requirements[0].kind = "maybe"
  b.requirements.push({ id: "R1", statement: "dup", verification: "sometimes" })
  b.verification.checks.push({ id: "C1", covers: ["R9"], command: "bash .codegen-contract/gate.sh" })
  errors = validatePlan(bad, { workClasses }).errors
  for (const fragment of ["kind must be change or preserve", "duplicate requirement id R1", "verification must be automated or manual", "duplicate check id C1", "covers unknown requirement R9", "must not call .codegen-contract/gate.sh"]) {
    assert.ok(errors.some((e) => e.includes(fragment)), `${fragment}\n${errors.join("\n")}`)
  }
})

test("with a Goal, every must requirement and automated criterion must be covered; the rest is reported", () => {
  const result = validatePlan(validPlan(), { workClasses, goal: goal() })
  assert.equal(result.valid, true, result.errors.join("\n"))
  const byId = Object.fromEntries([...result.coverage.requirements, ...result.coverage.acceptance_criteria].map((item) => [item.id, item]))
  assert.equal(byId["REQ-1"].status, "covered")
  assert.deepEqual(byId["REQ-1"].claims.map((claim) => claim.contract_id), ["users-service", "integration-api"])
  assert.equal(byId["REQ-2"].status, "covered")
  assert.equal(byId["REQ-3"].status, "uncovered")
  assert.equal(byId["ACC-1"].status, "covered")
  assert.equal(byId["ACC-2"].status, "pending-human")

  // Dropping the only claim on a must requirement rejects the plan.
  const missing = validPlan()
  missing.phases[1].contracts[0].requirements[0].covers = []
  const rejected = validatePlan(missing, { workClasses, goal: goal() })
  assert.equal(rejected.valid, false)
  assert.ok(rejected.errors.some((e) => e.includes("Goal requirement REQ-2 (must) is not covered")), rejected.errors.join("\n"))

  // A manual claim keeps a must requirement from being uncovered but is reported as manual-only;
  // an automated criterion claimed only manually is rejected.
  const manual = validPlan()
  for (const phase of manual.phases) for (const c of phase.contracts) c.requirements[0].covers = []
  const c = manual.phases[0].contracts[0]
  c.requirements.push({ id: "R2", statement: "Reviewed by eye", verification: "manual", covers: ["REQ-1", "ACC-1"] })
  manual.phases[1].contracts[0].requirements[0].covers = ["REQ-2"]
  const partial = validatePlan(manual, { workClasses, goal: goal() })
  assert.equal(partial.coverage.requirements.find((item) => item.id === "REQ-1").status, "manual-only")
  assert.ok(partial.errors.some((e) => e.includes("Goal acceptance criterion ACC-1 (automated) is not covered by any automated")), partial.errors.join("\n"))
  assert.ok(!partial.errors.some((e) => e.includes("REQ-1")))
  assert.deepEqual(partial.coverage.manual_contract_requirements, [{ contract_id: "users-service", requirement_id: "R2", statement: "Reviewed by eye" }])

  // Unknown Goal ids are rejected.
  const unknown = validPlan()
  unknown.phases[0].contracts[0].requirements[0].covers = ["REQ-1", "ACC-1", "NOPE"]
  assert.ok(validatePlan(unknown, { workClasses, goal: goal() }).errors.some((e) => e.includes("covers unknown Goal id NOPE")))

  // Pure refactor contracts are reported, never rejected.
  const refactor = validPlan()
  refactor.phases[1].contracts[0].requirements[0].kind = "preserve"
  assert.deepEqual(planCoverage(refactor, goal()).pure_refactor_contracts, ["products-service"])
})

test("forbidden and read accept extension globs; allowed_to_modify stays exact; ext globs overlap exact paths", async () => {
  const base = JSON.parse(await readFile(new URL("./fixtures/orchestrator-basic/plan-template.json", import.meta.url), "utf8"))
  const plan = structuredClone(base)
  const contract = plan.phases[0].contracts[0]
  contract.forbidden = ["*.json", "**/*.md", "tests/**", "package.json"]
  contract.read = ["*.py", "lib/alpha.py"]
  let result = validatePlan(plan, { workClasses: new Set(["localized-low-risk-code-change"]) })
  assert.deepEqual(result.errors.filter((e) => e.includes("unsupported")), [])
  contract.allowed_to_modify = ["lib/*.py"]
  result = validatePlan(plan, { workClasses: new Set(["localized-low-risk-code-change"]) })
  assert.ok(result.errors.some((e) => e.includes("unsupported path pattern in allowed_to_modify: lib/*.py")), result.errors.join("\n"))
  contract.allowed_to_modify = ["lib/alpha.py"]
  contract.forbidden = ["*.py"]
  result = validatePlan(plan, { workClasses: new Set(["localized-low-risk-code-change"]) })
  assert.ok(result.errors.some((e) => e.includes("allowed path overlaps forbidden path")), result.errors.join("\n"))
  assert.equal(pathPatternsOverlap("*.json", "scripts/count-las.sh"), false)
  assert.equal(pathPatternsOverlap("scripts/count-las.sh", "*.sh"), true)
})

test("check commands that inspect Git state are rejected", async () => {
  const plan = JSON.parse(await readFile(new URL("./fixtures/orchestrator-basic/plan-template.json", import.meta.url), "utf8"))
  const contract = plan.phases[0].contracts[0]
  contract.verification.checks = [
    { id: "C1", covers: ["R1"], command: "bash scripts/x.sh" },
    { id: "C2", covers: ["R1"], command: "test \"$(git status --short)\" = \"?? scripts/x.sh\"" },
  ]
  const result = validatePlan(plan, { workClasses: new Set(plan.phases.flatMap((p) => p.contracts.map((c) => c.work_class))) })
  assert.ok(result.errors.some((e) => e.includes("check C2 must not inspect Git state")), result.errors.join("; "))
})

test("a contract cannot carry more risk than its Goal", async () => {
  const plan = JSON.parse(await readFile(new URL("./fixtures/orchestrator-basic/plan-template.json", import.meta.url), "utf8"))
  plan.phases[0].contracts[0].risk = "high"
  const classes = new Set(plan.phases.flatMap((p) => p.contracts.map((c) => c.work_class)))
  assert.ok(validatePlan(plan, { workClasses: classes, maxRisk: "medium" }).errors.some((e) => e.includes("exceeds the Goal's risk medium")))
  assert.equal(validatePlan(plan, { workClasses: classes, maxRisk: "high" }).errors.filter((e) => e.includes("exceeds")).length, 0)
})

test("the fixture plans cover the fixture Goals", async () => {
  for (const [planFile, goalFile] of [
    ["plan-template.json", ".codegen-goal/goal.json"],
    ["plan-direct.json", "goal-direct.json"],
  ]) {
    const plan = JSON.parse(await readFile(new URL(`./fixtures/orchestrator-basic/${planFile}`, import.meta.url), "utf8"))
    const fixtureGoal = JSON.parse(await readFile(new URL(`./fixtures/orchestrator-basic/${goalFile}`, import.meta.url), "utf8"))
    const result = validatePlan(plan, { workClasses: new Set(["localized-low-risk-code-change"]), goal: fixtureGoal })
    assert.equal(result.valid, true, `${planFile}: ${result.errors.join("\n")}`)
    assert.ok(result.coverage.requirements.every((item) => item.status === "covered"))
  }
})
