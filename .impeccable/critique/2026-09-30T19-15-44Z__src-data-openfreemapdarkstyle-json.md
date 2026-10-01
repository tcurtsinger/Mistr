---
target: the map and its surfaces
total_score: 21
max_score: 36
na_heuristics: 10
p0_count: 0
p1_count: 4
target_identity: "file:E:\\Mistr\\src\\data\\openFreeMapDarkStyle.json"
target_fingerprint: "sha256:4dffa5b845ec84ccdaf1cfc1f569c62889af2a486e061df9926c284a32f09f5c"
target_path: "E:\\Mistr\\src\\data\\openFreeMapDarkStyle.json"
timestamp: 2026-09-30T19-15-44Z
slug: src-data-openfreemapdarkstyle-json
---
Method: dual-agent (A: design-review agent · B: detector-and-evidence agent)

# Map critique: basemap + radar (target src/data/openFreeMapDarkStyle.json, with RadarCustomLayer.ts, NationalGridLayer.ts, palette.ts)

Evidence: 15 live packaged-app captures (scratchpad map-crit/, 2026-09-30): 01 CONUS z3.9 · 02 Plains z6.2 · 03 Great Lakes z7.2 · 04 Nevada z7 (no radar) · 05 KDDC z9.5 · 06 KDDC z11 · 07 Chicago KLOT z10 · 08 z12.5 · 09 z14.5 · 10 Miami KAMX z9.3 · 11 Denver z8.3 · 12 KDDC z11.5 Smooth · 13 KDDC z11.5 Native · 14 CONUS 2560 z4.6 · 15 Chicago 2560 z11.2.

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 2 | Below-threshold holes, cone of silence, and no coverage all look like black map (06, 08, 04) |
| 2 | Match System / Real World | 2 | NWS palette right; no counties, no US-route numbers, raw refs ("I 595 EXPR", "SR 869 Toll") |
| 3 | User Control and Freedom | 3 | Free pan/zoom, zoom-led source, Smooth/Native |
| 4 | Consistency and Standards | 2 | Site vs National "Smooth" are different algorithms; click readout and painted pixel disagree (issue 1) |
| 5 | Error Prevention | 2 | Holes read as structures ("✓ Chicago"); 30/55 dBZ collide for colour-blind users |
| 6 | Recognition Rather Than Recall | 2 | Towns under the storm unnamed; "Chicago" vanishes above z12 |
| 7 | Flexibility and Efficiency | 3 | Continuous zoom treatment and cross-fade; no counties or distance cues |
| 8 | Aesthetic and Minimalist Design | 3 | Matte charcoal makes radar pop; black holes and black airports undercut it |
| 9 | Error Recovery | 2 | Data gaps have no visual encoding; only a click explains a hole |
| 10 | Help and Documentation | n/a | A basemap has no help surface |
| **Total** | | **21/36** | **Acceptable (58%)** |

## Design Specificity Verdict

LLM assessment: authored at regional scale, generic at storm scale. CONUS to ~z8 is a real radar instrument (explicit radar anchor, dark-cased major routes, tuned weak-return fade, haloed above-radar labels; 02, 03, 11 hold up against RadarScope/Zoom Earth). Zooming into a storm (z9–z12) the design stops: radar peppered with black holes; towns, state lines, coast, route numbers vanish under echo; counties don't exist.

Deterministic scan: detector 0 findings on src/App.tsx + index.html (the map is a WebGL canvas the detector cannot see). Rendered-DOM fallback scan: 8 findings, all chrome or MapLibre CSS (gpt-thin-border-wide-shadow ×4, repeating-stripes-gradient, pulsing-dot, cramped-padding, low-contrast unlocated), all false positives for the map. Overlay: blocked by the app CSP (script-src 'self', no wasm-unsafe-eval); no overlay. Direct measurement of live layer order, label/line contrast, palette, and pixels found issue 1.

## Overall Impression

Calm and credible zoomed out; untrustworthy zoomed in. Biggest opportunity: make the storm-zoom view as truthful and readable as the regional view.

## What's Working

1. Dark-cased, zoom-continuous major routes (highway_major_context_casing): 6.2–6.9:1 over bright echoes; interstate/US-only below z6.75.
2. National Smooth (NationalGridLayer.ts 106–135): value-space blending with coverage-as-opacity; feathered edges. The bar for Site.
3. Halo discipline on above-radar labels: cities 6.5–11:1, motorway refs ~7:1 over any echo colour.

## Priority Issues

