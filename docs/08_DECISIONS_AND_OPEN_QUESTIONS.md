# Decisions and Open Questions

## 1. Accepted decisions

### D001 — Build a bounded prototype, not a full rewrite

**Decision:** Mistr is a separate feasibility prototype for selected-site radar. It does not replace GustAVO or authorize an Electron/Qt/game-engine rewrite.

**Reason:** The proposed raw-radar path can be tested inside the current technology boundary and directly targets the recurring tile-readiness machinery.

### D002 — Keep the current shell stack for the prototype

**Decision:** Use Tauri 2, Rust, React, TypeScript, MapLibre GL JS, and WebGL2.

**Reason:** This proves compatibility with GustAVO and avoids mixing a renderer experiment with a platform migration.

### D003 — Selected-site raw radar only

**Decision:** Level II initially replaces only selected-site base reflectivity in the prototype.

**Reason:** Level II is per-site. National mosaicking is a separate scientific/data-engineering system.

### D004 — Preserve national mosaic separately

**Decision:** Keep the existing national mosaic and scale handoff during integration.

**Reason:** Removing it would be a product regression; stacking raw Level II sites is not an equivalent mosaic.

### D005 — Preserve SRV semantics via Level III `N0S`

**Decision:** Decode raw Level III code-56 `N0S` as the canonical `storm_relative_velocity` product. Level II velocity remains a distinct `base_velocity` product and cannot enter the SRV renderer path.

**Reason:** Storm-relative velocity is derived and is not present as the current `N0S` product in Level II. Phase 6 demonstrated exact structural parity against an independent decoder and spatial/category agreement with the identical IEM RIDGE observation; the accepted implementation record is [`18_LEVEL3_N0S_AND_CONTEXT_RECOVERY_DECISION.md`](18_LEVEL3_N0S_AND_CONTEXT_RECOVERY_DECISION.md).

### D006 — Use packed binary IPC

**Decision:** Bulk sweep values cross Tauri IPC as raw bytes with a versioned Mistr wire format, never JSON numeric arrays.

**Reason:** Payloads contain roughly millions of gates and require bounded transfer behavior.

**Accepted layout:** [`PackedSweep v1`](14_PACKED_SWEEP_V1.md) fixes the Phase 2 header, sections, integrity rules, generation identity, and two-credit transfer contract.

### D007 — Texture-oriented GPU representation

**Decision:** Reject a naïve six-vertices-per-bin mesh as the primary renderer. The measured Phase 3 production candidate is a six-vertex screen-space polar-sampling quad with native raw/status textures, a bounded irregular-azimuth lookup, and a palette texture.

**Reason:** The 20-frame memory goal depends on not duplicating geometry per gate and frame.

**Accepted record:** [`15_GPU_RENDERER_DECISION.md`](15_GPU_RENDERER_DECISION.md).

### D008 — Hard cuts establish correctness

**Decision:** Playback uses discrete measured frames with hard cuts first.

**Reason:** Crossfade is optional visual interpolation and must not complicate the base feasibility proof.

### D009 — Paint receipt is authoritative

**Decision:** The playhead follows an actual custom-layer paint receipt, not download, decode, upload, selection intent, source-loaded, or map-idle state.

**Reason:** Visible truth is the operator contract.

### D010 — Packaged WebView2 is mandatory

**Decision:** Browser-only evidence cannot pass adoption.

**Reason:** GustAVO's important radar divergences have occurred at the native WebView/custom-protocol boundary.

### D011 — Existing tiled radar remains until post-adoption observation

**Decision:** Integration is feature-flagged and reversible. Old selected-site tile code is deleted only after equivalence, fallback, and observation gates.

**Reason:** The prototype must not create an irreversible migration.

### D012 — No home-grown dealiasing in the prototype

**Decision:** Velocity dealiasing is deferred to separate scientifically validated work.

**Reason:** It is not a shader feature and requires algorithmic/meteorological validation.

### D013 — National is an explicit source, not a zoom handoff

**Decision:** The future top-level choices are `National` and `Site`. Mistr never switches between them automatically from camera zoom.

