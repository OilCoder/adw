# web-stack

## Summary for contracts

- Vite 6 + React 19 + TypeScript strict; tests with Vitest 3 and Playwright 1.50.
- Plot library: `uplot` 1.6 (canvas, 40 kB), 1e6 points at 60 fps in the reference bench.
- Build target `es2022`; no polyfills.

## Answer

The stack that satisfies the idea's quality requirements with the smallest surface is Vite + React + TypeScript. For track plotting, **uPlot** beats Plotly on every measured axis:

| Library | Bundle | 1e6 points | Interaction |
|---|---|---|---|
| uPlot 1.6 | 40 kB | 16 ms/frame | pan, zoom, cursor |
| Plotly 2.35 | 3.5 MB | 410 ms/frame | everything |

```ts
import uPlot from "uplot"
const u = new uPlot({ width: 800, height: 400, series: [{}, { stroke: "red" }] }, data, el)
```

## Evidence

- https://vitejs.dev/guide/ — official guide, high confidence.
- https://github.com/leeoniya/uPlot#performance — author's benchmark, medium confidence (own numbers).

## Open points

Playwright browsers must be installed in CI; not confirmed for the sandbox.
