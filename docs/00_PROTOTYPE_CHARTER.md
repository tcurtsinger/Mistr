# Mistr Prototype Charter

## 1. Purpose

Mistr is a bounded technical prototype intended to answer one decision:

> Can GustAVO replace selected-site radar playback based on pre-rendered MapLibre raster tiles with decoded, GPU-resident NEXRAD data while preserving product trust, map context, and packaged Windows reliability?

Mistr is not permission to rewrite GustAVO. It is a deliberately isolated experiment whose evidence will determine whether a targeted radar-engine retrofit is safer and more maintainable than the current tile orchestration.

## 2. Product context

The eventual consumer is the same single experienced US storm watcher/chaser served by GustAVO. The operating assumptions remain:

- Desktop use, often for long sessions.
- Always-online operation; offline support is not a primary driver.
- The live map remains the main working surface.
- Radar must remain visibly current, spatially trustworthy, keyboard accessible, and subordinate to the operator's weather decision.
- Warm colors remain weather/severity data, not application chrome.

Mistr itself may use a minimal diagnostic interface. It does not need to reproduce GustAVO's shell, panels, cameras, alerts, or design polish.

## 3. Problem statement

GustAVO currently represents each radar observation as a provider-rendered raster tile pyramid. Playback coordinates multiple MapLibre sources and layers, look-ahead loading, opacity-based preload behavior, tile-cache policy, camera movement, scale handoff, and readiness certification.

The current path must account for behaviors such as:

- Exact-zero raster opacity can prevent MapLibre from requesting preload tiles.
- Map movement can delay or suppress a global `idle` boundary.
- Native custom-protocol tile sources can behave differently from ordinary browser HTTPS sources.
- A source may report loaded while a different URL or frame remains painted.
- Timeline state can advance independently from what the operator actually sees.
- Historical tile caching, cancellation, LRU eviction, and source lifecycle add cross-language concurrency.

These are not proof that MapLibre, Tauri, Rust, or web rendering is inherently too slow. They show that animated radar tiles introduce a large asynchronous orchestration surface.

## 4. Hypothesis

For selected-site radar, a decoded polar sweep can be normalized once, transferred as packed binary data, uploaded to bounded WebGL2 resources, and replayed without further network or disk access.

Once a loop is resident:

```text
select frame -> update a small GPU selection value -> repaint
```

If true, this eliminates the selected-site radar dependency on per-frame tile readiness while retaining MapLibre for the basemap and all other geospatial layers.

## 5. Primary goals

1. Render an official selected-site Level II base-reflectivity sweep directly over MapLibre.
2. Hold a 20-frame observed loop in bounded GPU memory.
3. Switch an already-resident frame on the next rendered frame without network, disk, or decoder work.
4. Prove decoded values against independent trusted references.
5. Prove geospatial alignment across zoom, pan, pitch constraints, high-DPI scaling, and representative radar sites.
6. Prove behavior in packaged Tauri/WebView2 on Windows.
7. Measure real-time chunk latency against the current IEM/NOAA availability path.
8. Determine a safe route to current `N0S` storm-relative velocity parity using raw Level III data.
9. Produce sufficient diagnostics that Codex or Claude can reproduce failures without guessing.
10. Preserve a clean fallback to GustAVO's current tiled radar.

## 6. Secondary goals

These may be demonstrated only after primary gates pass:

- Custom reflectivity and velocity palettes.
- Simple hard cuts and optional crossfade between resident observations.
- Lowest-tilt selection from a full Level II volume.
- Additional Level II moments such as ZDR and correlation coefficient.
- Multiple elevation selection.
- Point interrogation of the displayed gate and its raw value.

## 7. Non-goals

Mistr will not initially:

- Rebuild GustAVO's complete UI.
- Replace Tauri with Electron, Qt, Godot, or another shell.
- Replace MapLibre or rebuild the basemap.
- Build a national Level II mosaic.
- Replace the current national `USCOMP-N0Q` product.
- Implement storm-motion estimation or label Level II base velocity as storm-relative velocity.
- Implement or market velocity dealiasing before a separately validated meteorological algorithm exists.
- Support the entire historical NEXRAD archive back to 1991.
- Add 3D volume rendering, vertical cross-sections, storm algorithms, or derived severe-weather products.
- Remove the current tiled radar before adoption gates pass.
- Optimize for mobile, macOS, or Linux before Windows feasibility is proven.
- Treat visual similarity as proof of meteorological correctness.

## 8. Prototype boundary

Mistr owns:

- Public AWS radar discovery/download.
- Completed-volume and real-time-chunk acquisition.
- Decoder adapter and normalization.
- A versioned packed-sweep wire format.
- Tauri binary transfer.
- WebGL2 resource allocation, rendering, and recovery.
- Minimal controls for site, product, timeline, data status, and diagnostics.
- Fixture capture and deterministic replay.
- Performance and latency measurement.

Mistr does not own:

- NWS warnings, SPC outlooks, cameras, video, lightning, notifications, saved views, or the GustAVO shell.
- National mosaicking science.
- Operational redistribution of NOAA data.

## 9. Success definition

Mistr succeeds only when every mandatory adoption gate in `05_TEST_AND_VALIDATION_PLAN.md` passes. At minimum:

- Gate values match trusted references.
- The rendered sweep is geospatially aligned.
- Twenty frames are resident within an explicit memory budget.
- Resident playback does no network, disk, decode, or bulk IPC work.
- P95 frame time remains inside the 60 FPS budget during representative 4K playback and camera interaction.
- Incomplete chunks, provider failures, rapid site changes, cancellation, and WebGL context loss are recovered without stale or falsely current radar.
- The packaged Windows app produces the same results as deterministic development fixtures.
- The existing tile renderer can be restored immediately by configuration.

## 10. Failure definition

Mistr should be stopped or redesigned if any of the following remain true after the bounded prototype phases:

- Decoder correctness cannot be established across the current live format corpus.
- Renderer alignment depends on brittle, undocumented MapLibre internals.
- WebGL context restoration cannot reliably recreate all resident frames.
- Memory grows without a hard bound during repeated site/product changes.
- Real-time acquisition is materially less reliable or stale compared with current sources without an acceptable fallback.
- Packaged WebView2 behavior differs in a way that cannot be reproduced automatically.
- The resulting implementation requires more cross-process lifecycle machinery than the tile path it intends to replace.
- AI agents cannot produce a deterministic debug bundle for a failed run.

## 11. Deliverables

The prototype must ultimately produce:

- A minimal installable Windows application.
- Source code separated into acquisition, decode, wire, and renderer modules.
- A pinned fixture corpus with provenance and hashes.
- Independent decoder comparison results.
- A repeatable performance report.
- A latency comparison report.
- A packaged-runtime fault-injection report.
- A go/no-go recommendation for GustAVO integration.
- If “go,” an integration and rollback plan with no deletion of the old renderer until equivalence is proven.

## 12. Current status

Planning only. No prototype implementation has been authorized by the creation of these documents.
