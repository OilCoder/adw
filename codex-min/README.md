# codex-min

The same minimal code-generation harness as `opencode-min` and `claude-min`,
on OpenAI's Codex CLI alone: one script, three agents, one hand-edited model
list, about 2,400 formatted lines in six modules. Everything runs on the
user's ChatGPT subscription through `codex`: no API key, no OpenCode, no
Claude. Fixes to the script apply to the three harnesses alike unless they are
about the launcher (what differs is listed at the end).

```text
idea → research questions (parallel) → plan + contracts + gates → builders (parallel, sandboxed) → independent gate → integration branch
```

## Files

`.codex/` is Codex's own project folder, and the harness uses its native
places: `AGENTS.md` at the root hands the session the supervisor role,
`.codex/config.toml` gives it its model (GPT-6 Astra) and exactly the
supervisor's permissions, `.codex/rules/*.rules` let it launch the script
outside the sandbox. `codegen.mjs`, `models.json`, `agents/`, `instructions/`
and `lib/` sit next to them; Codex ignores files it does not know.

| File | Does |
|---|---|
| `.codex/codegen.mjs` | the commands (`research`, `build`, `status`, `merge`, `structure`, `board`) and every file under `.codegen/` |
| `.codex/lib/agent.mjs` | runs a process with a timeout, one agent through `codex exec`, a task pool, the model ladder, the price of a call |
| `.codex/lib/sandbox.mjs` | one contract's sandbox: export, dependencies, gate, scope and structure checks, landing the diff |
| `.codex/lib/codex-db.mjs` | reads Codex's session files: the supervisor's thread (for `codex queue`), what the user asked, what the supervisor did last |
| `.codex/lib/board.mjs` | the board's facts (`boardData`, `boardJson`), costs summed from the attempts, the OpenAI quota |
| `.codex/lib/board-html.mjs`, `lib/board.css` | the board's HTML, one function per section, styles inlined. **A redesign touches only these two.** |
| `.codex/agents/*.md` | builder and researcher: `name`, `description`, `maxSteps`, `search`, and the body the script writes as the `AGENTS.md` of the directory the agent works in |
| `.codex/instructions/*.md` | the supervisor's rules (supervisor, codegen, structure, idea); the root `AGENTS.md` tells the session to read them first |
| `.codex/rules/codegen.rules` | the supervisor's execution policy: `research`, `build` and `merge` run escalated without a prompt; `git merge/push/reset` and `rm` are forbidden |
| `templates/` | `AGENTS.md` and `.codex/config.toml` for the supervisor |
| `.codex/models.json` | the ladder and the prices |

The board reloads `lib/board-html.mjs` and `lib/board.css` whenever they change on disk,
so a build that runs for hours picks up a redesign without a restart.

## Roles and where they run

| Role | Runs | Model |
|---|---|---|
| Supervisor | the Codex TUI session you open in the project | `.codex/config.toml` → `gpt-6-astra` (or whatever you pick with `/model`) |
| Researcher | `codex exec`, one per question, all at once, each in an empty git repo of its own, with live web search | `models.json` → `researcher` (Luna, then Terra) |
| Builder | `codex exec`, one per contract, N at a time, in a sandbox, no network | `models.json` → `builder` (Luna, then Terra) |
| Gate | the script, deterministic | none |

Codex has one really cheap model, GPT-5.6 Luna: it does the building and the
research, GPT-5.6 Terra is the rescue rung, and GPT-6 Astra is out of the
ladder on purpose (the supervisor is already the strong model; a contract
that Luna and Terra both fail is a wrong contract or gate). The cost the
board shows is what the API would have charged, in the credits of the Codex
pricing page (`models.json` → `prices`), for comparing models; the
subscription charges quota.

