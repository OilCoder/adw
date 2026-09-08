import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"

import { goalCoverage } from "./coverage.mjs"
import { runFinalGate } from "./final-gate.mjs"
import { checkGateReadiness, materializeGate } from "./gate.mjs"
import { routeGoal } from "./goal-routing.mjs"
import { validateGoal } from "./goal.mjs"
import { validatePlan } from "./plan-validation.mjs"
import {
  cherryPick,
  commitPaths,
  createWorktree,
  ensureExcluded,
  linkOpenCodeLayer,
  removeWorktree,
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

export function classifyBuilderOutcome(result, { attempt, maxAttempts }) {
  if (result === "PASS") return { disposition: "ACCEPT" }
  const retriable = result === "GATE_FAIL" || result === "SCOPE_FAIL" || result === "NO_CHANGES"
  if (retriable) {
    if (attempt < maxAttempts) return { disposition: "RETRY", reason: result }
    return { disposition: "STOP", status: "BUILD_FAILED", reason: `${result} after ${attempt} attempts` }
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
  runners,
  runId,
  concurrency = 2,
  keepWorktrees = false,
  minimumStatus = "qualified",
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
  //    route is the Planner constrained to exactly one contract.
  const workClasses = new Set(Object.keys(registry.routes))
  const maxContracts = routing.route === "direct" ? 1 : null
  let plan
  if (planPath) {
    plan = JSON.parse(await readFile(path.resolve(directory, planPath), "utf8"))
    state.plan_path = planPath
    state.plan_reviewed = true
  } else {
    if ((routing.budgets?.planner_calls ?? goal.budgets.max_planner_calls) < 1 && routing.route !== "direct") {
      return stop("BUDGET_BLOCKED", "no planner budget")
    }
    // A plan the validator rejects is re-requested with the errors as
    // evidence while the Goal's planner budget allows; any other failure stops.
    const budget = routing.budgets?.planner_calls ?? goal.budgets.max_planner_calls
    let evidence = null
    let output = null
    while (true) {
      state.planner_calls += 1
      output = `.codegen-plan/${runId}${state.planner_calls > 1 ? `-${state.planner_calls}` : ""}.json`
      await emit("PLAN_REQUESTED", { output, max_contracts: maxContracts, attempt: state.planner_calls, evidence })
      const summary = await runners.planner({
        directory,
        objective: goal.objective,
        goal: goalPath,
        output,
        minimumStatus,
        maxContracts,
        evidence,
      })
      await emit("PLAN_GENERATED", { result: summary.result, output, attempt: state.planner_calls, markdown: summary.markdown ?? null })
      if (summary.result === "PASS") {
        state.plan_markdown = summary.markdown ?? null
        break
      }
      const retriable = summary.result === "PLAN_INVALID" && state.planner_calls < Math.max(1, budget)
      if (!retriable) return stop("PLAN_FAILED", summary.result, { validation: summary.validation ?? null, attempts: state.planner_calls })
      evidence = `.codegen-plan/${runId}-${state.planner_calls}.evidence.json`
      await mkdir(path.dirname(path.resolve(directory, evidence)), { recursive: true })
      await writeFile(
        path.resolve(directory, evidence),
        `${JSON.stringify({ attempt: state.planner_calls, rejected_plan: output, errors: summary.validation?.errors ?? [] }, null, 2)}\n`,
      )
      await emit("PLAN_RETRY", { attempt: state.planner_calls, evidence, errors: summary.validation?.errors ?? [] })
    }
    plan = JSON.parse(await readFile(path.resolve(directory, output), "utf8"))
    state.plan_path = output
  }
  // The plan is validated against the Goal: every must requirement and every
  // automated acceptance criterion has to be claimed by some contract.
  const planValidation = validatePlan(plan, { workClasses, maxContracts, maxRisk: goal.routing.risk, goal })
  await emit("PLAN_VALIDATED", { valid: planValidation.valid, errors: planValidation.errors, execution_waves: planValidation.execution_waves })
  if (!planValidation.valid) return stop("PLAN_INVALID", planValidation.errors.join("; "))
  if (plan.base_revision !== baseRevision) {
    return stop("PLAN_STALE", `plan base_revision ${plan.base_revision} is not HEAD ${baseRevision}`)
  }
  state.plan_id = plan.plan_id
  const phasesById = new Map(plan.phases.map((phase) => [phase.phase_id, phase]))
  await emit("DAG_READY", { waves: planValidation.execution_waves })

  // On the planned route the user reviews PLAN.md before anyone builds: the
  // run stops here, before any worktree exists, and resumes when orchestrate
  // is called again with the reviewed plan. The direct route (one contract)
  // builds straight through.
  if (routing.route === "planned" && !state.plan_reviewed) {
    return stop("PLAN_REVIEW_REQUIRED", `review ${state.plan_markdown ?? state.plan_path} and orchestrate again with --plan ${state.plan_path}`, {
      plan_path: state.plan_path,
      plan_markdown: state.plan_markdown,
    })
  }

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

      const record = {
        contract_id: contract.contract_id,
        phase_id: phaseId,
        worktree,
        status: "PREPARED",
        gate_readiness: null,
        attempts: [],
        result_commit: null,
        stop: null,
      }
      wave.contracts.push(record)

      let readiness = await checkGateReadiness({ directory: worktree, contract: sealed, timeoutSeconds: gateTimeoutSeconds })
      if (!readiness.ready && readiness.fixable) {
        await emit("GATE_DESIGN_REQUESTED", { contract_id: contract.contract_id, reasons: readiness.reasons })
        state.gate_designer_calls += 1
        const design = await runners.gateDesigner({
          directory: worktree,
          contract: ".codegen-contract/contract.json",
          workClass: contract.work_class,
          risk: contract.risk,
          minimumStatus,
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
      prepared.push({ contract, record, sealed })
    }
    await persist()

    // 4b. Build contracts of the wave concurrently.
    await pool(prepared, concurrency, async ({ contract, record }) => {
      const maxAttempts = contract.budgets.max_builder_attempts
      let evidence = null
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        await emit("BUILDER_DISPATCHED", { contract_id: contract.contract_id, attempt, evidence })
        const summary = await runners.builder({
          directory: record.worktree,
          contract: ".codegen-contract/contract.json",
          workClass: contract.work_class,
          risk: contract.risk,
          minimumStatus,
          evidence,
        })
        // A runner that could not select a configuration reports status
        // NO_MATCH instead of a result; that is a blocking stop with the
        // admission reasons, not an unknown result.
        const result = summary.result ?? (summary.status === "NO_MATCH" ? "NO_BUILDER_ADMITTED" : summary.status)
        record.attempts.push({ attempt, result, evidence, summary })
        const outcome = classifyBuilderOutcome(result, { attempt, maxAttempts })
        if (result === "NO_BUILDER_ADMITTED") {
          outcome.reason = `no builder admitted for ${contract.work_class} at risk ${contract.risk}: ${(summary.rejected ?? []).slice(0, 4).map((r) => `${r.configuration_id} (${(r.reasons ?? []).join(", ")})`).join("; ")}`
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
        record.status = outcome.status
        record.stop = summary.user_action ?? outcome.reason
        await emit("CONTRACT_FAILED", { contract_id: contract.contract_id, attempt, status: outcome.status, reason: outcome.reason })
        return
      }
      record.status = "BUILD_FAILED"
      record.stop = `budget exhausted after ${maxAttempts} attempts`
      await emit("CONTRACT_FAILED", { contract_id: contract.contract_id, status: "BUILD_FAILED", reason: record.stop })
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
