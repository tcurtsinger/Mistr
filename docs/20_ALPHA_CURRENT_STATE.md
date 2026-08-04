# Alpha Current State

**Checkpoint:** 2026-08-04

**Merged baseline:** [PR #18 - National Phase 4 bounded rolling history and playback](https://github.com/tcurtsinger/Mistr/pull/18), merge commit `4a4da19`

**Active change:** Focused National playback correction: prepare the finest complete all-frame regional viewport level before playback, preserve uniform quality through camera moves, keep the prior paint visible during bounded preparation, and leave already-usable transport enabled during background history staging

**Branch:** `codex/mistr-national-visual-fidelity`

This document is the durable starting point for the next Mistr development session. Verify the active branch, worktree, and any future pull-request checks or threads before acting because repository state can change after this checkpoint.

## Product decision

Mistr is the product. Merged `main` contains the qualified selected-site Alpha and National Phases 1 through 4: 20 exact chronological CONUS observations, current-first predecessor backfill, strictly newer polling, GPU-resident playback/scrubbing, exact interrogation, and selected-frame detail refinement without automatic zoom handoff. The active focused branch corrects the demonstrated regional playback quality drop without starting Phase 5. Velocity UI, alerts, cameras, video, notifications, broad settings, and the wider GustAVO feature set remain outside the product.

Windows is the Alpha release platform. Shared Tauri, Rust, React, TypeScript, MapLibre, and WebGL code must continue to avoid unnecessary Windows-only assumptions so later macOS work remains practical.

## Current user experience

- The radar map fills the window beneath the approved compact floating controls.
- The content-sized top toolbar uses the sequence `Mistr | source icon, recenter icon | eye icon`. There is no left application menu or About panel.
- The source panel begins with explicit `National` and `Site` choices. Selecting `Site` exposes the canonical searchable station browser; supporting and accessible text identifies National coverage as CONUS. Recenter follows the painted source, and the eye popup still contains only `Smooth` and `Native`.
- The source control's accessible truth follows the radar that actually painted, never merely the requested source. Acquisition retains a visible indicator and a compact notice naming both displayed and pending radar.
- During normal operation, the bottom bar shows displayed scan timestamp and numeric frame age alongside transport, direct timeline scrubbing, and active dBZ. It does not show `Fresh`, `Stale`, `Playing`, `Paused`, or `Newest`.
- The age is green only for the recent newest painted live scan. Historical, archive, and old latest-live frames use white; numeric age and accessible text ensure color is not the only truth cue.
- Site and National direct timeline dragging scrub resident observations; there are no dedicated previous/next buttons. National enables play only after at least two complete overview observations are resident and truthfully labels partial backfill. At regional zoom, play keeps the current frame visible while it prepares one sharp all-frame viewport level; the compact notice names that state and the play button cancels it.
- A map click leaves a reticle. Site uses the existing exact polar interrogation; National sends a bounded identity-bound point request to Rust's exact retained base grid and discards stale responses.
- `Smooth` filters only the spatial appearance of the current measured observation; `Native` shows exact nearest-sampled polar gates for Site and exact nearest selected-level cells for National. National smoothing never bridges missing/no-coverage cells. Both modes preserve exact backend interrogation, measured time, numeric age, and painted identity.
- Both modes share a display-only weak-return curve: non-positive dBZ is visually transparent, positive returns increase progressively to full opacity at 20 dBZ, and native inspection remains exact. Mistr does not call this meteorological clutter removal.
- Major roads, state boundaries, and important labels remain above radar with light-and-dark contrast. Motorway, trunk, and primary segments use one continuous zoom treatment instead of separate visibility bands. Far regional zooms keep coherent interstate and U.S.-highway networks while state and unnetworked routes fade in with the detailed source graph; local roads fade in gradually below radar. Matte water remains below radar without a polygon outline whose generated seams could change across zoom levels. Minor map detail remains subdued, and Mistr does not lower global radar opacity.
- Initial load, successful site change, and recenter fit measured radar coverage; user pan and zoom remain free afterward.
- Preparation, active history loading, graphics recovery, and error states remain explicit exceptional notices. Usable resident playback stays available during background history work, but normal playback no longer carries permanent loading/position/status words.
- No prototype phases, fixture selectors, benchmark buttons, or engineering counters appear in the normal product surface.
- Engineering alignment anchors remain installed for packaged evidence but are hidden in the product map.

## Current runtime behavior

### First launch

Mistr decodes and paints only the newest pinned KTLX archive observation as a safe startup bridge, then automatically acquires current live radar for the stored site or KTLX on a fresh profile. The remaining 19 archive fixtures are hydrated only when packaged diagnostics explicitly request the full loop. Before the first paint, the playback area shows plain-language preparation progress instead of `0 / 0`, `PAUSED`, or an inspect prompt.

The OpenFreeMap style graph is bundled with the frontend and radar initialization begins on MapLibre's local `style.load` event. Remote tiles, sprites, and glyphs may continue loading afterward; a basemap failure is named without blocking or mislabeling radar.

### Stored site and site selection

The archive establishes a safe initial display. Mistr then acquires the selected site's current safe Level II reflectivity observation. The site control's painted-site truth changes and persistence occurs only after matching GPU paint truth. Failed or superseded requests preserve the last trustworthy painted radar.

The Alpha catalog contains the 155 operational WSR-88D identifiers currently present in the fixed Unidata Level II chunks provider and the NOAA Radar Operations Center inventory, including Alaska, Hawaii, Guam, and Puerto Rico. KOUN is a test radar with no current provider prefix and is intentionally excluded, along with TDWR, decommissioned/test, foreign, and other provider-absent identifiers. TypeScript and Rust read the same committed catalog, so unsupported identifiers fail before network work.

Initial volume discovery first requests the bounded list of populated provider ring slots and then compares only that dense set under a 64-probe hard cap. A live KINX check on this branch completed in 3.14 seconds with 12 total requests including seven downloaded chunks; the prior sparse-slot search took about 40 seconds and 731 requests.

The existing resident archive/live loop remains playable and scrubbable while another site's network and decode work is staged. The controller pauses only for its bounded atomic replacement and authoritative GPU paint. A compact visible notice names both the radar still displayed and the live site being loaded; failure copy explains that the last completed scan remains visible.

The complete catalog, discovery, UI, evidence, and rollback contract is [Alpha UI and Live-Site Hardening](23_ALPHA_UI_AND_SITE_HARDENING.md).

### Radar rendering quality

The reflectivity palette uses the exact unrounded `(rawCode - offset) / scale` conversion. Below-threshold remains transparent and range-folded remains explicit. Valid-return RGB values stay pinned to the NOAA/NWS operational `SR_BREF` ramp, while a separate display-only curve uses alpha 0 at or below 0 dBZ, 56 at 5 dBZ, 120 at 10 dBZ, 184 at 15 dBZ, and 255 at or above 20 dBZ. This removes the dominant pale negative-dBZ disk and calms dense positive weak-return shimmer without changing native inspection truth.

The product exposes two bounded spatial display modes for the same observation. `Smooth` is the default presentation and may filter spatial gate edges without synthesizing time or changing data. `Native` is the exact nearest-gate view. Point interrogation remains native in both modes, so a visually smoothed or transparent pixel is never substituted for the measured gate's exact status and dBZ. The bundled OpenFreeMap graph adds no provider and has an explicit radar-context boundary: matte water, local streets, buildings, railways, water names, towns, and local road labels stay below radar; major routes, boundaries, important cities, states, and countries stay above it. Water polygons are deliberately not outlined because their generated tile seams and generalized geometry change across zoom levels. Motorway, trunk, and primary geometry is filtered together and uses continuous paint expressions, preventing Mistr's style from hiding or re-weighting parts of one route at integer zoom handoffs. Interstate and U.S.-highway networks remain visible regionally, while state and unnetworked routes transition from hidden to visible only as the detailed road graph arrives. Major road names are limited to primary/trunk classes, while minor and service-road names appear only at close zoom in a subdued below-radar layer. The complete truth, ownership, rollback, and acceptance contract is [Radar Rendering Quality](25_RADAR_RENDERING_QUALITY.md).

The real Windows/WebView2 release runtime compiled and exercised both shader paths at 3840x2160. Two 1,000-transition resident-playback scenarios passed with zero long tasks and zero hot-path acquisition or frame uploads. Switching `Native` to `Smooth` preserved the observation, paint receipt, 53,099,312-byte resident GPU set, and zero-upload delta. Compact 1100x700 and 1024x640 checks passed with keyboard selection, accessible mode naming, one-panel behavior, and focus restoration. Live acquisition/site supersession and two-pass context-recovery validation also passed on the same release build.

### Rolling live history

- The first successful live observation paints immediately and establishes both the newest and oldest committed provider-volume cursors.
- Sequential backfill targets the preceding ring slot, requires a strictly older measured start, prepends one observation per resident GPU transaction, and keeps the current/newest observation displayed.
- When history reaches 20 or safe backfill stops, background polling requests the exact next ring slot after the newest committed cursor and requires a newer measured start time.
- A cursor advances only after its observation joins the resident renderer transaction and authoritative paint truth is accepted. Retry therefore cannot silently skip a failed publication or trust a wrapped/replaced provider slot as older history.
- Observations remain chronological and are capped at 20. A duplicate is ignored; an out-of-order or cross-site/render-key response is rejected.
- Retained GPU textures are reused. Each normal poll uploads one new frame and evicts at most the oldest frame after commit.
- If paused at newest, Mistr follows the new scan and remains paused. If inspecting an older retained scan, that scan remains displayed. If it ages out, the oldest remaining scan paints.
- Active playback resumes after the brief incremental mutation. Playback and scrubbing remain available while the next volume is pending.
- Recoverable acquisition failure retains the last painted observation, reports degraded/error truth, keeps the committed cursor, and retries after a bounded delay.
- Site changes and diagnostics supersede polling through the existing monotonically increasing generation. Exactly two global IPC transfer credits remain the hard ownership bound.

The complete design and rollback contract is [Bounded Rolling Live History](21_BOUNDED_ROLLING_LIVE_HISTORY.md).

### Context recovery

Visible-first WebGL recovery remains in force. Context loss during an uncommitted resident mutation restores the prior CPU history before rehydration. The recovered radar layer is returned to its established position below diagnostic successors and the neutral operational map-context layers.

## Architecture retained

- Tauri 2 desktop shell
- Rust fixed-host anonymous acquisition, bounded decoding, predecessor and exact-next live cursors, cancellation, and packed-sweep IPC
- React 19, TypeScript, and Vite
- MapLibre GL basemap
- custom WebGL radar layer with bounded resident observations
- exactly two cross-IPC transfer credits
- generation-based site and request cancellation
- painted-frame receipts as display truth
- visible-first WebGL context recovery

The `window.__MISTR_PHASE4__`, `window.__MISTR_PHASE5__`, and `window.__MISTR_PHASE6__` diagnostic APIs remain required by packaged evidence runners. They are not normal product controls.

The merged hidden `window.__MISTR_NATIONAL_PHASE2__` and `window.__MISTR_NATIONAL_PHASE3__` diagnostics remain available. Phase 4 adds hidden `window.__MISTR_NATIONAL_PHASE4__` controls for bounded history, resident transitions, direct scrub evidence, activity counters, quality locking, and all-frame context recovery; these are evidence surfaces rather than product controls.

## Merged National Phases 1 through 4

Merged PR #15 supplies the internal source boundary required before National acquisition work:

- `RadarSourceKey` is a closed union of `{ kind: "site", siteIcao }` and the future `{ kind: "national", domain: "conus" }` identity;
- `RadarSessionCoordinator` owns requested-source intent, last authoritative painted source, monotonic source-transition generations, supersession, rollback, stale receipt rejection, and persistence after paint;
- `SiteLevel2Session` adapts the already-qualified selected-site acquisition/history/renderer path to that coordinator without changing Level II decoding, rolling history, playback, transfer credits, or GPU behavior;
- the safe startup archive establishes painted Site truth without overwriting a stored live-site preference;
- user and startup site requests persist only after a matching GPU receipt is accepted; diagnostic transitions do not persist;
- failed or superseded transitions retain the previous painted source; and
- no incomplete National UI, numeric-grid renderer, or National timeline was introduced.

Merged PR #16 adds the National data and wire foundation:

- fixed anonymous HTTPS to `noaa-mrms-pds.s3.amazonaws.com`, exact current/previous UTC-day inventory, measured-time ordering, strict keys, no redirects, bounded response bodies, and rejection of HTML/XML in successful binary responses;
- a product-specific decoder for the reviewed `MergedBaseReflectivityQC_00.50` GRIB2 Template 5.41/16-bit grayscale PNG contract, including exact product, time, 7,000 by 3,500 grid, orientation, scaling, and status checks;
- durable exact `u16` raw codes with `R=-9990`, `E=0`, `D=1`, missing raw `9000`, and no-coverage raw `0`; every other structurally valid code is decoded by formula rather than fixture membership;
- power-of-two numeric levels using strongest-valid, then missing, then no-coverage reduction;
- big-endian `PackedGrid v1` manifests and independently hashed chunks with one-cell halos, strict Rust and TypeScript validation, and small cross-language fixtures;
- a directly indexed, count- and byte-bounded prepared backend cache;
- National manifest and chunk leases through the existing single global two-credit broker; and
- a non-shipping 30-observation release diagnostic that simultaneously retains every immutable compressed source object, validates the unchanged schema/working-set model, and returns to the prior Site loop without National paint or persistence.

Merged PR #17 adds:

- `NationalMrmsSession` behind the one `RadarSessionCoordinator`, preserving source intent separately from the old painted source until a matching receipt commits;
- one newest exact MRMS observation, with factor-4 complete-domain overview and factor-1 camera-detail working sets generated from the same retained base grid;
- a separate `NationalGridLayer` using `R16UI` chunk textures, one-cell halos, Native nearest-cell sampling, and Smooth interpolation only across four valid cells;
- a `NationalWorkingSetController` that validates complete coverage, transports one chunk lease at a time, uploads each texture in bounded row bands over animation frames, enforces a 4 ms per-frame upload ceiling, and rolls incomplete staging back;
- authoritative receipts containing observation, generation, content hash, presentation factor, coverage version/kind, chunk count, context epoch, timing, bytes, and framebuffer size after a GPU fence;
- exact Rust-owned base-grid point lookup tied to the painted generation, observation time, content hash, and geographic inspection identity;
- explicit `National` and `Site` top-level choices with CONUS copy, source-aware recenter, one-observation National timeline truth, and persistence only after paint; and
- visible-first rehydration after real WebGL context loss without network work.

Merged PR #18 adds:

- Rust-owned immutable compressed history plus complete factor-4 `PackedGrid` overviews, chronological current/predecessor/newer staging, a 20-frame cap, one-frame eviction, and a 180 MiB backend target;
- newest-first current paint followed by up to 19 predecessors without changing the selected newest observation;
- transient predecessor prepare/transfer/GPU failures retain and retry the same unconsumed candidate with capped jitter/backoff before newer-only polling; if the Rust preparation completed but its IPC response was lost, predecessor/newer retry returns the exact stored stage with an explicit reused marker and the frontend accepts its zero-work metrics without weakening fresh-acquisition validation;
- all retained overview frames resident as `R16UI` chunks, with an authoritative receipt for every selected observation and a 256 MiB hard radar ceiling;
- a provisional GPU/backend commit handshake with an identity-bound reversible Rust journal, so context loss, supersession, or backend failure restores both the prior chronology (including an evicted oldest frame) and the prior complete resident presentation; the backend byte ledger also counts a prior detailed frame whenever replacement leaves it uniquely journal-owned, while a lost seal response may retry the last finalized identity idempotently and post-finalization context recovery must supply a fresh matching receipt before publication;
- adaptive common-quality playback: exact factor 1 for all retained frames when the regional viewport fits under 200 MiB, factor 2 as the bounded fallback, and factor 4 for complete-domain overview/failure rollback; after preparation, play has no network, grid-decode, bulk-IPC, or upload work;
- exact selected-frame factor-1 refinement after pause/scrub settle, bounded detail prefetch for the adjacent temporal window, camera-bound cancellation/restart, and common factor-4 fallback for every retained frame;
- matching prepared exact detail reused across paused camera moves instead of re-decoding and re-encoding the same full CONUS frame;
- overlapping camera/diagnostic refinement callers await the active exact-viewport operation rather than observing its stale overview predecessor;
- finalizing a newer observation releases the superseded initial exact-pyramid acceleration cache, while immutable compressed history remains available for safe detail/interrogation re-decode;
- strictly newer inventory polling with bounded jitter/backoff and preservation of the last painted observation through failure;
- exact retained-observation point lookup bound to painted generation, time, content hash, and inspection identity, with a persistent inspection re-queried and cleared across every observation cut, one active expensive lookup, only the newest pending receipt retained, and every replaced or cancelled pending caller settled immediately with no result;
- National-to-Site ordering that lets an observed National acquisition/finalization transaction settle before transfer-generation cancellation, then rechecks current Site intent;
- visible-first rehydration of the selected frame followed by all common residents from CPU-owned bytes, without network dependence; and
- automatic National session restart on a newer generation when a Site replacement cancels National work but fails before authoritative Site paint, first pausing and awaiting old resident playback/working-set activity and leaving the prior complete National frame visible throughout.

The existing Phase 4, 5, 6, readiness, history, UI, and map-quality diagnostic surfaces remain required and unchanged.

## Validation state

### Merged National Phase 4 evidence and visual-fidelity correction

Twelve passing 3840x2160 Windows/WebView2 runs across review hardening retained 20 exact chronological NOAA MRMS observations spanning 37.70 to 38.10 minutes and kept all 20 complete factor-4 overviews GPU resident; the latest runs include identity-bound ambiguous rollback recovery. Each completed 1,000 direct resident transitions plus oldest/newest scrubs with zero network requests, response bytes, decoder runs, IPC transfers, IPC bytes, or texture uploads in the measured hot path. The highest National GPU allocation was 65,201,668 bytes and the highest passing upload slice across initial staging, detail, and both recovery passes was 2.20 ms. Two review-fix runs correctly rejected isolated 4.40 and 5.50 ms recovery slices at 96/64 rows; the threshold was not relaxed. The unchanged final 32-row renderer then passed four consecutive runs at 1.70, 1.90, 1.80, and 2.10 ms, including the latest full source, and every provisional mutation finalized before UI publication. The evidence runner holds one bounded resident reservation across timeline-sensitive assertions so a normal live MRMS rollover cannot make it compare different valid 20-frame histories.

At high zoom, the selected observation and one adjacent temporal observation refined to exact factor-1 viewport chunks while the common factor-4 level remained available for the entire loop. The original merged implementation returned active playback to factor 4 to avoid mixed quality. User evidence then demonstrated that this made Native blocky and Smooth blurry at regional zoom even though exact all-frame viewport detail fit the budget. The focused correction prepared all 20 frames at exact factor 1 before playback, retained one locked quality, used 83,397,504 to 86,060,064 GPU bytes across passing runs, added no acquisition, grid decoding, bulk IPC, or texture uploads after motion began, and kept upload slices at or below 3.10 ms. One unchanged-binary run correctly rejected a 6.30 ms forced-recovery slice; the strict 4 ms gate was not relaxed and the immediate unchanged rerun passed at 3.10 ms. A second full packaged run again held 20 factor-1 detail residents with no transfer/upload hot-path work; its intentional latest-only exact point lookups refreshed the persistent inspection as observation identity changed. Camera changes now cancel superseded preparation and re-prepare the new viewport before resuming. The same focused correction keeps Play and direct scrubbing enabled while another backfill frame stages against a complete resident timeline, delaying the replacement-pending barrier until the actual atomic commit. The release runner observed 1,738 partial-history UI samples across retained counts 2 through 19; all 1,279 stable staging samples exposed an enabled Play button. The first full run later rejected an unrelated 17.00 ms forced-recovery scheduling outlier under the unchanged 4 ms gate; the one unchanged rerun passed at 1.90 ms with no acceptance failures. Smooth and Native share this level, while extreme zoom remains limited by NOAA MRMS's approximately one-kilometre native cells. The dedicated command is `npm run test:national:phase4:packaged`; ignored evidence is written under `artifacts/national-phase-4/`.

The merged Phase 4 baseline passed `npm run verify`: the public scan covered 278 candidate files, documentation links covered 81 Markdown files, all 49 frontend/script test files passed with 285 tests, the production TypeScript/Vite build passed, and all 134 Rust tests across the library and binary targets passed with formatting, warnings-denied clippy, and `cargo check`. Deterministic tests prove complete resident counts remain blocked until recovery is actually painted and fenced, identity-bound rollback and finalization both continue beyond three failures, a replaced detail remains in the backend byte ledger while its rollback journal owns it, exact snapshots recover lost successful responses, source handoff awaits an in-flight selection, superseded inspection callers settle without waiting for the active decode, drain-settlement arrivals are not stranded, a painted renderer clears stale playback error state, healthy no-newer polling clears stale errors, and delay-command failure falls back without stopping polling. Separate release-runtime reruns passed the merged National Phase 2 and Phase 3 gates plus the unchanged selected-site Phase 4, Phase 5, and two-pass Phase 6 gates.

### Merged Phase 3 evidence

The packaged 3840x2160 Windows/WebView2 run acquired `MRMS_MergedBaseReflectivityQC_00.50_20260804-012808.grib2.gz`, retained 64,312,500 backend bytes, and painted all 28 factor-4 overview chunks. The overview used 3,108,788 GPU resource bytes and staged in 186.4 ms across animation frames. It then centered the strongest exact retained sample at 61.5 dBZ and painted an eight-chunk factor-1 viewport in 83.3 ms. The stable and peak detailed state retained all 28 overview chunks as complete-domain fallback, reported 36 resident chunks, and used 4,173,812 bytes. Working-set uploads peaked at 0.70 ms and time-sliced recovery uploads at 1.40 ms, both below the 4 ms ceiling.

Native and Smooth preserved the same observation/time identity while 1,219,013 captured 4K pixels changed between their spatial presentations. A real `WEBGL_lose_context` reset rehydrated visible detail first and then the complete overview fallback through bounded animation-frame upload slices, advancing the receipt from context epoch 1 to 2 while preserving observation, presentation factor, coverage identity, and all 36 resident chunks. The final broker snapshot had exactly two available credits and zero held/in-flight credits. A National-to-KTLX transition then completed with Site paint truth and no mixed timeline. The dedicated command is `npm run test:national:phase3:packaged`; generated reports and screenshots remain ignored.

Phase 3 unit/source validation passed 40 frontend/script test files with 251 tests, 115 Rust library tests plus Rust binary targets, the production build, and documentation/public scans. The merged National Phase 2 packaged gate and the established packaged Phase 4/5/6 regressions also passed; exact commands are recorded in the Phase 3 report.

### Merged Phase 2 evidence

The final real Windows/WebView2 release diagnostic acquired 30 distinct latest NOAA MRMS observations using 31 bounded network requests, spanning 57.90 minutes. It simultaneously retained all 30 immutable compressed source objects in 44,094,473 bytes, strictly decoded each exact 49,000,000-byte base grid, generated and wire-validated all 840 factor-4 chunks, and transferred the newest 28-chunk frame through the sole global broker. Holding two leases made a third return `credit_exhausted`; the final snapshot returned both credits.

The measured factor-4 numeric payload ledger is 3,104,644 bytes per frame including halos, 65,197,524 bytes for 20 frames plus one staged frame, and 96,243,964 bytes for 30 plus staging. The 30-frame result stays below the 200 MiB target without changing `PackedGrid v1` or the numeric working-set model. It is payload-budget evidence, not a claim that a National renderer or GPU allocation exists.

After the diagnostic, the release runtime restored the existing 20-frame KTLX Site loop and `nexrad_level2_archive_ii` painted-source truth.

The complete merged Phase 2 validation passed:

- `npm run verify`: public scan of 241 candidate files, links across 78 Markdown files, 232 frontend tests, production TypeScript/Vite build, Rust formatting, clippy with warnings denied, 121 Rust tests across the library and binaries including the cached four-season MRMS oracle, and Rust check;
- packaged National Phase 2: 30 retained and decoded observations, 840 validated chunks, the 30-frame memory extension, complete newest-frame transfer, two-credit backpressure/release, and Site restoration described above;
- packaged Phase 4: both 1,000-transition Native/Smooth 4K scenarios passed with 20 residents, 6.2 ms frame-time P95, zero long tasks, zero hot-path acquisition/uploads, unchanged 53,099,312-byte GPU residency, mode-switch truth, pixel evidence, rolling history, and context recovery;
- packaged Phase 5: in-flight KAMX-to-KTLX supersession preserved the `live_sweep_failed` diagnostic code, then two chronological KTLX observations painted with two residents and direct oldest/newest scrubbing; and
- packaged Phase 6: both release-runtime N0S, real WebGL context-recovery, minimize/restore, restart, and cold-start passes succeeded.

These gates show that Phase 2 did not weaken the current selected-site product or its diagnostic APIs. Merged Phase 3 is the first National rendering/product proof and remains one-frame-only on `main`; Phase 4 history is isolated to its review branch until merge.

### Merged Phase 1 evidence

The merged National Phase 1 foundation passed the full source and packaged regression contract on its branch checkpoint:

- `npm run verify`: public scan of 225 candidate files, links across 76 Markdown files, 227 frontend tests, production TypeScript/Vite build, Rust formatting and clippy with warnings denied, 98 Rust tests across library and binaries, and Rust check;
- packaged Phase 4: an unchanged rerun passed both 1,000-transition Native/Smooth scenarios at 3840x2160 with 20 residents, 6.2 ms frame-time P95, zero long tasks, zero hot-path acquisition/uploads, stable 53,099,312-byte GPU residency, and passing rolling-history/context-recovery evidence;
- the first Phase 4 run crossed only the documented non-consecutive stabilized-heap sampling threshold while every radar-specific gate passed; the immediate unchanged rerun passed, so `DRF-004` remains closed under its existing two-consecutive-failures reopen rule;
- packaged Phase 5 passed deterministic in-flight source supersession with the preserved `live_sweep_failed` diagnostic code, then painted two chronological KTLX observations beginning at provider volume 885 with direct oldest/newest scrubbing; and
- packaged Phase 6 passed both release-runtime N0S, real WebGL context-recovery, minimize/restore, restart, and cold-start runs.

An intermediate Phase 5 run exposed that wrapping a superseded provider error erased its established diagnostic code. Phase 1 now marks the original error object as superseded without replacing it, so UI callbacks can ignore stale work while packaged diagnostics retain the exact provider code. A regression test covers that ownership boundary.

These Phase 1 results prove selected-site behavior through the coordinator refactor. Phase 2's separate evidence proves acquisition/decoding/wire behavior only; neither result proves or implies a National renderer, product history, or UI behavior.

The merged rolling-history change passed:

- 126 frontend tests;
- 89 Rust tests across the library and workspace binaries;
- TypeScript compilation and the production Vite build;
- Rust formatting, clippy with warnings denied, tests, and check;
- packaged Phase 4 at 3840x2160 with two 1,000-transition scenarios, 19 incremental history updates per scenario, forced bounded eviction, direct oldest/newest scrub, real context loss/restoration, zero long tasks, and zero hot-path acquisition/uploads;
- packaged Phase 5 at 3840x2160 with site supersession, real KTLX volumes 560 then exact-next 561, two chronological GPU-resident observations, one incremental upload, and direct oldest/newest scrub;
- both packaged Phase 6 N0S, context-recovery, minimize/restore, and cold-restart passes; and
- compact 1100x700 layout inspection with no document overflow and both floating instruments inside the viewport.

The merged release-readiness change passed `npm run verify`: the public-repository scan, documentation links, 154 frontend tests, the production frontend build, Rust formatting, clippy with warnings denied, 89 Rust tests, and Rust check. Generated fixtures, provider responses, installed-product reports, screenshots, and installers remain ignored and uncommitted.

The merged UI/live-site hardening change passed the full source-level `npm run verify` contract plus packaged Windows validation. The packaged Phase 4 run completed both 1,000-transition scenarios at 3840x2160 with zero long tasks and zero hot-path acquisition/uploads. Packaged Phase 5 cancelled a superseded site request and painted chronological KTLX volumes 666 and 667 with direct oldest/newest scrub. Both Phase 6 passes succeeded. The readiness matrix passed at 3840x2160, 1100x700, and 1024x640 with correct keyboard focus/return, a stable playback bar, no unnamed controls, forced-colors focus, reduced motion, and 5.09:1 inactive-instruction contrast.

The current rendering-quality change passes `npm run verify`: the public scan, documentation links, 193 frontend tests, production frontend build, Rust formatting and clippy with warnings denied, 98 Rust tests, and Rust check. The exact release binary passed separate 1,000-transition `Native` and `Smooth` Phase 4 scenarios at 3840x2160, automated nonblank/distinct/background-retaining pixel evidence, both modes at 3840x2160, 1100x700, and 1024x640, Native live site supersession, Smooth exact-next live history and direct scrubbing, and one Native plus one Smooth Phase 6 context-recovery pass. A timestamp-matched packaged Smooth KAMX scan also aligned with the official `SR_BREF` operational color bands without changing Mistr's Level II engine. Demonstrated review defects in rollback ownership were corrected so the playback controller performs one bounded Native retry from the first startup paint through later play and scrub selections, accepts the matching paint receipt, and synchronizes the visible mode; the renderer owns the equivalent rollback for a mode-only repaint that has no playback promise. Resource-wide failures remain explicit. Independent final audits found no other demonstrated renderer, UI, accessibility, persistence, ownership, evidence, or public-delivery defect after the documented checkpoints were corrected.

The active radar-chrome hardening passes `npm run verify`: the public scan, documentation links, 204 frontend tests, production frontend build, Rust formatting and clippy with warnings denied, 98 Rust tests, and Rust check. The exact Windows/WebView2 release executable passed the accessibility/readiness matrix in both display modes at 3840x2160, 1100x700, and 1024x640. Evidence covers three measured 40-by-40-pixel toolbar targets at every viewport, toolbar arrow/Home navigation, site and view panel focus/return, the exact `Radar View` tooltip, one-panel ownership, a stable playback bar, direct scrub accessibility truth, forced colors, reduced motion, 5.09:1 inactive-instruction contrast, and absence of the retired application menu. A separate real-data packaged soak acquired four chronological KTLX observations in 0.1 minutes, exposed the exceptional recent-history loading notice, rendered the recent newest age as numeric green text with matching accessible meaning, uploaded exactly four frames, retained bounded GPU memory, passed direct oldest/newest scrub, and recovered a real WebGL context.

The active radar-legibility build passes `npm run verify`: the public scan, documentation links, 218 frontend tests, production frontend build, Rust formatting and clippy with warnings denied, 98 Rust tests, and Rust check. Its exact Windows/WebView2 release executable passed separate `Native` and `Smooth` 1,000-transition Phase 4 scenarios at 3840x2160 with zero long tasks, zero hot-path acquisition/uploads, 6.2/6.2 ms frame-time P95, no mode-switch upload, and the unchanged 53,099,312-byte resident GPU set. Pixel evidence retained 33.0% common background, and runtime layer evidence placed local context below radar before beginning essential context at `highway_major_context_casing`. The 3840x2160, 1100x700, and 1024x640 readiness matrix passed in both modes, and both Phase 6 cold-start/context-recovery passes succeeded. A packaged live KOKX observation at `2026-08-03T04:18:59Z` retained coherent precipitation while removing the bright road mesh that previously fragmented the storm. Exact release sweeps across Lancaster through Barstow at zoom 5.5 through 11.5 retained continuous CA-58 hierarchy, while a focused Lake Isabella sweep at zoom 5.5 through 8.5 confirmed that the isolated generalized Route 178 fragment remains hidden until its connecting state-road geometry appears. Downloaded volumes and screenshots remain ignored.

The final release executable and bundles also pass:

- the packaged live soak with exact-next KTLX volumes 569 through 572, four chronological resident frames, exactly four incremental uploads, direct oldest/newest scrub, bounded GPU memory, and real context recovery;
- the superseding current-first packaged soak with a 1.27-second safe first paint, KTLX volume 676 plus predecessors through 657, 20 chronological resident frames in 0.6 minutes, exact incremental uploads, bounded GPU memory, deterministic in-flight site cancellation, direct scrub, and real context recovery;
- a packaged cold start with WebView2's network proxy deliberately blackholed, where the bundled safe radar still painted in 1.26 seconds without remote basemap resources;
- the packaged accessibility/readiness gate at 3840x2160, 1100x700, and 1024x640, including keyboard focus/return, forced colors, reduced motion, accessibility-tree names, slider truth, stable playback position, and 5.09:1 inactive-instruction contrast;
- two consecutive packaged Phase 4 runs, each containing two 1,000-transition scenarios with zero long tasks, zero hot-path acquisition/uploads, 20 resident frames, and unchanged heap limits;
- both packaged Phase 6 cold-start, N0S, context-recovery, minimize/restore, and restart passes;
- final `0.1.0` NSIS and MSI upgrade-from-`0.0.1`, installed first-launch 20-frame GPU paint, and uninstall checks;
- independent NSIS and MSI install/launch/uninstall in a clean Windows 11 Enterprise Sandbox; and
- a real Windows sleep/wake cycle with a 34,387 ms heartbeat gap, active pre-sleep playback, 20 painted residents before and after wake, resumed playback, and a matching post-wake direct-scrub receipt.

The repeated Phase 4 heap finding was investigated rather than waived. Allocation sampling traced the retained growth to MapLibre's parsed offscreen basemap tiles at 4K, not radar observations. Mistr now disables that out-of-view parsed-tile cache, and the runner waits for MapLibre's public `idle` signal before its existing two garbage collections. No threshold changed. Two consecutive final stabilized pairs were 79,102,293 to 83,581,348 bytes and 79,183,520 to 84,097,819 bytes. `DRF-004` is closed.

Release readiness also corrects a demonstrated installer defect: prior bundles did not carry the pinned archive resources and could remain running while unable to establish first-launch radar outside the repository. The exact 20 hash-pinned archives are now explicit ignored build resources, resolved through Tauri's packaged resource directory. The real sleep/wake gate closes `DRF-003`, and the enhanced public scanner closes `DRF-001` and `DRF-002`. See [Alpha Release Readiness](22_ALPHA_RELEASE_READINESS.md).

## Pull-request checkpoint

PR #8, rolling-history [PR #9](https://github.com/tcurtsinger/Mistr/pull/9), release-readiness [PR #10](https://github.com/tcurtsinger/Mistr/pull/10), UI/live-site hardening [PR #11](https://github.com/tcurtsinger/Mistr/pull/11), rendering quality [PR #12](https://github.com/tcurtsinger/Mistr/pull/12), radar-chrome hardening [PR #13](https://github.com/tcurtsinger/Mistr/pull/13), radar legibility [PR #14](https://github.com/tcurtsinger/Mistr/pull/14), National coordinator foundation [PR #15](https://github.com/tcurtsinger/Mistr/pull/15), National MRMS data/wire foundation [PR #16](https://github.com/tcurtsinger/Mistr/pull/16), National static renderer [PR #17](https://github.com/tcurtsinger/Mistr/pull/17), and National history/playback [PR #18](https://github.com/tcurtsinger/Mistr/pull/18) are merged.

Review workflow:

1. Read live checks, reviews, conversation comments, and thread-aware `reviewThreads`.
2. Independently verify every comment against current code.
3. Fix demonstrated wrong behavior, unsafe ownership, performance regression, broken UI truth, or failed acceptance gates.
4. Record only genuinely non-blocking edge cases in [Deferred review findings](DEFERRED_REVIEW_FINDINGS.md).
5. Reply with disposition and evidence, then resolve every thread that is closed.
6. Re-run affected local and packaged checks, commit, and push to the same branch.
7. Never merge; only the user merges.

## Next work after this checkpoint

Complete and review only the demonstrated National playback visual-fidelity correction. Do not begin the Phase 5 long-session, rollover, device-floor, installer, sleep/wake, or clean-machine matrix on this branch. Microsoft Store packaging and signing remain paused.

## Public-repository safety

Never commit credentials, environment files, signing material, downloaded radar archives, arbitrary provider responses, local diagnostic bundles, or packaged screenshots. Keep fixture provenance and hashes in reviewed manifests, keep downloaded bytes in ignored cache directories, and run `npm run public:check` before every commit.
