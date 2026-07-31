# Phase 2 packed wire and binary IPC report

**Status:** Complete on the primary Windows workstation

**Scope:** One normalized reflectivity sweep encoded in Rust, transferred as raw Tauri IPC bytes, validated in TypeScript, and released through bounded credits. No GPU rendering or playback claim.

## Decision and implementation

Phase 2 accepts [`PackedSweep v1`](../14_PACKED_SWEEP_V1.md): a deterministic little-endian buffer with a fixed 320-byte header and separate radial, `f32` value, detailed-status, and compact raw-code sections.

- Rust validates the Mistr-owned `NormalizedSweep`, encodes the canonical layout, computes the wire hash, and validates its completed output before publication.
- Tauri returns `tauri::ipc::Response<Vec<u8>>`; the frontend requires a real `ArrayBuffer`, not a JSON number array.
- TypeScript validates bounds, canonical offsets, alignment, enums, reserved bytes, dimensions, metadata, SHA-256, radials, and every raw/status/value relationship before exposing zero-copy typed-array views.
- Rust allocates a frontend session epoch; generations are monotonic within it. A replacement WebView session reclaims orphaned delivered credits but leaves prior native work charged until completion. TypeScript blocks a response superseded while IPC or parsing was in progress.
- The broker has exactly two global transfer credits. A third concurrent request fails immediately with `credit_exhausted`; old `spawn_blocking` work and raw responses already committed to IPC delivery stay charged across generation changes until completion or frontend stale-response acknowledgement. Release IDs remain idempotent for the frontend session's full lifetime, so even a long-delayed retry cannot release a newer credit.

The implementation uses Tauri's documented raw array-buffer response API. It does not add HTTP, base64, private WebView hooks, or bulk JSON.

## Cross-language golden vector

The Rust encoder produces the exact committed bytes at `fixtures/expected/phase-2/packed-sweep-v1.bin`. The TypeScript parser consumes that file directly in Vitest and proves its value, status, raw-code, radial, identity, and hash fields.

| Property | Golden value |
|---|---|
| Bytes | 408 |
| Shape | 2 radials by 3 gates |
| Generation | 7 |
| Observation ID | `a92d9790232a3941f429fb80f192bbea` |
| Normalized SHA-256 | `a92d9790232a3941f429fb80f192bbea152b1ac6282756f6b1cf5e78df93d058` |
| Wire SHA-256 | `cbf7165bbc718ed590354d2ca299c11d83488bebc706ef37ef294125164787ed` |

The three gate states are represented explicitly: valid, below threshold, and range folded. Typed gate sections share the received `ArrayBuffer`; the parser does not copy them into JavaScript number arrays. WebCrypto hashing makes one bounded temporary byte copy because the wire digest excludes its own field.

## Real decoded-sweep evidence

The Phase 1 public KTLX fixture was decoded, encoded, and revalidated in the release profile through `mistr-wire --archive`. Bulk output remains ignored under `artifacts/`; exact identity and size are locked by the fixture-conditional Rust integration test.

| Measurement | Result |
|---|---:|
| Compressed input | 7,936,679 bytes |
| Sweep shape | 720 radials by 1,832 gates |
| Cells | 1,319,040 |
| Packed payload | 7,931,840 bytes (7.564 MiB) |
| Decode and normalize | 817.517 ms |
| Encode | 15.123 ms |
| Rust wire validation | 4.149 ms |
| Observation ID | `f3c4ced03212402d921c9880b485db5b` |
| Normalized SHA-256 | `f3c4ced03212402d921c9880b485db5bd95e5c28a1c752b2cae86a9e7bf27bf6` |
| Wire SHA-256 | `8d9999eeb5d6a34a985c1c94a33707446bf6e9a959657c217d1ad4e7a219fc78` |

The decoder duration is reported for transparency but is not a Phase 2 IPC budget. The actual KTLX payload and the full-size packaged benchmark payload have the same dimensions and byte length. The packaged benchmark uses deterministic synthetic gate content so it does not perform disk I/O or decoding inside an IPC timing sample.

## Release encoder benchmark

Twenty iterations of the deterministic 720 by 1,832 sweep were run with the release `mistr-wire` binary on the Phase 0 workstation.

