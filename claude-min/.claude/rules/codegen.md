# Codegen (minimal)

Everything the system needs lives in `.codegen/` and is driven by one script,
`node .claude/codegen.mjs`. The supervisor writes the files; the script runs
the agents. Models for scripted agents come from `.claude/models.json`
(Claude models, cheapest first, edited by hand). Every agent is a `claude -p`
call on the user's subscription with the role and permissions of
`.claude/agents/<role>.md`; the supervisor is the session the user opened
(whatever `/model` says). The agent files are visible to this session as
subagents: never delegate to them, the script runs them. A ladder entry is a
model or a group of models (an array): one rung either way. A builder rung
that is a group is a race: every model of the group at once, each in its own
copy of the sandbox, the first PASS lands and the others are killed (`LOST`);
a researcher tries the group's members one by one. A model with no output at
all after `timeouts_seconds.silence` (90 s), or one that only answers
rate-limit retries, is dropped at once (`NO_RESPONSE` / `RATE_LIMITED`) and
not remembered as a failure. Each contract or question starts at the
cheapest rung and climbs at
most `max_models_per_item` rungs, two attempts per rung. If a gate
fails only in files outside `allowed_to_modify` (its own test file, another
domain, missing types elsewhere), the contract stops at that attempt with
GATE BROKEN: fix the gate or the contract, no model can. There is no
automatic demotion: `status` shows which model closed each item; if the
cheap one keeps failing in a project, move it down in `models.json`.

## Files the supervisor writes

- `.codegen/structure.md`: the map, required before `build` (rules in
  `.claude/rules/structure.md`). Machine-readable part: under
  `## Folders`, one bullet per folder starting with a backticked pattern
  (`- \`src/core/**\`: pure domain logic`, `- \`*\`: root config files`);
  under `## Repeated names allowed`, bullets like `- \`store.ts\`` for file
  names that may legitimately appear in several folders (`index.*`,
  `__init__.py`, `mod.rs`, `README.md` are always allowed). A builder that
  writes outside the map, leaves a provisional file, or duplicates a file
  name gets the verdict `STRUCTURE`. `node .claude/codegen.mjs structure`
  audits the current tree against the map.
- `.codegen/research/questions.json`: `[{ "id", "question", "context" }]`.
  One bounded question each; all run in parallel.
- `.codegen/plan.json`: `{ "contracts": [{ "id", "title", "depends_on": [] }] }`.
  Contracts without dependencies build in parallel.
- `.codegen/contracts/<id>/contract.json`:
  `objective`, `read` (files the builder should look at), `allowed_to_modify`
  (exact paths or `dir/**`), `protected` (tests and anything the builder must
  not touch), `requirements` (`[{ id, statement }]`), `gate` (the command,
  always `bash .codegen/contracts/<id>/gate.sh`).
- `.codegen/contracts/<id>/gate.sh`: exits 0 only when the contract is met.
  It must fail on the untouched repository; the script refuses a gate that
  already passes (`GATE_TRIVIAL`).

## Commands

- `node .claude/codegen.mjs research [--only id,id] [--reject id,id]`: runs every
  question, writes `.codegen/research/<id>.md`, records DONE (the model said
  so in time), PARTIAL (a report exists but was cut or left unfinished),
  TIMEOUT / NO_REPORT (nothing usable; that model is skipped for the
  question from then on), NO_RESPONSE (the model never started; not held
  against it) or NO_MODELS. A report the model wrote in one
  `write` and never edited is flagged "written in one go" in `status`, the
  journal and the end-of-run notice: judge those harder. `--reject` sets a report aside
  (`<id>.rejected-N.md`) and reruns the question from the next rung; the
  supervisor is the judge of research quality, the gate is for code. It
  refuses to reject a PARTIAL or to reject the same question a third time:
  split it into new ids instead. It refuses to start while a research run
  is alive; so does `build`. `build` also refuses a contract whose `read`
  has a glob, the idea, a research report or more than 5 files.
- `node .claude/codegen.mjs build [--parallel N, default 4] [--only id,id] [--resume]`:
  commits `.codegen/` and `wiki/` (seal: the supervisor has no git of its own), creates branch `codegen/<run>`, builds each
  contract in its own worktree, checks scope and protected paths, reruns the
  gate independently, retries once with the gate output as evidence (not
  after NO_CHANGES or TIMEOUT: a model that wrote nothing does not write on
  a second try), then moves to the next model, merges passing contracts
  into the branch.
  The script writes `[codegen] …` lines in its output (and in the journal,
  so the board shows them) when a question ends without DONE, a contract
  fails for good, or a run ends. Both commands run in the foreground: the
  supervisor starts them with the Bash tool in the background and the tool
  wakes it with the whole output when they exit; meanwhile `status` shows
  the state line and the failures so far.
  `--resume` continues the current run on its integration branch: contracts
  that already passed stay passed, the user's new commits (fixed gates,
  harness updates) are merged into that branch first, and `--only` limits
  which pending contracts run. While the run is still alive, `--resume`
  queues the fixed contracts into it instead (and new ids of `plan.json`);
  a failed contract whose files did not change is refused, and the request
  must arrive while another contract is still building. Never start a fresh `build` to continue
  partial work: a fresh run starts from the user's branch, which does not
  contain the previous run's passed contracts until the user merges them.
- `node .claude/codegen.mjs status`: report of the current run plus the
  last log lines.

## Results

Per contract: `PASS`, `INSTALL_FAILED`, `GATE_FAIL`, `OUT_OF_SCOPE`, `PROTECTED_TOUCHED`,
`NO_CHANGES`, `TIMEOUT`, `RATE_LIMITED` (the model only answered rate-limit
retries; the ladder moves on at once), `NO_RESPONSE` (nothing at all in the
silence window; same), `LOST` (a racer killed because another passed),
`GATE_TRIVIAL`, `MERGE_CONFLICT`, `SKIPPED`
(a dependency failed), `NOT_SELECTED` (left out by `--only`). Logs and every attempt's events are under
`.codegen/runs/<run>/<id>/`.
- `node .claude/codegen.mjs merge [--partial]`: fast-forwards the run's
  integration branch into the user's branch, sealing `.codegen/` and `wiki/`
  first. Refuses while a build runs,
  when contracts are pending (unless `--partial`), or when the tree is dirty.
