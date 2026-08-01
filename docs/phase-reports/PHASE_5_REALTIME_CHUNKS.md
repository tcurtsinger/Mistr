# Phase 5 â€” Real-Time Chunks and Latency

**Status:** Complete on the primary Windows workstation

**Date:** 2026-08-01 UTC

**Scope:** Anonymous public Level II real-time chunk discovery, bounded assembly, safe lowest-sweep publication, complete-volume comparison, source latency observation, generation cancellation, last-complete fallback truth, and packaged 4K live paint. No velocity, national mosaic, context recovery, multi-machine claim, or GustAVO integration.

## Result

**PASS** for the bounded Phase 5 scope.

Mistr discovered rotating real-time volumes, assembled strict start/intermediate/end sequences, progressively decoded only physically complete lowest reflectivity sweeps, and compared each published candidate with the same sweep decoded from its completed volume. The reviewed dataset contains `14` fresh observations across `8` sites and three observed VCPs (`35, 212, 215`). Every early/complete comparison matched exactly.

In this observation window, safe decode completed `26411` ms before NOAA at P50 and `27828` ms before IEM at P50, with a five-second provider-poll uncertainty. This supports proceeding with the raw selected-site architecture; it does not promise that raw always wins.

The release packaged runner also proved the end-to-end path. It cancelled a superseded KAMX request, published only the current KTLX generation, parsed 7,931,840 packed bytes, atomically replaced the prior archive loop with one live frame, and received a matching hardware GPU-complete receipt at 3840 by 2160. Safe-decode-to-paint was 80 ms in that run.

The governing boundary and fallback decision is [`17_REALTIME_FRESHNESS_AND_FALLBACK_DECISION.md`](../17_REALTIME_FRESHNESS_AND_FALLBACK_DECISION.md).

## Public source evidence

The implementation used no credentials.

| Source | Role |
|---|---|
| `unidata-nexrad-level2-chunks` | Rotating real-time source objects |
| `unidata-nexrad-level2` | Completed-volume availability observation and fallback source |
| NOAA selected-site `sr_bref` WMS capabilities | Second-resolution comparator inventory |
| IEM RIDGE `N0B` inventory | Minute-resolution comparator inventory |

