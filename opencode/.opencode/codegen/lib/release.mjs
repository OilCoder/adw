// The release check: every request production issues must resolve to at
// least one admitted configuration (two independent families for advisors,
// a third for the reconciler). Admission is membership in the routes of the
// registry, decided from public benchmarks; the metalog of a project may
// exclude or demote configurations later, never add them.
import { ROLES, eligibleConfigurations, orderConfigurations, validateRegistry } from "./model-selection.mjs"
import { selectExecutionPlan } from "./builder-runner.mjs"

export const RELEASE_ROUTE = {
  "goal-manager": [
    { workClass: "complex-engineering-plan", risk: "medium", requiresTools: true, requiresCodeEditing: false },
  ],
  planner: [
    { workClass: "complex-engineering-plan", risk: "medium", requiresTools: true, requiresCodeEditing: false },
  ],
  builder: [
    { workClass: "localized-low-risk-code-change", risk: "low", requiresTools: true, requiresCodeEditing: true },
    { workClass: "repository-code-change", risk: "medium", requiresTools: true, requiresCodeEditing: true },
  ],
  "gate-designer": [
    { workClass: "localized-low-risk-code-change", risk: "low", requiresTools: true, requiresCodeEditing: true, excludeBuilderFamily: true },
    { workClass: "repository-code-change", risk: "medium", requiresTools: true, requiresCodeEditing: true, excludeBuilderFamily: true },
  ],
  researcher: [
    { workClass: "research-synthesis", risk: "medium", requiresTools: true, requiresCodeEditing: false },
  ],
  advisor: [
    { workClass: "independent-analysis", risk: "medium", requiresTools: true, requiresCodeEditing: false, distinctFamilies: 2 },
  ],
  reconciler: [
    { workClass: "independent-analysis", risk: "medium", requiresTools: true, requiresCodeEditing: false, excludeAdvisorFamilies: true },
  ],
}

// Configurations admitted for a role, in selection order.
export function admittedForRole(registry, role, request, { metalog = null } = {}) {
  const { eligible, rejected } = eligibleConfigurations(registry, { ...request, role, metalog })
  return { eligible: orderConfigurations(registry, role, eligible, { metalog }), rejected }
}

// Distinct families in selection order: advisors must be independent, and
// the reconciler comes from a family that gave no opinion.
export function independentFamilies(configurations) {
  const byFamily = new Map()
  for (const configuration of configurations) {
    if (!byFamily.has(configuration.family)) byFamily.set(configuration.family, configuration)
  }
  return [...byFamily.values()]
}

export function builderFamily(registry, { metalog = null } = {}) {
  const plan = selectExecutionPlan(registry, "builder", RELEASE_ROUTE.builder[0], { metalog })
  return plan.status === "READY" ? plan.primary.family : null
}

export function checkRelease(registry, { metalog = null } = {}) {
  validateRegistry(registry)
  const roles = {}
  const missing = []
  const builder = builderFamily(registry, { metalog })
  let advisorFamilies = []

  for (const role of ROLES) {
    const checks = []
    for (const spec of RELEASE_ROUTE[role]) {
      const request = {
        workClass: spec.workClass,
        risk: spec.risk,
        requiresTools: spec.requiresTools,
        requiresCodeEditing: spec.requiresCodeEditing,
        excludeFamily: spec.excludeBuilderFamily ? builder : null,
      }
      const { eligible, rejected } = admittedForRole(registry, role, request, { metalog })
      let families = independentFamilies(eligible)
      if (spec.excludeAdvisorFamilies) {
        families = families.filter((configuration) => !advisorFamilies.includes(configuration.family))
      }
      const required = spec.distinctFamilies ?? 1
      const ok = families.length >= required
      if (spec.distinctFamilies) advisorFamilies = families.slice(0, spec.distinctFamilies).map((c) => c.family)
      checks.push({
        work_class: spec.workClass,
        risk: spec.risk,
        exclude_family: request.excludeFamily,
        required_families: required,
        selected: families.slice(0, required).map((configuration) => configuration.configuration_id),
        ladder: eligible.map((configuration) => configuration.configuration_id),
        ok,
        rejected: ok ? [] : rejected,
      })
      if (!ok) missing.push(`${role} has no admitted configuration for ${spec.workClass} (risk ${spec.risk}${request.excludeFamily ? `, excluding family ${request.excludeFamily}` : ""}${required > 1 ? `, ${required} distinct families` : ""})`)
    }
    roles[role] = checks
  }
  return { ok: missing.length === 0, builder_family: builder, roles, missing }
}
