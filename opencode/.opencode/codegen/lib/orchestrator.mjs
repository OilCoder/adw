import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"

import { goalCoverage } from "./coverage.mjs"
import { runFinalGate } from "./final-gate.mjs"
import { checkGateReadiness, materializeGate } from "./gate.mjs"
import { routeGoal } from "./goal-routing.mjs"
import { validateGoal } from "./goal.mjs"
import { stopEntry } from "./metalog.mjs"
import { validatePlan } from "./plan-validation.mjs"
import {
  cherryPick,
  commitPaths,
  createWorktree,
  ensureExcluded,
  linkOpenCodeLayer,
  removeWorktree,
  resetWorktree,
  restorePaths,
  revision,
} from "./worktrees.mjs"

export const RUN_ROOT = ".codegen-run"

// Terminal dispositions after a Builder attempt, from CODE_GENERATION_FLOW §4.
const PROVIDER_STOPS = new Set(["PROVIDER_RATE_LIMIT", "PROVIDER_UNAVAILABLE"])
const USER_ACTION_STOPS = new Set(["ZEN_BALANCE_EXHAUSTED", "GO_USAGE_LIMIT"])
const BLOCKING_STOPS = new Set([
  "NO_BUILDER_ADMITTED",
  "AUTH_ERROR",
  "MODEL_CONFIG_ERROR",
  "LOCAL_RUNNER_ERROR",
  "UNCLASSIFIED_ERROR",
  "PARTIAL_EXECUTION",
])

// What the next attempt would be told: the result and the checks or paths
// behind it. An attempt that reproduces the signature of an earlier one would
// be retried with exactly the same evidence, which CODE_GENERATION_FLOW §4
// forbids, so the loop stops there. There is no attempt cap: the loop runs
// while each attempt brings new evidence.
export function attemptSignature(result, summary = {}) {
  const failing = (summary.verification ?? []).filter((check) => check.exit_code !== 0).map((check) => check.check_id).sort()
  const outside = [...(summary.outside_scope ?? [])].sort()
  return JSON.stringify({ result, failing, outside })
}

// `repeats` is the number of the earlier attempt this one reproduced, or null.
export function classifyBuilderOutcome(result, { attempt, repeats = null }) {
  if (result === "PASS") return { disposition: "ACCEPT" }
  const retriable = result === "GATE_FAIL" || result === "SCOPE_FAIL" || result === "NO_CHANGES"
  if (retriable) {
    if (repeats === null) return { disposition: "RETRY", reason: result }
    return { disposition: "STOP", status: "BUILD_FAILED", reason: `no progress: attempt ${attempt} reproduced attempt ${repeats} (${result})` }
  }
  if (result === "CONTRACT_BLOCKED") return { disposition: "STOP", status: "REPLAN_REQUIRED", reason: result }
  if (USER_ACTION_STOPS.has(result)) return { disposition: "STOP", status: "USER_ACTION_REQUIRED", reason: result }
  if (PROVIDER_STOPS.has(result)) return { disposition: "STOP", status: "ESCALATE", reason: result }
  if (BLOCKING_STOPS.has(result)) return { disposition: "STOP", status: "BLOCKED", reason: result }
  return { disposition: "STOP", status: "BLOCKED", reason: `unknown builder result ${result}` }
}

function pathspec(pattern) {
  return pattern.endsWith("/**") ? pattern.slice(0, -3) : pattern
}

async function pool(items, concurrency, worker) {
  const results = new Array(items.length)
  let next = 0
  async function lane() {
    while (next < items.length) {
      const index = next
      next += 1
      results[index] = await worker(items[index], index)
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, lane))
  return results
}

