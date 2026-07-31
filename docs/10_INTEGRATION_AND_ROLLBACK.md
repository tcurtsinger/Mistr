# GustAVO Integration and Rollback Plan

## 1. Integration principle

Mistr must earn integration. GustAVO remains unchanged until the standalone decoder, wire, renderer, playback, real-time, and packaged gates pass.

When authorized, integration is additive and feature-flagged. The existing selected-site tile renderer remains available until a later, separately approved deletion phase.

## 2. Proposed modes

| Mode | Selected-site reflectivity | Storm-relative velocity | National mosaic |
|---|---|---|---|
| `tiled` | Current NOAA/NWS tile path | Current IEM RIDGE `N0S` tiles | Current IEM `USCOMP-N0Q` |
| `raw-shadow` | Tiled visible; raw runs diagnostics without display | Tiled visible; optional raw L3 comparison | Current national |
| `raw` | Raw Level II | Raw Level III `N0S` only after parity gate | Current national |
| `raw-with-fallback` | Raw preferred, explicit tile fallback | Raw preferred only where proven, explicit tile fallback | Current national |

The active mode and actual source used for the painted observation must be visible in diagnostics. A fallback must never pretend it remained on raw data.

## 3. Integration sequence

### Stage A — Library extraction

- Package Mistr decoder/normalizer/wire components without importing GustAVO UI state.
- Package the TypeScript wire parser/resource manager/custom layer without importing GustAVO panels.
- Preserve exact Mistr fixture tests in the integrated repository or shared package.
- Pin dependencies and generated artifacts.

### Stage B — Shadow acquisition

- Run raw acquisition/decoding only on explicit diagnostic builds.
- Keep tiled radar visible.
- Compare timestamps, products, values, latency, and resource costs.
- Do not upload full loops continuously if shadow mode would distort normal performance; use bounded sampling.

### Stage C — Opt-in raw reflectivity

- Allow explicit development/operator opt-in.
- Keep national mosaic behavior unchanged.
- Keep current timeline/product labels truthful.
- Capture debug bundles automatically on raw failure/fallback.
- Require packaged Windows verification.

### Stage D — Raw `N0S` parity

- Enable only after Level III numeric and visual parity passes.
- Keep Level II base velocity as a separate product if exposed.
- Verify units, range, timestamps, missing/range-folded semantics, and palette.

### Stage E — Controlled default

- Make raw selected-site radar default only after the observation period is approved.
- Retain explicit tile fallback and telemetry/diagnostics.
- Define what constitutes fallback activation and how the UI communicates it.

### Stage F — Deletion review

- Identify selected-site-only tile logic versus logic still required by national/other rasters.
- Delete only code proven unreachable/unneeded.
- Preserve migration-free rollback for at least the agreed release window.
- Update GustAVO's `ARCHITECTURE.md`, `DATA_SOURCES.md`, tests, and user-facing source attribution.

## 4. National/site handoff

The current product contract remains:

- National mosaic authoritative below the handoff zoom.
- Selected-site radar authoritative at closer zoom.
- Timeline follows the product actually displayed.
- Products with different measured times are not blended as simultaneous.

Integration tests must cover:

- Crossing the handoff while playing.
- Crossing while the raw selected-site loop is still loading.
- Crossing during context restoration.
- Raw failure before/after crossing.
- Rapid oscillation around the threshold.
- Toggling national or selected-site visibility independently.

The selected-site raw engine may eliminate its own tile readiness, but the handoff remains an explicit product state.

## 5. GustAVO regression surface

Integration must demonstrate no unapproved change to:

- Warnings/watches and layer order.
- SPC and other map overlays.
- Camera discovery/playback.
- Timeline keyboard shortcuts.
- Focus mode and radar transport.
- Panel state and saved views.
- Map style reload.
- Accessibility names/focus behavior.
- Notifications, credentials, SQLite history, or fixed-host adapters.
- Existing national mosaic freshness/fallback.
- Packaging/install/update behavior.

## 6. Rollback triggers

Automatically activate configured tile fallback or recommend rollback when:

- Raw inventory/acquisition is unavailable beyond the policy deadline.
- The required observation cannot be assembled completely.
- Decoder or wire validation fails.
- GPU capabilities do not meet the supported contract.
- Upload fails or GPU budget is exceeded.
- Context restoration fails within the allowed recovery policy.
- A paint receipt does not arrive before the bounded visible-state deadline.
- Numeric self-check/reference sentinels fail.
- Repeated raw crashes/failures cross an approved threshold.

Fallback trigger details are included in the debug bundle.

## 7. Rollback mechanics

Rollback must require no database migration or reinstall.

Minimum mechanisms:

- Startup configuration or feature flag selects `tiled` mode.
- Raw caches are ignored safely when disabled.
- Tile cache remains valid and independently versioned.
- The raw custom layer unregisters and releases all resources.
- In-flight raw generations are cancelled.
- Tiled sources/layers initialize through their current tested path.
- UI clearly reports the active source and current observation.

An operator-visible toggle may exist during testing, but production fallback policy must avoid rapid flapping between sources.

## 8. Rollback drill

Before adoption:

1. Start in raw mode with a resident loop.
2. Inject a raw acquisition/decoder/renderer failure.
3. Verify last-known-good handling and explicit status.
4. Activate tiled fallback.
5. Verify correct selected-site product and measured timestamp.
6. Verify national handoff.
7. Restart the app in tiled mode.
8. Confirm no raw task/resource remains.
9. Re-enable raw mode and confirm clean initialization.
10. Capture logs, screenshots, resource ledger, and timings.

## 9. Conditions for deleting old selected-site machinery

Deletion is prohibited until:

- All adoption gates pass in integrated GustAVO.
- Raw mode has completed an approved observation period across representative live weather.
- Packaged Windows crash/failure/resource evidence is acceptable.
- `N0S` parity is proven or the product decision explicitly retains tiled `N0S`.
- National/other raster dependencies are separated from selected-site code.
- Rollback has been rehearsed from a release-like build.
- Documentation and tests identify every removed responsibility.
- The user explicitly authorizes removal.

## 10. What may remain tiled permanently

Success does not require ideological removal of all tiles.

Likely retained tiled/gridded paths:

- Basemap vector/raster tiles.
- National radar mosaic unless a separate official gridded renderer is justified.
- GOES and other raster overlays.
- Any product whose provider-rendered form is reliable, truthful, and not in an animated hot path.

Mistr is a targeted operational simplification, not a “no web technology” mandate.
