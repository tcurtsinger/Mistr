---
target: top and bottom bars plus menu
total_score: 31
max_score: 40
na_heuristics:
p0_count: 0
p1_count: 2
timestamp: 2026-08-03T00-49-53Z
slug: src-ui-radarchrome-tsx
---
Method: dual-agent (A: /root/chrome_design_review · B: /root/chrome_detector_evidence)

# Mistr Radar Chrome Critique

## Design Health Score

| # | Heuristic | Score | Key issue |
|---|---|---:|---|
| 1 | Visibility of System Status | 4 | Displayed time, frame position, playback, freshness, preparation, and failure truth remain visible. |
| 2 | Match System / Real World | 3 | Radar language is appropriate, but `VIEW` is less precise than the accessible label `Radar display`. |
| 3 | User Control and Freedom | 3 | Direct scrub, Escape, recenter, back, and close exist; the visible menu close is awkward in semantic and tab order. |
| 4 | Consistency and Standards | 3 | The visual system is cohesive, but moving the edge trigger into a panel-close position is a nonstandard implementation. |
| 5 | Error Prevention | 3 | Unavailable controls are disabled and painted-frame truth is preserved; dense small readouts can still be misread at a glance. |
| 6 | Recognition Rather Than Recall | 3 | Core state remains visible, though the icon-only menu and unexplained Smooth/Native labels assume familiarity. |
| 7 | Flexibility and Efficiency | 2 | Search and direct scrubbing are efficient, but common expert actions have no visible or documented accelerators. |
| 8 | Aesthetic and Minimalist Design | 3 | Radar stays dominant; the two-action menu is over-sectioned and the spectrum timeline asks for extra attention. |
| 9 | Error Recovery | 4 | Preparation and failure states use plain language while preserving the last trustworthy display. |
| 10 | Help and Documentation | 3 | About covers product and data facts, but rendering modes and expert controls lack contextual help. |
| **Total** |  | **31/40** | **Good — solid foundation; address the major accessibility and hierarchy issues.** |

## Design Specificity Verdict

**LLM assessment:** This feels authored for Mistr rather than borrowed from a generic dashboard. The full-screen radar stage, top context instrument, bottom measured-time instrument, and restrained Stormlight edge treatment create a coherent product-specific composition. The earlier oversized/stencil treatment is gone. The present weakness is over-compression: the controls feel miniature in places rather than simply quiet.

**Deterministic scan:** `detect.mjs --json src/ui/RadarChrome.tsx` completed successfully with `[]`: zero findings, zero rule names, zero file locations, and no false positives. The detector did not catch the responsive preparation-width regression or the semantic menu-close issue; both require rendered-layout and interaction inspection.

**Visual overlay:** No reliable user-visible overlay is available. The fresh browser's mutation preflight failed because its evaluation surface exposed a read-only document title, so injection and browser presentation were correctly skipped. Fallback evidence came from DOM snapshots, screenshots, computed geometry, focus testing, source/CSS correlation, and a live packaged Mistr view.

## Overall Impression

The redesign has already solved the largest visual problems: both bars are compact, the menu is clean, and the radar remains the stage. The biggest opportunity is not to shrink the chrome further; it is to make the same compact footprint easier to scan by improving type hierarchy, quieting decorative competition, and making the menu close control structurally honest.

## What's Working

1. **Clear spatial model:** The top changes radar context, the bottom controls observation time, and the left menu holds infrequent application actions. The map never recenters or resizes when a panel opens.
2. **Operational truth is unusually strong:** Displayed scan time, frame position, playback, freshness, preparation/failure state, and inspected dBZ occupy one stable instrument instead of shifting or floating.
3. **The earlier menu problems are fixed visually:** No stencil art, accent rail, duplicate site picker, oversized exterior close tab, or permanent sidebar remains. Keyboard Escape and focus restoration also work.

## Priority Issues

### [P1] Operational typography is too small for extended monitoring

