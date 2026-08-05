# National Radar Performance and Fidelity Findings

**Date:** 2026-08-04
**Status:** Root causes diagnosed and remediation implemented on `claude/national-performance-fixes`; packaged before/after evidence remains owner-run
**Baseline:** `codex/mistr-national-visual-fidelity` at `183a534`
**Reporter:** Owner-observed behavior in the packaged app, traced to code by review

## 0. Implemented outcome

- **F1 (implemented):** the selected observation's refinement now stages **whole-domain factor-1 detail** (`stageSelectedDetail` with `bounds: null` → `complete_domain` coverage). The paused presentation is camera-independent: `moveend` performs no cancellation, restaging, or quality change unless a playback session is engaged. The refinement zoom gate is removed, so the CONUS home view (zoom ~5.5) sharpens to native resolution, including on 4K displays.
- **F2 (implemented):** `stageHistoryOverview` accepts the preserved selected presentation factor; backfill and polling commits keep complete-domain detail active instead of resetting to the factor-4 overview. The 19 pixelate/sharpen startup cycles are gone.
- **F3 (resolved via F1):** no separate pixel-density selector was needed for the paused view. **Playback** retains the zoom-6 sharp gate because 20 whole-domain factor-2 frames (245.3 MiB) exceed the 200 MiB target; playback at country scale remains factor 4 by memory necessity, and the sharp playback path is still viewport-bounded.
- **F4 (implemented):** upload slicing now uses a shared `UploadFrameBudget`: row bands are sized from measured throughput and multiple bands/chunks share one animation frame until the 4 ms budget is spent. The fixed 32-row-band-per-vsync behavior (≈10 vsync waits per chunk) is gone; a 50 ms long-task ceiling still fails any pathological single slice closed.
- **F5 (deliberately not implemented):** with the paused view whole-domain, viewport restaging survives only in the bounded playback-preparation path, where the camera is pinned by the quality lock; a reuse diff there no longer pays for its complexity.

Memory contract after F1: 20 factor-4 commons (61.3 MiB) + selected whole-domain factor-1 detail (46.7 MiB) + one staged replacement (46.7 MiB) ≈ **154.7 MiB** peak, inside the 200 MiB target; the 256 MiB hard-ceiling checks are unchanged and still enforced at commit time.

## 0.1 Round 2 — owner retest findings and remediation (2026-08-04)

The owner retested the packaged build after PR #20 merged: pan/zoom **while playing** still froze the loop, a `Mistr could not change scans` notice appeared on roughly half of pans, playback blocked backfill from ever finishing, and blur-then-sharpen persisted around playback sessions. Round 1 fixed only the paused path. Verified round-2 root causes, remediated on `claude/national-playback-continuity`:

1. **Playback stopped for every camera change and for quality preparation.** `notifyCameraChanged` paused the loop, re-prepared all 20 viewport-detail frames, and only then restarted; `play()` was also gated behind that preparation. Remediation: **motion-first playback** — motion starts immediately at the always-resident factor-4 commons, sharp preparation runs beside the loop as prefetch-only residency work (`prefetchDetail` for every frame, including the selected one, which the relaxed `commitPrefetchedStaging` guard now permits while the common level is active), and the quality lock upgrades between frames with a normal paint receipt. A camera change drops the lock to the commons — whole-domain, therefore camera-independent — without stopping motion, and re-prepares in the background.
2. **Supersession surfaced as a user-facing error.** A second pan during an in-flight preparation raised `RadarSourceSupersededError`, which the `moveend`/play/scrub handlers rendered as the playback-area notice. Remediation: supersession is normal control flow and is now filtered everywhere before `setPlaybackError`; the camera notification path no longer produces awaited rejections at all.
3. **Playback starved acquisition.** The play session held the exclusive resident-only reservation for its entire duration while `runNationalAcquisition` spun on it, so backfill and strictly-newer polling made no progress while playing. Remediation: motion is resident-only by construction and holds no reservation; backfill and polling continue during playback, with each commit briefly pausing/resuming the loop through the existing replacement contract. Sharp preparation defers until retained history settles (`pendingBackfillCount` = 0) and the post-commit resume re-runs it.
4. **Home-view playback deleted the complete-domain detail.** The below-threshold branch of quality preparation reset to the overview and pruned all detail, forcing a ~1 s re-refinement blur after every home-view play. Remediation: below the sharp threshold, preparation touches no residency at all.

