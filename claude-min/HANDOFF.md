# claude-min — punto de recuperación (2026-09-13)

## Qué es

El mismo harness que `opencode-min/` (idea → research → mapa → plan +
contratos + gates → builders en sandbox → gate → rama de integración →
`merge`), corriendo solo sobre Claude Code y la suscripción del usuario.
Supervisor = la sesión de Claude Code abierta en el proyecto (Fable);
researchers y builders = `claude -p` con Haiku y, de rescate, Sonnet.

## Historia

- 2026-09-12: primera versión, copiada del tag `opencode-min-v1` (commits
  a12a08b…2fdb706). Smoke 1/1 y 3/3 con haiku.
- 2026-09-13: **reconstruida desde `opencode-min` HEAD** (17 commits después
  del tag: módulos en `lib/`, `tests/check.sh` con binario falso y goldens,
  tablero v2, marca "written in one go", supervisor reagrupado). Método: copia
  de opencode-min HEAD, rutas `.opencode`→`.claude` e `instructions`→`rules`,
  y encima el delta del lanzador medido con `diff` entre claude-min v1 y el tag.
  Verificación: los 24 escenarios golden de opencode-min corridos aquí con
  `tests/fake-claude/claude` y comparados línea a línea con los goldens de
  opencode-min: solo difieren nombres de modelo, coste por intento, las líneas
  `[codegen]` en la salida, `delivered` y la longitud de la escalera (2 vs 3).
  Smokes reales con haiku: 1/1 (22 s, 0,045 USD equiv.), 3/3 en paralelo
  (un intento cada uno), research (ver abajo).

## Qué cambia respecto a opencode-min (y solo esto)

Está en README "What differs". Resumen: `runAgent` con `claude -p`,
permisos por `--settings` desde el frontmatter del agente, `CLAUDECODE`
quitado; sin `detach`/`--wait` ni aviso por puerto (el supervisor lanza en
segundo plano con su Bash y recibe la salida entera al terminar);
researcher en directorio vacío propio; sandbox sin `CLAUDE.md`/`.claude/`;
coste desde los intentos; `RATE_LIMITED` salta el peldaño; sin cuotas.
`board.json` mantiene el mismo esquema (quota/openai null, lastNotify con
delivered/port/reason) para que Garden lea ambos harness igual.

## Hechos verificados (no volver a investigar)

- Un `claude` anidado no arranca con `CLAUDECODE` en el entorno; el script
  la quita para sus hijos y el smoke corre desde dentro de Claude Code.
- En `--permission-mode default` un Bash no listado se deniega sin preguntar;
  `deny` con rutas bloquea; `allow` con ruta NO restringe (solo evita la
  pregunta): por eso el researcher trabaja en `.codegen/runs/<q>.<n>.work/`.
- `Bash(bash .codegen/contracts/*)` (sin espacio antes del `*`) deja correr
  el gate; el lint de prompts usa esa semántica de glob.
- Los subagentes nativos (`.claude/agents/*.md`) no admiten reglas
  allow/deny propias ni cwd propio, y cada uno termina dentro del contexto
  del supervisor: por eso los agentes siguen siendo procesos `claude -p`,
  no `Agent`. Agent Teams siguen experimentales y no arrancan en `-p`.
- Coste y duración vienen del evento `result` de stream-json; los pasos son
  los mensajes `assistant` con `tool_use`; Write/Edit cuentan para one-shot.
- Diferencia de comportamiento asumida: en OpenCode el supervisor recibe un
  aviso por cada contrato que falla mientras la corrida sigue; aquí la
  sesión solo despierta al terminar el proceso. Entre medias `status` muestra
  los fallos y el supervisor puede arreglar contratos si el usuario pregunta.

## Escalera por defecto

`models.json`: haiku → sonnet, `max_models_per_item: 2`, dos intentos por
peldaño. Opus fuera a propósito (decisión del usuario 2026-09-13: un solo
modelo barato construye; si Haiku y Sonnet fallan, el contrato está mal).

## Cómo retomar

```bash
cd /home/pokinux/adw/claude-min && bash tests/check.sh     # 17 s, sin modelos
bash smoke.sh                                              # un contrato real con haiku
```

Regla de mantenimiento: un arreglo al script que no sea del lanzador se
aplica en opencode-min y en claude-min por igual; nunca ajustes cruzados.
Para reconstruir de nuevo desde opencode-min HEAD, repetir el método de
arriba: copiar, renombrar rutas, re-aplicar la lista "What differs" del
README, regenerar goldens y compararlos con los de opencode-min.

## Deriva conocida solo de pruebas

`tests/golden.mjs` normaliza quitando la línea entera de `duration_ms`/`at`
(opencode-min deja una línea en blanco). Aplicar lo mismo en opencode-min
cuando toque regenerar sus goldens, o dejarlo anotado aquí.

## Pendiente

- Instalar en un proyecto de campo y medir el pico de contexto del supervisor
  y el consumo de cuota con builders en paralelo (todo comparte la
  suscripción: supervisor, builders y la conversación del usuario).
- Tag `claude-min-v2` cuando el usuario lo decida.
