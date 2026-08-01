# GPU Renderer Plan

## 1. Objective

Render measured selected-site radar data inside MapLibre without representing each observation as a raster tile pyramid. The basemap and other GustAVO layers remain ordinary MapLibre layers; only selected-site radar uses a custom WebGL2 layer.

## 2. Required rendering contract

The renderer receives a validated `PackedSweep` and must:

- Preserve the observation's radial/gate structure.
- Position it correctly around the radar in Web Mercator.
- Apply a documented palette without changing measured values.
- Distinguish missing, below-threshold, and range-folded gates.
- Render below map labels at the intended style-layer position.
- Hard-cut between discrete measured observations by default.
- Provide proof that the selected observation actually participated in a completed draw.
- Restore all resources after WebGL context loss or fail honestly.

## 3. WebGL baseline

Mistr requires WebGL2. Startup diagnostics record:

- WebView2 runtime version.
- GPU vendor/renderer strings where available.
- `MAX_TEXTURE_SIZE`.
- `MAX_ARRAY_TEXTURE_LAYERS`.
- `MAX_VERTEX_TEXTURE_IMAGE_UNITS` and fragment limits used by the selected design.
- Supported integer texture formats.
- Device pixel ratio and framebuffer dimensions.
- Whether hardware acceleration is active.

Unsupported hardware produces a clear prototype failure or activates the tiled fallback; it must not silently select an unvalidated renderer.

## 4. Candidate rendering representations

### A. Naïve per-bin triangle mesh

Each gate becomes two triangles with duplicated positions and values.

Advantages:

- Conceptually direct.
- Easy palette lookup per vertex/fragment.

Disadvantages:

- Approximately six vertices per gate.
- Very large upload and GPU memory cost.
- Repeats geometry across observations.
- Makes the proposed 20-frame memory estimate unreliable.

**Decision:** rejected as the primary design. It may be implemented only as a tiny reference renderer for correctness comparison.

### B. Shared indexed radial geometry plus per-frame value textures

A bounded geometry describes radial/gate cells. Each observation supplies values and per-radial metadata through textures/buffers.

Advantages:

- Reuses geometry.
- Keeps raw values compact.
- Supports irregular azimuth metadata.

Risks:

- Geometry normalization must not create false coverage across missing radials.
- A fully expanded maximum-resolution grid may still submit many vertices.

### C. Screen-space/bounding-quad polar sampling

Draw one bounded quad around the radar. For each fragment, invert map position to radar-relative range/azimuth and sample a polar value texture.

Advantages:

- Very small geometry.
- Per-frame storage is primarily the compact polar texture.
- Timeline selection can be a texture-array layer index.

Risks:

- Accurate Web Mercator/radar geodesic inversion must be proven.
- Irregular radial azimuths and beam widths need a lookup/search strategy.
- Fill-rate grows with on-screen radar area.
- Edge and missing-radial behavior require careful treatment.

### Prototype decision

Implement B or C behind the same renderer interface after a short isolated benchmark. Prefer C if geospatial and irregular-azimuth correctness is demonstrated; otherwise use B. Do not let both grow into permanent parallel production renderers.

## 5. Recommended GPU data layout

For a normalized maximum grid of 720 radials by 1832 gates:

- Values: `R8UI` when the product encoding fits eight bits; otherwise `R16UI`.
- Validity/missing/range-folded state: compact integer mask texture or reserved codes only if the source semantics make that lossless.
- Azimuths/beam widths: compact float texture or buffer.
- Palette: a 256×1 or otherwise bounded 2D lookup texture. WebGL does not expose desktop OpenGL's 1D texture target.
- Loop: `TEXTURE_2D_ARRAY` when all observations can be normalized to compatible dimensions/encoding; otherwise one texture set per observation behind a bounded selector.

Shader color lookup follows documented product scale/offset. The shader must not reinterpret raw code values inconsistently with CPU point interrogation.

## 6. Memory model

### Compact value estimate

```text
720 radials × 1832 gates × 2 bytes × 20 observations
≈ 52.8 million bytes (about 50 MiB)
```

This excludes masks, azimuth metadata, palettes, GL allocation alignment, retained CPU data, MapLibre, basemap resources, and UI memory.

### Prototype budgets

Budgets must be reported separately:

- Raw compressed cache bytes.
- Decoded Rust working set.
- Normalized Rust/IPC bytes.
- Renderer CPU bytes.
- GPU bytes estimated from allocations.
- Total process working set/private bytes.

Initial target budgets for one active 20-frame product loop:

| Resource | Target | Hard prototype ceiling before redesign |
|---|---:|---:|
| GPU radar resources | ≤ 200 MiB | 256 MiB |
| Retained normalized CPU loop | ≤ 200 MiB | 300 MiB |
| One observation transfer | ≤ 16 MiB | 32 MiB |
| Concurrent in-flight transfers | 2 | 3 |

These are engineering bounds, not claims that every implementation will naturally meet them.

## 7. Geospatial placement

The renderer must account for:

- Radar latitude, longitude, and altitude metadata.
- Gate center range and gate spacing.
- Per-radial azimuth and actual angular width where available.
- Earth's curvature/geodesic destination calculation across the radar's operational range.
- Web Mercator projection used by MapLibre.
- Antimeridian and high-latitude behavior for Alaska, Hawaii, Puerto Rico, and Guam sites.
- Clipping to the product's measured maximum range.

### Validation anchors

