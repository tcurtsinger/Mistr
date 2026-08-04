# Test and Validation Plan

## 1. Test philosophy

Mistr is an evidence project. A visually convincing demo is necessary but insufficient.

Every material defect should be captured as a deterministic failing test before repair when technically possible. No fix is accepted because it “seems smoother” or because one live storm stopped reproducing.

Required validation layers:

1. Source-object integrity.
2. Decoder numeric correctness.
3. Normalization and wire correctness.
4. GPU rendering and geospatial correctness.
5. State-machine correctness.
6. Resource and performance bounds.
7. Live latency/reliability.
8. Packaged Windows lifecycle behavior.
9. GustAVO integration regression safety.

## 2. Fixture corpus

### 2.1 Manifest requirements

Every fixture has a manifest entry containing:

- Stable fixture ID.
- Source bucket and object key or documented alternate source.
- Acquisition timestamp.
- SHA-256.
- Compressed byte length.
- Radar site.
- Measurement/volume time.
- VCP and relevant metadata.
- Expected products/moments.
- Why the fixture exists.
- Independent decoder/tool versions used for expected results.
- Whether redistribution in the repository is permitted/appropriate.

Expected numeric samples are stored separately from the decoder under test.

### 2.2 Minimum Level II corpus

Include current-format examples covering:

- Quiet/clear-air scan.
- Widespread precipitation.
- Severe convection with high reflectivity gradients.
- Strong aliased velocity.
- Significant missing/no-data areas.
- Range-folded values.
- Multiple VCPs.
- Different lowest-elevation structures or split cuts.
- Eight-bit and sixteen-bit moment encodings if observed/currently relevant.
- Non-CONUS sites: Alaska, Hawaii, Puerto Rico, and Guam.
- Antimeridian/high-latitude stress where applicable.
- A volume with incomplete/corrupt data for negative testing.
- Real-time chunks captured from start through end.
- A chunk sequence with an intentional gap/duplicate/out-of-order delivery in the test harness.

### 2.3 Minimum Level III corpus

Include `N0S` fixtures for:

- Several CONUS sites.
- Quiet and severe-weather velocity fields.
- Missing/range-folded values.
- A timestamp with a matching IEM RIDGE product.
- At least one non-CONUS site if the product is present.
- Malformed/truncated negative cases.

### 2.4 Corpus immutability

- Fixture source bytes never change under an existing fixture ID.
- Expected-output changes require explanation and reviewer approval.
- Hash mismatch fails tests before decoding.
- New decoder versions run against the full corpus before adoption.

## 3. Decoder tests

### Unit tests

- Volume header parsing.
- Endianness.
- Compressed-record lengths.
- Message type recognition.
- Radial/elevation/volume boundaries.
- Moment block offsets.
- Scale/offset conversion.
- Missing/range-folded markers.
- Gate count and spacing.
- Azimuth/elevation normalization.
- Timestamp conversion.
- Bounds checking and decompression ceilings.

### Golden tests

For each accepted fixture:

- Radar identity and coordinates.
- Volume/sweep times.
- VCP/elevation metadata.
- Radial and gate counts.
- Selected radial azimuths.
- Selected raw gate codes.
- Selected physical values.
- Product extents.
- Stable normalized content hash.

### Differential tests

Compare Mistr output with an independent decoder for all common fields. Any disagreement must be categorized:

- Mistr defect.
- Oracle defect.
- Format ambiguity.
- Expected normalization difference.
- Unsupported source variant.

“Looks plausible” is not an allowed resolution.

### Robustness tests

- Truncated file at every major boundary.
- Oversized declared message.
- Integer overflow in offsets/counts.
- Invalid compression block.
- Duplicate radials.
- Missing end-of-elevation/end-of-volume.
- Inconsistent word sizes.
- Unexpected product/moment.
- Allocation limits.
- Decoder panic containment.

Use fuzzing/property testing where practical, seeded for reproducibility in CI.

## 4. Wire and IPC tests

