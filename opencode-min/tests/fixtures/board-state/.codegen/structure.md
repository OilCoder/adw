# Mapa estructural — LAS Viewer

## Responsabilidades generales

Aplicación web estática, local-first y sin backend. Los bytes LAS originales y todos los cálculos permanecen en el navegador. Cada dominio contiene su implementación, tipos y pruebas unitarias; las pruebas contractuales externas viven bajo `.codegen/` y están protegidas.

## Folders

- `.opencode/**`: configuración y automatización del sistema de agentes; nunca contiene producto.
- `.codegen/**`: investigación, mapa, contratos, gates y reportes del sistema de generación; nunca contiene producto.
- `docs/**`: sitio documental mínimo publicado por GitHub Pages; nunca contiene código fuente del producto.
- `wiki/idea/**`: idea vigente y criterios de aceptación del producto; fuente documental canónica.
- `wiki/audits/**`: sesiones de prueba registradas por fecha, con `notes.md` e imágenes.
- `wiki/changes/**`: propuestas de cambio activas y su archivo histórico bajo `wiki/changes/archive/`.
- `wiki/**`: guías, decisiones arquitectónicas, formatos, validación y limitaciones para personas y agentes.
- `data/**`: corpus LAS real e inmutable aportado por el usuario; ninguna tarea puede modificarlo.
- `public/**`: iconos, manifest y recursos estáticos autocontenidos; sin datos de pozo ni recursos remotos.
- `src/app/analysis/**`: paneles React de calidad, procesamiento, petrofísica, intervalos y comparación; un panel por archivo y una composición del espacio de análisis.
- `src/app/**`: composición de pantallas, navegación y coordinación de casos de uso; no implementa matemáticas de dominio.
- `src/design/**`: tokens visuales y componentes de interfaz reutilizables, accesibles y en español.
- `src/core/**`: modelo inmutable de proyecto, pozo, índice, curva, metadatos, incidencias y procedencia.
- `src/units/**`: normalización declarativa, compatibilidad y conversión explícita de unidades.
- `src/las/**`: detección, parseo y escritura LAS 1.2/2.0, fixtures unitarios y worker de importación.
- `src/projects/**`: persistencia local IndexedDB/OPFS, snapshots, recetas, migraciones y paquete portátil.
- `src/viewer/**`: presets, estado de vistas, pistas Canvas, escalas, LOD, cursor, zoom, selección y configuraciones guardadas.
- `src/quality/**`: diagnósticos estructurales, estadísticas, huecos, duplicados, outliers, histogramas y correlaciones.
- `src/formulas/**`: lexer, parser AST y evaluador seguro de fórmulas; nunca ejecuta JavaScript arbitrario.
- `src/processing/**`: transformaciones reproducibles, previsualización, recetas y curvas derivadas.
- `src/petrophysics/**`: modelos petrofísicos, ecuaciones, validación de dominios, supuestos y resultados.
- `src/intervals/**`: intervalos, anotaciones, integración de espesores y net sand/reservoir/pay.
- `src/comparison/**`: alineación explícita, comparación de curvas y pozos y gráficos de dispersión.
- `src/exporting/**`: única implementación de exportaciones CSV, LAS, PNG, PDF, QC e historial.
- `tests/e2e/**`: pruebas Playwright de flujos completos ejecutadas en navegador; no aloja pruebas Vitest.
- `tests/fixtures/**`: fixtures sintéticos pequeños y deterministas; los datos reales se leen de `data/`.
- `benchmarks/**`: generadores y mediciones reproducibles de parser, cálculo, render e interacción.
- `scripts/**`: automatización de validación, corpus y reportes; nunca lógica usada por la aplicación.
- `.github/**`: CI y despliegue automatizado sobre la rama `master`.
- `dist/**`: salida generada de Vite; nunca se edita ni versiona manualmente.
- `coverage/**`: cobertura generada; nunca se edita ni versiona.
- `playwright-report/**`: reportes E2E generados; nunca se editan ni versionan.
- `test-results/**`: artefactos E2E generados; nunca se editan ni versionan.
- `*`: archivos raíz de configuración, licencia y orientación del repositorio.

## Dominios y dependencias permitidas

- `core` no depende de ningún otro dominio del producto.
- `units` no depende de otros dominios.
- `design` no depende de dominios científicos ni de datos; puede usar `lucide-react` para iconos accesibles.
- `las` depende solo de `core`.
- `formulas` depende solo de `units`.
- `projects` depende de `core`; puede usar contratos serializados de `viewer` y `processing`, sin importar componentes.
- `viewer` depende de `core` y `design`.
- `quality` depende de `core`.
- `processing` depende de `core`, `units` y `formulas`.
- `petrophysics` depende de `core` y `units`; no depende de la interfaz.
- `intervals` depende de `core`; consume curvas petrofísicas como datos, no importa `petrophysics`.
- `comparison` depende de `core`, `quality` y primitivas públicas de `viewer`.
- `exporting` depende de `core`, `las`, `quality`, `viewer` y contratos serializados de `projects`.
- `app`, incluido `src/app/analysis`, puede depender de todos los dominios y es el único que los coordina.
- Las dependencias inversas y los ciclos están prohibidos. El trabajo pesado usa workers dentro del dominio propietario.

## Convenciones

- Lenguaje de implementación: TypeScript estricto; React TSX solo en dominios de interfaz declarados.
- Archivos y carpetas: `kebab-case`; componentes React: archivo `PascalCase.tsx`; identificadores: `camelCase`; tipos y componentes: `PascalCase`; constantes globales: `UPPER_SNAKE_CASE`.
- Código, comentarios técnicos y nombres internos: inglés. Interfaz, mensajes, ayuda y documentación: español. Los mnemónicos LAS originales nunca se traducen ni normalizan destructivamente.
- Una responsabilidad por archivo. No se permiten cajones `utils`, `helpers`, `common`, `misc`, archivos provisionales ni componentes monolíticos con paneles independientes.
- Pruebas unitarias: junto al archivo probado como `*.test.ts(x)`. Pruebas de navegador: `tests/e2e/*.spec.ts` y deben ejecutar un navegador, no solo listar casos.
- Fixtures: `tests/fixtures/`; generadores grandes: `benchmarks/`. Generados: solo `dist/`, `coverage/`, `playwright-report/` y `test-results/`.

## Dependencias autorizadas

- Runtime: `react`, `react-dom`, `zustand`, `idb`, `uplot`, `pdf-lib`, `fflate`, `lucide-react`.
- Desarrollo y validación: `typescript`, `vite`, `vitest`, `fast-check`, `@vitejs/plugin-react`, `@testing-library/react`, `@testing-library/user-event`, `@testing-library/jest-dom`, `jsdom`, `@playwright/test`, `@axe-core/playwright`, `axe-core`, `eslint`, `typescript-eslint`, `eslint-plugin-react-hooks`, `eslint-plugin-react-refresh`, `prettier`.
- APIs web nativas preferidas: Web Workers, TypedArrays, IndexedDB, OPFS, Web Crypto, Canvas 2D y File APIs.
- No se permiten CDNs, telemetría, fuentes remotas, backend, `eval`, `Function`, analítica ni envío de datos a terceros.

## Repeated names allowed

- `idea.md`
- `index.ts`
- `types.ts`
- `errors.ts`
- `schema.ts`
- `worker.ts`
- `fixtures.ts`
