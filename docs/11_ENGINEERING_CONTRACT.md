# Engineering Contract

## 1. Repository intent

Mistr is the product repository. Its selected-site Windows Alpha is implemented; historical prototype documents remain engineering evidence rather than authority to copy GustAVO behavior.

National implementation proceeds one evidence-gated phase at a time. It must not recreate GustAVO's automatic handoff, dual timelines, MapLibre radar-tile engine, or directory-scanned network cache.

## 2. Planned stack

Initial compatibility target:

- Windows desktop.
- Tauri 2.
- Rust stable pinned by `rust-toolchain.toml`.
- Tokio and `reqwest` for bounded acquisition.
- Candidate Rust NEXRAD decoder pinned to an exact version/revision behind an adapter.
- React and TypeScript for the diagnostic shell.
- Vite.
- MapLibre GL JS pinned to the version used for the prototype evidence.
- Vitest for deterministic TypeScript tests.
- Rust unit/property/fuzz tests as appropriate.
- Playwright/browser automation for portable UI tests, supplemented by mandatory packaged Windows tests.

Do not automatically choose the newest versions at implementation time. Revalidate, then pin the tested set.

## 3. Proposed source layout

```text
Mistr/
  docs\
  fixtures\
    manifests\
    expected\
    scenarios\
  scripts\
  src\
    app\
    diagnostics\
    packed-sweep\
    packed-grid\
    playback\
    radar-session\
      RadarSessionCoordinator.ts
      SiteLevel2Session.ts
    radar-resources\
    raw-radar-layer\
  src-tauri\
    src\
      acquisition\
      cache\
      chunk_assembly\
      decoder\
      diagnostics\
      level2\
      level3\
      normalization\
      mrms.rs
      national_phase2.rs
      packed_grid.rs
      packed_sweep\
  tests\
    browser\
    packaged\
    performance\
```

Large source fixtures may live in approved external/LFS storage, but their manifests, hashes, expected samples, and scripted scenarios stay in the repository.

## 4. Current product and active-phase UI

Mistr's normal UI follows `PRODUCT.md` and `DESIGN.md`; diagnostics remain hidden behind packaged APIs rather than becoming a second weather dashboard.

National Phases 1 and 2 changed no visible interface. Phase 3 owns the explicit `National`/`Site` source panel because it also delivers the complete static National session, numeric renderer, exact interrogation, and paint-truth path. Selecting Site reveals the existing searchable station list; supporting/accessibility copy identifies National as CONUS. Keyboard, focus-return, compact-layout, painted-truth, and one-panel behavior remain mandatory.

Phase 3 exposes exactly one National timeline observation and disabled movement controls. It is forbidden from adding polling, history, multi-frame residency, playback, scrubbing, or quality locking assigned to Phase 4. Hidden `window.__MISTR_NATIONAL_PHASE2__` and `window.__MISTR_NATIONAL_PHASE3__` evidence APIs do not become normal controls.

Required surfaces:

### Map

- MapLibre basemap.
- Raw selected-site radar custom layer.
- Separate National numeric-grid custom layer when National is painted.
- Optional tiled comparison/fallback layer.
- Diagnostic gate markers and radar range boundary.

### Controls

- Radar site selector.
- Product selector with explicit `Reflectivity`, `Base velocity`, and `Storm-relative velocity (N0S)` labels where implemented.
- Elevation selector only after multi-elevation scope is enabled.
- Live/fixture mode.
- Play/pause, step, scrub, newest.
- Hard-cut/crossfade control only if crossfade phase is authorized.
- Raw/tiled/side-by-side comparison mode.
- Fault-scenario selector in diagnostic builds.

### Status

- Measured time and age.
- Actual source and fallback status.
- Acquisition/decode/upload/residency state.
- Last-painted observation.
- Resident-frame count and memory.
- Latency and frame timing.
- Context epoch and recovery state.

### Evidence actions

- Capture screenshot.
- Export debug bundle.
- Run deterministic scenario.
- Copy bounded diagnostic summary.

Accessibility requirements still apply: keyboard operation, meaningful names, visible focus, and non-color-only state.

## 5. Planned commands

Exact names may change before implementation, but the repository should offer one-command paths equivalent to:

```text
npm run verify                 # format, lint, types, frontend tests, Rust tests/checks
npm run fixtures:verify        # manifest/hash/oracle checks
npm run test:scenarios         # deterministic state/fault scenarios
npm run test:browser           # browser custom-layer/UI coverage
npm run test:packaged          # real Tauri/WebView2 packaged smoke/scenarios
npm run benchmark:renderer     # fixed fixture/camera performance run
npm run test:national:phase2:packaged # live NOAA MRMS decode/wire/backpressure diagnostic
npm run test:national:phase3:packaged # static National renderer/handoff/context evidence
npm run benchmark:latency      # summarize captured live latency samples
npm run debug:bundle           # create bounded diagnostics archive
npm run tauri build            # installable/release-like artifact
```

No “verify” command may omit Rust or silently skip packaged tests while reporting a complete pass. Fast and full commands can be separate, but their scope must be explicit.

## 6. Quality policy

### Rust

- `cargo fmt --check`.
- `cargo clippy` with warnings denied for project code.
- Tests under locked dependencies.
- Dependency advisory/license policy with documented exceptions.
- No production panic/unwrap on untrusted radar data paths without a proven invariant.
- Explicit decompressed/allocation limits.

### TypeScript

- Strict type checking.
- Lint with zero warnings for project code.
- No `any` at wire/resource boundaries.
- Exhaustive handling of state/error enums.
- No large typed arrays stored in React state.

### Shaders

- Sources versioned as first-class code.
- Compile/link failures tested and logged.
- CPU reference calculations for palette and coordinate behavior.
- Shader changes require visual and performance regression runs.

## 7. Dependency policy

- Pin exact versions in lockfiles.
- Pin niche decoder revisions explicitly.
- Record dependency purpose and replacement boundary.
- Prefer public stable APIs over internal MapLibre/WebView hooks.
- No dependency is accepted only because another radar app uses it.
- Upgrade one risky boundary at a time and run the full fixture/package suite.
- A decoder update cannot change expected values without a reviewed explanation.

## 8. Build profiles

### Development fixture

- Deterministic local fixtures.
- Debug diagnostics enabled.
- Same wire and renderer as packaged.

### Development live

- Public AWS sources.
- Detailed bounded timing.
- No browser-only acquisition fallback.

### Packaged diagnostic

- Release-like Tauri/WebView2 build.
- Diagnostic overlay, fault controls, and debug bundle enabled.
- Primary feasibility evidence build.

### Release candidate prototype

- No destructive fault controls exposed by default.
- Still not a GustAVO replacement.
- Used for final observation/latency/long-session evidence.

## 9. CI and local hardware responsibilities

CI should run:

- Formatting, lint, types.
- Rust/TypeScript unit and fixture tests.
- Wire golden vectors.
- Deterministic state/fault scenarios that do not require real live sources.
- Browser-level rendering tests when stable in the CI GPU environment.
- Dependency and license checks.

Local/release hardware must run:

- Packaged WebView2 scenarios.
- 4K performance traces.
- GPU memory/long-session tests.
- Context-loss and display lifecycle tests.
- Live latency collection.

CI unavailability for real GPU evidence is recorded as a limitation, not treated as a pass.

## 10. Artifact retention

Each phase result archives:

- Commit/build ID.
- Version manifest.
- Test summaries.
- Debug/performance traces.
- Screenshots.
- Memory/latency tables.
- Fixture/scenario IDs.
- Decision records.

Artifacts must be named deterministically enough to compare runs and bounded enough for AI review.

## 11. Change isolation

- One phase/decision per branch where practical.
- Preserve dirty worktree baselines.
- Do not sweep unrelated GustAVO changes into Mistr integration.
- Add a regression test before or with every demonstrated defect fix.
- Keep architecture, decoder, renderer, and UI changes separable in review.
- User controls when any Mistr work is integrated or merged into GustAVO.
- National phases use separate `codex/` branches and Ready-for-review pull requests; only the owner merges.
- Phase 1 ended at the behavior-preserving coordinator and merged through PR #15. Phase 2 ended after strict MRMS acquisition/decoding, value-aware levels, `PackedGrid v1`, shared-credit transfer, and the non-shipping 30-frame diagnostic, then merged through PR #16.
- Phase 3 ends after one complete current National paint, overview/detail working sets, exact point interrogation, explicit source/recenter UI, atomic Site/National handoff, real context recovery, synchronized documentation, full regression evidence, and PR review.
- Phase 3 does not begin National polling, predecessor backfill, history residency, playback, scrubbing, or playback-quality locking assigned to Phase 4.
- The pre-existing `assets/radar.svg` and `assets/recenter.svg` files remain outside National work unless separately authorized.
- Downloaded MRMS observations, arbitrary provider responses, local oracle environments, packaged reports, screenshots, and binaries remain ignored and must never be staged.
