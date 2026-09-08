# Dudas y hallazgos — sistema codegen

Proyecto: `OilCoder/claude-project-base`, carpeta `opencode/`.

**Sin cambios al codigo hasta terminar de entender el sistema.** Solo dudas y
hallazgos; sin apuntes de estudio ni propuestas cerradas.

**Orden de ataque sugerido:** C primero (barato y ya decidido) · A y B juntos
(mismo problema de fondo, necesitan diseno) · D despues · E cuando se toque ese
codigo por otra razon.

---

# A. Termina en verde sin haber hecho el trabajo

**Gravedad: maxima. Falla en silencio.** Nadie comprueba que lo entregado cubra
lo pedido: ni al planificar, ni al verificar, ni al cerrar. Su nombre en la
arquitectura es el revisor semantico, que nunca se cableo.

## A1. La corrida completa el plan, no el Goal

Los criterios de aceptacion del Goal son prosa y nadie los ejecuta. El Gate
final comprueba las pruebas de los contratos y los comandos del plan; nada
comprueba que el resultado cumpla lo que el Goal prometia.

- El unico puente entre Goal y resultado es el Planner. Si tradujo bien, cuadra.
  Si se dejo un requisito fuera, la corrida termina en verde con el trabajo
  incompleto y nada lo detecta.
- Esta es la pieza "revisor semantico" que figura como no implementada.
- Propuesto (sin decidir): merge final automatico cuando el Gate final pasa.
  Solo seria seguro si algo garantiza que el Goal se cumplio entero.

## A2. Nadie comprueba que el plan cubra el objetivo

El validador comprueba que el plan sea **ejecutable sin riesgo** (sin ciclos,
sin solape de archivos, rutas seguras, riesgo dentro del techo del Goal). Nunca
comprueba que sea **suficiente**.

- No existe una version legible del plan, asi que tampoco puedo revisarlo yo
  antes de que empiecen a programar. Del Goal si se rinde un GOAL.md; del plan no.
- Resultado: ni maquina ni humano miran si el plan cubre el objetivo.

## A3. Una prueba solo tiene que fallar, no cubrir

Lo unico que se le exige a la prueba de un contrato antes de programar es que
**falle en el baseline**.

- Eso demuestra que mide *algo* del cambio, no que mida *todo* lo que el
  contrato pide.
- Una prueba que cubra un requisito de tres pasa esa comprobacion igual de bien,
  y luego el Gate da PASS con dos requisitos sin verificar.

# B. Un LLM juzga y el codigo obedece sin verificar

**Gravedad: alta. Tambien silencioso.** El triaje de riesgo, los presupuestos y
las citas de investigacion los pone un modelo y nadie los contrasta. La unica
excepcion del sistema es la verificacion de la revision del Goal tras deliberar:
ahi el codigo si comprueba al modelo.

## B1. El triaje lo hace un vistazo, y queda congelado

La ruta (directa o planificada) la decide el orquestador con una tabla fija,
pero sobre etiquetas que puso el goal-manager: si el cambio es localizado, si el
riesgo es bajo, si ya existe una prueba que lo cubra.

- El goal-manager solo puede leer y buscar; no ejecuta tests. Su "ya hay prueba"
  es por inspección, no comprobado.
- Es un vistazo inicial, antes de que nadie profundice. El Planner, que sí
  estudia el cambio a fondo, se encuentra la etiqueta puesta y no puede corregirla.
- Si marca "riesgo bajo" a la ligera, un cambio grande entra por la vía rápida
  (un solo contrato, dos intentos) y nada lo detecta después.

## B2. El que gasta es el que pone el limite

Los presupuestos (llamadas de investigacion, llamadas al Planner, intentos del
builder) los escribe el goal-manager dentro del Goal. El codigo los aplica con
rigor, pero el numero lo puso un LLM.

- Misma debilidad del hallazgo 3: mecanica infalible sobre un juicio no verificado.
- Si declara preguntas de mas, gasta de mas. Si se queda corto de presupuesto, la
  deliberacion para sin investigar nada.
- No hay techo del sistema por encima del que fija el Goal.
  
