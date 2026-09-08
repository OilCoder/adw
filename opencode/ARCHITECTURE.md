# Arquitectura del sistema codegen (estado real)

**Directriz de diseño:** `CODE_GENERATION_FLOW.md` (flujo, roles, rutas, límites).
**Metodología de admisión de modelos:** `MODEL_SELECTION_SPEC.md`.
**Este documento:** qué de esa directriz está implementado, cómo, y qué no. Se actualiza en el mismo commit que cambia el código. Diagnóstico que motivó la limpieza: `docs/DIAGNOSTICO-2026-09-03.md`. Auditoría pieza a pieza del 2026-09-07: `caso-de-estudio-claude.md` (grupos A a E).

## Flujo ejecutable desde el supervisor

El usuario conversa con el agente `supervisor` (sin `edit`, sin `bash`, sin `task`). Su única vía de ejecución es la tool `codegen_workflow`, que lanza runners deterministas con `node`:

```text
draft        run-goal.mjs --intent        Goal Manager redacta .codegen-goal/goal.json (DRAFT/RESEARCHING/DECIDED)
deliberate   deliberate.mjs               Researcher por pregunta pendiente · advisors + reconciler por pregunta bloqueante con opciones · Goal Manager revisa el Goal
revise       run-goal.mjs --revise        Goal Manager incorpora las respuestas del usuario a preguntas sin opciones
approve      run-goal.mjs --approve       sello determinista, sin modelo; solo tras aprobación explícita del usuario
orchestrate  orchestrate.mjs              Router → Planner → validación (DAG + cobertura del Goal) → PLAN.md → [ruta planificada: PLAN_REVIEW_REQUIRED] → readiness por comprobación (Gate Designer) → Builders en worktrees → cherry-pick a codegen/<run> → Gate final → libro de cobertura
orchestrate  orchestrate.mjs --plan       continúa con el plan que el usuario aprobó (argumento `plan` de la tool)
merge        merge-run.mjs                fast-forward de la rama codegen/<run> sobre la rama del usuario; borra worktrees y rama; solo cuando el usuario lo pide
```

Cada agente corre como `opencode run --agent <rol> --model <configuración certificada para el rol> --format json`. Si el supervisor corre en la TUI de OpenCode **arrancada con `opencode --port 4096`** (sin `--port` la TUI no escucha en ningún puerto), el plugin `.opencode/plugins/codegen-server.js` publica la URL de ese servidor en `.opencode/.codegen-server.json` y los runners se enganchan con `--attach`: las sesiones de los agentes aparecen en la lista de sesiones de la TUI con el nombre `<agente> · <detalle>`. Sin servidor vivo, los eventos se capturan `inline`.

## Tabla de implementación frente a `CODE_GENERATION_FLOW.md`

