---
version: 1
slug: "src-app-tsx"
primary_target: "src/App.tsx"
related_targets: ["src/ui/RadarChrome.tsx","src/styles.css"]
---

SCOPE: Production radar surface for the installable Mistr Alpha; visitor mode is Operate.
AUDIENCE: The owner and experienced storm enthusiasts monitoring live storms for long desktop sessions.
TASK: See which radar is painted, when its displayed scan was taken and how old it is, play or scrub the recent loop instantly, switch sites, and inspect a measured dBZ value.
PROOF: The existing decoded Level II custom layer, National MRMS layer, bounded resident GPU frames, paint receipts, live publication state, and recovery diagnostics remain the truth source.
DIRECTION: "MistrRadar, darker" (owner decision 2026-09-29, replacing Stormlight Cyclorama). The owner's MistrRadar chrome system, which sits beside CARROT Weather and Zoom Earth, with neutral near-black surfaces in place of its teal charcoal and a thin single-row timeline in place of its tall timeline pill. No top toolbar, wordmark, or toolbar text slot. The map and basemap direction: a consistently quiet matte-charcoal map keeps local roads, buildings, railways, water names, suburbs, and secondary labels below radar, with towns below z8 and villages below z10. Above radar sit the coastline and large-lake shores; county, state, and country boundaries, each over a dark casing; major routes with normalized identifiers; towns from z8 and villages from z10; countries; natural-case states; and important cities. Only the ocean and large lakes are outlined, never split inland water. Motorway, trunk, and primary segments share one continuous treatment, and local roads fade in gradually. Reflectivity uses the classic NWS colors in solid 5-dBZ bands. Global radar opacity is never the readability fix.
MEMORABLE MOMENT: One glance down reads the painted scan's time, age, and radar on a single thin line; clicking a storm adds its measured dBZ with its true color beside them.
CONSTRAINTS: Chrome is opaque, never blurred or translucent, with no glow or gradient decoration. One system-blue accent marks play, selection, and focus; semantic inks mark state only (recent-live green age, caution amber, failure coral); radar colors appear only as data (color-scale strip, dBZ swatch). No permanent sidebar, speculative controls, duplicate site picker, inert product/elevation controls, dedicated step buttons, or normal-interface diagnostics. One temporary sheet or popover at a time; opening it never resizes the map. No notification banners: exceptional states (first load, history loading, retrying, failure, switching) are short words inside the timeline row, with full text available to hover, focus, and assistive technology. The normal row never shows `Fresh`, `Stale`, `Playing`, `Paused`, or `Newest`. Green age is reserved for the recent newest painted live scan. `Smooth` and `Native` remain the only view controls. Windows-first; keyboard (including Space, arrow steps, `/` for site search, Escape), focus return, forced-colors, and reduced motion remain intact; 1100px windows keep every control.
UNRESOLVED: Public Alpha still requires an owner decision on interactive unsigned-build messaging and installation instructions.

## Direction contract

THESIS: The radar owns the room. Chrome is a few solid dark instruments parked where radar users expect them, and the timeline is one thin line of truth. It refuses the category's frosted floating cards and the old glow-edged gradient chrome.

OWN-WORLD: Opaque neutral near-black surfaces, 1px 8% white hairlines, one soft ambient float shadow, with small in-surface shadows only on moving parts (the selected segment, the scrubber thumb); no blur, glass, glow, or gradients. One system blue for play, selection, and focus. Windows system UI type, sentence case, tabular numerals. Pills and MistrRadar's rounded rectangles (8px inner controls, 10 to 12px controls and rail, 16px popover, 18px sheet, 22px row); circles only for play, the scrubber thumb, the credits button, and spinners. Radar color only as data.

STORY: The operator glances down and reads time, age, and radar in one line, plays or drags the loop without lag, clicks a storm and reads its dBZ in its true color, and sees problems change that same line instead of a banner.

FIRST VIEWPORT: Full-bleed radar. Top center, a thin dBZ color-scale pill. Right edge, vertically centered, a 44px rail: Site and Recenter, then View. Bottom center, 22px up, a single-row timeline about 44px tall: a 32px blue play circle, the scan time at 15px/600 with its age, the source tag, a 3px track with real-time ticks, and the dBZ readout with its swatch.

FORM: User-pinned: the owner's own MistrRadar system, darkened and thinned; resolved as canon over roll seed f860bc31 (the roll assigned candidate 5 of 7, Glass Cockpit).

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
