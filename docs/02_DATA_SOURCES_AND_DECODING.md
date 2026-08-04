# Data Sources and Decoding

## 1. Source policy

Mistr uses public, keyless sources for the prototype and records exact source provenance for every observation. It does not imply NOAA endorsement and must retain required attribution when integrated.

Primary public buckets:

| Source | Purpose | Prototype use |
|---|---|---|
| `s3://unidata-nexrad-level2` | Completed/archive Level II volumes | Deterministic fixtures, recent history, fallback for complete volumes |
| `s3://unidata-nexrad-level2-chunks` | Real-time Level II volume chunks | Lowest-latency live selected-site Level II acquisition |
| `s3://unidata-nexrad-level3` | Selected real-time Level III products | Implemented official `N0S` storm-relative velocity path |
| Existing NOAA/NWS `SR_BREF` WMS | Current selected-site tiled reflectivity | Visual/latency comparison and fallback only |
| Existing IEM RIDGE `N0S` | Current selected-site tiled SRV | Product parity, latency comparison, fallback only |
| NOAA `noaa-mrms-pds` `CONUS/MergedBaseReflectivityQC_00.50/` | National CONUS base-reflectivity mosaic | Merged fixed-host acquisition/strict numeric decode/levels/`PackedGrid v1` and one-frame renderer; Phase 4 adds 20-observation history/polling |

The current AWS Open Data registry names `unidata-nexrad-level2` as archive data, `unidata-nexrad-level2-chunks` as real-time Level II data, and `unidata-nexrad-level3` as selected real-time Level III data.

## 2. Radar data model

Mistr documentation uses these terms precisely:

- **Radial:** one beam direction containing range gates.
- **Gate/bin:** one sampled range interval along a radial.
- **Sweep/elevation scan:** a set of radials around the radar at one elevation angle.
- **Volume scan:** multiple sweeps/elevations collected under a volume coverage pattern.
- **Moment:** measured field such as reflectivity, radial velocity, spectrum width, ZDR, PhiDP, or correlation coefficient.
- **Playback frame:** one selected product/elevation observation rendered at a measured time. Initially this is one lowest-elevation sweep extracted from one Level II volume or one Level III product.

Calling a complete Level II volume “one GPU buffer” is incorrect. The prototype extracts and normalizes only the displayed sweep.

## 3. Product mapping

### 3.1 Base reflectivity

Prototype source: Level II reflectivity moment from the selected lowest usable elevation.

Requirements:

- Preserve measured data codes and documented scale/offset.
- Preserve missing, below-threshold, and range-folded states.
- Record the actual elevation angle and measurement time.
- Keep decoded data separate from presentation: any spatially filtered display must use the same observation and leave native interrogation unchanged.
- Compare against the current NOAA/NWS `SR_BREF` image and an independent Level II decoder, recognizing that provider quality control or styling may create visual differences.

For a valid Level II reflectivity code, the canonical conversion is exact:

```text
dBZ = (rawCode - offset) / scale
```

Mistr does not round the result before palette lookup or point interrogation. Status is authoritative: below-threshold is transparent, range-folded remains an explicit categorical state, and an unknown or missing status never becomes a valid return. Valid reflectivity keeps the NOAA/NWS operational `SR_BREF` RGB thresholds. A separate display-only curve makes non-positive dBZ transparent, progressively raises opacity from 0 through 20 dBZ, and leaves values at or above 20 dBZ fully opaque. This does not classify clutter or alter the native measured gate returned by inspection.

The `Smooth` display mode may filter the spatial presentation inside a single measured observation. `Native` uses exact nearest-gate sampling. Neither mode changes normalized bytes, scale/offset metadata, scan time, freshness, playback truth, or the native dBZ returned for a map inspection. The complete boundary and acceptance contract is [Radar Rendering Quality](25_RADAR_RENDERING_QUALITY.md).

### 3.2 Velocity

Level II provides mean radial/base velocity. This is not the same as GustAVO's current storm-relative velocity.

Mistr must label Level II velocity as **Base velocity** or **Radial velocity** unless a separately validated transformation is applied.