AWS and NCEI describe the Level II real-time/archive resources and ordered real-time blocks in the [AWS Open Data entry](https://registry.opendata.aws/noaa-nexrad/) and [NCEI decoding documentation](https://www.ncei.noaa.gov/products/radar/decoding-utilities-examples). Binary interpretation remains grounded in [ROC ICD 2620010J](https://www.roc.noaa.gov/public-documents/icds/2620010J.pdf).

## Observation matrix

The committed reviewed dataset is [`fixtures/expected/phase-5/live-latency-dataset.json`](../../fixtures/expected/phase-5/live-latency-dataset.json). It contains public timestamps, dimensions, VCPs, normalized hashes, comparison booleans, and derived latency only. Raw chunks, complete archives, provider bodies, local executable copies, stdout/stderr, and screenshots remain ignored.

| Property | Result |
|---|---:|
| Fresh observations | `14` |
| Sites | `KABR, KAMX, KBOX, KCBW, KDMX, KHGX, KRIW, KTLX` |
| VCPs | `35, 212, 215` |
| First safe sequence | chunk 7 in every fresh observation |
| Completed-volume comparisons | `14` |
| Exact raw/status/azimuth matches | `14` |
| Observed assembler gaps | `0` |
| Observed conflicting duplicates | 0 |

Echo coverage is retained as a reproducible fraction of valid reflectivity gates. The report uses â€œlower/higher echo coverage,â€ not an unsupported meteorological storm classification. The matrix includes `6` lower-coverage and `8` higher-coverage observations.

## Latency

All values are milliseconds. P50/P95 use nearest rank. â€œLead versus providerâ€ is provider first-observed time minus Mistr safe-decode completion; positive means Mistr was first. NOAA/IEM first-seen values carry up to 5,000 ms polling uncertainty. S3 `Last-Modified` is second-resolution and uses a different clock from local decode completion, so the `-240` ms minimum is treated as timestamp uncertainty, not as decoding before availability.

| Measurement | Samples | Minimum | P50 | P95 | Worst |
|---|---:|---:|---:|---:|---:|
| Lowest-sweep end to raw availability | `14` | `1290` | `1804` | `2767` | `2767` |
| Raw availability to safe decode | `14` | `-240` | `537` | `1332` | `1332` |
| Lowest-sweep end to safe decode | `14` | `1970` | `2589` | `3226` | `3226` |
| Safe-decode lead versus NOAA | `13` | `17503` | `26411` | `81753` | `81753` |
| Safe-decode lead versus IEM | `14` | `16215` | `27828` | `93124` | `93124` |
| Volume start to completed archive observation | `14` | `243536` | `326330` | `521375` | `521375` |

## Safety and failure behavior

The Mistr-owned assembler enforces:

- canonical four-character site and rotating index `1..=999`;
- exact `YYYYMMDD-HHMMSS-NNN-T` key shape;
- 4 MiB per chunk, 64 MiB per volume, and 256 chunks per volume;
- `001-S` as the first object;
- contiguous publication and a terminal `E` sequence for volume completion;
- identical-duplicate no-op versus conflicting-duplicate rejection;
- late-object ignore and explicit incomplete rollover evidence; and
- generation cancellation before each network/decode/publication boundary.

The progressive decoder additionally requires a physical first-radial start and last-radial end, rejects unknown statuses and duplicate source azimuth numbers, and permits publication only once for a volume. Missing reflectivity or an incomplete boundary means â€œnot safe yetâ€; other decoder errors fail closed.

Deterministic tests cover gaps, out-of-order delivery, duplicates, terminal ordering, rollover, late chunks, payload mismatch, site/generation mismatch, single-use publication, fixed-host rejection, bounded XML/provider parsing, rotating-index wrap, cancellation, atomic evidence publication, and the display fallback reducer.

## Fallback and truth

The UI keeps the last GPU-painted complete frame during acquisition and on error. Its explicit source ladder is:

1. safe real-time Level II chunks;
2. completed Level II archive; then
3. existing provider tiles.

The Phase 5 prototype starts from the Phase 4 completed archive loop, so a gap/error has real known-good radar to retain. It never converts an assembler prefix into a timeline/current label. Dynamic archive and provider-tile adapters are deliberately retained as Phase 7 integration seams rather than duplicated inside this spike.

## Packaged Windows evidence

Command:

```powershell
npm run test:phase5:packaged
```

| Gate | Result |
|---|---:|
| Shell | Release Tauri / WebView2 |
| Window and receipt framebuffer | 3840 Ã— 2160 |
| GPU path | Hardware ANGLE / NVIDIA RTX 4080 / D3D11 |
| Superseded request | KAMX rejected with `live_sweep_failed` |
| Current publication | KTLX generation 3 only |
| Packed live sweep | 7,931,840 bytes |
| Safe sequence in current catch-up run | 13 |
| Raw last-modified to safe decode | 4,702 ms |
| Safe decode to GPU receipt | 80 ms |
| GPU receipt observation match | PASS |
| Renderer selected/last-painted match | PASS |
| Incomplete UI label present | No |

The packaged run intentionally requests the current volume for a fast deterministic app gate, so its safe sequence is not used as earliest-progressive latency evidence. Fresh steady-state probes establish chunk 7 as the publication boundary. Ignored artifacts are written under `artifacts/phase-5/packaged/`.

The Phase 4 packaged regression was repeated against the transactional replacement path after review closure. It again passed both 1,000-transition 4K runs with zero long tasks, zero hot-path work, exact paint truth, at most 6.2 ms frame P95, at most 16.7 ms switch P95, 50.639 MiB current known GPU allocation, and a 101.279 MiB atomic-replacement peak.

## Automated coverage

- TypeScript/JavaScript: 81 tests across 20 files.
- Rust: 64 library tests plus seven binary tests.
- Full verification includes public-repository scanning, documentation links, TypeScript build, Rust formatting, Clippy with warnings denied, tests, and locked dependency checks.
- Live/provider and packaged gates are explicit manual acceptance commands and do not make CI depend on public weather services.

## Phase gate

- [x] No incomplete or inconsistent sweep is labeled complete/current.
- [x] Last complete GPU-painted radar remains visible during gaps/failures.
- [x] Site/generation switches cancel old acquisition without late evidence or publication.
- [x] Fresh latency observations cover multiple sites, echo-coverage conditions, and VCPs with explicit clock uncertainty.
- [x] Every early safe sweep matches its completed volume for raw codes, statuses, and azimuths.
- [x] Archive/provider fallback order is explicit and state-tested.
- [x] The real release/WebView2 app paints the exact live observation at 4K with hardware acceleration.
- [x] Phase 4 resident playback remains passing after renderer generalization.
- [x] No raw radar/provider payload, credential, machine path, or generated artifact is committed.

**Decision:** Phase 5 passes for the bounded reflectivity prototype. Proceed to Phase 6 after this pull request's demonstrated-defect review is resolved. Do not claim nationwide provider SLA, velocity parity, context recovery, or production GustAVO readiness from this phase.