| Concepto (sección de la directriz) | Estado | Dónde |
|---|---|---|
| Objetivo / Goal (§5.1) | Implementado | `lib/goal.mjs`, `schema/goal.schema.json`, `scripts/run-goal.mjs`, agente `goal-manager` |
| Router determinista (§5.2) | Implementado | `lib/goal-routing.mjs`; direct / planned / deliberative (esta última solo para un Goal sin sellar: el orquestador para con `DELIBERATION_REQUIRED`) |
| El código desmiente el triaje del Goal, solo hacia arriba (§5.2) | Implementado 2026-09-08 (B1) | `plan-validation.mjs` `triageAssessment`: ruta directa con más de un contrato → `route_effective: planned`; riesgo efectivo = máx(declarado por el Planner, suelo de `config/risk-floors.json` sobre `allowed_to_modify`); contradicción → `PLAN_REVIEW_REQUIRED` también en ruta directa, sección "Triage" en PLAN.md, `state.triage`, evento `TRIAGE_CONTRADICTED`. En readiness, `existing_gate: true` con Gate Designer necesario → contradicción informativa. El riesgo efectivo gobierna la admisión de Builder y Gate Designer. Nunca baja una etiqueta aprobada. `architecture_uncertainty` y `external_research_required` no se desmienten |
| Ruta directa (§8.1) | Implementado: el Planner recibe `--route direct` y pide un contrato; si necesita más, la corrida se reencamina a planificada y pausa | `lib/orchestrator.mjs`, `scripts/run-planner.mjs`. Sin tope de intentos: el Builder reintenta mientras el resultado cambie y para por falta de progreso (decisión del usuario 2026-09-08) |
| Ruta planificada, DAG de fases y oleadas (§5.3, §8.2) | Implementado | `lib/plan-validation.mjs`, `scripts/run-planner.mjs`, agente `planner` |
| El plan cubre el Goal (§5.3) | Implementado 2026-09-08 | `plan-validation.mjs` `planCoverage`: cada requisito de contrato lleva `covers`; un `must` sin cubrir o un criterio `automated` sin requisito automatizado que lo cubra rechaza el plan y entra en `PLAN_RETRY`. `should/could` sin cubrir y `must` cubiertos solo por manuales se reportan |
| Plan legible y revisión del usuario (§8.2) | Implementado 2026-09-08 | `lib/coverage.mjs` `renderPlanMarkdown` → `.codegen-plan/<run>.md`; en ruta planificada `orchestrate` para en `PLAN_REVIEW_REQUIRED` antes de crear worktrees y continúa con `--plan`; `PLAN_STALE` si HEAD cambió |
| Ruta deliberativa: investigar, opinar, decidir (§8.3) | Implementado desde 2026-09-03 | `scripts/deliberate.mjs`, `lib/deliberation.mjs`, `run-researcher.mjs`, `run-opinions.mjs`, `run-goal.mjs --revise`; agentes `researcher`, `advisor`, `reconciler` |
| Citas verificadas por recuperación (§3, §5.2) | Implementado 2026-09-08 (B3) | `lib/source-verification.mjs`: cada fuente se descarga (GET, 15 s, 2 MB) y cada hallazgo lleva `quote` que se busca en el texto. DNS/404/410 o título ajeno → `REPORT_INVALID`; 403/429/5xx/timeout/binario o extracto ausente → hallazgo `unverified`, confianza forzada a `low`. Un informe sin hallazgo verificado no responde (`reportAnswers`): `verifyRevision` rechaza completarlo. Veredictos en `report.verification`, rendidos en el `.md`. `--source-verification offline` es solo mantenimiento (rechazado en proyectos instalados). Lo semántico (que la fuente diga lo que el hallazgo afirma más allá del extracto) queda para el Reviewer diferido |
| Decisión técnica vinculante | Implementado: la decisión es `PROPOSED` hasta que el usuario aprueba el Goal que la registra | `lib/opinions.mjs`, `run-goal.mjs --approve` |
| Contrato sellado (§5.4) | Implementado | requisitos con `id`, `kind` (`change`/`preserve`), `verification` (`automated`/`manual`) y `covers`; una comprobación por requisito automatizado en `verification.checks`. `orchestrator.mjs` materializa `.codegen-contract/checks/<id>.sh` y `gate.sh` (`lib/gate.mjs` `materializeGate`) y commitea `.codegen-contract` (forzado si el proyecto lo ignora) |
| Gate Designer (§3, §4) | Implementado, solo cuando una comprobación no está lista | `scripts/run-gate-designer.mjs`; familia distinta de la del Builder; solo escribe bajo `.codegen-contract/checks/`; tocar `contract.json` o `gate.sh` es `SCOPE_FAIL` y readiness se juzga contra el contrato sellado |
| GATE_READY por requisito (§4) | Implementado 2026-09-08 | `gate.checkGateReadiness` corre cada comprobación en el baseline; el esperado se deriva de los requisitos que cubre (`lib/contract.mjs` `expectedBaseline`). Razones `check-passes-on-baseline:<id>` (reparable), `check-fails-on-baseline:<id>` (no reparable). Sigue juzgando solo el código de salida, no la razón del fallo |
| Builder (§5.5) | Implementado | `scripts/run-builder.mjs`, agente `builder`; snapshot de archivos y control de alcance; la verificación controlada corre todas las comprobaciones y deja su resultado por id en la evidencia del reintento |
| Verificación independiente y Gate (§5.6, §5.7) | Implementado | el runner reejecuta las comprobaciones; `lib/final-gate.mjs` sobre la rama integrada, con veredicto por comprobación (`CHECK <id>: PASS|FAIL`) |
| Libro de cobertura del Goal (§5.7) | Implementado 2026-09-08 | `lib/coverage.mjs` `goalCoverage` → `state.goal_coverage` y evento `GOAL_COVERAGE`: por id del Goal, contratos que lo reclamaron, estado y comprobaciones; `manual`/`operational` quedan `PENDING_HUMAN`. Como las oleadas paran al primer fallo, en una corrida completada repite lo que el plan reclamó: su valor es cerrar el ciclo y decir qué no se comprobó a máquina |
| Clasificación del fallo (§4) | Implementado parcialmente | `orchestrator.classifyBuilderOutcome`: reintento con evidencia, `REPLAN_REQUIRED`, `USER_ACTION_REQUIRED`, `ESCALATE`, `BLOCKED`. Retorno automático al Planner tras `REPLAN_REQUIRED`: **no implementado**, la corrida para con evidencia |
| Replan por plan inválido | Implementado | `orchestrator.mjs` (`PLAN_RETRY` mientras los errores cambien; un plan que reproduce los errores de un intento anterior para como `PLAN_FAILED` sin progreso); incluye los rechazos por cobertura |
| Trabajo derivado (§4) | **Diseñado, no cableado** | `lib/derived-work.mjs` clasifica hallazgos; nada lo llama todavía |
| Presupuestos (§9) | Eliminados por decisión del usuario 2026-09-08 | Ni el Goal ni el contrato llevan presupuestos; no existe `config/budgets.json`. El coste se controla en OpenCode y en el proveedor. Todo bucle para por falta de progreso: `attemptSignature` en `lib/orchestrator.mjs` (resultado + comprobaciones fallidas + rutas fuera de alcance) para el Builder, conjunto de errores de validación para el Planner; `record.attempts[].repeats` dice qué intento se reprodujo. `deliberate.mjs` investiga todas las preguntas required pendientes |
| Model Selector por rol, Go antes que Zen, sin cambio automático de modelo (§4) | Implementado | `lib/model-selection.mjs`, `lib/builder-runner.mjs`, `config/model-pools.json`. El orden efectivo es `runner_policies.<rol>`; `economics` del registro no participa |
| Admisión certificada por rol | Implementado, solo mantenimiento | `lib/certification.mjs`, `scripts/certify.mjs` (no se instala); `install.mjs` exige ruta completa. Desde 2026-09-08 la evidencia guarda `schema_hash` del esquema del rol (`roleSchemaHash`); el release check **todavía no lo exige** (ver decisiones) |
| Saldo Zen agotado → parar y pedir recarga (§4) | Implementado | `builder-runner.classifyExecution` → `ZEN_BALANCE_EXHAUSTED` |
| OpenRouter fuera de rutas automáticas (§4) | Implementado; sus configuraciones se retiraron del registro el 2026-09-03 | `tests/config-coherence.test.mjs` lo vigila |
| Reviewer semántico (§3) | **No implementado, diferido a propósito** (2026-09-08) | El hilo de ids convierte la omisión en afirmación visible, no la verifica: un Planner puede reclamar cobertura falsa o etiquetar `preserve`/`manual` un cambio automatizable; eso se ve en PLAN.md en la pausa. Un rol reviewer obliga a certificarlo con corrida real antes de que `install.mjs` vuelva a instalar (atadura A1 → C3); se añadirá cuando toque certificar modelos |
| Merge del resultado | Implementado 2026-09-03 (b1cb1b1) | `scripts/merge-run.mjs`: fast-forward de `codegen/<run>` sobre la rama del usuario, checkout limpio obligatorio, borra worktrees y rama |
| State Recorder (§3) | Implementado | `.codegen-run/<run>/state.json` y `events.jsonl` |

