# OpenCode code-generation system

This directory is a self-contained, directly executable code-generation system
for OpenCode and the source copied into target projects.

## Layout

- `.opencode/`: agents (supervisor, goal-manager, researcher, advisor,
  reconciler, planner, gate-designer, builder), tools, the server-url plugin,
  instructions, and namespaced runtime files.
- `opencode.json`: project-level OpenCode configuration.
- `tests/`: tests for the reusable system.
- `CODE_GENERATION_FLOW.md`: the design directive (flow, roles, routes, limits).
- `ARCHITECTURE.md`: what of that directive is implemented, where, and what is
  not; kept in step with the code.
- `MODEL_SELECTION_SPEC.md`: model-admission methodology.
- `docs/`: the 2026-09-03 diagnosis and, under `docs/archive/`, superseded
  design notes kept for history.

Runtime implementation stays under `.opencode/codegen/` to avoid colliding with
a target project's `src/`, `lib/`, `config/`, tests, or package manifest.

## Installation contract

Open this directory directly to develop or test the method. Install it into an
existing target project from this source repository with:

```bash
node opencode/install.mjs /path/to/project --dry-run
node opencode/install.mjs /path/to/project
```

From inside this directory, the equivalent command is:

```bash
npm run install:target -- /path/to/project
```

The installer first runs the release check (`npm run release:check`): every
role must have a `qualified` configuration for the requests production issues,
otherwise nothing is copied. It then copies only reusable `.opencode/` runtime
files, merges missing OpenCode settings (including `default_agent: supervisor`)
and provider whitelist entries, adds the code-generation npm scripts without
replacing the target's `test` script or shipping the maintenance scripts, and
appends local runtime paths to `.gitignore`. Existing project scalar settings
win and are reported.

Install state is recorded in ignored `.opencode/.codegen-install.json`,
including the harness Git revision that was installed (`harness_revision`) and
the time. On a later update, files that still match the previous installation
can be replaced; a locally modified managed file or conflicting npm script stops
installation before any files are written. The installer copies
`.opencode/package.json` (merging an existing one) and runs `npm install`
inside `.opencode/` so the tools and the plugin can load `@opencode-ai/plugin`;
`--skip-install` skips that step and `--skip-validation` skips the final
`opencode debug config` check when OpenCode is not available on that machine.
Commit the `.opencode/` changes in the target right after installing, with the
harness revision in the message, so the installed copy never drifts uncommitted.

Provider credentials, `.opencode/node_modules/`, run artifacts, generated lock
files, the published server URL, and the installation manifest are machine-local
state and are never part of the payload or source commit. Tests, design
documents, `certify.mjs`, and the builder smoke stay in this source repository
for maintenance and are not copied into target projects. `npm run clean` lists
the working artifacts of a target (`.codegen-*` directories, run artifacts,
stale worktrees) and removes them with `--yes`; it never deletes `codegen/*`
branches.

The interactive session opens on the `supervisor` agent with the provider and
model selected by the user, for example an OpenAI-authenticated GPT model. The
supervisor cannot edit files or run shell commands: a request that changes code
goes through the `codegen_workflow` tool (`draft` a Goal, `deliberate` it when
it has pending research or blocking questions with options, `revise` it with
the user's answers, `approve` it after the user's explicit approval,
`orchestrate`), and every model-backed step runs
in a child process with the configuration certified for that role. If Git has
no HEAD or any controlled step fails, the supervisor reports the blocker and
stops with zero product edits. The role agents are addressable only through
`opencode run --agent <role>`, which is what the runners do.

Automatic model selection prefers an admitted OpenCode Go configuration that
meets the task's capability, risk, and context requirements. A Zen-only model
may be selected directly when no admitted Go configuration is sufficient. With
the console's `Use balance` option enabled, OpenCode continues the same Go
request against the Zen balance after a Go usage limit; this never triggers a
model change. When Zen credits run out, the runner returns
`ZEN_BALANCE_EXHAUSTED`, preserves the run, and requests a recharge.
Authentication, model configuration, rate-limit, availability, partial edits,
scope failures, and Gate failures stop without trying another model. OpenRouter
remains a recorded manual alternative.
A model/provider pair is one configuration: passing a smoke through Zen does
not qualify the same family through Go or OpenRouter.

