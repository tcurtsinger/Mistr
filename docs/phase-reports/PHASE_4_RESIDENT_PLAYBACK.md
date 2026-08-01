# Phase 4 — Resident 20-Observation Playback

**Status:** Complete on the primary Windows workstation

**Date:** 2026-07-31

**Scope:** Twenty real KTLX Level II base-reflectivity observations resident together, hard-cut playback, authoritative GPU paint receipts, repeated resource replacement, hot-path activity proof, and packaged 4K performance. No live chunks, velocity, context recovery, tiled fallback, or GustAVO integration claim.

## Result

**PASS** for the bounded Phase 4 scope on the primary workstation.

The packaged Tauri/WebView2 executable decoded 20 distinct hash-pinned public Level II archives through the existing Rust adapter and two-credit transfer broker. After each transfer, the frontend copied only compact CPU truth and released the bulk transfer lease. The custom layer then uploaded all 20 frames before playback began.

Two consecutive packaged 3840 by 2160 scenarios each completed 1,000 receipt-gated hard cuts while deterministic pan/zoom actions exercised MapLibre. Both runs recorded zero radar network, disk, decode, normalization, or bulk IPC activity; zero long tasks; 6.2 ms P95 frame duration; exact selected/painted/playhead agreement; and stable known resource allocations through five atomic loop replacements per run.

The durable playback contract is recorded in [`16_RESIDENT_PLAYBACK_DECISION.md`](../16_RESIDENT_PLAYBACK_DECISION.md).

## Packaged environment

| Property | Result |
|---|---|
| Shell | Release Tauri executable / WebView2 |
| Window and painted framebuffer | 3840 × 2160 |
| GPU | NVIDIA GeForce RTX 4080 |
| WebGL path | Hardware ANGLE / D3D11 |
| WebGL context epoch | 1 |
| Device pixel ratio | 1 |
| MapLibre | 6.1.0, public custom-layer and layer-order APIs |
| Scenario command | `npm run test:phase4:packaged` |

The runner verifies all ignored source fixtures, produces a release-like executable, starts it with a localhost-only WebView2 diagnostic port, resizes the real desktop window to 4K, runs two stability scenarios, writes bounded ignored evidence artifacts, and terminates the process. Browser/Vite-only rendering is not acceptance evidence.

## Real observation loop

The committed manifest's explicit `phase4KtlxReflectivityLoop` set pins 20 consecutive KTLX archive objects from the public `unidata-nexrad-level2` bucket. Other fixture sets may be added to the shared manifest without changing this loop. Raw binary objects remain ignored and are downloaded only through the fixed-host, hash-verifying fixture script.

| Property | Result |
|---|---:|
| Manifest observations | 20 |
| Distinct decoded observation IDs | 20 |
| First archive key time | 2024-05-20 20:21:03Z |
| Last archive key time | 2024-05-20 23:05:12Z |
| First decoded sweep time | 2024-05-20 20:21:03.421Z |
| Last decoded sweep time | 2024-05-20 23:05:12.891Z |
| Site/product | KTLX / lowest-sweep base reflectivity |
| Total packed bytes transferred during load | 158,636,800 bytes |
| Playback transfer bytes | 0 |

Every requested fixture ID must belong to `phase4KtlxReflectivityLoop` and exist in the manifest embedded into the Rust binary. The backend derives the cache path from that entry, bounds the read, verifies exact source length and SHA-256 before decode, and refuses arbitrary paths or IDs from unrelated fixture sets.

## Residency and allocation ledger

| Allocation scope | Bytes | MiB |
|---|---:|---:|
| Retained compact CPU truth, 20 frames | 53,098,240 | 50.638 |
| Known current radar GPU allocations | 53,099,312 | 50.639 |
| Known peak during atomic replacement | 106,197,552 | 101.278 |
| GPU target | 209,715,200 | 200.000 |
| GPU hard ceiling | 268,435,456 | 256.000 |

“Known GPU allocations” counts Mistr-owned texture and buffer bytes specified by format. It does not claim visibility into driver padding, MapLibre resources, browser surfaces, or the basemap's GPU memory.

The current allocation stayed exactly 53,099,312 bytes in every one of five replacements in both packaged runs. Replacement creates a complete temporary resource map, swaps it atomically, and then deletes the old map. The measured 106,197,552-byte peak therefore includes both frame maps plus shared resources and remains below the target, not merely the hard ceiling.

After the final paused, garbage-collected scenario, the seven-process Tauri/WebView2 tree recorded:

| Whole process tree | Result |
|---|---:|
| Aggregate working set | 879,587,328 bytes (838.84 MiB) |
| Aggregate private bytes | 1,059,655,680 bytes (1,010.57 MiB) |

Those whole-process figures include the 4K browser and GPU surfaces, MapLibre, basemap tiles/cache, WebView2, UI, diagnostics, and radar. They are not radar-only allocations. The exact Mistr-owned ledger above is the enforceable radar budget.

## Paint-truth state machine

Selection changes only a small in-memory resource selector and triggers a repaint. The playback controller cannot issue another selection while the prior selection awaits paint.

For every transition:

1. the controller requests a resident observation;
2. the renderer increments a selection sequence;
3. the custom layer draws that exact observation;
4. a WebGL fence proves GPU completion;
5. the renderer emits generation, observation, context epoch, selection sequence, draw sequence, timing, and framebuffer dimensions; and
6. only then does the controller update the public playhead.

