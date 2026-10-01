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

*Owner decision (2026-09-28): zoom decides the source. Zooming past about 9 over a Site's coverage cross-fades to that Site; zooming out returns to the resident National mosaic. See [Seamless radar handoff](docs/32_SEAMLESS_RADAR_HANDOFF.md).*

National radar is the approved next product milestone. Merged Phases 1 through 4 established the typed source coordinator, strict NOAA MRMS acquisition and numeric decoding, `PackedGrid v1`, the explicit `National`/`Site` choice, a 20-observation CONUS loop, exact Rust-owned interrogation, quality-locked playback, and atomic source handoff.

Phase 4 is merged. National now provides 20 exact chronological observations, newest-first visible startup, predecessor backfill, strictly newer polling, bounded all-frame overview residency, direct scrubbing, and common-quality playback. Once two complete observations are usable, background backfill keeps Play and direct scrubbing available; only the bounded atomic residency swap or graphics recovery may hold those controls briefly. A post-merge visual-fidelity correction prepares the finest complete all-frame viewport level that fits the 200 MiB GPU target before regional playback begins: exact factor 1 first, factor 2 as the bounded fallback, and factor 4 only for the country overview or when finer all-frame coverage cannot fit. Smooth and Native use the same selected numeric level; Smooth filters its appearance but never invents source resolution. The approved phased product and engineering contract is [National Radar Implementation Plan](docs/26_NATIONAL_RADAR_IMPLEMENTATION_PLAN.md).

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
- Layered operational map context: matte land and water, local roads, buildings, railways, water names, and secondary places remain below radar, while the coastline and large-lake shores, county, state, and country boundaries, major routes, and important place labels remain legible above precipitation without globally washing out radar colors. Each line above radar has a dark casing, so it holds over bright echo as well as over the dark map. Only the ocean and large lakes are outlined; ponds, rivers, reservoirs, and split water polygons never are, because their zoom-dependent seams are not stable geography. Motorway, trunk, and primary segments share one continuous major-route treatment so vector-tile classification changes do not create hard visual handoffs while zooming. Far regional views retain coherent interstate and U.S.-highway networks; state and unnetworked routes fade in only when the detailed source graph is available instead of exposing isolated generalized fragments.
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
- *Owner decision (2026-09-29):* the interface follows the owner's own MistrRadar app, the standard dark radar-app arrangement that sits beside CARROT Weather and Zoom Earth, with neutral near-black surfaces and a thin single-row timeline. MistrRadar's craft is the bar; its teal charcoal and tall timeline card are not.
- The radar surface keeps the map full-screen with four quiet instruments at rest: a thin dBZ color-scale strip at top center, the map credits at top right, a right-edge tool rail, and one thin bottom-center playback row. There is no toolbar wordmark or text slot, no left application menu, and no About panel; rail tools are added only when they become real product controls.
- The rail holds a radar-source button that opens the single canonical searchable site list, with `National` as its first row and recent sites above the full catalog; a direct recenter button; and a view button whose popover offers exactly `Smooth` and `Native`. Those labels describe rendering only and never imply a different radar product, elevation, or measured observation.
- Temporary sheets and popovers open from their rail controls, overlay the map without resizing or recentering it, and are mutually exclusive. No control or panel is draggable or user-positionable.
- During normal operation, the playback row shows the displayed scan time and its numeric age together, a tag naming the painted radar (a site ID or `National`, with `KTLX → KFWS` while a switch is pending), transport, direct timeline scrubbing, and the active dBZ sample with its color. Time, age, and inspection hold fixed geometry so value refreshes cannot move the timeline or resize the row. An exact National lookup in progress is a neutral pending value, never an `outside coverage` claim; source-native missing/no-coverage status appears only after the matching lookup settles. The row does not show `Fresh`, `Stale`, `Playing`, `Paused`, or `Newest`. Green age text is reserved for the recent newest painted live scan; historical, archive, and old latest-live ages are neutral, and a live scan being retried turns its age amber. Preparation, history loading, graphics recovery, and errors are short words on the timeline row, never banners, with the full account on hover, focus, and to assistive technology.
- Technical detail may remain available for reproducible diagnostics, but it must not dominate the storm-inspection workflow.

## Evidence on Hand

- The existing repository proves strict Level II acquisition/decoding, bounded predecessor backfill plus exact-next rolling live polling, bounded binary IPC, incremental GPU-resident history and playback, live progressive publication, cancellation, Level III `N0S` parity, and visible-first WebGL recovery. Merged National Phases 2 through 4 additionally prove strict MRMS acquisition/decoding, `PackedGrid v1`, 20-observation National history, numeric interrogation, source handoff, quality locking, and real WebGL recovery. Post-merge packaged visual-fidelity evidence held all 20 regional playback frames at exact factor 1, peaked at 86,060,064 GPU bytes across the measured passing runs, performed no playback-time acquisition/transfer/upload work, and retained exact identity-bound interrogation.
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

The tool rail exposes meaningful accessible names and keyboard-focus tooltips; its source control names painted truth and its view control names the selected `Smooth`/`Native` mode. The site sheet opens focused on search, where arrow keys move through results and Enter picks the highlighted one; the view popover opens focused on the selected mode; both return focus to their rail control when closed. Space plays or pauses, left and right step one scan, `/` opens site search, and Escape closes a panel or clears the inspected point. Numeric age and accessible text make the age color redundant rather than color-only. Windows forced-colors mode retains a visible focus outline, and failure text distinguishes an unavailable first acquisition from a retry that is preserving already-painted live radar.

No additional product-specific accessibility needs have been confirmed for Alpha v1.
