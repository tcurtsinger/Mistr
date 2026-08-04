# National Static Renderer Decision

**Status:** Implemented and packaged-validated on the Phase 3 review branch; not shipped from `main` until merge
**Date:** 2026-08-03
**Scope:** One current NOAA MRMS CONUS observation only

## Decision

Mistr renders National radar with a dedicated numeric-grid WebGL2 custom layer. It does not reuse the selected-site polar renderer, create MapLibre raster radar sources, or accept provider-colored imagery as numeric truth.

The static source path is:

```text
RadarSessionCoordinator
  -> NationalMrmsSession
  -> fixed-host MRMS acquire/decode/levels
  -> PackedGrid v1 manifest and chunks
  -> shared global two-credit broker
  -> NationalWorkingSetController
  -> NationalGridLayer
  -> complete-coverage GPU receipt
```

## Presentation levels and coverage

- The home view uses factor 4: a complete 1,750 by 875 CONUS overview in 28 chunks.
- High zoom uses factor 1 for only the chunks intersecting the current viewport while retaining factor 4 as complete-domain fallback outside that viewport.
- Factor 2 remains generated and wire-compatible for later common-quality selection.
- Each chunk has a 256-cell interior and one-cell sampling halo.
- Active and staged presentations are separate. The prior presentation remains paint truth until the replacement completes.
- A receipt is authoritative only after every required chunk uploads, complete coverage draws, and the matching GPU fence completes.

The receipt includes observation time, content hash, source generation, presentation factor, coverage version and kind, required chunk count, context epoch, draw sequence, upload/staging timing, uploaded bytes, and framebuffer size.

## Numeric rendering and interrogation

Raw MRMS codes are uploaded as `R16UI` integer textures. The shader decodes the accepted `R=-9990`, `E=0`, `D=1` contract and treats missing raw `9000` and no-coverage raw `0` as non-painting statuses.

- `Native` samples the nearest cell at the active presentation level.
- `Smooth` interpolates spatially only when all four contributing cells are valid. It never bridges missing or no-coverage cells.
- Both modes use the existing approved reflectivity palette and weak-return display curve.
- Neither mode is interrogation authority.

Map interrogation sends longitude/latitude plus the currently painted observation time, generation, content hash, and unique inspection identity to Rust. Rust reads the exact retained factor-1 base grid and returns raw code, status, and exact dBZ. The UI discards a reply if any identity no longer matches current paint truth.

## Source handoff

One `RadarSessionCoordinator` owns requested intent and painted truth for both source types.

1. The old source remains visibly enabled while the replacement acquires, decodes, transfers, uploads, draws complete coverage, and completes its GPU fence.
2. Only the matching receipt commits source label, measured time, age, timeline, inspection identity, and persistence.
3. After receipt acceptance, the old layer is removed and its complete loop is released. Mistr does not keep two permanent histories.
4. Failure, supersession, timeout, or context loss deletes partial staging and leaves or restores the old complete presentation.

Green age text means newest for the painted source. A newer-for-National MRMS observation may still be several minutes older than the preceding Site observation; the exact time and numeric age remain visible.

## Upload, memory, and recovery

One National chunk is uploaded per animation frame. The configured and enforced upload slice is no greater than 4 ms. A lease remains charged until validation and upload complete, then returns to the one shared two-credit broker.

The renderer records active plus staged GPU bytes and rejects a presentation above the 256 MiB hard ceiling. The target remains 200 MiB for the eventual Phase 4 working set.

For context loss, the active complete presentation and any required complete-domain fallback retain their CPU chunk arrays. WebGL handles are discarded, the prior complete presentation wins over an interrupted replacement, and chunks rehydrate locally one per animation frame under the same 4 ms upload ceiling. Visible exact viewport chunks recover before the off-viewport fallback; the next receipt waits for the declared working set and increments context epoch. Recovery performs no network, decode, disk, or IPC work.

## Phase boundary

Phase 3 has one exact National observation. It does not implement:

- MRMS polling;
- predecessor backfill;
- a 20-observation National timeline;
- National playback or direct scrubbing;
- all-frame overview residency; or
- playback quality locking.

Those remain Phase 4 and require a separate owner authorization after this branch is reviewed and merged.

## Evidence

The dedicated release/WebView2 command is:

```text
npm run test:national:phase3:packaged
```

The measured evidence and complete gate results are recorded in [National Phase 3 Static Renderer](phase-reports/NATIONAL_PHASE_3_STATIC_RENDERER.md). Generated NOAA downloads, reports, screenshots, and binaries remain ignored and are never committed.
