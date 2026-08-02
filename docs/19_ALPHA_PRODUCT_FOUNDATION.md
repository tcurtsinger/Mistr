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

- A first launch opens the pinned 20-observation KTLX reflectivity loop on its newest painted scan, paused and explicitly marked `ARCHIVE LOOP`.
- Selecting a site starts the qualified bounded live Level II path, cancels superseded work, and replaces the displayed radar only after a current observation is decoded and painted.
- The selected site is persisted and reopened on the next launch.
- Clicking the map places an inspection reticle; any available dBZ value is reported in the playback bar rather than a floating map tooltip.
- The radar renderer, binary transfer protocol, two-credit ownership bound, cancellation rules, and visible-first WebGL recovery remain unchanged.

## Remaining Alpha engine milestone

The live site path currently publishes one completed current observation at a time. Building a product-grade rolling loop of recent **live** observations is the next engine milestone. It must accumulate completed observations without weakening cancellation, painted-frame truth, bounded IPC ownership, GPU residency, or context recovery.

Until that milestone lands, the interface distinguishes the pinned archive loop from a live site observation and must not imply that a one-frame live resident set is an animated history.

## Release posture

Windows packaged behavior is the Alpha gate. macOS compatibility remains an architecture requirement, but signing, notarization, native runtime validation, and distribution are a later milestone. The owner has Mac hardware and an active Apple Developer membership available when that work begins.

Every major product phase continues to require:

1. public-repository and documentation checks;
2. deterministic frontend and Rust tests;
3. a production frontend build;
4. packaged Windows validation for affected radar behavior; and
5. an in-review pull request before the user merges.