## B3. Las citas del investigador pueden ser inventadas

La validacion del informe comprueba que cada fuente tenga id unico, URL https,
titulo, editor y fecha de consulta no futura, y que cada hallazgo cite una
fuente de su propia lista.

- No comprueba que la URL exista, que responda, que el titulo sea suyo, ni que
  diga lo que el informe afirma.
- Garantiza citas **bien formadas y coherentes entre si**, no citas **reales**.
  Un informe con cinco URLs inventadas pero bien escritas pasa el filtro.
- Esa evidencia acaba registrada en el Goal como decision, con su id de informe.

## B4. Decisiones del grupo B (2026-09-08)

**Aprobado y pedido a otra sesion:**

1. Quitar la nota de "ya hay prueba" de la decision de ruta. El sistema ejecuta
   la prueba de verdad mas adelante y la fabrica si no sirve; la nota del
   principio solo era una adivinanza.
2. Los presupuestos dejan de escribirlos un modelo. El usuario vigila su gasto
   en OpenAI y OpenCode. Hace falta un numero fijo del sistema que corte los
   reintentos, pero ya no es juicio de nadie. **B2 queda cerrado.**
3. Comprobar que las fuentes del investigador existan de verdad, no solo que
   esten bien escritas. **B3 queda cerrado.**
4. El goal-manager puede autocorregirse cuando su archivo no cumple el esquema
   (hoy solo el Planner tiene esa oportunidad), y apoyarse en researcher/advisor.
   Aviso pendiente: si pide ayuda por su cuenta vuelve a haber investigacion
   silenciosa, que es justo lo que el diseno separo para que el gasto sea visible.

**Queda abierto — B1 parcial:** las notas de "cambio pequeno" y "riesgo bajo"
siguen puestas por un modelo que solo leyo por encima, y nadie las contradice.
Son las que mandan una peticion por la via rapida (un contrato, dos intentos).
Opciones planteadas: (A) que otro modelo pueda contradecirlas, (B) quitarlas y
que todo vaya por la via completa, (C) asumir el riesgo. **Sin decidir.**


# C. Dinero mal gastado

**Gravedad: media. El grupo mas accionable** — se sabe que se quiere y el punto
C4 ya es una decision tomada. Por aqui empezar.

## C1. El selector nunca escoge el mas barato

Hay una lista de preferencia escrita a mano por tipo de trabajo. El selector
coge el primero que pase los filtros (habilitado, certificado para el rol, techo
de riesgo, contexto, herramientas, familia excluida).

- **El coste no participa en la seleccion.** La tabla guarda el precio por millon
  de tokens de cada modelo y el selector no lo mira ni una vez.
- En la lista de "cambio pequeno y de bajo riesgo" los modelos flash estan en los
  puestos 8, 9 y 10, debajo de los caros. Como el primero siempre pasa, nunca se
  ejecutan.
- La lista escrita a mano *es* la politica de coste, y hoy esta al reves para
  tareas triviales.
- El selector guarda un suplente (el segundo elegible) y nunca lo usa.

**Intencion del sistema:** el modelo mas barato capaz debe ser el primero
asignado. Hoy no ocurre.

## C2. El modelo caro en la TUI se desperdicia

El supervisor usa el modelo de la TUI y solo conversa, resume el Goal y decide
si deliberar. Los roles que producen (planner, builder) usan sus propias
configuraciones certificadas, fuera de la TUI.

- ¿Bajar la TUI a mid-tier y subir el mejor modelo al pool del `planner`?
- ¿Cuál es el piso aceptable para el supervisor?
- ¿Cómo encaja mi autenticación OpenAI (Plus) con la política "Go antes que Zen"?

## C3. La certificacion no se realimenta sola

La evidencia no sale de las corridas reales: sale de un script de certificacion
aparte, con un caso de prueba fijo por rol. Y ese script no se instala en los
proyectos destino, solo vive en este repositorio.

- Desde un proyecto real no se puede certificar nada; hay que volver aqui,
  certificar y reinstalar.
- Resultado: un modelo nuevo de OpenCode no entra nunca a menos que yo me siente
  deliberadamente a certificarlo.
