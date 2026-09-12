# claude-min — punto de recuperación (2026-09-12 00:40)

Nació de `opencode-min-v1` (`git archive` del tag) la noche del 11 al 12 de
septiembre, a petición del usuario: mismo harness, el supervisor es la
sesión de Claude Code y researchers y builders son `claude -p` con modelos
baratos, todo con la suscripción (decisión del usuario: sin clave de API).

## Qué cambia respecto a opencode-min (y solo esto)

- Carpeta del proyecto `.adw/` en vez de `.opencode/`; sin `opencode.json`;
  sin `opencode-db.mjs`.
- `runAgent`: `claude -p <prompt> --model <m> --output-format stream-json
  --verbose --max-turns <steps> --permission-mode default --settings <json>
  --system-prompt <cuerpo del agente>`, con `CLAUDECODE` quitado del entorno
  (un claude anidado no arranca con esa variable). Coste, duración y uso
  salen del evento `result`; se guardan por intento y por pregunta.
- Agentes: front matter `steps`, `allow`, `deny` (reglas de permisos de
  Claude Code en JSON). Verificado con pruebas: en modo `default` un Bash no
  listado se deniega sin preguntar; `deny` con rutas (`Edit(src/**)`) bloquea;
  una regla `allow` con ruta NO restringe por sí sola (solo evita la
  pregunta). Por eso el researcher trabaja en un directorio vacío propio y el
  script copia `report.md` a `.codegen/research/`.
- `RATE_LIMITED`: cero pasos y ≥ 3 eventos de rate limit → siguiente peldaño
  al instante (hoy en Zen cada intento así costó 15 min).
- Sin `notify` por puerto ni `detach`: `research` y `build` corren en primer
  plano; el supervisor los lanza con Bash en segundo plano y Claude Code lo
  despierta al terminar. Las líneas `[codegen]` van a la salida y al diario.
- Tablero: coste y tiempo desde los intentos (equivalente API); "Supervisor:
  tú". Sin fases "supervisor trabajando" / "te espera" (dependían de la BD).
- `install.sh` escribe además `CLAUDE.md` (rol de supervisor) y
  `.claude/settings.json` (permisos exactos del supervisor: edita solo
  `.codegen/**` y `wiki/**`, corre solo el script y git de lectura; deniega
  `src/**`, `git merge`, `git push`, `rm`). Regla de higiene cumplida por
  construcción: prompt y permisos coinciden.

## Pruebas del estreno

- `smoke.sh` con haiku: 1/1 PASS, 6 pasos, 17 s, 0,041 USD equivalentes.
- `parallel-basic --parallel 3` (a la vez que un research): 3/3 PASS con
  haiku, 1 intento cada uno, 7 a 14 pasos, 0,03 a 0,05 USD equivalentes,
  todo en ~80 s; cero eventos de rate limit con cuatro procesos a la vez.
- `research` (las-null, haiku): PARTIAL por tope de pasos (30): el informe
  quedó completo (96 líneas, las cuatro secciones, 9 fuentes) pero el modelo
  gastó los turnos en escrituras pequeñas y no llegó a la línea `DONE`.
  Mismo comportamiento que en opencode-min; el supervisor lo acepta. Si se
  repite, subir `steps` del researcher a 40 es el ajuste, no otro modelo.

## Costes asumidos (dichos al usuario)

- Dos harness: un arreglo al script se aplica en los dos salvo que sea del
  lanzador.
- Todo comparte la cuota de la suscripción de Claude: supervisor, builders en
  paralelo y la conversación del usuario. Medir antes de un proyecto grande.
