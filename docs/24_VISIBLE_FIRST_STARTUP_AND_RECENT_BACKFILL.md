# Visible-First Startup and Recent Backfill

**Decision date:** 2026-08-02

**Status:** Implemented and packaged-validated in [PR #11](https://github.com/tcurtsinger/Mistr/pull/11), ready for review

## Demonstrated problem

Hands-on testing showed that a fresh development launch could take two to three minutes before Mistr became usable, and that a newly selected site could remain at `1/20` or `2/20` for many minutes.

The delays had independent causes:

1. Radar initialization waited for MapLibre's full remote basemap `load` event. A slow tile, sprite, or glyph request could therefore block local radar work indefinitely.
2. Mistr decoded all 20 raw bundled KTLX archives before painting the newest one. On this workstation those decodes took about 57 seconds in the debug build and 18 seconds in release, before GPU setup and copies.
3. The live-history engine loaded one current scan and then waited only for future scans. KEWX volume cadence measured about 4 minutes 37 seconds, so accumulating 19 more observations would take roughly 88 minutes.
4. The words `BUILDING n/20` implied that known recent observations were being loaded, and `PAUSED · NEWEST` implied usable playback even when only one frame existed.

## Supercell comparison

Current `dpaulat/supercell-wx` source was inspected at commit [`efb4e3af6bbd5bfe664a667b654e4234c7b0144d`](https://github.com/dpaulat/supercell-wx/tree/efb4e3af6bbd5bfe664a667b654e4234c7b0144d). Its Level II chunks provider keeps a two-scan cache, identifies the current and immediately preceding ring entries, and loads those scan records concurrently on a three-thread pool. It may fall back to the full Level II archive path for the prior scan. See [`aws_level2_chunks_data_provider.cpp`](https://github.com/dpaulat/supercell-wx/blob/efb4e3af6bbd5bfe664a667b654e4234c7b0144d/wxdata/source/scwx/provider/aws_level2_chunks_data_provider.cpp).

Mistr does not copy Supercell's two-frame product limit or C++ architecture. The relevant lesson is behavioral: current radar should become visible first, and usable recent context should come from already-existing preceding scans rather than waiting for future weather.

## Decision

### Startup

- Commit the OpenFreeMap dark style graph with the frontend and initialize radar at MapLibre's local `style.load` event.
- Treat remote basemap readiness separately. Basemap failure says `Basemap unavailable. Radar remains available.` and never becomes a radar error.
- Decode and paint only the newest bundled KTLX archive observation on the normal startup path.
- Keep the full pinned 20-frame archive available to `prepareArchive()` for packaged performance, recovery, and installer diagnostics.
- Begin current live acquisition immediately after the safe paint. A normal launch never performs 19 irrelevant raw archive decodes before requesting live radar.

### Recent live history

- Paint the selected site's current safe observation first and return site-selection success after its matching GPU receipt.
- Maintain separate committed newest and oldest provider cursors.
- Sequentially request the preceding ring slot, including `1 -> 999` wrap, and require a strictly older measured start time.
- Prepend one accepted older observation per incremental GPU transaction while preserving the visible current/newest scan.
- Stop safely at 20 frames or when no safe predecessor is available. A partial backfill failure does not mark the already-painted radar unavailable.
- Start continuous exact-next polling after backfill finishes or settles partial. During backfill, a Site probes for a newer scan every 2 minutes (3-second wait; finding none changes nothing) and National checks every 30 seconds, so fresh data never waits behind history (2026-09-28).
- Preserve generation cancellation, exactly two cross-IPC transfer credits, and the temporary `20 + 1` incremental resource bound.
- Keep the displayed publication's acquisition evidence, paint receipt, and renderer snapshot as one matching diagnostic record. Report older background acquisitions separately as history updates so they are never mislabeled as the scan that painted.

### Visible truth

- Current radar is usable while recent history loads.
- One live frame plus active backfill says `LOADING RECENT`.
- Active timeline progress says `LOADING RECENT n/20`.
- A settled partial timeline says `RECENT n/20`; a one-frame partial set says `WAITING FOR NEXT SCAN`.
- A complete 20-frame history shows only its normal position.
- A reticle outside the measured sweep says `OUTSIDE RADAR COVERAGE` instead of reverting to an unselected prompt.

## Evidence so far

- A direct KEWX current safe-sweep probe completed in about 3.6 seconds with 12 requests and approximately 2.15 MiB downloaded.
- In the debug desktop runtime, the newest bundled archive painted about seven seconds after process start and current live radar painted about five seconds later.
- A live KEWX session reached three chronological resident observations within about eight additional seconds and reached the 20-frame bound in the background in about one minute.
- The newest observation remained the authoritative painted frame while older observations were prepended.
- A separate KAKQ run reached the full 20-frame bound with 53,099,312 GPU bytes, matching the established bounded 20-frame resource level.
- The final packaged release/WebView2 live soak painted the safe bundled observation in 1.27 seconds with one archive disk read, then loaded current KTLX volume 676 and predecessors through 657 into 20 strictly chronological residents in 0.6 minutes. It waited for the observable pending-site state before superseding it, then passed direct oldest/newest scrub, bounded upload/memory checks, and real WebGL context recovery with no degraded samples.
- A separate packaged cold start forced WebView2 through an unreachable proxy, blocking remote basemap resources. The one-frame safe archive still painted in 1.26 seconds with renderer status `painted`, demonstrating that basemap network readiness no longer gates radar.

These workstation measurements are diagnostic evidence, not a universal latency promise. The release/WebView2 gates remain authoritative.

## Acceptance

- Frontend tests cover prepend ordering, deduplication, render-key/generation rules, non-CONUS site acceptance, and truthful one-frame/loading/partial/full copy.
- Rust tests cover explicit before/after request validation, previous-slot wrap, strict older-time selection, and preservation of current/exact-next behavior.
- The packaged live soak must validate current-first paint, bounded predecessor accumulation, chronology, direct scrub, site supersession, and real context recovery without waiting for future scans.
- Shortened 4–19-frame soak modes must stop inside the backfill loop at their configured target rather than relying on an external sampling interval; these diagnostic limits never change the product's 20-frame history bound.
- Phase 4 must still lazy-load its complete archive before performance scenarios.
- Phase 5 and Phase 6 must continue to pass their existing cancellation, paint-receipt, N0S, and context-recovery gates.

## The startup scan is optional (2026-09-28)

Until this change, a missing, truncated, or undecodable bundled scan failed the whole startup: the Site layer, playback controller, and source sessions were all built on that first paint, so current radar never started. Now the scan is attempted once; if it fails, the reason is logged and exposed as `__MISTR_PHASE4__.startupFallback()`, the partial layer is removed, the chrome shows `LOADING CURRENT RADAR`, and startup continues to the source the restored camera calls for. With no Site painted, a Site switch builds its own layer and fades it in, the same path used from National.

`npm run test:startup-fallback:packaged` launches the packaged app three times, each after a separate launch stores its camera:

| Case | Startup scan | Camera | Result |
|---|---|---|---|
| bundled | present | KTLX, zoom 9.5 | scan painted in 1.14 s, then live KTLX |
| missing | absent (`os error 2`) | KTLX, zoom 9.5 | scan skipped, live KTLX |
| corrupt | 255 bytes | country view | scan skipped (size mismatch), National |

The scan runs before current radar starts, delaying it by about 1.1 s, so only a KTLX launch uses it (2026-09-29): any other launch would paint KTLX in the wrong place. National and other Site launches skip it (`skipped` in `startupFallback()`). For a KTLX launch, starting both at once would need the startup acquisition to share the Site lane with the scan request; that and the predecoded scan below are the remaining startup optimizations.

A page reload used to fail startup: the previous document's native downloads stay charged against the transfer credits for about a second while they unwind, and the new document's first requests were refused. Startup now waits (at most 10 s) until nothing is in flight; a launch finds nothing and does not wait. The gate's `national` and `reload` cases cover both.

## Deferred optimization

The bundled startup observation is still decoded from raw Level II data. A future performance-only change may bundle a hash-pinned predecoded packed sweep, provided provenance, wire validation, public-repository policy, and installer evidence remain equivalent. That optimization is not required to correct the demonstrated blocking dependencies.