- Rust golden encoder output parsed by TypeScript.
- TypeScript-produced negative buffers rejected consistently.
- Schema version mismatch.
- Wrong magic/endian marker.
- Overlapping sections.
- Unaligned offsets.
- Section beyond total length.
- Invalid enum and incompatible flags.
- Hash mismatch.
- Cancelled/stale generation.
- Payload at maximum accepted size.
- Backpressure when renderer credits are exhausted.
- Rapid cancellation during transfer.
- Packaged WebView2 transfer benchmark and memory snapshot.

## 5. Renderer correctness tests

### Static visual tests

For pinned fixtures and camera configurations, capture:

- Full radar range.
- Near-radar gates.
- Far-range gates.
- Cardinal directions.
- Screen edges.
- Several map zoom levels.
- High-DPI scaling.
- Non-CONUS sites.
- Transparent/missing/range-folded cases.

Use golden screenshots only after numeric and geospatial truth is established. Image diffs have explicit thresholds and require human review when updated.

### Geospatial tests

- CPU-compute selected gate centers independently.
- Place diagnostic markers at those coordinates.
- Measure pixel separation from rendered gate centers/regions.
- Repeat after pan, zoom, resize, device-scale change, and style reload.
- Verify operational range boundary.
- Verify no radial wrap seam or missing-radial bridge.

### Palette tests

- Every raw code/sample maps to expected color/alpha.
- Missing and range-folded policies are distinct.
- Palette replacement changes colors without changing values or re-uploading the observation texture.
- CPU point interrogation and rendered palette agree.

### GL coexistence tests

- Basemap labels remain correct.
- Warning polygons and other reference layers retain z-order.
- Radar does not corrupt MapLibre state.
- Style reload removes/re-adds resources correctly.
- Layer disable/removal releases resources.

## 6. State-machine tests

Use a deterministic fake clock and scripted acquisition/decoder/upload stages.

Required sequences:

- Normal archive load to paint.
- Real-time chunks to complete sweep.
- Decode failure.
- Upload failure.
- Next frame delayed while current remains visible.
- Rapid site change during download, decode, transfer, and upload.
- Product change during paint.
- Old generation completes late.
- Duplicate observation.
- Out-of-order measurement times.
- Playback reaches newest frame.
- Scrub to resident and non-resident frames.
- Pause/resume.
- WebGL context loss while playing and while uploading.
- Typed Site/future-National transition while the old source remains painted.
- A newer source request superseding an older transition before acquisition, transfer, and paint completion.
- Matching paint acceptance followed by persistence.
- Failed replacement rolling back to prior painted-source truth without persistence.
- Stale source, generation, or observation receipts being rejected.
- Raw failure activates tile fallback.

Invariant assertions:

- UI playhead equals the last accepted paint receipt.
- No observation from an old generation becomes selected.
- At most one observation is authoritative for selected-site display.
- Resident implies current-context resources exist.
- Context epoch mismatch prevents draw.
- Failure never marks data fresh.
- Resource counts remain within budget.
- Requested-source intent never replaces painted-source UI truth before receipt acceptance.
- Persistence occurs only for the current intentional transition after matching GPU paint.

### Phase 1 source-coordinator regression gate

The behavior-preserving coordinator phase must prove:

1. `RadarSourceKey` exhaustively distinguishes selected Site from the future CONUS National source.
2. `SiteLevel2Session` passes the coordinator-owned generation into the existing qualified Level II acquisition and replacement path.
3. Starting a newer transition makes every older completion non-authoritative.
4. Failure clears the pending request but retains the previous painted source and observation.
5. A mismatched source or stale generation receipt cannot paint, persist, or change the selected source.
6. Startup's safe archive paint does not overwrite the stored intended live site.
7. Diagnostic archive/Phase 5 transitions preserve their public APIs without changing persistence.
8. `window.__MISTR_PHASE4__`, `window.__MISTR_PHASE5__`, and `window.__MISTR_PHASE6__` remain callable by their existing packaged runners.

Phase 1 exit requires `npm run verify`, documentation and public-repository checks, whitespace validation, and the existing packaged Phase 4, 5, and 6 paths. An unavailable packaged path is reported as unverified rather than silently passed.

### National Phase 2 acquisition and wire gate

Phase 2 adds source, cross-language, and packaged checks without weakening any Site gate:

1. Exact object-key parsing rejects wrong products, paths, dates, timestamps, and hosts.
2. Inventory parsing rejects foreign/truncated/malformed listings and orders candidates by measured observation time rather than response order.
3. Response and expansion bounds reject oversized compressed/GRIB/PNG/normalized data and HTML/XML bodies returned with HTTP 200.
4. The strict decoder rejects mutations to GRIB discipline/edition, section order, product, grid, Template 5.41 metadata, bit depth, scaling, bitmap/status, PNG shape/color/interlace, and filename/message time identity.
5. Four seasonal NOAA samples compare every cell with independent ecCodes output; committed expected data contains hashes and small samples only.
6. Synthetic raw codes absent from the oracle, including the structural endpoints, decode through the accepted GRIB formula rather than an observed-value lookup table.
7. Strongest-valid overview reduction and missing/no-coverage priority are unit tested.
8. Rust emits one `PackedGrid v1` manifest and chunk fixture that TypeScript parses and validates for source, grid, encoding, string/descriptor bounds, big-endian values, identity, and payload SHA-256.
9. Corrupt manifests, chunks, geometry, length, reserved bytes, and payload hashes fail closed.
10. National manifest/chunk transfers use the existing global broker; two concurrent leases succeed, a third returns `credit_exhausted`, and all credits return after release.
11. The release/WebView2 diagnostic acquires and decodes 30 distinct current observations, simultaneously retains all 30 immutable compressed source objects, validates all 840 factor-4 chunks, proves the unchanged schema/renderer model below the 200 MiB target, transfers the newest complete working set, and restores the 20-frame KTLX Site loop without painting National.

The dedicated packaged command is `npm run test:national:phase2:packaged`. Its report is generated under ignored `artifacts/national-phase-2/`. Phase 2 exit also requires `npm run verify`, `npm run docs:check`, `npm run public:check`, `git diff --check`, and unchanged packaged Phase 4, 5, and 6 regressions. The hidden `window.__MISTR_NATIONAL_PHASE2__` API is diagnostic-only; `window.__MISTR_PHASE4__`, `window.__MISTR_PHASE5__`, and `window.__MISTR_PHASE6__` remain unchanged.

### National Phase 3 static-renderer gate

Phase 3 adds source, renderer, UI, and packaged checks without beginning history/playback:

1. Coverage helpers require unique in-range chunks and prove factor-4 complete-domain versus factor-1 viewport selection.
2. Working-set tests prove no receipt before all required chunk uploads, one lease release per success/failure path, and prior-presentation rollback on partial failure.
3. Sampling tests cover raw-code formula endpoints, Native nearest-cell truth, Smooth spatial interpolation, and the ban on interpolation across missing/no-coverage status.
4. `NationalMrmsSession` tests cover accepted paint/persistence, acquisition failure rollback, supersession, and stale receipt rejection through the shared coordinator.
5. Rust exact point tests prove valid, missing, and no-coverage results from the retained base grid and reject generation/time/hash drift.
6. The packaged release run paints one complete factor-4 CONUS observation, refines to a bounded factor-1 viewport, and requires matching coverage-aware GPU receipts after fences.
7. The run proves Native/Smooth change only spatial pixels, exact lookup remains tied to painted identity, and green age semantics are newest-for-source rather than cross-source recency.
8. Real `WEBGL_lose_context` recovery must increment context epoch while preserving observation, presentation factor, coverage version, and no-network local rehydration.
9. Site-to-National and National-to-Site transitions retain the old renderer until replacement paint and end with one settled source/timeline.
10. The final shared broker snapshot must retain exactly two credits with zero held or in-flight ownership.

The dedicated command is `npm run test:national:phase3:packaged`; reports and 4K screenshots are generated only under ignored `artifacts/national-phase-3/`. Phase 3 exit also requires `npm run verify`, `npm run docs:check`, `npm run public:check`, `git diff --check`, and unchanged packaged Phase 4, 5, and 6 regression commands. Hidden `window.__MISTR_NATIONAL_PHASE3__` is evidence-only; the existing Phase 4/5/6 APIs remain required.

