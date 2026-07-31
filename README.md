# Mistr

Mistr is a feasibility prototype for a fast, native-data NEXRAD radar renderer. It tests a specific architecture before any production adoption:

1. acquire public NEXRAD Level II volumes;
2. decode and normalize radar sweeps in Rust;
3. transfer a compact binary representation across Tauri IPC; and
4. render resident sweeps in a custom MapLibre WebGL layer.

The target is a Windows desktop storm command center with game-loop-style playback, while MapLibre continues to own the basemap and ordinary overlays.

## Status

**Prototype only.** Phase 0 established the reproducible desktop harness. Phase 1 contains a bounded Rust Level II decoder adapter and an independently verified reflectivity reference. Phase 2 adds the strict `PackedSweep v1` binary boundary and proves raw `ArrayBuffer` transfer, cancellation, and bounded backpressure in packaged Tauri. GPU and full playback feasibility must still pass their explicit gates before this code is considered for production use.

Start with [the documentation index](docs/README.md) and [prototype charter](docs/00_PROTOTYPE_CHARTER.md).

## Local development

Prerequisites:

- Windows 11 with the Microsoft Edge WebView2 runtime
- Node.js 24
- Rust stable with the MSVC target
- Microsoft C++ Build Tools required by Tauri

```powershell
npm ci
npm run verify
npm run fixture:download
npm run tauri:dev
```

Build local Windows installers with:

```powershell
npm run tauri:build
```

The unsigned NSIS and MSI outputs are local prototype artifacts under `src-tauri/target/release/bundle/`; they are not committed to the public repository.

Downloaded radar data and generated diagnostics are intentionally ignored by Git. No AWS credentials are used: the Phase 0 fixture is fetched from a public Unidata NEXRAD bucket.

## Phase 1 decoder check

After `npm run fixture:download`, produce the Mistr diagnostic with:

```powershell
cargo run --locked --manifest-path src-tauri\Cargo.toml --bin mistr-decode -- fixtures\cache\KTLX20240520_230512_V06 --product reflectivity --json artifacts\phase-1\rust-reflectivity.json --text artifacts\phase-1\rust-reflectivity.txt
```

The independent Py-ART procedure is documented in [scripts/oracle/README.md](scripts/oracle/README.md). Reviewed, public-data-only reference reports are committed under `fixtures/expected/phase-1/`; arbitrary local diagnostics remain ignored.

## Phase 2 wire checks

Generate the committed cross-language golden vector:

```powershell
cargo run --locked --manifest-path src-tauri\Cargo.toml --bin mistr-wire -- --golden --output fixtures\expected\phase-2\packed-sweep-v1.bin --json fixtures\expected\phase-2\packed-sweep-v1.json
```

After `npm run fixture:download`, encode and validate the real Phase 1 KTLX sweep without committing its bulk output:

```powershell
cargo run --release --locked --manifest-path src-tauri\Cargo.toml --bin mistr-wire -- --archive fixtures\cache\KTLX20240520_230512_V06 --product reflectivity --output artifacts\phase-2\ktlx-packed-sweep-v1.bin --json artifacts\phase-2\ktlx-wire-report.json
```

The accepted byte layout is documented in [PackedSweep v1](docs/14_PACKED_SWEEP_V1.md), and the packaged-runtime evidence is in the [Phase 2 report](docs/phase-reports/PHASE_2_PACKED_WIRE_AND_IPC.md).

## Public-repository rules

- Never commit credentials, environment files, signing certificates, local debug bundles, or downloaded radar archives.
- Keep test-data provenance and checksums in `fixtures/manifest.json`; keep the bytes in `fixtures/cache/`.
- Run `npm run public:check` before every commit.
- Treat output under `diagnostics/`, `artifacts/`, and `benchmark-results/` as private until reviewed.

See [SECURITY.md](SECURITY.md) for reporting and handling security issues.
