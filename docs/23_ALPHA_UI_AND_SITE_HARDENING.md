# Alpha UI and Live-Site Hardening

**Status:** Implemented and validated in [PR #11](https://github.com/tcurtsinger/Mistr/pull/11), ready for review

**Checkpoint:** 2026-08-02

## Decision

Mistr exposes one searchable catalog of the 155 operational WSR-88D sites that are present in both the current NOAA Radar Operations Center inventory and the fixed Unidata Level II chunks provider. Alaska, Hawaii, Guam, and Puerto Rico are included. KOUN and other test sites, TDWR airport radars, decommissioned or foreign systems, and identifiers absent from the provider are excluded.

The shared committed catalog is `src/data/radar-sites.json`. React uses it to render and validate the site picker; Rust reads the same file and rejects unsupported identifiers before any network request. The provider hostname allowlist is unchanged.

Catalog provenance:

- [NOAA Radar Operations Center current WSR-88D build inventory](https://www.roc.noaa.gov/build-loaded.php)
- [Unidata Level II chunks top-level prefix inventory](https://unidata-nexrad-level2-chunks.s3.amazonaws.com/?list-type=2&delimiter=%2F&max-keys=1000)
- [NCEI inventory note identifying KOUN as a test site](https://www.ncei.noaa.gov/nexradinv/choosesite.jsp)

The catalog is a supported-source list, not a claim that every radar is online at every moment. Temporary site or provider outages remain visible failure states while the last trustworthy painted observation remains displayed.

## Demonstrated defects closed

### Five-site catalog and unavailable KOUN

The prior UI hard-coded five Oklahoma-area identifiers and presented KOUN as an ordinary live site. Current provider inventory contains no KOUN prefix, and NCEI identifies KOUN as a test radar. KOUN therefore remained `UPDATING` until timeout and could never replace the KTLX archive display.

The new catalog removes KOUN and exposes all 155 qualified WSR-88D sites through one searchable header picker. The menu no longer duplicates site selection.

### Slow initial live discovery

The prior initial discovery searched all 999 possible rotating volume slots. Sparse provider directories degraded that search toward linear behavior. A reproduced KINX acquisition required 731 anonymous requests and about 40 seconds before a valid current sweep painted.

Initial discovery now performs one bounded delimiter listing for the selected site's populated ring slots, validates those prefixes, and searches only the dense returned sequence by timestamp. A hard cap of 64 volume probes fails closed if provider inventory changes pathologically during discovery. Exact-next polling after the first accepted cursor is unchanged.

The corrected KINX check completed in 3.14 seconds with 12 total requests, including the downloaded safe-sweep chunks. It decoded 720 radials by 1,832 gates. Unsupported KOUN now fails catalog validation in about 0.05 seconds without starting provider discovery.

### Slow first paint and future-only history

Hands-on KEWX testing demonstrated two separate waits. Normal startup decoded all 20 raw archive fixtures before painting any of them, and radar initialization was gated on MapLibre's full remote basemap `load` event. After live radar finally painted, `BUILDING 1/20` waited only for future provider volumes, so a 20-frame loop could take roughly 88 minutes at KEWX's measured scan cadence.

The frontend now bundles the OpenFreeMap style graph, begins radar work at local `style.load`, and treats remote basemap readiness separately. It decodes and paints only the newest bundled safe observation before starting current live acquisition; the other 19 fixtures are lazy diagnostic inputs. Current live radar then paints before sequential predecessor backfill. Each predecessor must occupy the prior ring slot and carry a strictly older measured time before it can be prepended. Exact-next polling begins after backfill completes or safely settles partial.

On this workstation the debug runtime painted its bundled safe frame about seven seconds after process start and painted current live radar about five seconds later. A live KEWX session then reached three usable chronological frames within roughly eight additional seconds and the full 20-frame resident loop in about one minute. Release decoding is materially faster than the debug runtime; packaged timing remains the release gate.

### Misleading startup and hidden recovery copy

Before the first paint, the normal playback bar previously showed `0 / 0`, `PAUSED`, `WAITING FOR RADAR`, an active-looking timeline, and `CLICK TO INSPECT`. Real archive-decode progress existed internally but was not visible. Recovery guidance was available only to screen readers.

The playback area now becomes a dedicated compact preparation state until the first painted scan and exposes plain-language history progress. Every launch proceeds from the safe bundled archive paint to current live radar for the stored site or KTLX on a fresh profile. Site acquisition names both the displayed radar and the pending live site. Actionable recovery copy is visible.

### Disabled retained playback and flashing state text

Network acquisition previously disabled the still-valid resident loop. Existing archive/live frames now remain playable and scrubbable during network and decode staging; the controller pauses only for its bounded atomic GPU replacement.

Routine playback steps also alternated `PLAYING` and `PAINTING` around every GPU receipt. Active playback now keeps the stable label `PLAYING`; a paused manual selection may say `LOADING SCAN`, and actual graphics recovery remains `RECOVERING`.

### Diagnostic markers in weather pixels

Engineering alignment anchors were rendered as pale circles above radar pixels, creating the fixed cluster and cardinal white points reported during hands-on review. Their sources, layer order, and numeric reports remain installed for packaged evidence, but both engineering layers are hidden by default in the product map.

### Atomic replacement and accessible status

Resident playback remains available during network and decode staging, but direct transport is now held during the brief atomic GPU history replacement itself. This prevents an old timeline index from racing a newly installed resident set. A controller regression test exercises a scrub attempt during that exact interval.

Preparation progress, site-loading notices, and failure recovery each have one screen-reader announcement path rather than overlapping live regions. Search connects its input to the results and announces the matching count or empty result without reading every station button.

The S3 directory parser also requires the complete `ListBucketResult` and `CommonPrefixes` structure before using its prefixes. A truncated provider response therefore fails closed instead of allowing a partial directory to masquerade as the newest-volume inventory.

## Interface contract

- The top context contains Mistr identity and the single canonical site selector.
- The picker searches by four-character identifier or place name and supports keyboard focus.
- Fixed Alpha scope—base reflectivity at the lowest usable tilt—is explained in About rather than occupying inert control-like header segments.
- The left menu contains only recenter and About.
- Preparation, retained-display loading, recovery, and failure use visible product-language status.
- A current live frame is immediately usable as radar; predecessor progress says `LOADING RECENT n/20`, settled partial history says `RECENT n/20`, and one-frame partial history says `WAITING FOR NEXT SCAN`.
- A selected inspection point outside the measured sweep says `OUTSIDE RADAR COVERAGE` rather than reverting to `CLICK TO INSPECT` while leaving a reticle behind.
- The intentionally tiny inspection reticle is separate from hidden alignment diagnostics.

## Live qualification sample

The corrected fixed-host path safely decoded current lowest-sweep reflectivity for this representative sample:

| Region / owner case | Site | Result | Time | Total requests | Shape / VCP |
|---|---:|---:|---:|---:|---|
| CONUS | KINX | Pass | 3.14 s | 12 | 720 x 1,832 / 35 |
| Alaska | PABC | Pass | 4.17 s | 28 | 720 x 1,832 / 215 |
| Hawaii | PHKI | Pass | 3.37 s | 26 | 720 x 1,832 / 215 |
| Guam | PGUA | Pass | 2.83 s | 12 | 720 x 1,832 / 215 |
| Puerto Rico | TJUA | Pass | 3.60 s | 28 | 720 x 1,832 / 215 |
| Military | KGRK | Pass | 3.78 s | 12 | 720 x 1,832 / 35 |

These live observations demonstrate representative identifier, source, and decoder paths. They do not turn changing public weather into a CI dependency or promise uninterrupted availability for every catalog entry.

## Validation

- full `npm run verify`, including the public-repository scan, documentation links, frontend tests, production build, Rust formatting, clippy with warnings denied, Rust tests, and Rust check;
- packaged Phase 4 at 3840x2160: two 1,000-transition scenarios, zero long tasks, zero hot-path acquisition/uploads, resident-history mutation/recovery, and hidden-diagnostic layer coexistence;
- packaged Phase 5 at 3840x2160: superseded-site cancellation, KTLX volumes 666 then exact-next 667, two chronological GPU-resident observations, matching paint receipts, and direct oldest/newest scrub;
- packaged current-first backfill soak: a 1.27-second safe first paint with one archive read, KTLX volume 676 plus predecessors through 657, 20 chronological GPU-resident observations in 0.6 minutes, deterministic in-flight site supersession, direct oldest/newest scrub, 53,099,312 GPU bytes, and real context recovery;
- both packaged Phase 6 passes for N0S, real WebGL context recovery, minimize/restore, and cold restart; and
- packaged readiness at 3840x2160, 1100x700, and 1024x640 with no overflow, stable playback position, correct menu/search focus and return, keyboard scrub truth, no unnamed interactive controls, forced-colors focus, reduced motion, and 5.09:1 inactive-instruction contrast.

The corrected live path also safely decoded the representative site sample above. Raw archives, provider responses, screenshots, executables, and generated evidence remain ignored and uncommitted.

## Rollback

If the broader catalog or bounded inventory discovery regresses safe acquisition, revert the catalog/prefix-discovery change together. Do not restore KOUN or the five-site list as an apparent fix. The prior archive fallback, generation cancellation, two-credit IPC ownership, and GPU paint-truth boundaries remain unchanged and are the safe rollback floor.