Each fixture includes known gate locations computed independently on the CPU. The renderer test places markers at selected gate centers and verifies overlay agreement at multiple zoom levels and screen positions.

The initial prototype should constrain pitch and globe mode if those modes are not part of GustAVO's current operational contract. Unsupported camera modes are explicit, not accidentally distorted.

## 8. Palette and sampling semantics

- Nearest measured gate is the correctness baseline.
- Linear interpolation of data values is disabled by default.
- Palette lookup may use discrete or continuous stops only as the chosen product specification defines.
- Transparent means no valid visible return according to explicit mask/palette policy; it does not mean “not loaded.”
- Range-folded values have an explicit presentation policy.
- Palette changes update only the lookup texture and repaint; they do not redownload, decode, or rewrite observation values.

## 9. Frame selection and playback

When observations share one texture array:

```text
uniform frameLayer = selected resident index
```

An already-resident hard cut must require only:

- Selection metadata update.
- A MapLibre repaint request.
- One custom-layer draw using the new index.
- Paint receipt publication.

It must not require:

- Network requests.
- Disk reads.
- Rust decoding.
- Bulk IPC.
- Texture reallocation.
- MapLibre source/layer replacement.
- MapLibre `idle`.

## 10. Optional crossfade

Crossfade is deferred until hard cuts pass all gates.

If enabled:

- Both observations must already be resident.
- Blend only visual colors/alpha using an explicit mix fraction.
- Keep timestamps discrete and identify the two source observations.
- Do not describe the blend as predicted motion or a measured intermediate observation.
- Measure the extra draw/sampling and memory cost.
- Disable automatically under performance pressure if policy permits.

Shader `mix()` arithmetic is simple; state, alignment, missing-data behavior, and truth labeling are not free.

## 11. MapLibre GL state discipline

MapLibre's custom-layer API does not guarantee arbitrary ambient GL state. Mistr must:

- Compile/link programs once per context epoch.
- Bind its own VAO, buffers, textures, and uniforms on every draw.
- Set and restore blend, depth, stencil, cull, active texture, framebuffer, viewport/scissor assumptions as required.
- Avoid deleting or mutating MapLibre-owned resources.
- Release its resources in `onRemove` and on invalidation.
- Keep shader compile/link logs in diagnostics.
- Use premultiplied alpha or explicitly configure a compatible blend function.

A GL-state regression test renders normal MapLibre layers before and after radar and confirms they remain unchanged.

## 12. Context loss and restoration

On `webglcontextlost`:

1. Prevent default restoration behavior as required by the environment.
2. Increment the context epoch.
3. Mark all GPU observations non-resident immediately.
4. Stop playback advancement.
5. Retain or request normalized CPU data according to memory policy.
6. Surface `RENDERER RECOVERING`, never falsely current.

On `webglcontextrestored`:

1. Re-query capabilities.
2. Recompile shaders and recreate shared geometry/palette.
3. Re-upload the visible observation first.
4. Publish a new paint receipt.
5. Rehydrate the remaining loop under backpressure.
6. Resume playback only when policy-defined residency is restored.

Automated tests must trigger context loss where supported and also exercise a deterministic simulated resource reset.

### Phase 6 implementation result

The packaged Windows prototype now exercises the real `WEBGL_lose_context` path rather than merely clearing Mistr's own handles. It retains normalized CPU observations, invalidates the prior paint receipt, advances a context epoch, and re-adds the custom layer through MapLibre's public style API. The selected visible frame is uploaded and GPU-fenced first; the remaining loop is uploaded one frame per render turn and fenced before playback becomes ready. Pending paint/recovery promises fail explicitly if recreation or GPU verification fails. Two consecutive cold-start packaged passes also covered minimize/restore, offline resident playback, and 1x/2x device-scale overrides. Real Windows sleep/wake remains a manual hardware lifecycle check, recorded as DRF-003 rather than reported as an automated pass.

Evidence: [`phase-reports/PHASE_6_N0S_AND_CONTEXT_RECOVERY.md`](phase-reports/PHASE_6_N0S_AND_CONTEXT_RECOVERY.md).

## 13. Resource replacement

For site/product/elevation changes:

- New resources are built under a new generation.
- The old painted observation remains visible until the new current frame is resident and selected, unless product semantics require clearing.
- New resources are validated before atomic activation.
- Old resources are freed only after they are no longer referenced by a draw.
- A failed new generation cannot evict the last-known-good visible observation unless the operator explicitly disables it.

## 14. Point interrogation

The operator and tests need a CPU method to query the same displayed gate:

```text
map coordinate -> radar range/azimuth -> radial/gate -> raw code -> physical value
```

This becomes a correctness tool:

- Click several known positions.
- Compare CPU-interrogated values with reference decoder values.
- Optionally render a diagnostic gate outline.
- Ensure palette color corresponds to the same code/value.

GPU readback is not the primary query mechanism and should not be placed on the playback path.

## 15. Renderer performance evidence

Measure at minimum:

- Shader compile/link time.
- Observation upload time and bytes.
- First paint after upload.
- Resident frame-switch latency.
- CPU frame time and browser main-thread long tasks.
- GPU timing when supported and non-disruptive.
- P50/P95/P99 frame time during playback.
- Panning/zooming during playback.
- Memory before/after 1,000 frame changes.
- Memory before/after 100 site/product generations.
- Context-loss recovery time.

The target is not “the GPU looks smooth.” The target is a bounded, repeatable trace that demonstrates why it is smooth.
