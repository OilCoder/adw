# Codegen (minimal)

Everything the system needs lives in `.codegen/` and is driven by one script,
`node .opencode/codegen.mjs`. The supervisor writes the files; the script runs
the agents. Models for scripted agents come from `.opencode/models.json`
(OpenCode Go, cheapest first, edited by hand). The TUI runs on the user's
model. Each contract or question starts at the cheapest model and climbs at
most `max_models_per_item` rungs, two attempts per rung. A model that
exhausted its attempts on an item another model then passed gets a confirmed
failure; after `demote_after_confirmed_failures` it moves to the end of the
ladder for this project (`.codegen/models-state.json`, shown by `status`).

## Files the supervisor writes

- `.codegen/structure.md`: the map, required before `build` (rules in
  `.opencode/instructions/structure.md`). Machine-readable part: under
  `## Folders`, one bullet per folder starting with a backticked pattern
  (`- \`src/core/**\`: pure domain logic`, `- \`*\`: root config files`);
  under `## Repeated names allowed`, bullets like `- \`store.ts\`` for file
  names that may legitimately appear in several folders (`index.*`,
  `__init__.py`, `mod.rs`, `README.md` are always allowed). A builder that
  writes outside the map, leaves a provisional file, or duplicates a file
  name gets the verdict `STRUCTURE`. `node .opencode/codegen.mjs structure`
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

- `node .opencode/codegen.mjs research [--only id,id] [--reject id,id] [--background]`: runs every
  question, writes `.codegen/research/<id>.md`, prints DONE / PARTIAL /
  NO_REPORT. `--reject` sets a report aside (`<id>.rejected-N.md`), counts
  its model as failed for that question and reruns it from the next rung;
  the supervisor is the judge of research quality, the gate is for code.
- `node .opencode/codegen.mjs build [--parallel N, default 4] [--only id,id] [--resume] [--background]`:
  commits `.codegen/` (seal), creates branch `codegen/<run>`, builds each
  contract in its own worktree, checks scope and protected paths, reruns the
  gate independently, retries once with the gate output as evidence, then
  moves to the next model, merges passing contracts into the branch.
  `--background` returns immediately; use `status` to follow.
  `--resume` continues the current run on its integration branch: contracts
  that already passed stay passed, the user's new commits (fixed gates,
  harness updates) are merged into that branch first, and `--only` limits
  which pending contracts run. Never start a fresh `build` to continue
  partial work: a fresh run starts from the user's branch, which does not
  contain the previous run's passed contracts until the user merges them.
- `node .opencode/codegen.mjs status`: report of the current run plus the
  last log lines.

## Results

Per contract: `PASS`, `INSTALL_FAILED`, `GATE_FAIL`, `OUT_OF_SCOPE`, `PROTECTED_TOUCHED`,
`NO_CHANGES`, `TIMEOUT`, `GATE_TRIVIAL`, `MERGE_CONFLICT`, `SKIPPED`
(a dependency failed), `NOT_SELECTED` (left out by `--only`). Logs and every attempt's events are under
`.codegen/runs/<run>/<id>/`.
- `node .opencode/codegen.mjs merge [--partial]`: fast-forwards the run's
  integration branch into the user's branch. Refuses while a build runs,
  when contracts are pending (unless `--partial`), or when the tree is dirty.
