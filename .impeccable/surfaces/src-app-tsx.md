---
version: 1
slug: "src-app-tsx"
primary_target: "src/App.tsx"
related_targets: ["src/ui/RadarChrome.tsx","src/styles.css"]
---

SCOPE: Production radar surface for the installable Mistr Alpha; visitor mode is Operate.
AUDIENCE: The owner and experienced storm enthusiasts monitoring live storms for long desktop sessions.
TASK: Select one NEXRAD site, inspect base reflectivity without camera/playback lag, scrub recent measured scans, and always know displayed time, freshness, and playback state.
PROOF: The existing decoded Level II custom layer, bounded resident GPU frames, paint receipts, live publication state, and recovery diagnostics remain the truth source.
DIRECTION: Stormlight Cyclorama, quiet-instrument refinement. Full-screen radar; tightly content-sized top-center context bar with the single canonical searchable site selector; one small left global-menu trigger; future right alert trigger absent in Alpha; compact bounded bottom-center playback bar. Fixed Alpha product/tilt facts live in About rather than inert header segments. The menu uses a conventional internal close control, no site-picker duplicate, no decorative vertical accent rail, and restrained Barlow typography rather than stencil lettering. Approved comps remain composition references only: docs/design/comps/mistr-alpha-v2-a-quiet-radar.webp and mistr-alpha-v2-c-menu-open.webp; their larger chrome, stencil typography, and menu accent are superseded by the current design contract.
MEMORABLE MOMENT: Click a storm to place a precise reticle while the measured dBZ value appears in the stable playback bar.
CONSTRAINTS: No permanent sidebar, full-width rails, floating panel chains, top feature catalog, duplicate site picker, inert product/elevation controls, radar-tinting atmosphere, dedicated step buttons, ornamental stencil type, menu accent rail, visible engineering alignment markers, or normal-interface prototype diagnostics. One temporary panel at a time; opening it never resizes the map or moves the playback bar. Before first paint, show plain-language progress instead of fake timeline truth. Windows-first; compact desktop labels collapse before controls; keyboard and reduced-motion support remain intact.
UNRESOLVED: Public Alpha still requires an owner decision on interactive unsigned-build messaging and installation instructions. Controlled Windows sleep/wake and clean-machine installer validation passed. No new product surface is implied by the remaining release decision.
