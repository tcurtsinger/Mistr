# PackedSweep v1 decision record

**Status:** Accepted for Mistr Phase 2

**Decision date:** 2026-07-31

**Applies to:** One normalized Level II sweep transferred from Rust to the Tauri WebView

## Context

A current KTLX reflectivity sweep contains 720 radials and 1,319,040 gates. Serializing its values as JSON would add conversion work, transient strings/arrays, and a weakly typed boundary before WebGL upload. Mistr instead needs one deterministic, bounded byte buffer whose metadata and sections can be validated without importing Rust decoder types into TypeScript.

Tauri 2.11.5 explicitly supports optimized array-buffer responses through `tauri::ipc::Response`; `Vec<u8>` becomes a raw IPC response instead of a JSON numeric array. Mistr uses that public API and does not add a local HTTP server or private WebView hook.

## Decision

`PackedSweep v1` is a little-endian, canonically laid-out byte buffer containing:

1. a fixed 320-byte header;
2. 24-byte radial metadata records;
3. decoded `f32` values;
4. one-byte detailed gate statuses; and
5. compact raw codes stored as `u8` or little-endian `u16` according to the source word size.

The buffer carries a caller generation and stable observation ID. Rust owns encoding. TypeScript owns validation and typed-array views. Bulk gate data never enters React state and never crosses IPC as JSON.

## Byte order and alignment

- Every integer and float is little-endian.
- Magic is the eight ASCII bytes `MSTRSWP1`.
- The byte-order marker is `0x01020304`.
- The header is exactly 320 bytes.
- Every section begins on an eight-byte boundary.
- Padding and reserved bytes are zero.
- Sections use one canonical order: radials, values, statuses, raw codes.
- Total length is the raw-code end rounded up to eight bytes.

## Header layout

| Offset | Size | Field | Rule |
|---:|---:|---|---|
| 0 | 8 | magic | `MSTRSWP1` |
| 8 | 4 | endian marker | `0x01020304` |
| 12 | 2 | schema version | `1` |
| 14 | 2 | header length | `320` |
| 16 | 4 | total length | exact buffer length, at most 32 MiB |
| 20 | 4 | flags | exactly one raw-code-width flag |
| 24 | 2 | product | `1` reflectivity, `2` base velocity |
| 26 | 2 | source kind | `1` Level II Archive II, `2` Phase 2 synthetic benchmark |
| 28 | 4 | reserved | zero |
| 32 | 8 | generation | request generation; stale generations cannot publish |
| 40 | 16 | observation ID | first 16 bytes of normalized SHA-256 |
| 56 | 4 | site ICAO | uppercase ASCII letter/digit |
| 60 | 1 | elevation number | source elevation number |
| 61 | 1 | data word size | `8` or `16` |
| 62 | 1 | status encoding | `1` = Mistr detailed status v1 |
| 63 | 1 | value encoding | `1` = IEEE-754 `f32` |
| 64 | 2 | VCP | source VCP |
| 66 | 2 | reserved | zero |
| 68 | 4 | radial count | `1..=2048` |
| 72 | 4 | gate count | `1..=4096` |
| 76 | 4 | cell count | exactly radial count times gate count; at most 4,194,304 |
| 80 | 4 | gate spacing metres | greater than zero |
| 84 | 4 | first gate centre metres | source geometry |
| 88 | 4 | radar latitude | finite `f32`, `[-90, 90]` |
| 92 | 4 | radar longitude | finite `f32`, `[-180, 180]` |
| 96 | 2 | site altitude metres | signed source value |
| 98 | 2 | tower height metres | unsigned source value |
| 100 | 4 | sweep elevation degrees | finite `f32`, `[0, 90]` |
| 104 | 4 | scale | finite source scale |
| 108 | 4 | offset | finite source offset |
| 112 | 8 | volume start Unix ms | signed `i64` |
| 120 | 8 | volume end Unix ms | not before volume start |
| 128 | 8 | sweep start Unix ms | signed `i64` |
| 136 | 8 | sweep end Unix ms | not before sweep start |
| 144 | 32 | source SHA-256 | raw digest bytes |
| 176 | 32 | normalized SHA-256 | raw digest bytes |
| 208 | 32 | wire SHA-256 | digest described below |
| 240 | 8 | radial section | `u32` offset, `u32` length |
| 248 | 8 | value section | `u32` offset, `u32` length |
| 256 | 8 | status section | `u32` offset, `u32` length |
| 264 | 8 | raw-code section | `u32` offset, `u32` length |
| 272 | 48 | reserved | zero |

Flags:

- bit 0 (`0x00000001`): raw codes are `u8`;
- bit 1 (`0x00000002`): raw codes are little-endian `u16`;
- all other bits are invalid in v1.

## Radial record layout

Each radial record is 24 bytes:

| Offset | Size | Field |
|---:|---:|---|
| 0 | 2 | source azimuth number (`u16`) |
| 2 | 2 | reserved zero |
| 4 | 4 | azimuth degrees (`f32`) |
| 8 | 4 | beam width degrees (`f32`) |
| 12 | 4 | elevation degrees (`f32`) |
| 16 | 8 | collection time Unix ms (`i64`) |

Angles must be finite. Azimuth is in `[0, 360)`, beam width is in `(0, 360]`, and elevation is in `[0, 90]`.

## Gate sections

All gate sections are radial-major and contain exactly `cell_count` entries.

### Values

