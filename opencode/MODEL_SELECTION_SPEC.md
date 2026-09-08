# Especificación del observatorio para seleccionar modelos

**Estado:** especificación conceptual final<br>
**Última revisión de fuentes:** 2 de septiembre de 2026

## 1. Alcance

Este documento define un sistema para seleccionar modelos usando **métricas publicadas por páginas fiables**, normalizarlas y calcular qué configuraciones son suficientemente capaces y económicamente convenientes para cada trabajo.

El sistema no ejecutará benchmarks locales. Su función será:

1. recopilar resultados públicos actuales;
2. evaluar la fiabilidad y comparabilidad de cada dato;
3. descartar configuraciones que no demuestren la capacidad mínima necesaria;
4. calcular eficiencia, costo esperado y riesgo de fallback;
5. mantener varios candidatos por tipo de trabajo;
6. detectar cuándo añadir, vigilar o retirar una configuración.

La unidad observada es:

```text
configuración = modelo + proveedor + harness + esfuerzo/parámetros + fecha

registro comparable = configuración + benchmark + versión del benchmark
```

Si una fuente no identifica esos elementos, el dato pierde confianza y no debe mezclarse como si fuera equivalente.

---

## 2. Principios

1. **Capacidad antes que precio.** Tokens baratos que no resuelven trabajo no son eficientes.
2. **Admisión por mínimos, no por posición.** Un leaderboard filtra candidatos; su número uno no gana automáticamente.
3. **Varios modelos por nivel.** Cada trabajo puede tener un pool de configuraciones aptas.
4. **Un modelo puede cubrir varios niveles.** Importan las capacidades demostradas, no etiquetas rígidas.
5. **Costo por resultado.** El precio por millón de tokens es una entrada, no la conclusión.
6. **No mezclar resultados incompatibles.** Harness, esfuerzo, versión y proveedor deben controlarse.
7. **Fuentes independientes primero.** Los resultados del fabricante son evidencia secundaria.
8. **Un dato ausente no vale cero.** Se marca como desconocido y reduce la confianza.
9. **No inventar precisión.** Las estimaciones deben distinguirse de las mediciones.
10. **Todo dato caduca.** Capacidad, precio, velocidad y disponibilidad llevan fecha.
11. **No compensar requisitos críticos.** Una gran puntuación en razonamiento no compensa tool calling insuficiente para un Builder.
12. **Comparar costos dentro de la misma clase de tarea.** Un dólar por issue de SWE-bench no equivale a un dólar por ejercicio de Aider o Terminal-Bench.

---

## 3. Pools de trabajo

### Builder / Coder

Debe demostrar que puede editar código existente, seguir instrucciones, resolver bugs, trabajar en varios archivos, usar terminal, ejecutar tests, recuperarse de errores y evitar cambios innecesarios.

Fuentes prioritarias: Aider Polyglot, SWE-bench Verified, SWE-bench Bash-Only, SWE-bench Multilingual, Terminal-Bench y pruebas de compatibilidad con OpenCode.

### Engineer / Planner

Debe demostrar comprensión de repositorios, descomposición de fases, identificación de dependencias y riesgos, selección de contexto, definición de criterios de aceptación y reacción correcta ante fallos.

Fuentes prioritarias: SWE-bench, Terminal-Bench, benchmarks agentic de ingeniería, razonamiento aplicado a código, contexto efectivo y tool calling.

### Researcher / Project Planner

Debe demostrar búsqueda, selección de fuentes, comprensión documental, verificación de vigencia, factualidad, citas, síntesis y planificación técnica.

Fuentes prioritarias: benchmarks independientes de deep research, búsqueda, factualidad, citas, seguimiento de instrucciones y contexto largo. Los benchmarks de código pesan poco aquí.

### Orchestrator

Debe demostrar clasificación de tareas, routing, selección de herramientas y contexto, interpretación de resultados, control de fallback y presupuesto, prevención de bucles y escalamiento correcto.

Fuentes prioritarias: Terminal-Bench, tool use, benchmarks agentic de larga duración, seguimiento de instrucciones, routing, contexto largo y estabilidad operacional.

---

## 4. Fuentes y función