- Hoy solo 7 combinaciones estan certificadas de 27 candidatas. El builder tiene
  un unico modelo certificado: si falla, no hay repuesto.

**Como deberia ser:** este repositorio es donde se evalua y se deja el modelo
como candidato. En un proyecto real el sistema deberia poder escoger cualquiera
de la lista publicada, porque ya paso los filtros de aceptacion aqui.

## C4. Rehacer la seleccion de modelos (decision)

**Origen del error:** cuando eligi los modelos temia que el sistema usara
modelos ultraeconomicos incapaces, que gastaran dinero reintentando escribir
codigo. Esa precaucion se paso de largo: ahora el sistema escoge siempre el mas
capaz aunque sea caro, incluso para tareas que no lo necesitan.

**Lo que hay que hacer:**

1. Partir de **todos** los modelos de OpenCode Go, no de una lista corta.
2. Descartar con evidencia los que no sirven para este proyecto: malos
   escribiendo codigo, malos siguiendo instrucciones o usando herramientas.
3. Quedarse solo con los que realmente pueden codificar.
4. Construir un escalafon en dos grupos:
   - **Razonar y fases criticas** (Goal, Plan, investigacion): los mas capaces.
   - **Ejecutar** (builders, gates): los mas rapidos, economicos y suficientes.

**Objetivo:** maximizar velocidad de generacion y presupuesto, no capacidad
bruta.

**Tension a resolver:** "el mas barato capaz primero" choca con "no reintentar
con otro modelo tras un fallo". Si el barato no puede, hoy la corrida para en
vez de subir un peldano. Hay que decidir cual de las dos reglas cede.

## C5. Decisiones del grupo C (2026-09-08)

**C1 — corregible, aprobado.** La lista escrita a mano se hizo como *filtro*
("estos modelos saben programar", segun benchmarks de la industria sobre lo
disponible en OpenCode Go), pero el sistema la lee como *orden de preferencia* y
coge el primero. Como esta ordenada por capacidad, siempre gana el mas caro.
Arreglo: mantener el filtro y ordenar cada lista de barato a caro entre los que
pasaron el corte. El dato de cuota por millon de tokens ya esta en la tabla; hoy
no lo mira nadie.

**C2 — el mejor modelo va al Planner.** Es quien lee el proyecto entero, decide
que cambiar, en cuantas piezas y en que orden; y desde el grupo A, tambien que
requisito cubre cada pieza. La TUI se queda con un modelo mid-tier para el
supervisor.

El modelo elegido es el de frontera de OpenAI, por la suscripcion del usuario.
`auth.json` confirma que `openai` esta autenticado por OAuth, junto a
`opencode-go`. Pasos necesarios:

1. Anadir `openai` a los proveedores permitidos del proyecto (hoy solo estan
   ollama, opencode, opencode-go, openrouter).
2. Anotar sus modelos en la tabla y certificarlos como `planner`.
3. **Por comprobar antes de disenar nada:** si esa autenticacion OAuth funciona
   desde procesos no interactivos (`opencode run`) o solo desde la sesion
   interactiva. Se prueba con una llamada suelta.

# D. Detecta pero no repara

**Gravedad: media. Falla en voz alta**, asi que uno se entera: cuesta tiempo, no
confianza. Incluye las tres piezas sin cablear del final.

## D1. Un conflicto de integracion no tiene salida

Los commits de cada oleada se llevan uno a uno a la rama de integracion. Si uno
choca, la corrida para y termina. No hay reintento ni resolucion automatica.

- Queda un estado a medias: la rama con las oleadas anteriores aplicadas, el
  worktree del encargo conflictivo con su commit, y nadie los junta. Hay que
  meterse a mano.
- Deberia ser raro: el validador ya impide que dos encargos concurrentes toquen
  los mismos archivos. Un conflicto aqui significa que el plan declaro mal que
  archivos toca cada encargo.
- Y por eso tiene un destino natural que hoy no se usa: replantear.

## D2. Detecta bien, no repara nada

