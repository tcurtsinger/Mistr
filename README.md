# Mistr

Mistr is a feasibility prototype for a fast, native-data NEXRAD radar renderer. It tests a specific architecture before any production adoption:

1. acquire public NEXRAD Level II volumes;
2. decode and normalize radar sweeps in Rust;
3. transfer a compact binary representation across Tauri IPC; and
4. render resident sweeps in a custom MapLibre WebGL layer.

The target is a Windows desktop storm command center with game-loop-style playback, while MapLibre continues to own the basemap and ordinary overlays.

## Status

**Prototype only.** Phases 0 through 5 are complete on the primary Windows workstation. The build retains the Phase 4 proof of 20 GPU-resident real observations and adds bounded, cancellable acquisition from the public real-time Level II chunk bucket. A live frame is exposed only after the lowest sweep has a verified physical boundary, and the packaged app replaces visible radar only after an authoritative GPU receipt. Velocity parity, context recovery, multi-machine evidence, and GustAVO integration still have explicit later gates.

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

Downloaded radar data and generated diagnostics are intentionally ignored by Git. No AWS credentials are used: the fixtures are fetched from a public Unidata NEXRAD bucket.

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

## Phase 4 packaged playback gate

After downloading the 20 public fixtures, run the real release/WebView2 4K gate:

```powershell
npm run test:phase4:packaged
```

The runner performs two 1,000-transition interaction scenarios and five atomic loop replacements per scenario. Its ignored evidence is written under `artifacts/phase-4/`. The contract and results are documented in the [resident playback decision](docs/16_RESIDENT_PLAYBACK_DECISION.md) and [Phase 4 report](docs/phase-reports/PHASE_4_RESIDENT_PLAYBACK.md).

## Phase 5 live gate

Run the release/WebView2 live acquisition, site-supersession, and 4K GPU-paint gate with:

```powershell
npm run test:phase5:packaged
```

Run a source-only observation probe without the WebView with:

```powershell
cargo run --release --locked --manifest-path src-tauri\Cargo.toml --bin mistr-live-probe -- --site KTLX --fresh --timeout-seconds 900 --output artifacts\phase-5\live\KTLX.json
```

The probe uses anonymous fixed-host HTTPS only. Raw chunks, executables, provider responses, and packaged screenshots remain ignored; the reviewed latency dataset contains only bounded public metadata and hashes. See the [real-time decision](docs/17_REALTIME_FRESHNESS_AND_FALLBACK_DECISION.md) and [Phase 5 report](docs/phase-reports/PHASE_5_REALTIME_CHUNKS.md).

## Public-repository rules

- Never commit credentials, environment files, signing certificates, local debug bundles, or downloaded radar archives.
- Keep test-data provenance and checksums in `fixtures/manifest.json`; keep the bytes in `fixtures/cache/`.
- Run `npm run public:check` before every commit.
- Treat output under `diagnostics/`, `artifacts/`, and `benchmark-results/` as private until reviewed.

See [SECURITY.md](SECURITY.md) for reporting and handling security issues.