The supervisor decomposes the idea, writes questions, plan, contracts and
gates under `.codegen/`, and launches the script escalated (outside Codex's
sandbox, which `.codex/rules` approves without a prompt): `research` and
`build` return at once and keep running detached, and the script queues a
`[codegen]` message into the supervisor's thread with `codex queue` when a
contract fails for good and when the run ends. It never edits product files:
the permission profile in `.codex/config.toml` makes `src/`, `tests/`,
`.codex/` and `AGENTS.md` read-only for it. Builders can only edit paths
their contract allows; the script checks scope, protected paths and the gate
after every attempt, retries once with the gate output as evidence (not after
NO_CHANGES or TIMEOUT: measured over seven projects, that retry passed 8 % of
the time against 64 % after GATE_FAIL), then moves to the next model in the
list. A contract that fails for good does not end the run: the supervisor
fixes it and `build --resume --only <id>` queues it into the live run
(refused if nothing changed) while other contracts still build. A model whose
turn fails on a rate or usage limit before any work, or that prints nothing
at all for `timeouts_seconds.silence` seconds (90), is skipped at once
(`RATE_LIMITED` / `NO_RESPONSE`), not after the timeout, and not held against
it. A ladder entry may be a group (a JSON array): one rung, raced by builders
(each model in its own copy of the sandbox, the first PASS lands, the others
are killed as `LOST`) and tried one by one by researchers; the default ladder
has no group.

## Install into a project

```bash
bash install.sh /path/to/project     # copies .codex/, AGENTS.md and .codex/config.toml if absent, .gitignore entries
cd /path/to/project && codex         # you are the supervisor; trust the project when Codex asks
```

Codex loads `.codex/config.toml` and `.codex/rules/` only in a trusted
project, so answer yes the first time. Edit `.codex/models.json` to choose
models, cheapest first. `install.sh` never overwrites `models.json`,
`AGENTS.md` or `config.toml` once they exist.

## Check it works

```bash
bash smoke.sh                                   # one contract, first builder model
bash smoke.sh gpt-5.6-terra                     # one contract, a given model
FIXTURE=parallel-basic CMD="build --parallel 3" bash smoke.sh   # three contracts, one depends on two
FIXTURE=parallel-basic CMD=research bash smoke.sh               # one real research question
```

Run it from a plain terminal (or from Claude Code). From inside a Codex
session it must run escalated: the agents are `codex exec` processes and die
inside the sandbox (`~/.codex` is read-only there); the script refuses to
start in that case and says so.

## Behaviour freeze (no models, seconds)

```bash
bash tests/check.sh            # syntax, prompt/rules lint, board golden, 32 scenario goldens
bash tests/golden.sh --update  # after an intended change of behaviour, rewrite the goldens
bash tests/golden-board.sh --update   # after an intended change of the board's HTML
```

`tests/fake-codex/codex` stands in for the real binary, prints the same JSONL
events (`thread.started`, `item.completed`, `turn.completed`, `error`), and
plays scripted builders and researchers from `tests/scenarios/*.json` (the
same scenarios as claude-min, with OpenAI model names); its `calls.log`
records the sandbox, approval policy, web search, config and AGENTS.md each
role got. The verdicts PASS, GATE_FAIL, RATE_LIMITED, NO_RESPONSE, LOST,
OUT_OF_SCOPE, PROTECTED_TOUCHED, STRUCTURE, NO_CHANGES, TIMEOUT, GATE_TRIVIAL,
GATE BROKEN, MERGE_CONFLICT, SKIPPED, DONE, PARTIAL, NO_REPORT, NO_MODELS,
one-shot, the reject refusals, resume and merge each have a scenario whose
normalized outputs live in `tests/golden/` (INSTALL_FAILED and ERROR do not).
The goldens were generated from this code and compared line by line with
claude-min's: only the launcher's lines differ (model names, the cost per
attempt, `delivered` and `reason` of a notice, the `.codex/` paths). Run
`check.sh` before and after touching any `.mjs`.

## Following a run

`node .codex/codegen.mjs board --watch` keeps `.codegen/board.html` fresh
every 10 s (builds and research also rewrite it on every state change). Open
it in VS Code with the Live Preview extension or in a browser. Strip: phase,
supervisor (its Codex thread, read from `~/.codex/sessions`), contracts, what
waits for you, cost (API-equivalent credits, from the `turn.completed` usage
of every `codex exec` call priced with `models.json`). Then the ChatGPT
subscription quota (5 hours, week), read from the usage endpoint with the
token Codex keeps in `~/.codex/auth.json` (the same call opencode-min makes).
Tabs in workflow order: **Ahora** (running now, the journal), **Research**
(one table by run), **Contratos** (dependency graph and a board by state),
**Modelos y coste** (ladders, one table per role). Click a contract, in the
journal or on a card, for its detail in a modal; click a research entry for
the report rendered; click a graph node to light its whole path.
`.codegen/board.json` carries the same facts, with the same shape as
opencode-min's, for project-garden (`openai` filled, `quota` and `claude`
null). The design spec is `opencode-min/new-style/board/proposal.html`.