**Reason:** Explicit intent avoids blank/oscillating handoffs and prevents camera state from silently changing the product and timeline.

### D014 — NOAA MRMS is the National numeric source

**Decision:** Use NOAA `MergedBaseReflectivityQC` for CONUS. Mistr validates and renders NOAA's processed quality-controlled mosaic; it does not merge Level II sites or claim mosaic authorship.

**Reason:** This preserves numeric dBZ/status truth without recreating a scientifically complex mosaic or depending on provider-colored WMS tiles.

### D015 — One typed Radar Session Coordinator

**Decision:** `RadarSourceKey` is `{ kind: "site", siteIcao } | { kind: "national", domain: "conus" }`. One coordinator owns source intent, one active transition generation, painted-source truth, receipt acceptance, rollback, and persistence after paint.

**Reason:** UI state, data sessions, and renderers must not maintain independent source or timeline authority.

**Implemented result:** Merged Phase 1 supplies `RadarSessionCoordinator` and `SiteLevel2Session`; Phase 3 adds `NationalMrmsSession` behind the same acceptance/persistence boundary.

### D016 — Separate source sessions and renderers

**Decision:** Preserve the existing polar `SiteLevel2Session` and use `NationalMrmsSession` with a separate numeric-grid renderer. Do not pretend a gridded MRMS observation is a polar sweep or MapLibre tile loop.

**Reason:** The products have different geometry, decoding, working sets, and interrogation paths but must share transition and paint-truth semantics.

### D017 — Independent timelines, one painted source

**Decision:** Site and National never share or merge timelines, and Mistr never keeps two complete active loops. The old source may remain visible only until the replacement completely paints.

**Reason:** This preserves truthful source/time/age/dBZ identity and bounds resources during transition.

### D018 — National history separates retained from resident

**Decision:** Rust retains 20 exact MRMS observations while the GPU owns a bounded presentation-level working set. The architecture must support a later 30-observation diagnostic without replacing the schema, renderer, cache, timeline, or source coordinator.

**Reason:** Twenty full 7,000 by 3,500 native grids cannot fit the radar GPU budget.

### D019 — Playback locks to one common complete quality

**Decision:** Active playback and timeline dragging use the finest complete presentation level available for every playable National observation at the viewport. Fine selected-frame refinement occurs only after pause or scrub settle.

**Reason:** Missing fine detail must not stall motion or make frames alternate visibly between coarse and detailed quality.

### D020 — Strict product-specific MRMS decoding

**Decision:** Phase 2 accepts only anonymous HTTPS from the fixed NOAA MRMS host, exact `MergedBaseReflectivityQC_00.50` keys, and the reviewed GRIB2/PNG/grid/scaling/status structure. Unknown structure fails closed. The normalized value is the exact two-byte unsigned raw code plus GRIB metadata; observed fixtures never define the allowed value domain.

**Reason:** A bounded, reviewable adapter prevents provider errors or format drift from becoming numeric truth while still accepting valid rare codes that were absent from development data.

### D021 — `PackedGrid v1` is distinct from `PackedSweep v1`

**Decision:** A National frame uses one bounded big-endian manifest plus independently bounded, hashed numeric chunks carrying repeated generation/observation/content identity. It is not encoded as a polar sweep, a MapLibre source, or provider imagery. Both record types use the single existing global two-credit broker.

**Reason:** Rectilinear CONUS geometry and level/chunk residency differ fundamentally from a selected-site polar scan, while shared transfer ownership prevents a hidden second queue.

### D022 — Value-aware power-of-two National levels

**Decision:** Overview reduction preserves the strongest valid dBZ; if no valid source cell exists it preserves missing before no coverage. Integer-code averaging and ordinary mipmapping are forbidden. Phase 2's release diagnostic uses factor 4 and 256-cell interiors with one-cell halos.

**Reason:** CONUS overviews require reduction, but numeric/status truth and small storm features cannot be preserved by image averaging.

### D023 — Phase 2 remains diagnostic-only

**Decision:** Phase 2 may list, download, decode, generate levels, cache prepared data, and transfer `PackedGrid v1` only through hidden diagnostics. It may not install `NationalMrmsSession`, paint a National frame, publish National UI/timeline truth, or persist a National choice. A diagnostic run ends by restoring the established Site loop.