Deferred with reason: pipelining backfill downloads against GPU commits requires a staged-frame queue in Rust (`national_history.rs` holds a single `staged` slot); backfill remains serial per frame. The engineering-contract playback sentence was updated for the motion-first model as an owner decision dated 2026-08-04.

## 1. Reported symptoms

1. **Initial National load takes far too long** before the timeline feels usable.
2. **Any pan or zoom appears to reload everything**, with visible re-acquisition of already-displayed radar.
3. **The image is intermittently pixelated or blurry after camera movement** and "corrects itself" seconds later; at the default CONUS view on a 4K display it never fully sharpens.

All three are real, reproducible consequences of the current working-set implementation. None of them are provider, network-quality, or GPU-capability problems.

## 2. Root causes

### 2.1 Initial load: serialized backfill and fixed-row upload slicing

First paint itself is fast and honors current-first startup: exactly one observation is downloaded before anything is visible (`src-tauri/src/national_history.rs:677-715`), measured at roughly 890 ms end to end on the validation machine (`docs/phase-reports/NATIONAL_PHASE_3_STATIC_RENDERER.md:37-43`).

The slowness is everything after first paint:

- The 19 predecessor observations backfill strictly one at a time (`src/App.tsx:1949-1996`), each paying download + decode + pyramid + 28-chunk staging (~690 ms each, ≈13 s minimum total).
- Every chunk costs two IPC round-trips (request, then release acknowledgement) even though the transfer broker allows two credits; the second credit is never used on the real path (`src/national-radar/NationalHistoryWorkingSetController.ts:231-247`, `src/packed-sweep/transferClient.ts:1050`).
- GPU uploads are sliced at a fixed 32 rows per animation frame (`src/national-radar/NationalGridLayer.ts:1573`), roughly 10 vsync waits per chunk. One factor-4 overview is ~280 `requestAnimationFrame` waits; on a vsync-locked 60 Hz display that is seconds of idle waiting per observation. The plan requires a **measured ~4 ms per-frame upload budget** (`docs/26_NATIONAL_RADAR_IMPLEMENTATION_PLAN.md`, "Time-sliced staging uploads"); 32 rows is far below that budget on the validation hardware.
- Each backfill commit also resets presentation quality (see 2.3), multiplying visible churn during the loading period.

### 2.2 Pan/zoom reload: zero chunk reuse and float-exact camera keys

- The camera key is center longitude/latitude to five decimals plus zoom to four decimals (`src/App.tsx:3244-3247`). Any nonzero camera delta — a one-pixel pan — invalidates the entire working set.
- Invalidation cancels staging, **deletes partially staged textures** (`src/national-radar/NationalGridLayer.ts:736-742`), bumps the coverage version, and re-requests **every** chunk descriptor in the new viewport over IPC. `beginStaging` always starts from an empty chunk map (`NationalGridLayer.ts:443-451`); chunks already resident on the GPU for the previous viewport are never reused even when the two viewports overlap almost completely.
- Rust-side, the prepared-detail cache holds a single slot (`src-tauri/src/national_history.rs:900-929`). The ±1 temporal neighbor prefetch immediately evicts it, so every camera change re-encodes the full 392-chunk factor-1 grid per observation instead of only the viewport chunks.

### 2.3 Pixelation: unconditional fallback to the factor-4 overview

