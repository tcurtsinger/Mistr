---
name: Mistr
description: Full-bleed desktop radar with a few solid near-black instruments and one thin line of measured time.
colors:
  map: "#0c0c0c"
  surface: "#16181b"
  raise: "#202327"
  raise-hover: "#2a2e33"
  raise-2: "#3a3f46"
  line: "rgba(255, 255, 255, 0.08)"
  line-strong: "rgba(255, 255, 255, 0.15)"
  text: "#eef1f4"
  text-2: "#a7aeb6"
  text-3: "#858d96"
  accent: "#0a84ff"
  accent-ink: "#5eaaff"
  accent-wash: "rgba(10, 132, 255, 0.16)"
  on-accent: "#ffffff"
  recent-live: "#6fdca6"
  warn-ink: "#ffcf7a"
  bad: "#ff7a70"
typography:
  title:
    fontFamily: "Segoe UI Variable Display, Segoe UI, -apple-system, BlinkMacSystemFont, system-ui, sans-serif"
    fontSize: "17px"
    fontWeight: 600
    lineHeight: 1.25
  clock:
    fontFamily: "Segoe UI Variable Display, Segoe UI, -apple-system, BlinkMacSystemFont, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 600
    lineHeight: 1
    letterSpacing: "-0.005em"
    fontFeature: "tnum"
  body:
    fontFamily: "Segoe UI Variable Text, Segoe UI, -apple-system, BlinkMacSystemFont, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.4
  strong:
    fontFamily: "Segoe UI Variable Text, Segoe UI, -apple-system, BlinkMacSystemFont, system-ui, sans-serif"
    fontSize: "13.5px"
    fontWeight: 600
    lineHeight: 1.3
  readout:
    fontFamily: "Segoe UI Variable Text, Segoe UI, -apple-system, BlinkMacSystemFont, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 600
    lineHeight: 1
    fontFeature: "tnum"
  caption:
    fontFamily: "Segoe UI Variable Text, Segoe UI, -apple-system, BlinkMacSystemFont, system-ui, sans-serif"
    fontSize: "12.5px"
    fontWeight: 400
    lineHeight: 1.35
    fontFeature: "tnum"
  label:
    fontFamily: "Segoe UI Variable Text, Segoe UI, -apple-system, BlinkMacSystemFont, system-ui, sans-serif"
    fontSize: "11px"
    fontWeight: 600
    lineHeight: 1.2
    fontFeature: "tnum"
  tick:
    fontFamily: "Segoe UI Variable Text, Segoe UI, -apple-system, BlinkMacSystemFont, system-ui, sans-serif"
    fontSize: "10px"
    fontWeight: 400
    lineHeight: 1.2
    fontFeature: "tnum"
rounded:
  swatch: "3px"
  control: "8px"
  field: "10px"
  rail: "12px"
  popover: "16px"
  sheet: "18px"
  bar: "22px"
  pill: "999px"
spacing:
  tight: "6px"
  inner: "8px"
  cluster: "10px"
  edge: "14px"
  bar-lift: "22px"
  rail-w: "44px"
  bar-h: "44px"
