// Shape helpers for one contract: requirements with ids, kinds and
// verification, and checks that cover them. Shared by the plan validator,
// the Gate readiness check, the renderers, and the coverage ledger.

export const REQUIREMENT_KINDS = ["change", "preserve"]
export const REQUIREMENT_VERIFICATIONS = ["automated", "manual"]

// Defaults are the strict ones: a requirement is a change to be proven by a
// check unless the Planner explicitly declares otherwise.
export function normalizeRequirement(requirement) {
  return {
    id: requirement?.id,
    statement: requirement?.statement,
    kind: requirement?.kind ?? "change",
    verification: requirement?.verification ?? "automated",
    covers: Array.isArray(requirement?.covers) ? requirement.covers : [],
  }
}

export function contractRequirements(contract) {
  return Array.isArray(contract?.requirements)
    ? contract.requirements.filter((item) => item && typeof item === "object").map(normalizeRequirement)
    : []
}

export function contractChecks(contract) {
  return Array.isArray(contract?.verification?.checks) ? contract.verification.checks.filter((item) => item && typeof item === "object") : []
}

// A check that covers any change requirement must fail on the untouched
// baseline; one that covers only preserve requirements must already pass.
// The Planner never declares this: it follows from what the check covers.
export function expectedBaseline(check, contract) {
  const requirements = new Map(contractRequirements(contract).map((item) => [item.id, item]))
  const kinds = (check?.covers ?? []).map((id) => requirements.get(id)?.kind ?? "change")
  return kinds.some((kind) => kind === "change") ? "fail" : "pass"
}

// Pure refactor: every requirement preserves behavior, so no check proves a
// change happened. Allowed, but reported.
export function isPureRefactor(contract) {
  const requirements = contractRequirements(contract)
  return requirements.length > 0 && requirements.every((item) => item.kind === "preserve")
}
