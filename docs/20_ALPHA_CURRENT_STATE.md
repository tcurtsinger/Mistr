# Alpha Current State

**Checkpoint:** 2026-08-02

**Merged baseline:** [PR #13 - Harden the radar chrome](https://github.com/tcurtsinger/Mistr/pull/13), merge commit `28322ef`

**Active change:** [PR #14 - Improve radar legibility and map context](https://github.com/tcurtsinger/Mistr/pull/14)

**Branch:** `codex/mistr-radar-legibility`

This document is the durable starting point for the next Mistr development session. Verify the active branch, worktree, and any future pull-request checks or threads before acting because repository state can change after this checkpoint.

## Product decision

Mistr is the product. Alpha remains deliberately narrow: one selected NEXRAD site, live high-resolution base reflectivity, smooth pan and zoom, and a truthful recent-observation timeline. National mosaic, velocity UI, alerts, cameras, video, notifications, broad settings, and the wider GustAVO feature set remain outside Alpha v1.

Windows is the Alpha release platform. Shared Tauri, Rust, React, TypeScript, MapLibre, and WebGL code must continue to avoid unnecessary Windows-only assumptions so later macOS work remains practical.

## Current user experience

- The radar map fills the window beneath the approved compact floating controls.
- The content-sized top toolbar uses the sequence `Mistr | site icon, recenter icon | eye icon`. There is no left application menu or About panel.
- The site icon opens the single canonical searchable site browser, recenter is a direct command, and the eye icon opens a radar-view popup containing only `Smooth` and `Native`. Its tooltip is `Radar View`; fixed product and elevation facts are not presented as controls.
- The site control's accessible truth follows the radar that actually painted, never merely the requested site. Site acquisition retains a visible indicator and a compact notice naming both displayed and pending radar.
- During normal operation, the bottom bar shows displayed scan timestamp and numeric frame age alongside transport, direct timeline scrubbing, and active dBZ. It does not show `Fresh`, `Stale`, `Playing`, `Paused`, or `Newest`.
- The age is green only for the recent newest painted live scan. Historical, archive, and old latest-live frames use white; numeric age and accessible text ensure color is not the only truth cue.
- Direct timeline dragging scrubs resident observations; there are no dedicated previous/next buttons.
- A map click leaves a reticle, and its dBZ value is recomputed whenever another observation paints.
- `Smooth` filters only the spatial appearance of the current measured observation; `Native` shows exact nearest-sampled polar gates. Both modes preserve native gate/status interrogation, measured time, numeric age, and painted-frame truth.
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

## Validation state

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

PR #8, rolling-history [PR #9](https://github.com/tcurtsinger/Mistr/pull/9), release-readiness [PR #10](https://github.com/tcurtsinger/Mistr/pull/10), UI/live-site hardening [PR #11](https://github.com/tcurtsinger/Mistr/pull/11), rendering quality [PR #12](https://github.com/tcurtsinger/Mistr/pull/12), and radar-chrome hardening [PR #13](https://github.com/tcurtsinger/Mistr/pull/13) are merged. Radar legibility is ready for review in [PR #14](https://github.com/tcurtsinger/Mistr/pull/14) on `codex/mistr-radar-legibility`. It is not a draft. Only the repository owner merges.

Review workflow:

1. Read live checks, reviews, conversation comments, and thread-aware `reviewThreads`.
2. Independently verify every comment against current code.
3. Fix demonstrated wrong behavior, unsafe ownership, performance regression, broken UI truth, or failed acceptance gates.
4. Record only genuinely non-blocking edge cases in [Deferred review findings](DEFERRED_REVIEW_FINDINGS.md).
5. Reply with disposition and evidence, then resolve every thread that is closed.
6. Re-run affected local and packaged checks, commit, and push to the same branch.
7. Never merge; only the user merges.

## Next work after this checkpoint

Do not begin national radar work. Continue owner-led UI and runtime hardening, then return to Store packaging only after the normal radar surface is accepted. Real sleep/wake and clean-machine installation are closed. The existing NSIS and MSI evidence remains useful, but new public packaging waits for this surface to stabilize.

## Public-repository safety

Never commit credentials, environment files, signing material, downloaded radar archives, arbitrary provider responses, local diagnostic bundles, or packaged screenshots. Keep fixture provenance and hashes in reviewed manifests, keep downloaded bytes in ignored cache directories, and run `npm run public:check` before every commit.
