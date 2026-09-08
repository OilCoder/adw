Trabaja en `/home/pokinux/claude-project-base/opencode`, el sistema de generación
de código sobre OpenCode.

Acabo de auditar el sistema pieza a pieza y dejé 14 hallazgos agrupados en
`caso-de-estudio-claude.md` (grupos A a E). **Yo decido qué grupo se toca y
cuándo. Tú no eliges el orden ni empiezas por tu cuenta.**

## Fase 1 — entender el proyecto

Esto es lo único que haces al principio. Sin editar nada.

1. Lee `caso-de-estudio-claude.md` entero.
2. Lee `CODE_GENERATION_FLOW.md`: es la **intención de diseño**, prescribe, no
   describe el código.
3. `ARCHITECTURE.md` está desactualizada — lleva 8 commits sin tocarse y no
   menciona la operación `merge`, que ya existe. Úsala como pista, no como
   verdad. Su sección de decisiones dice que nunca hubo una orquestación
   completa sobre un proyecto real: eso es falso, ya la hubo.
4. Recorre el código y confirma por tu cuenta el flujo real: supervisor →
   `codegen_workflow` → goal-manager → deliberación → aprobación → orquestador →
   planner → validación → worktrees → gate readiness → builders → integración →
   gate final → merge.
5. Verifica los 14 hallazgos contra el código. Están escritos por otra sesión.
   Si alguno no se sostiene, dilo con evidencia.

Cuando termines, dame **un resumen corto**: qué hallazgos confirmas, cuáles no,
y si encontraste algo que la auditoría no vio. Y para.

## Fase 2 — solo cuando yo diga un grupo

Yo te diré "vamos con el grupo X". Entonces:

1. Explícame en lenguaje llano, sin volcar código, qué vas a cambiar y por qué,
   hallazgo por hallazgo de ese grupo.
2. Espera mi aprobación.
3. Implementa solo ese grupo. No te adelantes a los demás.

Los grupos son independientes salvo estas ataduras, que tienes que señalarme
cuando toquen:

- **A1, A2 y A3 son el mismo agujero en tres momentos** (nadie comprueba que lo
  entregado cubra lo pedido). Si comparten solución, dilo antes de parchearlos
  por separado.
- **C1 choca con una regla existente**: quiero el modelo más barato capaz
  primero, pero el sistema prohíbe a propósito reintentar con otro modelo tras
  un fallo, para que ningún fallo quede tapado. Propón cómo se concilian y di
  cuál de las dos reglas cede.
- **C4 no es un fallo, es una decisión mía**: reevaluar todos los modelos de
  OpenCode Go. Eso es trabajo de certificación con corridas reales, no de
  código. Adviérteme del costo antes de empezarlo.
- **B1** (el triaje de riesgo lo escribe un modelo y el código lo obedece):
  cualquier arreglo tiene que decidir si el código puede desmentir esa etiqueta
  y en qué momento.

## Reglas del repositorio

- `CODE_GENERATION_FLOW.md` es la directriz. Si un arreglo la contradice,
  propón cambiarla primero; no la contradigas en silencio.
- `ARCHITECTURE.md` se actualiza en el mismo commit que cambia el código.
- Hay tests en `tests/`. Ningún commit con la suite en rojo.
- No inventes. Si dices que algo está verificado, enseña la evidencia.

## Cómo quiero que me hables

Respuestas cortas y en lenguaje llano, como a un ingeniero junior. Un paso por
turno y esperas. Nada de tablas de resumen ni volcados de código salvo que te
los pida.
