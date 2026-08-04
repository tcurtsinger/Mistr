# Product

<!-- impeccable:product-schema 1 -->

## Platform

Installable desktop application. Windows is the Alpha release platform; the shared Tauri application architecture remains compatible with a later macOS release.

## Users

Mistr is designed first for its owner, an experienced storm enthusiast who inspects live storms from a desktop for extended sessions. Alpha decisions should optimize that personal workflow rather than anticipate a broad consumer audience.

Mistr may also be shared with other storm enthusiasts who understand radar and want a focused, dependable desktop viewer. Supporting that audience must not add onboarding, configuration, or feature complexity that compromises the primary workflow.

## Product Purpose

Mistr is an installable desktop radar application for interactively inspecting live storms without playback lag, map-performance failures, or ambiguous data state.

Alpha v1 succeeds when the operator can open Mistr, choose one NEXRAD site, see high-resolution live base reflectivity, zoom and pan freely, and play or scrub a recent measured-observation loop while always knowing which observation is actually displayed and whether it is current.

## Positioning

Mistr is a focused radar instrument, not a general weather dashboard. Its selected-site radar is decoded from public radar data and kept in bounded GPU-resident resources for map navigation and playback; it does not depend on hundreds of provider-rendered radar tiles to advance an animation.

The product earns additional capabilities only when they improve live storm inspection without weakening performance, truthfulness, or maintainability.

## Approved National Direction

National radar is the approved next product milestone. Merged Phases 1 through 3 established the typed source coordinator, strict NOAA MRMS acquisition and numeric decoding, `PackedGrid v1`, the explicit `National`/`Site` choice, one complete CONUS numeric-grid paint, exact Rust-owned interrogation, and atomic source handoff.

The active Phase 4 review branch extends that merged one-frame product to 20 exact chronological National observations, newest-first visible startup, predecessor backfill, strictly newer polling, bounded all-frame overview residency, direct scrubbing, and common-quality playback with paused selected-frame refinement. This behavior is implemented and packaged-validated on `codex/mistr-national-history`, but is not shipped from `main` until its pull request is reviewed and merged. The approved phased product and engineering contract is [National Radar Implementation Plan](docs/26_NATIONAL_RADAR_IMPLEMENTATION_PLAN.md).

## Operating Context

- The primary environment is a Windows desktop with mouse and keyboard, used at a desk during storm monitoring.
- The application is expected to remain open for long sessions and to recover cleanly from data gaps, site changes, window lifecycle events, and graphics-context loss.
- The normal operating environment is online. Network failure still requires an explicit recovery or error notice, a truthful numeric age for the painted frame, and preservation of the last genuinely displayed observation.
- macOS is an intended later platform. The owner has Mac hardware and an active Apple Developer membership available for future build, runtime, signing, and distribution validation.

## Capabilities and Constraints

### Alpha v1

- Installable Windows desktop application named Mistr.
- One selected operational WSR-88D site at a time, chosen from the provider-qualified 155-site catalog with a searchable workflow. Test, decommissioned, TDWR, and provider-absent identifiers are excluded.
- Live high-resolution base reflectivity.
- Smooth map pan and zoom.
- A display-only weak-return visibility curve that hides non-positive reflectivity, progressively reveals 0–20 dBZ, and leaves stronger operational precipitation fully opaque. This is presentation rather than meteorological clutter classification; native measured dBZ remains available to inspection.
- Layered operational map context: matte land and water, local roads, buildings, railways, water names, and secondary places remain below radar, while major routes, boundaries, and important place labels remain legible above precipitation without globally washing out radar colors. Split water polygons are never outlined because their zoom-dependent seams are not stable geography. Motorway, trunk, and primary segments share one continuous major-route treatment so vector-tile classification changes do not create hard visual handoffs while zooming. Far regional views retain coherent interstate and U.S.-highway networks; state and unnetworked routes fade in only when the detailed source graph is available instead of exposing isolated generalized fragments.
- Two explicit spatial presentation modes for that same measured observation: `Smooth` by default and `Native` on demand. `Smooth` may soften gate edges within one scan; it never synthesizes time, changes decoded values, or changes the native dBZ returned by inspection. `Native` exposes the exact nearest sampled polar gate.
- A bounded recent-observation loop with play, pause, and direct timeline scrubbing. Focused timeline arrow-key movement may be supported without adding dedicated previous/next buttons.
- Clear measured time and numeric frame age during normal operation, with explicit preparation, loading, recovery, and failure notices when action or context is required.
- The visible timeline follows a completed GPU paint, not merely a request or selected frame.
- The last genuinely painted observation remains visible while newer data loads or a recoverable failure is handled.
- The newest bundled archive observation establishes a safe first paint without decoding the entire diagnostic loop; every launch then proceeds automatically to current live radar for the stored site or KTLX on a fresh profile.
- Current live radar paints before history backfill. Mistr then loads safe preceding observations into a bounded recent loop and only afterward waits for exact-next future volumes.
- Existing resident playback and scrubbing remain usable while a different site's network/decode work is staged; only the bounded atomic GPU replacement may hold transport briefly.
- Automatic cancellation of superseded site/data work and bounded ownership of network, CPU, IPC, and GPU resources.
- Deterministic fixture, packaged-runtime, performance, and recovery validation remains part of the product engineering contract even when those diagnostics are absent from the normal interface.

### Explicitly outside Alpha v1

