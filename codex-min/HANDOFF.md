# codex-min — punto de recuperación (2026-09-14)

## Qué es

El mismo harness que `opencode-min/` y `claude-min/` (idea → research → mapa
→ plan + contratos + gates → builders en sandbox → gate → rama de
integración → `merge`), corriendo solo sobre Codex CLI (0.154.0) y la
suscripción ChatGPT del usuario. Supervisor = la sesión TUI de `codex`
abierta en el proyecto, con GPT-6 Astra (`.codex/config.toml`); researchers y
builders = `codex exec` con GPT-5.6 Luna y, de rescate, GPT-5.6 Terra.

## Historia

- 2026-09-14: construida desde `claude-min` HEAD (que a su vez es
  opencode-min HEAD con el lanzador cambiado). Método: copia, rutas
  `.claude`→`.codex`, `rules`→`instructions`, `CLAUDE.md`→`AGENTS.md`, y encima
  el lanzador de Codex (lista "What differs" del README). Verificación: los 32
  escenarios golden corridos aquí con `tests/fake-codex/codex` y comparados
  línea a línea con los de claude-min: solo difieren nombres de modelo, coste
  por intento, `delivered`/`reason` de los avisos y las rutas `.codex/`
  (residuo tras normalizar: 2 líneas, `cost: null` en RATE_LIMITED porque un
  turno fallido no trae uso). Smokes reales con Luna: build 1/1 PASS en 36 s
  (0,12 cr), research 1 pregunta con búsqueda web real (ver abajo).

## Hechos verificados con Codex 0.154.0 (no volver a investigar)

- `codex exec --json` imprime JSONL: `thread.started`, `turn.started`,
  `item.started/completed` (item.type: `agent_message`, `command_execution`
  con `command`/`aggregated_output`/`exit_code`, `file_change` con
  `changes[{path,kind:add|update|delete}]`, `reasoning`, `web_search`,
  `mcp_tool_call`), `turn.completed` con `usage` (`input_tokens`,
  `cached_input_tokens`, `output_tokens`, `reasoning_output_tokens`),
  `turn.failed`, `error`. No hay coste ni duración en los eventos: el precio
  sale de `models.json` (`prices`, créditos por millón según la página de
  precios de Codex del 2026-09-14: luna 5/0,5/30, terra 50/5/300, sol
  100/10/500, astra 250/25/1250; la conversión crédito→USD no está
  publicada, no inventarla) y la duración la mide el script.
- `codex exec` no acepta `-a`; la política de aprobación va por
  `-c approval_policy=never|on-request`. No existe `--max-turns`.
- Un `codex exec` anidado dentro del sandbox de Codex muere al arrancar:
  "failed to initialize in-process app-server client: Read-only file system"
  (`~/.codex` es de solo lectura dentro del sandbox, con o sin red). Por eso
  `research`/`build` comprueban que `~/.codex` sea escribible y se niegan a
  arrancar dentro del sandbox (exit 1 con el motivo), y el supervisor los lanza
  escalados.
- Un proceso desprendido (`spawn detached + unref`) desde un comando
  **escalado** sobrevive al fin de la llamada y del proceso `codex`
  (verificado con `sleep` huérfano de PID 1). Dentro del sandbox no: el
  comando se queda colgado y el hijo muere con él.
- Escalado en `codex exec`: con `approvals_reviewer=user` está deshabilitado
  del todo (no hay quien apruebe); con `approvals_reviewer=auto_review` (el
  config del usuario) el modelo revisor aprueba. En la TUI, con
  `approval_policy=on-request`, una regla `allow` en `.codex/rules` aprueba
  sin preguntar según la documentación: **no comprobado en una TUI viva**
  (no se puede desde `exec`).
- `.codex/config.toml` del proyecto se carga solo si el proyecto está en
  `[projects."…"] trust_level = "trusted"` del config del usuario (la
  sobreescritura por `-c projects…` no bastó). Perfil de permisos verificado:
  `default_permissions = "supervisor"` con `extends = ":workspace"` y
  `[permissions.supervisor.filesystem.":workspace_roots"]` `"." = "write"`,
  `"src" = "read"` → escribir en `src/` da "Read-only file system", en
  `.codegen/` funciona. Regla `prefix_rule(pattern=["rm"],
  decision="forbidden")` bloquea con "rejected: <justification>". Los
  perfiles de permisos no se combinan con `sandbox_mode`.
