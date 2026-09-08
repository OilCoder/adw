// Runtime selection for a runner: the cheapest admitted configuration of the
// role, skipping what the metalog excludes, with a fit check the first time
// this project uses a configuration. The runner then records its call.
import { selectExecutionPlan } from "./builder-runner.mjs"
import { resolveFitCheck, runFitCheck } from "./fit-check.mjs"
import { appendMetalog, callEntry, loadMetalogSummary } from "./metalog.mjs"

export async function selectConfiguration({ systemRoot, registry, role, request, args = {}, display = "inline", fitTimeoutSeconds = 120 }) {
  const fitMode = await resolveFitCheck(args, systemRoot)
  const fits = []
  const skipped = []
  while (true) {
    const metalog = await loadMetalogSummary(systemRoot)
    const excludeConfigurations = [...(request.excludeConfigurations ?? []), ...skipped]
    const plan = selectExecutionPlan(registry, role, { ...request, excludeConfigurations }, { metalog })
    if (plan.status !== "READY") return { ...plan, fits }
    const id = plan.primary.configuration_id
    if (fitMode === "off" || metalog.configurations[id]?.fit === "pass") return { ...plan, fits }
    const configuration = registry.configurations.find((item) => item.configuration_id === id)
    const fit = await runFitCheck({ systemRoot, configuration, display, timeoutSeconds: fitTimeoutSeconds })
    await appendMetalog(systemRoot, fit.entry)
    fits.push({ configuration_id: id, outcome: fit.outcome, result: fit.result, reason: fit.reason })
    if (fit.outcome === "pass") return { ...plan, fits }
    // A failed fit is now in the metalog and excluded by the selector; an
    // unknown one is skipped for this call only.
    skipped.push(id)
  }
}

// Fit of one given configuration (advisors and reconciler are chosen by
// family, not by the plan). Cached verdicts come from the metalog.
export async function ensureFit({ systemRoot, configuration, args = {}, display = "inline", fitTimeoutSeconds = 120 }) {
  const fitMode = await resolveFitCheck(args, systemRoot)
  const metalog = await loadMetalogSummary(systemRoot)
  const known = metalog.configurations[configuration.configuration_id]?.fit ?? null
  if (fitMode === "off" || known === "pass") return { outcome: "pass", cached: true }
  if (known === "fail") return { outcome: "fail", cached: true, reason: metalog.configurations[configuration.configuration_id].fit_reason }
  const fit = await runFitCheck({ systemRoot, configuration, display, timeoutSeconds: fitTimeoutSeconds })
  await appendMetalog(systemRoot, fit.entry)
  return { outcome: fit.outcome, reason: fit.reason, result: fit.result, cached: false }
}

export async function recordCall({ systemRoot, role, plan, result, success, runId, execution = null, reason = null, context = {} }) {
  return appendMetalog(systemRoot, callEntry({ role, selection: plan.primary, result, success, runId, execution, reason, context }))
}
