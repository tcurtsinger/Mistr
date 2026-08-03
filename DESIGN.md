---
name: Mistr
description: A full-screen stormlight radar instrument organized around a compact top toolbar and bottom playback control.
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
  recent-live: "#73E6B2"
  scan-cyan: "#4BDCFF"
typography:
  display:
    fontFamily: "Barlow Semi Condensed, Segoe UI, sans-serif"
    fontSize: "1rem"
    fontWeight: 600
    lineHeight: 1
    letterSpacing: "0.06em"
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
  fine: "2px"
  small: "6px"
  control: "8px"
  instrument: "12px"
  playback: "14px"
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
    height: "44px"
    padding: "1px 5px"
  playback-bar:
    backgroundColor: "{colors.instrument-black}"
    textColor: "{colors.day-white}"
    rounded: "{rounded.playback}"
    height: "44px"
    padding: "4px 9px"
  button-primary:
    backgroundColor: "{colors.cobalt-horizon}"
    textColor: "{colors.day-white}"
    rounded: "{rounded.control}"
    padding: "10px 14px"
---

# Design System: Mistr

## Overview

**Creative North Star: "Stormlight Cyclorama"**

Mistr treats the radar as the stage and its small control instruments as a disciplined lighting rig. Matte night surfaces, measured cobalt-to-rose-to-dawn edge light, quiet condensed typography, and precise timecode create atmosphere without turning the application into a science-fiction dashboard. The map remains full-screen and weather remains visually sovereign.

The interface uses two stable spatial zones: radar tools at the top center and observation time at the bottom center. These zones remain intentionally sparse. A temporary site or view panel may grow from its toolbar control, but panels never become movable windows or a collection of independent bubbles.

**Key Characteristics:**
- Full-screen radar with no permanent rail and no full-width chrome.
- Compact top-center icon-led toolbar for site, recenter, and radar-view controls.
- No left application menu or placeholder alert trigger in Alpha.
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
- **Scan Cyan** (`#4BDCFF`): transport position, displayed time, and updating state; it identifies instrument activity rather than weather severity.

### Neutral
- **Night** (`#050506`): deepest background and empty map surround.
- **Stage Black** (`#080B12`): transient panels and structural surfaces.
- **Instrument Black** (`rgba(8, 11, 18, 0.88)`): bounded optical-glass controls.
- **Day White** (`#F4F7FA`): primary operational text.
- **Quiet Text** (`#8F96A8`): inactive controls and secondary labels.
- **Recent Live** (`#73E6B2`): the numeric age of the newest painted live scan while it remains recent. Historical, archive, and old latest-live ages use Day White; the number itself and accessible text keep color from carrying truth alone.

### Named Rules

**The Weather Separation Rule.** Cyclorama color belongs to chrome, focus, and controlled seams. It is never blended over NEXRAD pixels, used to recolor the basemap, or allowed to imitate radar or warning severity.

**The Operational Context Rule.** Land and water remain the base plane beneath radar. Local streets, buildings, railways, water names, and secondary places also stay below radar. Only restrained coastlines, major routes, boundaries, and important place labels remain above it with enough light-and-dark contrast to survive changing radar colors. Global radar opacity is not used to make the map visible, and context is never allowed to become a luminous wireframe.

**The Bounded Dawn Rule.** Pale pink and white are edge light and active-state material, not panel or page backgrounds.

## Typography

**Display Font:** Barlow Semi Condensed with Segoe UI fallback
**Body Font:** Barlow Semi Condensed with Segoe UI fallback
**Numeric Font:** Recursive with Cascadia Mono and Consolas fallbacks

**Character:** A single condensed sans-serif family keeps identity and equipment labels precise without ornamental letterforms. Operational copy and time values remain calm, compact, and immediately readable during long sessions.

### Hierarchy
- **Display:** Mistr identity and rare surface identifiers only.
- **Title:** Panel titles, site identifiers, and important state names.
- **Body:** Instructions, recovery information, and settings explanations.
- **Label:** Short uppercase cue labels with measured tracking.
- **Numeric:** Displayed scan time, frame age, and dBZ with tabular figures.

### Named Rules

**The Instrument Type Rule.** Typography earns character through proportion, weight, and spacing rather than novelty letterforms. Identity may be distinctive, but operational copy always reads first.

## Layout

The map fills the window. In Alpha, the top-center toolbar contains Mistr identity followed by a site icon that opens the canonical searchable site picker, a direct recenter icon, and an eye icon that opens the real two-state radar-view popup. The popup's visible labels are exactly `Smooth` and `Native`, with `Smooth` as the default, and the eye control exposes the tooltip `Radar View`. Base reflectivity at the lowest usable tilt is fixed Alpha scope, so product and elevation remain documented facts rather than inert control-like chrome.

