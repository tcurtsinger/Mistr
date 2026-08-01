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
| Existing IEM `USCOMP-N0Q` | National mosaic | Retained outside the raw selected-site engine |

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
- Do not blur measured gates merely to make the image appear smoother.
- Compare against the current NOAA/NWS `SR_BREF` image and an independent Level II decoder, recognizing that provider quality control or styling may create visual differences.

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

Level II is per-site. `USCOMP-N0Q` or a future official gridded multi-radar product remains responsible for wide-area national context.

Building a proper mosaic requires overlap policy, beam-height/quality considerations, terrain/blockage handling, time alignment, and multi-radar quality control. That is outside Mistr's initial scope.

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
