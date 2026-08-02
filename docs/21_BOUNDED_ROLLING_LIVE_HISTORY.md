# Bounded Rolling Live History

**Decision date:** 2026-08-02

## Decision

Mistr retains up to 20 successive safe Level II base-reflectivity observations for one selected NEXRAD site. The history is chronological, GPU resident, directly scrubbable, and owned by one site session. It is not a national mosaic and never combines sites.

## Acquisition cursors

The first live request acquires and paints the current qualified observation. Its provider volume index and measured start time initialize two independent committed cursors:

- the **oldest cursor** drives recent-history backfill by targeting the preceding ring slot and accepting only a strictly older measured start; and
- the **newest cursor** drives normal live polling by targeting the exact next ring slot and accepting only a strictly newer measured start.

Backfill runs sequentially before future polling so generation cancellation remains unambiguous. Each accepted predecessor is prepended to chronological residency without changing the visible newest observation. Ring index `1` wraps to `999`, but index arithmetic is never treated as time truth: a replaced or wrapped slot must still carry an older measured start.

Each cursor advances only after the decoded observation has joined the resident set and the controller has accepted authoritative GPU paint truth. A timeout, missing predecessor, decode failure, rejected GPU mutation, site switch, or superseded generation leaves the relevant cursor unchanged. Missing older history settles as a truthful partial loop and does not mark the already-painted current radar unavailable.

The existing generation token remains the cancellation authority. Beginning a new generation cancels the old site or poll request. The existing two global cross-IPC credits remain unchanged.

## Bounded CPU and GPU ownership

- The frontend history limit is exactly 20 observations.
- A successful backfill update prepends one older observation. A future update appends one newer observation and evicts at most the oldest one.
- Retained observations keep their existing WebGL textures.
- Only the added observation is uploaded during an incremental update.
- At the 20-frame bound, the evicted textures remain available until the selected frame has authoritative paint truth; commit then deletes the evicted resources.
- Failure rolls back CPU order and visible selection, deletes only the newly uploaded resources, and repaints the prior authoritative observation.
- A site or product replacement still uses the existing full atomic replacement and a newer renderer generation.

The incremental transaction briefly owns at most one additional frame beyond the configured resident history. It does not create radar tiles, retain an unbounded response list, or perform acquisition on playback's hot path.

## Playback and visible truth

- A one-frame live history cannot play or scrub yet. While predecessor work is active it says `LOADING RECENT`; once partial history settles it says `WAITING FOR NEXT SCAN`.
- If paused on newest when a scan arrives, Mistr follows the new scan and remains paused on newest.
- If paused on an older retained scan, Mistr preserves that inspection position.
- If that older scan is evicted, Mistr paints the oldest remaining scan rather than pointing at a missing frame.
- Active playback resumes after the incremental transaction commits.
- Background polling does not disable resident play or direct scrubbing.
- The bottom bar shows `LOADING RECENT n/20` during active backfill and `RECENT n/20` for a settled partial history. At 20 frames, the partial suffix disappears.
- Displayed time, freshness, site, playback position, and dBZ always follow the observation that actually painted. A newly resident scan is not claimed as displayed while the operator is inspecting an older scan.
- Recoverable acquisition failure preserves the last painted observation and exposes degraded/error state while retry keeps the same history cursor.

## Recovery

WebGL context loss abandons any uncommitted history mutation and restores its prior CPU truth before visible-first rehydration. Restored radar is inserted back before its diagnostic successor or the first symbol layer, preserving the established map-layer order instead of moving radar above labels.

## Validation

The phase is covered by deterministic frontend and Rust tests plus packaged Windows/WebView2 evidence:

- history prepend/append ordering, deduplication, exact 20-frame eviction, render-key checks, paused-newest behavior, older-frame preservation, aged-out selection, playback resumption, rollback, cursor bounds, predecessor wrap/time validation, and exact-next volume targeting;
- a packaged 3840x2160 lifecycle that performs 19 incremental updates against measured archive observations, caps the diagnostic resident set at five to force eviction, scrubs oldest/newest, loses and restores the real WebGL context, then runs the established two 1,000-transition hot-path scenarios;
- zero long tasks and zero hot-path acquisition or frame uploads in both final Phase 4 scenarios;
- a packaged real KTLX run that acquires volume 560 and exact-next volume 561, retains both GPU observations, uploads exactly one additional frame, and directly scrubs oldest then newest at 3840x2160;
- a visible-first packaged backfill gate that paints current radar before loading predecessors, validates strict chronological residency, direct oldest/newest scrub, bounded resources, site supersession, and context recovery;
- the established two-pass Phase 6 packaged N0S, context-recovery, minimize/restore, and restart gate; and
- compact 1100x700 layout verification with no document overflow and both floating instruments inside the viewport.

Generated radar responses, screenshots, and diagnostic reports remain ignored local artifacts.

## Scope boundary

This completes the bounded selected-site live-history engine milestone. National radar, velocity UI, alerts, cameras, notifications, and broad settings remain outside Alpha v1. The next decision after this change merges is an Alpha release-readiness review, including the deferred real Windows sleep/wake check, rather than automatic expansion into national radar work.
