# Seamless radar handoff — Phase A: resident National

**Date:** 2026-09-28
**Status:** Implemented; native packaged validation pending.
**Owner decisions (2026-09-28):** phased delivery (A: resident National; B: cross-fade, zoom-driven switching, Site preload; C: playback time carried across a switch). Zoom decides the source in Phase B, including after a manual Site pick. Panning out of a Site's coverage while zoomed in returns through National; only one Site layer ever exists.

## Problem

Every Site ↔ National switch destroyed the other source. Returning to National meant a new generation, a backend store reset, a new current frame, and a full 60-frame backfill — minutes of rebuild in development builds and tens of seconds in release. A zoom-driven handoff (Phase B) is impossible on that footing.

The single-source assumption lived in four places: one global transfer generation and one two-credit pool in the broker, one generation in the TypeScript client, one painted source in the session coordinator, and teardown in the App on every switch. A hidden National layer also drew nothing, so it produced no GPU receipt and could neither commit history nor finish context recovery.

## Decisions

### Transfer lanes

`TransferBroker` and `PackedSweepTransferClient` now hold one lane per source (`site`, `national`), each with its own generation, cancellation token, and **two credits**. Commands choose their lane server-side; the client passes a lane only to `begin` and `cancel`. Generations remain unique across lanes, so a release acknowledgement still finds its owner from `(session, generation)`.

This supersedes the single global two-credit pool in [26 §6.5](26_NATIONAL_RADAR_IMPLEMENTATION_PLAN.md), the "2 global credits" row in [17](17_REALTIME_FRESHNESS_AND_FALLBACK_DECISION.md), and the global-credit wording in [05](05_TEST_AND_VALIDATION_PLAN.md). The bound per lane is unchanged, so worst-case IPC ownership is four leases: two Site sweeps plus two National batch envelopes.

### Resident means "holds data, claims nothing"

`NationalGridLayer.setVisibility("resident")` keeps every frame on the GPU and lets staging, history commits, and context recovery complete on GPU fences **without drawing**. Their receipts carry `presented: false` and land in `residentReceipt`; `paintReceipt` stays reserved for frames that were actually drawn. The truth contract is unchanged: the timeline, time, and age follow only a presented paint of the visible source.

- A draw that completes after `hide` is downgraded to a resident receipt.
- Frame selection is refused while hidden.
- `revealAndWait()` lets an in-progress hidden commit finish, then resolves only after a real visible draw.
- The session coordinator reveals a resident source under its **original** generation (`residentGeneration`), so its later playback paints still synchronize.

### App behavior

- **National → Site:** National playback pauses; history, backfill, and polling continue on the National lane. When the Site paints, National becomes resident instead of being removed. A failed Site request leaves National exactly as it was and resumes its playback.
- **Site → National:** if National is resident and its lane is current, the switch is a single fenced paint — no acquisition, decode, or bulk transfer — then the Site is removed and its lane cancelled. Otherwise National acquires as before.
- While hidden, National writes neither the shared timeline nor the history status nor the error notice; its last error is replayed on reveal. Commit receipts that were not presented never drive inspection.
- Smooth/Native now applies to both layers, so a hidden layer can never reverse-sync an older mode into the UI.

### Memory

The Site layer gains a 320 MiB GPU ceiling (a 60-frame loop is about 152 MiB, about 304 MiB during an atomic replacement). With National's 3,584 MiB ceiling, the combined bound is 3,904 MiB. While a Site is shown, resident National also keeps its host-side copies (about 2.8 GiB of WebView heap and up to the 4 GiB backend target) alive. This is the same footprint National uses while visible, now held for longer.

## Not changed in Phase A

- The camera still recenters on a manual switch (`focusRadar` / `focusNational`).
- Layer order after a context restore is not yet pinned; it matters only once both layers draw (Phase B cross-fade).
- The Site is still torn down when National shows.
- National code stays in `App.tsx`; extracting a `NationalRadarEngine` is a separate refactor.

## Validation

- Unit: broker lane isolation (Rust), client lane isolation, coordinator/session reveal, and a fake-WebGL state-machine suite for hidden commits, reveal, downgrade, a hidden fence finishing after reveal, recovery while hidden, and reveal waiting out a commit.
- Packaged (`npm run test:national:phase4:packaged`): `proveFailedSiteKeepsNational` (same generation, no backfill restart, playback resumed) and `proveResidentHandoff` (National resident while the Site paints; reveal under the original generation with zero network, decode, and bulk IPC activity within 250 ms; the Site layer removed).

## Phase B — zoom decides the source

**Date:** 2026-09-28. **Status:** Implemented; native packaged validation pending.

### Policy

`decideAutoSource` (`src/radar-session/autoSourcePolicy.ts`) is a pure function of zoom, view center, the displayed source, and the operator's picked Site:

| Condition | Result |
|---|---|
| National shown, zoom ≥ 9, a Site within 200 km of the center | Switch to the nearest such Site (or the picked Site while within 230 km) |
| National shown, zoom ≥ 8 and < 9, same Site condition | Stay on National; preload that Site |
| Site shown, zoom ≥ 8.5 and center within 230 km of it | Stay on the Site |
| Site shown, otherwise | Return to National |

Moving between Sites always passes through National, so only one Site layer exists. Site coordinates live in `src/data/radar-sites.json`: 150 from nexrad-model's registry (a Rust test keeps them in sync) and 5 from api.weather.gov.

Only camera moves the operator makes are evaluated (MapLibre events with an `originalEvent`), plus the landing of an explicit picker or recenter flight. Programmatic cameras, including every packaged harness camera, never switch sources.

### Switching

- **Preload:** the likely Site's newest scan is fetched on the Site lane while National is shown. The switch reuses that generation (`SiteLevel2Session.start({ residentGeneration })`) and paints without a network wait. A preload older than 5 minutes is refetched.
- **Fade in:** the Site's first frame paints at `u_opacity = 0`, then fades to 1 over 300 ms (instant under reduced motion). Only then does the coordinator accept it, so the timeline follows a fully visible frame. National keeps playing underneath until it becomes resident.
- **Fade out:** National paints underneath first (a reveal, or a fresh acquisition), then the Site fades to 0 and is removed.
- **Layer order:** National is always inserted, and re-inserted after context loss, below the Site stack, so only the upper layer fades.
- **Guards:** one automatic switch runs at a time; a Site that just failed is not retried automatically for a minute.

### Camera

Automatic switches never move the camera. The picker flies to a Site at zoom 9.5 (preloading during the flight when National is shown) and makes it preferred; picking National zooms out to the country; recenter uses the same targets. The camera is stored on every move and restored at launch.

### Known limits

- At the end of a fade-in, National disappears everywhere, including outside the Site's range ring, so corners of a wide view briefly lose echo.
- Playback time is not yet carried across a switch (Phase C); a Site starts at its newest scan.

### Validation

`proveZoomHandoff` in the National packaged gate: at zoom 8.3 over KTLX the Site preloads; at 9.6 the Site fades in under the preloaded generation with National resident and the camera untouched; at 7.5 the same National history returns, the Site layer is removed, and the camera is untouched.
