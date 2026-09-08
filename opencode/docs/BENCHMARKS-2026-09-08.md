# Benchmarks públicos, catálogo OpenCode Go (35 modelos) — reunido 2026-09-08

Fuentes independientes (agente 2): SWE-bench Verified (leaderboards.json oficial), Terminal-Bench Hub 4.0 / 2.1 (POST supabase leaderboard-read, 2026-09-03), TB 3.0 (snapshot web 2026-07-23), Artificial Analysis Intelligence Index v4.3 (artículo 2026-09-07), LiveBench 2026-06-25 (CSV), LMArena (dataset HF 2026-09-06; text / style-control / webdev 2026-09-02..05). Vendor (agente 1): páginas y model cards de cada fabricante. "—" = por confirmar. Toda cifra tiene URL en los informes de los agentes (sesión 2026-09-08).

| modelo Go | in$/out$ /M | ctx | SWE-bench Verified (indep.) | Terminal-Bench (indep.) | AA Intelligence v4.3 | LiveBench Coding / Agentic | Arena text-SC / WebDev | vendor (SWE-V, TB, tool-use) |
|---|---|---|---|---|---|---|---|---|
| gpt-5.6-sol (openai, planner) | 4/20 (suscripción) | 1.05M | — | TB4.0 37.27 (Codex, max, #10); AA-run TB4 39.9 | 47 | 83.94 / 56.21 | 1483 (#17) / 1617 (#13) | — |
| gpt-5.6-terra (openai) | 2/12 | 1.05M | — | TB4.0 21.52 (#12); TB2.1 78.43 (#11) | 42 | 78.25 / 54.95 | 1466 / 1520 | — |
| gpt-5.6-luna | 0.2/1.2 | 1.05M | — | TB4.0 17.27 (#15); TB2.1 75.73 (#14) | 37.5 | 82.91 / 48.43 | 1453 / 1519 | — |
| glm-5.3 | 1.4/4.4 | 1M | — | TB4.0 41.82 (Claude Code, max, #9) | 44.86 | 78.95 / 60.91 | 1482 (#20) / 1609 (#14) | TB2.1 88.2, DeepSWE 66.9, Toolathlon-V 73.0 |
| glm-5.3-flash | 0.075/0.25 | 1M | — | — | 42 | 78.95 / 56.77 | 1474 / 1605 | TB2.1 84.3, DeepSWE 63.4 |
| kimi-k3 | 3/15 | 1M | — | TB3.0 3.52 (Kimi CLI, oculto) | 43.78 | 81.45 / 62.17 | 1489 (#12) / 1674 (#5) | TB2.1 88.3, DeepSWE 67.5, Toolathlon-V 76.5, MCP-Atlas 84.2 |
| qwen3.8-max | 2/6 | 1M | — | — | 40 (como "Qwen3.8 2.4T A95B", mapeo por confirmar) | 72.87 / 64.65 | 1480 (#22) / 1686 (#4, 0902) | TB2.1 86.6, Toolathlon-V 72.5 |
| qwen3.8-flash | 0.15/0.47 | 1M | — | — | — | 72.55 / 61.62 (Flash-Next) | — / 1626 (#9) | LCB v6 91.9, SWE-Pro 62.5 (Flash-Next) |
| deepseek-v4-pro | 0.66/1.98 | 1M | — | — | 36.28 (0813 max) | 77.16 / 54.95 (0813) | 1460 / 1582 | SWE-V 80.6, TB2.0 67.9, LCB 93.5 (Max) |
| deepseek-v4-flash | 0.22/0.66 | 1M | — | — | — | 74.98 / 46.77 (0731) | 1436 / 1580 | SWE-V 79.0, TB2.0 56.9, LCB 91.6 (Max) |
| deepseek-v4-flash-vision-exp | 0.22/0.66 | 1M | — | — | — | 68.20 / 65.10 | — | — |
| minimax-m3 | 0.3/1.2 | 1M | — | — | — | 68.20 / 40.66 | 1443 / 1487 | SWE-V 80.5, TB2.1 66.0, MCP Atlas 74.2 |
| minimax-m2.7 | 0.3/1.2 | 205K | — | — | — | — | 1415 / 1398 | TB2.0 57.0, Toolathon 46.3 |
| minimax-m2.5 | 0.3/1.2 | 205K | 75.8 (mini-SWE-agent, 2026-02) | — | — | — | 1391 / 1384 | — |
| mimo-v2.5-pro | 0.435/0.87 | 1M | — | — | 26 | — | 1468 / 1475 | SWE-V 78.9 |
| mimo-v2.5 | 0.14/0.28 | 1M | — | — | — | — | 1434 / 1438 | — |
| mimo-v2-pro | 1/3 | 1M | — | — | — | — | 1448 / 1433 | — |
| mimo-v2-omni | 0.4/2 | 262K | — | — | — | — | 1430 / — | — |
| kimi-k2.7-code | 0.95/4 | 262K | — | — | — | 73.96 / 45.66 | — / 1472 | MCP Atlas 76.0, MCP Mark-V 81.1 |
| kimi-k2.6 | 0.95/4 | 262K | — | — | — | 78.57 / 46.92 | 1461 / 1509 | — |
| kimi-k2.5 | 0.6/3 | 262K | 70.8 (2026-02) | — | — | — | 1451 / 1436 | — |
| glm-5.2 | 1.4/4.4 | 1M | — | TB3.0 5.14 (#8) | — | 79.65 / 51.77 | 1472 / 1587 | — |
| glm-5.1 | 1.4/4.4 | 203K | — | TB2.1 58.65 (#22) | — | — | 1466 / 1508 | — |
| glm-5 | 1/3.2 | 203K | 72.8 (2026-02) | — | — | — | 1458 / 1436 | — |
| qwen3.7-max | 2.5/7.5 | 1M | — | — | — | 74.22 / 43.59 | 1474 / 1517 | — |
| qwen3.7-plus | 0.4/1.6 | 1M | — | — | — | — | 1455 / — | — |
| qwen3.6-plus | 0.5/3 | 1M | — | — | — | 78.18 / 41.36 | 1444 / 1460 | — |
| qwen3.5-plus | 0.2/1.2 | 262K | — | — | — | — | — | — |
| grok-4.6 | 2/6 | 500K | — | TB4.0 20.30 (Grok Build, #13) | 44.41 | 76.78 / 57.02 | — / 1625 (#10) | — |
| grok-4.5 | 2/6 | 500K | — | TB4.0 12.42; TB2.1 79.33 (Cursor CLI, #9) | — | 68.59 / 56.46 | 1471 / 1556 | — |
| muse-spark-1.3-contributor (Meta) | 0.1/0.2 | 1M | — | TB2.1 76.18 (Muse Spark 1.1) | 48.17 (1.3 max) | 81.06 / 64.09 (1.3 xhigh) | — / 1622 (#11) | — |
| muse-spark-1.2-contributor (Meta) | 0.1/0.2 | 1M | — | — | — | 77.54 / 57.58 (1.2 xhigh) | 1499 (#5) / 1534 | — |
| hy4-preview (Tencent) | 0.834/2.5 | 1M | — | — | — | — | — / 1621 (#12); Agent Arena #10 | — |
| hy3 (Tencent) | 0.14/0.58 | 256K | — | — | — | — | 1455 / 1512 | — |
| longcat-2.0 (Meituan) | 0.3/1.2 | 1M | — | — | — | — | — | — |
| ox-alpha-free | 0/0 | 1M | — | — | — | 75.75 / 52.63 (ox-alpha-max) | — | (reportado como GLM-5.3-Flash, por confirmar) |
| omen-alpha | 0.2/0.66 | 500K | — | — | — | — | — | — (stealth, por confirmar) |

Notas: los boards "contributor" de Muse Spark puntúan el SKU xHigh, no el contributor; TB 2.0/2.1/3.0/4.0 no son comparables entre sí; ningún modelo de 2026 aparece en SWE-bench Verified oficial (los vendors publican SWE-bench Pro / DeepSWE en su lugar); AA Coding Index no encontrado; Aider Polyglot sin actualizar desde 2025-11.