- `AGENTS.md` solo se lee en la raíz de un repositorio **git** (con
  `--skip-git-repo-check` en un directorio sin git no se carga). Prueba
  determinista: codeword en AGENTS.md, 2/2 con `--ignore-user-config`. Por
  eso la madriguera del researcher hace `git init`, y el sandbox lleva el
  AGENTS.md del builder en el commit base.
- `codex exec` apunta cada directorio en que corre como proyecto de
  confianza en `$CODEX_HOME/config.toml`, incluso con `--ignore-user-config`
  y con `--ephemeral`. Por eso los agentes corren con `CODEX_HOME` privado
  (`<sandboxes>/_codex-home`, `auth.json` enlazado desde `~/.codex`): el
  config del usuario queda limpio (verificado: 20 → 20 entradas). Avisa
  "could not create PATH aliases" si ese home está bajo `/tmp`; inocuo.
- Escritura denegada por el sandbox bajo `approval_policy=never` vuelve
  limpia al modelo ("Read-only file system", exit 1), sin colgarse.
  Anomalía no reproducida: tres `exec --json` con el config del usuario
  cargado (auto_review), una escritura denegada y un prompt con varios
  comandos se quedaron colgados 200 s sin eventos; con prompt simple o sin
  `--json` no pasa. Los agentes no cargan el config del usuario, así que no
  les afecta; anotado por si aparece en la TUI del supervisor.
- `codex queue --thread <uuid> --message <texto>` encola en
  `~/.codex/queue_1.sqlite` (exit 0 aunque la sesión no esté abierta). La
  sesión TUI del proyecto se encuentra en `~/.codex/sessions/AAAA/MM/DD/
  rollout-*.jsonl`: primera línea `session_meta` con `cwd` y
  `originator: "codex-tui"` (los `exec` son `codex_exec` y con `--ephemeral`
  no escriben); esa primera línea mide ~18 KB (lleva el prompt base entero),
  `codex-db.mjs` la lee hasta el salto de línea. Probado contra un rollout
  real (hilo del 2026-09-08): id, nombre del hilo, última acción, "esperando"
  y 84 mensajes de usuario correctos. **Entrega a una TUI viva no comprobada**: es la diferencia de
  comportamiento asumida de este harness (como en claude-min la del aviso).
- La TUI ejecuta comandos con `exec_command` + `wait` (celdas PTY con
  `yield_time_ms`): un comando largo bloquea la celda, de ahí `detach`.
- El mensaje final del researcher: Luna tiende a cerrar con "Research report
  completed: [report.md](…)" y a poner `DONE ./report.md` dentro del informe;
  el cierre se lee del último `agent_message`, así que el prompt del lanzador
  y el paso 5 del researcher dicen explícitamente que la línea DONE va en la
  respuesta, no en el informe.

## Escalera por defecto

`models.json`: luna → terra, `max_models_per_item: 2`, dos intentos por
peldaño. Sol y Astra fuera a propósito (decisión del usuario 2026-09-14:
Astra supervisa, Luna construye e investiga). `model_reasoning_effort` del
supervisor en `medium` (Astra trae `low` por defecto; subirlo es decisión de
coste del usuario).

## Cómo retomar

```bash
cd /home/pokinux/adw/codex-min && bash tests/check.sh     # ~20 s, sin modelos
bash smoke.sh                                              # un contrato real con luna
FIXTURE=parallel-basic CMD=research bash smoke.sh          # una pregunta real con búsqueda web
```

Regla de mantenimiento: un arreglo al script que no sea del lanzador se
aplica en opencode-min, claude-min y codex-min por igual; nunca ajustes
cruzados. Para reconstruir desde claude-min HEAD, repetir el método de arriba.

## Pendiente

- Primera sesión TUI real en un proyecto de campo: comprobar (1) que la regla
  `allow` deja escalar `research`/`build`/`merge` sin preguntar, (2) que el
  mensaje de `codex queue` llega a la TUI al terminar el turno, (3) que la
  sesión escalada no rompe nada más, (4) que Astra lee las instrucciones que
  `AGENTS.md` le manda leer. Cada punto es un hecho a apuntar arriba.
- Tag `codex-min-v1` cuando el usuario lo decida.
