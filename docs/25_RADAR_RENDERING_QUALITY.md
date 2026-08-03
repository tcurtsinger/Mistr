# Radar Rendering Quality

**Status:** Accepted Alpha rendering contract

## 1. Decision

Mistr offers two spatial presentations of the same selected, measured radar observation:

- `Smooth` is the default product presentation. It reduces distracting gate-edge aliasing while preserving observation identity and native interrogation truth.
- `Native` is the exact polar-gate presentation using nearest sampling.

These visible top-context labels are deliberate. They describe how one observation is drawn; they are not radar products, elevation choices, forecast frames, or different data sources.

## 2. Demonstrated problem

The pinned KTLX observation at `2024-05-20T22:21:59Z` is a clear-air VCP 35 scan with 720 radials, 1,832 gates per radial, 250-metre gate spacing, a 2,125-metre first-gate center, and approximately 0.5-degree beam width. Its 460-kilometre coverage puts many native gates below one screen pixel while distant wedges remain visibly wider. Exact point sampling at every zoom therefore produces distracting spokes and speckle even when the decoder and packed wire are correct.

Independent packed-data inspection found all 720 radial rows unique and the azimuth spacing bounded around 0.5 degrees. Nearly all valid returns in this clear-air frame are below 20 dBZ. The visual problem must therefore be corrected in presentation rather than by changing the decoder or pretending every source-valid return is precipitation.

