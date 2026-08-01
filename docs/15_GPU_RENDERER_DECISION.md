# GPU renderer, native grid, and retention decision

**Status:** Accepted for Mistr Phases 3 and 4

**Date:** 2026-07-31

## Context

Mistr must render decoded NEXRAD Level II base reflectivity in a public MapLibre custom layer without recreating a large per-gate mesh or inventing measurements where a radial is absent. The same representation must remain understandable and repairable by AI coding agents, preserve raw-code truth for point interrogation, fit a 20-observation loop inside the prototype budgets, and recover deterministically after later context-loss work.

The production candidates were:

1. shared indexed radial/gate geometry plus value textures; and
2. a screen-space bounding quad whose fragment shader converts Web Mercator coordinates to longitude/latitude, computes radar-relative range/bearing, and samples the native polar textures.

This record also closes the Phase 3 decisions for normalization/missing-data semantics and CPU/GPU retention.

## Decision

### Renderer representation

Use a **screen-space polar-sampling quad** in a two-dimensional MapLibre `CustomLayerInterface`.

- Six vertices form two triangles around the geodesically sampled radar extent.
- An `R8UI` texture stores native KTLX reflectivity raw codes.
- A second `R8UI` texture stores explicit valid/below-threshold/range-folded status.
- A 4,096-entry `R16UI` azimuth lookup maps bearings to irregular native radials. Zero means no measured radial covers the bearing.
- An `R32F` texture stores each radial's measured elevation in radians.
- A 256 by 1 `RGBA8` texture stores the premultiplied diagnostic palette.
- The shader uses the matrix supplied through MapLibre's public `CustomRenderMethodInput.defaultProjectionData.mainMatrix`. It measures surface distance, selects the native radial, then converts surface distance to Level II beam slant range with the Doviak-Zrnic standard-atmosphere 4/3-Earth model before selecting the gate. It does not read private style, transform, painter, or source internals.
- Pitch, bearing, terrain, and globe are out of the accepted Phase 3 camera contract. The app fixes pitch and bearing at zero and selects Mercator.

This is not literally “one scan equals one GPU buffer.” One observation is a compact resource set: raw texture, status texture, azimuth lookup, palette, and a six-vertex quad. Phase 4 may share compatible immutable resources, but correctness does not depend on that optimization.

### Native grid and missing data

Preserve each observation's native radial and gate dimensions rather than padding every observation to a nominal 720 by 1,832 grid.

- Gate selection uses the source first-gate center and spacing with inclusive half-gate boundaries.
- Level II gate ranges are slant ranges. Surface placement and point interrogation convert consistently through the radial's measured elevation and the standard 4/3-Earth beam model.
- Radials remain sorted by source azimuth and retain their beam widths.
- The CPU builds the bounded azimuth lookup from those beam widths.
- Lookup value zero is transparent missing coverage. The shader never bridges an unmeasured radial gap.
- Below-threshold is transparent; range-folded remains a distinct status and explicit color.
- Compatible dimensions may be grouped later, but a texture array is not required for Phase 4. Incompatible observations use separate bounded texture sets.

### CPU and GPU retention

Release the 7.564 MiB `PackedSweep` lease after the renderer copies only the compact restoration/interrogation model and synchronously uploads the selected observation.

Retain per observation on the renderer CPU side:

- raw codes;
- detailed statuses;
- radial azimuths and beam widths; and
- radial elevations;
- the azimuth lookup.

Do not retain the packed `Float32Array` value section. A value is recovered losslessly from raw code, scale, and offset for accepted reflectivity encodings.

For Phase 4, retain the compact CPU upload source for every resident observation so context restoration can be deterministic and independent of disk/IPC. If a future product or layout makes the 20-observation loop exceed the declared CPU/GPU ceilings, reduce residency or activate fallback visibly; do not silently discard restoration truth.

## Alternatives considered

### Shared indexed geometry

The measured 720 by 1,832 candidate contained:

- 1,321,593 vertices;
- 7,914,240 indices;
- 2,638,080 triangles; and
- 42,229,704 CPU bytes before value/status textures.

It built in 8.3 ms in the corrected packaged run, but repeats gate-boundary geometry and introduces index/edge rules that the polar shader does not need. It remains a viable future reference renderer, not the selected production candidate.

### Normalized maximum grid

Padding simplifies array-layer selection but can invent apparent radial coverage unless a separate validity representation is perfect. It also spends memory on absent gates and hides genuine layout variation. Native dimensions are simpler and more truthful for the bounded prototype.

### Re-decode or re-request on context restoration

This would lower renderer CPU retention but couple recovery to Rust cache/IPC availability and make visible-frame recovery slower and harder to reason about. The measured compact model is small enough to retain for the intended loop.

## Evidence

The accepted KTLX observation is 720 by 1,832 (1,319,040 cells), 8-bit reflectivity, 250 m gate spacing, and 2,125 m first-gate center.

