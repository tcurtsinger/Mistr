---
name: Mistr
description: A full-screen stormlight radar instrument organized into four disciplined control zones.
colors:
  night: "#050506"
  stage-black: "#080B12"
  instrument-black: "rgba(8, 11, 18, 0.88)"
  cobalt-horizon: "#0A2BFF"
  rose-gather: "#D24BFF"
  rose-light: "#FF7BAE"
  dawn-wash: "#FFD7E6"
  day-white: "#F4F7FA"
  quiet-text: "#8F96A8"
  fresh: "#73E6B2"
typography:
  display:
    fontFamily: "Saira Stencil One, Arial Narrow, sans-serif"
    fontSize: "1.25rem"
    fontWeight: 400
    lineHeight: 1
    letterSpacing: "0.12em"
  title:
    fontFamily: "Barlow Semi Condensed, Segoe UI, sans-serif"
    fontSize: "1rem"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "0.06em"
  body:
    fontFamily: "Barlow Semi Condensed, Segoe UI, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.4
    letterSpacing: "normal"
  label:
    fontFamily: "Barlow Condensed, Arial Narrow, sans-serif"
    fontSize: "0.6875rem"
    fontWeight: 500
    lineHeight: 1
    letterSpacing: "0.16em"
  numeric:
    fontFamily: "Recursive Variable, Cascadia Mono, Consolas, monospace"
    fontSize: "0.8125rem"
    fontWeight: 500
    lineHeight: 1
    letterSpacing: "0.02em"
rounded:
  control: "8px"
  instrument: "16px"
  playback: "18px"
spacing:
  hairline: "4px"
  compact: "8px"
  control: "12px"
  standard: "16px"
  section: "24px"
components:
  context-bar:
    backgroundColor: "{colors.instrument-black}"
    textColor: "{colors.day-white}"
    rounded: "{rounded.instrument}"
    height: "50px"
    padding: "6px 10px"
  edge-trigger:
    backgroundColor: "{colors.instrument-black}"
    textColor: "{colors.day-white}"
    rounded: "{rounded.instrument}"
    size: "48px"
  playback-bar:
    backgroundColor: "{colors.instrument-black}"
    textColor: "{colors.day-white}"
    rounded: "{rounded.playback}"
    height: "62px"
    padding: "8px 14px"
  button-primary:
    backgroundColor: "{colors.cobalt-horizon}"
    textColor: "{colors.day-white}"
    rounded: "{rounded.control}"
    padding: "10px 14px"
---

# Design System: Mistr

## Overview

**Creative North Star: "Stormlight Cyclorama"**

Mistr treats the radar as the stage and its small control instruments as a disciplined lighting rig. Matte night surfaces, measured cobalt-to-rose-to-dawn edge light, cue lettering, and precise timecode create atmosphere without turning the application into a science-fiction dashboard. The map remains full-screen and weather remains visually sovereign.

The interface uses four stable spatial zones: radar context at the top center, global tools at the left edge, future alerts at the right edge, and time at the bottom center. These zones remain intentionally sparse. A temporary panel may grow from a side trigger, but panels never become movable windows or a collection of independent bubbles.

**Key Characteristics:**
- Full-screen radar with no permanent rail and no full-width chrome.
- Compact top-center context bar for site and radar-product controls only.
- One left-edge menu trigger and a reserved future right-edge alert trigger.
- Stable bottom-center playback bar that never shifts when panels open.
- Matte black optical glass with a narrow, bounded stormlight spectrum.

## Colors

The palette passes from black night through cobalt and rose into pale dawn, but saturated chrome remains rare and spatially controlled.

### Primary
- **Cobalt Horizon** (`#0A2BFF`): focus, selected position, and the cool origin of the cue spectrum.

### Secondary
- **Rose Gather** (`#D24BFF`): the center of the signature light field, used in continuous bounded gradients rather than scattered decoration.
- **Rose Light** (`#FF7BAE`): brief active emphasis and the transition toward dawn.
- **Dawn Wash** (`#FFD7E6`): the pale endpoint of the spectrum and a high-luminance edge, never a reading surface.

### Neutral
- **Night** (`#050506`): deepest background and empty map surround.
- **Stage Black** (`#080B12`): transient panels and structural surfaces.
- **Instrument Black** (`rgba(8, 11, 18, 0.88)`): bounded optical-glass controls.
- **Day White** (`#F4F7FA`): primary operational text.
- **Quiet Text** (`#8F96A8`): inactive controls and secondary labels.
- **Fresh** (`#73E6B2`): freshness confirmation paired with words and elapsed time.

### Named Rules

**The Weather Separation Rule.** Cyclorama color belongs to chrome, focus, and controlled seams. It is never blended over NEXRAD pixels, used to recolor the basemap, or allowed to imitate radar or warning severity.

**The Bounded Dawn Rule.** Pale pink and white are edge light and active-state material, not panel or page backgrounds.

## Typography

**Display Font:** Saira Stencil One with narrow sans-serif fallbacks
**Body Font:** Barlow Semi Condensed with Segoe UI fallback
**Numeric Font:** Recursive with Cascadia Mono and Consolas fallbacks

**Character:** Sparse stencil lettering recalls physical lighting cues and equipment labels. Operational copy and time values remain calm, compact, and immediately readable during long sessions.

### Hierarchy
- **Display:** Mistr identity and rare surface identifiers only.
- **Title:** Panel titles, site identifiers, and important state names.
- **Body:** Instructions, recovery information, and settings explanations.
- **Label:** Short uppercase cue labels with measured tracking.
- **Numeric:** Scan time, freshness age, dBZ, and playback position with tabular figures.

