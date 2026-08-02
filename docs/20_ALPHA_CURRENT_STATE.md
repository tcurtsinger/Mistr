# Alpha Current State

**Checkpoint:** 2026-08-02

**Merged foundation:** [PR #8 — Establish the Mistr Alpha radar surface](https://github.com/tcurtsinger/Mistr/pull/8), merge commit `6a9df18`

**Active change:** [PR #9 — Add bounded rolling live radar history](https://github.com/tcurtsinger/Mistr/pull/9)

**Branch:** `codex/mistr-rolling-live-history`

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

The rolling-history change has passed:

- 126 frontend tests;
- 89 Rust tests across the library and workspace binaries;
- TypeScript compilation and the production Vite build;
- Rust formatting, clippy with warnings denied, tests, and check;
- packaged Phase 4 at 3840x2160 with two 1,000-transition scenarios, 19 incremental history updates per scenario, forced bounded eviction, direct oldest/newest scrub, real context loss/restoration, zero long tasks, and zero hot-path acquisition/uploads;
- packaged Phase 5 at 3840x2160 with site supersession, real KTLX volumes 560 then exact-next 561, two chronological GPU-resident observations, one incremental upload, and direct oldest/newest scrub;
- both packaged Phase 6 N0S, context-recovery, minimize/restore, and cold-restart passes; and
- compact 1100x700 layout inspection with no document overflow and both floating instruments inside the viewport.

The final `npm run verify` passed on this branch, including documentation links, the repository-publication scan, all frontend and Rust tests, the production frontend build, Rust formatting, clippy, and check. The release Tauri executable used by the packaged Phase 4, Phase 5, Phase 6, and compact-layout checks also passed. Generated fixtures, provider responses, packaged reports, and screenshots remain ignored and uncommitted.

The Phase 4 stabilized-heap gate initially repeated the previously documented measurement edge after the heavier rolling/context lifecycle. The runner now performs a second explicit DevTools garbage collection and settling interval before taking each stabilized sample; no threshold changed. The unchanged release executable then passed with final samples of 85,095,638 and 87,938,245 bytes. `DRF-004` remains open if same-state growth repeats under the strengthened measurement.

## Pull-request checkpoint

PR #8 is merged. Rolling-history [PR #9](https://github.com/tcurtsinger/Mistr/pull/9) is **ready for review**, not a draft. Only the repository owner merges.

Review workflow:

1. Read live checks, reviews, conversation comments, and thread-aware `reviewThreads`.
2. Independently verify every comment against current code.
3. Fix demonstrated wrong behavior, unsafe ownership, performance regression, broken UI truth, or failed acceptance gates.
4. Record only genuinely non-blocking edge cases in [Deferred review findings](DEFERRED_REVIEW_FINDINGS.md).
5. Reply with disposition and evidence, then resolve every thread that is closed.
6. Re-run affected local and packaged checks, commit, and push to the same branch.
7. Never merge; only the user merges.

## Next decision after this change merges

Do not begin national radar work. The next step is an Alpha release-readiness review, including:

1. the deferred controlled Windows sleep/wake lifecycle pass (`DRF-003`);
2. an extended real selected-site operational soak using the committed exact-next cursor;
3. clean-machine Windows install, launch, update/uninstall, and unsigned-build messaging checks;
4. final accessibility, compact/4K visual, failure-copy, and public-repository audit; and
5. an explicit owner decision on the remaining release blockers before any new product surface is added.

## Public-repository safety

Never commit credentials, environment files, signing material, downloaded radar archives, arbitrary provider responses, local diagnostic bundles, or packaged screenshots. Keep fixture provenance and hashes in reviewed manifests, keep downloaded bytes in ignored cache directories, and run `npm run public:check` before every commit.
