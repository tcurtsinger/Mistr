# PackedGrid v1

## Status and scope

`PackedGrid v1` is the Phase 2 binary contract for one NOAA MRMS numeric presentation level. It is implemented and cross-language validated behind a hidden diagnostic, but no National renderer or product source uses it yet.

It is intentionally distinct from polar `PackedSweep v1`. One frame consists of:

1. one bounded manifest containing immutable frame identity, numeric/grid metadata, and every chunk descriptor; and
2. one bounded record per numeric chunk containing repeated frame identity, exact two-byte unsigned raw codes, and a payload hash.

All integers and raw codes are big-endian. Floating-point reference value `R` is stored as its IEEE-754 `f32` bits. Version 1 accepts only the fixed CONUS `MergedBaseReflectivityQC_00.50` contract; changing a reserved field or accepted source/grid/encoding value requires reviewed schema work rather than lenient parsing.

## Bounds and constants

| Item | v1 value |
|---|---:|
| Header bytes | 176 |
| Chunk descriptor bytes | 72 |
| Manifest maximum | 1 MiB |
| Chunk maximum | 512 KiB |
| Chunk interior | 256 by 256 cells maximum |
| Sampling halo | one source cell where the level boundary allows |
| Base grid | 7,000 by 3,500 exact `u16` cells |
| Presentation factors | power of two, 1 through 16 |
| Phase 2 diagnostic factor | 4: 1,750 by 875, 28 chunks |
| Source/domain/product codes | `1` / `1` / `1` |
| Orientation code | `1`, north to south |

The existing global `TransferBroker` remains the only IPC credit owner. A manifest or chunk consumes one of exactly two credits until the frontend validates and releases its lease. No whole 49,000,000-byte expanded base grid crosses as one frontend buffer.

## Manifest record

Magic is `MGRD`; record kind is `1`.

| Offset | Bytes | Field |
|---:|---:|---|
| 0 | 4 | Magic |
| 4 | 2 | Schema version, `1` |
| 6 | 2 | Record kind |
| 8 | 4 | Header length, `176` |
| 12 | 4 | Exact total record length |
| 16 | 8 | Nonzero source generation |
| 24 | 8 | Measured observation Unix milliseconds, signed |
| 32 | 4 | Presentation-level width |
| 36 | 4 | Presentation-level height |
| 40 | 4 | First latitude, signed microdegrees |
| 44 | 4 | First longitude, signed microdegrees |
| 48 | 4 | Last latitude, signed microdegrees |
| 52 | 4 | Last longitude, signed microdegrees |
| 56 | 4 | Longitude step at this level, unsigned microdegrees |
| 60 | 4 | Latitude step at this level, unsigned microdegrees |
| 64 | 1 | Row-orientation code |
| 65 | 1 | Bit depth, `16` |
| 66 | 2 | Reserved zero |
| 68 | 4 | GRIB reference value `R` as `f32` bits |
| 72 | 2 | Signed binary scale `E` |
| 74 | 2 | Signed decimal scale `D` |
| 76 | 2 | Missing raw code |
| 78 | 2 | No-coverage raw code |
| 80 | 2 | Presentation factor |
| 82 | 2 | Chunk interior size, `256` |
| 84 | 4 | Chunk count |
| 88 | 8 | Source-kind UTF-8 offset and length |
| 96 | 8 | Domain UTF-8 offset and length |
| 104 | 8 | Product UTF-8 offset and length |
| 112 | 8 | Provider UTF-8 offset and length |
| 120 | 32 | Compressed source-object SHA-256 |
| 152 | 4 | Descriptor-section offset |
| 156 | 2 | Descriptor size, `72` |
| 158 | 2 | Reserved zero |
| 160 | 8 | Exact object-key UTF-8 offset and length |
| 168 | 8 | Reserved zero |

The five UTF-8 strings begin exactly at byte 176, are each 1 through 256 bytes, are contiguous without gaps/overlap, and end exactly where descriptors begin. Version 1 requires:

- source kind `national_mrms`;
- domain `conus`;
- product `MergedBaseReflectivityQC_00.50`;
- provider `noaa-mrms-pds.s3.amazonaws.com`; and
- an exact approved object key whose timestamp equals the manifest observation time.

Grid coordinates use a north-west sample-anchor convention at every presentation level. The first latitude/longitude remains the first native sample represented by the level; each overview step is the native `0.01` degree step multiplied by the presentation factor. The final anchors are derived rather than copied from the base-grid endpoint:

```text
lastLongitude = firstLongitude + (width - 1) * longitudeStep
lastLatitude  = firstLatitude  - (height - 1) * latitudeStep
```

This keeps dimensions, step, orientation, and endpoints self-consistent. An overview value still represents the complete native-cell reduction footprint beginning at its anchor; the exact base grid remains the interrogation authority.

Each 72-byte descriptor is:

| Relative offset | Bytes | Field |
|---:|---:|---|
| 0 | 4 | Sequential chunk index |
| 4 | 2 | Chunk X |
| 6 | 2 | Chunk Y |
| 8 | 4 | Interior X |
| 12 | 4 | Interior Y |
| 16 | 2 | Interior width |
| 18 | 2 | Interior height |
| 20 | 4 | Halo X |
| 24 | 4 | Halo Y |
| 28 | 2 | Halo width |
| 30 | 2 | Halo height |
| 32 | 4 | Exact encoded chunk-record length |
| 36 | 32 | Chunk-payload SHA-256 |
| 68 | 4 | Reserved zero |

The validator derives every interior/halo coordinate and size from the level shape, chunk index, 256-cell interior, and one-cell halo. Descriptors cannot independently redefine geometry.

## Chunk record

Magic is `MGCK`; record kind is `2`.

| Offset | Bytes | Field |
|---:|---:|---|
| 0 | 16 | Common magic/version/kind/header/total-length fields |
| 16 | 8 | Source generation |
| 24 | 8 | Measured observation Unix milliseconds |
| 32 | 32 | Compressed source-object SHA-256 |
| 64 | 1 | Source code |
| 65 | 1 | Domain code |
| 66 | 1 | Product code |
| 67 | 1 | Orientation code |
| 68 | 4 | Presentation-level width |
| 72 | 4 | Presentation-level height |
| 76 | 2 | Presentation factor |
| 78 | 2 | Chunk interior size |
| 80 | 32 | Chunk index and interior/halo geometry, matching the descriptor fields through halo height |
| 112 | 1 | Bit depth |
| 113 | 3 | Reserved zero |
| 116 | 4 | Reference value `R` as `f32` bits |
| 120 | 2 | Binary scale `E` |
| 122 | 2 | Decimal scale `D` |
| 124 | 2 | Missing raw code |
| 126 | 2 | No-coverage raw code |
| 128 | 4 | Payload offset, `176` |
| 132 | 4 | Exact payload length |
| 136 | 32 | SHA-256 of payload bytes |
| 168 | 8 | Reserved zero |
| 176 | variable | Row-major halo cells as exact big-endian `u16` raw codes |

The payload length must equal `haloWidth * haloHeight * 2`. The frontend copies a single received chunk into a bounded `Uint16Array`, validates its SHA-256 and all fixed metadata, and then matches generation, observation time, content hash, level shape/factor, and full descriptor against the already validated manifest.

## Numeric truth

Version 1 pins `bitDepth=16`, `R=-9990`, `E=0`, `D=1`, missing raw `9000`, and no-coverage raw `0`. For every other raw code `X`:

```text
dBZ = (R + X * 2^E) / 10^D
```

No codebook derived from observed fixtures participates in validation or decoding. `Smooth`/`Native` rendering and exact point interrogation are later-phase responsibilities; this wire preserves the data required by both without claiming a frame painted.

## Evidence

Rust round-trip/corruption tests, TypeScript cross-language parser tests, and the hidden release/WebView2 diagnostic validate the contract. The committed fixtures under `fixtures/expected/national-phase2/` contain one full manifest and one bounded chunk from the reviewed public sample; large source observations and generated reports remain ignored.