export async function orchestrate({
  directory,
  goalPath,
  planPath = null,
  registry,
  riskFloors = null,
  runners,
  runId,
  concurrency = 2,
  keepWorktrees = false,
  metalog = null,
  gateTimeoutSeconds = 300,
  log = () => {},
}) {
  const baseRevision = await revision(directory)
  const runDirectory = path.join(directory, RUN_ROOT, runId)
  await mkdir(runDirectory, { recursive: true })
  await ensureExcluded(directory, `${RUN_ROOT}/`)
  const eventsFile = path.join(runDirectory, "events.jsonl")
  const stateFile = path.join(runDirectory, "state.json")
  const state = {
    run_id: runId,
    status: "STARTED",
    stop_reason: null,
    goal_id: null,
    route: null,
    triage: null,
    plan_id: null,
    plan_path: null,
    plan_markdown: null,
    plan_reviewed: false,
    base_revision: null,
    integration_branch: `codegen/${runId}`,
    integration_worktree: path.join(runDirectory, "integration"),
    integration_head: null,
    waves: [],
    final_gate: null,
    goal_coverage: null,
    derived_work: [],
    escalations: [],
    planner_calls: 0,
    gate_designer_calls: 0,
    user_action: null,
  }
  async function emit(event, data = {}) {
    const record = { at: new Date().toISOString(), event, ...data }
    await appendFile(eventsFile, `${JSON.stringify(record)}\n`)
    log(record)
  }
  async function persist() {
    await writeFile(stateFile, `${JSON.stringify(state, null, 2)}\n`)
  }
  async function stop(status, reason, extra = {}) {
    state.status = status
    state.stop_reason = reason
    if (extra.user_action) state.user_action = extra.user_action
    await emit("RUN_STOPPED", { status, reason, ...extra })
    await persist()
    return state
  }

  // 1. Goal and Router.
  const goal = JSON.parse(await readFile(path.resolve(directory, goalPath), "utf8"))
  const goalValidation = validateGoal(goal)
  if (!goalValidation.valid) return stop("INVALID_GOAL", goalValidation.errors.join("; "))
  state.goal_id = goal.goal_id
  await emit("GOAL_LOADED", { goal_id: goal.goal_id, status: goal.status })
  const routing = routeGoal(goal)
  await emit("ROUTED", routing)
  // A Goal that still needs research or decisions stops for deliberation; a
  // deliberated Goal the user has not approved stops for approval. Only the
  // user seals a Goal, and only a SEALED Goal reaches the Planner.
  if (routing.status === "GOAL_NOT_SEALED") {
    return stop("APPROVAL_REQUIRED", `goal status is ${goal.status}, not SEALED`, { routing })
  }
  if (routing.status !== "ROUTED") return stop("ROUTE_BLOCKED", routing.status, { routing })
  if (routing.route === "deliberative") {
    return stop("DELIBERATION_REQUIRED", "goal needs research, opinions, or decisions before planning: run deliberate.mjs (codegen_workflow deliberate), then approve", { routing })
  }
  if (goal.status !== "SEALED") return stop("APPROVAL_REQUIRED", `goal status is ${goal.status}, not SEALED`, { routing })
  state.route = routing.route
  state.base_revision = baseRevision

  // 2. Plan: reuse a plan the user reviewed, or ask the Planner. The direct
  //    route asks for one contract; a plan that needs more is re-routed.
  const workClasses = new Set(Object.keys(registry.routes))
  let plan
  if (planPath) {
    plan = JSON.parse(await readFile(path.resolve(directory, planPath), "utf8"))
    state.plan_path = planPath
    state.plan_reviewed = true
  } else {
    // A plan the validator rejects is re-requested with the errors as
    // evidence while the errors change. A plan that reproduces the errors of
    // an earlier attempt would be re-requested with the same evidence: no
    // progress for that configuration, so the orchestrator climbs one rung
    // of the Planner's list (the next configuration gets the evidence) and
    // stops only when the list is exhausted. Any other failure stops at once.
    const excluded = []
    let errorSets = []
    let evidence = null
    let output = null
    while (true) {
      state.planner_calls += 1
      output = `.codegen-plan/${runId}${state.planner_calls > 1 ? `-${state.planner_calls}` : ""}.json`
      await emit("PLAN_REQUESTED", { output, route: routing.route, attempt: state.planner_calls, evidence, excluded: [...excluded] })
      const summary = await runners.planner({
        directory,
        objective: goal.objective,
        goal: goalPath,
        output,
        route: routing.route,
        evidence,
        excludeConfigurations: [...excluded],
      })
      const selection = summary.selection ?? null
      await emit("PLAN_GENERATED", { result: summary.result ?? summary.status, output, attempt: state.planner_calls, markdown: summary.markdown ?? null, configuration_id: selection?.configuration_id ?? null, rank: selection?.rank ?? null })
      if (summary.result === "PASS") {
        state.plan_markdown = summary.markdown ?? null
        break
      }
      if (summary.status === "NO_MATCH") {
        return stop("PLAN_FAILED", `no planner admitted${excluded.length > 0 ? ` after escalating past ${excluded.join(", ")}` : ""}`, { rejected: summary.rejected ?? null, attempts: state.planner_calls })
      }
      if (summary.result !== "PLAN_INVALID") return stop("PLAN_FAILED", summary.result, { validation: summary.validation ?? null, attempts: state.planner_calls })
      const errors = [...(summary.validation?.errors ?? [])].sort()
      const repeats = errorSets.findIndex((item) => item.length === errors.length && item.every((error, index) => error === errors[index]))
      errorSets.push(errors)
      evidence = `.codegen-plan/${runId}-${state.planner_calls}.evidence.json`
      await mkdir(path.dirname(path.resolve(directory, evidence)), { recursive: true })
      await writeFile(
        path.resolve(directory, evidence),
        `${JSON.stringify({ attempt: state.planner_calls, rejected_plan: output, errors: summary.validation?.errors ?? [], ...(repeats !== -1 ? { escalated_from: selection?.configuration_id ?? null } : {}) }, null, 2)}\n`,
      )
      if (repeats === -1) {
        await emit("PLAN_RETRY", { attempt: state.planner_calls, evidence, errors: summary.validation?.errors ?? [] })
        continue
      }
      const reason = `no progress: attempt ${state.planner_calls} reproduced the validation errors of attempt ${repeats + 1}`
      if (selection?.configuration_id) {
        await metalog?.append?.(stopEntry({ role: "planner", selection, reason, runId, context: { attempt: state.planner_calls } }))
      }
      const next = selection ? ((selection.ladder ?? []).find((id) => id !== selection.configuration_id && !excluded.includes(id)) ?? null) : null
      if (!next) {
        return stop("PLAN_FAILED", `${reason}; no other planner admitted`, { validation: summary.validation ?? null, attempts: state.planner_calls })
      }
      excluded.push(selection.configuration_id)
      errorSets = []
      const escalation = { role: "planner", from: selection.configuration_id, to: next, reason, evidence }
      state.escalations.push(escalation)
      await emit("ESCALATED", escalation)
    }
    plan = JSON.parse(await readFile(path.resolve(directory, output), "utf8"))
    state.plan_path = output
  }
  // The plan is validated against the Goal: every must requirement and every
  // automated acceptance criterion has to be claimed by some contract. The
  // Goal's triage is judged again with the plan's evidence: a direct route
  // that needs more than one contract becomes planned, and a contract's
  // effective risk is the highest of what the Planner declared and what its
  // paths imply. The code only ever raises a label; a raise is a
  // contradiction the user accepts at plan review.
  const planValidation = validatePlan(plan, { workClasses, goal, route: routing.route, riskFloors })
  await emit("PLAN_VALIDATED", { valid: planValidation.valid, errors: planValidation.errors, execution_waves: planValidation.execution_waves })
  if (!planValidation.valid) return stop("PLAN_INVALID", planValidation.errors.join("; "))
  if (plan.base_revision !== baseRevision) {
    return stop("PLAN_STALE", `plan base_revision ${plan.base_revision} is not HEAD ${baseRevision}`)
  }
  state.plan_id = plan.plan_id
  state.triage = planValidation.triage
  state.route = planValidation.triage.route_effective
  for (const contradiction of planValidation.triage.contradictions) await emit("TRIAGE_CONTRADICTED", contradiction)
  const riskByContract = new Map(planValidation.triage.contracts.map((item) => [item.contract_id, item.risk_effective]))
  await emit("DAG_READY", { waves: planValidation.execution_waves, route: state.route, risk_effective: planValidation.triage.risk_effective })

  // On the planned route, or whenever the plan contradicts the Goal's
  // triage, the user reviews PLAN.md before anyone builds: the run stops
  // here, before any worktree exists, and resumes when orchestrate is called
  // again with the reviewed plan. A direct route that fits its labels builds
  // straight through.
  const needsReview = state.route === "planned" || planValidation.triage.contradictions.length > 0
  if (needsReview && !state.plan_reviewed) {
    return stop("PLAN_REVIEW_REQUIRED", `review ${state.plan_markdown ?? state.plan_path} and orchestrate again with --plan ${state.plan_path}`, {
      plan_path: state.plan_path,
      plan_markdown: state.plan_markdown,
      contradictions: planValidation.triage.contradictions,
    })
  }

  const phasesById = new Map(plan.phases.map((phase) => [phase.phase_id, phase]))

  // 3. Integration branch, isolated from the user's checkout.
  await createWorktree({
    repository: directory,
    directory: state.integration_worktree,
    revision: baseRevision,
    branch: state.integration_branch,
  })
  state.integration_head = baseRevision
  await persist()

  const gateSources = []
  const worktreesToRemove = []

  // 4. Waves: one worktree per contract, builders in parallel, gates per contract.
  for (const [waveIndex, phaseIds] of planValidation.execution_waves.entries()) {
    const contracts = phaseIds.flatMap((phaseId) =>
      phasesById.get(phaseId).contracts.map((contract) => ({ phaseId, contract })),
    )
    const wave = { index: waveIndex + 1, phases: phaseIds, status: "STARTED", contracts: [] }
    state.waves.push(wave)
    await emit("WAVE_READY", { wave: wave.index, phases: phaseIds, contracts: contracts.map((c) => c.contract.contract_id) })

    // 4a. Prepare worktrees serially: seal contract + gate, check readiness.
    const prepared = []
    for (const { phaseId, contract } of contracts) {
      const worktree = path.join(runDirectory, "worktrees", contract.contract_id)
      await createWorktree({ repository: directory, directory: worktree, revision: state.integration_head })
      worktreesToRemove.push(worktree)
      await linkOpenCodeLayer(directory, worktree)
      await emit("WORKTREE_CREATED", { contract_id: contract.contract_id, worktree, base: state.integration_head })

      // Seal: one script per check under .codegen-contract/checks/, the
      // generated gate.sh that runs them all, and the contract pointing at
      // the scripts. The Gate Designer may later rewrite check bodies only.
      const contractDirectory = path.join(worktree, ".codegen-contract")
      await mkdir(contractDirectory, { recursive: true })
      const sealed = await materializeGate(worktree, contract)
      await writeFile(path.join(contractDirectory, "contract.json"), `${JSON.stringify(sealed, null, 2)}\n`)
      await commitPaths(worktree, [".codegen-contract"], `codegen: seal ${contract.contract_id}`, { force: true })

      const riskEffective = riskByContract.get(contract.contract_id) ?? contract.risk
      const record = {
        contract_id: contract.contract_id,
        phase_id: phaseId,
        worktree,
        status: "PREPARED",
        risk_effective: riskEffective,
        gate_readiness: null,
        attempts: [],
        escalations: [],
        sealed_commit: null,
        result_commit: null,
        stop: null,
      }
      wave.contracts.push(record)

      let readiness = await checkGateReadiness({ directory: worktree, contract: sealed, timeoutSeconds: gateTimeoutSeconds })
      if (!readiness.ready && readiness.fixable) {
        await emit("GATE_DESIGN_REQUESTED", { contract_id: contract.contract_id, reasons: readiness.reasons })
        // The Goal said a Gate already existed; the evidence says otherwise.
        // Recorded, never silently corrected: the Gate Designer resolves it.
        if (goal.routing.existing_gate) {
          const contradiction = {
            label: "existing_gate",
            claimed: true,
            effective: false,
            evidence: `${contract.contract_id}: ${readiness.reasons.join(", ")}; the Gate Designer had to make the checks real`,
          }
          state.triage.contradictions.push(contradiction)
          await emit("TRIAGE_CONTRADICTED", contradiction)
        }
        state.gate_designer_calls += 1
        const design = await runners.gateDesigner({
          directory: worktree,
          contract: ".codegen-contract/contract.json",
          workClass: contract.work_class,
          risk: riskEffective,
        })
        await emit("GATE_DESIGNED", { contract_id: contract.contract_id, result: design.result })
        if (design.result === "GATE_READY") {
          await commitPaths(worktree, [".codegen-contract"], `codegen: gate ${contract.contract_id}`, { force: true })
          readiness = design.readiness_after
        }
      }
      record.gate_readiness = readiness
      if (!readiness.ready) {
        record.status = "GATE_NOT_READY"
        wave.status = "BLOCKED"
        await emit("WAVE_BLOCKED", { wave: wave.index, contract_id: contract.contract_id, reasons: readiness.reasons })
        await persist()
        return stop("GATE_NOT_READY", `${contract.contract_id}: ${readiness.reasons.join(", ")}`)
      }
      await emit("GATE_READY", { contract_id: contract.contract_id, baseline: readiness.baseline })
      record.sealed_commit = await revision(worktree)
      prepared.push({ contract, record, sealed })
    }
    await persist()

    // 4b. Build contracts of the wave concurrently.
    await pool(prepared, concurrency, async ({ contract, record }) => {
      // Attempts run while each one brings new evidence. When a configuration
      // reproduces an earlier attempt (no progress) the orchestrator climbs
      // one rung: the worktree goes back to the sealed contract and the next
      // configuration of the Builder's list gets the accumulated evidence.
      // The contract fails only when the list is exhausted.
      const excluded = []
      let signatures = []
      let evidence = null
      for (let attempt = 1; ; attempt += 1) {
        await emit("BUILDER_DISPATCHED", { contract_id: contract.contract_id, attempt, evidence, excluded: [...excluded] })
        const summary = await runners.builder({
          directory: record.worktree,
          contract: ".codegen-contract/contract.json",
          workClass: contract.work_class,
          risk: record.risk_effective,
          evidence,
          excludeConfigurations: [...excluded],
        })
        const selection = summary.selection ?? null
        // A runner that could not select a configuration reports status
        // NO_MATCH instead of a result; that is a blocking stop with the
        // admission reasons, not an unknown result.
        const result = summary.result ?? (summary.status === "NO_MATCH" ? "NO_BUILDER_ADMITTED" : summary.status)
        const signature = attemptSignature(result, summary)
        const repeats = signatures.find((item) => item.signature === signature)?.attempt ?? null
        signatures.push({ attempt, signature })
        record.attempts.push({ attempt, rung: excluded.length + 1, configuration_id: selection?.configuration_id ?? null, result, evidence, repeats, summary })
        const outcome = classifyBuilderOutcome(result, { attempt, repeats })
        if (result === "NO_BUILDER_ADMITTED") {
          outcome.reason = `no builder admitted for ${contract.work_class} at risk ${record.risk_effective}${excluded.length > 0 ? ` after escalating past ${excluded.join(", ")}` : ""}: ${(summary.rejected ?? []).slice(0, 4).map((r) => `${r.configuration_id} (${(r.reasons ?? []).join(", ")})`).join("; ")}`
        }
        if (outcome.disposition === "ACCEPT") {
          record.result_commit = await commitPaths(
            record.worktree,
            contract.allowed_to_modify.map(pathspec),
            `codegen(${contract.contract_id}): ${contract.objective}`,
          )
          record.status = record.result_commit ? "PASSED" : "NO_RESULT_COMMIT"
          await emit("CONTRACT_PASSED", { contract_id: contract.contract_id, attempt, commit: record.result_commit })
          return
        }
        if (outcome.disposition === "RETRY") {
          if (summary.result === "SCOPE_FAIL") await restorePaths(record.worktree, summary.outside_scope ?? [])
          evidence = `.codegen-contract/evidence-${attempt}.json`
          await writeFile(
            path.join(record.worktree, evidence),
            `${JSON.stringify({ attempt, result: summary.result, outside_scope: summary.outside_scope, verification: summary.verification, attempts: summary.attempts }, null, 2)}\n`,
          )
          await emit("RETRY", { contract_id: contract.contract_id, attempt, reason: outcome.reason, evidence })
          continue
        }
        if (outcome.status === "BUILD_FAILED" && selection?.configuration_id) {
          await metalog?.append?.(stopEntry({ role: "builder", selection, reason: outcome.reason, runId, context: { contract_id: contract.contract_id, attempt } }))
          const next = (selection.ladder ?? []).find((id) => id !== selection.configuration_id && !excluded.includes(id)) ?? null
          if (next) {
            excluded.push(selection.configuration_id)
            await resetWorktree(record.worktree, record.sealed_commit)
            evidence = `.codegen-contract/evidence-rung-${excluded.length + 1}.json`
            await writeFile(
              path.join(record.worktree, evidence),
              `${JSON.stringify(
                {
                  escalated_from: selection.configuration_id,
                  reason: outcome.reason,
                  attempts: record.attempts.map((item) => ({ attempt: item.attempt, configuration_id: item.configuration_id, result: item.result, outside_scope: item.summary?.outside_scope, verification: item.summary?.verification })),
                },
                null,
                2,
              )}\n`,
            )
            signatures = []
            const escalation = { role: "builder", contract_id: contract.contract_id, from: selection.configuration_id, to: next, reason: outcome.reason, evidence }
            record.escalations.push(escalation)
            state.escalations.push(escalation)
            await emit("ESCALATED", escalation)
            continue
          }
          outcome.reason = `${outcome.reason}; no other builder admitted`
        }
        record.status = outcome.status
        record.stop = summary.user_action ?? outcome.reason
        await emit("CONTRACT_FAILED", { contract_id: contract.contract_id, attempt, status: outcome.status, reason: outcome.reason })
        return
      }
    })
    await persist()

    const failed = wave.contracts.filter((record) => record.status !== "PASSED")
    if (failed.length > 0) {
      wave.status = "BLOCKED"
      await emit("WAVE_BLOCKED", { wave: wave.index, failed: failed.map((record) => [record.contract_id, record.status]) })
      const statuses = new Set(failed.map((record) => record.status))
      const status = ["USER_ACTION_REQUIRED", "REPLAN_REQUIRED", "ESCALATE", "BLOCKED", "BUILD_FAILED"].find((candidate) => statuses.has(candidate)) ?? "BUILD_FAILED"
      const userAction = failed.find((record) => record.status === "USER_ACTION_REQUIRED")?.stop ?? null
      return stop(
        status,
        failed.map((record) => `${record.contract_id}: ${record.stop ?? record.status}`).join("; "),
        { user_action: userAction },
      )
    }

    // 4c. Integrate the wave onto the integration branch, in contract order.
    for (const record of [...wave.contracts].sort((a, b) => a.contract_id.localeCompare(b.contract_id))) {
      const picked = await cherryPick(state.integration_worktree, record.result_commit)
      if (!picked.ok) {
        wave.status = "INTEGRATION_CONFLICT"
        await emit("INTEGRATION_CONFLICT", { contract_id: record.contract_id, detail: picked.conflict })
        return stop("INTEGRATION_CONFLICT", `${record.contract_id}: ${picked.conflict}`)
      }
      state.integration_head = picked.head
      await emit("INTEGRATED", { contract_id: record.contract_id, head: picked.head })
      gateSources.push({ contract_id: record.contract_id, source: path.join(record.worktree, ".codegen-contract") })
    }
    wave.status = "COMPLETED"
    await emit("WAVE_COMPLETED", { wave: wave.index, head: state.integration_head })
    await persist()
  }

  // 5. Final Gate on the integrated result.
  await emit("FINAL_GATE_STARTED", { head: state.integration_head })
  state.final_gate = await runFinalGate({
    directory: state.integration_worktree,
    baseRevision,
    plan,
    contractGates: gateSources,
    timeoutSeconds: gateTimeoutSeconds,
  })
  await emit(state.final_gate.result === "PASS" ? "FINAL_GATE_PASS" : "FINAL_GATE_FAIL", state.final_gate)

  // 6. Goal coverage ledger: what each Goal id was claimed by, and what the
  //    contracts and their checks actually did. Manual and operational items
  //    stay pending human verification; nothing declares them green.
  const results = new Map()
  for (const record of state.waves.flatMap((wave) => wave.contracts)) {
    const gate = state.final_gate.checks.find((check) => check.contract_id === record.contract_id)
    results.set(record.contract_id, {
      status: record.status,
      checks: Object.fromEntries((gate?.check_results ?? []).map((item) => [item.check_id, item.result])),
    })
  }
  state.goal_coverage = goalCoverage(plan, goal, results)
  await emit("GOAL_COVERAGE", state.goal_coverage.summary)

  if (!keepWorktrees && state.final_gate.result === "PASS") {
    for (const worktree of worktreesToRemove) await removeWorktree({ repository: directory, directory: worktree })
  }
  state.status = state.final_gate.result === "PASS" ? "COMPLETED" : "FINAL_GATE_FAILED"
  await emit("RUN_COMPLETED", { status: state.status, branch: state.integration_branch, head: state.integration_head })
  await persist()
  return state
}