1. [P1] Site radar drawn ~0.85 km toward the radar. RadarCustomLayer.ts:121–123 computes ground range as 2R·asin(√h); on ANGLE/D3D11 (RTX 4080) asin returns +6.8e-5 rad for small inputs: 862 m short near the radar, 560 m at 127 km, 296 m at 255 km. Inner edge measured at 1.16 km (should be 2.00 km); offset ~10 px z9.5, ~28 px z11, ~300 px z14.5. CPU inspection is exact, so readout and painted pixel disagree. Measured three ways by the evidence pass; not yet confirmed by a test. Fix: numerically stable range (2R·atan2(√h, √(1−h)) or local tangent-plane within radar range) plus a packaged-gate check that the inner edge lands at 2.00 km. Command: /impeccable harden.
2. [P1] Radar gaps render as black holes. Below-threshold (status 1) gates hard-discarded in both modes (RadarCustomLayer.ts:61–67, 153): 164 holes in 06, 110 in 12, "✓ Chicago" (07, 15), 400-px V at z14.5 (09). Native leaves 1-px inter-radial seams (line 140): 25,919 pinholes and a radial line in 13. docs/25 §6 fixed this for National; Site never got it. Fix: port National smoothing to Site Smooth (no status-1 discard, weight valid neighbours, coverage as opacity); Native nearest radial under the same adjacency test. Command: /impeccable polish.
3. [P1] Boundaries and coast vanish over radar; no counties. boundary_state uncased: 1.65:1 on land, 1.05–1.30:1 over echo; country similar. Land/water 1.06:1 and no coast line above radar (10). No admin_level 6 layer. Fix: dark casing on state/country lines; cased county hairline from ~z8; bundled simplified coastline/lakeshore above radar. Command: /impeccable bolder.
4. [P1] Town names and route numbers vanish where the storm is. place_town/place_village below radar (05, 06, 12, 13 name no settlement in echo; fragments "ontezuma", "rders", "OADS"). Only motorway refs labelled (no US-50/283/400; no shields). place_city_large maxzoom 12 ("Chicago" gone in 08, 09). Fix: towns above radar from ~z8, villages ~z10; US-route ref label; normalise refs; lift city maxzoom. Reverses an owner direction decision. Command: /impeccable shape, then /impeccable typeset.
5. [P2] Palette lightness backwards on a near-black map; colour-blind collisions. L*: 5→45, 20→76, 30→42, 40→83, 55→35, 60→82, 70→39. Against the map 55 dBZ 2.5:1, 70 dBZ 2.9:1, 40 dBZ 12.4:1. Machado simulation: deutan 25/35 ΔE 1.7, 30/55 ΔE 2.8; protan 25/35 ΔE 2.5; 40→45 ΔE 8.6 with normal vision; range-folded vs 70 dBZ ~7. Fix: keep NWS hues, lift 30, 50–55, 70 lightness for monotonic intensity; document as dark-map adaptation. Command: /impeccable colorize.

## Persona Red Flags

Alex (power user): click value ≠ painted pixel (issue 1); Native not visually exact; no counties, range rings, US-route numbers; holes indistinguishable from clear air without clicking.
Sam (CVD / low vision): 25/35 and 30/55 collide with no second channel; state 2.98:1, country 2.3–2.8:1, suburbs/hamlets 1.69:1, local roads 2.05:1 with 0.9-px halo; land/water 1.06:1.
Storm-watcher on 4K at night: 10-px labels are specks at 2560 (14); holes flicker in the loop; 15 dBZ teal nearly as bright as 20 dBZ; coast fades in a dark room.

## Minor Observations

- Aeroways pure #000 (aeroway-*): O'Hare bars, runway X in KDDC cone of silence.
- landcover_wood never draws: wood-pattern sprite missing.
- building has explicit fill-outline-color; possible tile seams.
- Country labels uppercase and on storms ("UNITED STATES", "CUBA", "THE BAHAMAS").
- State-route casings fade in at z7.2 and mesh over Illinois echo (03); start ~z8.
- Water lighter than land, close to 5 dBZ haze.
- ne2_shaded source declared, unused.
- Cone of silence a crisp black disc (~75 px at z11).
- National edges near Greeley step in 8–10 px blocks at z8.3 (11); check painted level.
- GPU atan latitude wobble ±70 m (Site) / ±146 m (National).

## Questions to Consider

1. The storm question is "which town is next". Is keeping towns below radar serving the storm, or the screenshot?
2. Should the NWS legend stay the colour authority on #0c0c0c, where 55 and 70 dBZ are the dimmest colours?
3. Should "no echo", "no coverage", and "below threshold inside a storm" all look like empty map?
4. What does Native promise: measurement footprints exactly, or the gaps between beams too?