| Evidence | Recorded result |
|---|---:|
| Polar geometry | 48 bytes, 6 vertices, 2 triangles |
| Renderer CPU model | 2,654,912 bytes (2.532 MiB) |
| Known GPU radar allocations | 2,650,224 bytes (2.527 MiB) |
| Projected 20-observation CPU model | 50.64 MiB |
| Projected 20-observation GPU allocations | 50.55 MiB |
| Shader compile/link | 14.4 ms |
| Upload plus exact texture readback | 5.5 ms |
| GPU-completion first-paint receipt | 6.5 ms |
| Custom-layer draw CPU P95 | 1.2 ms across 615 draws |

The one-observation resource count includes two 1,319,040-byte gate textures, one 8,192-byte azimuth lookup, one 2,880-byte radial-elevation texture, one 1,024-byte palette, and a 48-byte quad. It excludes opaque driver allocation/alignment and MapLibre/basemap resources, so it is a known-allocation estimate rather than total GPU-process memory.

Ten CPU-generated gate anchors at near and 117.125 km slant ranges recovered the exact source radial/gate after converting to ground placement. Maximum geodesic round-trip error was `5.006e-9` m in ground range and `2.001e-10` degrees in bearing. Fifteen committed independent Py-ART 2.2.5 reference gates at near, 117.125 km, and 459.875 km slant range validate the conversion to ground range within 0.1 m. At the outer gate, Py-ART reports 459,200.875 m ground range rather than 459,875 m slant range. A packaged WebGL framebuffer readback exactly recovered raw code 67, status 0, encoded radial 1, and premultiplied RGBA `[30, 106, 114, 136]` from the uploaded textures.

The packaged captures at zoom 5.0, offset zoom 6.4, and near zoom 8.0 preserve the same footprint and marker alignment. A separate Py-ART 2.2.5 render of the verified source archive shows the same field orientation, near-radar footprint, and isolated distant echoes. The stronger numeric basis remains the prior full-array Py-ART agreement plus the GPU readback and geodesic anchor tests.

The packaged WebView2 device was hardware ANGLE/D3D11 on an NVIDIA GeForce RTX 4080. WebGL2 reported `MAX_TEXTURE_SIZE = 16384` and 16 fragment texture units, above the required 4,096 lookup width and five samplers.

## Consequences

- Phase 4 frame selection swaps a bounded resource selection rather than waiting for raster-tile readiness.
- The renderer's main complexity is explicit and localized in geodesy, lookup construction, texture upload, shader sampling, and GL-state restoration.
- Variable observations do not need destructive resampling, but separate texture sets may require more binding work than one array texture.
- Point interrogation and GPU rendering share raw/status/scale/offset semantics without retaining duplicate decoded float fields.
- The design is restricted to the accepted 2D Mercator camera contract until other modes receive their own evidence.

## Risks and mitigations

- **Fragment cost at large screen coverage:** measure 20-frame playback and pan/zoom at representative resolution in Phase 4; retain tiled fallback.
- **Irregular radial gaps:** the zero-valued lookup is tested and discards unmeasured bearings.
- **GPU/CPU disagreement:** exact texture readback is a Phase 3 gate; shader sources and CPU equations have deterministic tests.
- **MapLibre interference:** every draw binds owned resources and restores program, VAO, texture units, blend equations/functions, and depth/stencil/cull/blend enables. Standard layers are deliberately inserted before and after the custom layer and verified in the packaged app.
- **Context loss:** compact CPU truth is retained, but actual loss/restoration is intentionally a Phase 6 gate and is not claimed here.

## Validation required next

Phase 4 must load a real 20-observation loop, prove already-resident hard cuts with paint receipts, measure frame-time/long-task behavior under interaction, and confirm the projected CPU/GPU residency with actual allocations and stabilized process memory.

## Primary API basis

- [MapLibre `CustomLayerInterface`](https://maplibre.org/maplibre-gl-js/docs/API/interfaces/CustomLayerInterface/)
- [MapLibre `CustomRenderMethodInput`](https://maplibre.org/maplibre-gl-js/docs/API/type-aliases/CustomRenderMethodInput/)
- [MapLibre custom style-layer example](https://maplibre.org/maplibre-gl-js/docs/examples/add-a-custom-style-layer/)
- [MapLibre v6 release notes](https://github.com/maplibre/maplibre-gl-js/releases/tag/v6.0.0)
- [WebGL 2.0 specification](https://registry.khronos.org/webgl/specs/latest/2.0/)
- [Py-ART antenna-to-Cartesian standard-atmosphere equations](https://arm-doe.github.io/pyart-docs-travis/API/generated/pyart.core.antenna_to_cartesian.html)

**Supersedes / superseded by:** resolves D007 and Q002, Q003, and Q006 in `08_DECISIONS_AND_OPEN_QUESTIONS.md`. Not superseded.
