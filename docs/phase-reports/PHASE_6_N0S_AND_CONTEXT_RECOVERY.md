# Phase 6 - N0S parity and packaged recovery

**Date:** 2026-08-01
**Result:** PASS for the automated primary-workstation gate; real Windows sleep/wake remains a manual adoption check

## What Phase 6 proves

- A public Level III `N0S` object can be decoded and normalized in strict Rust.
- The runtime keeps base velocity and storm-relative velocity as different products.
- N0S category/status/value output matches an independent decoder across four sites.
- KTLX N0S spatial output agrees with the matching IEM RIDGE reference.
- The same `PackedSweep v1`, CPU model, and WebGL renderer can display N0S.
- A real WebGL context reset restores the visible observation first, then restores full policy residency, and publishes only a new-context paint receipt.
- The packaged Windows WebView2 build survives minimize/restore, scale changes, offline resident playback, and two cold starts.

## Pinned public corpus

Raw bytes remain ignored. `fixtures/manifest.json` pins the public URL, size, SHA-256, station, scan time, and local cache name.

| Site | Scenario | VCP | Shape | Missing | Range folded | Valid | Independent comparison |
|---|---|---:|---:|---:|---:|---:|---|
| KTLX | 2024-05-20 severe-weather case; same volume start as Phase 1 Level II | 35 | 360 x 230 | 49,571 | 37 | 33,192 | PASS |
| KAMX | Current quiet/mixed field | 212 | 360 x 230 | 66,383 | 996 | 15,421 | PASS |
| KDMX | Current broader velocity field | 212 | 360 x 230 | 47,086 | 2,195 | 33,519 | PASS |
| PABC | Non-CONUS Alaska site | 215 | 360 x 230 | 49,729 | 2,004 | 31,067 | PASS |

Every comparison passes site, product identity, units, coordinates, elevation, VCP, dimensions, gate geometry, status counts, sorted-azimuth SHA-256, float/status SHA-256, and raw-category SHA-256. The independent oracle is the exact dev dependency `nexrad-level-3-data@0.6.1`; concise reports are committed under `fixtures/expected/phase-6/`.

## IEM RIDGE visual/spatial parity

The KTLX object and IEM image represent the same site and minute. An independent Python comparator parses AF1F RLE, uses the IEM world file, maps every nontransparent reference-pixel center to the closest source radial and 4/3-earth slant-range gate, then compares indexed product categories.

| Measure | Result | Gate |
|---|---:|---:|
| Nontransparent IEM pixels | 100,636 | informational |
| Source-covered pixels | 99,263 (98.636%) | at least 98% |
| Exact category agreement | 92,621 (93.309%) | at least 90% |
| Same or adjacent category | 97,219 (97.941%) | at least 97% |

The remaining difference is concentrated at radial/gate raster edges and adjacent velocity categories. The evidence is `fixtures/expected/phase-6/ktlx-iem-ridge-comparison.json`.

## Product-label truth

| Source | Product label | Units | Renderer acceptance |
|---|---|---|---|
| Level II reflectivity | `reflectivity` | `dBZ` | accepted |
| Level II base velocity | `base_velocity` | `m/s` | not accepted as N0S |
| Level III product 56 | `storm_relative_velocity` | `kt` | accepted |

N0S interrogation reads the copied categorical threshold value. It never applies the Level II linear raw/scale/offset equation.

## Packaged WebView2 evidence

```powershell
npm run test:phase6:packaged
```

The ignored detailed evidence is written to `artifacts/phase-6/`. Two consecutive release-build process starts passed with no acceptance failures.

| Gate | Pass 1 | Pass 2 |
|---|---|---|
| WebView2 runtime | Edge/Chromium 150 | Edge/Chromium 150 |
| Hardware renderer | NVIDIA RTX 4080 / D3D11 | NVIDIA RTX 4080 / D3D11 |
| Reflectivity context reset | 20/20 restored; PASS | 20/20 restored; PASS |
| Visible receipt context epoch | old + 1 | old + 1 |
| Reflectivity recovery duration | under 0.4 s | under 0.4 s |
| Minimize/restore plus new paint | PASS | PASS |
| Offline resident step | PASS | PASS |
| DPR 1 framebuffer | 1280 x 720 | 1280 x 720 |
| DPR 2 framebuffer | 2560 x 1440 | 2560 x 1440 |
| N0S product/source/units | SRV / Level III N0S / kt | SRV / Level III N0S / kt |
| N0S context reset | 1/1 restored; PASS | 1/1 restored; PASS |
| Cold restart | PASS | PASS |

The current N0S frame uses about 0.49 MiB of retained CPU radar data and 0.17 MiB of GPU resources in the packaged report. The context-reset gate uses the browser's real `WEBGL_lose_context` extension rather than deleting Mistr's handles in a mock.

## Recovery truth checked by the gate

For both the 20-frame reflectivity loop and one-frame N0S display, acceptance requires:

- context epoch increments exactly once;
- selected observation remains unchanged;
- a new paint receipt names that observation and new epoch;
- the visible-frame-paint flag is true;
- recovery is not complete until current residency equals target residency; and
- the next playback step paints under the restored context.

## Unautomated check

Real Windows sleep/wake was not triggered by automation because it would suspend the user's workstation. CDP `Page.setWebLifecycleState(frozen)` was evaluated and rejected as a substitute because it deliberately disables `requestAnimationFrame`, unlike a system sleep/wake recovery test. The real sleep/wake check is `DRF-003`; it remains required before production adoption, but it does not invalidate the decoder, product-parity, or actual GPU-reset results above.

## Phase decision

The architecture is feasible. Phase 6 closes the two largest semantic/runtime unknowns: GustAVO can preserve true storm-relative velocity without tiles, and MapLibre/WebView2 can recover Mistr's custom GPU layer without stale paint truth. The next authorized phase is a feature-flagged GustAVO integration rehearsal; it must retain the existing tiled path and national mosaic.
