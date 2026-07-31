# Decoder decision record

**Decision:** Accept for the bounded Mistr prototype

**Decision date:** 2026-07-31

**Applies to:** Current-format NEXRAD Level II Archive II base reflectivity

## Choice

Mistr uses the `nexrad` Rust crate family behind a Mistr-owned adapter:

| Crate | Exact version | Published source revision | License | Role |
|---|---:|---|---|---|
| `nexrad-data` | `1.0.0-rc.7` | `4b4e5ed7cbb6c6d7c0997e86fc725c301c8fd40d` | MIT | Archive II framing, record decompression, scan assembly |
| `nexrad-decode` | `1.0.0-rc.3` | `de6e16d1977ca118738d917c130bf13413da7626` | MIT | Level II message decoding, transitively selected by `nexrad-data` |
| `nexrad-model` | `1.0.0-rc.2` | `3d9ef8d7d1ecaa24795c53300fbdd5825852f1aa` | MIT | Temporary decoded scan model inside the adapter |

The versions are exact requirements in `src-tauri/Cargo.toml` where direct and are fully locked in `src-tauri/Cargo.lock`. AWS features are disabled: Mistr does not pull in the crate's HTTP/AWS client path just to decode local bytes. The relevant normal dependency tree is small and uses `bzip2`, `flate2`, `chrono`, `zerocopy`, `uom`, `sha2`, `thiserror`, and their low-level support crates. It does not add a Python runtime or native radar service to the shipped desktop application.

The independent oracle is `arm_pyart==2.2.5`. Py-ART is a development-only reference and is never imported, bundled, or invoked by the application.

## Why this candidate

1. It directly understands Archive II volumes and current Message 31 moment data.
2. Its model exposes raw gate codes, word size, scale, offset, first-gate range, gate spacing, azimuth, elevation, timestamps, site location, and VCP. Those are the fields Mistr must validate before rendering.
3. The implementation is Rust-native and fits the existing Tauri process without a Python sidecar, local HTTP server, or C++/Qt rewrite.
4. Exact versions are small enough for Codex and Claude to inspect at source level when troubleshooting.
5. The KTLX current-format fixture agrees with Py-ART for every sorted azimuth and all 1,319,040 normalized reflectivity cells, not merely for a screenshot.

This is a prototype acceptance, not an unconditional production endorsement. The crates are release candidates. Promotion into GustAVO requires keeping the adapter boundary, fixture regression hashes, dependency pins, and failure limits.

## Ownership boundary

All third-party radar types are confined to `src-tauri/src/radar/decoder.rs`, which is a private module. Its public function returns only Mistr-owned structures from `src-tauri/src/radar/mod.rs`:

- `DecodeOutput`
- `DecodeEvidence`
- `NormalizedSweep`
- `RadarSite`
- `RadialMetadata`
- `GateStatus`
- `DecodeError`

Renderer and IPC phases must not import `nexrad-data`, `nexrad-decode`, or `nexrad-model`. If the candidate later fails, replacing the adapter does not force a renderer rewrite.

## Normalization rules

- Select the earliest sweep among those at the lowest finite median elevation that contain the requested moment.
- Include only radials that actually contain that moment.
- Sort radials by azimuth, source azimuth number, then collection timestamp.
- Require identical gate count, first-gate center, gate spacing, word size, scale, and offset across every selected radial. Do not silently pad, truncate, or inherit geometry from the first ray.
- For scaled moments, decode raw code `0` as below threshold, raw code `1` as range folded, and other codes with `(raw - offset) / scale`. A literal zero scale uses the upstream format's direct raw-value semantics.
- Store invalid values as `0.0` plus a separate Mistr `GateStatus`; never encode missing data as an ambiguous color or NaN.
- Preserve source hash, radar/site geometry, VCP, volume/sweep times, per-radial angles/times, raw codes, decoded values, and validity.

## Safety wrapper

The upstream API is designed for trusted radar archives and contains unbounded `read_to_end` decompression paths. It can also index beyond a short header before returning an error. Mistr therefore does not pass arbitrary bytes directly to it.

Before third-party decoding, the adapter:

1. caps compressed input at 64 MiB;
2. performs bounded outer-gzip expansion capped at 256 MiB;
3. verifies the Archive II header length;
4. walks modern LDM record framing itself with checked arithmetic;
5. caps record count at 8,192 and each compressed record at 16 MiB;
6. pre-decompresses each bzip2 record into a sink, capped at 16 MiB per record and 512 MiB total;
7. contains any third-party panic with `catch_unwind` and converts it to a Mistr error;
8. caps normalized output at 2,048 radials, 4,096 gates per radial, and 4,194,304 cells; and
9. rejects non-finite/out-of-range geometry and inconsistent per-radial layouts.

The preflight intentionally decompresses records once for bounds validation and the candidate decoder decompresses them again for parsing. That duplicate CPU work is acceptable for correctness Phase 1. A future performance phase may replace it only if the same hard bounds remain demonstrable.

## Alternatives considered

### Call `nexrad-decode` directly

This could avoid some behavior in `nexrad-data::volume::File`, but Mistr would then own scan/VCP/site assembly immediately. The adapter already contains the risky framing and decompression behavior while retaining the tested assembly path, so direct message assembly is not justified yet.

### Ship Py-ART or xradar

These are valuable independent scientific references but would add Python, NumPy/xarray, packaging, and cross-process operational complexity to a Windows desktop app. They remain oracle tools, not runtime dependencies.

### Write a decoder from the ICD immediately

A first-party decoder would maximize control but substantially expand the amount of binary-protocol code that AI agents must maintain. The adapter preserves that option if real fixture disagreements appear; Phase 1 evidence does not justify paying that cost now.

## Explicitly unsupported or unproven

- Legacy CTM/pre-LDM framing is rejected with a named unsupported-variant error.
- Real-time `unidata-nexrad-level2-chunks` objects must be assembled into a valid volume before this adapter; chunk assembly is not Phase 1.
- Level III products, including raw `N0S` storm-relative velocity, are outside this Level II adapter.
- Level II base velocity can be normalized by the same code path but has not passed an independent Phase 1 oracle comparison and must not be labeled storm-relative velocity.
- Message variants absent from the current fixture are not claimed as supported merely because the upstream crate has code for them.
- Corrupt but internally parseable scientific values beyond the validated geometry rules remain a corpus-expansion concern.

The unsupported list is a scope boundary, not evidence that the overall raw-radar approach is infeasible.
