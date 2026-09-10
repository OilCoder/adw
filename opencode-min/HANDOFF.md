# opencode-min — punto de recuperación (2026-09-09, ~23:20 UTC)

Documento para retomar tras un compact o en otra sesión. Lo esencial primero.

## Qué es

`opencode-min/` es el harness de generación de código para OpenCode que
reemplazó a `opencode/` (7.500 líneas + 3.700 de JSON que nunca llegaron a
llamar a un builder). Se construyó hoy en un día porque el usuario estaba a
punto de abandonar. Tamaño actual: 12 archivos, unas 950 líneas.

```text
idea → supervisor (TUI, OpenAI) escribe preguntas → researchers en paralelo (Go)
     → supervisor escribe plan + contratos + gates → builders en paralelo (Go, sandbox)
     → gate determinista → rama codegen/<run> → el usuario mezcla
```

Archivos: `.opencode/codegen.mjs` (research | build | status | board),
`.opencode/board.mjs` (tablero HTML), `agents/{supervisor,researcher,builder}.md`,
`instructions/codegen.md`, `models.json`, `install.sh`, `smoke.sh`, `tests/fixtures/`.

## Estado del proyecto de prueba: `/home/pokinux/las-viewer-v4`

- Idea: `project/idea.md` (suite web LAS: importar, visualizar, QC, procesar,
  petrofísica, exportar). Datos reales en `data/` (204 MB, commit inicial).
- Corrida `20260909T194543Z-build`, rama `codegen/20260909T194543Z-build`.
- **Corrida cerrada a las 23:30 UTC: 19 de 20 contratos pasaron.**
  `c19-integration` falló tras 6 intentos por contrato mal escrito (anterior
  a las reglas nuevas): `read` con toda la idea, los 11 informes, `src/**` y
  `data/**`; el test exige `lang="es"` en `index.html`, que no está en sus
  archivos permitidos; el gate incluye Playwright sin navegadores instalados.
  Siguiente paso: el supervisor lo divide en contratos pequeños (lang e
  integración; docs de validación y rendimiento; e2e aparte o sin instalar
  navegadores) y `build --resume`.
- Aterrizaje: `node .opencode/codegen.mjs merge` (fast-forward; merge commit
  si el usuario commiteó; `--partial` si quedan contratos). El supervisor lo
  ejecuta solo cuando todo pasó; con pendientes pregunta. Añadido 2026-09-10 00:00.
- Coste de la corrida en Go hasta las 22:00: ~4,6 USD. Supervisor: 0 (suscripción OpenAI).

## Lo que se aprendió hoy (cada uno costó una vuelta real)

1. **OpenCode toma la raíz del proyecto de `$PWD`, no del cwd real.** Sin
   `env: { PWD: cwd }` el builder edita el árbol del usuario. Cuatro
   iteraciones hasta encontrarlo. Ya corregido; memoria `opencode-pwd-project-root`.
2. **Sandboxes = repo git fresco exportado con `git archive`**, fuera del
   repo. Worktrees y clones no sirvieron (por el punto 1, en realidad), pero
   el diseño actual es robusto: el diff se aplica como commit en una rama
   `codegen/<run>-<id>` y se mezcla en la rama de integración.
3. **`npm ci` en el sandbox antes del gate base**: sin dependencias, el gate
   base falla "por la razón equivocada" y enmascara gates rotos.
4. **`--resume`**: continuar la misma corrida en su rama de integración,
   conservando lo que pasó y mezclando los commits nuevos del usuario. Sin
   esto el supervisor intentaba hacer `git merge` por su cuenta.
5. **Reglas del supervisor añadidas** (una frase cada una, no maquinaria):
   gates independientes del scaffold; `read` ≤ 5 archivos, nunca la idea ni
   informes enteros; diagnosticar fallos leyendo `.codegen/runs/` y
   sospechar del test si varios modelos fallan igual; nunca mezclar; usar
   `--resume`; rechazar informes de research malos.