components:
  playback-bar:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.bar}"
    height: "44px"
    width: "min(800px, calc(100vw - 28px))"
    padding: "0 14px 0 6px"
  playback-toggle:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.on-accent}"
    rounded: "{rounded.pill}"
    size: "32px"
  playback-toggle-disabled:
    backgroundColor: "{colors.raise-2}"
    textColor: "{colors.text-3}"
  source-tag:
    backgroundColor: "rgba(255, 255, 255, 0.09)"
    textColor: "{colors.text}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: "1px 8px"
    width: "66px"
  source-tag-pending:
    backgroundColor: "{colors.accent-wash}"
    textColor: "{colors.accent-ink}"
  rail-group:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.rail}"
    width: "44px"
  rail-button:
    backgroundColor: "transparent"
    textColor: "{colors.text}"
    size: "44px"
  rail-button-hover:
    backgroundColor: "{colors.raise-hover}"
  rail-button-open:
    backgroundColor: "{colors.accent-wash}"
    textColor: "{colors.accent-ink}"
  chrome-tooltip:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.control}"
    padding: "5px 10px"
  color-scale:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text-2}"
    rounded: "{rounded.pill}"
    padding: "6px 14px 5px"
  site-sheet:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.sheet}"
    width: "min(340px, calc(100vw - 100px))"
  site-search:
    backgroundColor: "{colors.raise}"
    textColor: "{colors.text}"
    rounded: "{rounded.field}"
    height: "38px"
    padding: "0 40px 0 36px"
  source-option-active:
    backgroundColor: "{colors.raise}"
    textColor: "{colors.text}"
    rounded: "{rounded.field}"
    height: "40px"
    padding: "6px 10px"
  view-popover:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.popover}"
    width: "232px"
    padding: "10px"
  segmented:
    backgroundColor: "{colors.raise}"
    rounded: "{rounded.field}"
    height: "36px"
    padding: "3px"
  segmented-selected:
    backgroundColor: "{colors.raise-2}"
    textColor: "{colors.text}"
    rounded: "{rounded.control}"
---

# Design System: Mistr

## Overview

**Creative North Star: "The Radar Owns the Room"**

Mistr is a full-bleed radar with a few solid, dark instruments parked where radar users expect them. It adapts the owner's MistrRadar system, the standard dark radar-app arrangement found in CARROT Weather and Zoom Earth, but uses neutral near-black instead of teal charcoal and a thin single-row timeline instead of a tall timeline card. The radar is the only large, bright, colourful thing on screen. The chrome is opaque, quiet, and small. It uses one blue for play, selection, and focus. Everything else is neutral grey or a semantic ink that carries a specific state.

At rest the screen has four instruments: a thin dBZ colour-scale strip at top centre, the folded map credits at top right, a 44px tool rail vertically centred on the right edge, and one 44px playback row 22px above the bottom edge. Only one temporary surface opens at a time, the site sheet or the view popover. It opens from its rail control and never resizes or recentres the map. Status never arrives as a banner. Loading, retrying, switching, and failure are a few words in the timeline row, and the full account is available on hover, on focus, and to assistive technology.

The system rejects frosted or translucent floating cards, glow, decorative gradients, and the retired "Stormlight Cyclorama" glass with its cobalt-to-rose edge light. Radar colours appear in the chrome only as data.

**Key Characteristics:**
- Full-bleed radar over a quiet matte-charcoal basemap. Chrome takes up very little of the screen.
- Solid near-black surfaces, 1px 8% white hairlines, and one soft float shadow. No blur.
- One system blue (`#0a84ff` family). Green, amber, and coral appear only as state inks.
- Windows system UI type, sentence case, and tabular numerals wherever a number changes.
- Fixed geometry. Changing values never move the track or resize the row.
- Pills and gently rounded rectangles. Circles only for transport and status marks.

## Colors

A neutral near-black ramp carries every surface, one system blue carries intent, and three semantic inks carry state. Radar colour lives only in the data.

### Primary
- **System Blue** (accent): fills the play circle. It is also the focus outline (2px, 2px offset), the search-field focus border, the text caret, and the scrubber thumb's halo ring.
- **Blue Ink** (accent-ink): blue text and line work on dark surfaces. Used for the open rail icon, the current site's ID and check mark in the site list, the pending source tag, info status words, and spinner arcs.
- **Blue Wash** (accent-wash): the 16% tint behind an open rail button and a pending source tag, the search focus ring, and the unlit track of spinners.
- **On Blue** (on-accent): the play and pause glyph, and the white scrubber thumb.

