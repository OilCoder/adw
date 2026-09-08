import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { ROLES, eligibleConfigurations, roleStatus, validateRegistry } from "./model-selection.mjs"
import { selectExecutionPlan } from "./builder-runner.mjs"

const SCHEMA_DIRECTORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../schema")

// The schema each role produces or consumes. Certification evidence records
// a hash of it, so evidence gathered against an older shape can be told
// apart from evidence that matches what the runners enforce today.
export const ROLE_SCHEMAS = {
  "goal-manager": ["goal.schema.json"],
  planner: ["plan.schema.json"],
  "gate-designer": ["plan.schema.json"],
  builder: ["plan.schema.json"],
  researcher: ["research-report.schema.json"],
  advisor: ["opinion.schema.json"],
  reconciler: ["opinion.schema.json", "decision.schema.json"],
}

export async function roleSchemaHash(role, schemaDirectory = SCHEMA_DIRECTORY) {
  const files = ROLE_SCHEMAS[role]
  if (!files) throw new Error(`Unknown role: ${role}`)
  const hash = createHash("sha256")
  for (const file of files) hash.update(await readFile(path.join(schemaDirectory, file)))
  return hash.digest("hex")
}

// The requests the orchestrator and runners actually issue in production. A
// release is complete only when every one of them resolves to a qualified
// configuration for its role. Gate Designer requests exclude the family of the
// Builder that will implement the contract, exactly as orchestrate.mjs does.
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

// Configurations admitted for a role, in the role policy's order.
export function admittedForRole(registry, role, request) {
  const policy = registry.runner_policies?.[role]
  if (!policy) throw new Error(`Registry does not define a ${role} runner policy`)
  const { eligible, rejected } = eligibleConfigurations(registry, { ...request, role })
  const ordered = policy.configuration_ids
    .map((id) => eligible.find((configuration) => configuration.configuration_id === id))
    .filter((configuration) => configuration && policy.providers.includes(configuration.provider))
  return { eligible: ordered, rejected }
}

// Distinct families in policy order: advisors must be independent, and the
// reconciler comes from a family that gave no opinion.
export function independentFamilies(configurations) {
  const byFamily = new Map()
  for (const configuration of configurations) {
    if (!byFamily.has(configuration.family)) byFamily.set(configuration.family, configuration)
  }
  return [...byFamily.values()]
}

export function builderFamily(registry, minimumStatus = "qualified") {
  const plan = selectExecutionPlan(registry, "builder", {
    ...RELEASE_ROUTE.builder[0],
    minimumStatus,
  })
  return plan.status === "READY" ? plan.primary.family : null
}

export function checkRelease(registry, { minimumStatus = "qualified" } = {}) {
  validateRegistry(registry)
  const roles = {}
  const missing = []
  const builder = builderFamily(registry, minimumStatus)
  let advisorFamilies = []

  for (const role of ROLES) {
    const checks = []
    for (const spec of RELEASE_ROUTE[role]) {
      const request = {
        workClass: spec.workClass,
        risk: spec.risk,
        requiresTools: spec.requiresTools,
        requiresCodeEditing: spec.requiresCodeEditing,
        minimumStatus,
        excludeFamily: spec.excludeBuilderFamily ? builder : null,
      }
      const { eligible, rejected } = admittedForRole(registry, role, request)
      let families = independentFamilies(eligible)
      if (spec.excludeAdvisorFamilies) {
        families = families.filter((configuration) => !advisorFamilies.includes(configuration.family))
      }
      const required = spec.distinctFamilies ?? 1
      const ok = families.length >= required
      if (spec.distinctFamilies) advisorFamilies = families.slice(0, spec.distinctFamilies).map((c) => c.family)
      const check = {
        work_class: spec.workClass,
        risk: spec.risk,
        exclude_family: request.excludeFamily,
        required_families: required,
        selected: families.slice(0, required).map((configuration) => configuration.configuration_id),
        ok,
        rejected: ok ? [] : rejected,
      }
      checks.push(check)
      if (!ok) missing.push(`${role} has no ${minimumStatus} configuration for ${spec.workClass} (risk ${spec.risk}${request.excludeFamily ? `, excluding family ${request.excludeFamily}` : ""}${required > 1 ? `, ${required} distinct families` : ""})`)
    }
    roles[role] = checks
  }
  return { ok: missing.length === 0, minimum_status: minimumStatus, builder_family: builder, roles, missing }
}

export function recordCertification(registry, { configurationId, role, result, certifiedAt, evidence }) {
  if (!ROLES.includes(role)) throw new Error(`Unknown role: ${role}`)
  const configuration = registry.configurations.find((item) => item.configuration_id === configurationId)
  if (!configuration) throw new Error(`Unknown configuration: ${configurationId}`)
  configuration.admission ??= {}
  configuration.admission.roles ??= {}
  const previous = configuration.admission.roles[role] ?? {}
  if (result === "PASS") {
    configuration.admission.roles[role] = {
      status: "qualified",
      certified_at: certifiedAt,
      evidence,
    }
  } else {
    configuration.admission.roles[role] = {
      ...previous,
      status: previous.status === "qualified" ? "candidate" : (previous.status ?? "candidate"),
      last_failure: { at: certifiedAt, ...evidence },
    }
  }
  return configuration.admission.roles[role]
}

export function certificationSummary(registry) {
  const rows = []
  for (const configuration of registry.configurations) {
    for (const role of ROLES) {
      const entry = configuration.admission?.roles?.[role]
      if (entry) rows.push({ configuration_id: configuration.configuration_id, role, status: roleStatus(configuration, role), certified_at: entry.certified_at ?? null, run_id: entry.evidence?.run_id ?? null })
    }
  }
  return rows
}