El Gate final vuelve a correr todas las pruebas de cada encargo sobre el arbol
ya integrado, asi que **si detecta** que dos piezas que pasaron por separado se
rompen al juntarlas.

- Lo que no existe es la correccion. Si el Gate final falla, la corrida termina
  en fallo: sin reintento, sin volver al Planner, sin builder de reparacion.
  Deja la rama, los worktrees y el comando que fallo.
- Es el mismo agujero del hallazgo 8 visto desde otro angulo.
- Y encaja con las tres piezas sin cablear (volver al Planner, trabajo derivado,
  revisor semantico): las tres son mecanismos de reparacion. El sistema esta
  construido entero salvo su capacidad de arreglarse.

## D3. Decisiones del grupo D (2026-09-08)

**D1 y D2 implementados.** Hallazgo previo: D1 es casi inalcanzable por
construccion (el validador impide solapes en una oleada y el commit solo lleva
rutas permitidas); un conflicto real es un hueco del validador o un cambio
ajeno en la rama. Diagnostico determinista en los dos casos (git y
reproduccion de comprobaciones a lo largo de la rama), sin modelo; el Planner
es el diagnosta de respaldo, con la evidencia, no un agente nuevo.

Decisiones tomadas:

1. Alcance del contrato de reparacion: union de las rutas de los dos contratos
   implicados, dentro de la huella que el Gate final ya vigila.
2. Riesgo: heredado del aprobado (`risk_accepted` en el trabajo derivado);
   la condicion literal "bajo riesgo" de la directriz mandaba casi todo al
   Planner. Directriz §4 actualizada.
3. Reanudacion minima de corrida (`--resume`): sin ella no hay Planner con
   revision del plan de reparacion.
4. En ruta planificada el plan de reparacion siempre se revisa; en directa
   solo con contradiccion (riesgo mayor o rutas fuera de la huella).
5. Libro de cobertura: sigue leyendo los contratos aprobados y los de planes
   de reparacion; los contratos compuestos aparecen en `state.repairs` bajo su
   padre.

**Fuera de alcance, relacionado:** comprobar los comandos de
`final_verification` del plan en el baseline al validar. Hoy la reproduccion
lo detecta despues ("nunca paso en ningun head") y va al Planner.

# E. Higiene

**Gravedad: baja.** Confunden al leer el codigo, no rompen nada.

## E1. Hallazgos en `approve`

- Sella lo que haya en disco, sin comprobar que sea el mismo Goal que el
  supervisor me resumió. Si el archivo cambió entremedias, apruebo algo que no leí.
- No queda rastro de la aprobación (ni quién ni cuándo): solo cambia `status`.
  El sello es la única evidencia de que hubo un humano.

## E2. La ruta deliberativa dentro del orquestador confunde

El triaje es una sola funcion compartida por los dos circuitos, y puede devolver
"deliberativa". El orquestador la llama entera, asi que contempla ese caso.

- Pero es inalcanzable: para llegar al orquestador el Goal debe estar sellado, y
  sellar exige que las dudas esten cerradas.
- Leyendo el orquestador parece que puede deliberar, y no puede. La deliberacion
  vive en otro programa, anterior al sello.

---

## E3. Decisiones del grupo E (2026-09-08)

**E1 y E2 implementados.** E1: `approve` exige el `goal_digest` del resumen
que el supervisor leyo al usuario y se niega si el archivo cambio; el Goal
sellado guarda `approval` (usuario, fecha, digest, via) y el validador lo
exige. E2: el Router solo enruta Goals sellados; un Goal abierto devuelve lo
que le falta y el orquestador para con una sola parada, `APPROVAL_REQUIRED`.
La deliberacion vive antes del sello, en `deliberate.mjs`.

# Sin cablear en el sistema

- Retorno automatico al Planner tras `REPLAN_REQUIRED` en la oleada inicial
  (tras integrar si esta cableado, grupo D).
- Reviewer semantico (ver grupo A).


# Recorrido

Completo: supervisor, `codegen_workflow`, goal-manager, deliberacion
(investigador, opinadores, conciliador), aprobacion, orquestador, planner,
validacion de plan, worktrees, gate readiness, builders, integracion, gate
final, merge.
