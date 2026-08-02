# Alpha Product Foundation

## Decision

Mistr is the product. GustAVO integration is no longer the default next step, and the completed prototype phases remain engineering evidence rather than the application's identity.

The Alpha is intentionally narrower than GustAVO: one selected NEXRAD site, live base reflectivity, an interactive map, and a truthful recent-observation timeline. National mosaic, velocity, alerts, cameras, video, and general weather-dashboard features remain outside the first product milestone.

## Normal interface

The normal application surface contains only:

- a full-screen MapLibre map and custom WebGL radar layer;
- a compact top-center bar for site, product, and elevation context;
- one left-edge menu trigger with a single temporary overlay panel; and
- a stable bottom-center bar for displayed scan time, freshness, play/pause, direct scrubbing, playback position, and map interrogation.

Prototype phase names, benchmark buttons, fixture controls, and diagnostic counters are not exposed in the normal interface. The packaged validation globals remain available only to the automated evidence runners.

## Current runtime truth

- A first launch decodes and paints the newest pinned KTLX archive observation as a safe bridge; the remaining archive fixtures are loaded only when packaged diagnostics request the full loop.
- Selecting a site starts the qualified bounded live Level II path, cancels superseded work, and replaces the displayed radar only after a current observation is decoded and painted.
- After that first live paint, Mistr prepends strictly older safe provider volumes until the recent history reaches 20 or no safe predecessor is available, then requests the exact next future volume.
- Resident playback becomes usable as soon as a second frame joins. Active backfill says `LOADING RECENT n/20`; a settled partial set says `RECENT n/20`, and a one-frame partial set says `WAITING FOR NEXT SCAN`.
- The selected site is persisted and reopened on the next launch.
- Clicking the map places an inspection reticle; any available dBZ value is reported in the playback bar rather than a floating map tooltip.
- The radar renderer, binary transfer protocol, two-credit ownership bound, cancellation rules, and visible-first WebGL recovery remain unchanged.

## Completed Alpha engine milestone

The bounded rolling **live** reflectivity loop is implemented. It retains at most 20 observations for one site, uploads only the added GPU frame, rolls back failed mutations, preserves direct scrubbing and painted-frame truth, carries separate committed oldest/newest cursors for predecessor backfill and exact-next polling, and does not weaken site-generation cancellation or the two-credit IPC bound.

A one-frame live set remains honestly non-playable until a second observation arrives. Archive and live source truth remain distinct. The detailed ownership and validation record is [Bounded Rolling Live History](21_BOUNDED_ROLLING_LIVE_HISTORY.md).

The next decision after this phase merges is an Alpha release-readiness review, not national mosaic work or automatic feature expansion.

## Release posture

Windows packaged behavior is the Alpha gate. macOS compatibility remains an architecture requirement, but signing, notarization, native runtime validation, and distribution are a later milestone. The owner has Mac hardware and an active Apple Developer membership available when that work begins.

Every major product phase continues to require:

1. public-repository and documentation checks;
2. deterministic frontend and Rust tests;
3. a production frontend build;
4. packaged Windows validation for affected radar behavior; and
5. an in-review pull request before the user merges.
