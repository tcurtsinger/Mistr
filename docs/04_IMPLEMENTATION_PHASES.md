# Implementation Phases

## Governing delivery rule

Each phase ends with evidence and a written result. A later phase does not begin merely because code exists. A failed mandatory exit criterion sends the work back for correction or stops the prototype.

No phase deletes or replaces GustAVO code. Mistr is built separately until the adoption decision.

## Phase 0 — Baseline and experiment harness

### Objective

Create a reproducible environment and baseline the existing radar behavior before implementing raw rendering.

### Work

- Record exact Windows, WebView2, GPU driver, Node, Rust, Tauri, MapLibre, and package versions.
- Pin a single primary benchmark workstation plus at least one lower-capability Windows machine or VM where hardware acceleration is available.
- Capture existing GustAVO tile-path traces for:
  - Initial 20-frame load.
  - Playback while stationary.
  - Playback while panning and zooming.
  - Zoom-7 handoff.
  - Rapid site changes.
  - Provider timeout.
- Define the fixture manifest format and acquire the first Level II objects.
- Build scripts that can hash fixtures and verify provenance without decoding them.
- Establish a result-report template.

### Deliverables

- Version manifest.
- Existing-path baseline report.
- Initial fixture manifest and checksums.
- Repeatable packaged-launch and trace instructions.

### Exit criteria

- Another clean checkout/machine can reproduce the baseline procedure.
- The package/runtime versions and test hardware are recorded.
- No Mistr performance claim depends on a browser-only run.

## Phase 1 — Decoder evaluation and numeric reference

### Objective

Prove that current Level II reflectivity data can be decoded correctly and deterministically before any GPU work.

### Work

- Implement the decoder adapter interface.
- Evaluate the pinned Rust candidate decoder against the initial corpus.
- Extract lowest-elevation reflectivity into Mistr's internal `NormalizedSweep`.
- Produce a small human-readable diagnostic dump for selected radials/gates.
- Compare numeric output to Py-ART/xradar or another independent decoder.
- Add malformed/truncated object cases.
- Record unsupported messages/variants.

### Deliverables

- Decoder decision record.
- Numeric comparison report.
- Unit/property/fuzz tests for bounds and truncation.
- Normalized-sweep diagnostic artifacts.

### Exit criteria

- Required current-format fixtures decode without unexplained disagreement.
- Exact sampled gate values, dimensions, azimuths, ranges, elevation, units, and timestamps match the oracle within documented tolerances.
- Malformed data fails without panic or unbounded allocation.
- Third-party decoder types do not escape the adapter.

### Stop condition

If current-format correctness cannot be established, do not proceed to WebGL. Decide whether to fork/fix the decoder, select another, or stop.

## Phase 2 — Packed wire format and binary IPC

### Objective

Transfer a normalized sweep from Rust to the WebView with bounded copies and deterministic validation.

### Work

- Finalize `PackedSweep v1` ADR.
- Implement Rust encoder and TypeScript parser.
- Use Tauri raw-byte IPC.
- Add length, offset, alignment, enum, version, and hash validation.
- Add cancellation/generation identity.
- Benchmark payload sizes, encode time, transfer time, parse time, and memory.
- Implement bounded transfer credits/backpressure.

### Deliverables

- Wire-format specification.
- Cross-language golden vectors.
- Corrupt-wire tests.
- IPC benchmark report in packaged Tauri.

### Exit criteria

- Golden vectors round-trip identically.
- Corrupt/hostile offsets and lengths are rejected.
- No bulk gate data uses JSON.
- Cancellation prevents old generations from reaching upload.
- One-sweep transfer stays within the declared size and time budget on the benchmark systems.

## Phase 3 — Static custom-layer renderer

### Objective

Render one decoded Level II reflectivity sweep correctly over MapLibre.

### Work

- Implement a small reference renderer if needed.
- Benchmark shared radial geometry versus polar-sampling quad.
- Choose one production candidate and document why.
- Implement value/mask/palette textures.
- Implement Web Mercator/geodesic placement.
- Render one fixture at multiple zooms and map positions.
- Add point interrogation and gate diagnostics.
- Verify MapLibre layers before/after radar are unaffected.

### Deliverables

- Renderer decision record.
- Alignment screenshots and numeric gate-marker comparisons.
- GL capability/resource report.
- Shader compile/link and static-render performance report.

### Exit criteria

- The selected sweep aligns with independent gate coordinates and trusted imagery.
- Raw values and palette colors agree with CPU interrogation.
- Normal MapLibre layers render correctly around the custom layer.
- The renderer does not depend on undocumented private MapLibre properties.

## Phase 4 — Resident 20-frame playback

**Status:** Complete on the primary Windows workstation. See [`phase-reports/PHASE_4_RESIDENT_PLAYBACK.md`](phase-reports/PHASE_4_RESIDENT_PLAYBACK.md) and [`16_RESIDENT_PLAYBACK_DECISION.md`](16_RESIDENT_PLAYBACK_DECISION.md).

### Objective

