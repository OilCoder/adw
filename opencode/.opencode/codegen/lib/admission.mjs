// Admission by public benchmarks (MODEL_SELECTION_SPEC §8). The rule is
// code: config/benchmark-evidence.json holds every score with its source,
// this module decides who is admitted for what and at which risk, and
// scripts/admit.mjs writes the result into the registry. Nobody writes the
// list by hand, and a test keeps the registry equal to what the rule says.
export const RULE = {
  // Proof of writing code: one benchmark of real coding tasks at or above
  // its floor. Vendor-reported figures count here, but only for low risk.
  coding: {
    swe_bench_verified: 70,
    swe_rebench: 38,
    terminal_bench_2: 55,
    livebench_coding: 72,
    vendor_swe: 70,
    vendor_terminal_bench_2: 55,
  },
  // Proof of working with tools: any agentic benchmark. Those with a floor
  // need it; the rest count by presence (they are agentic by construction).
  tools: {
    swe_bench_verified: "coding-floor",
    swe_rebench: "coding-floor",
    terminal_bench_2: null,
    terminal_bench_3: null,
    terminal_bench_4: null,
    livebench_agentic: 45,
    vendor_terminal_bench_2: null,
    vendor_toolathlon: null,
    vendor_mcp_atlas: null,
  },
  // Proof of reasoning, for the roles that plan, research, and judge.
  reasoning: {
    aa_intelligence: 40,
    arena_text: 1470,
    livebench_agentic: 55,
  },
  // SWE-rebench: only contamination-free windows with enough problems.
  swe_rebench_min_sample: 100,
}

export const CODING_CLASSES = ["localized-low-risk-code-change", "repository-code-change"]
export const REASONING_CLASSES = ["complex-engineering-plan", "research-synthesis", "independent-analysis", "orchestration"]

const RISK_RANK = { low: 0, medium: 1, high: 2 }

// A score counts when it is confirmed and, for SWE-rebench, read on a
// clean window with enough problems.
function usable(score) {
  if (score.unconfirmed) return false
  if (score.source === "swe_rebench" && (score.sample ?? 0) < RULE.swe_rebench_min_sample) return false
  return true
}

function sourceOf(evidence, id) {
  return evidence.sources[id] ?? { independent: false, name: id }
}

function metFloor(score, floor) {
  return floor === null ? true : score.value >= floor
}

// Assessment of one model: which proofs it passes, on which sources, and
// the risk and work classes that follow.
export function assess(evidence, modelId) {
  const model = evidence.models[modelId]
  if (!model) throw new Error(`no evidence entry for ${modelId}`)
  const scores = (model.scores ?? []).filter(usable)
  const passes = (table) =>
    scores
      .filter((score) => score.source in table)
      .filter((score) => {
        const floor = table[score.source]
        if (floor === "coding-floor") return metFloor(score, RULE.coding[score.source])
        return metFloor(score, floor)
      })
      .map((score) => ({ source: score.source, value: score.value, independent: sourceOf(evidence, score.source).independent }))

  const coding = passes(RULE.coding)
  const tools = passes(RULE.tools)
  const reasoning = passes(RULE.reasoning)
  const codingIndependent = coding.filter((item) => item.independent)
  const codingOk = coding.length > 0 && tools.length > 0
  const reasoningOk = reasoning.length > 0

  // Risk for code: vendor-only proof → low; an independent proof → medium;
  // independent proofs (of code or of tools) on two different boards → high.
  let codingRisk = null
  if (codingOk) {
    codingRisk = "low"
    if (codingIndependent.length > 0) {
      codingRisk = "medium"
      const boards = new Set([...codingIndependent, ...tools.filter((item) => item.independent)].map((item) => sourceOf(evidence, item.source).url))
      if (boards.size >= 2) codingRisk = "high"
    }
  }
  const reasoningRisk = reasoningOk ? "medium" : null
  const maxRisk = codingRisk ?? reasoningRisk

  // The OpenAI subscription serves only the roles that reason (Planner,
  // Goal Manager); its models are never routed as Builders.
  const [provider] = modelId.split("/")
  const workClasses = []
  if (codingOk && provider !== "openai") {
    workClasses.push("localized-low-risk-code-change")
    if (RISK_RANK[codingRisk] >= RISK_RANK.medium) workClasses.push("repository-code-change")
  }
  if (reasoningOk) workClasses.push(...(provider === "openai" ? ["complex-engineering-plan", "orchestration"] : REASONING_CLASSES))

  const reasons = []
  if (!codingOk) reasons.push(coding.length === 0 ? "no coding proof at the floor" : "no tool-use proof")
  if (!reasoningOk) reasons.push("no reasoning proof at the floor")
  if (scores.length === 0) reasons.push("no usable score (none, or all unconfirmed)")

  return {
    model: modelId,
    admitted: workClasses.length > 0,
    unstable: Boolean(model.unstable),
    status: workClasses.length === 0 ? "candidate" : model.unstable ? "watch" : "active",
    coding: { ok: codingOk, risk: codingRisk, proofs: coding, tools },
    reasoning: { ok: reasoningOk, proofs: reasoning },
    max_risk: maxRisk,
    work_classes: workClasses,
    reasons,
  }
}

export function assessAll(evidence) {
  return Object.keys(evidence.models).map((id) => assess(evidence, id))
}