### Tertiary (state inks)
- **Recent Live Green** (recent-live): the frame age (600 weight) only while the painted scan is the newest live scan and less than 10 minutes old. Historical, archive, and older latest-live ages use Secondary Text.
- **Caution Amber** (warn-ink): the age of a live scan that is being retried, and caution status words for failures the painted radar survives (retrying, National unavailable, basemap unavailable, scan change failed).
- **Failure Coral** (bad): error status words, the first-load failure title, and its alert icon.

### Neutral
- **Map Black** (map): the app background and empty map surround.
- **Instrument Black** (surface): every persistent instrument and temporary panel: the playback row, rail groups, colour strip, credits, tooltips, sheet, and popover.
- **Raised** (raise): wells inside surfaces, including the search field, segmented-control track, active list row, and icon-button hover.
- **Raised Hover** (raise-hover): rail-button hover and credits-button hover.
- **Raised High** (raise-2): the selected segment, the disabled play circle, and the scrollbar thumb.
- **Hairline** (line): the 1px border on every surface, the dividers between rail buttons and list groups, and the bar divider.
- **Strong Hairline** (line-strong): the search-field border and the dashed not-yet-loaded part of the track.
- **Primary Text** (text): clock, tag, readout, titles, and site IDs.
- **Secondary Text** (text-2): dates, neutral ages, place names, captions, group labels, colour-strip end labels, and the credits icon stroke.
- **Tertiary Text** (text-3): time zone, placeholders, the `Inspect` hint, pending `--.- dBZ`, colour-strip ticks, and disabled controls.

### Named Rules
**The One Blue Rule.** Blue means play, selection, or focus, and nothing else. No second accent hue is allowed in the chrome.

**The Data Colour Rule.** Radar reflectivity colours appear in the chrome only as data: the colour-scale strip, which is drawn from the renderer's own palette with weak returns faded as they are on the map, and the opaque dBZ swatch beside an inspected value. Chrome colour is never blended over radar pixels, never recolours the basemap, and never imitates radar or warning severity.

**The Earned Green Rule.** Green age is reserved for the recent newest painted scan of the active source, even when the newest National mosaic is older than a prior Site scan. The number and its accessible label carry the same truth, so colour never carries it alone.

**The Operational Context Rule.** Land and water are the base plane beneath radar, in close matte charcoal tones. Local streets, paths, buildings, railways, water names, local road names, towns, and secondary places also stay below radar. Only country and state boundaries, motorways, trunk and primary routes, major route identifiers, states, countries, and important city labels sit above it. They use cool neutral contrast strong enough to survive changing radar colours. Split water polygons are never outlined. Motorway, trunk, and primary segments share one continuous zoom treatment instead of swapping layers at fixed zooms. At far regional zoom only the coherent interstate and U.S.-highway networks remain, and state and unnetworked routes fade in with the detailed road graph. Global radar opacity is never the readability fix, and context never becomes a luminous wireframe.

## Typography

**Title Font:** Segoe UI Variable Display (with Segoe UI, -apple-system, system-ui fallbacks)
**Body Font:** Segoe UI Variable Text (with the same fallbacks)

**Character:** Native Windows interface type. It should read as a well-made Windows app, not a branded dashboard. The optical Display cut is used only at the two largest sizes. Every interface string is sentence case, and nothing is tracked uppercase.

### Hierarchy
- **Title** (600, 17px, 1.25): the site sheet's `Radar` heading, the only heading in the chrome.
- **Clock** (600, 15px, 1, -0.005em, tabular): the displayed scan time, `12:00:34 AM`. It is the anchor of the playback row.
- **Body** (400, 14px, 1.4): the root size and the search field.
- **Strong** (600, 13.5px): site IDs in the list, `National`, and the first-load title. Segmented labels use 600 13px.
- **Readout** (600, 13px, 1, tabular): the dBZ value. Its hint, pending, and status forms drop to 500 weight in Tertiary or Secondary Text.
- **Caption** (400, 12.5px, tabular): the short date, neutral age, place names (13px), view captions (12px), and first-load detail. The time zone is 12px in Tertiary Text.
- **Label** (600, 11px, 1.2, tabular): timeline hover time and status words. The source tag is 600 11.5px/1.45, colour-strip end labels are 400 11px, and tooltips are 500 12.5px.
- **Tick** (400, 10px, tabular): colour-strip dBZ ticks.