## Auditing a built project

A change request can arrive as a spoken audit: `wiki/audits/<stamp>/notes.md`
with `[HH:MM:SS]` paragraphs, the screenshots inline and the text the user
copied with Ctrl+C as fenced blocks, which is what the supervisor's
change-request loop reads first. Those sessions are recorded by
`voice-audit-wsl` (a separate repo, `~/voice-audit-wsl`).

## Safety

- A sandbox gets its dependencies before anything runs: `npm ci` when there is a
  `package-lock.json`, a `uv` venv (`.venv`, `pip install -e .[dev]` or
  `requirements.txt`, plus pytest) when there is a `pyproject.toml` or
  `requirements.txt`; the gate and the builder see that venv first in `PATH`.
- Builders run in a sandbox outside the repository (a fresh git repo exported
  from the integration branch, without the supervisor's `AGENTS.md` and
  `.codex/`, with the builder's role as its own `AGENTS.md` inside the base
  commit), never in your tree. Around it, Codex's own sandbox: only that
  directory and the temp dirs are writable, `.git` is protected, there is no
  network, and nothing asks (`approval_policy=never`: a blocked action is an
  error for the model). Researchers work in an empty git repo of their own
  with live web search and the report is copied back.
- Every agent runs with the user's config and rules ignored and a private
  `CODEX_HOME` next to the sandboxes (`_codex-home`, `auth.json` linked from
  `~/.codex`): `codex exec` records every directory it runs in as a trusted
  project, and that must not land in the user's `config.toml`.
- Passing work lands as commits on `codegen/<run>`; you merge it yourself
  (`merge`, escalated: the sandbox protects `.git`).
- Tests and anything under `protected` cannot be changed by a builder.
- A gate that already passes on the untouched repo is refused (`GATE_TRIVIAL`).
- After the run the script warns if your working tree changed at all.

## Growth rule

No new state, flag, module or option without a concrete failure that asks
for it, and never without removing or merging something. The same rule
applies to every generated project (`.codex/instructions/structure.md`,
principle 9).

## What differs from claude-min and opencode-min (the launcher, nothing else)

- `lib/agent.mjs`: `runAgent` is `codex exec --json --ephemeral --ignore-user-config
  --ignore-rules --skip-git-repo-check --sandbox workspace-write -c approval_policy=never
  -c web_search=live|disabled --model <m> --cd <dir> --output-last-message <file> <prompt>`
  with `CODEX_HOME` set to the agents' private home; the agent's body is the
  directory's `AGENTS.md`. Steps are the `command_execution`, `file_change`,
  `mcp_tool_call` and `web_search` items; the final text is the last
  `agent_message`; one-shot counts `file_change` adds and updates; cost is the
  `turn.completed` usage priced with `models.json`; `RATE_LIMITED` when the
  turn failed on a rate or usage limit with no step done. No `--max-turns`
  exists: `maxSteps` is only the researcher's DONE threshold, the timeout is
  the hard cut.
- `codegen.mjs`: `research` and `build` detach (`--wait` keeps them in the
  foreground) and refuse to start inside Codex's sandbox; `notify` is
  `codex queue --thread <supervisor thread> --message "[codegen] …"`, the
  thread being the newest TUI session opened in the project (`codex-db.mjs`);
  the journal records `delivered` (queue accepted) and `reason`. The seal
  commits `AGENTS.md`. Researchers get a private git repo under `.codegen/runs/`.
- `lib/sandbox.mjs`: the export drops `AGENTS.md` and `.codex/` and writes the
  builder's `AGENTS.md` before the base commit; `AGENTS.md` is protected.
- `lib/board.mjs`: costs summed from the attempts; the supervisor from Codex's
  session files; the OpenAI quota from `~/.codex/auth.json`, in `board.json` as
  `openai` (`quota` and `claude` stay null so Garden reads all three alike).
- Tests: `fake-codex` instead of `fake-claude`; `lint-prompts.sh` reads the
  execution policy (`.codex/rules/codegen.rules`) and checks that the
  researcher, which has no shell, cites no command.

## What is deliberately not here

Opinions, reconciler, source verification, source cache, session tracking,
Codex sub-agents (`multi_agent`), hooks, plugins, custom tools, admission by
benchmarks, metalog, fit checks, cost counters. Each returns only when a
concrete failure asks for it.