function configurationId(modelId, assessment) {
  const [provider, model] = modelId.split("/")
  const tier = provider === "openai" ? "openai" : provider === "opencode-go" ? "go" : provider
  const prefix = provider === "openai" ? "planner" : assessment.coding.ok ? "builder" : assessment.reasoning.ok ? "analyst" : "candidate"
  return `${prefix}-${tier}-${model}`
}

// One registry configuration per admitted model, built from the evidence.
// Existing admitted entries keep their configuration_id, prices, and
// context: those fields belong to scripts/catalog.mjs (models.dev), and the
// evidence's catalog snapshot only bootstraps a model that is new to the
// registry. Two writers of the same field would undo each other.
export function configurationFor(evidence, assessment, { existing = null } = {}) {
  const model = evidence.models[assessment.model]
  const [provider] = assessment.model.split("/")
  const catalog = model.catalog
  const quota = provider === "opencode-go"
  const key = (name) => (quota ? `${name}_quota_value` : name)
  const economics = existing?.economics ?? {
    currency: "USD",
    [key("input_per_million")]: catalog.input,
    [key("output_per_million")]: catalog.output,
    ...(catalog.cache_read !== null && catalog.cache_read !== undefined ? { [key("cached_input_per_million")]: catalog.cache_read } : {}),
    price_type: quota ? "opencode-go-subscription-quota" : provider === "openai" ? "openai-subscription" : "list-price",
    ...(model.note ? { note: model.note } : {}),
  }
  return {
    configuration_id: existing?.configuration_id ?? configurationId(assessment.model, assessment),
    opencode_model: assessment.model,
    provider,
    family: model.family,
    local: false,
    enabled: true,
    status: assessment.status,
    work_classes: assessment.work_classes,
    capabilities: {
      code_editing: assessment.coding.ok,
      tool_calling: true,
      structured_output: existing?.capabilities?.structured_output ?? false,
      context_tokens: existing?.capabilities?.context_tokens ?? catalog.context_tokens,
    },
    constraints: { max_risk: assessment.max_risk },
    economics,
    admission: {
      rule: "MODEL_SELECTION_SPEC §8, computed by lib/admission.mjs from config/benchmark-evidence.json",
      evidence_as_of: evidence.generated_at,
      coding: assessment.coding.ok ? { risk: assessment.coding.risk, proofs: assessment.coding.proofs.map((p) => `${p.source}=${p.value}`), tools: assessment.coding.tools.map((p) => `${p.source}=${p.value}`) } : null,
      reasoning: assessment.reasoning.ok ? { proofs: assessment.reasoning.proofs.map((p) => `${p.source}=${p.value}`) } : null,
      ...(assessment.unstable ? { watch: "preview, experimental, alpha, or contributor SKU: registered, never routed automatically" } : {}),
    },
  }
}

// The registry the rule implies: the non-catalog configurations the
// registry already had (local models) stay untouched; every catalog
// configuration is rebuilt from the evidence; routes list the admitted
// configurations per work class in evidence order.
export function applyAdmission(registry, evidence) {
  const assessments = assessAll(evidence)
  const byModel = new Map(registry.configurations.map((item) => [item.opencode_model, item]))
  const kept = registry.configurations.filter((item) => !(item.opencode_model in evidence.models) && !["opencode-go", "openai", "opencode"].includes(item.provider))
  const rebuilt = assessments
    .filter((item) => item.admitted)
    .map((item) => configurationFor(evidence, item, { existing: byModel.get(item.model) ?? null }))
  const configurations = [...kept, ...rebuilt]
  // Routes hold the admitted catalog configurations only; a local model
  // (ollama) stays registered for pinned maintenance runs, never routed.
  const routes = {}
  for (const workClass of [...CODING_CLASSES, ...REASONING_CLASSES]) {
    routes[workClass] = rebuilt.filter((item) => item.work_classes.includes(workClass)).map((item) => item.configuration_id)
  }
  return {
    registry: { ...registry, configurations, routes },
    assessments,
    admitted: assessments.filter((item) => item.admitted).map((item) => item.model),
    candidates: assessments.filter((item) => !item.admitted).map((item) => ({ model: item.model, reasons: item.reasons })),
  }
}

// True when the registry's admission (which models, for which classes, at
// which risk and status) equals what the rule implies. Prices and context
// are the catalog's (scripts/catalog.mjs apply) and are not compared. The
// drift test and `admit.mjs check` use it.
export function admissionDrift(registry, evidence) {
  const expected = applyAdmission(registry, evidence).registry
  const strip = ({ configuration_id, opencode_model, provider, family, status, enabled, work_classes, constraints }) => ({ configuration_id, opencode_model, provider, family, status, enabled, work_classes, max_risk: constraints?.max_risk })
  const normalize = (item) => JSON.stringify([...item.configurations].map(strip).sort((a, b) => a.configuration_id.localeCompare(b.configuration_id)))
  const differences = []
  if (normalize(registry) !== normalize(expected)) differences.push("configurations differ from the rule's output")
  for (const workClass of Object.keys(expected.routes)) {
    if (JSON.stringify(registry.routes[workClass] ?? []) !== JSON.stringify(expected.routes[workClass])) differences.push(`route ${workClass} differs`)
  }
  for (const workClass of Object.keys(registry.routes)) {
    if (!(workClass in expected.routes)) differences.push(`route ${workClass} is not one the rule produces`)
  }
  return differences
}