- IEEE-754 `f32`, four bytes per gate.
- Valid gates contain the normalized physical value.
- Invalid gates contain positive `0.0`.

### Statuses

- `0`: valid;
- `1`: below threshold;
- `2`: range folded.

No other code is valid in v1.

### Raw codes

- Eight-bit products use one byte per gate.
- Sixteen-bit products use little-endian `u16` per gate.
- When scale is nonzero: raw `0` must be below threshold, raw `1` must be range folded, and raw `2+` must be valid with `value = f32((raw - offset) / scale)`.
- When scale is exactly zero, raw codes are direct values and every gate must be valid.

The explicit value section is intentionally retained in v1 even though current scaled moments can be reconstructed from raw codes. It preserves the exact Mistr normalized output, lets TypeScript prove the raw/value relation, and keeps the renderer decision independent. At current reflectivity dimensions the complete transfer remains below the 16 MiB target.

## Integrity hash

The 32-byte wire-hash field cannot hash itself. The digest is SHA-256 over this exact concatenation:

```text
bytes [0, 208) + bytes [240, total_length)
```

This covers every semantic header field, every section descriptor, all reserved/padding bytes, and the complete payload. Rust validates its completed encoding before returning it. TypeScript performs structural validation first, then verifies the same digest before exposing typed-array views.

## Required parser rejection

Both implementations reject, with stable categories where surfaced:

- wrong magic, byte-order marker, version, or header length;
- total length mismatch or a payload above 32 MiB;
- unknown product/source/status/value enum;
- incompatible flags and word size;
- impossible dimensions or integer overflow;
- noncanonical, unaligned, overlapping, truncated, or wrongly sized sections;
- nonzero reserved/padding bytes;
- invalid ICAO, floats, angles, geometry, or time ordering;
- invalid status codes;
- raw/status/value disagreement;
- observation ID disagreement with normalized SHA-256; and
- wire-hash mismatch.

## IPC and backpressure contract

The broker has exactly two global transfer credits. A request consumes one before encoding/transfer and moves it from `in_flight` to `held` only when the current generation may publish. The frontend returns a held credit after parsing/upload ownership is established. A third request is rejected with `credit_exhausted`; it is never queued without a bound.

Starting or cancelling a generation invalidates all prior publication rights, but it does not refund credits for `spawn_blocking` work that is still executing or raw responses already committed to IPC delivery. Old work remains globally charged until it actually completes; an old delivered response remains associated with its generation until TypeScript acknowledges and discards it. Release acknowledgements therefore accept the generation that owns the delivered credit even after a newer generation becomes current. Rust checks generation before work and immediately before committing a raw response. TypeScript discards and acknowledges a response if its local generation changed while `invoke` or parsing was pending. Thus repeated supersession cannot bypass the global two-transfer bound, and stale bytes cannot reach upload.

Control calls remain small JSON. The sweep response is `tauri::ipc::Response<Vec<u8>>`, received by TypeScript as an `ArrayBuffer`.

## Budgets and Phase 2 gate

| Item | Target | Hard ceiling |
|---|---:|---:|
| One packed sweep | at most 16 MiB | 32 MiB rejected |
| Concurrent transfer credits | 2 | 2 |
| Release encoder P95, representative sweep | at most 100 ms | report failure |
| Packaged raw invoke P95, representative sweep | at most 250 ms | 500 ms |
| TypeScript structural/hash/semantic parse P95 | at most 100 ms | 250 ms |

The timing gate is measured in packaged Tauri/WebView2 on the recorded Phase 0 workstation. Browser-only results do not satisfy it.

## Alternatives considered

### JSON arrays

Rejected. It adds text serialization and large JavaScript object/number-array allocation at the hottest process boundary.

### Tauri events

Rejected for complete sweeps. Events are appropriate for small status messages, not a multi-megabyte request/response payload requiring explicit ownership.

### Chunked Tauri channel

Deferred. Tauri recommends channels for streaming data, but one bounded sweep already fits the declared one-response budget. Chunking would add reassembly and cancellation states before measurement demonstrates a need.

### Shared memory or local HTTP

Rejected for the prototype. Both add lifecycle/security machinery and bypass the supported Tauri raw-response path without evidence that it is necessary.

### Raw codes without decoded values

Deferred to a future schema only if renderer evidence justifies it. V1 prioritizes exact cross-language normalization proof while remaining inside the budget.

## Consequences

- A KTLX 720 by 1832 eight-bit sweep is expected to be about 7.6 MiB instead of a JSON-expanded multi-million-number object.
- The parser performs one bounded temporary copy for WebCrypto hashing because SHA-256 excludes its own 32-byte field. That cost is measured explicitly.
- V1 is intentionally strict. Any incompatible layout requires a new schema version rather than heuristic parsing.
- GPU representation, multi-frame compatibility, and CPU retention remain Phase 3/4 decisions; this wire does not pre-decide them.

## Evidence required to retain this decision

- Rust encoder/validator tests and exact golden bytes.
- TypeScript parsing of the Rust golden vector.
- Corrupt/hostile-buffer tests in both languages.
- Generation, cancellation, and credit-exhaustion tests.
- A debug/dev run must report non-passing; only the release build profile can satisfy the packaged timing gate.
- A real raw-byte response in packaged Tauri.
- Payload, timing, and memory evidence in the Phase 2 report.

## Primary API reference

- [Tauri: Calling Rust from the Frontend — Returning Array Buffers](https://v2.tauri.app/develop/calling-rust/#returning-array-buffers)
