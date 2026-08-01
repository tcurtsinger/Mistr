# Phase 3 static GPU renderer report

**Status:** Complete on the primary Windows workstation

**Scope:** One real decoded KTLX Level II reflectivity sweep rendered in a public MapLibre WebGL2 custom layer. No multi-frame residency, playback, live chunks, velocity parity, fallback, or context-recovery claim.

## Result

**PASS** for the bounded Phase 3 scope.

The release Tauri executable decoded the pinned public KTLX fixture, transferred its strict `PackedSweep v1` bytes, copied a compact renderer model, released the transfer credit, uploaded native raw/status/azimuth/radial-metadata/palette textures, and published a paint receipt only after a WebGL fence reported GPU completion.

The accepted representation and retention rules are in [`15_GPU_RENDERER_DECISION.md`](../15_GPU_RENDERER_DECISION.md).

## Packaged environment

| Property | Result |
|---|---|
| Shell | Tauri release executable / packaged frontend assets |
| View runtime | Windows WebView2 |
| Framebuffer | 1,440 by 900, device pixel ratio 1 |
| WebGL | WebGL 2.0 / GLSL ES 3.00 Chromium |
| GPU path | Hardware ANGLE, NVIDIA GeForce RTX 4080, D3D11 |
| Maximum 2D texture size | 16,384 |
| Fragment texture units | 16 (five required) |
| Shader driver log | Empty |

The executable was built with `npm run tauri:build -- --no-bundle`, then launched with `MISTR_PHASE3_FIXTURE_PATH` pointing to the ignored, hash-verified public fixture. Browser/Vite-only rendering is not used as acceptance evidence.

## Fixture and decoded truth

| Property | Result |
|---|---:|
| Fixture | `KTLX20240520_230512_V06` |
| Observation ID | `f3c4ced03212402d921c9880b485db5b` |
| Shape | 720 radials by 1,832 gates |
| Cells | 1,319,040 |
| Raw encoding | 8-bit, scale 2, offset 66 |
| Gate geometry | 2,125 m first center, 250 m spacing |
| Packed transfer | 7,931,840 bytes (7.564 MiB) |

Phase 1 already proved every normalized gate and detailed status against independent Py-ART 2.2.5 full-array hashes. Phase 3 does not substitute a new decoder assertion for that result; it proves those bytes survive the renderer boundary.

## Renderer candidate measurement

Both candidates were materialized/measured from the real 720 by 1,832 shape in packaged WebView2. The shared geometry allocation was immediately discarded; only the polar quad reached WebGL.

| Candidate | Geometry | CPU construction | Selected |
|---|---:|---:|---|
| Shared indexed radial grid | 42,229,704 bytes; 1,321,593 vertices; 7,914,240 indices; 2,638,080 triangles | 8.9 ms | No |
| Polar-sampling quad | 48 bytes; 6 vertices; 2 triangles | below timer resolution in this run | **Yes** |

The selected shader performs inverse Web Mercator, spherical ground range/bearing, irregular-radial lookup, standard-atmosphere ground-to-slant conversion using the measured radial elevation, native half-gate selection, detailed-status handling, and palette lookup. Missing lookup entries and below-threshold gates discard; range-folded remains explicit.

## Numeric alignment

Ten generated anchor coordinates cover source radial indices 0, 180, 360, 540, and 719 at the near gate and 117.125 km slant range. Every surface map coordinate selected the exact source radial and gate after the 4/3-Earth beam conversion.

| Check | Result |
|---|---:|
| Correct anchor selections | 10 / 10 |
| Maximum recovered range error | `5.006e-9` m |
| Maximum recovered bearing error | `2.001e-10` degrees |
| Independent Py-ART beam-projection references | 15 / 15 within 0.1 m |
| Outermost reference | 459,875 m slant -> 459,200.875 m ground |
| Native radial-gap test | PASS; lookup zero remains missing |
| Gate half-boundary tests | PASS |
| Antimeridian geodesy test | PASS |

The errors above are floating-point round-trip noise, far below one 250 m gate or one approximately 0.5 degree radial.

## Raw/status/palette GPU truth

After upload, the renderer temporarily attached each owned texture to a read framebuffer and compared selected texels with the CPU source. This diagnostic is outside the draw/playback hot path.

| Field | CPU expected | GPU readback |
|---|---:|---:|
| Raw reflectivity code | 67 | 67 |
| Detailed status | 0 (valid) | 0 |
| Encoded radial lookup | 1 | 1 |
| Premultiplied palette RGBA | `[30, 106, 114, 136]` | `[30, 106, 114, 136]` |

Point interrogation independently returns raw code, status, decoded dBZ, source radial/gate, and the unpremultiplied palette color. Tests also cover below-threshold, range-folded, and invalid status behavior; the real KTLX fixture itself contains no range-folded reflectivity cells.

## Visual and MapLibre coexistence evidence

Three packaged captures were reviewed:

- full-range zoom 5.0;
- radar offset from screen center at zoom 6.4; and
- near-radar gate detail at zoom 8.0.

