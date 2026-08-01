# Real-Time Lowest-Sweep Publication and Fallback

**Status:** Accepted for the Phase 5 reflectivity prototype

**Decision date:** 2026-08-01 UTC

**Applies to:** Selected-site, lowest-elevation NEXRAD Level II base reflectivity

## Context

Waiting for a completed Level II volume is structurally simple, but it discards the freshness advantage of the real-time chunk feed. Publishing merely because a partial byte stream happens to decode is unsafe: the result could begin mid-elevation, omit radials, cross a gap, or outlive a site switch.

The decision therefore needs a stronger boundary than “decoder returned a sweep,” plus a fallback that never replaces known visible truth with partial work.

The public-data contract was revalidated against the [AWS Open Data registry](https://registry.opendata.aws/noaa-nexrad/), [NCEI's real-time block description](https://www.ncei.noaa.gov/products/radar/decoding-utilities-examples), and the [ROC Archive II/User ICD](https://www.roc.noaa.gov/public-documents/icds/2620010J.pdf). The AWS source has a rotating real-time chunk bucket and a completed archive bucket. NCEI describes real-time Level II as ordered header/data blocks whose data sections use BZip2 compression.

## Decision

Mistr may publish the lowest reflectivity sweep before the volume-end chunk only when all of these conditions are true:

1. downloaded objects form a contiguous sequence beginning at `001-S`;
2. every object key, declared length, payload form, site, rotating index, volume timestamp, sequence, and type passes the Mistr-owned bounded assembler;
3. the decoder sees an explicit scan/elevation start on the first radial;
4. the decoder sees an explicit elevation/scan end on the last radial;
5. every radial status is recognized, source azimuth numbers are unique, dimensions are internally consistent, and reflectivity is present;
6. the acquisition token is still the broker's current session/generation immediately before publication;
7. the packed response validates with source kind `nexrad_level2_chunks`; and
8. the UI advances visible truth only after the exact observation receives a GPU-complete paint receipt.

This is an allowlisted boundary for the tested reflectivity path, not blanket permission for future moments, message types, VCPs, or derived products. A new format that fails a condition is rejected.

## Why progressive publication is accepted

The committed latency dataset contains `14` fresh observations across `8` sites and VCPs `35, 212, 215`. Every fresh observation first became safe at chunk 7. The probe then continued through the terminal chunk and independently decoded the complete volume. All `14` comparisons matched exactly for:

- every raw reflectivity code;
- every detailed gate status; and
- every azimuth value.

This proves the boundary for the observed Phase 5 matrix. It does not prove all historical or future NEXRAD formats; an expanded corpus remains an adoption requirement.

## Acquisition and assembly contract

### Fixed network boundary

Rust owns all radar network activity. Requests are anonymous HTTPS with redirects disabled, a five-second connect timeout, a 15-second request timeout, bounded streamed bodies, and an exact host allowlist:

- `unidata-nexrad-level2-chunks.s3.amazonaws.com`;
- `unidata-nexrad-level2.s3.amazonaws.com`;
- `opengeo.ncep.noaa.gov`; and
- `mesonet.agron.iastate.edu`.

The latter two hosts are comparison observers only; they do not decide whether a raw sweep is publishable.

### Hard bounds

| Resource | Bound |
|---|---:|
| One real-time object | 4 MiB |
| One assembled volume | 64 MiB |
| Objects per volume | 256 |
| S3/provider inventory body | 2 MiB / 8 MiB |
| Concurrent packed transfers | 2 global credits |
| Complete packaged live request timeout | 10-900 seconds, including discovery and in-flight polling |

### State behavior

- Identical duplicates are no-ops; conflicting duplicates are fatal.
- Out-of-order objects may be stored, but only the contiguous prefix is eligible for decode.
- An end object establishes a terminal sequence but cannot claim completion until every prior sequence exists.
- A newer timestamp rolls over the assembler and records whether the prior volume was incomplete.
- Objects from an older timestamp are late and cannot mutate the active volume.
- A safe sweep is publishable once per active volume.
- A site/generation switch cancels the old atomic token; stale work cannot commit bytes or evidence.

## Fallback policy

Fallback is a truth policy, not a timer that paints whatever arrived most recently.

| Condition | Visible behavior | Next source |
|---|---|---|
| Contiguous live stream has not reached a safe sweep | Keep the last GPU-painted complete frame | Continue bounded live polling |
| Gap, timeout, malformed chunk, decode rejection, or provider failure | Keep and label the last complete frame; never label partial data current | Completed Level II archive |
| Completed archive is not yet available or fails validation | Keep the last complete frame | Existing selected-site provider tiles |
| Site switch | Immediately invalidate the old pipeline; keep last complete frame until the new site earns a paint receipt | New site's live chunks, then the same fallback ladder |

The Phase 5 shell begins with a hash-pinned completed Level II archive frame, so the fallback is real visible state rather than an empty placeholder. The pure display-state tests prove that gaps preserve it and that late success/failure from a superseded generation cannot change current state. Dynamic archive download and the GustAVO feature-flag/tile adapter remain Phase 7 integration work; Mistr defines and tests their source order without deleting either production fallback.

## Freshness result

All timings preserve distinct source clocks. Provider inventories were polled every five seconds, so NOAA/IEM comparisons have up to five seconds of observation uncertainty. S3 `Last-Modified` is recorded at one-second resolution while decode completion uses the workstation clock; one observed sub-second negative raw-to-decode delta is clock/granularity uncertainty, not a claim that decoding preceded availability.

| Measurement | P50 | P95 | Worst |
|---|---:|---:|---:|
| Lowest-sweep end to raw chunk availability | `1804` ms | `2767` ms | `2767` ms |
| Raw availability to safe decode | `537` ms | `1332` ms | `1332` ms |
| Safe-decode lead versus NOAA | `26411` ms | `81753` ms | `17503` ms |
| Safe-decode lead versus IEM | `27828` ms | `93124` ms | `16215` ms |

Positive lead means the Mistr safe decode was observed first, so the smallest provider-lead value is the worst case. The result supports the architectural conclusion that progressive raw acquisition can be materially fresher in this observation window. It is not a universal provider SLA or outage guarantee.

## Packaged paint proof

The release Tauri/WebView2 runner at 3840 by 2160:

1. started a fresh KAMX request;
2. superseded it with a current KTLX generation;
3. observed the KAMX request fail during start or sweep acquisition with no stale publication;
4. decoded and transferred a 7,931,840-byte KTLX sweep;
5. uploaded one live frame; and
6. received a matching hardware-accelerated GPU receipt 91 ms after safe decode completed.

The final observation ID matched backend evidence, packed bytes, display truth, selected renderer state, last-painted renderer state, and the 4K receipt. The existing Phase 4 2,000-transition packaged regression also passed after the renderer was generalized to replace its site/source/bounds atomically.

## Consequences

### Benefits

- The selected-site live path no longer waits for a complete volume or hundreds of raster-tile readiness events.
- A frame is one bounded packed sweep and one atomic GPU resource set.
- Site switching, publication, and evidence use the existing monotonic generation/two-credit contract.
- Completed archive and provider tiles remain available as explicit fallbacks.

### Costs and limitations

- Live acquisition still performs bounded HTTP polling; playback becomes I/O-free only after residency.
- The current prototype observes listings rather than consuming SNS notifications.
- The evidence window is enough for the Phase 5 architecture decision, not for nationwide reliability or seasonal claims.
- Dynamic archive/tile fallback wiring belongs in GustAVO integration; this prototype proves retention and source ordering.
- Product parity, Level III `N0S`, context loss, sleep/wake, and broader machine coverage remain Phase 6+ gates.

## Rejection conditions

The progressive boundary must be disabled for any product/format cohort if a completed-volume comparison changes a raw code, gate status, or azimuth; if end-of-elevation status is absent/ambiguous; or if a stale site generation can reach the renderer. That cohort waits for a completed volume or falls back rather than accepting looser validation.