### Named Rules
**The Tabular Rule.** Every number that changes (clock, age, dBZ, strip ticks, hover time, loading counts) uses tabular numerals, so a changing digit never nudges its neighbours.

**The Sentence Case Rule.** Labels, status words, and inspection states are written the way they are said: `Out of range`, `No coverage`, `Loading 2/60`, `Retrying KTLX`. Uppercase is used only for station IDs.

## Layout

The map fills the window, and the chrome floats over it with pointer events limited to the instruments. The shared edge inset is 14px (`--gap`).

- **Top centre:** the colour-scale pill, 14px from the top.
- **Top right:** the map credits, folded behind a 26px (i) button that still opens them. MapLibre's first-drag auto-open is suppressed, so the credits start folded.
- **Right edge, vertically centred:** the tool rail. The first group holds Site and Recenter, the second holds View, with 10px between groups. Rail tools exist only for real product controls.
- **Bottom centre:** the playback row, 44px tall and `min(800px, 100vw − 28px)` wide, 22px above the bottom edge.
- **Site sheet:** opens left of the rail (right inset 14 + 44 + 14px). It starts 34px below the top inset, clearing the credits, and ends 14px above the playback row. It is 340px wide.
- **View popover:** 232px wide, 10px left of the rail, bottom-aligned with the View group.

