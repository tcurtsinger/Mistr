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

### D005 — Preserve SRV semantics via Level III evaluation

**Decision:** Evaluate raw Level III `N0S` for storm-relative velocity parity. Level II velocity remains labeled base/radial velocity.

**Reason:** Storm-relative velocity is derived and is not present as the current `N0S` product in Level II.

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

Options:

- Publish after the lowest elevation's end boundary and required metadata are verified.
- Publish only after a complete volume.

Decision evidence: chunk/completed-volume comparisons and consistency across current VCPs.

### Q005 — Level III implementation language

Options:

- Rust decoder within the common backend normalization boundary.
- TypeScript/JavaScript decoder in a worker, outputting the same normalized model.
- Mistr-owned minimal Rust decoder validated against `nexrad-level-3-data`.

Preferred architectural direction is one Rust normalization boundary, but evidence and dependency maturity decide.

### Q006 — CPU retention for context restoration

**Resolved and confirmed for the resident-loop baseline:** Retain compact raw codes, detailed statuses, radial metadata (azimuth, beam width, and elevation), and azimuth lookup for every resident observation; release the packed float-value transfer after the compact copy. Phase 4 measured 53,098,240 CPU bytes (50.638 MiB) and 53,099,312 known GPU bytes (50.639 MiB) for 20 real KTLX observations. Five atomic replacements per run peaked at 106,197,552 known GPU bytes (101.278 MiB). See [`16_RESIDENT_PLAYBACK_DECISION.md`](16_RESIDENT_PLAYBACK_DECISION.md).

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
- Raw/gridded national mosaic replacement.
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
- Level III `N0S` decoder path.
- Raw/tile fallback and source-preference policy.
- GustAVO feature-flag and observation-period policy.

Additional accepted prototype ADRs:

- [x] Resident playback, atomic replacement, and paint truth: [`16_RESIDENT_PLAYBACK_DECISION.md`](16_RESIDENT_PLAYBACK_DECISION.md).
