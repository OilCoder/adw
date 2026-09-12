# Codegen (minimal)

Everything the system needs lives in `.codegen/` and is driven by one script,
`node .claude/codegen.mjs`. The supervisor writes the files; the script runs
the agents. Models for scripted agents come from `.claude/models.json`
(Claude models, cheapest first, edited by hand). The supervisor is the Claude Code session itself. Each contract or question starts at the cheapest model and climbs at
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
  TIMEOUT / NO_REPORT / RATE_LIMITED (nothing usable; that model is skipped
  for the question from then on) or NO_MODELS. `--reject` sets a report aside
  (`<id>.rejected-N.md`) and reruns the question from the next rung; the
  supervisor is the judge of research quality, the gate is for code. It
  refuses to reject a PARTIAL or to reject the same question a third time:
  split it into new ids instead. It refuses to start while a research run
  is alive; so does `build`. `build` also refuses a contract whose `read`
  has a glob, the idea, a research report or more than 5 files.
- `node .claude/codegen.mjs build [--parallel N, default 4] [--only id,id] [--resume]`:
  commits `.codegen/` (seal), creates branch `codegen/<run>`, builds each
  contract in its own worktree, checks scope and protected paths, reruns the
  gate independently, retries once with the gate output as evidence, then
  moves to the next model, merges passing contracts into the branch.
  The script prints `[codegen] …` lines when a question ends without DONE,
  a contract fails for good, or a run ends; they also go to the journal.
  The supervisor sees them when its background Bash call returns.
  Both commands run in the foreground; the supervisor launches them with
  its Bash tool in the background and is woken when they exit.
  `--resume` continues the current run on its integration branch: contracts
  that already passed stay passed, the user's new commits (fixed gates,
  harness updates) are merged into that branch first, and `--only` limits
  which pending contracts run. Never start a fresh `build` to continue
  partial work: a fresh run starts from the user's branch, which does not
  contain the previous run's passed contracts until the user merges them.
- `node .claude/codegen.mjs status`: report of the current run plus the
  last log lines.

## Results

Per contract: `PASS`, `INSTALL_FAILED`, `GATE_FAIL`, `OUT_OF_SCOPE`, `PROTECTED_TOUCHED`,
`NO_CHANGES`, `TIMEOUT`, `RATE_LIMITED` (the model answered nothing but retries; next rung at once), `GATE_TRIVIAL`, `MERGE_CONFLICT`, `SKIPPED`
(a dependency failed), `NOT_SELECTED` (left out by `--only`). Logs and every attempt's events are under
`.codegen/runs/<run>/<id>/`.
- `node .claude/codegen.mjs merge [--partial]`: fast-forwards the run's
  integration branch into the user's branch. Refuses while a build runs,
  when contracts are pending (unless `--partial`), or when the tree is dirty.