## Artefactos en el proyecto destino

| Ruta | Contenido | Git |
|---|---|---|
| `.opencode/` | agentes, tools, plugin, instrucciones, `codegen/` (lib, scripts, config, schema) | versionado; se actualiza con el instalador y se commitea con el sha del harness |
| `.opencode/package.json` + `node_modules/` | dependencia `@opencode-ai/plugin` | `package.json` versionado, `node_modules` ignorado |
| `.opencode/.codegen-install.json` | manifiesto: hashes, `harness_revision`, `installed_at` | ignorado |
| `.opencode/.codegen-server.json` | URL del servidor de la TUI (plugin) | ignorado |
| `.opencode/codegen/runs/` | eventos y resúmenes de cada agente | ignorado |
| `.codegen-goal/`, `.codegen-research/`, `.codegen-opinions/`, `.codegen-plan/` | Goal y sus versiones previas, informes (con `verification` escrita por el runner), opiniones y decisiones, planes (`<run>.json` + `<run>.md` rendido con cobertura, triaje y ajustes) | ignorados |
| `.codegen-run/<run>/` | worktrees por contrato y rama de integración; `state.json` con `goal_coverage` | ignorado (`.git/info/exclude`) |
| `codegen/<run>` | rama con el resultado | la fusiona `merge` a petición del usuario, o la borra el usuario |

