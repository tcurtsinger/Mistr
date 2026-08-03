# Mistr

Mistr is an installable desktop radar application for inspecting live storms without tile-bound playback or ambiguous data state. It acquires public NEXRAD data, decodes and normalizes radar sweeps in Rust, transfers a compact binary representation across Tauri IPC, and renders GPU-resident observations in a custom MapLibre WebGL layer.

The map remains fully interactive while playback behaves like a bounded game loop: recent observations already resident on the GPU can advance without requesting or repainting hundreds of radar tiles.

## Status

**Alpha selected-site radar.** The normal interface is radar-first: choose a NEXRAD site, inspect reflectivity, play or scrub its bounded recent-observation loop, and see the measured time and numeric age of the frame that actually painted. Windows is the Alpha release platform; the shared Tauri application remains compatible with a later macOS build.

The underlying engine has passed the historical Phase 0 through 6 feasibility gates on the primary Windows workstation, including 20-frame GPU-resident playback, bounded live Level II acquisition, strict Level III `N0S` decoding, and visible-first WebGL context recovery. Those phase records remain as engineering evidence rather than product UI.

Every launch paints the newest bundled pinned archive observation as a safe bridge without first decoding the entire diagnostic loop, then automatically acquires current live radar for the stored site or KTLX on a fresh profile. The single searchable picker exposes the 155 operational WSR-88D sites qualified against the fixed live provider, including Alaska, Hawaii, Guam, and Puerto Rico. Test, TDWR, decommissioned, and provider-absent identifiers are excluded. After current live radar paints, Mistr loads up to 19 safe preceding volumes into a chronological GPU-resident loop, then requests exact-next future volumes. Retained frames are reused, only the added frame is uploaded, and the oldest is evicted at the bound. See [Bounded Rolling Live History](docs/21_BOUNDED_ROLLING_LIVE_HISTORY.md) for the exact ownership contract, [Alpha UI and Live-Site Hardening](docs/23_ALPHA_UI_AND_SITE_HARDENING.md) for the catalog decisions, and [Visible-First Startup and Recent Backfill](docs/24_VISIBLE_FIRST_STARTUP_AND_RECENT_BACKFILL.md) for the startup correction.

Reflectivity keeps the operational NOAA/NWS RGB thresholds while using a display-only weak-return visibility curve: non-positive dBZ is transparent, positive returns grow through a quiet near-linear fade to full opacity at 20 dBZ, and native measured dBZ remains available to inspection. The existing map graph keeps matte water, local streets, buildings, railways, water names, and secondary places below radar; only major routes, boundaries, and important labels remain above it. Water polygons are intentionally not outlined because their vector-tile seams change with zoom. Motorway, trunk, and primary segments share a continuous style instead of swapping visibility and weight at hard zoom boundaries. This preserves legibility without globally lowering radar opacity, adding another provider, or claiming meteorological clutter classification. See [Radar Rendering Quality](docs/25_RADAR_RENDERING_QUALITY.md).

Start with the [product definition](PRODUCT.md), [design system](DESIGN.md), [current Alpha state](docs/20_ALPHA_CURRENT_STATE.md), and [documentation index](docs/README.md).

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

The unsigned NSIS and MSI outputs are local build artifacts under `src-tauri/target/release/bundle/`; they are not committed to the public repository.

Alpha release-readiness checks are intentionally separate from the historical engine gates:

```powershell
npm run test:alpha:readiness
npm run test:alpha:soak
npm run test:alpha:installers
npm run test:alpha:clean-machine
npm run test:alpha:sleep-wake
```

The sleep/wake check waits for a real user-triggered Windows sleep cycle and reconnects its diagnostic channel after wake. The clean-machine command requires Windows Sandbox or an equivalent clean Windows 11 environment. See [Alpha Release Readiness](docs/22_ALPHA_RELEASE_READINESS.md) for the exact evidence and remaining unsigned-package decision.

Downloaded radar data and generated diagnostics are intentionally ignored by Git. No AWS credentials are used: the fixtures are fetched from a public Unidata NEXRAD bucket.

## Engineering validation

The numbered phase checks below preserve the reproducible evidence used to qualify the radar engine. They are not user-facing product modes.

### Phase 1 decoder check

After `npm run fixture:download`, produce the Mistr diagnostic with:

```powershell
cargo run --locked --manifest-path src-tauri\Cargo.toml --bin mistr-decode -- fixtures\cache\KTLX20240520_230512_V06 --product reflectivity --json artifacts\phase-1\rust-reflectivity.json --text artifacts\phase-1\rust-reflectivity.txt
```

The independent Py-ART procedure is documented in [scripts/oracle/README.md](scripts/oracle/README.md). Reviewed, public-data-only reference reports are committed under `fixtures/expected/phase-1/`; arbitrary local diagnostics remain ignored.

### Phase 2 wire checks

Generate the committed cross-language golden vector:

```powershell
cargo run --locked --manifest-path src-tauri\Cargo.toml --bin mistr-wire -- --golden --output fixtures\expected\phase-2\packed-sweep-v1.bin --json fixtures\expected\phase-2\packed-sweep-v1.json
```

After `npm run fixture:download`, encode and validate the real Phase 1 KTLX sweep without committing its bulk output:

```powershell
cargo run --release --locked --manifest-path src-tauri\Cargo.toml --bin mistr-wire -- --archive fixtures\cache\KTLX20240520_230512_V06 --product reflectivity --output artifacts\phase-2\ktlx-packed-sweep-v1.bin --json artifacts\phase-2\ktlx-wire-report.json
```

The accepted byte layout is documented in [PackedSweep v1](docs/14_PACKED_SWEEP_V1.md), and the packaged-runtime evidence is in the [Phase 2 report](docs/phase-reports/PHASE_2_PACKED_WIRE_AND_IPC.md).

### Phase 4 packaged playback gate

After downloading the 20 public fixtures, run the real release/WebView2 4K gate:

```powershell
npm run test:phase4:packaged
```

The runner performs two 1,000-transition interaction scenarios and five atomic loop replacements per scenario. It also performs 19 incremental history updates, forced bounded eviction, oldest/newest scrubbing, and a real WebGL context reset before each hot-path workload. Before stabilized heap sampling, it waits for MapLibre's public `idle` signal and then performs the existing two explicit garbage collections; thresholds are unchanged. Its ignored evidence is written under `artifacts/phase-4/`. The contract and results are documented in the [resident playback decision](docs/16_RESIDENT_PLAYBACK_DECISION.md), [rolling-history decision](docs/21_BOUNDED_ROLLING_LIVE_HISTORY.md), and [Phase 4 report](docs/phase-reports/PHASE_4_RESIDENT_PLAYBACK.md).

### Phase 5 live gate

Run the release/WebView2 live acquisition, site-supersession, exact-next two-observation history, direct-scrub, and 4K GPU-paint gate with:

```powershell
npm run test:phase5:packaged
```

Run a source-only observation probe without the WebView with:

```powershell
cargo run --release --locked --manifest-path src-tauri\Cargo.toml --bin mistr-live-probe -- --site KTLX --fresh --timeout-seconds 900 --output artifacts\phase-5\live\KTLX.json
```

The probe uses anonymous fixed-host HTTPS only. Raw chunks, executables, provider responses, and packaged screenshots remain ignored; the reviewed latency dataset contains only bounded public metadata and hashes. See the [real-time decision](docs/17_REALTIME_FRESHNESS_AND_FALLBACK_DECISION.md) and [Phase 5 report](docs/phase-reports/PHASE_5_REALTIME_CHUNKS.md).

### Phase 6 N0S and recovery gate

Download/verify the fixed public Level III and IEM references, then run two packaged WebView2 cold-start passes:

```powershell
npm run fixture:verify:phase6
npm run test:phase6:packaged
```

This exercises real WebGL context loss/restoration, visible-first then loop rehydration, minimize/restore, offline resident playback, DPR 1/2 rendering, explicit N0S product labels, and restart. Detailed runtime artifacts remain ignored. See the [Phase 6 decision](docs/18_LEVEL3_N0S_AND_CONTEXT_RECOVERY_DECISION.md) and [Phase 6 report](docs/phase-reports/PHASE_6_N0S_AND_CONTEXT_RECOVERY.md).

## Public-repository rules

- Never commit credentials, environment files, signing certificates, local debug bundles, or downloaded radar archives.
- Keep test-data provenance and checksums in `fixtures/manifest.json`; keep the bytes in `fixtures/cache/`.
- Run `npm run public:check` before every commit.
- Treat output under `diagnostics/`, `artifacts/`, and `benchmark-results/` as private until reviewed.

See [SECURITY.md](SECURITY.md) for reporting and handling security issues.