Select a model interactively with `/models`, or per non-interactive execution:

```bash
opencode run --model opencode-go/minimax-m3 --agent builder "..."
```

Run a sealed Builder contract through the capability-first, Go-preferred policy
(production selection: only configurations certified as `builder`):

```bash
npm run builder -- \
  --contract .codegen-contract/contract.json \
  --work-class localized-low-risk-code-change
```

Generate and validate a phased plan from a project objective:

```bash
npm run planner -- \
  --objective "Implement the requested project behavior" \
  --output .codegen-plan/plan.json

npm run plan:validate -- .codegen-plan/plan.json
```

The Planner uses the configuration certified as `planner` (`opencode-go/gpt-5.6-luna`, alternate `opencode-go/glm-5.3`). The plan schema is
`.opencode/codegen/schema/plan.schema.json`. Independent phases form the
same execution wave; the validator rejects cycles, unknown work classes,
unsafe paths, and file overlap between contracts that could run concurrently.

Structure user intent into a Goal, then route it:

```bash
npm run goal:run -- \
  --intent "Prevent registering users with an existing email" \
  --reports .codegen-research/RQ-1.json

npm run goal:run -- --approve .codegen-goal/goal.json   # after the user approves
npm run goal -- validate .codegen-goal/goal.json
npm run goal -- render .codegen-goal/goal.json
npm run goal -- route .codegen-goal/goal.json
```

The Goal Manager runs with the configuration certified as `goal-manager` and
writes `.codegen-goal/goal.json`; `GOAL.md` is rendered deterministically after
validation. A Goal returned as `SEALED` is rejected unless the run passes
`--allow-sealed true`, because only the user seals a Goal. `--approve` seals the
existing Goal deterministically, without a model call, once the user has
approved that exact Goal; it refuses a Goal that still has required pending
research or blocking questions. The Router (`route`)
is a deterministic function of the Goal: an
open Goal with research, architecture uncertainty, or blocking questions routes
`deliberative`; a `SEALED` Goal routes `direct` (localized, low risk, existing
Gate) or `planned`. A `SEALED` Goal that carries deliberative signals must record
its conclusions under `decisions`, so it never routes back to deliberation.

Answer one bounded research question from the Goal:

```bash
npm run researcher -- --question RQ-1
npm run research -- validate .codegen-research/RQ-1.json .codegen-goal/goal.json RQ-1
npm run research -- render .codegen-research/RQ-1.json
```

The Researcher runs one configuration certified as `researcher` from the
Go-preferred `research-synthesis` route. The Runner also sets `OPENCODE_ENABLE_EXA=1` so
hosted search remains available when needed. The
report must cite only sources actually retrieved and give every finding a
verbatim quote; the validator binds it to the Goal question (id, text, budget,
allowed source types) and rejects future retrieval dates, uncited findings, and
over-budget source counts. The runner then fetches every source and searches
each quote: a source that does not exist or is about something else rejects
the report (`REPORT_INVALID`); an unverifiable source (403, 5xx, timeout,
binary) or a quote that is not found marks the finding unverified with its
confidence forced to `low`, and a report with no verified finding answers
nothing, so its question stays pending or is waived, never completed. The
verdicts are written under `verification` in the report and rendered in its
Markdown (`--source-verification offline` skips the network and is refused in
installed projects). Research reports never edit the Goal: the Goal Manager
records accepted conclusions under `decisions` on its next run.

Deliberate a blocking open question that carries a closed option set:

```bash
npm run opinions -- --question OQ-1 --advisors 2
```