Prove the core game-loop property: after loading, playback is GPU-resident and independent of network/tile readiness.

### Work

- Allocate a bounded 20-frame loop.
- Implement atomic resource activation and eviction.
- Implement authoritative selection/paint receipts.
- Implement hard-cut playback, scrub, pause, latest dwell, and loading hold.
- Add network/disk/decode/IPC counters during playback.
- Exercise pan/zoom during playback.
- Run 1,000+ transitions and repeated loop replacement.

### Deliverables

- Resident playback trace.
- Memory-allocation ledger.
- Long-run stability report.
- Playback state-machine tests.

### Exit criteria

- An already-resident frame paints on the next render opportunity.
- Resident playback performs zero network, disk, decoder, and bulk IPC work.
- P95 frame time stays below 16.7 ms in the representative 4K scenario.
- Per-run resident selection-to-GPU-receipt P95 stays below 33.4 ms.
- Radar GPU memory remains at or below the target budget and never exceeds the hard ceiling.
- Timeline state never claims an observation that lacks a matching paint receipt.
- Repeated playback and replacement show no unbounded growth.

## Phase 5 — Real-time chunks and latency comparison

### Objective

Prove a reliable live acquisition path and measure whether it improves freshness.

### Work

- Implement rotating-volume discovery and chunk polling.
- Assemble start/intermediate/end chunks.
- Detect gaps, duplicates, rollover, late chunks, and cancellation.
- Decide whether lowest-sweep progressive publication is safe.
- Compare first safe raw paint with current IEM/NOAA frame availability.
- Run during quiet and active weather windows across multiple sites/VCPs.
- Preserve archive/completed-volume fallback.

### Deliverables

- Chunk state-machine tests.
- Live latency dataset and P50/P95/worst summary.
- Gap/failure-injection report.
- Freshness/fallback policy ADR.

### Exit criteria

- No incomplete or inconsistent sweep is labeled complete/current.
- The last complete frame remains visible during gaps.
- Site switches cancel old chunk pipelines without late publication.
- Latency is measured over enough observations to support a conclusion.
- Archive/fallback behavior is explicit and tested.

## Phase 6 — Product parity and packaged recovery

### Objective

Prove the required GustAVO semantics beyond reflectivity and survive real desktop lifecycle faults.

### Work

- Evaluate and pin a raw Level III `N0S` decoder path.
- Normalize `N0S` into the same renderer contract.
- Compare to IEM RIDGE for identical site/time products.
- Keep Level II radial velocity explicitly separate.
- Implement WebGL context-loss recovery.
- Test minimize/restore, display scale changes, GPU reset simulation, sleep/wake, offline/online transition, and app restart.
- Validate on packaged WebView2.

### Deliverables

- `N0S` parity report.
- Context/lifecycle recovery report.
- Product-labeling tests.
- Packaged Windows test artifacts.

### Exit criteria

- Mistr never labels base velocity as storm-relative velocity.
- `N0S` numeric/product metadata and visual output agree with trusted references.
- Context restoration recreates the visible frame first and then the loop.
- Recovery does not show stale data as current.
- Packaged results agree with deterministic fixture expectations.

## Phase 7 — GustAVO integration rehearsal

### Objective

Demonstrate safe coexistence with GustAVO without removing the tiled path.

### Work

- Produce an integration branch only after explicit authorization.
- Add feature flags for `tiled`, `raw`, and controlled fallback modes.
- Reuse Mistr's versioned wire and renderer modules with minimal adaptation.
- Preserve the national mosaic and zoom handoff.
- Run GustAVO's complete test/build/package gates.
- Compare raw/tiled side by side or through blind captures.
- Exercise warnings, overlays, cameras, panels, keyboard controls, and long-session behavior while raw radar plays.
- Generate rollback evidence.

### Deliverables

- Integration diff and architecture update.
- Full GustAVO regression report.
- Side-by-side evidence.
- Rollback drill report.
- Final go/no-go recommendation.

### Exit criteria

- Every Mistr adoption gate passes in GustAVO.
- Non-radar GustAVO behavior is unchanged or deliberately documented.
- The national mosaic/handoff remains truthful.
- Tiled selected-site radar can be restored without data migration or reinstall.
- No old code is deleted yet.

## Phase 8 — Adoption and later deletion

This phase is outside the prototype and requires separate approval.

Only after a defined observation period may the team consider:

- Making raw selected-site radar the default.
- Reducing or removing selected-site historical PNG caching.
- Deleting old look-ahead/readiness logic that has no national-mosaic responsibility.
- Keeping an emergency fallback for a further release window.

Deletion requires proof that the removed logic is no longer shared by national or other raster products.

## Effort and sequencing notes

- Unlimited token budget does not remove the need for phase boundaries.
- Decoder, wire, renderer, and real-time acquisition work are intentionally sequential because each depends on evidence from the previous boundary.
- UI polish should not run ahead of correctness.
- Derived products, dealiasing, tilt control, and crossfade are backlog items, not excuses to expand the feasibility spike.
