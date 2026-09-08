import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { RULE, admissionDrift, applyAdmission, assess } from "../.opencode/codegen/lib/admission.mjs"
import { validateRegistry } from "../.opencode/codegen/lib/model-selection.mjs"

const here = path.dirname(fileURLToPath(import.meta.url))
const configDirectory = path.resolve(here, "../.opencode/codegen/config")
const registry = JSON.parse(await readFile(path.join(configDirectory, "model-pools.json"), "utf8"))
const evidence = JSON.parse(await readFile(path.join(configDirectory, "benchmark-evidence.json"), "utf8"))

// The registry is what the rule says, nothing else: whoever edits the
// evidence runs `admit.mjs apply`; whoever edits the registry by hand fails here.
test("the shipped registry equals the admission rule applied to the evidence", () => {
  assert.deepEqual(admissionDrift(registry, evidence), [])
  assert.doesNotThrow(() => validateRegistry(applyAdmission(registry, evidence).registry))
})

test("every score in the evidence names a known source, and unconfirmed scores never count", () => {
  for (const [id, model] of Object.entries(evidence.models)) {
    for (const score of model.scores) assert.ok(score.source in evidence.sources, `${id}: unknown source ${score.source}`)
  }
  const muse = assess(evidence, "opencode-go/muse-spark-1.3-contributor")
  assert.equal(muse.admitted, false)
  assert.ok(muse.reasons.includes("no usable score (none, or all unconfirmed)"))
})

test("coding needs a coding proof and a tool proof; vendor-only proof is low risk; two independent boards make high", () => {
  const cases = {
    "opencode-go/qwen3.6-plus": { admitted: false, reason: "no tool-use proof" },
    "opencode-go/minimax-m3": { risk: "low" },
    "opencode-go/glm-5.3-flash": { risk: "medium" },
    "opencode-go/gpt-5.6-luna": { risk: "high" },
    "opencode-go/deepseek-v4-pro": { risk: "high" },
  }
  for (const [id, expected] of Object.entries(cases)) {
    const result = assess(evidence, id)
    if (expected.admitted === false) {
      assert.equal(result.coding.ok, false, id)
      assert.ok(result.reasons.includes(expected.reason), `${id}: ${result.reasons}`)
    } else {
      assert.equal(result.coding.ok, true, id)
      assert.equal(result.coding.risk, expected.risk, id)
    }
  }
})

test("SWE-rebench counts only on clean windows with enough problems; reasoning-only models never build", () => {
  const flash = assess(evidence, "opencode-go/deepseek-v4-flash")
  assert.ok(!flash.coding.proofs.some((proof) => proof.source === "swe_rebench"), "a 23-problem window is not a proof")
  const pro = assess(evidence, "opencode-go/deepseek-v4-pro")
  assert.ok(pro.coding.proofs.some((proof) => proof.source === "swe_rebench" && proof.value >= RULE.coding.swe_rebench))
  const qwenMax = assess(evidence, "opencode-go/qwen3.7-max")
  assert.equal(qwenMax.coding.ok, false)
  assert.equal(qwenMax.reasoning.ok, true)
  assert.deepEqual(qwenMax.work_classes, ["complex-engineering-plan", "research-synthesis", "independent-analysis", "orchestration"])
})

test("the OpenAI subscription plans and orchestrates only; experimental SKUs are registered as watch", () => {
  const sol = assess(evidence, "openai/gpt-5.6-sol")
  assert.deepEqual(sol.work_classes, ["complex-engineering-plan", "orchestration"])
  assert.equal(sol.max_risk, "high")
  const vision = assess(evidence, "opencode-go/deepseek-v4-flash-vision-exp")
  assert.equal(vision.status, "watch")
  assert.equal(registry.configurations.find((item) => item.opencode_model === vision.model).status, "watch")
})
