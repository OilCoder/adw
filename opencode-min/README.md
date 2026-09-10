# opencode-min

Minimal code-generation harness for OpenCode. One script, three agents, one
hand-edited model list. Replaces the `opencode/` system (7,500 lines of
runners, admission, metalog, research verification, session tracking) with
about 450 lines that do the same core job:

```text
idea → research questions (parallel) → plan + contracts + gates → builders (parallel, sandboxed) → independent gate → integration branch
```

## Roles and where they run

| Role | Runs | Model |
|---|---|---|
| Supervisor | the TUI, talking with you | the TUI model (OpenAI subscription) |
| Researcher | `codegen.mjs research`, one per question, all at once | `models.json` → `researcher` (OpenCode Go) |
| Builder | `codegen.mjs build`, one per contract, N at a time | `models.json` → `builder` (OpenCode Go) |
| Gate | the script, deterministic | none |

The supervisor decomposes the idea, writes questions, plan, contracts and
gates under `.codegen/`, and launches the script. It never edits product
files. Builders can only edit paths their contract allows; the script checks
scope, protected paths and the gate after every attempt, retries once with the
gate output as evidence, then moves to the next model in the list.

## Install into a project

```bash
bash install.sh /path/to/project     # copies .opencode/, opencode.json if absent, .gitignore entries
cd /path/to/project && opencode      # supervisor is the default agent
```

Edit `.opencode/models.json` to choose models, cheapest first.

## Check it works

```bash
bash smoke.sh                                   # one contract, first builder model
bash smoke.sh opencode-go/glm-5.3-flash         # one contract, a given model
FIXTURE=parallel-basic CMD="build --parallel 3" bash smoke.sh   # three contracts, one depends on two
FIXTURE=parallel-basic CMD=research bash smoke.sh               # one real research question
```

## Following a run

`node .opencode/codegen.mjs board --watch` keeps `.codegen/board.html` fresh
every 10 s (builds and research also rewrite it on every state change). Open
it in VS Code with the Live Preview extension or in a browser. Tabs: **Ahora**
(phase, what is running, the journal with ● contracts, ■ research, ◆ your
messages), **Contratos** (dependency graph + board), **Research**, **Modelos
y coste**. Supervisor activity, your messages and costs come from OpenCode's
own database, read-only, no model calls.

## Safety

- Builders run in a sandbox outside the repository (a fresh git repo exported
  from the integration branch), never in your tree. The script also sets
  `PWD` for the child: OpenCode resolves its project from that variable, not
  from the real working directory.
- Passing work lands as commits on `codegen/<run>`; you merge it yourself.
- Tests and anything under `protected` cannot be changed by a builder.
- A gate that already passes on the untouched repo is refused (`GATE_TRIVIAL`).
- After the run the script warns if your working tree changed at all.

## What is deliberately not here

Opinions, reconciler, source verification, source cache, session tracking,
TUI following, plugin, custom tools, admission by benchmarks, metalog, fit
checks, cost counters. Each returns only when a concrete failure asks for it.
