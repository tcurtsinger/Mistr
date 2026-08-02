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
DIRECTION: Stormlight Cyclorama. Full-screen radar; compact top-center context bar; one left global-menu trigger; future right alert trigger absent in Alpha; stable bottom-center playback bar. Approved comps: docs/design/comps/mistr-alpha-v2-a-quiet-radar.webp and mistr-alpha-v2-c-menu-open.webp.
MEMORABLE MOMENT: Click a storm to place a precise reticle while the measured dBZ value appears in the stable playback bar.
CONSTRAINTS: No permanent sidebar, full-width rails, floating panel chains, top feature catalog, radar-tinting atmosphere, dedicated step buttons, or normal-interface prototype diagnostics. One temporary panel at a time; opening it never resizes the map or moves the playback bar. Windows-first; compact desktop labels collapse before controls; keyboard and reduced-motion support remain intact.
UNRESOLVED: Product-grade multi-site recent-scan backfill remains an engine milestone; the approved shell must state archive/live truth rather than imply a resident live loop that does not yet exist.
