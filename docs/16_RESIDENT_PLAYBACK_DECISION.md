# Resident Playback and Paint-Truth Decision

**Status:** Accepted for the Mistr prototype

**Date:** 2026-07-31

**Scope:** Phase 4 selected-site reflectivity playback

## Context

Phase 3 proved that one real decoded Level II sweep could render correctly through a MapLibre WebGL2 custom layer. Phase 4 had to establish the property that motivates Mistr: once a measured loop is resident, advancing radar is no longer a tile-loading operation.

The decision had to preserve five truths at the same time:

1. twenty distinct observations remain bounded in CPU and GPU memory;
2. variable native radial layouts are not resampled into invented data;
3. a frame switch performs no radar network, disk, decode, normalization, upload, or bulk IPC work;
4. the UI playhead never advances ahead of an actual GPU-complete custom-layer draw; and
5. replacing a loop cannot expose a partially uploaded resource set.

## Decision

### One bounded resource set per measured observation

The renderer retains at most 20 ordered observations for one generation and render key. Every frame owns:

- one native `R8UI` raw-code texture;
- one `R8UI` detailed-status texture;
- one `R16UI` 4,096-bin azimuth lookup texture; and
- one `RGB32F` radial-metadata texture containing azimuth, half beam width, and elevation.

All frames share one six-vertex polar quad, one shader program, and one reflectivity palette. Frames may have different native radial/gate dimensions; selection binds the chosen frame's four textures and updates its small metadata uniforms.

### Hard cuts only

Playback selects one already-resident observation ID. It does not interpolate values, crossfade, upload, decode, or fetch data. Crossfade remains deferred.

### Selection is intent; a GPU fence receipt is display truth

Every accepted selection increments a monotonic selection sequence. The first custom-layer draw using that exact generation, observation, context epoch, and selection sequence creates a WebGL fence. Only a later `clientWaitSync` completion publishes a paint receipt.

A receipt contains:

- generation;
- observation ID;
- WebGL context epoch;
- selection sequence;
- draw sequence;
- completion time;
- selection-to-paint latency; and
- framebuffer dimensions.

The playback controller advances its public playhead only after accepting a matching receipt. A second selection is rejected while the prior one is awaiting its receipt. Scrub, step, pause, normal playback, and latest-frame dwell all use the same path.

### Atomic loop activation and eviction

A replacement loop is validated and fully uploaded into a temporary resource map. Only after every texture allocation and readback succeeds does the renderer swap the active map and delete the prior map. A failed replacement deletes only the temporary resources and leaves the old loop authoritative.

The temporary overlap is included in the peak GPU allocation ledger and must remain below the 256 MiB hard ceiling.

### Explicit hot-path activity ledger

The Rust boundary records monotonic Phase 4 counters for radar network requests, fixture disk reads, decoder runs, normalization runs, bulk IPC transfers, and bulk IPC bytes. The packaged scenario snapshots these counters immediately before and after resident playback. Small diagnostic snapshot commands are control IPC and are not counted as bulk radar transfer.

## Alternatives considered

### One 2D array texture for all frames

Rejected for the baseline. Native observations can vary in dimensions and radial metadata, while WebGL array layers must share dimensions and format. Padding/resampling would complicate missing-data truth without a demonstrated performance need.

### Re-transfer a frame from Rust when selected

Rejected. It would reintroduce IPC readiness, transfer credits, parse work, and a failure boundary into playback.

### Advance the timeline when selection is requested

Rejected. This is the same intended-versus-painted ambiguity that Mistr is designed to remove.

### Use draw-call return as the paint receipt

Rejected. A JavaScript draw call queues GPU work; it does not prove GPU completion. Mistr retains the Phase 3 WebGL fence requirement for every selected observation.

## Evidence

The detailed results are in [`phase-reports/PHASE_4_RESIDENT_PLAYBACK.md`](phase-reports/PHASE_4_RESIDENT_PLAYBACK.md).

On the primary packaged Windows workstation:

- 20 distinct KTLX observations occupied 53,098,240 CPU bytes and 53,099,312 known GPU bytes;
- atomic replacement peaked at 106,197,552 known GPU bytes;
- two independent 4K runs completed 1,000 transitions each with no radar hot-path activity and no long tasks;
- both runs measured 6.2 ms P95 frame duration;
- resident switch-to-receipt P95 was 11.9 ms; and
- stabilized JavaScript heap was 82,943,541 bytes after run one and 83,814,104 bytes after run two, a bounded 0.83 MiB difference.

## Consequences

- The selected-site radar playhead can be authoritative without consulting MapLibre tile readiness.
- The 20-frame loop is comfortably below the 200 MiB target on the tested reflectivity corpus.
- Atomic loop replacement temporarily needs approximately two loop allocations; that peak is visible and budgeted.
- Retained compact CPU truth remains available for future context restoration, but actual context-loss recovery is still a Phase 6 gate.
- This result is one hardware/WebView2 proof, not a universal integrated-GPU claim.
- Live acquisition, site changes with newly decoded data, real-time chunks, velocity parity, tiled fallback, and GustAVO integration remain later phases.

## Supersedes / superseded by

This decision confirms the Phase 4 portions of Q006 and mitigates R7, R12, and R13 on the primary workstation. It does not supersede the Phase 3 representation decision in [`15_GPU_RENDERER_DECISION.md`](15_GPU_RENDERER_DECISION.md).
