# Codegen (minimal)

Everything the system needs lives in `.codegen/` and is driven by one script,
`node .opencode/codegen.mjs`. The supervisor writes the files; the script runs
the agents. Models for scripted agents come from `.opencode/models.json`
(OpenCode Go, cheapest first, edited by hand; every model there must also
be in the `opencode-go` whitelist of `opencode.json`, or the script refuses
to start). The TUI runs on the user's model. Researcher and builder are
primary agents (OpenCode's `run --agent` refuses subagents), so they show
up in the TUI's Tab cycle: never select them there. A ladder entry is a
model or a group of models (an array): one rung either way, so a paid model
is always reached. A builder rung that is a group is a race: every model of
the group at once, each in its own copy of the sandbox, the first PASS lands
and the others are killed (`LOST`); a researcher tries the group's members
one by one. A model with no output at all after `timeouts_seconds.silence`
(90 s) is dropped at once (`NO_RESPONSE`) and not remembered as a failure.
Each contract or question starts at the cheapest rung and climbs at
most `max_models_per_item` rungs, two attempts per rung (one for a
group). If a gate
fails only in files outside `allowed_to_modify` (its own test file, another
domain, missing types elsewhere), the contract stops at that attempt with
GATE BROKEN: fix the gate or the contract, no model can. There is no
automatic demotion: `status` shows which model closed each item; if the
cheap one keeps failing in a project, move it down in `models.json`.

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

- `node .opencode/codegen.mjs research [--only id,id] [--reject id,id]`: runs every
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
- `node .opencode/codegen.mjs build [--parallel N, default 4] [--only id,id] [--resume]`:
  commits `.codegen/` and `wiki/` (seal: the supervisor has no git of its own), creates branch `codegen/<run>`, builds each
  contract in its own worktree, checks scope and protected paths, reruns the
  gate independently, retries once with the gate output as evidence, then
  moves to the next model, merges passing contracts into the branch.
  The script wakes the supervisor by sending `[codegen] …` messages into
  its session through the local OpenCode server (`opencode --port`, default
  4096, `OPENCODE_PORT` to change it; the TUI must be started as
  `OPENCODE_PORT=N opencode --port N` or nothing listens and the message is
  lost: the journal and the board then say "no entregado" with the port) when a question ends without DONE, a
  contract fails for good, or a run ends. No server: no message, the board
  still shows it.
  Both commands detach from the shell at once and run on their own (a TUI
  shell kills long commands); follow them with `status`. `--wait` keeps
  them in the foreground, for scripts.
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
`NO_CHANGES`, `TIMEOUT`, `NO_RESPONSE`, `LOST` (a racer killed because another
passed), `GATE_TRIVIAL`, `MERGE_CONFLICT`, `SKIPPED`
(a dependency failed), `NOT_SELECTED` (left out by `--only`). Logs and every attempt's events are under
`.codegen/runs/<run>/<id>/`.
- `node .opencode/codegen.mjs merge [--partial]`: fast-forwards the run's
  integration branch into the user's branch, sealing `.codegen/` and `wiki/`
  first. Refuses while a build runs,
  when contracts are pending (unless `--partial`), or when the tree is dirty.