### 3.3 Storm-relative velocity

GustAVO currently uses official `N0S` storm-relative velocity from IEM RIDGE. Phase 6 accepted a bounded raw Level III code-56 `N0S` decoder and normalizes it as the canonical `storm_relative_velocity` product in `kt` through the same renderer contract. The pinned implementation and parity evidence are recorded in [`18_LEVEL3_N0S_AND_CONTEXT_RECOVERY_DECISION.md`](18_LEVEL3_N0S_AND_CONTEXT_RECOVERY_DECISION.md).

Mistr must not initially:

- Estimate storm motion.
- Subtract an inferred motion vector.
- Claim home-grown storm-relative velocity parity.
- Treat velocity dealiasing as a display-shader operation.

### 3.4 National radar

Level II is per-site and Mistr will not combine sites into a mosaic. The National source is NOAA MRMS `MergedBaseReflectivityQC` for CONUS: NOAA has already performed the multi-radar processing and quality control, while Mistr validates, decodes, preserves, and renders the numeric grid without claiming mosaic authorship.

Merged Phases 1 through 4 provide typed source coordination, fixed-host inventory/object download, gzip expansion, strict GRIB2/PNG decode, exact normalization, value-aware levels, `PackedGrid v1`, a separate numeric-grid renderer, 20 exact timeline observations, and identity-bound backend interrogation. The National session lists bounded current/previous-day keys by measured time, paints current first, retains immutable compressed objects and complete factor-4 overviews, backfills strictly older observations, and polls inventory for only strictly newer observations. Regional playback detail uses the same decoded retained identities; it does not reacquire or reinterpret provider data.

Each Phase 4 history mutation has one staged backend identity and one provisional GPU mutation. Predecessor and newer preparation are idempotent for an already-staged matching mutation: if Rust stored the frame but the Tauri response was lost, retry returns the same allocation and observation identity without another discovery, download, or decode. That report carries `reused: true`; frontend validation permits zero discovery/download/decode/network/response metrics only for this non-current replay shape. Fresh acquisition still requires measured network counts, and a different staged mutation kind still fails closed. After complete chunk upload, viewport draw, and GPU fence, Rust applies the chronology change with an identity-bound reversible journal. The renderer finalizes before Rust seals that journal; a context loss, supersession, or failure before that point restores both sides to the prior complete frame, including any just-evicted oldest observation. The most recently sealed identity remains as bounded idempotency metadata, allowing the frontend's same-identity finalize retry to return durable history after a lost IPC response. Point lookup re-decodes the exact retained compressed object under a single-operation gate when the selected base grid is not cached. Downloaded objects remain memory-owned and ignored artifacts rather than a directory-scanned provider cache.

National's durable normalized baseline is a two-byte unsigned raw code plus declared GRIB scaling and status metadata. Development fixtures confirm correctness but never define an observed-value allowlist. Unsupported template, bit depth, scaling, packing, grid, or status metadata rejects the new observation and preserves the last painted source.

The Phase 2 adapter accepts only `https://noaa-mrms-pds.s3.amazonaws.com/` and exact keys under `CONUS/MergedBaseReflectivityQC_00.50/YYYYMMDD/`. Inventory is bounded to 1,000 objects and 2 MiB per listed day; current and previous UTC days are combined only when required, deduplicated, sorted by filename/GRIB measured time, and selected newest by measurement rather than response order. Object responses are capped at 16 MiB compressed, redirects are disabled, declared and streamed sizes are checked, and HTML/XML error bodies cannot masquerade as a successful binary response.

The decoder is intentionally product-specific rather than a general GRIB implementation. It requires one complete GRIB2 message with discipline 209, the reviewed identification and product fields, the exact 7,000 by 3,500 north-to-south CONUS regular latitude/longitude grid, Template 5.41 PNG packing, 16-bit non-interlaced grayscale PNG data, no bitmap, and the reviewed `R=-9990`, `E=0`, `D=1` scaling. The numeric formula is `(R + X * 2^E) / 10^D`; raw `9000` is missing and raw `0` is no coverage. Every other `u16` code is structurally valid and decoded by that metadata, including values absent from all fixtures. Format drift fails closed with a stage-specific diagnostic rather than guessing.