| Fuente | Qué aporta | Roles | Precaución |
|---|---|---|---|
| [SWE-bench Verified](https://www.swebench.com/verified.html) | Issues reales resueltos | Builder, Engineer | Revisar harness, intentos y presupuesto |
| [SWE-bench Bash-Only](https://www.swebench.com/verified.html) | Modelos bajo el mismo mini-SWE-agent y entorno bash | Builder, Engineer | Registrar la release: 1.x y 2.x no son necesariamente comparables |
| SWE-bench Multilingual | Ingeniería en varios lenguajes | Builder, Engineer | Revisar cobertura por lenguaje |
| [Aider Polyglot](https://aider.chat/docs/leaderboards/) | Código, edición y cumplimiento del formato de edición | Builder | Son ejercicios delimitados; no una fase completa de repositorio |
| [Terminal-Bench](https://www.tbench.ai/) | Terminal, tools y autonomía | Builder, Engineer, Orchestrator | Registrar versión y agente; sensible al harness y con antecedentes de gaming |
| LiveCodeBench | Algoritmos y código reciente | Builder, Engineer | Poco parecido a editar repositorios |
| BigCodeBench | Código con APIs y librerías | Builder | Menos agentic |
| HumanEval / MBPP | Funciones pequeñas | Builder | Saturados y poco representativos |
| SWE-Lancer | Tareas con valor económico | Builder, Engineer | Revisar comparabilidad |
| [Artificial Analysis](https://artificialanalysis.ai/) | Evals propios, precio, velocidad, latencia y comparación de endpoints | Todos | No convertir su índice agregado en una verdad única |
| OpenRouter | Precio, contexto, proveedor y disponibilidad | Todos | No mide calidad |
| OpenCode Zen | Catálogo curado, precio y compatibilidad proveedor/harness | Builder, Engineer, Orchestrator | La curación es evidencia del proveedor; cada configuración aún requiere admisión directa |
| Benchmarks de research | Búsqueda, citas y síntesis | Researcher, Orchestrator | Preferir conjuntos auditables y recientes |

Una fuente perderá peso si deja de actualizarse, cambia su metodología sin continuidad o presenta problemas de integridad.

En la revisión de 2026, Artificial Analysis también expone evaluaciones útiles fuera del coding puro —como trabajo agentic de larga duración, análisis de documentos, factualidad y precisión por endpoint— que pueden aportar evidencia para Researcher, Orchestrator y proveedor. Deben capturarse como métricas separadas, no fundirse automáticamente con su índice general.

---

## 5. Fiabilidad de la evidencia

| Nivel | Evidencia | Uso |
|---|---|---|
| A | Independiente, metodología pública, configuración identificada y resultado reciente | Puede sostener admisión |
| B | Agregador independiente con enlaces verificables | Puede sostener admisión con confirmación |
| C | Resultado del fabricante con metodología reproducible | Descubrimiento y apoyo secundario |
| D | Anuncio o resultado sin configuración suficiente | Solo señal |
| E | Opiniones y pruebas anecdóticas | Contexto cualitativo; fuera del cálculo principal |

Una configuración no entra a un pool importante basándose solamente en evidencia C, D o E.

---

## 6. Datos a capturar

```yaml
identity:
  model_name:
  model_version:
  provider:
  harness:
  effort_level:
  benchmark_name:
  benchmark_version:
  result_date:
  source_url:
  source_tier:
  source_record_id:
  retrieved_at:
  extraction_method:

quality:
  swe_bench_verified:
  swe_bench_bash_only:
  swe_bench_multilingual:
  aider_polyglot:
  aider_correct_edit_format:
  terminal_bench:
  livecodebench:
  long_horizon_agent_score:
  document_analysis_score:
  factuality_score:
  endpoint_accuracy_score:
  research_score:
  tool_use_score:
  instruction_following_score:

economics:
  input_price_per_million:
  output_price_per_million:
  cached_input_price_per_million:
  reported_cost_per_task:
  reported_cost_value:
  reported_cost_scope:
  reported_tokens_per_task:
  context_window:
  max_output_tokens:
  tokens_per_second:
  time_to_first_token:
  availability:
  rate_limits:
  pricing_currency:
  pricing_unit:

data_quality:
  independent_result:
  same_harness_comparable:
  attempt_budget_known:
  token_usage_known:
  provider_known:
  exact_version_known:
  sample_size:
  successes:
  attempts:
  confidence_interval:
  methodology_version:
  parser_status:
  confidence_notes:
```

Los precios deben guardarse como snapshots históricos. `reported_cost_scope` debe indicar si el costo corresponde a una tarea, a toda la suite, a una ejecución o a otra unidad. `source_record_id` debe permitir rastrear cada cifra hasta su fila, submission o entrada original. `parser_status` permite detectar que una página cambió de estructura antes de aceptar datos incompletos o mal extraídos.

---

## 7. Normalización

Primero se comparan resultados dentro del mismo benchmark, versión y harness.

```text
comparación fuerte   = mismo benchmark + harness + presupuesto + fecha cercana
comparación moderada = diferencias documentadas y controlables
comparación débil    = benchmarks o harnesses distintos
```

Para combinar señales, cada benchmark se normaliza dentro de su cohorte comparable. Puede usarse percentil o min-max robusto:

```text
normalized_score =
  (model_score - cohort_p10) / (cohort_p90 - cohort_p10)
```

El valor se limita a `[0, 1]`. No deben sumarse porcentajes originales de benchmarks distintos como si midieran lo mismo.

La normalización solo facilita lectura y comparación relativa. **No convierte dos benchmarks diferentes en la misma unidad** ni autoriza a mezclar sus costos por tarea.

Cada métrica tendrá un factor de confianza:

```text
confidence_factor =
  source_factor
  × recency_factor
  × comparability_factor
  × completeness_factor
```

Valores iniciales orientativos: A `1.00`, B `0.90`, C `0.70`, D `0.40`; E queda fuera del cálculo. Deben calibrarse posteriormente. El factor de confianza nunca debe aumentar una métrica ni sustituir un requisito obligatorio: sirve para expresar cuánta confianza tenemos en ella.

### Incertidumbre estadística

Cuando estén disponibles el número de tareas, repeticiones o intervalos de confianza, deben conservarse. Dos resultados cercanos no se tratarán como distintos si sus intervalos se solapan ampliamente o la muestra es insuficiente.

Si solo se publica una puntuación puntual, se registrará la incertidumbre como desconocida. El sistema evitará recomendaciones fuertes basadas en diferencias pequeñas sin soporte estadístico.

---

## 8. Admisión por capacidad mínima

```text
datos públicos
   ↓
control de calidad y comparabilidad
   ↓
requisitos mínimos por trabajo
   ↓
pool de configuraciones capaces
   ↓
optimización económica y operacional
```

Cada pool tendrá métricas obligatorias, métricas complementarias, nivel mínimo de evidencia, antigüedad máxima y reglas para datos faltantes.

Los requisitos obligatorios se evalúan como gates independientes. No se promedian entre sí: fallar uno deja la configuración fuera de esa clase, aunque su promedio general sea alto. Las métricas complementarias solo ordenan o especializan configuraciones que ya aprobaron.

Ejemplo conceptual para Builder:

```text
REQUISITOS DUROS
- evidencia de edición de código existente
- evidencia de resolución de issues reales
- evidencia de terminal/tool use
- resultado reciente y configuración identificada

DESPUÉS DE APROBAR
- costo esperado
- velocidad
- contexto
- disponibilidad
- proveedor
```

### 8.1 Regla vigente (2026-09-08)

La regla es código: `lib/admission.mjs` la aplica a `config/benchmark-evidence.json`
(cada cifra con su fuente) y `scripts/admit.mjs apply` escribe el registro; un
test falla si el registro se aparta de lo que la regla produce. Nadie escribe la
lista a mano. El usuario decidió no hacer pruebas propias: todo parte de los
benchmarks.

Fuentes independientes (las corre un tercero): SWE-bench Verified oficial,
SWE-rebench (Nebius), Terminal-Bench 2.1 / 3.0 / 4.0, LiveBench (Coding y
Agentic), Artificial Analysis Intelligence Index, LMArena texto. Fuentes del
fabricante: SWE-V / DeepSWE, Terminal-Bench 2.x, Toolathlon y MCP-Atlas
tomados de las fichas. Una cifra "por confirmar" nunca cuenta.

Escribir código (Builder, Gate Designer), dos pruebas a la vez:

1. Prueba de código, al menos una al corte: SWE-bench Verified ≥ 70;
   SWE-rebench ≥ 38 (solo ventanas posteriores a la salida del modelo y con
   al menos 100 problemas; nunca comparar ventanas distintas); Terminal-Bench
   2.x ≥ 55; LiveBench Coding ≥ 72; del fabricante, SWE-V / DeepSWE ≥ 70 o
   Terminal-Bench 2.x ≥ 55.
2. Prueba de herramientas, cualquier benchmark agéntico: Terminal-Bench en
   cualquier versión, Toolathlon, MCP-Atlas, LiveBench Agentic ≥ 45, o la
   propia prueba de código cuando es agéntica (SWE-bench Verified, SWE-rebench).

Razonar (Planner, Goal Manager, Researcher, advisors, reconciler), una basta:
AA Intelligence ≥ 40, Arena texto ≥ 1470, o LiveBench Agentic ≥ 55.

Riesgo: solo evidencia del fabricante → bajo; una prueba independiente → medio;
pruebas independientes en dos tableros distintos → alto. Un modelo solo de
razonamiento queda en medio.

Además: los modelos de la suscripción OpenAI solo planifican y orquestan; los
SKU preview, experimental, alpha o contributor se registran como `watch` y no
se enrutan; un modelo sin cifra utilizable queda como candidato. Los cortes
salen de la distribución de cada fuente en `docs/BENCHMARKS-2026-09-08.md`
(el de SWE-rebench, del hueco entre 40.2 y 31.2 en la ventana de 111
problemas); se revisan cuando cambie la distribución, nunca por precio.

---

## 9. Cálculos económicos

### Costo nominal por ejecución

```text
nominal_task_cost =
  input_tokens × input_price_per_token
  + output_tokens × output_price_per_token
  + cached_tokens × cached_price_per_token
```

Si el leaderboard publica costo observado por tarea, se prefiere ese valor dentro de la misma configuración.

Este costo solo es comparable con otras entradas de la misma tarea, versión, harness y presupuesto. No debe usarse para ordenar directamente resultados de benchmarks diferentes.

### Costo esperado por éxito

```text
expected_cost_per_success ≈
  mean_cost_per_attempt / success_rate
```

### Intentos esperados

```text
expected_attempts_per_success ≈ 1 / success_rate
```

Ambas fórmulas suponen intentos independientes y costo estable; se etiquetan como estimaciones.

Si el sistema permite como máximo `k` intentos del mismo modelo, la probabilidad estimada de resolver antes de escalar es:

```text
success_within_k = 1 - (1 - success_rate)^k
```

El número esperado de intentos consumidos, incluyendo ejecuciones que agotan el límite, es:

```text
expected_attempts_with_cap =
  Σ desde i=1 hasta k de (1 - success_rate)^(i-1)
```

Estas fórmulas siguen suponiendo independencia. En la práctica, reintentar el mismo prompt puede producir fallos correlacionados; por eso no deben usarse para justificar reintentos ilimitados.

### Flujo con fallback

Cuando existan tasas comparables:

```text
expected_pipeline_cost =
  primary_attempt_cost
  + primary_failure_rate × fallback_attempt_cost
```

```text
pipeline_success_rate =
  primary_success_rate
  + primary_failure_rate × fallback_success_rate
```

```text
pipeline_cost_per_success =
  expected_pipeline_cost / pipeline_success_rate
```

Estas fórmulas representan un intento primario y, si falla, un intento de fallback. Para varios reintentos debe utilizarse la versión acotada anterior y documentar la política exacta. No se combinarán tasas de tareas diferentes; si no provienen de la misma clase y protocolo, el cálculo se marcará como no válido, no solo como una aproximación.

### Riesgo de fallback

Si no existe una tasa observada, se calcula un índice, no una falsa probabilidad:

```text
fallback_risk_index = f(
  distancia al mínimo de capacidad,
  debilidad en tool use,
  seguimiento de instrucciones,
  datos faltantes,
  comparabilidad,
  estabilidad del proveedor
)
```

Solo se llamará `fallback_rate` a una tasa realmente observada y publicada.

---

## 10. Datos medidos, derivados y desconocidos

Cada valor debe marcarse como:

- `measured`: publicado directamente;
- `derived`: calculado desde métricas publicadas;
- `estimated`: aproximación con supuestos explícitos;
- `unknown`: no disponible;
- `incomparable`: disponible, pero incompatible con la cohorte.

Reglas:

1. Nunca imputar cero.
2. Nunca presentar una estimación como medición.
3. Reducir confianza cuando falten proveedor, harness, intentos o tokens.
4. Exigir evidencia sólida para capacidades críticas.
5. Mostrar rangos cuando el costo dependa de supuestos.
6. No calcular costos de pipeline cuando las tasas de éxito no sean comparables.
7. No inferir confiabilidad del proveedor desde la puntuación del modelo ni viceversa.

---

## 11. Selección dentro del pool

Solo después de aprobar los mínimos se comparan:

- costo esperado por éxito;
- éxito e intentos esperados;
- riesgo de fallback;
- velocidad y latencia;
- contexto necesario;
- lenguaje o framework;
- disponibilidad y límites;
- confiabilidad del proveedor.

La selección debe ocurrir dentro de una clase y cohorte comparables. Si las fuentes no permiten estimar costo por éxito de forma válida, se mostrarán por separado calidad demostrada, precio nominal y confianza, sin forzar un cociente.

No es obligatorio producir un ranking único. Es preferible mantener una frontera de Pareto con configuraciones como:

- la más barata;
- la más rápida;
- la de mayor contexto;
- la más fiable;
- la balanceada;
- el fallback fuerte.

---

## 12. Actualización periódica

Fuentes a revisar: SWE-bench, Aider, Terminal-Bench, Artificial Analysis, OpenRouter, OpenCode y benchmarks independientes de research, tool use e instrucciones.

La captura preferirá, en este orden: API o dataset oficial versionado, exportación estructurada, tabla pública estable y, por último, extracción de HTML. Cada conector debe validar esquema, unidades y número de registros. Un cambio inesperado detiene la actualización de esa fuente en lugar de publicar ceros o datos parciales.

```text
captura
  ↓
validar fecha, versión y configuración
  ↓
normalizar por cohorte
  ↓
recalcular capacidad y confianza
  ↓
recalcular costo esperado y riesgo
  ↓
recomendar: añadir / mantener / vigilar / retirar
```

Generan alerta: un modelo que supera mínimos, una caída de rendimiento, cambios de precio o contexto, nueva evidencia independiente, problemas de integridad, cambios de proveedor o retiro de una versión.

Antes de publicar cada actualización deben ejecutarse controles de duplicados, alias de modelos, monedas, unidades, fechas futuras, porcentajes fuera de rango y cambios anómalos respecto al snapshot anterior.

---

## 13. Salida del observatorio

```yaml
configuration_id:
model:
provider:
harness:
effort:
last_updated:

qualified_roles:
qualified_task_classes:
failed_requirements:
unknown_requirements:

public_metrics:
derived_metrics:
expected_cost_per_success:
fallback_risk_index:
confidence_level:
uncertainty:
comparability_group:
metric_status: measured | derived | estimated | unknown | incomparable

strengths:
limitations:
recommended_use:
status: candidate | qualified | watch | deprecated
sources:
```

Resumen por pool:

| Pool | Configuración | Motivo | Costo esperado | Riesgo fallback | Confianza | Estado |
|---|---|---|---:|---:|---:|---|
| Builder | A | Menor costo entre las aptas | — | — | — | Qualified |
| Builder | B | Mayor velocidad | — | — | — | Qualified |
| Builder | C | Contexto grande | — | — | — | Qualified |
| Engineer | D | Mejor evidencia agentic | — | — | — | Qualified |

---

## 14. Limitaciones

Al no ejecutar pruebas propias:

- no conoceremos con certeza el comportamiento en nuestros repositorios;
- no tendremos un fallback real de nuestro flujo hasta usarlo;
- algunos costos por éxito serán estimaciones;
- dependeremos de que las páginas publiquen configuración suficiente;
- puede haber diferencias entre el benchmark y OpenCode;
- el proveedor puede cambiar cuantización, routing o infraestructura;
- una puntuación pública no garantiza nuestras instrucciones particulares;
- una tasa de éxito de benchmark no garantiza que los reintentos sean independientes;
- diferencias pequeñas pueden no ser estadísticamente significativas;
- algunos roles, especialmente Researcher y Orchestrator, pueden tener evidencia pública menos uniforme que Builder.

Por eso el sistema debe distinguir medición, derivación y estimación, y aplicar un margen de seguridad a los mínimos.

---

## 15. Decisiones pendientes

1. Seleccionar las fuentes definitivas y asignarles confianza.
2. Confirmar cuáles permiten extracción periódica estable.
3. Definir la taxonomía de tareas por rol.
4. Estudiar distribuciones antes de fijar mínimos numéricos.
5. Calibrar el factor de confianza y la caducidad de datos.
6. Definir supuestos estándar para costo por éxito y fallback.
7. Diseñar almacenamiento histórico y frecuencia de actualización.
8. Definir cómo ADW/OpenCode consumirá los pools.
9. Definir grupos de comparabilidad para impedir cruces inválidos entre benchmarks.
10. Establecer validaciones y alertas para extractores que cambien de esquema.

---

## 16. Criterio final

La pregunta no será:

> ¿Cuál modelo encabeza el leaderboard o cuesta menos por millón de tokens?

Será:

> Según evidencia pública reciente, fiable y comparable, ¿qué configuraciones han demostrado capacidad suficiente para este trabajo y cuál ofrece la mejor combinación de costo esperado por éxito, velocidad, contexto, disponibilidad y bajo riesgo de fallback?

El observatorio debe impedir dos errores: pagar siempre por el modelo más potente y llenar el sistema de tokens baratos que no producen trabajo útil.