Advisors run once each on distinct model families certified as `advisor`.
Unanimity on a listed option becomes a proposed decision deterministically;
divergence (or an `OTHER` position) goes to a Reconciler certified as
`reconciler` from a family that gave no opinion, whose decision must cite every
opinion and explain every rejected position. The output under `.codegen-opinions/<id>/` is
`PROPOSED`: the Goal Manager records it under `decisions` (with `opinion_ids`)
and the user seals the Goal.

Deliberate a whole open Goal in one pass (the deliberative route of
`CODE_GENERATION_FLOW.md` §8.3):

```bash
npm run deliberate                       # Researcher per pending question, opinions per blocking question, then revision
npm run goal:run -- --revise .codegen-goal/goal.json --intent "answers to the questions without options"
```

`deliberate.mjs` reads the Goal, runs the Researcher on every `pending`
question within `budgets.max_research_calls` (required first), runs
`run-opinions.mjs` on every blocking open question that carries options, and
then asks the Goal Manager (`run-goal.mjs --revise`) to fold the validated
reports and proposed decisions into the Goal, keeping the previous version as
`.codegen-goal/goal.before-<run>.json`. The revision is verified against the
evidence: answered questions must be `completed`, every proposed decision must
appear under `decisions` with its `opinion_ids`, the Goal must stay unsealed.
A blocking question without options stops as `USER_DECISION_REQUIRED`; the
user's answer enters through `--revise --intent`. The result `DECIDED` with
`ready_for_approval: true` means the user can now approve.

Run a sealed Goal end to end:

```bash
npm run orchestrate -- --concurrency 2
npm run orchestrate -- --plan .codegen-plan/plan.json --keep-worktrees true
```

The orchestrator is deterministic glue over the runners above. It requires a
Git HEAD and a `SEALED` Goal (an unapproved Goal stops as `APPROVAL_REQUIRED`,
an open one as `DELIBERATION_REQUIRED`), routes the Goal, asks the Planner (the
direct route is the Planner capped at one contract), and validates the plan:
the DAG, the paths, the risk ceiling, and its coverage of the Goal. Every
contract requirement declares in `covers` the Goal requirement and
acceptance-criterion ids it satisfies; a plan that leaves a `must` requirement
or an automated criterion uncovered is rejected and re-requested with the
errors as evidence, within `budgets.max_planner_calls`. A valid plan is
rendered as `PLAN.md` next to it. The Goal's triage is judged again with the
plan's evidence, only upward: a direct route that needs more than one contract
becomes planned, and each contract's effective risk is the highest of what the
Planner declared and the floor its paths imply
(`.opencode/codegen/config/risk-floors.json`). On the planned route, or when
the plan contradicts the Goal's labels, the run then stops as
`PLAN_REVIEW_REQUIRED`: the user reviews `PLAN.md` (coverage, triage
contradictions, budget adjustments) and the run continues with `--plan <path>`;
approving the plan accepts the effective route and risk. Contract budgets above
the system ceilings (`.opencode/codegen/config/budgets.json`) are clamped when
the contract is sealed. Then, for each execution wave:

1. creates one detached Git worktree per contract under `.codegen-run/<run>/`
   (excluded through `.git/info/exclude`, never the tracked `.gitignore`),
   links the untracked OpenCode layer into it, and seals the contract: one
   script per check under `.codegen-contract/checks/<id>.sh` and a generated
   `.codegen-contract/gate.sh` that runs them all and reports each by id;
2. checks Gate readiness check by check: scripts resolve, and on the untouched
   baseline each check behaves as the requirements it covers demand (fails
   when it covers a `change` requirement, passes when it covers only
   `preserve` ones). A fixable gap names the check and calls the Gate
   Designer, which may only write under `.codegen-contract/checks/`; a
   `preserve` check failing on the baseline is not fixable and stops the run;
3. runs Builders concurrently (`--concurrency`), retrying with an evidence file
   that carries every check's result on `GATE_FAIL`, `SCOPE_FAIL`, or
   `NO_CHANGES` within the contract's `max_builder_attempts`;
   `CONTRACT_BLOCKED` stops as `REPLAN_REQUIRED`, provider failures stop as
   `ESCALATE`, while an exhausted Zen balance stops as `USER_ACTION_REQUIRED`
   with recharge instructions;