### National Phase 4 history and playback gate

Phase 4 adds bounded-history, transaction, residency, and playback tests without weakening the merged one-frame or Site paths:

1. Backend store tests prove current/predecessor/newer chronology, identity mismatch rejection without losing the staged transaction, 20-frame one-oldest eviction, and the same store/snapshot model at a non-shipping 30-frame limit.
2. Working-set tests prove every lease releases, a complete GPU fence remains provisional until backend commit, and supersession after the fence repaints the prior presentation.
3. Playback tests prove factor-1/factor-2 all-frame viewport preparation, factor-4 fallback, cancellation cleanup, and a uniform quality lock. Direct scrub waits while common residency is incomplete after context loss, and complete texture counts cannot release that barrier until the renderer has repainted, fenced, published a receipt, and left provisional state. Fine refinement waits for pause/settle, an active camera move cancels and re-prepares before resuming, overview camera changes do not create a refinement loop, and the same controller accepts the diagnostic 30-frame cap.
4. Polling/backfill may run only outside a resident-only activity reservation. The measured 1,000-transition and scrub intervals require zero network, response, decode, IPC, point-decode, and upload deltas. The packaged runner holds one outer evidence-only reservation across the initial history snapshot, transitions, scrubs, and exact inspection so a normal live rollover cannot make one assertion compare different valid timelines.
5. The packaged release run retains 20 exact chronological observations, spans at least 30 minutes, and keeps every factor-4 common presentation GPU resident below the 200 MiB target and 256 MiB hard ceiling.
6. Oldest/newest direct scrub and 1,000 chronological transitions require matching generation/observation/content/presentation receipts without disk, network, decode, IPC, or upload work.
7. High-zoom pause refines the selected exact factor-1 viewport and bounded adjacent temporal window while all 20 common presentations remain complete. Active regional play prepares the finest all-frame viewport level that fits the 200 MiB target, requiring factor 1 or factor 2 for all 20 observations in the packaged camera, then keeps that quality locked. The measured playback interval permits identity-bound point lookups but requires zero new acquisition, grid decoding, bulk IPC, texture uploads, or mixed-factor receipts.
8. Exact point lookup must name one retained painted identity; a late identity result is rejected, and a persistent map inspection is re-queried after every playback or scrub observation cut before a new value appears. Deterministic queue tests prove only one expensive lookup runs at a time, multiple waiting receipts collapse to the newest, every superseded or cancelled pending caller settles immediately with no result, and a request arriving during drain settlement cannot be stranded; packaged playback requires the queue to drain with no pending work after pause.
9. A backend commit remains reversibly journaled until renderer finalization; simulated post-fence cancellation/context loss restores an evicted oldest frame and the prior GPU graph before either side can publish. If detail replacement occurs while that journal exists, its uniquely owned prior detailed frame must remain included in reversible and total backend bytes until finalization. Before renderer finalization, identity-bound rollback must continue beyond three ambiguous local IPC failures until Rust responds or an exact snapshot proves that staged/reversible state and the candidate are gone. After renderer finalization, frontend sealing follows the equivalent unbounded-attempt/capped-delay contract; an identity-matching non-reversible snapshot may recover a lost successful response, and repeating the same finalization remains idempotent.
10. Real `WEBGL_lose_context` recovery increments context epoch, restores the selected observation and all 20 common residents from CPU-owned bytes, and records zero backend activity. A second forced loss after renderer finalization but during backend sealing must publish only the recovered current-context receipt.
11. A forced Site failure after it cancels National must preserve the old National paint, pause and await active resident playback, start a newer National generation, restart backfill, and restore matching backend, renderer, coordinator, and transfer ownership before the normal successful Site handoff.
12. A Site request that arrives during National acquisition/finalization must wait for that observed transaction before advancing the shared generation, then revalidate that its transition still owns source intent.
13. Repeating detail preparation for the same generation, observation, hash, and factor must return the same cached packed frame without incrementing decoder work; mismatched factor or identity must miss the cache.
14. A transient predecessor prepare/commit failure must leave the candidate eligible, wait through capped jitter/backoff, and retry it before newer-only polling; a successful predecessor resets the backoff attempt and source supersession stops without another delay.
15. National playback controls remain disabled until at least two retained observations have complete common residency and authoritative paint truth. Once usable, they remain enabled while a new observation stages against that prior complete resident set; the bounded atomic residency mutation, recovery, or incomplete common coverage may still hold them. Deterministic and packaged checks must observe an enabled Play button during partial-history staging.
16. The packaged Phase 3 regression must await an already-active camera refinement rather than returning a stale overview report while exact chunks are staging.
17. Finalizing a strictly newer observation must release the prior current frame's optional exact-pyramid cache so later factor-1 preparation remains within the backend target even if polling wins the cadence race before refinement.
18. A successful National-to-Site transition must disable new National playback input, pause and await an in-flight frame fence, settle refinement/working-set activity, and reject any defensive removal waiter before destroying the National layer.
19. A healthy `mrms_not_strictly_newer` result after a transient poll failure must clear the stale request error and reset base cadence. A transient delay-command failure must use bounded local backoff and continue the same polling loop; it cannot require a source restart.
20. The final renderer must pass two consecutive exact-code Phase 4 packaged runs after any upload-band change. Both initial/detail/recovery paths must stay under 4 ms without changing the threshold.
21. A painted National renderer snapshot clears a prior playback/recovery error, while recovering or failed snapshots retain the matching diagnostic until a successful repaint.
22. Retrying predecessor or newer preparation after its response is lost must return the exact matching Rust stage with `reused: true` and zero repeated acquisition; frontend validation accepts that all-zero metric shape, rejects unmarked zeros, and a different staged mutation kind remains a hard error.
23. The final broker has two credits and zero held/in-flight ownership, and a National-to-KTLX transition ends with one settled Site timeline.