| Stage | Minimum | P50 | P95 | Maximum | Gate |
|---|---:|---:|---:|---:|---|
| Encode | 15.379 ms | 15.623 ms | 16.447 ms | 16.619 ms | **PASS**, P95 <= 100 ms |
| Rust validation | 4.161 ms | 4.240 ms | 4.346 ms | 4.369 ms | Reported, no separate Phase 2 gate |

## Packaged Tauri/WebView2 benchmark

The release executable built by `npm run tauri:build -- --no-bundle` was launched directly. Its diagnostic ran ten sequential raw transfers, a three-request contention case, and a deliberately delayed stale-generation request. This is packaged WebView2 evidence, not a Vite browser simulation.

| Measurement | Result | Gate |
|---|---:|---|
| Response type | `ArrayBuffer` | **PASS**, no bulk JSON |
| Payload | 7.56 MiB | **PASS**, <= 16 MiB target |
| Encoder P95 | 18.1 ms | **PASS**, <= 100 ms |
| Raw invoke P95 | 62.5 ms | **PASS**, <= 250 ms |
| TypeScript parse P95 | 15.9 ms | **PASS**, <= 100 ms |
| Contention | 2 fulfilled, 1 `credit_exhausted` | **PASS**, exactly two credits |
| Delayed old generation | rejected as stale | **PASS**, no stale upload candidate |
| Final ledger | 2 available, 0 held, 0 in flight | **PASS**, all credits returned |

The displayed diagnostic result was `BINARY IPC PASS`. Basemap readiness and radar drawing were not evaluated by this phase; static custom-layer rendering begins in Phase 3.

## Process-memory snapshot

After a clean packaged launch and completion of the benchmark, a process-tree snapshot included `mistr.exe` and its six WebView2 processes:

| Measurement | Result |
|---|---:|
| Process count | 7 |
| Aggregate working set | 490,524,672 bytes (467.801 MiB) |
| Aggregate private bytes | 346,570,752 bytes (330.516 MiB) |

This is a point-in-time whole-application snapshot after transient 7.56 MiB transfers. It includes the WebView2 runtime, map shell, JavaScript heap, and GPU process. It is not a retained-sweep-only measurement and does not prove absence of a leak. Phase 4 must measure stabilized trends and the bounded 20-frame CPU/GPU residency budget.

## Rejection and control coverage

Automated tests cover:

- truncated and over-limit inputs;
- wrong magic, byte order, version, header length, product, source kind, and encodings;
- noncanonical, unaligned, overlapping, wrongly sized, and out-of-bounds sections;
- nonzero reserved or padding bytes;
- invalid dimensions, geometry, timestamps, floats, radials, statuses, and raw/value relations;
- observation-ID and wire-hash disagreement;
- deterministic encoding and the exact committed Rust golden;
- parsing the Rust golden in TypeScript without copying gate sections;
- frontend-session replacement, repeated benchmark generations, monotonic within-session generations, cancellation, stale-response blocking and acknowledgement, cross-generation in-flight/delivery charging, long-delayed idempotent/retryable lease release, and structured errors; and
- two-credit exhaustion and recovery.

The parser's 32 MiB hard limit is exercised before header access in both Rust and TypeScript. The representative 7.564 MiB payload remains below the 16 MiB target.

## Phase gate

- [x] Golden vector is byte-exact in Rust and parsed directly in TypeScript.
- [x] Corrupt and hostile offsets, lengths, encodings, hashes, and gate semantics are rejected.
- [x] Bulk gate data uses raw `ArrayBuffer` IPC, never JSON arrays.
- [x] Rust and TypeScript generation checks prevent old responses from becoming upload candidates.
- [x] Backpressure is globally bounded to two explicit credits across generation changes and recovers to a clean ledger.
- [x] A real decoded KTLX sweep fits the format and retains its normalized identity.
- [x] One-sweep payload, release encoding, packaged transfer, and TypeScript parsing pass their declared Phase 2 budgets on the primary workstation.
- [x] Packaged process memory is recorded without overstating a leak or residency result.

**Decision:** Phase 2 passes on the primary workstation. Proceed to Phase 3 static custom-layer renderer after pull-request defect review is resolved. This report makes no claim yet about geospatial rendering, GPU upload, frame time, playback smoothness, 20-frame residency, or production adoption.