### Named Rules

**The Cue, Not Costume Rule.** Stencil type marks identity and sequence. Ordinary controls do not inherit it merely to look thematic.

## Layout

The map fills the window. The top-center context bar contains only controls that change the radar being viewed: site, product, elevation, and a bounded display selector when needed. It is compact rather than full width.

The site shown in radar context follows the observation that actually painted. While a different site is being acquired, the freshness region names that pending site; the top context does not claim the switch before GPU publication succeeds.

One small trigger sits near the left edge for global application tools. It may open a compact menu over the map without changing the map viewport. A future alert trigger occupies the mirrored right-edge zone only after alerts exist. Its panel follows the same rules. Side panels stop above the playback bar, scroll internally, and never appear simultaneously.

The bottom-center playback bar remains stable regardless of panel state. It contains play/pause, direct scan scrubbing, displayed scan time, freshness, playback position/state, and the active dBZ sample. It never shrinks or shifts when a side panel opens.

On compact desktop windows, labels collapse before controls. The context bar may reduce its visible labels, while the playback timeline retains the largest flexible share. Displayed time, freshness, and an active dBZ sample remain visible. The map is never converted into a dashboard grid.

### Spatial Rules
- **Top changes what:** site, product, elevation, and display context.
- **Left changes the application:** infrequent global tools and settings.
- **Right explains alerts:** absent until alerts are a real product capability.
- **Bottom controls when:** playback, measured time, freshness, and inspection value.

## Elevation & Depth

The map is the base plane. Persistent controls use bounded optical glass, a subtle black shadow, and one spectral edge reflection. Temporary side panels grow from their trigger and use matte stage black with structural dividers. Nothing else receives card elevation.

**The One Panel Rule.** At most one temporary side panel is open. It overlays the map without resizing or recentering it.

## Shapes

Persistent instruments use one continuous rounded silhouette apiece. Internal groups are separated by spacing and hairlines rather than nested capsules. Side panels use restrained corners only where they detach from the window edge. Avoid bubble chains, circular button stacks, exaggerated pills, and decorative hardware geometry.

## Components

### Radar Context Bar
- Compact and centered near the top edge.
- Contains Mistr identity plus site, product, elevation, and bounded display controls.
- Uses text, chevrons, and conventional segmented states rather than an icon toolbar.

### Menu Trigger and Panel
- One small left-edge trigger with a clear accessible name.
- Opens a compact, grouped menu over the map without resizing it.
- Alpha content remains short: site browser, map appearance, application settings, and help/about.
- The panel stops above the playback bar and scrolls internally if future content exceeds its bound.

### Alert Trigger and Panel
- Does not appear in radar-only Alpha.
- When alerts become real, one right-edge trigger exposes a dedicated alert stream.
- It cannot share content with the global menu or open beside another panel.

### Playback Bar
- One continuous glass instrument centered near the bottom.
- Contains play/pause and a directly clickable/draggable scan timeline; no dedicated visible previous/next buttons.
- Always exposes displayed scan time, freshness in words and elapsed time, and playback position/state.
- A focused timeline may respond to arrow keys one observation at a time.
- While a selected site's live history contains fewer than 20 observations, playback position remains visible and the timeline metadata adds `BUILDING n/20`. Background polling does not replace freshness age or disable already-resident playback.

### Inspection Reticle
- Appears after a deliberate map click.
- Uses a precise crosshair/ring on the map while the dBZ value appears in the playback bar.
- Recomputes the value at the same geographic point whenever a different observation paints; a prior scan's value is never carried forward as current.
- Dismisses without leaving a persistent tooltip island.

### Radar Framing
- Initial load, successful site changes, and recenter fit the selected radar's measured coverage into the available map surface.
- Framing scales with the desktop window instead of falling back to a near-national view on 4K displays.
- User pan and zoom remain unconstrained after the initial fit.

### Status and Recovery
- Loading, partial history, stale/retrying, graphics recovery, and failure states use established regions in the context or playback bar.
- The last trustworthy painted observation remains visible whenever safe.
- A failed first live acquisition names the unavailable site; a recoverable background failure says `RETRYING SITE` rather than implying that valid painted radar disappeared.
- Opening a temporary panel moves keyboard focus into its first action. Escape, selection, or explicit close returns focus to the trigger that opened it.
- Windows forced-colors mode uses a system-color outline rather than relying on chrome glow or box shadow for focus.

## Do's and Don'ts

### Do
- **Do** let radar remain the largest, brightest, and most information-dense element.
- **Do** preserve one stable responsibility for each of the four spatial zones.
- **Do** keep the playback bar stationary when a menu opens.
- **Do** keep transient menus short, grouped, and mutually exclusive.
- **Do** use the stormlight spectrum as a continuous edge reflection or focus transition.
- **Do** preserve familiar play, pause, timeline, zoom, and selector affordances.

### Don't
- **Don't** turn the top context bar into general navigation or a feature catalog.
- **Don't** add chains of side buttons; each side has at most one trigger.
- **Don't** show an alert trigger before alerts exist.
- **Don't** resize or recenter the map when a side panel opens.
- **Don't** split the playback bar into unrelated pills or move it around panel state.
- **Don't** overlay gradients, blur, or glow on radar data.
- **Don't** expose prototype phases, benchmarks, fixture controls, or engineering diagnostics in the normal surface.
