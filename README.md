# ADW, Agent Development Workflow

Métodos de generación de código con agentes. El nombre es ADW porque el flujo no depende de un asistente: el supervisor puede ser la TUI de OpenCode o Claude Code, y los builders son modelos de OpenCode; el harness es el mismo.

Este repositorio compara métodos autocontenidos de generación de código para
Claude Code y OpenCode. Cada variante conserva su propia integración de harness.

```
clasico/
└── .claude/          ← método CLÁSICO: rules + skills + agents + hooks de disciplina
    ├── skills/       (/checkpoint, /blueprint, /plan-writing, /phase-executor, ...)
    ├── agents/       (architect, implementer, code-reviewer, ...)
    ├── rules/        (13 reglas: code-style, verification, planning-format, ...)
    ├── hooks/        (statusline, session-start, stop-suggest-checkpoint, ...)
    └── settings.template.json

noloop/
└── .claude/          ← método NO-LOOP (ADW): la estructura impone, la memoria no
    ├── hooks/        (adw-detect, adw-gate, adw-stop-gate, adw-posttool-lint)
    ├── settings.json / settings.template.json
    ├── referencias/  (diagramas del método, investigación, transcripción)
    ├── fixture-project/  (banco de pruebas con errores deliberados)
    ├── run-e2e.sh    (verificación end-to-end con claude -p real)
    └── adw-gates.conf.example

opencode/
├── .opencode/        ← agentes, Runner, gates y selección de modelos
├── install.mjs       ← instalación segura en otro proyecto
├── opencode.json     ← configuración de proveedores del método
└── tests/            ← pruebas del sistema reutilizable
```

## Filosofías

- **Clásico**: las reglas y skills *guían* al agente — disciplina de planeación
  (blueprint → PLAN.md → fases), bitácora, checkpoint. El agente recuerda verificar.
- **No-loop (ADW)**: los gates deterministas *imponen* el flujo — hooks que no dejan
  al agente terminar su turno con lint/tests rotos (exit 2 le devuelve los errores:
  el "fail: loop back" de los diagramas en `noloop/.claude/referencias/`). El humano
  aparece solo en los extremos: prompt y review.

## Usar un método en un proyecto

Copiar el `.claude/` del método al proyecto destino:

```bash
cp -r clasico/.claude  /ruta/al/proyecto/.claude   # o
cp -r noloop/.claude   /ruta/al/proyecto/.claude
cp noloop/.mcp.json    /ruta/al/proyecto/.mcp.json  # opcional, ver abajo
```

(Para no-loop: renombrar `settings.template.json` a `settings.json` en el destino y,
opcionalmente, definir los gates en `adw-gates.conf`; sin él se autodetectan —
Python → ruff/pytest, JS → eslint/prettier. Para el clásico: correr `/setup`.)

Para OpenCode, usa el instalador; no copies la carpeta `opencode/` dentro del
proyecto destino:

```bash
node opencode/install.mjs /ruta/al/proyecto --dry-run
node opencode/install.mjs /ruta/al/proyecto
```

El instalador solo entrega un sistema completo: cada rol (Goal Manager,
Planner, Gate Designer, Builder, Researcher, Advisors, Reconciler) debe tener
al menos una configuración admitida en su ruta del registro (`npm run
release:check`; ver `opencode/README.md`). Si falta alguna, la instalación
falla antes de copiar nada. Dentro de cada proyecto, la primera vez que se usa
una configuración se comprueba su encaje en segundos, y un metalog registra
cada llamada para que el selector baje sola a la que falla repetidamente. El proyecto destino arranca en el agente `supervisor`, que no
edita archivos: todo cambio de código pasa por Goal → aprobación → Planner →
Gate → Builder.

El repositorio conserva código, pruebas y documentación. Credenciales,
dependencias instaladas y artefactos de ejecución permanecen solo en local y
están ignorados por Git.

### Opcional: Codex vía MCP (no-loop)

`noloop/.mcp.json` registra `codex mcp-server` como herramienta MCP. Habilita
una segunda familia de modelo (OpenAI Codex, autenticado con tu suscripción
ChatGPT) en tres puntos de solo lectura del sistema: `verifier` y un
`researcher` en `/goal`, y un ángulo de `/opinion` — nunca en `builder` ni
`test-agent`, que necesitan el enforcement de hooks que solo ve tool-calls
nativas de Claude. Detalle y prioridad de cada punto en `skills/goal/SKILL.md`
y `skills/opinion/SKILL.md`.

Setup (una sola vez, fuera del repo):

```bash
npm install -g @openai/codex
codex   # "Sign in with ChatGPT" — usa tu plan Plus/Pro, sin API key
```

Primera vez en cada proyecto: Claude Code pide aprobación interactiva de
`.mcp.json` (corré `claude` a mano una vez y aceptá el trust dialog, o queda
en "Pending approval"). Es opcional y degradable: sin `codex` instalado o sin
`.mcp.json` copiado, todo el sistema sigue funcionando 100% con Claude.

También puedes abrir Claude directamente dentro de `clasico/` o `noloop/` para
trabajar sobre el método mismo.

## Verificar el método no-loop

```bash
bash noloop/.claude/run-e2e.sh
```

Copia el fixture a /tmp, instala el método, corre un `claude -p` real y muestra el log
de gates (`.claude/adw-runs/*.jsonl`) con la secuencia fail → loop-back → pass.

## Progresión del método no-loop (v0 → v4)

- **v0 (hecho)** — gate de lint que bloquea el turno (diagrama 1)
- **v1 (hecho)** — cadena lint → format → test (diagramas 2-3)
- **v2** — Test Agent con contexto fresco (diagrama 4)
- **v3** — Planner al frente + escalamiento de fallos (diagrama 5)
- **v4** — fan-out a N worktrees en paralelo (diagrama 6)
