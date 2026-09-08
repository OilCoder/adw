// Model selection: the registry names which configurations are admitted for
// each work class (routes, decided from public benchmarks) and which
// providers each role may use, in tier order. The order inside a role is
// never written by hand: it is the price per million tokens, cheapest first,
// with configurations the metalog demoted at the bottom.
const CATALOG_STATUSES = ["active", "watch", "deprecated"]

const RISK_RANK = {
  low: 0,
  medium: 1,
  high: 2,
}

// Roles that request configurations from the registry. The supervisor is the
// user's own interactive model and is never selected here.
export const ROLES = [
  "goal-manager",
  "planner",
  "gate-designer",
  "builder",
  "researcher",
  "advisor",
  "reconciler",
]

export const DEFAULT_DEMOTION_THRESHOLD = 2

function requireEnum(value, values, label) {
  if (!values.includes(value)) {
    throw new Error(`${label} must be one of: ${values.join(", ")}`)
  }
}

// One scalar per configuration: input plus output price per million tokens.
// Go stores subscription quota values in USD. The user's OpenAI subscription
// is not charged per call, so its configurations cost nothing here and tie;
// the tie breaks by configuration id (planner-openai-gpt-5.6-sol first).
export function configurationCost(configuration) {
  const economics = configuration.economics ?? {}
  if (economics.price_type === "openai-subscription") return { total: 0, input: 0, output: 0, cached: 0 }
  const input = economics.input_per_million ?? economics.input_per_million_quota_value ?? 0
  const output = economics.output_per_million ?? economics.output_per_million_quota_value ?? 0
  const cached = economics.cached_input_per_million ?? economics.cached_input_per_million_quota_value ?? 0
  return { total: input + output, input, output, cached }
}

export function demotionThreshold(registry) {
  return registry.selection?.demote_after_consecutive_failures ?? DEFAULT_DEMOTION_THRESHOLD
}

export function validateRegistry(registry) {
  if (registry?.schema_version !== 1) {
    throw new Error("Unsupported model-pool schema_version")
  }
  if (!registry.routes || !Array.isArray(registry.configurations)) {
    throw new Error("Registry must define routes and configurations")
  }
  if (registry.selection !== undefined) {
    const threshold = registry.selection?.demote_after_consecutive_failures
    if (!Number.isInteger(threshold) || threshold < 1) {
      throw new Error("selection.demote_after_consecutive_failures must be a positive integer")
    }
  }

  const ids = new Set()
  for (const configuration of registry.configurations) {
    if (!configuration.configuration_id || ids.has(configuration.configuration_id)) {
      throw new Error(`Missing or duplicate configuration_id: ${configuration.configuration_id}`)
    }
    ids.add(configuration.configuration_id)
    if (!CATALOG_STATUSES.includes(configuration.status)) {
      throw new Error(
        `Configuration ${configuration.configuration_id}: status must be one of ${CATALOG_STATUSES.join(", ")}`,
      )
    }
    requireEnum(configuration.constraints?.max_risk, Object.keys(RISK_RANK), "max_risk")
    if (!configuration.provider || !configuration.opencode_model?.startsWith(`${configuration.provider}/`)) {
      throw new Error(
        `Configuration ${configuration.configuration_id} must use its provider as model prefix`,
      )
    }
    if (configuration.admission?.roles) {
      throw new Error(
        `Configuration ${configuration.configuration_id} carries admission.roles; admission is route membership plus the metalog since 2026-09-08, not a certified role entry`,
      )
    }
  }

  for (const [workClass, route] of Object.entries(registry.routes)) {
    if (!Array.isArray(route) || route.length === 0) {
      throw new Error(`Route ${workClass} must contain configurations`)
    }
    for (const id of route) {
      if (!ids.has(id)) {
        throw new Error(`Route ${workClass} references unknown configuration: ${id}`)
      }
      const configuration = registry.configurations.find(
        (candidate) => candidate.configuration_id === id,
      )
      if (!configuration.work_classes.includes(workClass)) {
        throw new Error(`Configuration ${id} does not declare work class: ${workClass}`)
      }
    }
  }

  for (const [policyName, policy] of Object.entries(registry.runner_policies ?? {})) {
    if (!ROLES.includes(policyName)) {
      throw new Error(`Runner policy ${policyName} is not a registry role`)
    }
    if (!Array.isArray(policy.providers) || policy.providers.length === 0) {
      throw new Error(`${policyName} policy must define providers in tier order`)
    }
    if (policy.configuration_ids) {
      throw new Error(`${policyName} policy carries configuration_ids; the order is computed from price since 2026-09-08, never written by hand`)
    }
  }
}