`Smooth` filters the spatial presentation of one measured observation. It does not interpolate between scan times, generate a frame, change decoded gates, or change the dBZ returned by inspection. `Native` shows the exact polar gates with nearest sampling. Changing this display choice therefore leaves the selected observation, site, measured time, numeric age, playback position, and painted-frame receipt unchanged.

Reflectivity uses a shared display-only weak-return curve in both modes. Non-positive returns are visually suppressed, positive returns rise through a deliberately quiet near-linear fade to full opacity at 20 dBZ, and stronger operational colors remain unchanged. This treatment is never described as clutter removal: a visually hidden gate remains a valid measured gate, and inspection continues to report its native status and exact dBZ.

The site control's accessible name and tooltip follow the observation that actually painted. While a different site is being acquired, a compact visible acquisition indicator and notice name both the radar that remains displayed and the pending site; the toolbar never claims the switch before GPU publication succeeds.

There is no left-edge application menu or About panel in Alpha. Recenter is a direct toolbar command, and Mistr does not reserve visible controls for capabilities that do not yet exist. The site and view panels overlay the map, stay anchored to their originating icons, and never appear simultaneously.

The bottom-center playback bar remains stable regardless of panel state. During normal operation it contains play/pause, direct scan scrubbing, the displayed scan timestamp, numeric frame age, and the active dBZ sample. It does not display the words `Fresh`, `Stale`, `Playing`, `Paused`, or `Newest`. Exceptional preparation, loading, graphics recovery, and error notices temporarily use this established region without pretending normal playback truth.

On compact desktop windows, the icon-led toolbar retains its controls and accessible tooltips while the playback timeline keeps the largest flexible share. Displayed time, numeric age, and an active dBZ sample remain visible. The map is never converted into a dashboard grid.

### Spatial Rules
- **Top changes where and how radar is drawn:** site selection, recenter, and the real `Smooth`/`Native` spatial display choice in Alpha; other controls appear only after they become real capabilities.
- **Sides stay clear:** no application menu, placeholder alert control, or control chain competes with radar.
- **Bottom controls when:** playback, measured time, numeric age, and inspection value.

## Elevation & Depth

The map is the base plane. Persistent controls use bounded optical glass, a subtle black shadow, and one spectral edge reflection. Temporary toolbar panels grow from their trigger and use matte stage black with structural dividers. Nothing else receives card elevation.

**The One Panel Rule.** At most one temporary toolbar panel is open. It overlays the map without resizing or recentering it.

## Shapes

Persistent instruments use one continuous rounded silhouette apiece. Internal groups are separated by spacing and hairlines rather than nested capsules. Toolbar panels use restrained corners where they detach from their anchor. Avoid bubble chains, circular button stacks, exaggerated pills, and decorative hardware geometry.

Chrome is content-sized rather than viewport-filling. The toolbar and playback bar remain only as long and thick as their operational contents require. Temporary panels use a plain structural border without a decorative vertical accent rail.

## Components

### Radar Toolbar
- Compact and centered near the top edge.
- Wraps its contents closely rather than claiming unnecessary horizontal or vertical space.
- Uses an icon-led, extensible sequence: `Mistr | site icon, recenter icon | eye icon`.
- The site icon opens the single canonical searchable site browser; it has a meaningful accessible name that includes the painted site and a tooltip such as `Radar Site · KTLX`.
- Opens a searchable list of all provider-qualified operational WSR-88D sites, including Alaska, Hawaii, Guam, and Puerto Rico. Test, decommissioned, TDWR, and provider-absent sites are omitted.
- Recenter is a direct icon command with a meaningful accessible name rather than a menu row.
- The eye icon uses the tooltip `Radar View`, gives its selected mode in its accessible name, and opens a popup containing only the visible labels `Smooth` and `Native`. These describe presentation only, never a new or intermediate observation.
- Icon controls keep at least a 40 by 40 CSS-pixel target, visible keyboard focus, and non-native tooltips that appear on hover or focus without becoming the only source of essential truth.

### Toolbar Panels
- Site search opens focused on its search field; view opens focused on the selected `Smooth` or `Native` option.
- Escape, selection, outside interaction, or reopening the trigger dismisses the panel and returns focus appropriately.
- Only one toolbar panel is open; it overlays the map without moving the map or bottom bar.
- The view popup supports conventional radio-menu keyboard behavior. The searchable site browser remains a nonmodal dialog rather than a long menu.

