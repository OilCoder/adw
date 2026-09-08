// Derived work: a finding discovered during build, verification, or
// integration. The Router classifies it before anything runs; it can never
// silently widen scope. Not wired into the orchestrator yet; when it is, the
// repair chain stops like every other loop, by lack of progress (a finding
// already repaired is never repaired again), not by a counter.
const DIRECT_CONDITIONS = [
  ["within_goal_scope", "outside-goal-scope"],
  ["localized", "not-localized"],
  ["low_risk", "not-low-risk"],
  ["existing_gate", "no-existing-gate"],
]

export function routeDerivedWork(finding) {
  const reasons = []
  if (!finding?.parent_contract_id) reasons.push("missing-parent-contract")
  if (!Array.isArray(finding?.evidence) || finding.evidence.length === 0) reasons.push("missing-evidence")
  if (reasons.length > 0) return { disposition: "REJECTED", reasons }

  if (finding.needs_product_decision) {
    return { disposition: "USER_DECISION_REQUIRED", reasons: ["needs-product-decision"] }
  }
  if (finding.changes_architecture || finding.changes_dependencies || finding.changes_api) {
    return {
      disposition: "REPLAN_REQUIRED",
      reasons: [
        ...(finding.changes_architecture ? ["changes-architecture"] : []),
        ...(finding.changes_dependencies ? ["changes-dependencies"] : []),
        ...(finding.changes_api ? ["changes-api"] : []),
      ],
    }
  }
  if (!finding.required_for_goal) return { disposition: "RECORDED", reasons: ["not-required-for-goal"] }

  for (const [field, reason] of DIRECT_CONDITIONS) {
    if (finding[field] !== true) reasons.push(reason)
  }
  if (!Array.isArray(finding.allowed_to_modify) || finding.allowed_to_modify.length === 0) {
    reasons.push("no-concrete-paths")
  }
  if (reasons.length > 0) return { disposition: "REPLAN_REQUIRED", reasons }

  return {
    disposition: "DIRECT_REPAIR",
    reasons: ["within-goal", "localized", "low-risk", "existing-gate"],
  }
}