Inside the playback row, from left to right: play circle, clock with its zone (or, for a scan from another day, its date in the zone's place), age, source tag, flexible timeline, divider, and the dBZ cell. Time, age, and tag sit together in one group that holds a minimum of 292px (244px once the zone hides at 1000px), so a changing second, hour, age, date, or source never moves the track and any spare room falls once before it. The dBZ cell is a fixed 104px with `contain: layout`. The timeline takes all remaining width, with a 140px minimum.

Spacing rhythm: 6px tight pairs, 8px inner gaps, 10px between row clusters and rail groups, 12px within list rows, and 14px edges. At 1000px the time zone is hidden and the clock slot narrows to 86px. At 860px the date is hidden. The body minimum is 720 × 540px. A 1100 × 700 window keeps every control.

### Named Rules
**The Fixed Slot Rule.** Time, age, tag, and readout each hold a fixed minimum width. A changing second, hour, age, source, or dBZ value never moves the track or resizes the row.

**The No Banner Rule.** No notification appears above the playback row. Exceptional states are short words in the timeline's label lane. The row itself changes only before the first paint (the first-load row) and on first-load failure.

**The One Panel Rule.** At most one sheet or popover is open. It overlays the map without resizing or recentring it, and the playback row never moves when a panel opens.

## Elevation & Depth

The map is the base plane. Every instrument floats over it at one height. The instruments are opaque Instrument Black with a 1px hairline and the same soft two-layer shadow. There is no blur and no translucency, because blur would redraw with every radar frame and let map labels bleed into text. Inside a surface, depth is tonal: wells step up to Raised, and the selected segment steps up to Raised High with a tiny contact shadow.

### Shadow Vocabulary
- **Float** (`box-shadow: 0 10px 30px rgba(0, 0, 0, 0.42), 0 1px 3px rgba(0, 0, 0, 0.36)`): every persistent instrument, tooltip, and panel.
- **Contact** (`box-shadow: 0 1px 2px rgba(0, 0, 0, 0.35)`): the selected segment only.
- **Thumb** (`box-shadow: 0 1px 4px rgba(0, 0, 0, 0.5), 0 0 0 4px rgba(10, 132, 255, 0.3)`): the scrubber thumb. On focus the spread ring becomes solid System Blue.
- **Reticle** (`filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.95))`): keeps the white inspection reticle legible over any radar colour.

### Named Rules
**The Solid Chrome Rule.** Chrome is opaque. There is no backdrop blur, no glass, no glow, and no decorative gradient.

**The One Float Rule.** All instruments share one shadow and one height. Nothing is lifted above its peers.

## Shapes

The chrome uses pills and gently rounded rectangles, and radius scales with the size of the surface. The playback row (22px), colour strip, source tag, and compact credits are full pills. The rail groups use 12px. Buttons inside a group take an 11px radius only on the ends that touch the group corners and are square in between. Fields, list rows, icon buttons, and the segmented track use 10px. Tooltips and segments use 8px, the view popover 16px, and the site sheet 18px. The dBZ swatch is a 10px square with a 3px radius.

Circles are reserved for the play circle, the scrubber thumb, the credits (i) button, spinners, and the inspection reticle ring. Icons share one construction: a 24px grid, 1.75 stroke, and round caps and joins. They render at 20px in the rail and sheet, 16px in the play circle, and 15 to 18px in fields and readouts. The timeline is a 3px line. Its clock ticks are 1px × 9px at 34% white, and the loaded span is 24% white.

## Components

### Playback Row (signature)
- **Character:** one thin line of truth. Reading left to right tells you time, age, which radar, where you are in the loop, and what you clicked.
- **Play circle:** 32px System Blue with a white 16px glyph. Hover brightens it 12%, and press scales it to 0.94 over 120ms. When disabled it turns Raised High with a Tertiary glyph. Transport enables only when at least two observations are resident. While National prepares sharp playback it shows pause and acts as cancel.
- **Clock and age:** `12:00:34 AM` in 12-hour time with seconds, followed by the time-zone abbreviation. A short `Sep 29` date precedes the time only when the scan is not from today. The age follows as `1m 02s ago` (`45s`, `1h 05m`, `2d`) in its state ink.
- **Source tag:** a pill naming the painted radar, either a station ID or `National`. It is at least 66px wide with centred text, so switching sources never moves the track. While a switch is pending it turns blue-washed and reads `KTLX → KFWS`, with the arrow in Secondary Text. The tag follows what painted, never what was merely requested.
- **Timeline:** a native range input over a 3px track. Clock ticks mark the finest interval (15, 30, 60, or 120 minutes) that keeps the count to 12 or fewer. The thumb is a 12px white circle with a blue halo. While history loads, the track spans the full history capacity: the loaded span fills from the newest end and the rest is a dashed Strong Hairline, so the loop grows back in time instead of rescaling. There are no step buttons.
- **Label lane:** the band above the track. Hovering the track shows that scan's short time (`11:42 PM`) above the pointer. When no hover is active, the lane holds the status word. Info words sit at left in Blue Ink with a 9px spinner (`Loading 2/60`, `Loading KFWS`, `Restoring display`, `Preparing playback`). Caution words sit at right in Amber, and error words sit at right in Coral. The status word is focusable, and hover or focus opens the full message in an above-tooltip.
- **dBZ cell:** a fixed 104px cell after a 1px × 20px divider. At rest it shows the crosshair icon and `Inspect` in Tertiary Text. While pending it shows `--.- dBZ`. A value such as `33.5 dBZ` gets an opaque swatch of its true radar colour. Settled states read `Out of range`, `No coverage`, `No data`, `Below threshold`, `Range folded`, or `Unavailable`.
- **Never shows** `Fresh`, `Stale`, `Playing`, `Paused`, or `Newest`.

### First-Load Row
- Before the first paint, the same pill shows a 16px blue spinner, the requested source in Strong (`KTLX` or `National`), and plain progress in Caption (`Loading current scan`, `Loading history 3/20`, `Opening radar history`, `Preparing the display`). It never shows `0 / 0`, a live-looking timeline, or an inspection prompt.
- On failure the spinner becomes a Coral alert icon, the title reads `Radar unavailable` in Coral, and the full message wraps inside a row that may grow taller.

### Tool Rail
- **Style:** 44px square buttons stacked in Instrument Black groups, with 20px Primary Text icons and a hairline between buttons.
- **States:** hover changes the background to Raised Hover. An open panel's trigger gets Blue Wash and Blue Ink. Disabled buttons use Tertiary Text at 55% opacity. The focus ring is inset 2px.
- **Tools:** Radar (radar-sweep icon; accessible name gives the painted source and any pending one), Recenter (fit-frame icon), and View (eye). During acquisition a 9px spinning blue ring appears at the Radar button's top-right corner.
- **Keyboard:** one tab stop. Arrow keys, Home, and End move between enabled tools.

### Rail Tooltips
- Instrument Black, 8px radius, 500 12.5px Primary Text, and 5px × 10px padding. They open to the left of the rail with a 10px gap. They appear after 400ms of mouse hover, or at once on keyboard focus, and not when focus returns after a click. Examples: `Radar · KAMA`, `Recenter`, `Radar view · Smooth`. They are suppressed while the button's panel is open.

### Site Sheet
- A non-modal dialog with an 18px radius, headed `Radar` (Title) with a 36px close icon button.
- **Search field:** a 38px Raised well with a Strong Hairline border and 10px radius. A search icon sits at left and a clear button appears once text is entered. The placeholder is `Search site ID or city`. Focus changes the border to System Blue and adds a 3px Blue Wash ring. It is a combobox: arrow keys move the active row, Enter picks it, and `/` anywhere opens the sheet.
- **List order:** `National · CONUS mosaic` first, then `Recent` (the last five sites chosen), then `All sites`. Group labels are 600 13px Secondary Text, and groups are separated by hairlines. A search flattens the list to matches, and National matches `national`, `conus`, `mrms`, and `mosaic`.
- **Rows:** 40px minimum height with a 10px radius. The ID is in Strong, with a minimum width of 42px, and the place name is in Secondary Text, truncated with an ellipsis. The active row gets a Raised fill. The painted source's ID turns Blue Ink and gets a trailing blue check mark.

### View Popover
- A 232px menu containing a two-part segmented control. The track is a 36px Raised well with 3px padding. The selected segment is Raised High with Primary Text and a contact shadow. The unselected segment is Secondary Text and brightens on hover. The labels are exactly `Smooth` and `Native`. A 12px caption below describes the current mode: `Softer gate edges, same values.` or `Every measured gate, unsmoothed.`. The popover opens focused on the selected mode, and arrow keys move between modes.

### Colour-Scale Strip
- A pill at top centre reading `Light` [200px × 6px ramp] `Heavy · dBZ`. It has 10px ticks at 10 to 60 dBZ below the ramp. The ramp spans 5 to 70 dBZ in the renderer's palette with weak-return alpha applied, and a hairline inset keeps it separate from the pill.

### Credits
- MapLibre's compact attribution, restyled as a 28px Instrument Black pill with a 26px circular (i) button (Secondary Text stroke, Raised Hover on hover). When expanded it has a 14px radius, with links in Secondary Text that brighten to Primary Text.

### Inspection Reticle
- A deliberate map click places a 16px ring with a 1.5px white stroke and four ticks that stop short of the ring, so the sampled gate itself stays visible. A drop shadow keeps it legible on any colour. The value appears only in the playback row. There is no tooltip island. Escape clears the point.
- The value is recomputed at the same geographic point whenever a different observation paints, and a previous scan's value is never carried forward. `--.- dBZ` shows while that exact observation-bound lookup runs. Source-native status (`No coverage`, `No data`, `Out of range`) appears only after the matching lookup settles, so pending work is never labelled as a coverage result. National lookups always use the exact retained base grid.
- Screen-reader announcements stay stable during playback instead of announcing each inspection refresh.

### Radar Presentation (map, unchanged by the chrome redesign)
- **Weak-return curve:** reflectivity in both modes uses one display-only curve. Non-positive returns are suppressed, positive returns rise through a quiet, near-linear fade to full opacity at 20 dBZ, and stronger operational colours are unchanged. It is not clutter removal. A visually hidden gate remains a valid measured gate, and inspection reports its native status and exact dBZ.
- **Smooth and Native:** `Smooth` (the default) filters the spatial presentation of one measured observation. It never interpolates between scan times, generates a frame, or changes decoded values or inspected dBZ. `Native` shows the nearest Site polar gate or the nearest National grid cell at the active level. National smoothing never bridges missing or no-coverage cells. Switching between the two leaves source, observation, time, age, timeline position, and paint identity unchanged.
- **Painted truth:** the tag, rail name, time, and age follow the observation the GPU completed. The previous renderer stays visible until every replacement chunk has uploaded, full viewport coverage has drawn, and the GPU fence has completed. If replacement work fails or is superseded, the prior source is restored without changing timestamp, age, inspection identity, or persistence. National playback at regional zoom first prepares the finest complete all-frame level that fits in memory, then plays every frame at that one quality with no I/O or uploads. A paused frame may refine spatially without changing its time, age, source, or inspection identity.
- **Zoom-led source:** picking a Site flies to it at zoom 9.5, and picking National zooms out to the country. Crossing the detail threshold or panning into another Site's coverage cross-fades between layers, and the Site layer always fades over National.
- **Framing:** initial load, successful site changes, and Recenter fit the painted radar's measured coverage, or CONUS for National, to the window. Framing scales with the window instead of falling back to a near-national view on 4K displays. After that, pan and zoom are unconstrained.
- **Basemap:** the bundled OpenFreeMap source graph only; visual context adds no provider or network path. Local road names are title case, appear only at close zoom, and stay dim below radar. Important cities outrank route lines, and state labels are natural case and quieter.

## Do's and Don'ts

### Do:
- **Do** let radar stay the largest, brightest, and most information-dense element. Chrome is Instrument Black with a hairline and the Float shadow.
- **Do** keep blue for play, selection, and focus only, and give every state ink one job: green for the recent newest age, amber for survivable failure, coral for failure.
- **Do** give every changing value a fixed slot and tabular numerals: the time, age, and tag group at least 292px, the dBZ cell 104px.
- **Do** put exceptional states in the timeline label lane as a few sentence-case words, with the full message on hover, focus, and to assistive technology.
- **Do** anchor the sheet and popover to their rail controls, keep them mutually exclusive, open them focused (search field or selected mode), and return focus on close.
- **Do** show radar colour in the chrome only as data: the colour strip from the renderer palette and the opaque dBZ swatch.
- **Do** keep Space, arrow-key steps, `/`, Escape, visible focus, forced-colours outlines, and reduced-motion fallbacks working on every new control.

### Don't:
- **Don't** use backdrop blur, translucency, glow, or decorative gradients on any chrome surface.
- **Don't** add a banner, toast, or card above the playback row for any state.
- **Don't** add visible `Fresh`, `Stale`, `Playing`, `Paused`, or `Newest` labels, or step buttons, to the playback row.
- **Don't** add rail tools, a toolbar, a wordmark, a left menu, or an About panel for capabilities that don't exist yet.
- **Don't** introduce a second accent hue or tint the basemap or radar with chrome colour.
- **Don't** let a value change move the track, or resize or recentre the map when a panel opens. Panels are never draggable.
- **Don't** set interface copy in tracked uppercase or a condensed or novelty face.
- **Don't** expose prototype phases, benchmarks, fixture controls, or engineering diagnostics in the normal surface.
