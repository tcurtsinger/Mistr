# Mistr

**Status:** Mistr is now the product. The Windows-first Alpha foundation is underway; the earlier Phase 0 through 6 prototype work is retained below as reproducible engine evidence, not as the product identity or normal interface.

Mistr is a focused desktop radar instrument for selected-site storm inspection. Its Alpha product contract lives in [PRODUCT.md](../PRODUCT.md), and its implemented interface rules live in [DESIGN.md](../DESIGN.md).

Its qualified radar path is:

```text
AWS radar data -> decode and normalize -> packed binary IPC -> WebGL2 GPU resources -> MapLibre custom layer
```

The historical phase documents record how this architecture was selected, bounded, tested, and reviewed. They remain useful to future maintainers, but forward product work is planned directly in Mistr rather than as a GustAVO integration rehearsal.

## Alpha direction

- Keep Tauri, Rust, React, TypeScript, MapLibre, and the qualified custom WebGL renderer.
- Ship Windows first while preserving a reasonable path to macOS validation.
- Make one selected-site live base-reflectivity workflow dependable before adding national mosaic, velocity, alerts, cameras, or other weather surfaces.
- Keep the measured, painted observation as the source of truth for time, freshness, and playback state.
- Keep `Smooth` and `Native` as explicit spatial views of that same observation; inspection always reports the native gate/status truth and weak valid returns are never removed by a display cutoff.
- Preserve the fixture, packaged-runtime, performance, and recovery gates as part of product engineering.
- Keep prototype phase labels, benchmark controls, and diagnostic internals out of the normal interface.

## Documentation map

The numbered documents and phase reports below are historical architecture and acceptance evidence. New product and interface decisions must remain consistent with [PRODUCT.md](../PRODUCT.md) and [DESIGN.md](../DESIGN.md).


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
| [13_DECODER_DECISION.md](13_DECODER_DECISION.md) | Phase 1 decoder selection, pinning, ownership boundary, and safety limits |
| [14_PACKED_SWEEP_V1.md](14_PACKED_SWEEP_V1.md) | Phase 2 binary layout, integrity, generation, and transfer-credit contract |
| [15_GPU_RENDERER_DECISION.md](15_GPU_RENDERER_DECISION.md) | Phase 3 renderer representation, native-grid semantics, and retention ADR |
| [16_RESIDENT_PLAYBACK_DECISION.md](16_RESIDENT_PLAYBACK_DECISION.md) | Phase 4 resource-set, hard-cut, atomic replacement, and paint-truth ADR |
| [17_REALTIME_FRESHNESS_AND_FALLBACK_DECISION.md](17_REALTIME_FRESHNESS_AND_FALLBACK_DECISION.md) | Phase 5 safe-sweep publication, source freshness, cancellation, and fallback ADR |
| [18_LEVEL3_N0S_AND_CONTEXT_RECOVERY_DECISION.md](18_LEVEL3_N0S_AND_CONTEXT_RECOVERY_DECISION.md) | Phase 6 N0S decoder, product-label, categorical normalization, and visible-first recovery ADR |
| [19_ALPHA_PRODUCT_FOUNDATION.md](19_ALPHA_PRODUCT_FOUNDATION.md) | Productization decision, normal radar interface, current runtime truth, and remaining Alpha engine milestone |
| [20_ALPHA_CURRENT_STATE.md](20_ALPHA_CURRENT_STATE.md) | Current product/runtime state, validation evidence, review workflow, and the exact next development milestone |
| [21_BOUNDED_ROLLING_LIVE_HISTORY.md](21_BOUNDED_ROLLING_LIVE_HISTORY.md) | Exact-next live polling cursor, bounded incremental GPU history, playback truth, rollback, and packaged evidence |
| [22_ALPHA_RELEASE_READINESS.md](22_ALPHA_RELEASE_READINESS.md) | Operational soak, installed-product, accessibility, lifecycle, and public Alpha release gates |
| [23_ALPHA_UI_AND_SITE_HARDENING.md](23_ALPHA_UI_AND_SITE_HARDENING.md) | Full operational WSR-88D catalog, bounded discovery, startup/status truth, and hands-on UI remediation |
| [24_VISIBLE_FIRST_STARTUP_AND_RECENT_BACKFILL.md](24_VISIBLE_FIRST_STARTUP_AND_RECENT_BACKFILL.md) | Basemap-independent first paint, lazy archive diagnostics, predecessor backfill, and truthful partial-history states |
| [25_RADAR_RENDERING_QUALITY.md](25_RADAR_RENDERING_QUALITY.md) | Product reflectivity palette, `Smooth`/`Native` spatial modes, native interrogation truth, and rendering acceptance gates |
| [phase-reports/PHASE_2_PACKED_WIRE_AND_IPC.md](phase-reports/PHASE_2_PACKED_WIRE_AND_IPC.md) | Phase 2 cross-language, packaged IPC, timing, and memory evidence |
| [phase-reports/PHASE_3_STATIC_GPU_RENDERER.md](phase-reports/PHASE_3_STATIC_GPU_RENDERER.md) | Phase 3 packaged GPU, alignment, palette, coexistence, and performance evidence |
| [phase-reports/PHASE_4_RESIDENT_PLAYBACK.md](phase-reports/PHASE_4_RESIDENT_PLAYBACK.md) | Phase 4 real 20-observation residency, 4K playback, paint truth, and resource evidence |
| [phase-reports/PHASE_5_REALTIME_CHUNKS.md](phase-reports/PHASE_5_REALTIME_CHUNKS.md) | Phase 5 live chunk assembly, completed-volume comparison, latency, fallback, and packaged evidence |
| [phase-reports/PHASE_6_N0S_AND_CONTEXT_RECOVERY.md](phase-reports/PHASE_6_N0S_AND_CONTEXT_RECOVERY.md) | Phase 6 independent N0S parity, IEM spatial comparison, context reset, and packaged lifecycle evidence |
| [DEFERRED_REVIEW_FINDINGS.md](DEFERRED_REVIEW_FINDINGS.md) | Non-blocking review edge cases deliberately recorded for later work |
| [GLOSSARY.md](GLOSSARY.md) | Radar, rendering, and test terminology |

## Required reading order

1. Product definition
2. Design system
3. Architecture
4. Data sources and decoding
5. GPU renderer
6. Test and validation plan
7. Risk register
8. Engineering contract

## Governing rule

No Mistr result is considered successful because it looks smooth in a developer browser. Adoption requires decoded-value correctness, packaged Windows WebView2 evidence, deterministic regression coverage, bounded memory, measured latency, context-loss recovery, and a proven rollback path.