The dedicated command is `npm run test:national:phase4:packaged`; reports and 4K screenshots are generated only under ignored `artifacts/national-phase-4/`. Phase 4 exit also requires `npm run verify`, documentation/public/whitespace checks, the merged National Phase 2 and 3 packaged gates, and unchanged selected-site Phase 4, 5, and 6 packaged regressions. Hidden `window.__MISTR_NATIONAL_PHASE4__` is evidence-only; all earlier diagnostic APIs remain required.

## 7. Performance plan

### Test scenarios

1. Stationary 20-frame playback.
2. Continuous pan during playback.
3. Repeated zoom across the handoff threshold.
4. Rapid scrub.
5. Site switch with old loop visible.
6. Palette change.
7. Four-hour synthetic long session.
8. Context loss and rehydration.
9. Lower-capability GPU.
10. Map with representative GustAVO overlays enabled during integration rehearsal.

### Mandatory measurements

- Initial raw bytes downloaded.
- Decode and normalize duration per observation.
- Packed bytes per observation.
- IPC duration and peak queued bytes.
- GPU upload duration.
- First paint latency.
- Resident frame switch to paint latency.
- Browser main-thread long tasks.
- P50/P95/P99 frame duration.
- Total process CPU and memory.
- Renderer CPU memory.
- Estimated GPU allocations.
- Network/disk/decode/IPC counters during resident playback.

### Core performance gates

- P95 frame duration below 16.7 ms in the representative 4K playback/interaction scenario.
- Per-run resident selection-to-GPU-receipt P95 below 33.4 ms, covering the selected draw and non-blocking fence observation by the following 60 Hz opportunity.
- No recurring main-thread task over 50 ms caused by Mistr during resident playback.
- Zero network, disk, decode, normalization, and bulk IPC activity during resident loop playback.
- GPU radar allocations at or below 200 MiB target and never above 256 MiB hard ceiling for the initial 20-frame product loop.
- No positive memory trend after stabilization in repeated transition/site-switch tests.

If a machine cannot meet the 60 FPS target, report the exact bottleneck and fallback behavior rather than hiding the result.

## 8. Latency and source comparison

Measure a sufficiently broad live sample across multiple sites and weather regimes.

For each comparable observation:

- Radar measurement time.
- First chunk seen.
- Safe lowest-sweep completion.
- First Mistr paint.
- NOAA WMS comparable timestamp appearance.
- IEM comparable timestamp appearance.
- Complete archive-object appearance.
- Retries/errors/gaps.

