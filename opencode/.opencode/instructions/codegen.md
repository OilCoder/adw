# OpenCode code-generation system

This directory is a self-contained code-generation system built for OpenCode.
Treat roles, agents, models, and model calls as separate concepts.

## Supervisor

- The interactive session runs the `supervisor` agent on the user's model. It
  never edits product files and never runs shell commands. Requests that change
  code go through the `codegen_workflow` tool: `draft` a Goal, `deliberate`
  it when it has pending research or blocking questions with options (on the
  user's go), `revise` it with the user's answers, `approve` it only after
  the user explicitly approves that exact Goal, then `orchestrate`.
- Without a Git HEAD, without an admitted configuration for a role, or after
  any controlled step fails, the supervisor reports the blocker and stops with
  zero product edits.

## Model selection

- Call `model_select` with the requesting role to see the ordered list for a
  work class. Admission is membership in the work-class route of the registry
  (decided from public benchmarks); the order is computed, cheapest first
  inside each provider tier (the user's OpenAI subscription for the Planner
  and the Goal Manager, then OpenCode Go, then Zen), with this project's
  metalog applied. Nobody writes the order by hand.
- Select by role, work class, risk, context, and capabilities.
- Never invent a model ID or select a model merely because it appears in the
  provider catalog.
- The first time this project uses a configuration, the runner checks its fit
  with one call of seconds (it must write a probe file through its tools). A
  failed fit excludes the configuration here; the metalog remembers it.
- The metalog (`.opencode/codegen/metalog.jsonl`) records every model call
  with its rank, ladder, result, and reason. Two failures in a row attributable
  to the model in one role sink the configuration to the bottom of that role's
  list until it succeeds again; quota, authentication, provider, and blocked
  contracts never count.
- Dispatch sealed Builder contracts through
  `.opencode/codegen/scripts/run-builder.mjs`. Selection prefers Go and admits
  a Zen-only configuration directly when no Go configuration meets the risk,
  context, and capability requirements.
- Keep `Use balance` enabled in the OpenCode console. After a Go usage limit,
  OpenCode continues the same request against the Zen balance without changing
  the selected provider or model.
- Technical failures never switch models: authentication, configuration,
  rate-limit, availability, and partial-edit failures stop for classification.
  A configuration that makes no progress (it reproduces an earlier attempt) is
  escalated by the orchestrator: the worktree returns to the sealed contract
  and the next rung gets the accumulated evidence. OpenRouter is not part of
  automatic routes.
- `ZEN_BALANCE_EXHAUSTED` is terminal. Preserve the run and ask the user to
  recharge Zen before resuming; do not retry another model.

The authoritative runtime pool is
`.opencode/codegen/config/model-pools.json`. `MODEL_SELECTION_SPEC.md` documents
the evidence and admission methodology.

## Goal, Router, and Researcher

- A run starts from `.codegen-goal/goal.json`, produced by
  `.opencode/codegen/scripts/run-goal.mjs` and validated deterministically.
  `GOAL.md` is rendered from it; never hand-edit the Markdown.
- The Router is `goal.mjs route`, a deterministic function of the Goal. Run it
  before the Planner. Small, sealed, low-risk work with an existing Gate takes
  the direct route; never invoke research, opinions, or the Planner for it.
- Research happens only for a `research_questions` entry that is `pending`,
  through `.opencode/codegen/scripts/run-researcher.mjs`, one call per
  required pending question. The Researcher cites only sources it actually retrieved and
  gives every finding a verbatim quote; the runner fetches every source and
  searches the quote. A source that does not exist or is about something else
  rejects the report; an unverifiable source or a missing quote marks the
  finding unverified with confidence forced to low, and a report with no
  verified finding answers nothing (the question stays pending or is waived,
  never completed). The Researcher never edits the Goal; the Goal Manager
  records conclusions under `decisions`.
- Neither the Goal nor a contract carries budgets. The system sets no
  ceilings on calls or attempts; cost is controlled outside it (OpenCode and
  the provider). Every loop stops by lack of progress: a Builder attempt that
  reproduces an earlier one (same result, same failing checks or paths), or a
  Planner attempt that reproduces earlier validation errors, stops the run
  with evidence.
- `deliberate.mjs` sequences the deliberative route (CODE_GENERATION_FLOW
  §8.3): Researcher per pending question, advisors and reconciler per blocking
  question with options, then `run-goal.mjs --revise` so the Goal Manager folds
  reports and proposed decisions into the Goal. The revision is verified
  against the evidence; the Goal stays unsealed until the user approves it.
- A Goal is `SEALED` only after explicit user approval, through
  `run-goal.mjs --approve --digest <goal_digest>`, which seals
  deterministically without a model call. The digest is what the user read
  (every draft, revise, and deliberate summary reports it); a Goal whose file
  changed since is refused. The seal records `approval` (user, time, digest,
  path); the validator requires it on a `SEALED` Goal and rejects it elsewhere.
- The Router only routes a `SEALED` Goal (direct or planned). An open Goal is
  reported as `GOAL_NOT_SEALED` with what keeps it open, and the orchestrator
  stops as `APPROVAL_REQUIRED` naming it; deliberation is never a route of
  the orchestrator.

## Orchestration

- The supervisor uses the user's chosen provider (for example, OpenAI) to
  handle the conversation and high-level decisions. Child runners receive the
  cheapest configuration admitted for their role from the registry, corrected
  by the project's metalog.
- `.opencode/codegen/scripts/orchestrate.mjs` is the only component that
  chains Router, Planner, Gate readiness, Builders, integration, the final
  Gate, and the Goal coverage ledger. It is deterministic and spawns the
  runners; it never calls a model directly. It requires a Git HEAD and a
  `SEALED` Goal.
- The plan is validated against the Goal: every contract requirement declares
  the Goal ids it `covers`, and a plan that leaves a `must` requirement or an
  automated acceptance criterion uncovered is rejected and re-requested with
  the errors as evidence. `PLAN.md` is rendered next to the plan. On the
  planned route the run stops as `PLAN_REVIEW_REQUIRED` until the user
  approves that plan and `orchestrate` is called again with it; a direct
  route that fits the Goal's labels builds straight through.
- The Goal's triage is judged again with the plan's evidence, only upward: a
  direct route that needs more than one contract becomes planned; a contract's
  effective risk is the highest of the risk the Planner declared and the floor
  its `allowed_to_modify` paths imply (`config/risk-floors.json`); a Gate the
  Goal called existing but the Gate Designer had to write is recorded. Any
  contradiction pauses for plan review (direct route included), is listed in
  PLAN.md and `state.triage`, and approving the plan accepts the effective
  route and risk, which govern Builder and Gate Designer admission. Nothing
  lowers a label the user approved.
- Every contract builds in its own Git worktree under `.codegen-run/<run>/`
  from the current integration head. Results are cherry-picked onto the branch
  `codegen/<run>`. The user's checkout is never modified.
- Each contract check is materialized as `.codegen-contract/checks/<id>.sh`
  and the generated `gate.sh` runs them all. A contract is `GATE_READY` only
  when every check behaves as the requirements it covers demand on the
  untouched baseline: fails when it covers a `change` requirement, passes when
  it covers only `preserve` ones. The Gate Designer may only write under
  `.codegen-contract/checks/`; the contract and `gate.sh` are sealed.
- Integration failures are repaired, not reported. A cherry-pick conflict
  keeps its unmerged paths, the rest of the wave integrates, and the contract
  is rebuilt on the integrated head with the conflict as evidence. A failed
  final Gate is attributed deterministically (the failing checks are replayed
  along the integration branch; no model) and repaired by a contract composed
  from the culprit and the failing contract (union of their approved paths,
  their accepted risk, failing checks as `change`, the rest `preserve`),
  admitted by the derived-work Router, gated on the integration head, built,
  integrated, and judged by a new final Gate round. The Planner intervenes
  when the facts are inconclusive or the composed repair cannot run: it
  inspects the integrated tree and writes a repair plan based on the
  integration head; on the planned route (or on any contradiction) the run
  pauses as `PLAN_REVIEW_REQUIRED` with a `resume` run id and continues with
  `orchestrate` `run` set to it. Every repair loop stops by lack of progress:
  a final Gate round that reproduces an earlier one, or a finding already
  repaired once. Worktrees, branch, and evidence are always kept. The Goal is
  never edited during a run; what the user approves is the repair plan.
- After the final Gate, `state.json` carries `goal_coverage`: per Goal
  requirement and criterion, which contracts claimed it and how their checks
  fared. Manual and operational items stay pending human verification.
- Deliberation (`run-opinions.mjs`) needs an open question with a closed
  option set and distinct model families per advisor. Its output is a
  `PROPOSED` decision, never a sealed one; it becomes binding only when the
  user approves the Goal that records it.

## Visibility

- When the supervisor runs in the OpenCode TUI, every agent session is
  attached to that same server and appears in the session list, named
  `<agent> · <detail>`. Without a live server the events are captured inline.
  Display changes where events are shown, never how they are classified.

## Code-generation invariant

The Builder may run checks for self-correction, but it never has final authority
to accept its own changes. Controlled verification and the Gate decide PASS or
FAIL after the Builder returns.

Do not store API keys, access tokens, or provider credentials in this directory.
