# Mistr

**Status:** Prototype planning only. No implementation has been authorized or created.

Mistr is the bounded raw-radar feasibility prototype for GustAVO. Its purpose is to determine whether selected-site NEXRAD playback can move from provider-rendered map tiles to decoded, GPU-resident radar data without rewriting the full GustAVO desktop application.

The prototype keeps the existing product shell and proves only the risky radar path:

```text
AWS radar data -> decode and normalize -> packed binary IPC -> WebGL2 GPU resources -> MapLibre custom layer
```

If Mistr succeeds, GustAVO can adopt the new radar engine behind a feature flag. If it fails, GustAVO keeps its current tiled renderer with no forced platform migration.

## Executive decision

Mistr will test a targeted retrofit before any Electron, Qt, game-engine, or full native rewrite is considered.

- Keep Tauri, Rust, React, TypeScript, and MapLibre for the prototype.
- Use Level II for selected-site base reflectivity.
- Preserve current storm-relative velocity semantics by evaluating raw Level III `N0S`; do not mislabel Level II base velocity as storm-relative velocity.
- Keep the national mosaic separate. Level II is per-site and does not replace a proper national multi-radar mosaic.
- Use a GPU texture-oriented representation, not a naïve triangle mesh per radar gate.
- Keep the existing tiled selected-site radar available as a fallback until every adoption gate passes.

## Documentation map

| Document | Purpose |
|---|---|
| [00_PROTOTYPE_CHARTER.md](00_PROTOTYPE_CHARTER.md) | Mission, boundaries, success definition, non-goals |
| [01_ARCHITECTURE.md](01_ARCHITECTURE.md) | Target component, process, state, IPC, and resource architecture |
| [02_DATA_SOURCES_AND_DECODING.md](02_DATA_SOURCES_AND_DECODING.md) | Level II/III sources, product mapping, decoder policy, cache behavior |
| [03_GPU_RENDERER.md](03_GPU_RENDERER.md) | WebGL2/MapLibre renderer design, projection, memory, context recovery |
| [04_IMPLEMENTATION_PHASES.md](04_IMPLEMENTATION_PHASES.md) | Ordered work plan, deliverables, dependencies, phase exits |
| [05_TEST_AND_VALIDATION_PLAN.md](05_TEST_AND_VALIDATION_PLAN.md) | Fixture corpus, correctness, performance, failure, packaged-runtime gates |
| [06_OBSERVABILITY_AND_AI_WORKFLOW.md](06_OBSERVABILITY_AND_AI_WORKFLOW.md) | Debug evidence and safe Codex/Claude development workflow |
| [07_RISK_REGISTER.md](07_RISK_REGISTER.md) | Technical, data, schedule, correctness, and adoption risks |
| [08_DECISIONS_AND_OPEN_QUESTIONS.md](08_DECISIONS_AND_OPEN_QUESTIONS.md) | Accepted decisions and explicitly deferred choices |
| [09_SOURCE_RESEARCH.md](09_SOURCE_RESEARCH.md) | Primary sources and the claims they support |
| [10_INTEGRATION_AND_ROLLBACK.md](10_INTEGRATION_AND_ROLLBACK.md) | Feature flags, GustAVO integration, fallback, rollback, deletion conditions |
| [11_ENGINEERING_CONTRACT.md](11_ENGINEERING_CONTRACT.md) | Planned repository, stack, UI, commands, quality, CI, and artifacts |
| [12_FINAL_REPORT_TEMPLATE.md](12_FINAL_REPORT_TEMPLATE.md) | Required structure for the final evidence-backed feasibility decision |
| [GLOSSARY.md](GLOSSARY.md) | Radar, rendering, and test terminology |

## Required reading order

1. Prototype charter
2. Architecture
3. Data sources and decoding
4. GPU renderer
5. Test and validation plan
6. Implementation phases
7. Risk register
8. Engineering contract

## Governing rule

No Mistr result is considered successful because it looks smooth in a developer browser. Adoption requires decoded-value correctness, packaged Windows WebView2 evidence, deterministic regression coverage, bounded memory, measured latency, context-loss recovery, and a proven rollback path.
