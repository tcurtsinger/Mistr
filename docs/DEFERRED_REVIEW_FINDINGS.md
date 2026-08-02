# Deferred review findings

This ledger keeps review feedback visible without turning low-probability edge cases into an endless review loop.

## Disposition policy

1. A demonstrated defect that can produce a wrong result, unsafe behavior, or broken phase gate is fixed in the current pull request. The implementation reply explains the fix and the thread is resolved only after validation.
2. A plausible but non-blocking edge case is recorded here, answered on the pull request with a link to this entry, and resolved without another review round.
3. A finding is never silently dismissed. Every closed thread receives a written disposition.
4. Deferred items are reconsidered before the affected subsystem becomes a Mistr Alpha release dependency.

## Open items

None at this checkpoint.

## Closed items

### DRF-003 - Real Windows sleep/wake lifecycle pass

- **Origin:** Phase 6 packaged lifecycle validation.
- **Area:** Packaged Tauri/WebView2 runtime and `RadarCustomLayer` recovery.
- **Closed:** 2026-08-02 during Alpha release readiness.
- **Disposition:** A controlled real Windows sleep/wake pass succeeded with active playback. The saved heartbeat gap was 34,387 ms. Mistr had a painted 20-frame archive before sleep, remained painted with the same 20 resident frames after wake, resumed playback, and produced a matching direct-scrub GPU paint receipt. The validation harness persists its pre-sleep checkpoint and reconnects CDP after wake because the diagnostic socket itself can become unresponsive across system sleep.

### DRF-004 - Intermittent Phase 4 stabilized-heap measurement edge

- **Origin:** Alpha product-foundation packaged validation.
- **Area:** MapLibre tile ownership and `scripts/phase4-packaged-cdp.mjs` WebView2 heap sampling.
- **Closed:** 2026-08-02 during Alpha release readiness.
- **Disposition:** The strengthened gate reproduced twice and triggered investigation. V8 allocation sampling attributed retained growth to MapLibre basemap tile parsing rather than radar observations. At 3840x2160, MapLibre's default dynamic cache could retain about 270 parsed out-of-view tiles per source while the synthetic camera/context workload advanced. Mistr now disables that parsed offscreen cache, and the evidence runner waits for MapLibre's public `idle` signal before garbage collection so in-flight basemap work is not mislabeled as stabilized memory. No heap threshold changed. Two consecutive final runs passed with zero long tasks, zero hot-path acquisition/uploads, bounded radar residency, and stabilized pairs of 79,102,293 to 83,581,348 bytes and 79,183,520 to 84,097,819 bytes.

### DRF-001 - PuTTY private-key detection in the repository safety scanner

- **Origin:** Phase 0 pull-request review.
- **Area:** `scripts/check-public-repo.ps1`
- **Closed:** 2026-08-02 during Alpha release readiness.
- **Disposition:** The scanner now rejects PuTTY v2/v3 private-key payloads with non-empty private lines. A generated regression probe proves rejection without committing key-like content.

### DRF-002 - Temporary AWS credential detection in the repository safety scanner

- **Origin:** Phase 0 pull-request review.
- **Area:** `scripts/check-public-repo.ps1`
- **Closed:** 2026-08-02 during Alpha release readiness.
- **Disposition:** The scanner now rejects temporary `ASIA` access-key IDs and AWS session-token fields. Generated regression probes prove both paths without adding credentials to the repository.