4. commits only `allowed_to_modify` paths per contract and cherry-picks each
   result onto the integration branch `codegen/<run>`; the next wave starts from
   that head, which is what satisfies `depends_on`.

After the last wave the final Gate reruns every contract gate on the integrated
tree, checks the merged diff stays inside the union of allowed paths, and runs
the plan's optional `final_verification.commands`. The Goal coverage ledger
(`goal_coverage` in `state.json`) then says, per Goal requirement and
criterion, which contracts claimed it and how their checks fared; manual and
operational items stay pending human verification. The user's checkout is
never modified; merging `codegen/<run>` is the user's decision (`npm run
merge`, fast-forward only). State lives in `.codegen-run/<run>/state.json` and
`events.jsonl` (event names are listed in
`.opencode/codegen/lib/orchestrator.mjs`).

### Watching agents in the OpenCode session list

Every agent runs as its own `opencode run` process. Two displays exist:

- `tui`: the runner attaches the agent session to the supervisor's running
  OpenCode server (`opencode run --attach <url> --dir <worktree> --title
  "<agent> · <detail>"`). The session appears in the session list of the
  user's TUI, named after the agent, rendered by OpenCode itself, and can be
  opened while it runs. Start the TUI with `opencode --port 4096`: a plain
  `opencode` publishes a nominal URL that nothing listens on. The plugin
  `.opencode/plugins/codegen-server.js` writes the URL to
  `.opencode/.codegen-server.json`; the `codegen_workflow` tool checks that
  the pid is alive and the URL answers, passes it to the runners as
  `CODEGEN_ATTACH`, and reports which display it chose and why.
- `inline`: the agent's JSON events are captured silently.

The tool chooses `tui` whenever a live server is published and `inline`
otherwise; `CODEGEN_DISPLAY=inline` or `CODEGEN_DISPLAY=tui` forces one. The
runners and the orchestrator accept `--display` for manual runs (`tui` then
needs `CODEGEN_ATTACH`). The tmux, Windows Terminal, and VS Code views and the
guided transcript were removed on 2026-09-03: they reimplemented what the
OpenCode TUI already renders and caused most of that day's fixes. Do not resume
with `opencode -c` after a run: the most recent session may be an agent's.

An agent that emits no event within `CODEGEN_FIRST_OUTPUT_SECONDS` (120 by
default) is stopped and classified as `LOCAL_RUNNER_ERROR` instead of holding
the run until its full timeout. Raw events still go to the run artifacts under
`.opencode/codegen/runs/` (`CODEGEN_RUNS_DIR` relocates them; the test suite
points it at a temporary directory).

Operational note: `opencode run` waits for EOF on stdin when stdin is not a
TTY. The runners close stdin; if you script it by hand, add `< /dev/null`.

Not automated yet (see the table in `ARCHITECTURE.md`): replanning after
`REPLAN_REQUIRED` (the run stops with evidence), derived-work contracts
(`.opencode/codegen/lib/derived-work.mjs` classifies findings but nothing feeds
it yet), and Goal acceptance criteria, which are prose and are not executed.

## Certification and admission

Admission is a property of one combination: model, provider, role, and this
harness. It is recorded per role under `admission.roles` in
`.opencode/codegen/config/model-pools.json`; the catalog `status` of a
configuration is capped at `candidate`, so a configuration certified as
`builder` is not thereby admitted as `planner`. Every runner requests
configurations `qualified` for its own role, and production never lowers that
level: `--minimum-status candidate` and `--configuration <id>` (pinning) are
maintenance options that the runners refuse in an installed project (detected
through the install manifest). A target project's user never needs to know that
`candidate` exists.

Certification runs only in this repository, on the real runners and the real
OpenCode binary, against the fixtures under `tests/fixtures/`:

```bash
npm run certify -- run --role builder --configuration builder-go-minimax-m3
npm run certify -- run --role planner --configuration planner-go-glm-5.3
npm run certify -- run --role goal-manager --configuration planner-go-glm-5.3
npm run certify -- run --role gate-designer --configuration builder-go-mimo-v2.5-pro
npm run certify -- run --role researcher --configuration builder-go-gpt-5.6-luna
npm run certify -- run --role advisor --configuration builder-go-gpt-5.6-luna \
  --with builder-go-deepseek-v4-pro,builder-go-minimax-m3
