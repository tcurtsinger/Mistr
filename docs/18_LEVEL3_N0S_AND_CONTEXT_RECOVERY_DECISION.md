# Level III N0S and context-recovery decision

**Status:** Accepted for the Mistr prototype on 2026-08-01
**Scope:** Phase 6 product semantics, decoder boundary, renderer recovery, and packaged lifecycle

## Decision

Mistr will preserve GustAVO's storm-relative-velocity product by decoding NEXRAD Level III product 56 (`N0S`) in a small, strict Rust adapter. It will not derive or relabel Level II base velocity as storm-relative velocity.

The adapter accepts only:

- an explicitly expected four-character ICAO site;
- the `SDUS` / `N0S` text identity;
- message and product code 56;
- one bounded symbology layer;
- the `0xAF1F` 16-level radial packet;
- bounded radial, gate, cell, and input sizes; and
- RLE rows that expand to exactly the declared gate count.

Everything else fails closed. The runtime parser is Mistr-owned Rust. The pinned MIT package `nexrad-level-3-data@0.6.1` is a development-only independent oracle, not a production dependency.

NOAA NCEI describes `N0S/N1S/N2S/N3S` as storm-relative velocity, product 56, produced by removing storm motion from the wind field. It separately describes base velocity as the radial wind component toward or away from the radar. Those identities are therefore separate enum values and separate display labels in every Mistr boundary. See [NCEI's NEXRAD product descriptions](https://www.ncei.noaa.gov/products/radar/next-generation-weather-radar) and the [ROC interface-control-document index](https://www.roc.noaa.gov/interface-control-documents.php).

## Normalized N0S contract

| Field | N0S rule |
|---|---|
| Product | `storm_relative_velocity` |
| Units | `kt` |
| Source | `nexrad_level3_n0s` |
| Raw encoding | Category codes 0 through 15 |
| Code 0 | unavailable/below-threshold status; transparent |
| Codes 1-14 | valid product-specific threshold categories |
| Code 15 | range-folded status; explicit purple |
| Gate values | Product-description threshold table copied into the normalized float section |
| Geometry | Packet range scale and first-bin geometry; radials sorted by center azimuth |
| Palette | Dedicated inbound/near-zero/outbound categorical palette |

Threshold tables are read from each product. They are not hard-coded because the pinned corpus demonstrates different category knots between observations.

`PackedSweep v1` remains byte-compatible. Phase 6 assigns product code 3 and source code 4; its existing float-value section carries categorical display values. The WebView retains that float section only for N0S interrogation. Reflectivity continues to retain the smaller raw/status representation and reconstruct its linear values from scale/offset.

## Context-loss decision

MapLibre's public custom-layer contract says custom layers must handle `webglcontextlost` and `webglcontextrestored`. MapLibre 6 also warns that it cannot automatically restore custom layers. Mistr therefore owns the complete recovery sequence using only public map events and `addLayer`.

1. Invalidate the old paint receipt and increment the context epoch.
2. Retain normalized CPU models and the authoritative selected observation.
3. Allow MapLibre to recreate its style and WebGL context.
4. Re-add the custom layer from the public `webglcontextrestored`/`styledata` events.
5. Compile shaders and upload only the selected observation.
6. Draw it and require a new-context GPU fence receipt.
7. Upload one remaining resident observation per render turn.
8. Require a second GPU fence after policy residency is complete.
9. Resolve recovery and permit playback selection only after all required observations are resident.

This ordering is visible-first, not loop-first. Playback waits instead of selecting a nonresident frame. A context loss during an uncommitted loop replacement rolls back to the prior authoritative CPU loop before recovery.

The design follows the [MapLibre CustomLayerInterface contract](https://maplibre.org/maplibre-gl-js/docs/API/interfaces/CustomLayerInterface/) and its documented context events.

## Rejected alternatives

### Relabel Level II velocity

Rejected. Base velocity and storm-relative velocity answer different meteorological questions. A smooth display with the wrong product name is a correctness failure.

### Use the JavaScript decoder in production

Rejected. The package is useful as an independent oracle, but a second runtime language/worker path would widen the troubleshooting surface. The small Rust adapter is bounded, testable, and consistent with the established normalization boundary.

### Upload all 20 frames before showing anything

Rejected. It extends blank time after a GPU reset and provides no paint proof for the user's previously visible frame.

### Trust old WebGL handles or an old receipt

Rejected. Resources and receipts are context-epoch-specific. Reusing either can display nothing while the application claims current radar is painted.

## Remaining boundary

The automated packaged gate covers real `WEBGL_lose_context` loss/restoration, minimize/restore, offline resident playback, two device-scale overrides, and two cold application starts. A real Windows sleep/wake cycle is intentionally manual because suspending the workstation is disruptive and CDP page freezing is not equivalent: it suppresses `requestAnimationFrame` by design. This manual check remains recorded in `DEFERRED_REVIEW_FINDINGS.md` and must be completed before a production GustAVO adoption decision.