export function eligibleConfigurations(registry, request) {
  validateRegistry(registry)

  const workClass = request.workClass
  const role = request.role
  const risk = request.risk ?? "low"
  const requiredContext = request.requiredContext ?? 0
  const requiresTools = request.requiresTools ?? true
  const requiresCodeEditing = request.requiresCodeEditing ?? false
  const excludeFamily = request.excludeFamily ?? null
  const configurationId = request.configurationId ?? null
  const metalog = request.metalog?.configurations ?? {}

  requireEnum(role, ROLES, "role")
  requireEnum(risk, Object.keys(RISK_RANK), "risk")
  if (!Number.isInteger(requiredContext) || requiredContext < 0) {
    throw new Error("requiredContext must be a non-negative integer")
  }

  const route = registry.routes[workClass]
  if (!route) {
    throw new Error(`Unknown workClass: ${workClass}`)
  }
  const policy = registry.runner_policies?.[role]
  if (!policy) throw new Error(`Registry does not define a ${role} runner policy`)

  const byId = new Map(
    registry.configurations.map((configuration) => [configuration.configuration_id, configuration]),
  )
  const rejected = []
  const eligible = []

  for (const id of route) {
    const configuration = byId.get(id)
    const reasons = []

    if (!configuration.enabled) reasons.push("disabled")
    if (configuration.status !== "active") reasons.push(`status:${configuration.status}`)
    if (!policy.providers.includes(configuration.provider)) reasons.push(`provider:${configuration.provider}`)
    if (RISK_RANK[configuration.constraints.max_risk] < RISK_RANK[risk]) {
      reasons.push(`risk-ceiling:${configuration.constraints.max_risk}`)
    }
    if (configuration.capabilities.context_tokens < requiredContext) {
      reasons.push(`context:${configuration.capabilities.context_tokens}`)
    }
    if (requiresTools && !configuration.capabilities.tool_calling) {
      reasons.push("missing-tool-calling")
    }
    if (requiresCodeEditing && !configuration.capabilities.code_editing) {
      reasons.push("missing-code-editing")
    }
    if (excludeFamily && configuration.family === excludeFamily) {
      reasons.push(`excluded-family:${excludeFamily}`)
    }
    if (configurationId && configuration.configuration_id !== configurationId) {
      reasons.push(`pinned:${configurationId}`)
    }
    if (metalog[id]?.fit === "fail") {
      reasons.push(`fit-failed:${metalog[id].fit_reason ?? "see metalog"}`)
    }

    if (reasons.length > 0) {
      rejected.push({ configuration_id: id, reasons })
    } else {
      eligible.push(configuration)
    }
  }

  return { eligible, rejected }
}

// The order of a role's list: configurations the metalog demoted last (the
// role's failures in a row reached the threshold), then the provider tier of
// the role policy, then price, cheapest first; ties by cached price and id.
export function orderConfigurations(registry, role, configurations, { metalog = null } = {}) {
  const policy = registry.runner_policies?.[role]
  if (!policy) throw new Error(`Registry does not define a ${role} runner policy`)
  const threshold = demotionThreshold(registry)
  const summary = metalog?.configurations ?? {}
  const keyed = configurations.map((configuration) => {
    const streak = summary[configuration.configuration_id]?.roles?.[role]?.consecutive_failures ?? 0
    const cost = configurationCost(configuration)
    return {
      configuration,
      demoted: streak >= threshold ? 1 : 0,
      tier: policy.providers.indexOf(configuration.provider),
      cost: cost.total,
      cached: cost.cached,
      id: configuration.configuration_id,
    }
  })
  keyed.sort(
    (a, b) =>
      a.demoted - b.demoted ||
      a.tier - b.tier ||
      a.cost - b.cost ||
      a.cached - b.cached ||
      a.id.localeCompare(b.id),
  )
  return keyed.map((item) => item.configuration)
}

export function selectionView(configuration, { rank = null, role = null, metalog = null } = {}) {
  const item = metalog?.configurations?.[configuration.configuration_id]
  return {
    configuration_id: configuration.configuration_id,
    model: configuration.opencode_model,
    provider: configuration.provider,
    family: configuration.family,
    rank,
    cost_per_million: configurationCost(configuration).total,
    context_tokens: configuration.capabilities?.context_tokens ?? null,
    consecutive_failures: role ? (item?.roles?.[role]?.consecutive_failures ?? 0) : null,
    availability: "not-checked",
  }
}

// The ordered list for a request, with the primary and its rank in the list
// before any escalation exclusion.
export function selectModel(registry, request) {
  const workClass = request.workClass
  const role = request.role
  const metalog = request.metalog ?? null
  const excluded = request.excludeConfigurations ?? []
  const { eligible, rejected } = eligibleConfigurations(registry, request)
  const ordered = orderConfigurations(registry, role, eligible, { metalog })
  const ladder = ordered.map((configuration, index) => selectionView(configuration, { rank: index + 1, role, metalog }))
  const primary = ladder.find((item) => !excluded.includes(item.configuration_id)) ?? null
  const rejectedAll = [
    ...rejected,
    ...ladder.filter((item) => excluded.includes(item.configuration_id)).map((item) => ({ configuration_id: item.configuration_id, reasons: ["escalated-past"] })),
  ]

  if (!primary) {
    return {
      status: "NO_MATCH",
      work_class: workClass,
      role,
      ladder,
      rejected: rejectedAll,
    }
  }

  return {
    status: "SELECTED",
    work_class: workClass,
    role,
    selection: primary,
    ladder,
    warnings: ["The Runner must verify live provider and endpoint availability before execution."],
    rejected: rejectedAll,
  }
}