- On any camera change, the playback controller re-selects `finestCompletePlaybackFactor()`, which returns detail only when **every** timeline observation has complete detail at the same factor with a byte-identical chunk-index list (`NationalGridLayer.ts:1433-1486`). After a camera move the new viewport's chunk list never matches, so the selection always falls back to factor 4 — even when the selected observation's detail for essentially the same viewport is still resident.
- `residentsWithStaging` commits an overview staging with `{ common: staging, detail: null }` (`NationalGridLayer.ts:1066-1072`), so each of the 19 backfill commits drops detail residency. A user who zooms in during startup sees up to 19 pixelate/sharpen cycles.
- Sharpening is deferred behind a refinement debounce and re-stages the full viewport detail from scratch (`src/App.tsx:1599-1703`).
- Zoom below `NATIONAL_SHARP_PLAYBACK_MIN_ZOOM = 6` is hard-forced to factor 4 (`src/national-radar/NationalPlaybackQuality.ts:14`, `src/App.tsx:1618-1620`), while National recenter fits CONUS at maxZoom 5.5 (`src/App.tsx:3221-3231`). The default National view therefore **never** refines. At 4K the viewport is ~3840 px across while the factor-4 grid provides ~1750 columns for the same span: visibly soft. Factor 2 is the correct match for that display; the zoom-6 gate was calibrated for a smaller viewport.

## 3. The structural insight

One full-resolution CONUS frame is 24,500,000 cells × 2 bytes = **46.7 MiB**. The viewport-chunk machinery — camera keys, coverage versions, refinement debounce, exclusion-rect fallback compositing — exists to avoid GPU cost that, for the **selected frame**, was never large. Whole-domain residency per level is camera-independent by construction:

| Working set | MiB |
|---|---:|
| 20 observations at factor 4 (whole domain) | 61.3 |
| Selected observation at factor 1 (whole domain) | 46.7 |
| One staged factor-1 replacement during selection change | 46.7 |
| **Peak** | **~155** |

That peak sits under the 200 MiB target with room for halos, indices, palette, and fixed resources. Viewport-limited detail remains necessary only where whole-domain residency cannot fit: **all-frame sharp playback** (20 × factor 2 whole-domain would be 245 MiB), which keeps the existing bounded factor-1/factor-2 regional preparation.

## 4. Remediation plan, ranked

| # | Fix | Effect |
|---|---|---|
| F1 | **Whole-domain factor-1 residency for the selected observation.** Camera changes stop invalidating, restaging, or degrading the paused view entirely. Viewport coverage machinery remains only for the all-frame playback preparation path. | Removes symptoms 2 and most of 3 structurally |
| F2 | **Stop resetting presentation quality when an unrelated observation's overview commits.** Backfill commits preserve the selected observation's detail residency. | Removes the 19 pixelate cycles during startup |
| F3 | **Select presentation factor by measured screen-pixel density, not a zoom threshold.** Compare grid-cell size to device pixels so a 4K CONUS view selects factor 2 while a laptop selects factor 4. Remove the zoom-5.5-vs-gate-6 contradiction. | Fixes permanent softness at the home view |
| F4 | **Time-budgeted upload slicing.** Measure each slice and size the next to fill the ~4 ms budget instead of a fixed 32 rows. | Cuts startup staging waits roughly an order of magnitude on 60 Hz displays |
| F5 | **Chunk reuse diff for the remaining viewport paths.** When new coverage overlaps resident coverage at the same factor/observation/generation, request only missing chunks. | Cheapens playback-window restaging; lower priority once F1 lands |

Non-goals of this remediation: no truth-contract changes. Paint receipts, generation fencing, the two-credit broker, exact interrogation, and the memory ledger remain authoritative. Whole-domain residency must appear in the ledger under the existing categories.

## 5. Verification obligations

- Packaged evidence: pan/zoom on a painted National frame performs zero acquisition, decode, IPC, or upload for the selected observation after F1.
- Packaged evidence: startup to 20 resident observations, before/after, on the validation machine.
- Existing gates: `npm run verify` (fixtures, build, rustfmt, clippy, Rust tests) all green.
- The 4K and compact viewport matrices from Phase 5 re-run for the factor-density selection change.