`npm run clean` lista todo lo anterior salvo `.opencode/` y las ramas; con `--yes` lo borra.

## Variables de entorno y flags

- `CODEGEN_DISPLAY`: `inline` o `tui`; sin ella, la tool elige `tui` si hay servidor vivo. `CODEGEN_ATTACH`: URL que la tool pasa a los runners.
- `CODEGEN_FIRST_OUTPUT_SECONDS` (120): un agente sin eventos en ese tiempo se detiene como `LOCAL_RUNNER_ERROR`.
- `CODEGEN_RUNS_DIR`: dónde escribir artefactos (los tests usan un temporal). `CODEGEN_NODE`: binario `node` para la tool.
- `OPENCODE_ENABLE_EXA=1`: lo fija `run-researcher.mjs`.
- Flags de runners: `--display`, `--timeout`, `--plan` (orquestar un plan revisado), `--route direct|planned` (run-planner, lo pasa el orquestador), `--minimum-status` (solo mantenimiento; los proyectos instalados rechazan `candidate`), `--configuration` (solo certificación), `--source-verification fetch|offline` (run-researcher y deliberate; `offline` solo mantenimiento).
- Configuración del sistema en `.opencode/codegen/config/`: `model-pools.json` (registro de modelos), `risk-floors.json` (riesgo mínimo por rutas; editable por proyecto).

## Agentes instalados

`supervisor` (conversación), `goal-manager`, `researcher`, `advisor`, `reconciler`, `planner`, `gate-designer`, `builder`. Todos en `mode: primary` (con `subagent`, `opencode run --agent` cae al agente por defecto), sin `task`, sin `question`; `goal-manager` y `planner` no pueden leer `lib/`, `scripts/`, `config/` ni `tools/` del harness; `gate-designer` solo edita `.codegen-contract/checks/**`.

## Decisiones registradas