Across both final runs, all 2,000 requested transitions produced a matching receipt in strict sequence. The final playhead measurement time matched the last-painted and selected observation. Unit tests separately demonstrate that selected intent may change while the public playhead remains on the prior painted frame.

## Zero hot-path work

The Rust activity ledger before each run was:

| Counter after residency | Value |
|---|---:|
| Radar network requests | 0 |
| Fixture disk reads | 20 |
| Decoder runs | 20 |
| Normalization runs | 20 |
| Bulk IPC transfers | 20 |
| Bulk IPC bytes | 158,636,800 |

After each 1,000-transition playback run, every Rust counter was unchanged. Renderer upload counters were also unchanged: zero frame uploads and zero uploaded bytes during both timing windows. The resulting hot-path deltas were all zero. The two small counter snapshots are control IPC; no packed radar bytes cross the boundary during playback. Basemap tile requests remain MapLibre's separate responsibility and are not mislabeled as selected-site radar work.

## Packaged 4K performance

The final repeatable runner performs two independent 1,000-transition scenarios. Each scenario first executes five complete resource replacements, waits 750 ms for resource deletion and diagnostics to settle, and then begins the playback timing window. Camera position changes every eight transitions across representative zooms 5.0, 5.8, 6.4, and 8.0.

| Measurement | Run 1 | Run 2 | Gate |
|---|---:|---:|---:|
| Completed hard cuts | 1,000 | 1,000 | 1,000 |
| Frame-duration P95 | 6.2 ms | 6.2 ms | < 16.7 ms |
| Main-thread tasks ≥ 50 ms | 0 | 0 | 0 recurring |
| Radar hot-path counter delta | all zero | all zero | all zero |
| Paint-truth sequence | PASS | PASS | PASS |
| Atomic replacements | 5/5 stable | 5/5 stable | stable |
| Stabilized JS heap after explicit diagnostic GC | 84,218,915 bytes | 89,206,275 bytes | ≤ 5 MiB bounded delta |

The 4,987,360-byte stabilized heap difference is 4.76 MiB and remains within the runner's 5 MiB bounded-stability tolerance. Raw pre-GC heap snapshots are retained in the evidence because they show why uncollected heap size is not treated as an allocation ledger.

Final renderer metrics after the second run:

| Renderer measurement | Result |
|---|---:|
| All-frame upload plus readback validation | 76.4 ms |
| First paint after upload | 8.5 ms |
| Resident switch-to-GPU-receipt P50 | 10.5 ms |
| Resident switch-to-GPU-receipt P95 | 11.9 ms |
| Resident switch-to-GPU-receipt P99 | 14.8 ms |
| Custom-layer draw CPU P95 | 0.9 ms |
| Total custom-layer draws in final process | 4,326 |

Frame duration is measured from `requestAnimationFrame` timestamps over the full packaged interaction window. Switch latency is the stronger per-transition value: it begins at selection and ends only when the selected draw's GPU fence completes.

## Automated regression coverage

TypeScript contains 54 tests across 14 files. Phase 4 additions cover:

- playhead hold until a matching paint receipt;
- rejection of non-resident scrub targets;
- controller/render-loop synchronization when replacement observations use new IDs;
- ordered, unique, same-generation/same-render-key loop validation;
- monotonic generation advancement across atomic replacements;
- nearest-rank frame timing and 50 ms long-task classification;
- draining buffered long-task observer records before the scenario is certified;
- exact Phase 4 fixture ID forwarding through the leased binary path; and
- rejection of path-like fixture input.

Rust contains 38 library tests plus five binary tests. Phase 4 additions cover:

- exactly 20 distinct embedded manifest entries;
- rejection of an unpinned fixture ID;
- monotonic, stage-specific activity accounting; and
- all earlier transfer-credit, stale-generation, archive-bound, decoder, and wire-format regressions.

## Reproduction and ignored evidence

Run:

```powershell
npm run fixture:download
npm run test:phase4:packaged
```

The packaged runner writes ignored artifacts under `artifacts/phase-4/`, including:

- `packaged-report-4k.json`;
- `packaged-scenarios-4k.json`;
- `packaged-summary-4k.json`;
- `packaged-process-memory.json`;
- `packaged-ui-4k.txt`; and
- `packaged-4k.png`.

No raw archive, generated executable, screenshot, process detail, local path, or diagnostic artifact is committed.

## Phase gate

- [x] Twenty distinct real observations are resident together.
- [x] Current and peak radar CPU/GPU allocations are explicit and below budget.
- [x] An already-resident selection produces the next authoritative GPU-complete paint receipt.
- [x] The playhead never claims unpainted selection intent.
- [x] Resident playback performs zero radar network, disk, decode, normalization, upload, or bulk IPC work.
- [x] Two packaged 4K interaction runs remain below 16.7 ms P95 with zero long tasks.
- [x] At least 1,000 transitions and repeated loop replacement complete without unbounded known-resource or stabilized-heap growth.
- [x] Standard MapLibre layers remain present before and after the radar layer.
- [x] The evidence is reproducible through a committed packaged runner.

**Decision:** Phase 4 passes on the primary workstation. Proceed to Phase 5 only after this pull request's demonstrated-defect review is resolved. Phase 5 remains responsible for live real-time chunks, incomplete-volume handling, and latency comparison. Phase 6 remains responsible for WebGL context-loss restoration and broader fault recovery.
