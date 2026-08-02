# Alpha Release Readiness

**Decision date:** 2026-08-02

## Decision

The rolling selected-site radar engine is complete enough to enter an Alpha release-readiness phase. This phase adds no weather capability. It proves that the existing product can be installed, operated for an extended live session, used with keyboard and Windows accessibility modes, and recovered across a real workstation lifecycle without weakening displayed-radar truth.

Passing an individual automated gate is not a release approval. Public Alpha remains blocked until every manual item is either demonstrated or explicitly accepted by the owner with its limitation stated.

## Operational soak gate

The packaged WebView2 product session must:

- supersede a real site request without naming that site in the top context before it paints;
- acquire at least four successive KTLX observations through the product's background polling loop;
- retain every observation chronologically with exact-next provider-volume progression;
- upload exactly one GPU frame per accepted live observation;
- preserve bounded GPU residency and truthful `BUILDING n/20` UI;
- directly scrub oldest and newest resident observations; and
- survive a real WebGL context reset with the same live history and a matching visible paint receipt.

The ignored evidence is written by `npm run test:alpha:soak`. Provider payloads and screenshots are never committed.

**Result:** Passed in the packaged product with exact-next KTLX volumes 569, 570, 571, and 572. All four observations became chronological residents with four incremental uploads, 10,620,720 GPU bytes, working oldest/newest scrubs, and preserved membership plus visible newest paint after a real context reset. The evidence validator uses chronological history truth for scrub order because context rehydration may reorder the renderer's internal resource map without changing playback order.

## Installed-product gate

Both local Windows bundle formats must build and pass install, first-launch, GPU-paint, and uninstall checks. The installed application must establish the pinned 20-frame KTLX archive loop without depending on the repository working directory or the developer's ignored fixture cache.

The public Alpha package version is `0.1.0`. Local upgrade evidence installs the prior `0.0.1` bundle, applies the `0.1.0` bundle, proves the new installed radar, and then uninstalls it for both NSIS and MSI.

The release bundle therefore includes only the 20 hash-pinned Phase 4 archives as named Tauri resources. The source files remain ignored public-data downloads; the reviewed manifest, exact resource allowlist, sizes, and hashes remain the provenance boundary. Runtime resolution prefers an explicit diagnostic override, then a development checkout, then Tauri's packaged resource directory.

`npm run test:alpha:installers` validates local NSIS and MSI mechanics plus the installed first-launch radar. `npm run test:alpha:clean-machine` performs the dependency-isolated install/launch/uninstall pass when Windows Sandbox is enabled. A local install pass is not mislabeled as clean-machine evidence.

**Result:** Passed for the final `0.1.0` NSIS and MSI bundles. Both upgraded from local `0.0.1` baselines, established the 20-frame KTLX archive from installed resources, painted it on the GPU, and uninstalled cleanly. The same final bundles passed independent NSIS/MSI install, launch, and uninstall in a fresh Windows 11 Enterprise Sandbox.

## Interface and accessibility gate

`npm run test:alpha:readiness` exercises the real packaged surface at 3840x2160, 1100x700, and the supported 1024x640 minimum. It rejects:

- document overflow or clipped persistent instruments;
- controls below the WCAG 24-pixel target minimum;
- unnamed interactive accessibility-tree nodes or an unfocusable map;
- lost focus when opening or dismissing temporary panels;
- broken keyboard timeline movement or stale accessible slider value;
- panel-induced playback-bar motion;
- absent forced-colors keyboard focus;
- ignored reduced-motion preference;
- sub-AA instructional text contrast; and
- prototype or diagnostic terminology in the normal interface.

The release-readiness hardening moves focus into an opened panel, returns focus to its originating trigger on selection or Escape, removes a false dialog claim, adds Windows forced-colors focus treatment, raises the inactive inspection instruction above AA contrast, and distinguishes `RETRYING KTLX` from `KTLX UNAVAILABLE`.

**Result:** Passed at all three viewports. The accessibility tree contained no unnamed controls, focus moved and returned correctly, keyboard timeline movement updated its accessible value, the playback bar remained fixed when panels opened, and inactive instructional contrast measured 5.09:1.

## Repository boundary

The public scanner now covers the previously deferred PuTTY private-key form, temporary `ASIA` AWS access-key IDs, and AWS session-token fields. Regression probes generate synthetic secrets only during the test and remove them afterward; secret-like material is not committed.

Bundled radar archives remain ignored build inputs and generated installers remain ignored outputs. No credentials, signing material, provider responses, reports, or screenshots enter Git.

**Result:** Passed. The final scanner evaluated 202 candidate public files, and all generated secret-regression probes removed themselves after execution.

## Packaged performance stability

The 3840x2160 Phase 4 gate retains its 5 MiB stabilized JavaScript-heap-growth threshold, two 1,000-transition workloads, real rolling-history mutation, direct scrubbing, real context reset, and zero-hot-path-work requirement. Mistr disables MapLibre's parsed out-of-view tile cache so a radar-first 4K session cannot accumulate hundreds of offscreen vector tiles. The runner also waits for MapLibre's public `idle` signal before sampling, keeping in-flight basemap parsing out of a measurement labeled stabilized.

**Result:** Two consecutive final runs passed without changing thresholds. Both retained 20 radar frames at 53,099,312 GPU bytes, reported zero long tasks and zero hot-path acquisition/uploads, and remained within timing and heap limits. Both final Phase 6 cold-start/context-recovery passes also passed.

## Manual release blockers

One owner-visible release blocker remains:

1. **Unsigned-build messaging.** Local Alpha installers are deliberately unsigned. Authenticode truth is automated and both final bundles correctly report `NotSigned`, but the exact Windows warning shown for a downloaded installer depends on download origin. Inspect that warning interactively, or explicitly accept the limitation and document the user-facing installation instructions, before sharing a public Alpha artifact.

The real Windows sleep/wake gate is closed: active playback survived a measured 34,387 ms sleep gap with 20 painted residents, resumed playback, and a matching post-wake scrub receipt. The clean-machine gate is also closed by the fresh Windows Sandbox pass. `DRF-003` and `DRF-004` are closed in the deferred-findings ledger.

## Scope boundary

This phase does not add a national mosaic, velocity controls, alerts, warnings, cameras, video, notifications, broad settings, or macOS release work. After the release-readiness PR merges, the next action is an owner release/no-release decision based on the remaining unsigned-package limitation—not automatic feature expansion.
