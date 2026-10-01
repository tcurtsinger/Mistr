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

Radar is inserted at the explicit `highway_major_context_casing` boundary in the bundled style rather than below the map's first symbol. That boundary creates two intentional graphs without a second provider or global radar-opacity reduction.

The base plane keeps land, water, parks, and wooded areas within a narrow matte-charcoal range. Water is a cool navy a step from the land, recognizable without becoming a large bright field.

Only two kinds of water are outlined, both above radar. The [OpenMapTiles water schema](https://openmaptiles.org/schema/#water) warns that its polygons are split for rendering, so an outline of every water polygon would turn rivers, reservoirs, Lake Mead, and tile-generalized shorelines into seams that disappear and return while zooming.

- **The coastline** is the `ocean` class from the full-detail tiles. Inspection of OpenFreeMap tiles from z3 to z11 on the Atlantic, Gulf, Pacific, and New England coasts found no internal split seams in ocean polygons. The only cut edges lie in the tile buffer, which MapLibre clips away. The line therefore follows the water fill exactly at every zoom.
- **Large-lake shores** are the `lake` class from a second source on the same tiles, capped at z7 (`openmaptiles_lakes`). Lake features carry no size, but the z7 tiles keep only large lakes, so a pond appearing at z10 never gets a ring over the radar. On Lake Michigan, the z7 shore sits a median 70 m from the z12 shore: about 1 px at z11, 2.5 px at z12, and 20 px at z15. The lake shore therefore fades out between z11 and z12, before it visibly detaches from the water fill; at street zoom the shore is local context.

Below radar:

- buildings, aeroways, paths, minor/service/track roads, secondary/tertiary roads, railways, and one-way markers;
- water names, local road names, suburbs, and secondary places, plus towns below z8 and villages below z10; and
- local road names only from close zoom, in title case and at subdued contrast.

Above radar:

- motorways and primary/trunk roads only, filtered together and rendered through one continuous dark-support/neutral-center treatment rather than class-specific zoom bands; far regional zooms retain coherent interstate and U.S.-highway networks, then fade in state and unnetworked routes with the detailed source graph;
- the coastline and large-lake shores, then county, state, and country boundaries, each over a dark casing so it holds over bright echo as well as over the dark map. Counties (`admin_level` 6) start at z9, where the tiles first carry them, and fade in over 0.6 zoom. Maritime limits are excluded from states and from all casings, because state-waters and territorial-sea lines traced a second coast offshore; a country border through a lake stays, faint and uncased; and
- route identifiers, towns from z8, villages from z10, and important city, state, and country labels, above every line and each on a dark halo.

The storm question is which town is next, so a town under the echo stays named; the same places stay below radar at regional zoom, where they would crowd the storm. Important cities remain the strongest neutral labels and stay named to z15 (large cities to z16). State and country labels use natural case, and contrast that reads over echo, but they stay quieter than cities.

Every route shows one identifier. The tiles carry only the number for recognized networks, so `us-interstate` reads `I-70`, `us-highway` reads `US 50`, and `us-state` reads `KS 96` from its route network. Other refs are raw OSM text, such as `SR 408 Toll` or `US 17 Truck;US 92 Truck`; the label keeps the first route and drops the `Toll` and `EXPR` (express lanes) suffixes, which name the same road twice. U.S. routes on trunk and primary roads are labelled from z8, and state routes from z10.

The above-radar set is deliberately small. Its lines remain recognizable when sought but cannot become a pale wireframe or fragment the storm into equally salient road geometry. The [OpenMapTiles transportation schema](https://openmaptiles.org/schema/#transportation) can substitute generalized major-highway data at lower zooms and derives both road class and network from source hierarchy. Mistr therefore gives motorway, trunk, and primary segments the same continuously interpolated paint treatment; a route cannot disappear or become suddenly bold merely because its tile classification crosses one of those classes. At far regional zoom, only `us-interstate` and `us-highway` networks are admitted. State and unnetworked routes fade in across the detailed-source transition, preventing short generalized fragments such as the isolated Route 178 segment near Lake Isabella from appearing as white scratches. Local road classes share a gradual below-radar opacity curve rather than a hard layer threshold. Important cities outrank route lines, missing point-icon sprites are not required, and minor context remains useful on the unobscured map beneath the radar.

## 6. Spatial display modes

### `Smooth`

- Filters spatial appearance within one measured observation only.
- May reconstruct continuous-looking coverage from adjacent native polar samples when their statuses permit it.
- Must not interpolate between scan times, create timeline positions, or change a painted-frame receipt.
- Must not bridge missing radials, transparent/missing regions, or categorical range-folded regions as if valid reflectivity existed there.
- Must handle the 0/360-degree azimuth seam without inventing a discontinuity.

#### National `Smooth` edge behavior

The National grid renderer weights only the **valid** neighbors of a sample footprint and renormalizes them. A missing or no-coverage cell contributes no value at any weight, so `Smooth` still never bridges an invalid status; but a partially invalid footprint no longer collapses to a hard nearest-cell block, which previously drew every echo boundary as a row of 1 km squares.

The renormalized weight that survives is the fragment's **coverage**, and it is the fragment's opacity. Coverage is 1 wherever every contributing neighbor is valid, then ramps continuously to 0 across an echo boundary: full opacity at the last measured cell center, nothing at the first unmeasured cell center. A lone measured cell is a soft dot at full opacity on its own center rather than a hard square.

This means `Smooth` feathers up to **half a cell (~500 m) past the measured footprint** at low opacity. That translucent margin is the thing that replaces the hard square edge, and it is an accepted display-only cost of the mode:

- no measured value is ever blended with a missing or no-coverage sentinel — only opacity varies there;
- the feather is `Smooth`-only and applied after palette lookup on a premultiplied palette;
- `Native` keeps the exact measured footprint: hard cell boundaries, full opacity, no feather;
- interrogation reports the exact backend value and status in both modes, so a click inside the feathered margin still answers `missing` or `no coverage` truthfully.

`src/national-radar/sampling.ts` mirrors this contract outside WebGL so it stays unit-tested; the shader in `src/national-radar/NationalGridLayer.ts` must match it.

#### Site `Smooth` edge behavior

Site reflectivity follows the same edge contract on the polar grid. A sample blends two gates along each of its two nearest radials. Below-threshold, range-folded, and out-of-sweep gates are transparent, so the blend of premultiplied colors is the valid gates' color faded by the weight they hold, and that weight is the fragment's opacity. No value is carried across a gate that is not a measurement.

Site blends palette colors where National blends measured values. On the current palette, 30 dBZ is darker than both 25 and 35 dBZ, so a value blend across the gate-to-gate speckle of Level II drew a dark contour ring around every 25-to-35 dBZ patch. Site moves to value blending with a palette whose lightness rises with intensity.

- A below-threshold gate inside a storm is a soft dimple that reaches the map only at its own center. It used to be a hard black hole the size of the gate.
- Echo edges, the cone of silence around the radar, and the end of the sweep feather over half a gate past the measured footprint: 125 m for 250 m gates.
- Range folding stays categorical. A range-folded gate paints its solid color in both modes, and no blend crosses it.
- Storm-relative velocity is categorical and is never smoothed.

The shader in `src/radar-renderer/RadarCustomLayer.ts` carries this contract.

Neither mode adds resolution. The MRMS CONUS mosaic is a 0.01-degree (roughly 1 km) grid, so beyond about zoom 9 each measured cell covers many screen pixels and remains individually visible. Close-range structural detail is the selected-site Level II product's job, not the national mosaic's.

### `Native`

- Uses the exact native polar gate selected by nearest sampling.
- Keeps native bin and radial boundaries visible.
- Closes the hairline seams between adjacent radials. Native beam widths and encoded centers differ by a few hundredths of a degree, which left 1 px seams and pinholes between consecutive beams. A bearing between two radials whose centers are at most 1.5 mean beam widths apart belongs to the nearer one. A wider gap is a missing radial and stays open. Inspection uses the same rule (`coveringRadial` in `src/radar-renderer/geo.ts`), and so does `Smooth` when it picks the center gate.
- Is the safe rollback presentation if the filtered path cannot initialize or recover.

Changing modes leaves the selected site, observation identifier, measured time, freshness age, timeline position, playback state, resident-history ownership, and authoritative paint semantics unchanged.

## 7. Inspection truth

A map inspection always reports the native underlying gate, status, and dBZ for the displayed observation. This is true in both `Smooth` and `Native`.

The application never reverse-engineers a dBZ value from a filtered screen color. A visually blended pixel may sit between native colors, but that intermediate appearance is not labeled as an intermediate measurement. A visually transparent non-positive valid gate may still report its exact native negative dBZ when deliberately inspected. Below-threshold, range-folded, missing, and out-of-coverage inspection results remain explicit.

### Painted position

A pixel is painted at the gate or cell inspection reports for it. The shaders therefore avoid GPU `asin` and `atan` on the position path, because WebGL guarantees neither's precision. On the owner's RTX 4080 through ANGLE/D3D11, `asin` returned about 6.8e-5 rad high for small inputs, which drew every Site echo about 860 m short of its gate near the radar (590 m at 120 km). The `atan` behind Mercator latitude moved points by up to 150 m and turned Site bearings by 1.2° at 2 km. The CPU inspection path is double precision, so the readout and the color under the cursor disagreed.

- **Site:** sin and cos of latitude come straight from Mercator through `tanh` and `cosh`. Ground range is the chord between unit vectors and a series arcsine. Bearing comes from the tangent-plane axes of the radar's unit vector, computed on the CPU in double precision (`SITE_GEOMETRY_GLSL` and `radarUnitFrame` in `RadarCustomLayer.ts`).
- **National:** latitude takes one Newton step on sin(latitude) = tanh(t) after `atan` (`MERCATOR_LATITUDE_GLSL` in `NationalGridLayer.ts`).

The packaged Phase 4 gate runs these shipped snippets on the packaged GPU (`probeRadarGeometry`) against double-precision truth: 480 Site points from 2 km to 460 km around five radars at 25° to 65° N, and ten National latitudes. It fails when range, cross-range, or National latitude error passes 10 m. The owner's GPU measured 1.6 m, 4.7 m (at 460 km), and 1.6 m.

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
10. the shipped Site and National position shader code places points within 10 m of double-precision truth on the packaged GPU.

The combined packaged Windows/WebView2 matrix must cover direct scrub, resident playback, site switching, 4K pan/zoom, context loss/restoration, and compact/forced-colors inspection across both modes. Renderer-sensitive playback, recovery, responsive-layout, and accessibility paths exercise both modes directly; mode-independent acquisition ownership remains covered once per live workflow. The existing long-task, hot-path I/O/upload, GPU-memory, and painted-receipt gates do not relax for visual quality.

### Current Alpha evidence

The release WebView2 renderer with the quiet weak-return curve and explicit map-context boundary passed separate `Native` and `Smooth` 1,000-transition resident-playback scenarios at 3840x2160 with zero long tasks, zero hot-path acquisition, and zero hot-path frame uploads. Frame-time P95 was 6.2 ms in both modes. Switching modes changed neither observation/receipt truth nor the 53,099,312-byte resident GPU set and caused no upload. Automated isolated-pixel evidence found substantial signal in both modes, a 53.7% changed-pixel ratio, and 33.0% background retained in common; generated overview and close-zoom captures show weak texture receding while positive structure remains visible. Runtime coexistence placed matte water and local context through `place_town` below radar and began the essential above-radar graph at `highway_major_context_casing`.

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