npm run certify -- run --role reconciler --configuration builder-go-minimax-m3
npm run certify -- status
npm run release:check
```

Each run copies a fixture into a throwaway Git repository, executes the role's
runner with the pinned configuration, validates the artifact deterministically
(Gate pass and scope for the Builder, a valid plan on HEAD for the Planner, an
approvable Goal for the Goal Manager, a gate that fails on the baseline for the
Gate Designer, a complete cited report for the Researcher, a proposed decision
for advisors and reconciler), and writes the verdict with its evidence (run id,
duration, tokens, cost, OpenCode version) into the registry. A failure demotes
the role entry to `candidate` and keeps the failure. Run artifacts stay under
the ignored `.opencode/codegen/runs/certification/`.

The release check (`.opencode/codegen/lib/certification.mjs`) resolves the
requests production issues: Goal Manager and Planner on
`complex-engineering-plan`, Builder and Gate Designer on
`localized-low-risk-code-change` and `repository-code-change` (the Gate
Designer excluding the certified Builder's family), Researcher on
`research-synthesis`, two advisor families and a third reconciler family on
`independent-analysis`. It runs as a test (`npm test` is red while the route is
incomplete), inside the installer before any file is copied, and by hand before
a commit. The whole certified route ships with the installer.

Enable Go's console option `Use balance`: after a Go usage limit, the same Go
request continues against Zen credits. Set a Zen monthly spending limit. If the
balance is exhausted, the system stops with `ZEN_BALANCE_EXHAUSTED`; after a
recharge, resume from the preserved run instead of retrying another provider.

Basic-smoke pool (sealed Builder fixture, one attempt each):

- 2026-09-02, Go and Zen: `minimax-m2.7`, `qwen3.6-plus`, `kimi-k2.7-code`.
- 2026-09-03, Go and Zen: `minimax-m3` (new Builder primary), `gpt-5.6-luna`,
  `deepseek-v4-pro`. Go only, no Zen equivalent in the catalog:
  `mimo-v2.5-pro`, `qwen3.8-flash`, `glm-5.3-flash`. The Zen smokes remain
  admission evidence, not quota fallbacks. Separate Zen-only candidates provide
  capacity escalation when the Go candidates fail hard requirements.
- 2026-09-03, Zen-only capacity candidates: `claude-opus-5` PASS in 22 s
  ($0.1009145) and `gemini-3.1-pro` PASS in 20 s ($0.065864). The Zen copy of
  `gpt-5.6-sol` also passed, but was removed from the active registry because
  the authenticated `openai/gpt-5.6-sol` endpoint already supplies that model.
- 2026-09-03, mid/low-tier expansion: Go `deepseek-v4-flash` PASS in 19 s
  ($0.002201476 quota value); Zen `claude-sonnet-5` PASS in 37 s ($0.0407811),
  `claude-haiku-4-5` PASS in 19 s ($0.0178989), `gemini-3.8-flash` PASS in 45 s
  ($0.06101265), and `gemini-3.5-flash-lite` PASS in 14 s ($0.00895502).
  Every smoke changed only `calculator.py` and passed scope, integrity, and Gate
  checks. These remain conservative candidates, not broad qualification.
- `kimi-k3` and `qwen3.8-max` are registered as `watch` on Go without a smoke.

`docs/archive/GO_CATALOG_ANALYSIS.md` records the full Go catalog with quota prices and the
public evidence behind these choices. Basic smokes are compatibility evidence
for candidacy; only the certification above qualifies a role.
