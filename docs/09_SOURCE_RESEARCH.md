# Source Research and Claim Ledger

**Research snapshot:** 2026-07-31

This document records the evidence behind Mistr's architecture. Live services, libraries, and versions must be rechecked at implementation start.

## 1. Verified external facts

### Public NEXRAD AWS sources

The AWS Open Data registry identifies:

- `unidata-nexrad-level2` as Level II archive data.
- `unidata-nexrad-level2-chunks` as Level II real-time data.
- `unidata-nexrad-level3` as selected Level III real-time data.
- Anonymous/no-account-required CLI access for the public buckets.
- New Level II data added as available.

Source: [NEXRAD on AWS — Registry of Open Data](https://registry.opendata.aws/noaa-nexrad/)

### Level II contents

NOAA describes Level II as digital radial base data containing reflectivity, mean radial velocity, spectrum width, and dual-polarization variables, plus metadata needed for interpretation.

Sources:

- [NOAA ROC Level II data types](https://www.roc.noaa.gov/level-two-data-types.php)
- [NOAA NEXRAD Level 2 metadata](https://www.ncei.noaa.gov/access/metadata/landing-page/bin/iso?id=gov.noaa.ncdc%3AC00345)

### Level II real-time format complexity

NOAA documents that real-time Level II transmission uses multiple data blocks per sweep, BZip2-compressed data sections, and special volume assembly rather than ordinary whole-file decompression.

Sources:

- [NCEI decoding utilities and examples](https://www.ncei.noaa.gov/products/radar/decoding-utilities-examples)
- [NOAA Archive II/User transfer ICD](https://www.roc.noaa.gov/public-documents/icds/2620010f.pdf)

### Rust decoder ecosystem

Rust crates exist for Level II data access, decoding/modeling, rendering, and processing. At the research snapshot, important crates are young (0.x or release candidates), so Mistr treats them as candidates behind an adapter, not a trusted immutable foundation.

Sources:

- [nexrad-data](https://docs.rs/nexrad-data/latest/nexrad_data/)
- [nexrad-model](https://docs.rs/nexrad-model/latest/nexrad_model/)
- [nexrad-process](https://docs.rs/nexrad-process/latest/nexrad_process/)
- [nexrad-render](https://docs.rs/nexrad-render/latest/nexrad_render/)

The `nexrad-data` real-time module documents rotating volume indices, dozens of chunks per volume, several-second chunk arrival, possible gaps, and polling helpers. Those details must be verified against the pinned implementation used by Mistr.

Source: [nexrad-data real-time module](https://docs.rs/nexrad-data/latest/nexrad_data/aws/realtime/)

### MapLibre custom rendering

MapLibre GL JS supports custom style layers that draw directly into the map's WebGL context. The custom layer owns its resources and must handle `webglcontextlost` and `webglcontextrestored`.

Source: [MapLibre `CustomLayerInterface`](https://maplibre.org/maplibre-gl-js/docs/API/interfaces/CustomLayerInterface/)

### Tauri binary IPC

Tauri's IPC response body supports raw bytes through `Raw(Vec<u8>)`, so Mistr can avoid JSON encoding for sweep data.

Sources:

- [Tauri `InvokeResponseBody`](https://docs.rs/tauri/latest/tauri/ipc/enum.InvokeResponseBody.html)
- [Tauri `Response`](https://docs.rs/tauri/latest/tauri/ipc/struct.Response.html)

This proves a binary representation is supported; the copy count and packaged performance still require measurement.

### Supercell Wx feasibility reference

Supercell Wx is a public C++/Qt/OpenGL application supporting live/archive Level II and Level III radar. Its source includes an AWS Level II chunks provider and an OpenGL radar layer using geometry/value buffers and a palette texture.

Sources:

- [Supercell Wx repository](https://github.com/dpaulat/supercell-wx)
- [AWS Level II chunks provider](https://github.com/dpaulat/supercell-wx/blob/develop/wxdata/source/scwx/provider/aws_level2_chunks_data_provider.cpp)
- [Level II product view](https://github.com/dpaulat/supercell-wx/blob/develop/scwx-qt/source/scwx/qt/view/level2_product_view.cpp)
- [Radar product layer](https://github.com/dpaulat/supercell-wx/blob/develop/scwx-qt/source/scwx/qt/map/radar_product_layer.cpp)
- [Supercell Wx radar product documentation](https://supercell-wx.readthedocs.io/en/stable/user-guide/radar-toolbox.html)

It proves feasibility and illustrates complexity. It does not prove Mistr's exact texture-array design or memory budget.

### Storm-relative velocity correction

NOAA distinguishes Level II mean radial/base velocity from the derived storm-relative velocity product. Storm-relative velocity removes storm motion from the base velocity field.

Sources:

- [NCEI NEXRAD product descriptions](https://www.ncei.noaa.gov/products/radar/next-generation-weather-radar)
- [NOAA velocity explanation](https://www.noaa.gov/jetstream/velocity)

Therefore Level II velocity cannot be silently substituted for GustAVO's `N0S` product.

### Velocity dealiasing correction

Velocity dealiasing is a processing algorithm with Nyquist, filtering, connectivity, and sometimes reference-wind considerations. It is not a color-table or one-line shader feature.

Sources:

- [Py-ART correction API](https://arm-doe.github.io/pyart/API/generated/pyart.correct.html)
- [Py-ART region-based dealiasing](https://arm-doe.github.io/pyart-docs-travis/API/generated/pyart.correct.dealias_region_based.html)

### National mosaic correction

NOAA's MRMS system combines multiple radars and other inputs with quality control and merging algorithms to produce seamless mosaics. A single-site Level II engine does not replace that function.

Sources:

- [NOAA NSSL MRMS overview](https://www.nssl.noaa.gov/projects/mrms/)
- [MRMS operational viewer overview](https://mrms.nssl.noaa.gov/)
- [Physically based seamless reflectivity mosaic](https://repository.library.noaa.gov/view/noaa/32326)

## 2. Live research observations

### Level III `N0S` availability

An anonymous listing of `unidata-nexrad-level3` on 2026-07-31 returned keys with the pattern:

```text
TLX_N0S_2026_07_31_HH_MM_SS
```

This establishes that current `N0S` objects existed in the public Level III bucket at the snapshot. Mistr still needs a pinned fixture and decoder parity test.

### KTLX Level II size spot-check

An anonymous listing of the latest 20 non-MDM KTLX objects under the 2026-07-31 archive prefix showed:

- Minimum compressed object: approximately 6.94 MiB.
- Median: approximately 7.22 MiB.
- Maximum: approximately 7.39 MiB.
- Total for 20: approximately 143.71 MiB.

This is a one-site/time snapshot and is not a capacity guarantee. Weather, VCP, moments, and compression affect size. Compressed object size is not GPU memory.

### Memory arithmetic

For an illustrative normalized `720 × 1832` two-byte value texture across 20 frames:

```text
720 × 1832 × 2 × 20 = 52,761,600 bytes
```

This supports the plausibility of a 100–200 MiB complete radar resource budget only with compact textures/shared geometry. A naïve two-triangles-per-gate mesh can exceed one gigabyte for 20 frames once duplicated positions and values are included.

## 3. Current GustAVO evidence

The following files in the separate GustAVO working copy were read as the local source of truth while preparing Mistr. They are listed by repository-relative name so this public document does not publish workstation paths:

- `PRODUCT.md`
- `ARCHITECTURE.md`
- `DATA_SOURCES.md`
- `AUDIT_2026-07-30.md`
- `CODEX_AUDIT_2026-07-30.md`
- `package.json`
- `src-tauri/Cargo.toml`

### Current radar behavior

The current architecture documents:

- NOAA/NWS `SR_BREF` for selected-site reflectivity.
- IEM RIDGE `N0S` for selected-site storm-relative velocity.
- IEM `USCOMP-N0Q` for national radar.
- National radar below zoom 7 and selected-site radar at zoom 7 and closer.
- Stable raster source/layer slots and two-frame look-ahead loading.
- Imperceptible nonzero preload opacity because exact-zero raster layers may be culled before fetch.
- `idle` plus native custom-protocol source-completion fallback.
- Paint gating and last-known-good behavior.
- `weathertile://` historical tile caching in packaged Tauri.

Mistr is specifically intended to remove those selected-site per-observation tile-readiness responsibilities after its loop is resident. It does not remove basemap tiles or the national mosaic.

### Current audit caution

The July 30 audit documents current Rust/Tauri and cache concerns, including synchronous command behavior on the WebView2 UI/IPC thread, cache robustness gaps, cancellation/eviction concerns, and Rust quality-gate issues. Mistr therefore does not assume “the Rust half is solid”; it retains useful capabilities while introducing bounded thread, cache, and diagnostics rules.

### Current stack snapshot

At the research snapshot GustAVO uses approximately:

- Tauri 2.
- React 19.
- TypeScript 5.8.
- Vite 7.
- MapLibre GL JS 5.24.
- Rust `reqwest`, Tokio, and SQLite dependencies.

Implementation must record and pin the exact Mistr versions rather than inheriting floating semver ranges without review.

## 4. Corrected claim ledger

| Original proposition | Final assessment |
|---|---|
| Public Level II archive and real-time AWS data exist | Accurate |
| Rust can decode Level II | Feasible, but current crates are young and need independent validation |
| GR2Analyst/Supercell Wx prove this product model | Directionally accurate; Supercell is publicly verifiable, GR2 internals are proprietary |
| One scan equals one GPU buffer | Oversimplified; a volume has multiple sweeps and an efficient renderer likely uses textures/shared geometry |
| Twenty scans use 100–200 MB | Plausible only with compact representation; not guaranteed |
| Playback becomes a frame selector after residency | Accurate core insight |
| All radar tile/readiness machinery disappears | Accurate only for selected-site raw radar; basemap/national mosaic remain |
| Custom color tables become straightforward | Accurate |
| True fidelity at any zoom | Raw gate fidelity is retained; zoom cannot create unmeasured information |
| Velocity dealiasing falls out for free | Incorrect |
| Storm-relative velocity comes from Level II | Incorrect; use official Level III `N0S` or separately validated derivation |
| Crossfade is one shader line | Arithmetic is simple; lifecycle/alignment/truth semantics are not free |
| Rust side is already completely solid | Overstated; local audits identify real concerns |

## 5. Revalidation checklist at implementation start

- Confirm AWS bucket names, access, object-key conventions, and current update behavior.
- Confirm current `N0S` availability.
- Confirm latest decoder crate versions/revisions and changelogs.
- Re-run the candidate decoder against captured fixtures.
- Confirm current Tauri raw IPC and WebView2 behavior.
- Confirm current MapLibre custom-layer API and pinned version.
- Recheck GustAVO's radar products, handoff zoom, current branch, and dirty worktree before integration.
- Record all revalidation in a dated research update rather than silently changing this snapshot.
