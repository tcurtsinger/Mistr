# Alpha Current State

**Checkpoint:** 2026-08-02

**Merged product engine:** [PR #9 — Add bounded rolling live radar history](https://github.com/tcurtsinger/Mistr/pull/9), merge commit `444d500`

**Active change:** Alpha release readiness

**Branch:** `codex/mistr-alpha-release-readiness`

This document is the durable starting point for the next Mistr development session. Verify the active pull request, checks, and thread state on GitHub before acting because review status can change after this checkpoint.

## Product decision

Mistr is the product. Alpha remains deliberately narrow: one selected NEXRAD site, live high-resolution base reflectivity, smooth pan and zoom, and a truthful recent-observation timeline. National mosaic, velocity UI, alerts, cameras, video, notifications, broad settings, and the wider GustAVO feature set remain outside Alpha v1.

Windows is the Alpha release platform. Shared Tauri, Rust, React, TypeScript, MapLibre, and WebGL code must continue to avoid unnecessary Windows-only assumptions so later macOS work remains practical.

## Current user experience

- The radar map fills the window beneath the approved compact floating controls.
- The top context names the site that actually painted, never merely the requested site.
- The bottom bar keeps displayed scan time, freshness, playback state/position, and active dBZ visible.
- Direct timeline dragging scrubs resident observations; there are no dedicated previous/next buttons.
- A map click leaves a reticle, and its dBZ value is recomputed whenever another observation paints.
- Initial load, successful site change, and recenter fit measured radar coverage; user pan and zoom remain free afterward.
- A partial live loop adds `BUILDING n/20` beside the visible playback position without hiding freshness or disabling resident interaction.
- No prototype phases, fixture selectors, benchmark buttons, or engineering counters appear in the normal product surface.

## Current runtime behavior

### First launch

Without a stored site, Mistr opens the pinned 20-observation KTLX reflectivity archive loop, paints its newest observation, remains paused, and explicitly says `ARCHIVE LOOP`.

### Stored site and site selection

The archive establishes a safe initial display. Mistr then acquires the selected site's current safe Level II reflectivity observation. The site label changes and persistence occurs only after matching GPU paint truth. Failed or superseded requests preserve the last trustworthy painted radar.

The Alpha site list remains KTLX, KOUN, KINX, KVNX, and KFDR.

### Rolling live history

- The first successful live observation establishes a selected-site history and a committed provider-volume cursor.
- Background polling requests the exact next ring slot after that cursor and requires a newer measured start time.
- The cursor advances only after the observation joins the resident renderer transaction and authoritative paint truth is accepted. Retry therefore does not silently skip the failed publication.
- Observations remain chronological and are capped at 20. A duplicate is ignored; an out-of-order or cross-site/render-key response is rejected.
- Retained GPU textures are reused. Each normal poll uploads one new frame and evicts at most the oldest frame after commit.
- If paused at newest, Mistr follows the new scan and remains paused. If inspecting an older retained scan, that scan remains displayed. If it ages out, the oldest remaining scan paints.
- Active playback resumes after the brief incremental mutation. Playback and scrubbing remain available while the next volume is pending.
- Recoverable acquisition failure retains the last painted observation, reports degraded/error truth, keeps the committed cursor, and retries after a bounded delay.
- Site changes and diagnostics supersede polling through the existing monotonically increasing generation. Exactly two global IPC transfer credits remain the hard ownership bound.

The complete design and rollback contract is [Bounded Rolling Live History](21_BOUNDED_ROLLING_LIVE_HISTORY.md).

### Context recovery

Visible-first WebGL recovery remains in force. Context loss during an uncommitted resident mutation restores the prior CPU history before rehydration. The recovered radar layer is returned to its established position below diagnostic successors and map symbol labels.

## Architecture retained

- Tauri 2 desktop shell
- Rust fixed-host anonymous acquisition, bounded decoding, exact-next live cursor, cancellation, and packed-sweep IPC
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

The release-readiness branch now passes `npm run verify`: the public-repository scan, documentation links, 154 frontend tests, the production frontend build, Rust formatting, clippy with warnings denied, 89 Rust tests, and Rust check. Generated fixtures, provider responses, installed-product reports, screenshots, and installers remain ignored and uncommitted.

The final release executable and bundles also pass:

- the packaged live soak with exact-next KTLX volumes 569 through 572, four chronological resident frames, exactly four incremental uploads, direct oldest/newest scrub, bounded GPU memory, and real context recovery;
- the packaged accessibility/readiness gate at 3840x2160, 1100x700, and 1024x640, including keyboard focus/return, forced colors, reduced motion, accessibility-tree names, slider truth, stable playback position, and 5.09:1 inactive-instruction contrast;
- two consecutive packaged Phase 4 runs, each containing two 1,000-transition scenarios with zero long tasks, zero hot-path acquisition/uploads, 20 resident frames, and unchanged heap limits;
- both packaged Phase 6 cold-start, N0S, context-recovery, minimize/restore, and restart passes;
- final `0.1.0` NSIS and MSI upgrade-from-`0.0.1`, installed first-launch 20-frame GPU paint, and uninstall checks;
- independent NSIS and MSI install/launch/uninstall in a clean Windows 11 Enterprise Sandbox; and
- a real Windows sleep/wake cycle with a 34,387 ms heartbeat gap, active pre-sleep playback, 20 painted residents before and after wake, resumed playback, and a matching post-wake direct-scrub receipt.

The repeated Phase 4 heap finding was investigated rather than waived. Allocation sampling traced the retained growth to MapLibre's parsed offscreen basemap tiles at 4K, not radar observations. Mistr now disables that out-of-view parsed-tile cache, and the runner waits for MapLibre's public `idle` signal before its existing two garbage collections. No threshold changed. Two consecutive final stabilized pairs were 79,102,293 to 83,581,348 bytes and 79,183,520 to 84,097,819 bytes. `DRF-004` is closed.

Release readiness also corrects a demonstrated installer defect: prior bundles did not carry the pinned archive resources and could remain running while unable to establish first-launch radar outside the repository. The exact 20 hash-pinned archives are now explicit ignored build resources, resolved through Tauri's packaged resource directory. The real sleep/wake gate closes `DRF-003`, and the enhanced public scanner closes `DRF-001` and `DRF-002`. See [Alpha Release Readiness](22_ALPHA_RELEASE_READINESS.md).

## Pull-request checkpoint

PR #8 and rolling-history [PR #9](https://github.com/tcurtsinger/Mistr/pull/9) are merged. The release-readiness branch will be committed, pushed, and opened as a new **ready-for-review** pull request only after the automated gates finish and every remaining manual release blocker is stated plainly. Only the repository owner merges.

Review workflow:

1. Read live checks, reviews, conversation comments, and thread-aware `reviewThreads`.
2. Independently verify every comment against current code.
3. Fix demonstrated wrong behavior, unsafe ownership, performance regression, broken UI truth, or failed acceptance gates.
4. Record only genuinely non-blocking edge cases in [Deferred review findings](DEFERRED_REVIEW_FINDINGS.md).
5. Reply with disposition and evidence, then resolve every thread that is closed.
6. Re-run affected local and packaged checks, commit, and push to the same branch.
7. Never merge; only the user merges.

## Next decision after this change merges

Do not begin national radar work. Review the release-readiness evidence and make an explicit owner release/no-release decision. Real sleep/wake and clean-machine installation are closed. The final NSIS and MSI files are intentionally unsigned; the remaining owner action is to inspect or explicitly accept the Windows warning and document the user-facing installation instructions before a public Alpha artifact is described as ready.

## Public-repository safety

Never commit credentials, environment files, signing material, downloaded radar archives, arbitrary provider responses, local diagnostic bundles, or packaged screenshots. Keep fixture provenance and hashes in reviewed manifests, keep downloaded bytes in ignored cache directories, and run `npm run public:check` before every commit.