6. **Los tres fallos reales fueron de contrato/test, ninguno de builder**:
   vitest.config sin incluir los acceptance tests; test que pedía 80 curvas
   cuando el LAS tiene 84; selectores ambiguos en un test de UI. El
   supervisor, con la regla nueva, diagnosticó los dos últimos solo.
7. **Modelos**: glm-5.3-flash (el más barato) pasó 12 de los primeros 14
   contratos. La calidad del contrato pesa más que el modelo.

## Escalera de modelos (diseño acordado e implementado)

- `models.json`: builders y researchers Go ordenados por precio, listas
  separadas, editadas a mano. `max_models_per_item: 3`, dos intentos por peldaño.
- Memoria por proyecto en `.codegen/models-state.json`: un fallo cuenta solo
  si otro modelo pasó después ese mismo ítem; al segundo fallo confirmado el
  modelo va al final de la escalera para ese proyecto. `status` lo muestra.
- Research: el juez es el supervisor, con `research --reject <id>` (aparta
  el informe, cuenta el fallo, relanza con el siguiente peldaño).
- Probado en fixtures: degradación, resume, reject.

## Tablero (v2, 2026-09-10 01:00)

`node .opencode/codegen.mjs board [--watch]` escribe `.codegen/board.html`.
Pestañas: Ahora (franja de fase: investigando / construyendo / supervisor
trabajando / te espera / parado; "corriendo ahora"; diario con ● contratos,
■ research, ◆ mensajes del usuario y preguntas del supervisor), Contratos
(grafo + tablero con coste), Research (por tanda), Modelos y coste.
Fuentes: `.codegen/journal.jsonl` (el script lo escribe en cada evento),
`report.json`, `research/status.json`, `runs/current*.json`, y la base de
datos de OpenCode en solo lectura vía `opencode-db.mjs` (node:sqlite):
última acción del supervisor, mensajes del usuario, coste por sesión.
`--watch` refresca cada 10 s indefinidamente. El diario empieza hoy a las
00:55; lo anterior solo está en los logs. Artifacts de diseño:
https://claude.ai/code/artifact/3aac6a39-baa4-4374-a866-72e2b94ff4a1

## Estructura (2026-09-10 02:30)

Filosofía de orden común a todos los proyectos en
`.opencode/instructions/structure.md` (carpetas fijas `.opencode/ .codegen/
docs/ wiki/ data/`, ocho principios). Por proyecto, el supervisor escribe el
mapa `.codegen/structure.md` (sección `## Folders` con bullets `- \`patrón\``;
`## Repeated names allowed`) y el usuario lo aprueba con el plan. El script
exige el mapa para construir, valida que cada `allowed_to_modify` quepa en él,
da veredicto `STRUCTURE` (fuera del mapa, archivo provisional, nombre
duplicado) y `node .opencode/codegen.mjs structure` audita el árbol actual.
En las-viewer-v4 el mapa ya existe y la auditoría marca 13 archivos
(`src/test` → `tests/`, `ProjectTree` duplicado, un `.tmp`): pendiente una
tanda de reordenación planificada por el supervisor.

## Pendiente / siguiente

- Cerrar c19 y que el usuario pruebe la app generada.
- `opencode-min/` está **sin commit** en `claude-project-base` (el usuario
  decide cuándo). `las-viewer-v4` tiene sus commits de sello.
- Siguiente proyecto de prueba: pendiente de decidir. Preocupación del
  usuario: de dónde salen los datos. Fuentes de su nota de research
  (KGS, Texas RRC, OPM opm-data, SPE11, F3, OpenFWI, GDR) sin verificar hoy.
  Alternativa válida: datos sintéticos generados por el propio proyecto.
- Ideas descartadas hoy: seguir agentes en la TUI vía `--attach` (poco
  práctico); readmitir admisión automática por benchmarks (no).

## Cómo retomar

```bash
cd /home/pokinux/las-viewer-v4 && node .opencode/codegen.mjs status
```

Y en la TUI de OpenCode, al supervisor: "resume el estado y dime qué falta".
