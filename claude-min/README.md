# claude-min

The same minimal code-generation harness as `opencode-min`, on Claude Code
alone: one script, three agents, one hand-edited model list, about 2,300
formatted lines in five modules. Everything runs on the user's Claude
subscription: no API key, no OpenCode. Fixes to the script apply to both
harnesses alike unless they are about the launcher (what differs is listed at
the end).

```text
idea → research questions (parallel) → plan + contracts + gates → builders (parallel, sandboxed) → independent gate → integration branch
```

## Files

`.claude/` is Claude Code's own folder, and the harness uses its native places:
`CLAUDE.md` at the root hands the session the supervisor role, `.claude/settings.json`
gives it exactly the supervisor's permissions, `.claude/rules/*.md` load into every
session (the supervisor's rules), `.claude/agents/*.md` define the builder and the
researcher with native front matter. `codegen.mjs`, `models.json` and `lib/` sit next
to them; Claude Code ignores files it does not know.

| File | Does |
|---|---|
| `.claude/codegen.mjs` | the commands (`research`, `build`, `status`, `merge`, `structure`, `board`) and every file under `.codegen/` |
| `.claude/lib/agent.mjs` | runs a process with a timeout, one agent through `claude -p`, a task pool, and the model ladder |
| `.claude/lib/sandbox.mjs` | one contract's sandbox: export, dependencies, gate, scope and structure checks, landing the diff |
| `.claude/lib/board.mjs` | the board's facts (`boardData`, `boardJson`), costs summed from the attempts |
| `.claude/lib/board-html.mjs`, `lib/board.css` | the board's HTML, one function per section, styles inlined. **A redesign touches only these two.** |
| `.claude/agents/*.md` | builder and researcher: `name`, `description`, `maxTurns` (native) plus `allow` and `deny`, the permission rules the script hands to `claude -p` as a settings file |
| `.claude/rules/*.md` | the supervisor's rules (supervisor, codegen, structure, idea), loaded by Claude Code into the session |
| `templates/` | `CLAUDE.md` and `settings.json` for the supervisor, `models.default.json` for Garden |
| `.claude/models.json` | the ladder |

The board reloads `lib/board-html.mjs` and `lib/board.css` whenever they change on disk,
so a build that runs for hours picks up a redesign without a restart.

## Roles and where they run

| Role | Runs | Model |
|---|---|---|
| Supervisor | the Claude Code session you open in the project | whatever you chose with `/model` (Fable) |
| Researcher | `claude -p`, one per question, all at once, each in an empty work dir | `models.json` → `researcher` (Haiku, then Sonnet) |
| Builder | `claude -p`, one per contract, N at a time, in a sandbox | `models.json` → `builder` (Haiku, then Sonnet) |
| Gate | the script, deterministic | none |

Claude Code has one really cheap model, Haiku: it does the building and the
research, Sonnet is the rescue rung, and Opus is out of the ladder on purpose
(the supervisor is already the strong model; a contract that Haiku and Sonnet
both fail is a wrong contract or gate). The cost the board shows is what the
API would have charged, for comparing models; the subscription charges quota.

The supervisor decomposes the idea, writes questions, plan, contracts and
gates under `.codegen/`, and launches the script with its Bash tool in the
background; the tool wakes it with the whole output when a run ends. It never
edits product files: `.claude/settings.json` (installed) denies it. Builders
can only edit paths their contract allows; the script checks scope, protected
paths and the gate after every attempt, retries once with the gate output as
evidence, then moves to the next model in the list. A model that only answers
rate-limit retries, or prints nothing at all for `timeouts_seconds.silence`
seconds (90), is skipped at once (`RATE_LIMITED` / `NO_RESPONSE`), not after
the timeout, and not held against it. A ladder entry may be a group (a JSON
array): one rung, raced by builders (each model in its own copy of the
sandbox, the first PASS lands, the others are killed as `LOST`) and tried one
by one by researchers; the default ladder has no group, the mechanism is the
same as opencode-min's.

## Install into a project

```bash
bash install.sh /path/to/project     # copies .claude/, CLAUDE.md and .claude/settings.json if absent, .gitignore entries
cd /path/to/project && claude        # you are the supervisor
```

Edit `.claude/models.json` to choose models, cheapest first. `install.sh`
never overwrites `models.json`, `CLAUDE.md` or `settings.json` once they exist.

## Check it works

```bash
bash smoke.sh                                   # one contract, first builder model
bash smoke.sh claude-sonnet-5                   # one contract, a given model
FIXTURE=parallel-basic CMD="build --parallel 3" bash smoke.sh   # three contracts, one depends on two
FIXTURE=parallel-basic CMD=research bash smoke.sh               # one real research question
```

Run it from a plain terminal or from inside Claude Code: a nested `claude`
refuses to start while `CLAUDECODE` is set, and the script drops that
variable for its own children.

## Behaviour freeze (no models, seconds)

```bash
bash tests/check.sh            # syntax, prompt/permission lint, board golden, 30 scenario goldens
bash tests/golden.sh --update  # after an intended change of behaviour, rewrite the goldens
bash tests/golden-board.sh --update   # after an intended change of the board's HTML
```

`tests/fake-claude/claude` stands in for the real binary, prints the same
stream-json events, and plays scripted builders and researchers from
`tests/scenarios/*.json` (the same scenarios as opencode-min, plus
`build-rate-limited`, and the race / no-response / research-group ones); the verdicts PASS, GATE_FAIL, RATE_LIMITED, NO_RESPONSE, LOST,
OUT_OF_SCOPE, PROTECTED_TOUCHED, STRUCTURE, NO_CHANGES, TIMEOUT, GATE_TRIVIAL,
GATE BROKEN, MERGE_CONFLICT, SKIPPED, DONE, PARTIAL, NO_REPORT, NO_MODELS,
one-shot, the reject refusals, resume and merge each have a scenario whose
normalized outputs live in `tests/golden/` (INSTALL_FAILED and ERROR do not).
The goldens were generated from this code and compared line by line with
opencode-min's: only the launcher's lines differ (model names, the cost per
attempt, the `[codegen]` lines in the output, the ladder length). Run
`check.sh` before and after touching any `.mjs`.

## Following a run

`node .claude/codegen.mjs board --watch` keeps `.codegen/board.html` fresh
every 10 s (builds and research also rewrite it on every state change). Open
it in VS Code with the Live Preview extension or in a browser. Strip: phase,
supervisor (you), contracts, what waits for you, cost (API-equivalent, from
the `result` event of every `claude -p` call). Tabs in workflow order:
**Ahora** (running now, the journal), **Research** (one table by run),
**Contratos** (dependency graph and a board by state), **Modelos y coste**
(ladders, one table per role). Click a contract, in the journal or on a card,
for its detail in a modal; click a research entry for the report rendered;
click a graph node to light its whole path. `.codegen/board.json` carries the
same facts, with the same shape as opencode-min's, for project-garden. The
design spec is `opencode-min/new-style/board/proposal.html`.

## Auditing a built project

A change request can arrive as a spoken audit: `wiki/audits/<stamp>/notes.md`
with `[HH:MM:SS]` paragraphs, the screenshots inline and the text the user
copied with Ctrl+C as fenced blocks, which is what the supervisor's
change-request loop reads first. Those sessions are recorded by
`voice-audit-wsl` (a separate repo, `~/voice-audit-wsl`: Whisper on the GPU,
web page served from WSL; Garden's "Auditar" opens it on the project).

## Safety

- A sandbox gets its dependencies before anything runs: `npm ci` when there is a
  `package-lock.json`, a `uv` venv (`.venv`, `pip install -e .[dev]` or
  `requirements.txt`, plus pytest) when there is a `pyproject.toml` or
  `requirements.txt`; the gate and the builder see that venv first in `PATH`.
- Builders run in a sandbox outside the repository (a fresh git repo exported
  from the integration branch, without the supervisor's `CLAUDE.md` and
  `.claude/`, which would load into the builder and deny it its own files),
  never in your tree. Researchers work in an empty directory of their own: a
  Claude Code `allow` rule with a path does not restrict, it only skips the
  prompt, so the directory is the fence and the report is copied back.
- Every agent runs in `--permission-mode default` with only its own `allow`
  rules: an unlisted tool call is denied, never asked.
- Passing work lands as commits on `codegen/<run>`; you merge it yourself.
- Tests and anything under `protected` cannot be changed by a builder.
- A gate that already passes on the untouched repo is refused (`GATE_TRIVIAL`).
- After the run the script warns if your working tree changed at all.

## Growth rule

No new state, flag, module or option without a concrete failure that asks
for it, and never without removing or merging something. The same rule
applies to every generated project (`.claude/rules/structure.md`,
principle 9).

## What differs from opencode-min (the launcher, nothing else)

- `lib/agent.mjs`: `runAgent` is `claude -p … --output-format stream-json --max-turns
  <maxTurns> --permission-mode default --settings <allow/deny of the agent file>
  --system-prompt <its body>` with `CLAUDECODE` dropped; steps, final text, one-shot,
  cost and duration come from the events; `RATE_LIMITED` when a call only got
  rate-limit retries (the ladder leaves that rung at once). No `opencode.json`
  whitelist guard, no `PWD` override.
- `codegen.mjs`: `research` and `build` run in the foreground (no `detach`, no
  `--wait`); `notify` is a `[codegen]` line in the output plus the journal, since the
  supervisor is the session that reads that output when the background command
  ends. Researchers get a private work dir under `.codegen/runs/`. The seal
  commits `CLAUDE.md` instead of `opencode.json`.
- `lib/sandbox.mjs`: the export drops `CLAUDE.md` and `.claude/`; `CLAUDE.md` is protected.
- `lib/board.mjs`: costs summed from the attempts; no OpenCode database, no quotas
  (`board.json` keeps those fields as null so Garden reads both harnesses alike).
- Tests: `fake-claude` instead of `fake-opencode`; `lint-prompts.sh` reads Claude
  Code rules (`Bash(prefix*)`, `allow`/`deny` lists, `templates/settings.json`).

## What is deliberately not here

Opinions, reconciler, source verification, source cache, session tracking,
subagents from the supervisor, agent teams, hooks, plugin, custom tools,
admission by benchmarks, metalog, fit checks, cost counters, quotas. Each
returns only when a concrete failure asks for it.
