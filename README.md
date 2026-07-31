# Mistr

Mistr is a feasibility prototype for a fast, native-data NEXRAD radar renderer. It tests a specific architecture before any production adoption:

1. acquire public NEXRAD Level II volumes;
2. decode and normalize radar sweeps in Rust;
3. transfer a compact binary representation across Tauri IPC; and
4. render resident sweeps in a custom MapLibre WebGL layer.

The target is a Windows desktop storm command center with game-loop-style playback, while MapLibre continues to own the basemap and ordinary overlays.

## Status

**Prototype only.** Phase 0 establishes a reproducible desktop scaffold, fixture provenance, environment capture, and validation harness. Decoder and GPU feasibility must pass explicit gates before this code is considered for production use.

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

## Public-repository rules

- Never commit credentials, environment files, signing certificates, local debug bundles, or downloaded radar archives.
- Keep test-data provenance and checksums in `fixtures/manifest.json`; keep the bytes in `fixtures/cache/`.
- Run `npm run public:check` before every commit.
- Treat output under `diagnostics/`, `artifacts/`, and `benchmark-results/` as private until reviewed.

See [SECURITY.md](SECURITY.md) for reporting and handling security issues.
