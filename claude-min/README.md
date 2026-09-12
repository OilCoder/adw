# claude-min

The same minimal code-generation harness as `opencode-min`, on Claude Code
alone. One script, three agents, one hand-edited model list:

```text
idea → research questions (parallel) → plan + contracts + gates → builders (parallel, sandboxed) → independent gate → integration branch
```

## Roles and where they run

| Role | Runs | Model |
|---|---|---|
| Supervisor | the Claude Code session you open in the project | whatever you chose with `/model` |
| Researcher | `claude -p`, one per question, all at once, each in an empty work dir | `models.json` → `researcher` |
| Builder | `claude -p`, one per contract, N at a time, in a sandbox | `models.json` → `builder` |
| Gate | the script, deterministic | none |

Everything runs on the user's Claude subscription: no API key, no OpenCode.
The cost the board shows is what the API would have charged, for comparing
models; the subscription charges nothing per call.

The supervisor decomposes the idea, writes questions, plan, contracts and
gates under `.codegen/`, and launches the script with its Bash tool in the
background; the tool wakes it when a run ends. It never edits product files:
`.claude/settings.json` (installed) denies it. Builders can only edit paths
their contract allows; the script checks scope, protected paths and the gate
after every attempt, retries once with the gate output as evidence, then
moves to the next model in the list. A model that only answers rate-limit
retries is skipped at once (`RATE_LIMITED`), not after the timeout.

## Install into a project

```bash
bash install.sh /path/to/project     # copies .claude/, CLAUDE.md, .claude/settings.json, .gitignore entries
cd /path/to/project && claude        # you are the supervisor
```

Edit `.claude/models.json` to choose models, cheapest first (default:
`claude-haiku-4-5` → `claude-sonnet-5` → `claude-opus-5`).

## Check it works

```bash
bash smoke.sh                                   # one contract, first builder model
bash smoke.sh claude-sonnet-5                   # one contract, a given model
FIXTURE=parallel-basic CMD="build --parallel 3" bash smoke.sh   # three contracts, one depends on two
FIXTURE=parallel-basic CMD=research bash smoke.sh               # one real research question
```

Run smoke.sh from a plain terminal, or with `env -u CLAUDECODE` from inside
Claude Code (a nested `claude` refuses to start while that variable is set;
the script drops it for its own children).

## Agents

`.claude/agents/<role>.md`: front matter with `steps` (max turns), `allow` and
`deny` (Claude Code permission rules, JSON arrays), then the system prompt.
The script runs every agent with `--permission-mode default` and a settings
file made from those two lists: an unlisted tool call is denied, never asked.
Researchers get web search and a private empty directory; builders get edit
and the test commands, no web.

## Following a run

`node .claude/codegen.mjs board --watch` keeps `.codegen/board.html` fresh.
`.codegen/board.json` carries the same facts for other tools.

## Safety

- Sandboxes get their dependencies first (`npm ci`, or a `uv` venv from
  `pyproject.toml` / `requirements.txt`).
- Builders run in a sandbox outside the repository, never in your tree.
- Passing work lands as commits on `codegen/<run>`; `merge` lands it on your branch.
- Tests and anything under `protected` cannot be changed by a builder.
- A gate that already passes on the untouched repo is refused (`GATE_TRIVIAL`).

## Growth rule

No new state, flag, module or option without a concrete failure that asks
for it, and never without removing or merging something. Fixes to the script
apply to `opencode-min` and `claude-min` alike unless they are about the
launcher.
