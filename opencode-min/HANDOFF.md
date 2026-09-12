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
- `opencode-min/` está **sin commit** en `adw` (el usuario
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

## Research: bucle de relanzamientos corregido (2026-09-10 16:00)

Síntoma en las-viewer-v5: `net-pay` dio tres vueltas idénticas. El supervisor
lanzaba `research` en primer plano; el shell de la TUI mata el comando a los
15 min, justo cuando el segundo modelo (kimi-k3) llevaba 5 min; al relanzar,
el script no recordaba el TIMEOUT de qwen3.8-max y empezaba por él otra vez.
Los rechazos del supervisor eran correctos (fórmula mal, informe truncado).

Cambios (unas 30 líneas netas, sin archivos nuevos):
- `research` y `build` se desacoplan del shell por defecto; `--wait` los deja
  en primer plano (smoke.sh lo usa). `--background` desaparece.
- `research` se niega a arrancar si hay una corrida viva (misma guarda que merge).
- TIMEOUT / NO_REPORT se guardan en `rejected` del status: esos modelos se
  saltan para esa pregunta en corridas posteriores. Escalera vacía = `NO_MODELS`.
- DONE solo si el modelo cerró con `DONE <path>` dentro del tiempo; archivo
  cortado o sin cierre = PARTIAL (antes se daba por DONE, p. ej. `CONTINUA-2`).
- Fallos confirmados: un ítem cuenta una vez por modelo; rechazar un informe
  deshace las confirmaciones que ese pass había dado. `models-state.json` de
  v5 borrado (estaba inflado: 7 fallos con 4 preguntas).
- Researcher: cada sección con su propio edit, nunca el informe entero en una
  escritura. Supervisor: PARTIAL/TIMEOUT → aceptar o dividir la pregunta en
  ids nuevos en paralelo; nunca repetirla igual con un modelo más caro.
Probado con un `opencode` stub (timeout, parcial, reject/undo, escalera
vacía, guarda de concurrencia). Sin commit; el usuario decide.

## Revisión a tres lentes y recorte (2026-09-10 17:00)

Tres agentes (agrupar estados / quitar / dónde vive cada regla) sobre el
harness y las corridas reales de v4 y v5. Conclusión común: ni colapsar
estados ni cortar por cortar; la palanca es la señal que el script da al
supervisor y las reglas de flujo que solo eran texto (se ignoraron siempre).
Aplicado, neto ~45 líneas menos:
- DONE solo si el researcher cerró con `DONE` en la última línea, en tiempo
  y por debajo de su tope de pasos (`steps:` del front matter). Antes tres
  informes de v5 cortados a 30 pasos pasaron por DONE.
- `status` imprime las últimas palabras de cada PARTIAL (qué faltó).
- Negativas nuevas del script: `--reject` de un PARTIAL o tercer rechazo →
  "divide la pregunta en ids nuevos"; `build` con corrida viva; contrato con
  `read` de glob, idea, informe de research o más de 5 archivos.
- Memoria de modelos eliminada (`models-state.json`, degradación, undo,
  columna del tablero, párrafo de status, `demote_after_confirmed_failures`).
  Su única acción real fue un falso positivo (degradó a glm-5.3-flash por dos
  PARTIAL de qwen). Sustituto: `models.json` a mano; `status` muestra quién
  cerró cada ítem.
- Regla de crecimiento (README y principio 9 de structure.md): nada nuevo sin
  un fallo concreto que lo pida ni sin quitar algo; aplica a los proyectos.
Descartado: cortar el tablero (es el control del usuario); colapsar estados
(10 líneas de ganancia). Pendiente para después: partir `buildOne` en
preparar / intentar / aterrizar; fixture de eventos `--format json` congelado
como prueba de regresión (runAgent y opencode-db.mjs dependen de superficies
privadas de OpenCode que fallarían en silencio).

## Avisos al supervisor + gate roto (2026-09-10 19:30)

- El supervisor es un turno de chat: entre turnos nadie está despierto y el
  usuario era quien notaba cada parada. Ahora el script le escribe con
  `opencode run --attach http://127.0.0.1:$OPENCODE_PORT --session <id>`
  (puerto 4096 por defecto, la sesión sale de la BD como en el tablero) en
  cuatro momentos: pregunta que termina sin DONE, fin de research, contrato
  con FAIL definitivo, fin de build. Mensajes `[codegen] …`; diario y
  tablero los muestran (◆ "Aviso al supervisor"); sin servidor o sin sesión
  se anota "no entregado" y nada más. Probado extremo a extremo con un
  servidor en 4097: el supervisor recibió el PARTIAL, dividió la pregunta y
  relanzó solo.
- Gate roto: si el propio test del gate no compila (error localizado bajo
  `.codegen/`), el contrato para al primer intento con "GATE BROKEN". Sobre
  las 31 fallas de gate de v4+v5 marca solo las 6 de c11 (habría ahorrado 5
  intentos, ~70 min). Descartado el corte "misma aserción con dos modelos":
  habría cortado c12, que deepseek pasó al 5º intento.
- Tablero: ancho completo, pestaña recordada entre recargas de Live Preview,
  research en una sola tabla, modelos separados builder/researcher, coste
  por modelo arreglado (OpenCode guarda `{"id":…}`, no `modelID`).
- Reglas al supervisor: mientras la corrida vive, vigilar status y dejar
  corregido el contrato fallado; nunca cerrar un turno anunciando trabajo;
  los mensajes `[codegen]` son del script y se actúa sobre ellos.

## Contexto del supervisor (2026-09-10 20:00)

Medición de la sesión de v5: pico 281k tokens, compactación automática ya
disparada (OpenCode compacta a 252k con gpt-5.6 por suscripción: ventana
400k − 20k reservados; no es un porcentaje, y el 50-55 % de la TUI no se
confirmó en el código). 75 % del gasto: informes de research leídos enteros
y residentes 60 turnos; logs de 12k leídos enteros porque el prompt pedía
`tail` y los permisos solo dejaban `cat`. Ajustes:
1. `opencode.json`: `compaction.prune: true` (OpenCode borra salidas viejas
   de herramientas del contexto). Cero código.
2. Informe con `## Summary for contracts` obligatorio (≤40 líneas, primero);
   sin él es PARTIAL. El supervisor juzga el cuerpo una vez al llegar y
   después trabaja solo con el resumen y `grep`.
3. Permisos del supervisor: `head`, `tail`, `sed -n`, `grep`.
4. Los avisos `[codegen]` llevan la línea de estado (`buildLine`) y ya no
   dicen "ejecuta status"; `status` empieza con esa línea y perdió las 8
   líneas de log (están en el tablero).
Descartado: supervisor por fases con sesión nueva y archivo de traspaso; no
hay fallo que lo pida. Medir el pico en el próximo proyecto.
Regla de higiene: todo comando que un prompt cite debe estar en los permisos
del agente, y al revés; si se contradicen, el modelo improvisa en silencio.

## Sandboxes Python (2026-09-10 21:35)

reservoir-sim: c01 falló 6 veces con "No module named pytest". El sandbox
solo instalaba dependencias de Node (`npm ci`); el python del sistema no
tiene pytest ni scipy. Ahora, si hay `pyproject.toml` o `requirements.txt`,
el sandbox crea `.venv` con `uv` (`pip install -e .[dev]`, o `-r
requirements.txt`, más pytest) y gate y builder reciben `PATH` con ese venv
primero. Probado sobre una copia de reservoir-sim: uv en 3 s, gate base falla
por la razón correcta, el builder ve pytest 9.1. `.venv` y `.egg-info` van
al filtro de basura de `changedFiles`. Lección repetida del día 1: sin
dependencias el gate base falla "por la razón equivocada".

## Gate roto, generalizado (2026-09-10 21:45)

v5: el supervisor partió c24 en tres contratos de typecheck por dominio, pero
el sandbox no tiene `@types/react` (no está en el lock) y `tsc` da 936
errores en `src/app` y `src/design`; 18 intentos con el mismo fallo fuera
de alcance. El detector ahora cubre dos formas: (a) el test del gate no
compila (error bajo `.codegen/`); (b) un type checker reporta errores y
todos están fuera de `allowed_to_modify`. Se descartó "cualquier ruta fuera
de alcance": un "Cannot find module X imported from <test>" señala el test
pero se arregla creando X (c12 y c47 pasaron así). Replay sobre 42 fallas de
gate de v4+v5: marca solo los 18 de typecheck, ninguno que luego pasó.

## Punto de recuperación (2026-09-10 22:35, antes de compact)

### Harness (sin commit en adw; el usuario decide)
`codegen.mjs` 705 líneas. Cambios del día ya descritos arriba, más:
- Sandboxes Python: venv con `uv` (`pip install -e .[dev]` o `requirements.txt`, más pytest); gate y builder ven el venv primero en PATH.
- Gate roto generalizado: (a) test del gate no compila bajo `.codegen/`; (b) type checker con todos los errores fuera de `allowed_to_modify` → FAIL al primer intento "GATE BROKEN". Replay 42 fallas v4+v5: solo los 18 de typecheck.
- Supervisor: **no vigila**; termina el turno y espera los `[codegen]` (fallo definitivo, fin de research/build, pregunta sin DONE); `status` solo si el usuario lo pide o pasa una hora. Motivo: 15 polls × 200k contexto = 3M tokens; el usuario agotó la cuota de OpenAI con tres supervisores.
- Tablero: pestaña y scroll horizontal del grafo sobreviven a recargas; research en una tabla; modelos separados builder/researcher; coste por modelo arreglado (`{"id":…}`).
- Regla de crecimiento (README, `structure.md` principio 9, supervisor y builder).
- Verificación en las ideas = **referencias recomendadas**, sin listas de tests: el supervisor deriva los tests contrato por contrato.

### Proveedores y modelos (medido hoy)
- OpenCode Go es **suscripción con cuota** (semanal 103 %, mensual 81 % al final del día) y luego saldo: el usuario cargó 20 USD y gastó 11. Los precios del tablero son reales solo cuando la cuota está agotada.
- `ox-alpha-free` (Go): muerto, error de servidor siempre. `muse-spark-1.3-contributor` (Go y Zen): requiere opt-in en https://opencode.ai/workspace/wrk_01M1J0CSDBSWV9MA2GEYFCM46D/go; el usuario lo activó y responde.
- **mimo-v2.5** (Go, 0,14/0,28): 19 de 28 intentos cerrados en prodpipe vs 15/28 de glm-5.3-flash; código limpio (revisado un módulo). Puesto de primer peldaño en reservoir-sim y prodpipe.
- Zen gratis, con la credencial ya existente en la cuenta: responden mimo-v2.5-free, big-pickle, nemotron-3.5-lightning-free, muse-spark-1.3-contributor-free; no responden en 90 s nemotron-3-ultra-free, ling-3.0-flash-fin-free. Sin datos de calidad todavía.
- Cambiar de proveedor son dos archivos del proyecto (`models.json`, `opencode.json`); el harness no distingue.

### Proyectos (todos con harness idéntico a opencode-min)
| Proyecto | Estado | Modelos | Siguiente |
|---|---|---|---|
| las-viewer-v5 | 39/40, falla `29-release-root` | Go | supervisor lee el aviso, diagnostica, `--resume` |
| reservoir-sim | 10/18, fallan c08 BL, c09 five-spot, c09 gravedad; 5 detrás | Go, mimo primero | ídem; fallos numéricos, los interesantes |
| prodpipe | 49/50, falla `50-product-verification` | Go (muse, mimo, hy3, deepseek-v4.1, qwen3.5-plus, longcat) | ídem |
| facies-ml | sin arrancar; idea y datos listos (Parquet 99 MB versionados) | Zen gratis ×4 | prompt de arranque (idea.md como índice, decisiones cerradas, research solo "por confirmar", plan antes de construir) |
Ideas en `wiki/idea/` (idea, modelo, verificacion, requisitos, datos, decisiones, glosario); `project/` ya no se usa.
Puertos: cada TUI con `OPENCODE_PORT=N opencode --port N`; los avisos van al puerto de la variable. 4097 y 4098 ocupados por TUIs anteriores.

### Pendiente
- Commit de opencode-min en adw.
- Medir el pico de contexto del supervisor en el próximo proyecto (antes 281k) y el ciclo fallo → resume.
- Revisión de calidad mimo vs glm sobre prodpipe cuando cierre.
- Después, no ahora: partir `buildOne` (preparar/intentar/aterrizar), unificar el bucle de escalera duplicado, fixture de eventos `--format json` congelado.

## Idea, auditorías y cambios (2026-09-11)

Investigación con dos agentes sobre herramientas spec-driven (spec-kit,
OpenSpec, Kiro, BMAD, Tessl, 13 en total): ninguna se adopta. La evidencia
independiente (Scott Logic, Instil, Böckeler) mide 10× más lento y varios
múltiplos de coste por los artefactos generados; el único valor medido es
la fase de interrogatorio. La idea de siete archivos ya cubre más que
cualquiera (datos verificados y glosario no existen en ninguna). Préstamo
de OpenSpec sin OpenSpec: delta sobre la idea viva. Solo prosa, sin código:
- `instructions/idea.md` nuevo: qué va en cada uno de los siete archivos,
  qué se congela, quién lo llena.
- `structure.md`: `wiki/` con tres subcarpetas fijas `idea/`, `audits/`,
  `changes/`.
- Supervisor: fase idea antes de research (pregunta solo decisiones de
  producto; los hechos van a research); bucle de cambios (audit notes o
  petición → `wiki/changes/<name>/{proposal,delta}.md` → ciclo normal →
  tras `merge` aplica el delta a `wiki/idea/` y archiva). Absorbe la frase
  suelta de "change request" del paso 2 (regla de crecimiento). Permiso
  `edit` ampliado a `wiki/**`: sin él las instrucciones eran texto muerto.
  `project/idea.md` → `wiki/idea/**`.
- `install.sh`: ignora `wiki/audits/*/audio.*` (los sandboxes son
  `git archive` del árbol entero).
Solo en opencode-min; las copias de facies-ml, reservoir-sim, prodpipe y
las-viewer-v5 no se tocaron (tres con corridas vivas). Nuevo proyecto
`/home/pokinux/voice-audit` (Windows, faster-whisper large-v3, capturas
insertadas en el texto, salida en `wiki/audits/` del proyecto auditado):
`idea.md` y `decisiones.md` escritos; faltan los otros cinco.

## Tiempo por modelo en el tablero (2026-09-11)

Pedido del usuario: comparar modelos también por duración, no solo coste
(en Zen gratis el coste es 0). La BD de OpenCode ya guarda `time_created` y
`time_updated` por sesión: `agentCosts` suma `ms` por rol y modelo y la
tabla de modelos añade "Tiempo" (total) y "Por sesión" (media). Sin estado
nuevo. Copiado a voice-audit; pendiente en los demás proyectos.

## las-viewer-v5: cambio `wire-analysis-and-tracks` (2026-09-11)

Revisión del usuario: la app es importador + visor de una pista + export.
Dos agentes confirmaron: `AnalysisWorkspace.tsx` (2 161 líneas, cinco
paneles) huérfano; sin presets de pistas (la pista por defecto es DEPT
contra DEPT); readout sin formatear en el flex de la pista → salta el
layout; cinco gates Playwright con `--list`; CI e2e en `main` con repo en
`master`; sin iconos. Escrito `wiki/changes/wire-analysis-and-tracks/`
(proposal, delta, prompt con 11 contratos: 4 de orden, 1 de e2e real, 6
de funcionalidad incl. `lucide-react` + color por dominio). Harness de
prosa actualizado en ese proyecto; sin commit. Lección para el supervisor
(ya en las reglas del prompt, falta pasarla a supervisor.md de
opencode-min): un contrato de integración se prueba a través de `App` o
navegador real, nunca importando el componente; `--list` no es gate.

## Avisos "entregados" a nadie (2026-09-11 16:00)

las-viewer-v5: el build terminó 0/14 y el supervisor no se enteró. Su TUI
arrancó sin `--port`; el aviso fue al 4096 por defecto, donde nadie
escucha, y el diario lo marcó `delivered: true` porque solo comprobaba que
existiera una sesión de supervisor. Ahora `notify` abre el puerto
(`/dev/tcp`) antes de enviar; sin oyente anota `delivered: false` con la
razón y el comando para arrancar la TUI bien; el tablero lo muestra.
Regla para el usuario: cada TUI con `OPENCODE_PORT=N opencode --port N`,
puertos 4097 reservoir-sim, 4098 prodpipe, 4099 facies-ml, 4100
voice-audit, 4101 las-viewer-v5 (nueva).

## board.json y plantillas de modelos (2026-09-11 19:30)

Para project-garden (nuevo proyecto, idea en `/home/pokinux/project-garden/wiki/idea/`,
maqueta https://claude.ai/code/artifact/670d245c-18a9-4475-b2b2-bba6748f6d6a):
- `board.mjs` parte `renderBoard` en `boardData` (hechos) + `renderBoard` (HTML)
  + `boardJson` (los mismos hechos, planos). `writeBoard` escribe
  `.codegen/board.json` junto al HTML en cada evento; `merged` sale de
  `git merge-base --is-ancestor <integración> <rama usuario>`. Campos:
  phase, alive, researchAlive, waiting, build{run,passed,total,failed,
  gateBroken,pending,running,integration{branch,merged},closedBy},
  research{total,done,partial,rejected,alive}, cost, supervisor{sessionId,
  lastAt,lastKind}, lastNotify{at,text,delivered,port,reason}, updatedAt.
  `.codegen/board.json` en `.gitignore` (install.sh y los seis proyectos).
- `templates/models.pago.json` y `models.gratis.json`: escaleras de
  referencia; Garden las copia al crear un proyecto (la tercera, experimental,
  la genera Garden desde el catálogo de OpenCode: modelos nunca usados).
- `install.sh` ya preservaba `models.json`; Garden lo usa para "Actualizar harness".
Copiado a los seis proyectos. Sin commit. reservoir-sim ya está mezclado
(`merged: true`), el usuario lo hizo desde su TUI.

## El merge pedía un commit al usuario (2026-09-11 20:30)

Síntoma repetido en cada proyecto: `merge` se negaba por "árbol sucio", el
usuario commiteaba y el supervisor repetía (un turno de supervisor
desperdiciado por proyecto). Causa: `.codegen/journal.jsonl` estaba en git
(el sello lo commiteaba) y el script lo reescribe en cada evento. Ahora el
diario está en `.gitignore` (install.sh y los seis proyectos, sacado del
índice con `git rm --cached`), y ni la guarda de `merge` ni el sello lo miran;
`board.json` igual. Pendiente en cada proyecto: commitear la salida del
índice junto con el resto (lo hace el sello del próximo build).

## Higiene sin cambio de comportamiento (2026-09-12)

Ver README "Files" y "Behaviour freeze". Resumen:
- `tests/check.sh` (17 s, sin modelos): sintaxis, lint prompt/permisos, tablero
  golden (4 estados, HTML byte a byte) y 22 escenarios golden con un `opencode`
  falso (`tests/fake-opencode/`). Los golden se generaron con el código de v1 y
  cada fase se verificó contra ellos.
- Fases: prettier (printWidth 110) → `codegen.mjs` partido en `agent.mjs` +
  `sandbox.mjs` (la escalera duplicada es un `climb()`) → tablero en `board.mjs`
  (datos) + `board-html.mjs` (una función por sección) + `board.css`.
- Cambios funcionales del mismo día, antes de la higiene: escalera con 5 Zen
  gratis delante; guarda models.json ↔ whitelist; `hidden` fuera; supervisor
  relee contratos y usa `--parallel 8`; marca "written in one go" en research.
- Pendiente: reestructurar `supervisor.md` (ronda aparte), rediseño del tablero
  sobre `board-html.mjs`/`board.css` (regenerar golden con `--update`), y
  actualizar los seis proyectos de campo cuando el usuario lo decida.

## Tablero v2 (2026-09-12, tarde)

Rediseño aprobado en `new-style/board/proposal.html` (maqueta interactiva) a
partir de cuatro mockups de Codex en la misma carpeta. Implementado en
`board-html.mjs` + `board.css`; datos nuevos en `board.mjs` (cuota Go por
HTTP con caché, Markdown de informes, fecha de tanda) y `opencode-db.mjs`
(título y slug de la sesión del supervisor; los avisos `[codegen]` ya no
cuentan como mensajes del usuario). `board.json` gana `supervisor.title`,
`supervisor.slug` y `quota`. Golden del tablero regenerado; los golden de
escenarios aíslan `HOME` (sin BD ni auth). Verificado en navegador sobre
las-viewer-v5: cuatro pestañas, ventana emergente, informe renderizado,
camino iluminado, cuota real.