- 2026-09-03: `qualified` describe una combinación modelo + proveedor + rol + harness, certificada en este repositorio y publicada por el instalador; `candidate` es solo mantenimiento.
- 2026-09-03: el visor propio (tmux, wt, VS Code, transcripción guiada, extensión) se eliminó; las sesiones de los agentes se muestran en la TUI de OpenCode vía `--attach`. Evidencia del spike en `docs/DIAGNOSTICO-2026-09-03.md` §7.F.
- 2026-09-03: investigación y deliberación quedaron cableadas al supervisor; antes solo las usaban la certificación y los tests. Solo corre la investigación `required`; una pregunta opcional nunca gasta una llamada.
- 2026-09-03: primera orquestación real completa en `las-viewer-v2` (commit `c56a7db`, `scripts/count-las.sh`, autor `OpenCode Codegen`), hoy en la historia de `main` de ese proyecto. Lecciones aplicadas el 2026-09-04: la TUI arrancada sin `--port` dejaba a los agentes en `inline`, y una pregunta de investigación opcional gastaba un Researcher. El criterio de parada anterior ("una orquestación real antes de añadir funcionalidad") quedó cumplido.
- 2026-09-08 (grupo A de la auditoría): A1, A2 y A3 eran el mismo agujero en tres momentos y se cierran con un solo mecanismo, el hilo de ids Goal → requisito de contrato → comprobación → resultado. Lo que compra: la omisión silenciosa pasa a afirmación visible que el código exige completa. Lo que no compra: la veracidad de la afirmación (ver Reviewer). Fuera de alcance: merge automático, tope de intentos en ruta directa, reparación tras un veredicto negativo (grupo D), y "falla por la razón equivocada" en readiness.
- 2026-09-08: `expected_baseline` deja de ser un campo libre. Se deriva del `kind` de los requisitos que cubre cada comprobación; una comprobación que ya pasaba antes del cambio es guarda, no cobertura. Un requisito `manual` no lleva comprobación y se reporta como pendiente de verificación humana; un contrato todo manual se rechaza; un contrato todo `preserve` es refactor puro y se señala.
- 2026-09-08: pausa de revisión del plan solo en ruta planificada (`PLAN_REVIEW_REQUIRED`); la ruta directa sigue de corrido. El Reviewer semántico se difiere hasta la certificación de modelos (C3/C4).
- 2026-09-08: el cambio de forma del contrato deja caducada la evidencia de certificación de `planner`, `gate-designer` y `builder`; además `goal.schema.json` cambió (3857ced, 20:16 UTC del 2026-09-03) después de las dos certificaciones del `goal-manager`, y el grupo B cambia `research-report.schema.json` (`quote`, `verification`), lo que caduca la del `researcher`. Decisión: la evidencia guarda `schema_hash`, y el release check lo exigirá en el commit que traiga la recertificación de esos cinco roles (7 corridas en cuota Go: planner × 2, goal-manager × 2, gate-designer, builder, researcher), nunca antes, para no dejar el instalador bloqueado entre medias. Advisors y reconciler reciben el hash a mano: sus esquemas no han cambiado desde el commit inicial y se certificaron después.
- 2026-09-08 (grupo B de la auditoría): regla común, el modelo propone y el código fija techo o suelo con evidencia propia; cuando no puede juzgar, lo dice y lo pasa al usuario. B1: el triaje se desmiente al validar el plan (forma y riesgo) y en readiness (`existing_gate`), solo hacia arriba, con pausa obligatoria; el Planner gana una salida de la ruta directa que cuesta esa pausa. B2: implementado como techos y suelos en `config/budgets.json` y revertido el mismo día por decisión del usuario (entrada siguiente). B3 (decisión del usuario: marcar con suelo, no rechazar): solo lo probadamente falso invalida el informe; lo no verificable se marca y baja a confianza `low`; un informe sin nada verificado no responde. Los suelos de `risk-floors.json` son heurísticos de arranque, editables por proyecto; una concesión amplia (`src/**`) no dispara un patrón flotante (`**/auth/**`) y se revisa a ojo en PLAN.md.
- 2026-09-08 (presupuestos, decisión del usuario): el sistema no fija presupuestos; el coste se controla en OpenCode y en el proveedor. Se eliminan `budgets` del Goal y del contrato, el `budget` por pregunta de investigación (fuentes sin tope; el investigador usa el timeout de 900 s de los demás roles, ajustable con `--timeout`) y `config/budgets.json`. `max_unplanned_scope_expansion` se va con el objeto; el alcance lo sigue vigilando `allowed_to_modify` (`SCOPE_FAIL`). La parada de los bucles pasa a ser por falta de progreso (directriz §4 y §9.3): un intento que reproduce uno anterior se relanzaría con la misma evidencia, así que para ahí. Lo que compra: ningún tope arbitrario corta a un Builder que avanza. Lo que cuesta: un Builder que alterna resultados distintos sigue gastando hasta repetirse (el conjunto de resultados es finito; el freno real es la cuota del proveedor). El trabajo derivado pierde su presupuesto; su tope de cadena llega con el cableado (grupo D). Recertificación: cambian los esquemas de Goal, plan e informe; la tanda pendiente de 7 corridas ya los cubre.
- 2026-09-08: `commitPaths` (`lib/worktrees.mjs`) dejaba de funcionar cuando un contrato podía modificar un archivo que el Builder no tocó (`git add` fallaba por pathspec sin coincidencias). Corregido: `allowed_to_modify` es permiso, no obligación; solo se añaden rutas presentes o rastreadas. Lo destapó el test de suelos de riesgo (`package.json` permitido y no tocado).