- National radar mosaic and national-to-site zoom handoff.
- Velocity and storm-relative velocity controls.
- Warnings, watches, outlooks, cameras, video, notifications, and unrelated weather overlays.
- A large settings surface or general-purpose storm-command-center shell.
- macOS as a release-blocking acceptance platform.

The approved post-Alpha National milestone does not retroactively make any of these capabilities part of the shipped Alpha surface. Documentation and UI must continue to distinguish internal acquisition/wire diagnostics from a usable National product.

### Platform policy

- Windows behavior and packaged performance are the Alpha v1 release gates.
- Shared product code should remain macOS-compatible where reasonably possible; unnecessary Windows-only assumptions are prohibited.
- macOS packaging and WKWebView/WebGL validation are a later milestone rather than speculative Alpha scope.
- Apple signing, notarization, supported architectures, and public Mac distribution remain open until a Mac build is prepared for sharing.

## Brand Commitments

- The product name is **Mistr**.
- Mistr must feel like a deliberate product rather than expose prototype phases, benchmarks, fixture controls, or engineering acceptance terminology in its normal interface.
- The interface must be clean, focused, and trustworthy. GustAVO's accumulated feature set and incumbent interface are not requirements or default visual authority for Mistr.
- The Alpha radar surface keeps the map full-screen beneath a compact icon-led top-center radar toolbar and one stable bottom-center playback bar. There is no left application menu or About panel; future top-bar capabilities are added only when they become real product controls.
- The merged National toolbar contains Mistr identity, a source icon that offers explicit `National` and `Site` choices, a direct recenter icon, and an eye icon whose `Radar View` tooltip identifies the `Smooth`/`Native` popup. Choosing `Site` exposes the single canonical searchable station list. The popup labels are exactly `Smooth` and `Native`; they describe rendering only and never imply a different radar product, elevation, or measured observation.
- Temporary site and view panels remain anchored to their toolbar controls, overlay the map without resizing or recentering it, and are mutually exclusive. No control or panel is draggable or user-positionable.
- During normal operation, the bottom bar shows the displayed scan timestamp and numeric frame age alongside transport, direct timeline scrubbing, and the active dBZ sample. It does not show `Fresh`, `Stale`, `Playing`, `Paused`, or `Newest`. Green age text is reserved for the recent newest painted live scan; historical, archive, and old latest-live frames use white. Preparation, loading, graphics recovery, and error notices remain explicit exceptional states.
- Technical detail may remain available for reproducible diagnostics, but it must not dominate the storm-inspection workflow.

## Evidence on Hand

- The existing repository proves strict Level II acquisition/decoding, bounded predecessor backfill plus exact-next rolling live polling, bounded binary IPC, incremental GPU-resident history and playback, live progressive publication, cancellation, Level III `N0S` parity, and visible-first WebGL recovery. Merged National Phases 2 and 3 additionally prove strict MRMS acquisition/decoding, `PackedGrid v1`, one complete numeric-grid paint, exact viewport refinement, numeric interrogation, source handoff, and real WebGL recovery. The active Phase 4 branch proves 20 National residents spanning 37.67 minutes, 1,000 zero-I/O resident transitions, bounded 65,292,096-byte peak GPU allocation, common factor-4 quality locking, exact retained-frame lookup, network-free all-frame context recovery, and safe return to Site in packaged Windows/WebView2.
- Pinned public-data fixtures and expected results live under `fixtures/`.
- Architecture and accepted engineering decisions live under `docs/`, including the packed wire, GPU renderer, resident playback, live freshness/fallback, and recovery records.
- Packaged Windows validation scripts reproduce critical WebView2, 4K, performance, lifecycle, and recovery behavior.
- Windows installers bundle the exact hash-pinned first-launch archive resources, so safe initial radar does not depend on a developer checkout or ignored local cache.
- MapLibre does not retain a parsed out-of-view tile cache; visible basemap tiles and the browser's normal network cache remain available while 4K pan/zoom cannot accumulate hundreds of offscreen vector tiles in JavaScript memory.
- No customer testimonials, market adoption claims, or commercial performance evidence exists and future product work must not invent them.

## Product Principles

1. **The painted observation is the truth.** Time, numeric age, site context, and controls follow what the GPU completed, never what the application merely intended to show.
2. **Keep radar interaction immediate.** Pan, zoom, playback, and scrubbing must remain responsive and isolated from network, decode, disk, and bulk-transfer work.
3. **Keep the product narrower than the technology.** A capability does not belong merely because GustAVO had it or the radar engine can support it.
4. **Fail visibly without discarding valid context.** The displayed age remains truthful, and preparation, loading, recovery, and errors are explicit while the last trustworthy observation remains available when safe.
5. **Prefer explainable ownership over clever coupling.** Each task, state transition, buffer, and GPU resource has a bounded owner, deterministic evidence, and a release path that AI-assisted development can troubleshoot.

## Accessibility & Inclusion

Mistr is mouse-and-keyboard first. Core site selection, map navigation, and radar transport controls must remain keyboard operable, expose meaningful accessible names and focus state, and communicate operational status through text or structure rather than color alone.

The icon-led toolbar exposes meaningful accessible names and tooltips; its site name follows painted truth and its view control names the selected `Smooth`/`Native` mode. Temporary panels move keyboard focus into their first available action and return it to the originating trigger when selected or dismissed. Numeric age and accessible text make the green/white age treatment redundant rather than color-only. Windows forced-colors mode retains a visible focus outline, and failure text distinguishes an unavailable first acquisition from a retry that is preserving already-painted live radar.

No additional product-specific accessibility needs have been confirmed for Alpha v1.