NOAA describes Level II super-resolution reflectivity as 0.5-degree azimuth by 250-metre gate data extending to 460 kilometres. VCP 35 is a clear-air coverage pattern. See [NOAA NCEI Level II metadata](https://www.ncei.noaa.gov/access/metadata/landing-page/bin/iso?id=gov.noaa.ncdc%3AC00345) and [NWS VCP information](https://www.weather.gov/cle/news_VCP215).

## 3. Data truth boundary

For every valid Level II reflectivity code, Mistr uses the exact metadata conversion:

```text
dBZ = (rawCode - offset) / scale
```

The result is not rounded before palette lookup or point interrogation. Display work cannot mutate raw codes, status codes, scale/offset metadata, normalized CPU observations, packed IPC bytes, or the observation's measured time.

Status remains categorical and authoritative:

- valid return: convert with the exact equation and apply the reflectivity palette;
- source below threshold: transparent;
- range folded: explicit range-folded color/state;
- missing or unknown status: transparent and never promoted to a valid return.

## 4. Reflectivity palette

The Alpha reflectivity ramp is a meteorological data palette, not Stormlight chrome. It is pinned to the official NOAA/NWS [`SR_BREF` `radar_reflectivity` WMS legend](https://opengeo.ncep.noaa.gov/geoserver/kamx/wms?service=WMS&request=GetLegendGraphic&version=1.0.0&format=image%2Fpng&layer=kamx_sr_bref&style=radar_reflectivity) captured from the KAMX service on 2026-08-02. Five-dBZ anchors from -25 through 70 dBZ progress through neutral weak returns, blue/cyan, green, yellow/orange, red, magenta, and purple. The reference URL and capture date are recorded with the constants; the downloaded provider image remains an ignored local diagnostic, never a repository fixture.

Mistr keeps the official reference's operational RGB thresholds, then applies a separate display-only weak-return visibility curve to Level II reflectivity:

- at or below 0 dBZ: alpha 0;
- 5 dBZ: alpha 56/255;
- 10 dBZ: alpha 120/255;
- 15 dBZ: alpha 184/255; and
- at or above 20 dBZ: alpha 255.

Opacity interpolates from the exact unrounded dBZ value between those anchors. The curve stays close to linear while deliberately sitting slightly below a linear fade from 5 through 15 dBZ, reducing long-session shimmer from dense weak positive returns before precipitation becomes fully opaque at 20 dBZ. The broad pale disk formed by negative-dBZ clear-air returns remains absent. This is a presentation cutoff, not meteorological quality control. Negative dBZ can include genuine extremely light drizzle or snow, and 0–20 dBZ can contain either weak precipitation or non-weather return; the native gate/status/dBZ remains available to inspection. See [NOAA JetStream reflectivity guidance](https://www.noaa.gov/jetstream/reflectivity).

In `Native`, every non-positive valid gate therefore has a transparent palette entry. In `Smooth`, that gate remains a status-valid spatial neighbor, so an adjacent positive return may fade into its footprint within the existing bounded one-gate/one-radial interpolation. This does not bridge a source-invalid status or missing radial and does not change the underlying gate truth.

Palette anchors may interpolate color and alpha for presentation, but each lookup starts from the exact dBZ computed for that raw code. This color interpolation does not create, replace, or alter a measured value.

## 5. Operational map context

Radar is inserted at the explicit `highway_motorway_subtle` boundary in the bundled style rather than below the map's first symbol. That boundary creates two intentional graphs without a second provider or global radar-opacity reduction.

The base plane keeps land, water, parks, and wooded areas within a narrow matte-charcoal range. Water remains recognizable without becoming a large bright field. Mistr deliberately does not outline the `water` source-layer polygons: the [OpenMapTiles water schema](https://openmaptiles.org/schema/#water) explains that these polygons are split for rendering and that their generated boundaries can prevent reliable border styling. Removing the outline prevents Lake Mead, rivers, reservoirs, ocean partitions, and tile-generalized shorelines from becoming bold seams that disappear and return while zooming. Important cities remain the strongest neutral labels; state labels use natural case and quieter contrast so administrative text does not compete with precipitation.

Below radar:

- buildings, aeroways, paths, minor/service/track roads, secondary/tertiary roads, railways, and one-way markers;
- water names, local road names, towns, villages, suburbs, and secondary places; and
- local road names only from close zoom, in title case and at subdued contrast.

Above radar:

- motorways and primary/trunk roads only, with regional density disclosed progressively and restrained dual contrast at detailed zooms;
- country and state boundaries; and
- motorway/major-route identifiers plus important city, state, and country labels.

The above-radar set is deliberately small. Its lines remain recognizable when sought but cannot become a pale wireframe or fragment the storm into equally salient road geometry. Important cities outrank route lines, missing point-icon sprites are not required, and minor context remains useful on the unobscured map beneath the radar.

## 6. Spatial display modes

### `Smooth`

- Filters spatial appearance within one measured observation only.
- May reconstruct continuous-looking coverage from adjacent native polar samples when their statuses permit it.
- Must not interpolate between scan times, create timeline positions, or change a painted-frame receipt.
- Must not bridge missing radials, transparent/missing regions, or categorical range-folded regions as if valid reflectivity existed there.
- Must handle the 0/360-degree azimuth seam without inventing a discontinuity.

### `Native`

- Uses the exact native polar gate selected by nearest sampling.
- Keeps native bin and radial boundaries visible.
- Is the safe rollback presentation if the filtered path cannot initialize or recover.

Changing modes leaves the selected site, observation identifier, measured time, freshness age, timeline position, playback state, resident-history ownership, and authoritative paint semantics unchanged.

## 7. Inspection truth

A map inspection always reports the native underlying gate, status, and dBZ for the displayed observation. This is true in both `Smooth` and `Native`.

The application never reverse-engineers a dBZ value from a filtered screen color. A visually blended pixel may sit between native colors, but that intermediate appearance is not labeled as an intermediate measurement. A visually transparent non-positive valid gate may still report its exact native negative dBZ when deliberately inspected. Below-threshold, range-folded, missing, and out-of-coverage inspection results remain explicit.

## 8. Ownership and performance

- Spatial filtering remains in the renderer and does not trigger network, disk, decode, IPC, or per-playback-frame acquisition work.
- Canonical CPU observations and GPU-resident history remain bounded to the existing ownership contract.
- Mode changes must reuse bounded resident resources rather than duplicate an unbounded history.
- Exactly two cross-IPC transfer credits remain the hard transfer bound.
- WebGL context recovery restores the visible observation first and preserves or safely falls back from the chosen display mode.
- The radar layer remains below neutral operational map context, and decorative chrome color never washes over radar pixels.
- The visibility curve is encoded in the existing 256-entry palette texture. It adds no per-frame upload, resident observation, network path, or shader branch.

## 9. Acceptance gates

Source-level evidence must prove:

1. every valid reflectivity raw code maps through the exact scale/offset equation;
2. the pinned five-dBZ RGB colors match the captured NOAA/NWS operational `SR_BREF` reference;
3. weak-return alpha is integer, bounded, monotonic from 0 through 20 dBZ, transparent at or below 0 dBZ, and fully opaque at or above 20 dBZ;
4. below-threshold, range-folded, missing, and unknown statuses remain distinct;
5. uploaded palette bytes remain correctly premultiplied for WebGL;
6. `Smooth` and `Native` use the same observation and point interrogation result;
7. filtering cannot create data across invalid/status boundaries or the azimuth seam;
8. the explicit context boundary keeps water and local detail below radar without split-polygon outlines while major-route, boundary, and important-label context remains above it using only the existing map source graph; and
9. the visible labels and accessible control name expose the active mode without implying a new observation or meteorological clutter classification.

The combined packaged Windows/WebView2 matrix must cover direct scrub, resident playback, site switching, 4K pan/zoom, context loss/restoration, and compact/forced-colors inspection across both modes. Renderer-sensitive playback, recovery, responsive-layout, and accessibility paths exercise both modes directly; mode-independent acquisition ownership remains covered once per live workflow. The existing long-task, hot-path I/O/upload, GPU-memory, and painted-receipt gates do not relax for visual quality.

### Current Alpha evidence

The release WebView2 renderer with the quiet weak-return curve and explicit map-context boundary passed separate `Native` and `Smooth` 1,000-transition resident-playback scenarios at 3840x2160 with zero long tasks, zero hot-path acquisition, and zero hot-path frame uploads. Frame-time P95 was 6.1 ms in Native and 6.2 ms in Smooth. Switching modes changed neither observation/receipt truth nor the 53,099,312-byte resident GPU set and caused no upload. Automated isolated-pixel evidence found substantial signal in both modes, a 53.7% changed-pixel ratio, and 33.0% background retained in common; generated overview and close-zoom captures show weak texture receding while positive structure remains visible. Runtime coexistence placed matte water and local context through `place_town` below radar and began the essential above-radar graph at `highway_motorway_subtle`.

A packaged live KOKX observation at `2026-08-03T04:18:59Z` reproduced the owner's Long Island/Northeast operating scene. The prior pale negative-dBZ disk was absent, coherent positive precipitation remained visible from weak blue/cyan through operational green/yellow bands, important cities and major routes remained readable, and the former bright road mesh no longer fragmented the storm. The downloaded volume and screenshots remain ignored local validation artifacts.

A timestamp-matched 2026-08-02 22:08:23Z live KAMX check compared Mistr's packaged Smooth Level II draw with the official KAMX `SR_BREF` WMS frame. The operational color bands and storm structure aligned without the prior early yellow/orange severity shift. The comparison validates presentation rather than source identity: NOAA's WMS product includes its own Level III/MRMS processing, while Mistr continues to render independently decoded Level II measurements.

The current quiet-map release passed both modes at 3840x2160, 1100x700, and 1024x640, including keyboard mode selection, one-panel behavior, accessible active-mode naming, focus restoration, forced-colors focus, and reduced motion. Both cold-start/context-recovery passes also succeeded with the explicit context boundary. Live acquisition ownership, generation supersession, successive observations, and direct oldest/newest scrubbing remain covered by the unchanged earlier packaged workflows, while the current binary repeated a live KOKX acquisition and matching GPU paint.

## 10. Rollback

If `Smooth` causes incorrect boundaries, truth drift, performance regression, or a Smooth draw failure, Mistr falls back to `Native`. A mode-specific draw error receives one bounded retry through Native while context-loss, fence, upload, and resource-wide failures remain explicit errors handled by the existing recovery path. The playback controller owns this retry from the first startup paint through later play and scrub selections, accepts the matching Native paint receipt, and keeps the visible frame, timeline, and published playback state synchronized. A mode-only repaint has no new selection or receipt to accept, so the renderer performs the same bounded rollback itself while preserving the already-authoritative observation. Because the modes do not change acquisition, decoding, normalized data, resident history, or timeline truth, rollback does not discard or reinterpret an observation.

## 11. Related decisions

- [Data Sources and Decoding](02_DATA_SOURCES_AND_DECODING.md)
- [GPU Renderer](03_GPU_RENDERER.md)
- [GPU Renderer Decision](15_GPU_RENDERER_DECISION.md)
- [Resident Playback Decision](16_RESIDENT_PLAYBACK_DECISION.md)
- [Alpha UI and Live-Site Hardening](23_ALPHA_UI_AND_SITE_HARDENING.md)
- [Product definition](../PRODUCT.md)
- [Design system](../DESIGN.md)
