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
request production issues must resolve to an admitted configuration for its
role, otherwise nothing is copied. It then copies only reusable `.opencode/` runtime
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
documents, the catalog sync (`catalog.mjs`), and the builder smoke stay in this
source repository for maintenance and are not copied into target projects. The
project's metalog (`.opencode/codegen/metalog.jsonl`) is machine-local too. `npm run clean` lists
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
in a child process with the cheapest configuration admitted for that role. If Git has
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
(the cheapest configuration admitted as `builder`, checked for fit the first time this project uses it):

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

The Planner starts on the user's OpenAI subscription (`openai/gpt-5.6-sol`) and falls to the cheapest Go planner (`opencode-go/gpt-5.6-luna`) after it. The plan schema is
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

The Goal Manager runs on the same tiers as the Planner (OpenAI, then Go) and
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

The Researcher runs the cheapest configuration admitted for it on the
Go-preferred `research-synthesis` route. The Runner also sets `OPENCODE_ENABLE_EXA=1` so
hosted search remains available when needed. The
report must cite only sources actually retrieved and give every finding a
verbatim quote; the validator binds it to the Goal question (id, text,
allowed source types) and rejects future retrieval dates and uncited findings.
The runner then fetches every source and searches
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

Advisors run once each on distinct model families admitted as `advisor`, cheapest first.
Unanimity on a listed option becomes a proposed decision deterministically;
divergence (or an `OTHER` position) goes to a Reconciler admitted as
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

`deliberate.mjs` reads the Goal, runs the Researcher on every required
`pending` question, runs
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
errors as evidence while the errors change; a plan that reproduces the errors
of an earlier attempt stops the run as `PLAN_FAILED` (no progress). A valid plan is
rendered as `PLAN.md` next to it. The Goal's triage is judged again with the
plan's evidence, only upward: a direct route that needs more than one contract
becomes planned, and each contract's effective risk is the highest of what the
Planner declared and the floor its paths imply
(`.opencode/codegen/config/risk-floors.json`). On the planned route, or when
the plan contradicts the Goal's labels, the run then stops as
`PLAN_REVIEW_REQUIRED`: the user reviews `PLAN.md` (coverage, triage
contradictions) and the run continues with `--plan <path>`; approving the plan
accepts the effective route and risk. Then, for each execution wave:

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
   `NO_CHANGES` while each attempt changes the outcome; an attempt that
   reproduces an earlier one (same result, same failing checks or paths outside
   scope) is "no progress" for that configuration: the worktree goes back to
   the sealed contract, the next rung of the Builder's list gets the
   accumulated evidence (`ESCALATED`), and the contract fails as `BUILD_FAILED`
   only when the list is exhausted. There is no attempt cap: cost is controlled
   in OpenCode and at the provider;
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

## Admission, order, and the metalog

Admission is membership in a work-class route of
`.opencode/codegen/config/model-pools.json`, decided from public coding and
tool-use benchmarks (the evidence is recorded per configuration under
`admission.public_evidence` with its sources). The list is a filter, never an
order. The order inside a role is computed: provider tiers from
`runner_policies.<role>.providers` (the user's OpenAI subscription for the
Planner and the Goal Manager, then OpenCode Go, then Zen), and inside a tier
the price per million tokens, cheapest first (input plus output; cached input
breaks ties). Nobody writes `configuration_ids`; the registry rejects them.

Every project keeps a metalog, `.opencode/codegen/metalog.jsonl` (ignored):
one line per model call, fit check, and no-progress stop, with the role, the
configuration, its rank, the whole ladder, the result, the reason, tokens, and
cost. The selector reads it:

- The first time a project uses a configuration, a fit check runs one call of
  seconds in a temporary directory that carries the project's providers: the
  model must write `probe.json` with the exact content asked, through its
  tools. A failed fit excludes the configuration in that project; an unknown
  verdict (rate limit, provider down, missing login) is retried next time.
  `--fit-check off` exists for this repository's tests only.
- Only failures attributable to the model count (no progress, invalid
  artifact, scope violation, format). Quota, authentication, provider outages,
  and blocked contracts are neutral. `selection.demote_after_consecutive_failures`
  (2) failures in a row in one role sink the configuration to the bottom of
  that role's list until it succeeds again.
- `--configuration <id>` pins a configuration for maintenance; installed
  projects refuse it.

```bash
npm run release:check     # every production request resolves to an admitted configuration
npm run models:status     # the ordered list per role, with this project's metalog applied
npm run catalog -- diff   # registry vs the live OpenCode catalog (models.dev): dropped, unknown Go models, price and context changes
npm run catalog -- apply  # copy prices and context of known configurations; membership never changes here
```

The release check (`.opencode/codegen/lib/release.mjs`) resolves the requests
production issues: Goal Manager and Planner on `complex-engineering-plan`,
Builder and Gate Designer on `localized-low-risk-code-change` and
`repository-code-change` (the Gate Designer excluding the family of the Builder
first in line), Researcher on `research-synthesis`, two advisor families and a
third reconciler family on `independent-analysis`. It runs as a test, inside
the installer before any file is copied, and by hand before a commit. A new
model enters a route by hand, with its public evidence; the catalog sync only
reports it.

Enable Go's console option `Use balance`: after a Go usage limit, the same Go
request continues against Zen credits. Set a Zen monthly spending limit. If the
balance is exhausted, the system stops with `ZEN_BALANCE_EXHAUSTED`; after a
recharge, resume from the preserved run instead of retrying another provider.

History: the certification by fixture (`certify.mjs`, `qualified` per role) and
the basic-smoke pool of 2026-09-02/03 were removed on 2026-09-08 (audit group
C); `docs/archive/GO_CATALOG_ANALYSIS.md` keeps the earlier catalog analysis.