### Playback Bar
- One continuous glass instrument centered near the bottom.
- Bounded to the width needed by time, transport, timeline, age, and inspection truth rather than spanning most of a wide viewport.
- Contains play/pause and a directly clickable/draggable scan timeline; no dedicated visible previous/next buttons.
- During normal operation, exposes the displayed scan timestamp and numeric frame age without visible `Fresh`, `Stale`, `Playing`, `Paused`, or `Newest` labels. Play/pause remains clear through the familiar transport icon and accessible name.
- The age is green only for the recent newest painted live scan. A historical or archive scan, and a latest-live scan older than the accepted recency threshold, uses white. The exact number and accessible label preserve truth without relying on color alone.
- A focused timeline may respond to arrow keys one observation at a time.
- While safe preceding observations load, already-resident transport remains available. Loading or one-frame waiting uses a compact exceptional notice rather than permanent normal-state metadata, and background history work never replaces numeric age or disables usable resident playback.

### Inspection Reticle
- Appears after a deliberate map click.
- Uses a deliberately tiny crosshair/ring that marks the sampled point without obscuring nearby radar structure; the dBZ value appears in the playback bar.
- Recomputes the value at the same geographic point whenever a different observation paints; a prior scan's value is never carried forward as current.
- Dismisses without leaving a persistent tooltip island.

### Radar Framing
- Initial load, successful site changes, and recenter fit the selected radar's measured coverage into the available map surface.
- Framing scales with the desktop window instead of falling back to a near-national view on 4K displays.
- User pan and zoom remain unconstrained after the initial fit.

### Operational Map Context
- The radar is inserted at an explicit context boundary rather than beneath every symbol. Local roads, paths, railways, buildings, water names, local road names, towns, and secondary places remain below it.
- Coastlines, country and state boundaries, motorways, primary/trunk routes, major route identifiers, states, countries, and important city labels sit above radar using cool neutral contrast rather than Stormlight color.
- Regional framing shows motorways first and delays primary/trunk density until closer zoom. At detailed zooms, restrained major-road casing and label halos remain legible across dark, green, yellow, red, and weak-return backgrounds. Neither treatment lowers the entire radar layer's opacity.
- Local road names are title case, appear only at close zoom, and remain dim below radar. Important city labels receive more visual authority than route lines; missing sprite icons are not part of their presentation.
- The map uses the existing bundled OpenFreeMap source graph; visual context does not introduce another provider or network path.

### Status and Recovery
- Preparation, partial-history loading, site acquisition, graphics recovery, and failures use established notice or playback regions rather than adding permanent status words to the normal bar.
- Before the first painted scan, the playback area becomes a dedicated preparation state with plain-language progress. It does not show `0 / 0`, `PAUSED`, an active-looking timeline, or an inspection prompt.
- While a new site loads, the site icon shows a restrained acquisition indicator and a compact notice names both the radar that remains displayed and the pending live site; existing resident playback remains available until the atomic replacement begins.
- The last trustworthy painted observation remains visible whenever safe.
- A failed first live acquisition names the unavailable site; a recoverable background failure states that the painted radar remains displayed while retry proceeds.
- Opening a temporary panel moves keyboard focus into its first action. Escape, selection, or trigger reactivation returns focus to the control that opened it.
- Windows forced-colors mode uses a system-color outline rather than relying on chrome glow or box shadow for focus.

## Do's and Don'ts

### Do
- **Do** let radar remain the largest, brightest, and most information-dense element.
- **Do** preserve one stable responsibility for the top toolbar and bottom playback zones.
- **Do** keep the playback bar stationary when a toolbar panel opens.
- **Do** keep the site and view panels focused, anchored, and mutually exclusive.
- **Do** use the stormlight spectrum as a continuous edge reflection or focus transition.
- **Do** preserve familiar play, pause, timeline, zoom, and selector affordances.

### Don't
- **Don't** add toolbar icons for capabilities that do not yet exist.
- **Don't** restore a left application menu or reserve side controls for future features.
- **Don't** resize or recenter the map when a toolbar panel opens.
- **Don't** add visible `Fresh`, `Stale`, `Playing`, `Paused`, or `Newest` labels to the normal playback bar.
- **Don't** split the playback bar into unrelated pills or move it around panel state.
- **Don't** overlay gradients, blur, or glow on radar data.
- **Don't** expose prototype phases, benchmarks, fixture controls, or engineering diagnostics in the normal surface.
