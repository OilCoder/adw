import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { validateGoal } from "../.opencode/codegen/lib/goal.mjs"
import { validateDecision, validateOpinion } from "../.opencode/codegen/lib/opinions.mjs"
import { validatePlan } from "../.opencode/codegen/lib/plan-validation.mjs"
import { validateResearchReport } from "../.opencode/codegen/lib/research-report.mjs"

const here = path.dirname(fileURLToPath(import.meta.url))
const schemaDirectory = path.resolve(here, "../.opencode/codegen/schema")

async function json(file) {
  return JSON.parse(await readFile(file, "utf8"))
}

// Guards the hand-written validators against drifting away from the JSON
// schemas: every top-level required field must be enforced by the validator.
for (const [schemaFile, fixtureFile, validate] of [
  ["goal.schema.json", "goal-research/goal.json", validateGoal],
  ["research-report.schema.json", "goal-research/report.json", validateResearchReport],
  ["opinion.schema.json", "opinions/opinion.json", validateOpinion],
  ["decision.schema.json", "opinions/decision.json", validateDecision],
  ["plan.schema.json", "orchestrator-basic/plan-template.json", validatePlan],
]) {
  test(`${schemaFile} required fields are enforced by the validator`, async () => {
    const schema = await json(path.join(schemaDirectory, schemaFile))
    const fixture = await json(path.join(here, "fixtures", fixtureFile))
    assert.equal(validate(fixture).valid, true)
    for (const field of schema.required) {
      const candidate = { ...fixture }
      delete candidate[field]
      assert.equal(validate(candidate).valid, false, `validator accepted missing ${field}`)
    }
    for (const field of Object.keys(fixture)) {
      assert.ok(field in schema.properties, `fixture field ${field} is not in the schema`)
    }
  })
}

// The contract shape is where the plan schema carries its rules: required
// fields of a contract, a requirement, and a check are enforced too.
test("plan.schema.json contract, requirement, and check required fields are enforced", async () => {
  const schema = await json(path.join(schemaDirectory, "plan.schema.json"))
  const fixture = await json(path.join(here, "fixtures", "orchestrator-basic/plan-template.json"))
  const mutate = (change) => {
    const plan = structuredClone(fixture)
    change(plan.phases[0].contracts[0])
    return validatePlan(plan).valid
  }
  for (const field of schema.$defs.contract.required) {
    assert.equal(mutate((contract) => delete contract[field]), false, `validator accepted contract without ${field}`)
  }
  for (const field of schema.$defs.requirement.required) {
    assert.equal(mutate((contract) => delete contract.requirements[0][field]), false, `validator accepted requirement without ${field}`)
  }
  for (const field of schema.$defs.check.required) {
    assert.equal(mutate((contract) => delete contract.verification.checks[0][field]), false, `validator accepted check without ${field}`)
  }
  for (const field of Object.keys(fixture.phases[0].contracts[0])) {
    assert.ok(field in schema.$defs.contract.properties, `contract field ${field} is not in the schema`)
  }
  for (const field of Object.keys(fixture.phases[0].contracts[0].requirements[0])) {
    assert.ok(field in schema.$defs.requirement.properties, `requirement field ${field} is not in the schema`)
  }
})
