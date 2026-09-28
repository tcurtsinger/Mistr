# Radar System Audit — National and Site Renderers

**Date:** 2026-08-05
**Status:** Complete — direct renderer/shader review plus four verified subsystem sweeps (National pipeline, Site pipeline, app shell/UI, Rust backend)
**Scope:** National (MRMS CONUS grid) and Site (Level II sweep) rendering paths, their data pipelines, app-shell integration, and the Rust ingest backend.
**Tree state at audit:** `main` at `007f786` plus uncommitted edge-feather rework in `src/national-radar/` (sampling.ts, NationalGridLayer.ts, sampling.test.ts, docs/25). `tsc` clean; **319/319 tests pass in 49 files.**

---

## 0. Executive summary

**The reported National blur/pixelation at high zoom is the ~1 km MRMS data-resolution floor being magnified without any zoom governance — not a rendering bug.** The pipeline verifiably delivers full native resolution end to end (§1). What's missing is product-level zoom handling (cap, nudge, or auto-handoff to Site) and a better magnification filter than bilinear. No data corruption, mis-georeferencing, or silent quality loss was found anywhere; both renderers paint the right values in the right places.

Top items by priority:

| # | Finding | Where | Severity |
|---|---|---|---|
| 1 | No zoom governance while National is shown (the reported symptom's enabling condition) | U-1, §1 | high (product) |
| 2 | Factor-2 detail endpoint — the designed GPU-memory relief valve — can never succeed | B-1 | high |
| 3 | Newer-frame polling serialized behind backfill; freshness can starve (forever under a failing predecessor) | D-1 | high |
| 4 | Smooth/Native toggle silently reverted + persisted-over during source transitions | U-2 | high (UX) |
| 5 | Dead `NationalWorkingSetController` exports same-name budget constants at 6× smaller values | D-2 | high (trap) |
| 6 | No reconciliation after irreversible finalize → timeline divergence until next poll | D-3 | med-high |
| 7 | Superseded site transition orphans a painted layer; next attempt fails on shared IDs | U-3 | med-high |
| 8 | Bilinear magnification + no minification path (quality headroom both zoom directions) | N-1, §4.2-3 | medium |
| 9 | Playback silent stalls: swallowed errors, unguarded `play()`, lost resume intent | D-4, SP-1/2/4 | medium |
| 10 | Memory-budget model never re-sized for native residency (three conflicting worlds) | B-2, N-3 | medium |

---

## 1. The headline question: why does National look blurry (Smooth) and pixelated (Native) when zoomed in

**Verdict: it is the data-resolution floor, not a rendering bug.** The renderer is faithfully magnifying ~1 km MRMS cells far past their physical resolution, and the app currently lets the user do that without any zoom governance or handoff pressure toward the Site product.

### 1.1 The mechanism, end to end

- The data on screen is the **full-resolution** MRMS grid. Since the native-residency decision ([29_NATIONAL_RADAR_PERFORMANCE_FINDINGS.md](29_NATIONAL_RADAR_PERFORMANCE_FINDINGS.md) §0.2, owner decision 2026-08-04), every retained observation is GPU-resident at the exact 7,000 × 3,500 native grid (`presentationFactor` 1). The historical cause of softness — unconditional fallback to the factor-4 overview (doc 29 §2.3) — is gone. Confirmed in code: the common residency slot holds factor-1 manifests ([NationalGridLayer.ts:1573](../src/national-radar/NationalGridLayer.ts)), and `packedGrid.ts` validates `width === ceil(7000/factor)`.
- MRMS cells are 0.01° ≈ **1.11 km N–S × ~0.85 km E–W** at 40°N. Screen scale at 40°N is ≈ `78271.5 · cos(40°) / 2^z` m/px (512-px tiles):

  | Zoom | m/px (40°N) | One MRMS cell on screen |
  |---:|---:|---:|
  | 7 | ~468 | ~2 px — sub-pixel, fine |
  | 9 | ~117 | ~7–10 px — cells become visible |
  | 11 | ~29 | ~29–38 px — obviously cellular |
  | 13 | ~7.3 | ~115–150 px — giant blocks / wide gradients |

- The map is created **without `maxZoom`** ([App.tsx:254-270](../src/App.tsx)), so MapLibre's default cap of 22 applies. Nothing stops a user from viewing 1 km cells at street-level zoom.
- **Smooth** reconstructs by bilinear interpolation of raw dBZ codes between the 4 nearest cell centers ([NationalGridLayer.ts:105-134](../src/national-radar/NationalGridLayer.ts)). Bilinear magnified 30–150× produces exactly what was reported: wide, soft linear ramps with diamond-shaped level sets — "really blurry."
- **Native** is nearest-cell — by contract it draws the exact measured footprint as hard-edged squares, and the canvas is created with `antialias: false`, so the square edges alias on diagonals — "pixelated."
- The rendering-quality contract already accepts this: *"Neither mode adds resolution. The MRMS CONUS mosaic is a 0.01-degree (roughly 1 km) grid, so beyond about zoom 9 each measured cell covers many screen pixels… Close-range structural detail is the selected-site Level II product's job, not the national mosaic's"* ([25_RADAR_RENDERING_QUALITY.md](25_RADAR_RENDERING_QUALITY.md) §6).

So both modes are working as specified. What is actually missing is (a) product-level zoom governance for the National layer and (b) a better magnification filter than bilinear for Smooth. See recommendations (§4).

### 1.2 What it is *not*

Ruled out by direct inspection:

- **Not a downsampled texture.** Factor-1 data is what renders (see above).
- **Not a canvas-resolution problem.** No `pixelRatio` override, no CSS scaling of the WebGL canvas; `devicePixelRatio` is honored, and the basemap is crisp at the same zooms.
- **Not a georeferencing/registration error.** MRMS registration constants (first cell center −129.995°E / 54.995°N, 0.01° steps, north-to-south rows) are validated at parse time ([packedGrid.ts:14-16,114-141](../src/packed-grid/packedGrid.ts)) and match the shader's cell-centers-at-integer-grid-coordinates convention exactly.
- **Not texture filtering misuse.** Raw-code textures are R16UI + NEAREST (required for integer textures); Smooth's bilinear is computed manually in value space and looked up through a premultiplied 1024-entry LINEAR palette — the correct order (blend values, then palette).
- **Not float precision.** Grid coordinates stay ≤ 7,000, far inside float32's exact-integer range; worst-case fragment position error is ~1 m, invisible against 1 km cells.

---

## 2. Verified findings — renderers (my own read of the code)

Ordered by severity. Line references are to the current working tree.

### N-1 (medium, confirmed): No minification treatment — CONUS-scale views undersample the native grid
Since native residency, the *zoomed-out* direction has the opposite problem: at the CONUS home view (~z5.5), a 1080p-wide viewport spans ~7,000 grid columns with ~1,900 device pixels — each fragment point-samples (nearest or 2×2 bilinear) from ~3–4 cells per axis while the rest are skipped. Integer textures cannot mipmap, and the shader makes no attempt to area-average. Consequences: shimmer/crawling during pan at country scale, and isolated small echoes that pop in and out between frames. Doc 29 §2.3 worried about the factor-4 grid being too coarse for 4K; the factor-1-everywhere decision quietly created the inverse issue for 1080p. A proper fix is an area-weighted minification path (e.g., fragment-shader box filter over the cell footprint, or a float mip pyramid of dBZ with valid-cell weights).

### N-2 (low, confirmed): Smooth shader diverges from its unit-tested CPU mirror at clamped domain edges
[Docs/25 §6](25_RADAR_RENDERING_QUALITY.md) requires the shader to match `sampling.ts`. It doesn't at the domain boundary: the TS mirror computes the interpolation fraction *after* clamping (`fraction = clamp(x − lowerX, 0, 1)` → 0 at the west/north domain edge), while the shader computes `clamp(fract(local), 0, 1)` from the *unclamped* coordinate ([NationalGridLayer.ts:119](../src/national-radar/NationalGridLayer.ts)). GLSL `fract(−0.4) = 0.6`, so on the outermost half-cell ring of the whole CONUS domain the shader blends up to 60 % of the *second* cell where the mirror says 100 % first cell. Practical impact is nil for CONUS weather (the affected ring is over open ocean/Canada at the mosaic rim), but it is a genuine contract violation of the "shader must match" rule and trivial to fix (`fraction = clamp(local - vec2(lower), 0.0, 1.0)`).

### N-3 (low, confirmed): Three stale "256 MiB" error messages contradict the 1,536 MiB ceiling
The native-residency change raised `NATIONAL_GPU_HARD_CEILING_BYTES` to 1,536 MiB, but the failure strings still say 256 MiB: [NationalGridLayer.ts:619](../src/national-radar/NationalGridLayer.ts), [NationalGridLayer.ts:1101](../src/national-radar/NationalGridLayer.ts), [NationalHistoryWorkingSetController.ts:242](../src/national-radar/NationalHistoryWorkingSetController.ts). If the ceiling ever trips in the field, the diagnostic will send whoever reads it hunting for a limit that no longer exists.

### N-4 (low, confirmed): `presentationUsesCommonFallback()` semantics rotted under native residency
The predicate ([NationalGridLayer.ts:1462-1464](../src/national-radar/NationalGridLayer.ts)) answers "is the active presentation a viewport-detail level" by testing `manifest.presentationFactor === 1 || === 2`. That was sound when the common slot was always factor 4 — but under native residency the common slot's manifest is also factor 1, so the predicate now returns *true for the ordinary common presentation too*. Nothing breaks today only because every selector-4 code path sets `this.fallback = null` before the `this.fallback &&` guard in `render()`. The next person to set a fallback alongside a common selection gets a silent double-draw (fallback under active, with exclusion compositing). The check should key on the residency *slot* (or simply on `fallback !== null`), not the manifest factor.

### S-1 (medium, confirmed, design tension): Site Smooth blends palette *colors*; National Smooth blends *values*
The Site fragment shader's smooth path averages **premultiplied palette RGBA** across the 2×2 polar neighborhood ([RadarCustomLayer.ts:73-106](../src/radar-renderer/RadarCustomLayer.ts)); the National shader averages **raw dBZ codes** and does one palette lookup ([NationalGridLayer.ts:134](../src/national-radar/NationalGridLayer.ts)). Color-space averaging is alpha-correct here (premultiplied), and docs/25 §4 does bless palette-color interpolation — but across sharp palette turns (e.g., 55 dBZ red → 60 dBZ pink/magenta) a color average passes through hues that correspond to *no* dBZ value, where a value average would pass through the palette's actual ramp. The two renderers therefore disagree on what "Smooth" means at gradient boundaries. Worth a deliberate decision; value-space blending on the Site path would also be cheaper (one palette fetch instead of four).

### S-2 (low, confirmed, deliberate cost): Per-frame GPU readback validation stalls the pipeline on every upload
Every site frame upload round-trips 4 × 1-px `readPixels` to prove texture integrity ([RadarCustomLayer.ts:1687-1763](../src/radar-renderer/RadarCustomLayer.ts)). `readPixels` forces a CPU↔GPU sync each time. It runs once per new observation (not per paint), so it's bounded — but it is a hidden fixed tax on history updates and loop replacement (~20 syncs on a full loop swap), and it runs in release builds, not just tests. Consider sampling it (validate first frame per generation) or gating it behind diagnostics.

### S-3 (info, confirmed): Native mode keeps genuine hairline seams between radials
The azimuth lookup accepts bins up to `beamWidth/2 + halfBin`, but Native discards fragments strictly outside `beamWidth/2` ([RadarCustomLayer.ts:139](../src/radar-renderer/RadarCustomLayer.ts)). Real Level II azimuth centers drift by hundredths of a degree, so Native can show sub-pixel gaps between wedges that Smooth deliberately closes (the `safelyAdjacent` logic). This matches the documented "exact presentation" intent — recorded here so it isn't re-reported as a bug.

### P-1 (info, confirmed): Palette defines colors for −25…0 dBZ that can never render
`colorForReflectivity` carries full RGB anchors from −25 dBZ, but `reflectivityDisplayAlpha` zeroes everything ≤ 0 dBZ ([palette.ts:22-57](../src/radar-renderer/palette.ts)), so the first five anchors are permanently invisible in both renderers (both consume this same curve). Deliberate per docs/25 §4 (clear-air suppression). Note the latent trap: any future "show weak returns" toggle only needs an alpha-curve change, and the dead anchors become live — they are not dead code to delete.

### P-2 (trivial, confirmed): Two different `PALETTE_WIDTH` constants
`radar-renderer/palette.ts` exports `PALETTE_WIDTH = 256` (site, texelFetch, code-indexed); `NationalGridLayer.ts` privately defines `PALETTE_WIDTH = 1_024` (national, normalized LINEAR lookup). Same name, different meanings, one import away from a wrong-constant bug.

### U-1 (medium, confirmed): No zoom governance while National is the visible radar
`new maplibregl.Map({...})` sets no `maxZoom` ([App.tsx:254-270](../src/App.tsx)); the only 5.5/7.5 zoom numbers in the app are camera-fit options. Users can sit at z13+ on a 1 km product. Whatever the layer-switching UX is (see pending app-shell sweep), the National layer has no zoom ceiling, no crossfade toward the Site product, and no "you are past this product's resolution" affordance. This is the product-level half of the headline complaint.

---

## 3. Pipeline and backend findings

Findings from four parallel subsystem sweeps, each verified against the code before inclusion (verification notes inline).

### 3.1 App shell / UI / map integration

**Confirmed context answers** (feed §1): map has no `maxZoom`/`minZoom`/`pixelRatio` ([App.tsx:254-270](../src/App.tsx)); National↔Site selection is fully manual via the source panel — no zoom-driven switching, no nudge; the canvas/DPR path is clean (no CSS scaling, no pixelRatio override), so the basemap stays crisp while the radar magnifies — which is exactly the reported contrast. National interrogation reads the *backend* full-resolution store keyed by paint-receipt identity, not the GPU texture ([App.tsx:1394-1465](../src/App.tsx)) — correct per docs/25 §7, with the side effect that interrogation can never corroborate or refute a resident-texture defect.

**Cleared suspicion (recorded so it isn't re-raised):** every National commit passes `selectedPresentationFactor: 4` ([NationalGridLayer.ts:522-528](../src/national-radar/NationalGridLayer.ts)) while staging factor-1 data — this looked like a 4× coarseness bug. It is not: "4" is a *slot selector* (historical convention selecting the common residency slot; see the comment at [NationalGridLayer.ts:1573-1575](../src/national-radar/NationalGridLayer.ts)); the drawn uniforms and the paint receipt both come from the actual manifest, which is factor 1. Rendering resolution is unaffected. The naming is actively misleading — see recommendation §4 item 12.

#### U-2 (high, confirmed): Smooth/Native toggle is silently reverted during source transitions
`selectDisplayMode` routes the toggle **only to the currently painted layer** ([App.tsx:2876-2890](../src/App.tsx)), while a staging layer captures its mode once at construction ([App.tsx:1361](../src/App.tsx), [App.tsx:1141](../src/App.tsx)). The National layer's snapshot callback has a renderer-wins reverse sync ([App.tsx:1365-1369](../src/App.tsx)): if its mode differs from the ref, it overwrites the ref, React state, **and localStorage**. Verified sequence: Site painted, user selects National, then toggles Native while National stages → the toggle hits only the site layer; National's next snapshot emission (staging emits constantly) rewrites everything back to `smooth`; when National paints, it renders Smooth, the UI label says Smooth, and the persisted preference has been clobbered. The user's explicit Native choice is discarded with no error. (The agent-reported "tug-of-war" oscillation requires both layers to carry the reverse sync — only the startup archive layer does ([App.tsx:629-633](../src/App.tsx)) — but the silent revert is the general live behavior.) The live site bootstrap layer has the mirror problem: no reverse sync at all ([App.tsx:1143-1147](../src/App.tsx)), so a toggle during a National→Site transition leaves the painted site radar in one mode with the UI claiming the other.

#### U-3 (medium-high, confirmed): Superseded site transition orphans a fully painted layer and poisons the next attempt
The coordinator makes a new transition current **synchronously** at click time ([SiteLevel2Session.ts:71-78](../src/radar-session/SiteLevel2Session.ts)), but the closure variable that the in-flight transition checks (`transferGeneration`) is only reassigned deep inside the *new* transition's acquire path, after several awaits ([App.tsx:1101-1109](../src/App.tsx)). Verified window: click site B while site A's bootstrap is past its last `transferGeneration` check — A completes `acquireAndPaint` cleanly (its own catch never fires), then `acceptPaint` returns false in the session layer, where **no map cleanup exists** (`wasCurrent` is false, so `onTransitionFailed` is skipped too, [SiteLevel2Session.ts:85-93](../src/radar-session/SiteLevel2Session.ts)). Site A's `RadarCustomLayer` and the `mistr-range-source`/`mistr-anchor-source` diagnostic sources stay on the map alongside National. Because those IDs are fixed constants, the next site attempt throws "source already exists," fails, and its own catch incidentally removes the orphan — so the bug presents as 1–2 spurious "site unavailable" errors plus transiently doubled radar, then self-heals. Needs a cleanup path owned by the coordinator (or a supersession check after paint acceptance inside the closure).

#### U-4 (low, confirmed): Scrub queue drains against a stale source
The `queueScrub` drain loop closes over render-time `nationalActive` ([App.tsx:2782-2806](../src/App.tsx)); scrubs queued across a National↔Site flip are sent to the previous source's controller ref and silently no-op until the user scrubs again.

#### U-5 (low, dev-mode, plausible): The main `run()` effect lacks cancellation gates around map mutations
Cleanup sets a `cancelled` flag, but long acquisition paths mutate the map and `__MISTR_*` diagnostic globals without re-checking it; an HMR remount can leave diagnostics pointing at dead layers. Production has a single mount, so exposure is development/diagnostics.

#### U-6 (low, confirmed behavior — intent unclear): `maxTileCacheSize: 0` disables the basemap's out-of-view tile cache
[App.tsx:262-264](../src/App.tsx) sets 0 with a comment about keeping the cache "bounded at 4K." Zero means *no* out-of-view retention (omitted/null = viewport-sized auto cache), so panning away and back re-fetches/re-parses basemap tiles — visible as basemap pop-in during radar panning. If the intent was "strictly bounded on 4K displays," 0 achieves it at the cost of pop-in; the comment should say which trade was chosen.

#### U-7 (low, confirmed): Render-time reads of mutable refs gate control enablement
`displayModeReady`/playback enablement read `nationalLayerRef.current` during render ([App.tsx:2898-2900](../src/App.tsx)); correctness currently depends on incidental re-renders triggered by adjacent state updates.

#### U-8 (low, teardown-only, plausible): Unmount cleanup ordering touches a removed map
The map-create effect's cleanup (`instance.remove()`) runs before the radar effect cleanup, which then calls `getLayer`/`removeLayer` on the removed instance; the National branch lacks the `getStyle()` guard the diagnostic path has.

### 3.2 National data pipeline

**Verified clean:** the commit protocol (reversible renderer commit → backend commit → irreversible finalize with settle loops both sides) and the packed-grid codec are rigorous — strict header/geometry/hash validation, chunk geometry fully derived from the index (no off-by-one found), payload hash bound to manifest identity. Coverage's interior-cell intersection math is correct (cell-center ± half-step, halo correctly excluded). **No production path produces or selects downsampled data** — factors 1/2 viewport detail and `viewportCoverage` are reachable only from tests under native residency, which independently reconfirms §1.

#### D-1 (high, confirmed): Newer-observation polling is serialized behind backfill — freshness can starve
`runNationalPolling` is invoked only after the backfill loop returns complete ([App.tsx:1725-1766](../src/App.tsx)). The backfill loop caps only its backoff *delay*, not attempts — a persistently failing predecessor (malformed archive GRIB is a real MRMS occurrence) retries forever, and strictly-newer polling never starts: the map shows the initial frame indefinitely while claiming "loading." Native residency sharpened the benign case too: backfill now moves 19 × ~49 MiB frames, so on a moderate connection the backfill phase alone can exceed the 2-minute MRMS cadence — the visible frame ages until backfill completes because polling waits behind it. Doc 29 §0.2 flags backfill pipelining as the open follow-up; this finding adds that *freshness*, not just history depth, pays for the serialization. Needs a skip-after-N-attempts escape per predecessor and/or newer-frame polling running beside backfill.

#### D-2 (high, confirmed): Dead `NationalWorkingSetController` exports conflicting same-name budget constants
The file exports `NATIONAL_GPU_TARGET_BYTES = 200 MiB` / `NATIONAL_GPU_HARD_CEILING_BYTES = 256 MiB` — the same names `NationalGridLayer.ts` exports at 1,280/1,536 MiB. Grep-confirmed: nothing imports the controller except its own (passing) test; production uses only `NationalHistoryWorkingSetController`. It is a stale pre-native-residency artifact whose passing tests mask its deadness, and an auto-import of either constant can silently pick the 6×-smaller value. Delete the file or re-point it at the live constants.

#### D-3 (medium-high, confirmed mechanism / narrow trigger): No reconciliation after the irreversible finalize
In `commitNationalHistoryMutation` ([App.tsx:1653-1690](../src/App.tsx)), once `finalizeHistoryMutation` marks the renderer finalized, the catch block correctly performs no rollback — but it performs no reconciliation either. A transient error in `finalizeNationalHistoryCommit` or `waitForAuthoritativeReceipt` (e.g., context loss in that window) leaves `nationalObservations` and the playback timeline on the pre-mutation history while the renderer and Rust journal hold the new one. Until the next successful poll (≥ ~2 min, longer under backoff): `advanceOnce` throws "selected outside retained history," `play()` rejects, scrubs can target evicted frames, and the committed frame is absent from the UI timeline. A re-pull of `nationalHistorySnapshot` + `acceptHistory` in the both-finalized error path closes it.

#### D-4 (medium, confirmed): `resumeAfterMutation` fire-and-forgets `play()`
[NationalPlaybackController.ts:234-240](../src/playback/NationalPlaybackController.ts) uses bare `void this.play()` even though `play()` deliberately rethrows after stopping so callers can surface errors. It is invoked after every history replacement while playing — including from the mutation *catch* path ([App.tsx:1688](../src/App.tsx)). If the resume fails (renderer recovering, selection raced), the app gets an unhandled rejection and playback halts frozen with no `setPlaybackError`. The mid-loop `scheduleNext` rejection handler has the same silent-stop behavior.

#### D-5 (medium, confirmed): App hard-codes a 20-frame history everywhere; the wire contract allows 30
`.slice(-20)` and four `>= 20` comparisons in App.tsx vs `transferClient` accepting `historyLimit` 20 *or* 30. If the backend ever runs 30: `acceptHistory` throws *after* the irreversible finalize on every poll (compounding D-3), backfill stops at 20 while status compares against the backend's 30 → pinned at "loading/partial" forever. Also unbudgeted: 30 native frames ≈ 1,423 MiB — above the 1,280 MiB target, ~113 MiB under the ceiling. Centralize the limit and validate the 30 mode or delete it.

#### D-6 (medium, plausible): Site-transition settle sequence invalidates the National session *after* awaiting
[App.tsx:1101-1112](../src/App.tsx): the site path awaits national settling *before* bumping `nationalHistorySession`/`transferGeneration`, so a poll can start a fresh ~47 MiB staging during those awaits, and `nationalWorkingSet.cancel()` then rips it out mid-upload. Ownership checks make it self-heal, but the ordering is inverted (bump sessions first, then settle) — same family as U-3's window.

#### D-7 (grouped low, verified by sweep): pipeline hygiene
- The history controller's own 256 MiB tripwire ([NationalHistoryWorkingSetController.ts:241-243](../src/national-radar/NationalHistoryWorkingSetController.ts)) is a bare literal that can never fire (complete-domain factor-1 projects ~47 MiB) — same stale family as N-3.
- Initial acquisition skips `waitForIdle` before `stageInitialOverview`, unlike the poll path; the purpose-built `isNationalWorkingSetBusy` classifier is exported and used by nobody.
- `viewportCoverage` throws on empty intersections and unwrapped/antimeridian bounds — latent (viewport-detail paths are production-dead) but a guaranteed trip for any revival; `coverage.test.ts` (3 tests) covers none of these edges.
- The playback controller still arms real refinement timers into an undefined callback and reports `refining: true` for 180 ms after every pause/scrub — dead machinery under native residency, misleading state surface.
- `NationalMrmsSession` wraps losing-transition failures as superseded without `{ cause }`, discarding the real error.
- Finalize/rollback settle loops retry every ≤1 s indefinitely (2 IPC calls + state update per second if the backend wedges), and a `waitBeforeRetry` rejection escapes the loops' "retry until settled" contract (latent — the App's wait never rejects). Backfill's plain stop is mislabeled `"superseded"`.
- Chunk decode does ~25 M per-element big-endian `DataView.getUint16` reads plus an extra payload copy per frame (~tens of ms of main-thread work per 2-minute arrival) — a bulk byteswap would remove most of it.
- A selection in flight at controller dispose still fires `onPaint`/`emit()` into a possibly-removed layer afterward; a `disposed` guard before the callbacks closes it.

### 3.3 Site data pipeline

**Verified clean (a lot of it):** azimuth binning handles the 0/360 seam via binary search with modular neighbors; gate math uses consistent half-open boundaries and the 4/3-Earth forward/inverse pair is pinned to a Py-ART oracle within 0.1 m; `buildMercatorBounds` is monotone-safe, antimeridian-correct, and latitude-clamped; palette premultiplication matches the shader's blending, with 256 entries exactly matching 8-bit data resolution (no palette banding); `packedSweep.ts` validation is unusually rigorous (canonical layout, zero-fill enforcement, wire hash, per-gate cross-validation, masquerade rejection); coordinator/session supersession and receipt fencing are correct and well-tested; the transfer client's credit protocol is sound. **The site radar paints the right gates in the right places with the right colors** — the findings below are orchestration robustness, not rendering correctness.

#### SP-1 (medium, confirmed): `play()` is unguarded during resident replacements and silently self-cancels
`step()`/`scrub()` reject interaction while a replacement is in flight; `play()` does not ([ResidentPlaybackController.ts:250-271](../src/playback/ResidentPlaybackController.ts)). A play press during a live-append window schedules the dwell timer; the timer's advance then collides with the replacement's paint (`select` throws "already awaiting paint"), which `scheduleNext`'s catch swallows into `playing = false`. Net: pressing play during any live refresh is silently ignored. A nastier plausible sub-path: a press landing in the recovery-wait window grabs the shared `operation` slot first, making the healthy live append's own paint fail and roll back a just-arrived frame — surfacing as a spurious poll failure.

#### SP-2 (medium, confirmed): Timer-driven playback errors are swallowed with no surfaced cause
[ResidentPlaybackController.ts:361-364](../src/playback/ResidentPlaybackController.ts): `.catch(() => { this.playing = false; this.emit(); })` discards the error. Controller-invariant failures during autonomous playback stop the animation with a snapshot showing only `playing: false` — no `holdReason`, no error, diagnostics blind. Same silent-stop family as the National controller's D-4.

#### SP-3 (medium, structural throw confirmed / wedge scenario plausible): `beginLiveRefresh`'s invariant throw sits outside its error handler
In `acquireLive`, the `beginLiveRefresh`/`beginLiveDisplay` call runs *before* the `try` that owns `failLiveDisplay` ([App.tsx:800-811](../src/App.tsx)). The two truths it reconciles can diverge: `appendingHistory` derives from chunk-sourced history while `lastComplete` can legitimately retain an **archive-sourced** painted frame. If that happens during a live polling session, every poll throws before the handler, retries 15 s later, and live updates halt permanently with no degraded-state message. Move the call inside the guarded region and classify the invariant as a restartable condition.

#### SP-4 (low-medium, confirmed): Early `beforeCommit` throw leaves playback permanently paused
`updateResidentHistoryNow` runs `beforeCommit?.()` after `pauseAndWait()` but before the `try` that owns resume ([ResidentPlaybackController.ts:146-156](../src/playback/ResidentPlaybackController.ts)); a throw there (the App passes an ownership check) exits with playback paused and the `resumePlayback` intent lost. Masked when a successor replacement follows; if the superseding request itself fails, the loop stays frozen until a manual play.

#### SP-5 (low, confirmed): Selection sampled before `pauseAndWait()` causes a one-frame back-step on live appends
`previousSelected` is read before awaiting the in-flight paint ([ResidentPlaybackController.ts:143-146](../src/playback/ResidentPlaybackController.ts)); a timer advance completing inside the await makes the preserved selection one frame stale → visible N+1 → N → N+1 stutter on the append repaint. Fix: sample after the pause settles.

#### SP-6 (low, confirmed): Smooth paints pixels that interrogation reports as "outside"
The smooth shader's seam-closing deliberately paints bearings beyond `beamWidth/2` between adjacent radials when azimuth jitter opens a gap ([RadarCustomLayer.ts:167-180](../src/radar-renderer/RadarCustomLayer.ts)), but CPU interrogation accepts only `beamWidth/2` (`bearingWithinRadial`, [geo.ts:180-187](../src/radar-renderer/geo.ts)). Clicking visibly colored echo in a closed seam returns null; conversely Native shows hairline seams at the same spots. `geo.test.ts` pins the divergence without any consumer reconciling it. Docs/25 §7 promises a native gate report for displayed pixels — the seam pixels are the one place that promise quietly fails.

#### SP-7 (grouped low, verified by sweep): site hygiene
- `SiteRequestTracker` is dead code — only its test imports it; the real coalescing lives in ad-hoc `transferGeneration`/`livePollingSession` counters in App.tsx.
- Three subtly different dBZ decode formulas (wire `fround(fround(raw−offset)/scale)`, interrogation `fround((raw−offset)/scale)`, palette full-f64) can differ by 1 ulp for non-integer-exact scale/offset — exact for operational Level 2 encodings today; one shared helper closes it.
- The packed-sweep wire stores gate geometry as integer meters; N0S product bins are nominally 0.13 nmi ≈ 240.76 m — if operational products carry fractional-meter geometry, far-range gates shift up to ~one gate with no validation catching it (verify against the ICD).
- Initial site backfill serializes up to 19 sequential requests ahead of the first fresh poll (same freshness-behind-backfill family as D-1, milder); and a successful-but-not-appended poll cycle has no client-side delay, relying wholly on backend long-poll pacing.
- `PerformanceObserver.supportedEntryTypes` is read outside the `try` meant to tolerate its absence.
- Coverage gaps: no timer-pacing/dwell assertions, no play-during-replacement test (SP-1), no swallowed-error test (SP-2), no high-latitude or antimeridian `buildMercatorBounds` test.

### 3.4 Rust ingest backend

**Verified clean (strengthens §1.2):** GRIB2 registration is validated against pinned raw values (`La1 = 54.995°`, `Lo1 = 230.005° → −129.995°`, [mrms.rs:653-676](../src-tauri/src/mrms.rs)) — cell-center registration matching the shader exactly, with the 0–360→signed conversion checked, spans as `(n−1)·step`, and the downsample-level center shift computed in exact e6 integer math on both sides. Value encoding is bit-exact u16 end to end (no requantization; sentinels checked before the dBZ formula). Halo construction is copied row-wise from the same level array and cross-validated on encode *and* decode, with a seam test — cross-chunk bilinear seams cannot occur. Level 2 decode validates per-radial azimuth/beam/elevation bounds, forces uniform gate geometry, and wraps the third-party decoder in `catch_unwind` with fuzz coverage. HTTP is host-allowlisted, size-bounded, magic-checked, SHA-256-evidenced. There is no on-disk cache (no corruption/growth risk; cost: full re-download on restart). The live path serves factor 1 (`OVERVIEW_FACTOR: u16 = 1`, [national_history.rs:24-29](../src-tauri/src/national_history.rs)) — independently confirming §1's "not a downsampling bug."

#### B-1 (high, confirmed): The factor-2 detail endpoint can never succeed
`prepare_national_history_presentation` accepts `presentation_factor` 1 or 2 ([national_history.rs:899](../src-tauri/src/national_history.rs)), but both pyramid sources it can use — the cached `exact_pyramid` and the rebuild path — are constructed with `MrmsNumericPyramid::from_decoded(decoded, OVERVIEW_FACTOR)` where `OVERVIEW_FACTOR = 1` ([national_history.rs:955](../src-tauri/src/national_history.rs), [:1332-1348]). `from_decoded` inserts levels only up to `max_factor` ([packed_grid.rs:84-109](../src-tauri/src/packed_grid.rs)), so the pyramid holds level 1 only, and `PackedGridFrame::encode(…, 2)` is a guaranteed `InvalidLevel` error. Verified against the code chain personally. This matters because factor 2 is the designed relief valve for the ~1 GB GPU working set that native residency created (doc 29 §0.2 explicitly keeps "viewport-bounded sharp playback" as the fallback concept): the first caller to ask for it gets a runtime failure. It is latent today only because `App.tsx` never passes 2 — but the frontend types and `transferClient` advertise `1 | 2`. Either make the pyramid build to level 2 when factor 2 is requested, or delete factor 2 from the contract everywhere.

#### B-2 (medium, confirmed): Memory-budget model never re-sized for native residency; no working coarse fallback
Native residency multiplied per-frame GPU cost ~16× (~3 MB → ~52 MB with halos; ~1.03 GB for a 20-frame loop). The frontend ceiling was raised (1,280 MiB target / 1,536 MiB ceiling), but: the backend *diagnostic* surface still advertises the old world (`GPU_TARGET_BYTES = 200 MB` / `GPU_HARD_CEILING_BYTES = 256 MB`, [national_phase2.rs:27-28](../src-tauri/src/national_phase2.rs)); three frontend error strings still say "256 MiB" (finding N-3); and on GPUs where ~1 GB of texture residency does not fit there is **no degradation path** — history manifests serve only factor 1 and the factor-2 fallback is broken (B-1). Doc 29 records the supported-device floor as an owner decision, so this is by-design until it isn't; the audit's point is that the *only* graceful-degradation lever is currently a guaranteed error.

#### B-3 (medium, confirmed): 30-object diagnostic re-downloads and re-decodes everything per call
`prepare_national_phase2_diagnostic` ([national_phase2.rs:284-353](../src-tauri/src/national_phase2.rs)) serially downloads and fully decodes all 30 MRMS objects without consulting the prepared cache; one transient failure at object 29 discards everything, and a retry repeats ~150–250 MB of network plus ~30 s of decode. Diagnostic-only command, hence medium.

#### B-4 (low, confirmed): Per-session release-ID set is unbounded and 16× hotter since native residency
`acknowledged_release_ids` deliberately retains every transfer acknowledgement for the frontend session's lifetime ([phase2_ipc.rs:63-67](../src-tauri/src/phase2_ipc.rs), cleared only on session/document reset). The retention rationale is sound (lost control responses), but native residency raised transfers to ~393 per observation → ~12 k IDs/hour at MRMS cadence (~1 MB/hour, ever-growing `BTreeSet`). A multi-day always-on session accumulates tens of MB. Bound it with a high-water mark or per-generation pruning.

#### B-5 (low, confirmed): Commit-path budget enforcement is a `debug_assert` that can poison the store
`stage()` enforces the 2 GiB backend target, but `commit_staged` can add a reversible-commit clone that `stage()` never projected; the invariant after commit is only `debug_assert!` ([national_history.rs:468](../src-tauri/src/national_history.rs)). In a debug build an over-budget commit panics while holding the store `Mutex`, poisoning it — every subsequent National command then fails until restart. Cannot trigger at current sizes (~1.2 GB peak vs 2 GiB); becomes real if the limit shrinks or frames grow. Make it a real error (or project the reversible copy in `stage()`).

#### B-6 (low, confirmed): Frontend diagnostic fabricates backend capabilities
`phase3CompatibilityPreparation` ([App.tsx:3075-3095](../src/App.tsx)) reports `presentationFactors: [1, 2, 4]` with hardcoded chunk/byte figures as if backend-provided — while the live backend serves only factor 1 and factor 2 errors (B-1). Any operator or test reading this diagnostic is misled.

---

## 4. Recommendations

Grouped; within each group, ranked.

**A. The reported symptom (National at high zoom)**

1. **Add zoom governance for the National product (product decision + small code).** Options, cheapest first: (a) cap map zoom while National is the active radar (e.g., `maxZoom` ~9–10, matching doc 25's "beyond about zoom 9" line); (b) keep zoom free but overlay a subtle "1 km national mosaic — switch to a site for detail" affordance past z9; (c) automatic National→Site handoff/crossfade when a site's coverage contains the viewport. (c) is the RadarScope-style answer and the best UX, but touches session ownership contracts (doc 29's clean National-to-Site handoff evidence suggests the plumbing exists).
2. **Upgrade National Smooth magnification from bilinear to bicubic value interpolation (Catmull-Rom over a 4×4 neighborhood).** Blend raw codes exactly as today (valid-weighted, renormalized, coverage-driven opacity), just with a better kernel. This removes the diamond-shaped bilinear level sets that read as "blurry mush" and preserves echo shape dramatically better at 10–100× magnification. Costs: 16 `texelFetch`es/fragment (cheap on the stated RTX-class floor), **requires widening the chunk halo from 1 to 2 cells** (backend + descriptor change — `validateDescriptor` in packedGrid.ts pins halo = 1), and the sampling.ts mirror + tests must be extended to the new kernel. Native should stay exactly as it is — hard cells are its contract.
3. **Add a minification path for CONUS-scale views (finding N-1)** — area-weighted average of valid cells per fragment footprint (a ±N `texelFetch` box filter driven by `fwidth(grid)`), or a precomputed float mip pyramid with validity weights. Kills country-scale shimmer and echo popping.

**B. User-visible correctness (found by the sweep, unrelated to zoom)**

4. **Fix the display-mode routing (U-2).** Route `selectDisplayMode` to *every* live layer (painted and staging), or set the staged layer's mode at acceptance time; delete or narrowly scope the renderer-wins reverse sync so a staging layer's construction-time mode can never clobber the user's choice or localStorage.
5. **Own orphan cleanup at the coordinator (U-3).** On `acceptPaint` returning false, the session/coordinator must tear down whatever the losing transition installed (layer + diagnostic sources), instead of relying on the next attempt's failure path to collide with shared IDs and clean up by accident.
6. **Re-resolve the active source inside the scrub drain loop (U-4)** — read a ref, not the render-time `nationalActive`.
7. **Fix or delete the factor-2 detail contract (B-1), then reconcile the memory-budget model (B-2).** Decide whether a coarse degradation path exists on the supported-device floor; today the advertised lever is a guaranteed runtime error, and the budget constants/messages describe three different worlds (200/256 MB backend diagnostic, "256 MiB" frontend strings, 1,280/1,536 MiB actual).
8. **Unstarve freshness and close the finalize seam (D-1, D-3, D-4, D-5).** Run newer-frame polling beside (or interleaved with) backfill and give backfill a skip-after-N-attempts escape per predecessor; add history reconciliation to the both-finalized error path; surface `resumeAfterMutation` failures through `setPlaybackError`; centralize the 20-frame limit against the wire contract's 20-or-30.
9. **Harden site playback orchestration (SP-1…SP-5).** Guard `play()` with the same replacement-readiness check as step/scrub; surface `scheduleNext` failures into the snapshot (shared fix shape with D-4); move `beginLiveRefresh` inside its error handler; move `beforeCommit` inside the resume-owning `try`; sample the preserved selection after `pauseAndWait()`.

**C. Hygiene / debt**

10. **Delete the dead code with teeth: `NationalWorkingSetController` (D-2) and `SiteRequestTracker` (SP-7)** — the former exports conflicting same-name budget constants and both carry passing tests that disguise them as production code.
11. **Fix the shader/mirror edge divergence (N-2)** — one-line shader change; add a domain-edge unit test to sampling.test.ts.
12. **Rename the presentation-factor slot selector.** `selectedPresentationFactor = 4` now means "the common residency slot, whose manifest is factor 1" — an audit-grade trap (it derailed this audit's own sweep once). Replace the magic 4 with an explicit `"common" | "detail"` slot argument; keep the manifest factor as the only numeric factor. Same for the fabricated capability diagnostic (B-6).
13. **Correct the three stale 256 MiB messages (N-3, D-7)** — reference the constant instead of an inline literal.
14. **Decide Smooth's blending space once, for both renderers (S-1)** — recommend value-space everywhere; document it in docs/25 either way. While there, decide whether seam-closed smooth pixels should interrogate as their nearest radial instead of "outside" (SP-6), and update docs/25 §7's promise accordingly.
15. **Gate or sample the per-upload GPU readback validation (S-2)** in release builds.
16. **Backend/pipeline housekeeping:** bound `acknowledged_release_ids` (B-4), promote the commit-budget `debug_assert` to a real error (B-5), let the 30-object diagnostic reuse its cache (B-3), clarify or revisit `maxTileCacheSize: 0` (U-6), strip the dead refinement machinery from the National playback controller, add `{ cause }` to supersession wrapping, bulk-byteswap chunk decode, unify the three dBZ decode helpers (SP-7), and cover the untested coverage/loop/playback edges called out in D-7 and SP-7.

---

## 5. Method

- Full read of both fragment/vertex shader pairs and both custom-layer classes (`NationalGridLayer.ts` 2,014 lines; `RadarCustomLayer.ts` 2,144 lines), the packed-grid wire format, palette construction, geodesy helpers, and the uncommitted working-tree diff.
- Contract docs 25 (rendering quality), 28 (static renderer decision), 29 (performance/fidelity findings, rounds 1–3) read against the code.
- `npx tsc -p tsconfig.app.json --noEmit`: clean. `npx vitest run`: 49 files, 319 tests, all passing (24.2 s).
- Four parallel subsystem sweeps (National pipeline, Site pipeline, app shell/UI, Rust backend). Every finding rated medium or higher in §3 was re-verified against the source before inclusion (verification notes inline); one sweep suspicion was investigated and cleared (§3.1's factor-4 slot selector). Grouped "hygiene" items (D-7, SP-7) are included on the sweep's evidence with spot checks.
- Severity scale: high = user-visible wedge/regression or guaranteed failure on first use; medium = user-visible degradation under realistic timing, or a maintenance trap with teeth; low = latent, dev-only, or cosmetic.

## 6. Overall assessment

Both radar pipelines are engineered to an unusually high standard where truth matters: wire formats are hash-validated end to end, georeferencing is exact cell-center registration on both sides, paint receipts and generation fencing guard every async boundary, and no production path degrades data resolution. The reported zoom-quality complaint is the one place where the product promises less than users expect — the data floor is documented, but nothing in the UX communicates or governs it. The audit's substantive defects cluster in two seams: *transition orchestration* (mode toggles, superseded site transitions, finalize windows, play-during-replacement) where racy timing produces silent stalls or lost intent rather than wrong pixels, and *the native-residency migration's wake* (a broken factor-2 relief valve, three conflicting memory-budget worlds, dead controllers and refinement machinery, stale 256 MiB strings). Both clusters are cleanup-sized, not redesign-sized.