Report:

- Count and coverage period.
- P50/P95/worst latency for each path.
- Percentage raw path wins/ties/loses.
- Gap/failure rate.
- Difference between quiet and active weather.
- Any site/VCP pattern.

The prototype succeeds on architecture even if raw latency is not always faster, but the result affects product/fallback policy.

## 9. Fault injection

The harness must inject:

- Slow listing/download.
- HTTP timeout and connection reset.
- Non-success status.
- Oversized response.
- Duplicate/out-of-order/missing chunks.
- Corrupt compression.
- Decoder panic/error.
- Slow decode.
- Stale generation completion.
- IPC cancellation and renderer backpressure.
- GPU allocation/upload failure simulation.
- WebGL context loss.
- Style reload.
- Window resize and device-scale change.
- Sleep/wake and offline/online transitions.
- Raw-source failure with tile fallback available/unavailable.

Every injection has an expected visible state, log sequence, resource outcome, and recovery path.

## 10. Packaged Windows matrix

Minimum packaged verification:

| Dimension | Coverage |
|---|---|
| Windows | Windows 11 primary; supported Windows 10 if GustAVO continues to support it |
| WebView2 | Current installed stable; record exact version |
| GPU | Primary discrete/integrated GPU plus one materially different vendor/capability where available |
| Display | 1080p and 4K; 100% and high-DPI scaling |
| Window | Maximized, restored, resized, minimized/restored |
| Power | Normal session and sleep/wake |
| Network | Normal, throttled, disconnected/reconnected |

Browser-only Playwright tests remain useful for deterministic custom-layer logic but cannot satisfy the packaged-runtime gate.

### Phase 6 primary-machine result

Two consecutive packaged WebView2 cold-start passes completed on Windows 11 with hardware-accelerated NVIDIA rendering. Both passes exercised a 20-frame resident reflectivity loop, actual WebGL context loss/restoration, visible-first recovery, post-recovery paint, minimize/restore, disconnected resident playback, 1x/2x device-scale overrides, explicit `N0S` labeling/interrogation, an `N0S` context reset, and two cold restarts. Detailed generated logs remain ignored; the reproducible evidence summary is [`phase-reports/PHASE_6_N0S_AND_CONTEXT_RECOVERY.md`](phase-reports/PHASE_6_N0S_AND_CONTEXT_RECOVERY.md). Sleep/wake was unavailable to honest automation and remains DRF-003.

## 11. Adoption gates

All are mandatory unless explicitly reclassified through a documented decision:

1. **L2 numeric correctness:** trusted-reference agreement.
2. **L3 `N0S` parity:** no product substitution or mislabeled base velocity.
3. **Geospatial correctness:** tested gate alignment across representative sites/zooms.
4. **Resident playback:** no hot-path I/O/decode/bulk IPC.
5. **Performance:** frame-time and long-task budgets pass.
6. **Memory:** CPU/GPU resources are bounded and leak-free in long-run tests.
7. **State truth:** playhead follows actual paint receipts.
8. **Real-time robustness:** gaps, rollover, cancellation, and fallback pass.
9. **Context recovery:** WebGL loss/restoration passes.
10. **Packaged WebView2:** deterministic results and performance pass outside browser dev.
11. **Latency measured:** comparison report exists; no unverified speed claim.
12. **Fixture corpus pinned:** provenance, hashes, numeric expectations, and negative cases exist.
13. **Debuggability:** one command produces a sufficient diagnostic bundle.
14. **Integration safety:** GustAVO non-radar regressions pass.
15. **Rollback:** tiled radar restoration is rehearsed.

## 12. Go/no-go report format

The final report must state:

- Exact commit/build and environment.
- Each gate: pass, fail, or unavailable.
- Evidence artifact for every pass.
- Demonstrated defects and their visible consequence.
- Performance and memory tables.
- Latency tables.
- Unsupported cases.
- Remaining risks.
- Recommendation: integrate, extend prototype, redesign, or stop.

Unavailable evidence is uncertainty, not a pass.
