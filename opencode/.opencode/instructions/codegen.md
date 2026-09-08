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
- Without a Git HEAD, without a certified route, or after any controlled step
  fails, the supervisor reports the blocker and stops with zero product edits.

## Model selection

- Call `model_select` with the requesting role before dispatching model-backed
  work. Admission is certified per role: a configuration admitted as `builder`
  is not admitted as `planner`.
- Select by role, work class, risk, context, and capabilities.
- Never invent a model ID or select a model merely because it appears in the
  provider catalog.
- Production work uses `minimumStatus: "qualified"`, which is the default. This
  project runs only certified configurations; there is no lower level to ask
  for here.
- Treat the returned alternate as another eligible configuration, not an automatic retry.
- A configured model is not necessarily available now. The Runner must perform
  provider and endpoint preflight before execution.
- Dispatch sealed Builder contracts through
  `.opencode/codegen/scripts/run-builder.mjs`. Selection is capability-first:
  prefer Go, but select a Zen-only candidate directly when no Go candidate
  meets the risk, context, and capability requirements.
- Keep `Use balance` enabled in the OpenCode console. After a Go usage limit,
  OpenCode continues the same request against the Zen balance without changing
  the selected provider or model.
- Never switch models because of quota or execution failure. Authentication,
  configuration, rate-limit, availability, partial-edit, and Gate failures stop
  for classification. OpenRouter is not part of automatic routes.
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
  through `.opencode/codegen/scripts/run-researcher.mjs`, within the Goal's
  research budget. The Researcher cites only sources it actually retrieved and
  never edits the Goal; the Goal Manager records conclusions under `decisions`.
- `deliberate.mjs` sequences the deliberative route (CODE_GENERATION_FLOW
  §8.3): Researcher per pending question, advisors and reconciler per blocking
  question with options, then `run-goal.mjs --revise` so the Goal Manager folds
  reports and proposed decisions into the Goal. The revision is verified
  against the evidence; the Goal stays unsealed until the user approves it.
- A Goal is `SEALED` only after explicit user approval, through
  `run-goal.mjs --approve`, which seals deterministically without a model call.

## Orchestration

- The supervisor uses the user's chosen provider (for example, OpenAI) to
  handle the conversation and high-level decisions. Child runners receive the
  configuration certified for their role from the registry.
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
  approves that plan and `orchestrate` is called again with it; the direct
  route builds straight through.
- Every contract builds in its own Git worktree under `.codegen-run/<run>/`
  from the current integration head. Results are cherry-picked onto the branch
  `codegen/<run>`. The user's checkout is never modified.
- Each contract check is materialized as `.codegen-contract/checks/<id>.sh`
  and the generated `gate.sh` runs them all. A contract is `GATE_READY` only
  when every check behaves as the requirements it covers demand on the
  untouched baseline: fails when it covers a `change` requirement, passes when
  it covers only `preserve` ones. The Gate Designer may only write under
  `.codegen-contract/checks/`; the contract and `gate.sh` are sealed.
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
