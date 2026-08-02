# Radar Rendering Quality

**Status:** Accepted Alpha rendering contract

## 1. Decision

Mistr offers two spatial presentations of the same selected, measured radar observation:

- `Smooth` is the default product presentation. It reduces distracting gate-edge aliasing while preserving observation identity and native interrogation truth.
- `Native` is the exact polar-gate presentation using nearest sampling.

These visible top-context labels are deliberate. They describe how one observation is drawn; they are not radar products, elevation choices, forecast frames, or different data sources.

## 2. Demonstrated problem

The pinned KTLX observation at `2024-05-20T22:21:59Z` is a clear-air VCP 35 scan with 720 radials, 1,832 gates per radial, 250-metre gate spacing, a 2,125-metre first-gate center, and approximately 0.5-degree beam width. Its 460-kilometre coverage puts many native gates below one screen pixel while distant wedges remain visibly wider. Exact point sampling at every zoom therefore produces distracting spokes and speckle even when the decoder and packed wire are correct.

Independent packed-data inspection found all 720 radial rows unique and the azimuth spacing bounded around 0.5 degrees. Nearly all valid returns in this clear-air frame are below 20 dBZ. The visual problem must therefore be corrected in presentation, not by discarding weak values or changing the decoder.

NOAA describes Level II super-resolution reflectivity as 0.5-degree azimuth by 250-metre gate data extending to 460 kilometres. VCP 35 is a clear-air coverage pattern. See [NOAA NCEI Level II metadata](https://www.ncei.noaa.gov/access/metadata/landing-page/bin/iso?id=gov.noaa.ncdc%3AC00345) and [NWS VCP information](https://www.weather.gov/cle/news_VCP215).

## 3. Data truth boundary

For every valid Level II reflectivity code, Mistr uses the exact metadata conversion:

```text
dBZ = (rawCode - offset) / scale
```

The result is not rounded before palette lookup or point interrogation. Display work cannot mutate raw codes, status codes, scale/offset metadata, normalized CPU observations, packed IPC bytes, or the observation's measured time.

Status remains categorical and authoritative:

- valid return: convert with the exact equation and apply the reflectivity palette;
- below threshold: transparent;
- range folded: explicit range-folded color/state;
- missing or unknown status: transparent and never promoted to a valid return.

## 4. Reflectivity palette

The Alpha reflectivity ramp is a meteorological data palette, not Stormlight chrome. It progresses from restrained blue/cyan weak returns through green, yellow, orange, red, magenta, and pale extreme returns.

Every valid raw code has nonzero alpha. Very weak returns begin at low opacity and opacity rises gradually and monotonically. There is no low-dBZ hard cutoff: clear-air and weak biological returns remain available without visually overpowering stronger storm structure.

Palette anchors may interpolate color and alpha for presentation, but each lookup starts from the exact dBZ computed for that raw code. This color interpolation does not create, replace, or alter a measured value.

## 5. Spatial display modes

### `Smooth`

- Filters spatial appearance within one measured observation only.
- May reconstruct continuous-looking coverage from adjacent native polar samples when their statuses permit it.
- Must not interpolate between scan times, create timeline positions, or change a painted-frame receipt.
- Must not bridge missing radials, transparent/missing regions, or categorical range-folded regions as if valid reflectivity existed there.
- Must handle the 0/360-degree azimuth seam without inventing a discontinuity.

### `Native`

- Uses the exact native polar gate selected by nearest sampling.
- Keeps native bin and radial boundaries visible.
- Is the safe rollback presentation if the filtered path cannot initialize or recover.

Changing modes leaves the selected site, observation identifier, measured time, freshness age, timeline position, playback state, resident-history ownership, and authoritative paint semantics unchanged.

## 6. Inspection truth

A map inspection always reports the native underlying gate, status, and dBZ for the displayed observation. This is true in both `Smooth` and `Native`.

The application never reverse-engineers a dBZ value from a filtered screen color. A visually blended pixel may sit between native colors, but that intermediate appearance is not labeled as an intermediate measurement. Below-threshold, range-folded, missing, and out-of-coverage inspection results remain explicit.

## 7. Ownership and performance

- Spatial filtering remains in the renderer and does not trigger network, disk, decode, IPC, or per-playback-frame acquisition work.
- Canonical CPU observations and GPU-resident history remain bounded to the existing ownership contract.
- Mode changes must reuse bounded resident resources rather than duplicate an unbounded history.
- Exactly two cross-IPC transfer credits remain the hard transfer bound.
- WebGL context recovery restores the visible observation first and preserves or safely falls back from the chosen display mode.
- The radar layer remains below map labels, and decorative chrome color never washes over radar pixels.

## 8. Acceptance gates

Source-level evidence must prove:

1. every valid reflectivity raw code maps through the exact scale/offset equation;
2. every valid palette entry has nonzero alpha and low-return alpha increases gradually without a hard threshold;
3. below-threshold, range-folded, missing, and unknown statuses remain distinct;
4. uploaded palette bytes remain correctly premultiplied for WebGL;
5. `Smooth` and `Native` use the same observation and point interrogation result;
6. filtering cannot create data across invalid/status boundaries or the azimuth seam; and
7. the visible labels and accessible control name expose the active mode without implying a new observation.

The combined packaged Windows/WebView2 matrix must cover direct scrub, resident playback, site switching, 4K pan/zoom, context loss/restoration, and compact/forced-colors inspection across both modes. Renderer-sensitive playback, recovery, responsive-layout, and accessibility paths exercise both modes directly; mode-independent acquisition ownership remains covered once per live workflow. The existing long-task, hot-path I/O/upload, GPU-memory, and painted-receipt gates do not relax for visual quality.

### Current Alpha evidence

The release WebView2 renderer compiled both shader paths and passed separate `Native` and `Smooth` 1,000-transition resident-playback scenarios at 3840x2160 with zero long tasks, zero hot-path acquisition, and zero hot-path frame uploads. Switching `Native` to `Smooth` changed neither observation/receipt truth nor the 53,099,312-byte resident GPU set and caused no upload. Automated isolated-pixel evidence found substantial signal in both modes, a 35.5% changed-pixel ratio, and 7.9% background retained in common; generated overview and close-zoom captures confirm that `Smooth` closes false hairline seams between normally adjacent beams while retaining genuine missing/status regions, while `Native` retains exact polar bins.

The same release build passed both modes at 3840x2160, 1100x700, and 1024x640, including keyboard mode selection, one-panel behavior, accessible active-mode naming, focus restoration, forced-colors focus, and reduced motion. Live acquisition with generation supersession, a successive observation, direct oldest/newest scrubbing, and two cold-start context-recovery passes also succeeded.

## 9. Rollback

If `Smooth` causes incorrect boundaries, truth drift, performance regression, or recovery failure, Mistr falls back to `Native`. Because the modes do not change acquisition, decoding, normalized data, resident history, or timeline truth, rollback does not discard or reinterpret an observation.

## 10. Related decisions

- [Data Sources and Decoding](02_DATA_SOURCES_AND_DECODING.md)
- [GPU Renderer](03_GPU_RENDERER.md)
- [GPU Renderer Decision](15_GPU_RENDERER_DECISION.md)
- [Resident Playback Decision](16_RESIDENT_PLAYBACK_DECISION.md)
- [Alpha UI and Live-Site Hardening](23_ALPHA_UI_AND_SITE_HARDENING.md)
- [Product definition](../PRODUCT.md)
- [Design system](../DESIGN.md)