**Reason:** Source acquisition and wire safety can be reviewed independently without exposing a partially implemented product or weakening the old-source-visible paint contract.

**Phase 2 evidence:** The final packaged release run retained 30 exact compressed source objects in 44,094,473 bytes, decoded 30 distinct observations spanning 57.90 minutes, validated 840 factor-4 chunks, measured 96,243,964 bytes for 30 frames plus staging below the 200 MiB target, proved third-request backpressure at the shared two-credit limit, transferred the newest 28-chunk frame, and restored 20 KTLX Site residents. This is not renderer or product evidence.

### D024 — National receipts bind presentation coverage

**Decision:** National becomes paint truth only after every chunk required by one declared presentation factor and coverage version uploads, complete coverage draws, and its GPU fence completes. The receipt includes the observation/generation/hash, factor, coverage kind/version, chunk count, context epoch, timing, bytes, and framebuffer.

**Reason:** An observation identity alone cannot prove that a chunked viewport is complete or that a camera-old detail set is what the user sees.

### D025 — Phase 3 uses complete overview plus exact viewport detail

**Decision:** The static National home view uses the complete factor-4 domain. At high zoom, Phase 3 atomically replaces it with required factor-1 viewport chunks while retaining the old complete presentation during staging. Factor 2 is generated and wire-compatible for Phase 4 selection but is not required by the Phase 3 camera threshold.

**Reason:** This makes a full CONUS frame immediately usable, proves the exact renderer path, and bounds frontend/GPU ownership without pre-implementing playback quality locking.

### D026 — Smooth never bridges numeric status

**Decision:** National Native uses nearest-cell sampling at the active presentation level. Smooth may bilinearly interpolate only when all four source cells are valid; otherwise it falls back to the nearest valid sample or remains transparent for missing/no coverage. Interrogation always asks Rust's exact base grid.

**Reason:** Spatial presentation may soften cell edges but cannot invent precipitation across provider status boundaries or become numeric truth.

### D027 — Phase 3 is exactly one National observation

**Decision:** Phase 3 exposes one newest current National observation with disabled transport/scrub movement. It does not poll, backfill, retain a National loop, or reuse the Site timeline.

**Reason:** Static end-to-end paint, interrogation, handoff, and recovery are reviewable independently from the substantially larger Phase 4 history/residency/quality-lock subsystem.

### D028 — Phase 4 commits history only after complete GPU paint

**Decision:** Phase 4 keeps 20 exact chronological MRMS observations in Rust and one complete factor-4 presentation for every retained observation on the GPU. A current, predecessor, or strictly newer mutation remains provisional after its GPU fence receipt. Rust applies it with an identity-bound reversible journal, including ownership of any evicted oldest frame; renderer finalization occurs before Rust seals the journal. Rejection or context loss before finalization restores the prior complete chronology, residency graph, and painted observation.

**Reason:** Backend retention and visible GPU truth must change as one transaction. A download, decode, transfer, partial upload, or fence for a superseded generation cannot evict a valid timeline frame or change the UI.

### D029 — Phase 4 interaction suspends acquisition and locks common quality

**Decision:** Playback and active dragging reserve the resident working set, wait for in-flight acquisition/refinement to settle, and then perform no network, disk, grid decode, bulk IPC, or texture-upload work. At regional zoom, play first prepares the finest complete viewport presentation for every retained frame under the 200 MiB target: factor 1, then factor 2 if required, with factor 4 as the complete-domain fallback. Every transition uses the one locked factor. Camera changes cancel the old viewport work, keep the prior complete paint visible, and re-prepare one all-frame level before playback resumes. Exact point interrogation may continue through its separate latest-only bounded lookup path.

**Reason:** The retained loop must play at normal cadence without I/O stalls or visible coarse/detail alternation. User evidence showed that always locking factor 4 at regional zoom made Native visibly blocky and Smooth blurry even when exact viewport detail fit comfortably within the existing budget.

## 2. Decisions required before implementation

### Q001 — Level II decoder dependency

Options to evaluate:

- Current `nexrad-data`/related Rust crates pinned at exact revision.
- A maintained fork with Mistr fixes.
- A different decoder behind the same adapter.
- A minimal Mistr parser limited to current formats only, if dependencies fail the corpus.

Decision evidence: fixture correctness, malformed-input behavior, API stability, license, maintenance, and required patch size.

### Q002 — Production renderer representation

**Resolved:** Screen-space/bounding-quad polar sampling. The shared indexed grid remains a reference alternative; it measured 42,229,704 bytes and 2,638,080 triangles for the accepted fixture before value/status textures.

Candidates:

- Shared indexed radial geometry with value textures.
- Bounding-quad polar sampling.

Decision evidence: geospatial correctness, irregular-radial support, GPU/CPU time, memory, GL complexity, and context recovery.

### Q003 — Normalization grid

**Resolved:** Preserve native per-observation dimensions. Missing bearings are zero entries in a 4,096-bin azimuth lookup and remain transparent; do not pad or bridge them into invented coverage. Compatible observations may be grouped later, but Phase 4 may use separate bounded texture sets.

Questions:

- Preserve variable radial/gate dimensions per observation?
- Normalize to a maximum 720×1832 grid?
- How are missing radials represented without inventing coverage?
- Is one array texture feasible across all current observation layouts?

Decision evidence: corpus inventory and renderer benchmark.

### Q004 — Real-time publication boundary

**Resolved for Phase 5 reflectivity:** Publish after the decoder proves one complete lowest elevation with an explicit scan/elevation start, an explicit elevation/scan end, known radial statuses, unique source azimuth numbers, and complete reflectivity geometry. Do not wait for the rest of the volume solely for playback.

The accepted boundary is conditional, not a general claim about every future product. Phase 5 compares the early sweep's raw codes, detailed gate statuses, and azimuths with the same sweep decoded again from the completed volume. Any future VCP/message/product that fails those invariants is rejected and falls back; it does not weaken the boundary.

**Accepted record:** [`17_REALTIME_FRESHNESS_AND_FALLBACK_DECISION.md`](17_REALTIME_FRESHNESS_AND_FALLBACK_DECISION.md).

Options:

- Publish after the lowest elevation's end boundary and required metadata are verified.
- Publish only after a complete volume.

Decision evidence: chunk/completed-volume comparisons and consistency across current VCPs.

### Q005 — Level III implementation language

**Resolved in Phase 6:** Use a Mistr-owned, bounded Rust parser for product 56 / `N0S` inside the common normalization boundary. Pin `nexrad-level-3-data@0.6.1` only as an independent development oracle. See [`18_LEVEL3_N0S_AND_CONTEXT_RECOVERY_DECISION.md`](18_LEVEL3_N0S_AND_CONTEXT_RECOVERY_DECISION.md).

Options:

- Rust decoder within the common backend normalization boundary.
- TypeScript/JavaScript decoder in a worker, outputting the same normalized model.
- Mistr-owned minimal Rust decoder validated against `nexrad-level-3-data`.

The selected path keeps one runtime language at the decoder boundary while avoiding dependence on an immature or absent general Rust Level III crate.

### Q006 — CPU retention for context restoration

**Resolved and confirmed for the resident-loop baseline:** Retain compact raw codes, detailed statuses, radial metadata (azimuth, beam width, and elevation), and azimuth lookup for every resident observation; release the packed float-value transfer after the compact copy. N0S additionally retains its categorical float values because they cannot be reconstructed with one linear scale/offset equation. Phase 4 measured 53,098,240 CPU bytes (50.638 MiB) and 53,099,312 known GPU bytes (50.639 MiB) for 20 real KTLX observations. Five atomic replacements per run peaked at 106,197,552 known GPU bytes (101.278 MiB). See [`16_RESIDENT_PLAYBACK_DECISION.md`](16_RESIDENT_PLAYBACK_DECISION.md) and [`18_LEVEL3_N0S_AND_CONTEXT_RECOVERY_DECISION.md`](18_LEVEL3_N0S_AND_CONTEXT_RECOVERY_DECISION.md).

Options:

- Retain all 20 normalized sweeps in renderer memory.
- Retain only visible/nearby sweeps and request replay from Rust cache.
- Shared/mapped representation if the platform safely supports it.

Decision evidence: total memory and context-restore latency.

### Q007 — GPU budget downgrade policy

If a device cannot hold 20 frames under the ceiling:

- Reduce resident loop count while preserving measured history on CPU/disk?
- Use eight-bit encoding when lossless for the product?
- Activate tiled fallback?

No silent degradation is allowed. The final policy must be visible and testable.

### Q008 — Crossfade

Decision deferred until hard-cut correctness/performance passes. If accepted, specify truth labeling, duration, missing-data behavior, and performance fallback.

### Q009 — Map camera modes

Confirm GustAVO's supported pitch, bearing, terrain, and globe constraints. Mistr should not accidentally promise modes that its polar transform has not validated.

### Q010 — Fixture storage

Decide Git LFS, release assets, internal artifact storage, or another durable mechanism based on corpus size and terms. The manifest and hashes always remain in source control.

## 3. Questions explicitly deferred beyond Mistr

- Full historical archive compatibility.
- Multi-elevation operator UI.
- Dual-pol product UX.
- Velocity dealiasing.
- Storm-motion derivation.
- 3D volume rendering and cross-sections.
- Derived products such as VIL, echo tops, hail, rotation, or storm tracking.
- National domains outside CONUS and additional MRMS products.
- Multi-radar/quad-pane view.
- macOS/Linux product support.
- Offline complete radar archive.

## 4. ADR template

Every material decision should create an ADR with:

```text
Title
Status: proposed | accepted | superseded | rejected
Date
Context
Decision
Alternatives considered
Evidence
Consequences
Risks and mitigations
Validation required
Supersedes / superseded by
```

Required ADRs before Phase 3:

- [x] Decoder selection/pinning: [`13_DECODER_DECISION.md`](13_DECODER_DECISION.md).
- [x] `PackedSweep v1` layout: [`14_PACKED_SWEEP_V1.md`](14_PACKED_SWEEP_V1.md).
- [x] GPU renderer representation: [`15_GPU_RENDERER_DECISION.md`](15_GPU_RENDERER_DECISION.md).
- [x] Normalization grid and missing-data semantics: [`15_GPU_RENDERER_DECISION.md`](15_GPU_RENDERER_DECISION.md).
- [x] CPU/GPU retention policy: [`15_GPU_RENDERER_DECISION.md`](15_GPU_RENDERER_DECISION.md).

Required ADRs before Phase 7:

- Real-time publication boundary.
- [x] Level III `N0S` decoder path: [`18_LEVEL3_N0S_AND_CONTEXT_RECOVERY_DECISION.md`](18_LEVEL3_N0S_AND_CONTEXT_RECOVERY_DECISION.md).
- Raw/tile fallback and source-preference policy.
- GustAVO feature-flag and observation-period policy.

Additional accepted prototype ADRs:

- [x] Resident playback, atomic replacement, and paint truth: [`16_RESIDENT_PLAYBACK_DECISION.md`](16_RESIDENT_PLAYBACK_DECISION.md).
- [x] Real-time publication boundary and fallback: [`17_REALTIME_FRESHNESS_AND_FALLBACK_DECISION.md`](17_REALTIME_FRESHNESS_AND_FALLBACK_DECISION.md).
- [x] Level III N0S and visible-first context recovery: [`18_LEVEL3_N0S_AND_CONTEXT_RECOVERY_DECISION.md`](18_LEVEL3_N0S_AND_CONTEXT_RECOVERY_DECISION.md).
- [x] National numeric-grid renderer, coverage receipts, and exact interrogation: [`28_NATIONAL_STATIC_RENDERER_DECISION.md`](28_NATIONAL_STATIC_RENDERER_DECISION.md).
- [x] National native-resolution residency — quality is never traded for memory on the supported desktop floor (owner, 2026-08-04): [`29_NATIONAL_RADAR_PERFORMANCE_FINDINGS.md`](29_NATIONAL_RADAR_PERFORMANCE_FINDINGS.md) §0.2.
