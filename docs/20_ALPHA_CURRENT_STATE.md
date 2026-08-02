# Alpha Current State

**Checkpoint:** 2026-08-01

**Active change:** [PR #8 — Establish the Mistr Alpha radar surface](https://github.com/tcurtsinger/Mistr/pull/8)

**Branch:** `codex/mistr-product-foundation`

This document is the durable starting point for the next Mistr development session. Verify the pull-request state on GitHub before acting because review and merge status can change after this checkpoint.

## Product decision

Mistr is the product. Building the Alpha directly on Mistr is the accepted direction; integrating the engine into GustAVO is not the default plan.

The first product goal remains deliberately narrow: one selected NEXRAD site, live high-resolution base reflectivity, smooth pan and zoom, and a truthful recent-observation timeline. National mosaic, velocity, alerts, cameras, video, and the broader GustAVO feature set remain outside Alpha v1.

Windows is the Alpha release platform. The shared Tauri architecture must avoid unnecessary Windows-only assumptions so a later macOS build remains practical, but macOS validation and distribution are not current release gates.

## Current user experience

The approved radar surface is implemented:

- the radar map fills the window;
- a compact top-center bar shows the **painted** site, product, and elevation;
- one left-edge trigger opens a compact overlay menu without resizing or recentering the map;
- one bottom-center playback bar remains fixed while panels open;
- there is no permanent left rail, full-width top or bottom bar, right-side alert control, or dedicated previous/next buttons;
- timeline dragging performs direct scrubbing;
- a deliberate map click places a reticle, while the dBZ result appears only in the playback bar; and
- initial load, successful site changes, and recenter fit the radar's measured coverage to the available map surface.

The normal interface contains no prototype phase controls, benchmark buttons, fixture selectors, or engineering counters. The application and installer identity is `Mistr`, not `Mistr Radar Prototype`.

## Current runtime behavior

### First launch

When no last-used site is stored, Mistr opens the pinned 20-observation KTLX base-reflectivity archive loop. It paints the newest observation and remains paused. The playback bar explicitly says `ARCHIVE LOOP`.

### Reopen and site selection

- The last successfully painted live site is persisted.
- On a later launch, the archive loop establishes a safe initial display and Mistr then requests the stored live site.
- During acquisition, the top context continues to name the site that is actually painted; the freshness area names the pending site.
- A site label changes only after the replacement observation has decoded and received a matching GPU paint receipt.
- Failed or superseded requests preserve the last trustworthy painted radar and cannot relabel it as the failed site.

The current Alpha site list is KTLX, KOUN, KINX, KVNX, and KFDR.

### Playback and interrogation

- The 20-frame archive loop supports play, pause, and direct scrubbing.
- Displayed scan time and playback position follow the most recent completed GPU paint.
- If a reticle is active, its dBZ value is recomputed at the same geographic point whenever a different observation paints; a previous scan's value is never carried forward as current.
- Compact desktop layouts retain displayed time, freshness, playback, and the active interrogation result.

### Important current boundary

The live acquisition path currently publishes one completed current observation and replaces the resident set with that one frame. It does **not** yet accumulate a rolling history of successive live observations. Play and scrub are therefore disabled for a one-frame live set.

Building the bounded rolling **live** observation loop is the next radar-engine milestone. The interface must continue to distinguish archive and live truth until that milestone is complete.

## Architecture retained

- Tauri 2 desktop shell
- Rust acquisition, bounded decoding, cancellation, and packed-sweep IPC
- React 19, TypeScript, and Vite
- MapLibre GL basemap
- custom WebGL radar layer with GPU-resident observations
- two-credit cross-IPC ownership bound
- painted-frame receipts as UI truth
- visible-first WebGL context recovery
- fixed-host anonymous public-data adapters

The automated `__MISTR_PHASE4__`, `__MISTR_PHASE5__`, and `__MISTR_PHASE6__` APIs remain available for packaged evidence runners. They are not normal product controls and must not be removed casually.

## Validation state

The product-foundation change has passed:

- the full `npm run verify` suite;
- 105 frontend tests;
- 87 Rust tests across the workspace binaries and library;
- public-repository scanning for 180 candidate files;
- documentation-link validation;
- production frontend and release Tauri builds;
- packaged Windows/WebView2 Phase 4 at 3840x2160 with two 1,000-transition scenarios, zero long tasks, and zero hot-path acquisition/upload activity;
- packaged Phase 5 live acquisition, supersession/cancellation, and GPU paint;
- packaged Phase 6 N0S, context recovery, and restart twice; and
- compact 1100x700 browser QA.

The Impeccable finish review found five material issues—stale dBZ after frame changes, premature site relabeling, hidden compact dBZ, repeated screen-reader freshness announcements, and over-wide 4K framing. All five were fixed and the targeted re-review confirmed them resolved.

One isolated intermediate Phase 4 stabilized-heap measurement failure did not reproduce in two later final-build runs. It is recorded transparently as `DRF-004` in [Deferred review findings](DEFERRED_REVIEW_FINDINGS.md); no acceptance threshold was relaxed.

Pull-request review later demonstrated that a persisted-site startup acquisition could overlap the Phase 4 or Phase 6 packaged gate after those runners observed their diagnostic APIs. The runners now cross an explicit archive-preparation barrier that supersedes and awaits startup work, restores all 20 archive observations, and only then begins measurement or recovery checks. The full verification suite and both affected packaged gates passed after this correction.

## Pull-request checkpoint

At this checkpoint, PR #8 remains open and marked ready for review. Automated review submitted one actionable thread about persisted startup acquisition overlapping the packaged Phase 4 and Phase 6 gates; the branch now isolates both runners with the archive-preparation barrier described above. No conversation comments or other review threads had appeared. Re-read the live PR, checks, and thread state before taking action because CI and review status can change after this checkpoint.

## Required review workflow

1. Inspect PR #8 with thread-aware review data, not only the flat comment list.
2. Treat demonstrated wrong behavior, unsafe ownership, performance regressions, or broken acceptance gates as defects and fix them.
3. Treat genuinely low-probability, non-blocking edge cases according to [Deferred review findings](DEFERRED_REVIEW_FINDINGS.md) instead of starting an endless review loop.
4. Reply to every closed review comment with its disposition and evidence, then resolve the thread so the owner is never left guessing.
5. Re-run the relevant local and packaged checks after code changes.
6. Commit and push review fixes to the same branch and keep PR #8 ready for review.
7. Only the repository owner merges.

## Next product phase after PR #8

Do not begin the next engine phase until PR #8 is merged and the local checkout is synchronized safely with `main`.

The recommended next phase is the bounded rolling live reflectivity loop for one selected site:

1. acquire successive safe, completed live observations for the active site;
2. retain a bounded chronological history suitable for playback;
3. append/replace resident GPU resources without reintroducing tile readiness, unbounded memory, or main-thread stalls;
4. keep newest-scan, paused, freshness, partial-history, failure, and painted-frame semantics truthful;
5. preserve generation cancellation and the two-credit IPC ownership bound across site switches;
6. validate long-session polling, site supersession, context recovery, direct scrubbing, and packaged 4K performance; and
7. deliver the phase through a new ready-for-review PR with CI and packaged evidence.

National radar remains later work. A national mosaic is a separate multi-radar product and should not be faked by simply displaying one Level II site at national scale.

## Public-repository safety

This is a public repository. Never commit credentials, environment files, signing material, downloaded raw radar archives, arbitrary provider responses, local diagnostic bundles, or packaged screenshots. Keep provenance and hashes in reviewed manifests, keep fixture bytes in ignored cache directories, and run `npm run public:check` before every commit.