In all three, the same echoes remain geospatially fixed while the map moves/zooms, the dashed diagnostic range layer renders below radar, diagnostic anchor circles render above radar, and basemap roads/labels remain present. Public `map.getLayersOrder()` plus `map.getLayer()` verify the actual style order: ordinary `waterway` below the radar group, exact diagnostic order `range -> radar -> anchors`, and ordinary `water_name` above it. No private MapLibre member is read.

An ignored diagnostic artifact generated by `scripts/oracle/render_pyart.py` renders the same verified bytes through independent Py-ART. Human comparison confirmed the same north-up footprint, near-radar structure, and isolated distant echoes. This visual check is supported by, not substituted for, the full-array Phase 1 hashes, exact GPU readback, and numeric anchor proof.

## Static performance and resources

After 20 scripted pan/zoom positions plus normal basemap activity, the final corrected renderer snapshot recorded 543 custom-layer draws.

| Measurement | Result |
|---|---:|
| Shader compile/link | 1.7 ms |
| Texture upload plus exact readback | 5.8 ms |
| First GPU-complete paint after upload | 6.6 ms |
| Custom-layer draw CPU P95 | 1.1 ms |
| Known renderer CPU model | 2,654,912 bytes (2.532 MiB) |
| Known radar GPU allocations | 2,655,984 bytes (2.533 MiB) |

These are one-workstation static-render measurements, not Phase 4 playback percentiles. “Known GPU allocations” counts Mistr's specified texture/buffer bytes; it does not claim visibility into opaque driver allocation or the basemap's GPU memory.

The seven-process Tauri/WebView2 tree snapshot after the interaction run was:

| Whole process tree | Result |
|---|---:|
| Aggregate working set | 544,829,440 bytes (519.59 MiB) |
| Aggregate private bytes | 389,464,064 bytes (371.42 MiB) |

This includes the shell, WebView2 browser/renderer/GPU processes, MapLibre, basemap tiles, UI, and diagnostics. It is not a radar-only number or a leak result.

## Packaged defect found and fixed

The first release run never reached MapLibre `load`. MapLibre 6's ESM worker was emitted as a plain URL, but its adjacent `maplibre-gl-shared.mjs` dependency was not emitted, so WebView2 received the app HTML fallback with a non-JavaScript MIME type.

Mistr now imports the worker with Vite's `?worker&url` contract and calls public `setWorkerUrl` before map construction. Vite bundles the worker and its shared dependency into one emitted worker asset. The packaged rerun reached `BASEMAP READY`, decoded/uploaded radar, and passed. A regression test requires the configured URL to match MapLibre's public worker setting.

## Automated coverage

The TypeScript suite now contains 45 tests across 12 files, including:

- geodesic and Mercator round trips, antimeridian wrap, native gate boundaries, exact beam-width rejection at quantized lookup-bin edges, irregular-radial gaps, unordered-radial rejection, distant-query rejection before beam inversion, and 15 committed Py-ART standard-atmosphere slant/ground references;
- compact CPU-model sizing and retention, point interrogation, exact anchor selection, status/value/palette semantics, and unsupported product/status rejection;
- premultiplied palette bytes and below-threshold/range-folded behavior;
- measured candidate geometry counts/bytes and bounded dimensions;
- fail-closed hardware-renderer classification when unmasked renderer evidence is unavailable or identifies a common software rasterizer;
- actual MapLibre layer-order proof, including failure when no ordinary style layer remains above radar;
- shader contract checks for compact texture fetches and CPU-matching missing/gate/status rules;
- exact Phase 3 Tauri command arguments and leased credit release; and
- explicit MapLibre worker URL configuration.

Rust has 35 library tests plus five binary tests. The Phase 3 fixture command shares the two-credit broker, performs a hard bounded read even if the file grows after metadata inspection, decodes/encodes off the command thread, blocks stale publication, and returns the credit on every error path.

## Phase gate

- [x] Real Level II reflectivity sweep renders through a public MapLibre WebGL2 custom layer.
- [x] Selected renderer is based on a measured shared-grid comparison and accepted ADR.
- [x] Native raw/status/palette texture bytes agree exactly with CPU truth.
- [x] Independent geodesic anchors select the exact native gates at multiple bearings/ranges.
- [x] Packaged captures pass at multiple zooms and an offset screen position.
- [x] Independent Py-ART imagery shows the same field footprint and orientation.
- [x] Standard MapLibre layers before and after radar remain present and visually correct.
- [x] Hardware/capability, resource, compile, upload, first-paint, draw, and whole-process metrics are recorded without conflating scopes.
- [x] No undocumented private MapLibre property is used.

**Decision:** Phase 3 passes on the primary workstation. Proceed to Phase 4 only after this pull request's demonstrated-defect review is resolved. Phase 4 must prove a real 20-frame resident loop, frame-selection paint receipts, zero hot-path I/O/decode/IPC, bounded memory, and interaction performance. Phase 6 remains responsible for context-loss restoration.
