# The idea (`wiki/idea/`, written by the user with the supervisor)

The idea is the input of everything else: research questions come from what
it leaves as facts to confirm, contracts quote it, gates test what it calls
done. The more complete it is, the less research the project pays for.
Seven files, Spanish names because every project already uses them; index
in `idea.md`. Rule for each: one question it answers, what goes in, what
stays out.

| File | Answers | In | Out | Who fills it |
|---|---|---|---|---|
| `idea.md` | What is it and when is it done? | user, goal, definition of done (one concrete scenario), what it does in a few bullets, out of scope, index of the other six | details, figures, formulas | the user, with the supervisor asking |
| `requisitos.md` | What exact surface does it have? | commands or screens, config with exact keys, outputs and files, exit codes, two real examples of printed or rendered output, quality requirements | the why (that is `decisiones.md`) | the user with the supervisor |
| `modelo.md` | What does the domain know? | formulas with units and domain, columns and classes with verified figures, official metrics, protocols, references opened | design opinions | research reports, judged by the supervisor |
| `datos.md` | What is in `data/` and where did it come from? | origin, hashes, sizes, what is versioned, what is fetched | column descriptions (those are `modelo.md`) | a script plus research |
| `verificacion.md` | How do we know it works? | cases with a known answer, end-to-end acceptance criteria, as recommended references | concrete tests, tolerances, split by contract: the supervisor decides those | the user with the supervisor |
| `decisiones.md` | What is closed and why? | one row per decision: decision, discarded alternatives, reason; reopened only with a new reason written there | anything still open | the user |
| `glosario.md` | What does each word mean? | one line per term | anything else | the supervisor |

Frozen: requirements, definition of done, domain model, invariants and
decisions. Open: how it is implemented, how it is tested, how work is split.
A longer idea is not a better idea: one real input/output example beats
three paragraphs, and every extra instruction lowers how well a cheap model
follows the rest. Verification lists references, never a test plan.

Once the project is built the idea is not edited by hand: a change goes
through `wiki/changes/<name>/` (`proposal.md`, `delta.md`) and the delta is
applied to `wiki/idea/` after the change lands (supervisor loop for change
requests).
