# Phase 0 baseline and harness report

**Status:** Complete on the primary Windows workstation; cross-hardware acceptance remains deferred
**Scope:** Reproducibility and safety infrastructure; no decoder or GPU radar claim

## Reproducible inputs

- Application dependencies are exactly pinned in `package.json` and `package-lock.json`.
- Rust dependencies are pinned by `src-tauri/Cargo.lock`.
- `fixtures/manifest.json` records a fixed public Level II object, byte length, SHA-256 digest, site, scan time, and source URL.
- Downloaded fixture bytes remain outside Git under `fixtures/cache/`.

## Primary development-machine snapshot

The first Phase 0 run used:

| Component | Version |
|---|---|
| Windows | NT 10.0.26200.0 |
| PowerShell | 5.1.26100.8875 |
| Node.js | 24.11.0 |
| npm | 11.6.1 |
| Rust | rustc 1.96.0 |
| Cargo | 1.96.0 |
| WebView2 | 150.0.4078.105 |
| Primary GPU | NVIDIA GeForce RTX 4080, driver 32.0.16.1074 |
| Secondary GPU | AMD Radeon Graphics, driver 32.0.21043.5001 |

Machine-specific captures are generated with `npm run env:capture` and intentionally ignored by Git.

## Repeatable procedure

```powershell
git clone https://github.com/tcurtsinger/Mistr.git
cd Mistr
npm ci
npm run fixture:download
npm run verify
npm run env:capture
npm run tauri:build -- --no-bundle
```

Launch the produced executable from `src-tauri/target/release/mistr.exe`. A valid Phase 0 launch displays the map chassis, reports `SHELL TAURI`, and labels radar as `NOT CONNECTED` rather than implying radar is operational. `npm run tauri:build` also produces unsigned local NSIS and MSI installers; the build outputs stay outside Git.

The primary-workstation run built both installer formats successfully and the release executable remained running through the packaged smoke window. Browser visual verification also confirmed the dark basemap reached `BASEMAP READY` with no console errors; the only observed style warning was an upstream missing `circle-11` sprite in the public OpenFreeMap style.

## Existing-path comparison

This repository does not copy or publish private machine traces from GustAVO. The comparison procedure is defined in [the test plan](../05_TEST_AND_VALIDATION_PLAN.md) and [integration plan](../10_INTEGRATION_AND_ROLLBACK.md). Before Phase 4 performance claims are made, collect the same 20-frame stationary, pan/zoom, scale-handoff, rapid-site-change, and provider-timeout scenarios from both applications on the same machine.

## Phase gate

Phase 0 is complete only when all of the following are recorded in the phase commit or pull request:

- [x] `npm ci` succeeds from a clean dependency state.
- [x] The fixture downloads and its SHA-256 checksum verifies.
- [x] TypeScript tests and production build succeed.
- [x] Rust/Tauri compilation succeeds with the lockfile.
- [x] The production Tauri executable launches in WebView2.
- [x] Both unsigned local Windows installer formats build successfully.
- [x] The public-repository check finds no forbidden artifacts or secret patterns.
- [ ] A second Windows hardware profile is captured before performance acceptance.

The second-machine item is not a blocker for beginning Phase 1, but it is a blocker for accepting the overall renderer prototype.