**Why it matters:** Most labels and several critical readouts are fixed at 11px with wide tracking. On large monitors this makes the chrome visually remote and forces repeated close reading during the long monitoring sessions Mistr is built for.

**Fix:** Preserve the 40px top and 44px bottom silhouettes. Raise critical values to 12–13px, reduce tracking on operational text, and create hierarchy with weight and contrast rather than added bar height. Validate at native 4K and 1100×700.

**Suggested command:** `$impeccable typeset`

### [P1] The menu close is visually internal but structurally external

**Why it matters:** The left edge trigger is moved with CSS into the panel's upper-right corner. It still precedes the panel in DOM/tab order, while focus moves to Recenter when the panel opens. A keyboard or screen-reader user cannot reach the visible close control in the natural panel sequence. This also diverges from the design contract's conventional internal close control.

**Fix:** Render a real close button in the panel header, hide the edge trigger while the panel is open, retain Escape and focus return, and test forward/backward tab order.

**Suggested command:** `$impeccable harden`

### [P2] The preparation bar expands across the compact desktop at 921–1220px

**Why it matters:** At the established 1100px compact width, the otherwise content-sized preparation instrument measured 1028×44px. It looks like a full-width bar during the exact waiting state when the interface should feel calm and intentional.

**Fix:** Add a preparation-specific width override inside the 1220px breakpoint, or scope the generic playback width rule to the populated variant. Retest 920, 1100, 1220, and 1440px.

**Suggested command:** `$impeccable adapt`

### [P2] The bottom bar has no single dominant operational reading

**Why it matters:** Time, playback state, freshness, inspection copy, thumb glow, and the cyan-to-rose timeline all compete inside a small height. Users can parse it, but cannot reliably glance it.

**Fix:** Make displayed time the primary reading, freshness the clear secondary reading, and playback state subordinate to the transport. Quiet the full-spectrum track and reserve stronger color for the thumb, keyboard focus, and exceptional states.

**Suggested command:** `$impeccable distill`

### [P2] The two-action menu is over-structured

**Why it matters:** Header support text, two section labels, row rules, and a group divider make Recenter and About feel more administrative than they are. The current-site supporting line also repeats context already visible above and in `Return to <site>`.

**Fix:** Remove duplicated support copy and reduce separator count. Keep the two commands legible through spacing and restrained labels rather than a rule around every group.

**Suggested command:** `$impeccable layout`

## Persona Red Flags

- **Alex — power user:** Direct scrubbing and site search are strong, but there is no visible or documented play/pause, recenter, or menu accelerator. Alex must repeatedly target small controls during a fast weather workflow.
- **Sam — keyboard/screen-reader user:** Accessible names, live status, Escape behavior, and focus restoration are strong. The main failure is the visually internal close button sitting outside the panel's semantic/tab sequence; 11px tracked text also creates low-vision strain.
- **Long-session storm monitor:** The quiet chrome supports concentration, but repeatedly reading tiny time/freshness/status text will fatigue the primary operator. The vivid timeline also pulls attention from storm structure during hours-long use.

## Minor Observations

- The 40px closed menu trigger is a reasonable desktop target, but it unnecessarily shrinks to 32px in the close state.
- `VIEW` is ambiguous; `DISPLAY` would better describe Smooth/Native without reintroducing product or elevation controls.
- Menu secondary text could gain slightly more contrast without becoming prominent.
- `CLICK TO INSPECT` is good onboarding copy, but after the interaction is learned it consumes persistent width.
- At 800px, the menu and centered top bar overlap horizontally by about 8px. That is below the established 1100px compact target, so it is an edge condition rather than a release defect.
- Cognitive load is low overall: one checklist failure, visual hierarchy. No decision point exposes more than four actions.

## Questions to Consider

- Can the chrome feel smaller through lower visual weight rather than smaller text?
- If one bottom-bar fact must be recognized in half a second, should it be scan time or freshness?
- Does a two-command menu need section architecture at all?
- Should Smooth/Native remain terse expert labels, or gain a one-line explanation inside the dropdown?
