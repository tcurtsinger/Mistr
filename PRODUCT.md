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

## Operating Context

- The primary environment is a Windows desktop with mouse and keyboard, used at a desk during storm monitoring.
- The application is expected to remain open for long sessions and to recover cleanly from data gaps, site changes, window lifecycle events, and graphics-context loss.
- The normal operating environment is online. Network failure still requires explicit stale/error state and preservation of the last genuinely displayed observation.
- macOS is an intended later platform. The owner has Mac hardware and an active Apple Developer membership available for future build, runtime, signing, and distribution validation.

## Capabilities and Constraints

### Alpha v1

- Installable Windows desktop application named Mistr.
- One selected NEXRAD site at a time, with a simple site-selection workflow.
- Live high-resolution base reflectivity.
- Smooth map pan and zoom.
- A bounded recent-observation loop with play, pause, and direct timeline scrubbing. Focused timeline arrow-key movement may be supported without adding dedicated previous/next buttons.
- Clear measured time, freshness, loading, stale, recovery, and failure state.
- The visible timeline follows a completed GPU paint, not merely a request or selected frame.
- The last genuinely painted observation remains visible while newer data loads or a recoverable failure is handled.
- Automatic cancellation of superseded site/data work and bounded ownership of network, CPU, IPC, and GPU resources.
- Deterministic fixture, packaged-runtime, performance, and recovery validation remains part of the product engineering contract even when those diagnostics are absent from the normal interface.

### Explicitly outside Alpha v1

- National radar mosaic and national-to-site zoom handoff.
- Velocity and storm-relative velocity controls.
- Warnings, watches, outlooks, cameras, video, notifications, and unrelated weather overlays.
- A large settings surface or general-purpose storm-command-center shell.
- macOS as a release-blocking acceptance platform.

### Platform policy

- Windows behavior and packaged performance are the Alpha v1 release gates.
- Shared product code should remain macOS-compatible where reasonably possible; unnecessary Windows-only assumptions are prohibited.
- macOS packaging and WKWebView/WebGL validation are a later milestone rather than speculative Alpha scope.
- Apple signing, notarization, supported architectures, and public Mac distribution remain open until a Mac build is prepared for sharing.

## Brand Commitments

- The product name is **Mistr**.
- Mistr must feel like a deliberate product rather than expose prototype phases, benchmarks, fixture controls, or engineering acceptance terminology in its normal interface.
- The interface must be clean, focused, and trustworthy. GustAVO's accumulated feature set and incumbent interface are not requirements or default visual authority for Mistr.
- The Alpha radar surface keeps the map full-screen beneath a compact top-center radar-context bar, one small left menu trigger, and one stable bottom-center playback bar. A future right-side alert trigger is reserved but does not ship before alerts exist.
- Temporary menu and alert panels overlay the map without resizing or recentering it. Only one panel may be open, panels stop above the playback bar, and no control or panel is draggable or user-positionable.
- Technical detail may remain available for reproducible diagnostics, but it must not dominate the storm-inspection workflow.

## Evidence on Hand

- The existing repository proves strict Level II acquisition/decoding, exact-next rolling live polling, bounded binary IPC, incremental GPU-resident history and playback, live progressive publication, cancellation, Level III `N0S` parity, and visible-first WebGL recovery.
- Pinned public-data fixtures and expected results live under `fixtures/`.
- Architecture and accepted engineering decisions live under `docs/`, including the packed wire, GPU renderer, resident playback, live freshness/fallback, and recovery records.
- Packaged Windows validation scripts reproduce critical WebView2, 4K, performance, lifecycle, and recovery behavior.
- Windows installers bundle the exact hash-pinned first-launch archive resources, so safe initial radar does not depend on a developer checkout or ignored local cache.
- MapLibre does not retain a parsed out-of-view tile cache; visible basemap tiles and the browser's normal network cache remain available while 4K pan/zoom cannot accumulate hundreds of offscreen vector tiles in JavaScript memory.
- No customer testimonials, market adoption claims, or commercial performance evidence exists and future product work must not invent them.

## Product Principles

1. **The painted observation is the truth.** Time, freshness, and controls follow what the GPU completed, never what the application merely intended to show.
2. **Keep radar interaction immediate.** Pan, zoom, playback, and scrubbing must remain responsive and isolated from network, decode, disk, and bulk-transfer work.
3. **Keep the product narrower than the technology.** A capability does not belong merely because GustAVO had it or the radar engine can support it.
4. **Fail visibly without discarding valid context.** Loading, stale data, recovery, and errors are explicit while the last trustworthy observation remains available when safe.
5. **Prefer explainable ownership over clever coupling.** Each task, state transition, buffer, and GPU resource has a bounded owner, deterministic evidence, and a release path that AI-assisted development can troubleshoot.

## Accessibility & Inclusion

Mistr is mouse-and-keyboard first. Core site selection, map navigation, and radar transport controls must remain keyboard operable, expose meaningful accessible names and focus state, and communicate operational status through text or structure rather than color alone.

Temporary panels move keyboard focus into their first available action and return it to the originating trigger when selected or dismissed. Windows forced-colors mode retains a visible focus outline, and failure text distinguishes an unavailable first acquisition from a retry that is preserving already-painted live radar.

No additional product-specific accessibility needs have been confirmed for Alpha v1.