The four-season public oracle compares all 24,500,000 cells per sample against ecCodes, records zero formula disagreements, and keeps only hashes, counts, point samples, and tiny windows in Git. The reviewed development sample additionally pins compressed, expanded-GRIB, and normalized big-endian hashes. Downloaded NOAA observations stay in ignored `fixtures/cache/` paths.

### 3.5 Source identity boundary

`RadarSourceKey` identifies user-level source intent independently of decoder provenance:

```ts
type RadarSourceKey =
  | { kind: "site"; siteIcao: string }
  | { kind: "national"; domain: "conus" };
```

Archive and live Level II observations for one station both satisfy the same top-level Site intent. Their exact provider source remains in observation provenance and paint truth. `PackedGrid v1` retains the MRMS product, domain, provider, object key, content hash, measured time, grid transform, scaling/status metadata, presentation level, and chunk geometry without representing the observation as a polar sweep. Every National chunk, complete-coverage GPU receipt, history identity, and exact point lookup repeats the same observation identity. At reduced presentation levels, the first and last grid coordinates are the centers of the complete source-cell footprints represented by those reduced cells; they are not copied unchanged from the factor-1 cell centers.

National history keeps the immutable compressed provider object as exact durable truth. An exact numeric pyramid retained from current-frame preparation is only a bounded acceleration cache. Once a strictly newer frame finalizes, the superseded pyramid is released; later detail or interrogation for that older observation safely re-decodes its retained object. This prevents an old 64 MiB-class pyramid from overlapping the 49 MiB factor-1 packed cache and falsely exhausting the 180 MiB history target.

## 4. Acquisition modes

### 4.1 Fixture mode

The default automated mode uses pinned local source objects with a manifest. It exercises the same decode, normalize, wire, and renderer paths as live operation.

Fixture mode supports deterministic simulated:

- Network delay.
- Chunk gaps.
- Out-of-order chunks.
- Duplicate chunks.
- Cancellation.
- Corrupt compressed data.
- Unsupported message variants.
- Slow decode and slow upload.

### 4.2 Archive/completed-volume mode

Use the archive bucket to:

- Build the initial 20-frame loop.
- Backfill missing recent observations.
- Capture reproducible fixtures.
- Compare full-volume metadata.

Objects are immutable by key for prototype purposes and cached with source metadata and a content hash.

### 4.3 Real-time chunk mode

The real-time bucket exposes rotating volume indices and ordered chunks. The prototype must account for:

- Start/intermediate/end chunk types.
- Approximately dozens of chunks per volume, not one object.
- Several-second chunk cadence.
- Missing volume indices and gaps.
- A volume index eventually being reused.
- Chunks arriving while the operator switches site/product.
- Lowest elevation completing before the entire volume.

The prototype must measure, not assume, whether a safe publishable lowest sweep arrives before IEM/NOAA renders become available.

## 5. Latency model

For every observation, record these monotonic and UTC timestamps where available:

1. Radar measurement start.
2. Sweep completion.
3. Source object/chunk last-modified time.
4. Mistr discovery time.
5. Download start/end.
6. Assembly completion.
7. Decode start/end.
8. Normalize start/end.
9. IPC start/end.
10. GPU upload start/end.
11. First paint receipt.
12. Current IEM/NOAA comparable-frame discovery time.

Primary latency comparisons:

- Measurement to first safe raw paint.
- Measurement to current provider tile availability.
- Discovery to first paint.
- P50, P95, and worst observed latency across quiet and severe-weather periods.

No claim that chunks are faster becomes product documentation until measured.

## 6. Decoder dependency policy

The Rust NEXRAD ecosystem is usable but young. Mistr must not expose third-party crate types outside an adapter module.

Before selecting a decoder:

1. Pin exact crate versions and source revisions.
2. Record license and transitive dependencies.
3. Run the fixture corpus against the candidate.
4. Compare decoded values with at least one independent mature decoder or application export.
5. Fuzz or property-test malformed counts, offsets, and truncation.
6. Verify current Message 31 and real-time chunk behavior.
7. Inventory unsupported historical formats without expanding the prototype scope.
8. Decide whether to pin, fork, or replace based on demonstrated defects—not version number alone.

The adapter must make swapping decoders possible without changing acquisition, wire, UI, or renderer modules.

## 7. Decoder oracle strategy

No single implementation is its own oracle.

For Level II fixtures, compare where possible against:

- NOAA format/transfer interface control documents.
- Py-ART or xradar decoded coordinates and moment values.
- Supercell Wx or another trusted viewer for visual and metadata sanity.
- Current NOAA/NWS imagery for time, coverage, gross alignment, and product identity.

For Level III `N0S`, compare against:

- The raw product metadata.
- `nexrad-level-3-data` or another independent decoder.
- IEM RIDGE `N0S` at the same site and measured time.

Required comparisons are numeric, not screenshot-only:

- Radial count.
- Gate count.
- Azimuth/elevation.
- First gate and gate spacing.
- Product code and units.
- Scale/offset transformation.
- Missing/range-folded markers.
- Sampled gate values at pinned radial/gate indices.
- Data extent and measurement time.

## 8. Internal normalized sweep

Conceptual fields for the Mistr-owned internal model:

```text
NormalizedSweep
  schema_version
  source_kind                 // level2_archive | level2_chunks | level3
  source_object_id
  source_content_hash
  site_icao
  product                     // reflectivity | base_velocity | storm_relative_velocity | ...
  units
  measured_at_utc
  volume_started_at_utc
  elevation_number
  elevation_degrees
  vcp
  radar_latitude
  radar_longitude
  radar_altitude_m
  radial_count
  gate_count
  gate_spacing_m
  first_gate_center_m
  value_encoding              // u8 | u16
  scale
  offset
  missing_code
  range_folded_code
  azimuths[]
  beam_widths[]
  values[radial][gate]
  validity[radial][gate]
```

The implementation may optimize storage, but all semantic information must remain recoverable.

## 9. `PackedSweep v1` wire layout

The exact byte layout should be finalized in an ADR before implementation. Required properties:

- Magic bytes and schema version.
- Little-endian fixed-width numeric fields.
- Total byte length.
- Header checksum or full payload hash.
- Product/units/encoding enums, not free-form strings in the bulk section.
- Radar/site/time/elevation/range metadata.
- Section directory with aligned offsets and lengths.
- Azimuth section.
- Optional beam-width section.
- Value section.
- Validity/mask section.
- No pointer-sized or platform-dependent fields.
- Decoder rejects unknown required flags and accepts only explicitly compatible minor additions.

Mistr should also define a small JSON diagnostic representation for tests and human inspection. It is never used for bulk runtime transfer.

## 10. Cache and retention

Initial defaults, subject to measurement:

- GPU: at most 20 observations for the active loop.
- Normalized CPU data: active loop plus enough retained data for context restoration within a documented RAM budget.
- Raw cache: bounded by bytes and age; offline completeness is not required.
- Fixture corpus: permanent, version-controlled by manifest and stored using an appropriate large-binary policy if source files are too large for ordinary Git.

Cache keys include every input that can alter output:

```text
source hash + decoder adapter version + normalization version + product + elevation + wire schema
```

## 11. Data failure policy

- Never display a partially decoded or internally inconsistent sweep as current.
- Retain the last complete painted observation when the next frame fails.
- Display explicit `STALE`, `INCOMPLETE`, `FALLBACK`, or `UNAVAILABLE` state.
- A timeout does not convert old data into current data.
- A missing chunk is not silently skipped inside a declared complete observation.
- A malformed object is quarantined by hash so the app does not retry it indefinitely.
- Source preference changes are recorded in provenance and surfaced in diagnostics.

## 12. Attribution and terms

The prototype documentation and UI must identify NOAA NEXRAD data and the AWS Open Data/Unidata distribution path as appropriate. It must not claim NOAA endorsement. Any future redistribution or packaging of raw fixture data must be reviewed for attribution, repository size, and provider policy.
