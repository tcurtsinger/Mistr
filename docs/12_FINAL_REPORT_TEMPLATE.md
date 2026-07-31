# Mistr Final Feasibility Report Template

## Executive conclusion

**Recommendation:** Integrate / Extend prototype / Redesign / Stop

**One-sentence reason:**

## Build and environment

- Commit:
- Build artifact:
- Date/time window:
- Windows version:
- WebView2 version:
- GPU/driver:
- Display/resolution/scaling:
- Tauri/MapLibre/Rust/Node versions:
- Decoder revision:
- Wire schema:
- Fixture manifest revision:

## Scope completed

- [ ] Level II archive decoding
- [ ] Level II real-time chunks
- [ ] Lowest-sweep reflectivity
- [ ] 20-frame GPU-resident loop
- [ ] Level III `N0S`
- [ ] Packaged WebView2 validation
- [ ] Context recovery
- [ ] Latency comparison
- [ ] GustAVO integration rehearsal

## Adoption gates

| Gate | Status: pass/fail/unavailable | Evidence artifact | Notes |
|---|---|---|---|
| L2 numeric correctness | | | |
| L3 `N0S` parity | | | |
| Geospatial correctness | | | |
| Resident playback has no hot-path I/O | | | |
| 4K performance budget | | | |
| CPU/GPU memory bounds | | | |
| Timeline/paint truth | | | |
| Real-time chunk robustness | | | |
| WebGL context recovery | | | |
| Packaged Windows behavior | | | |
| Latency comparison complete | | | |
| Fixture corpus pinned | | | |
| Debug bundle sufficient | | | |
| GustAVO regression safety | | | |
| Rollback rehearsed | | | |

## Correctness results

### Level II

- Fixtures tested:
- Oracle(s):
- Dimensions/metadata comparison:
- Sample gate comparison:
- Known disagreements:
- Unsupported cases:

### Level III `N0S`

- Fixtures tested:
- IEM/reference comparison:
- Units/range/time agreement:
- Known disagreements:

### Geospatial alignment

- Sites/zooms tested:
- Maximum observed marker/render error:
- Unsupported camera/site conditions:

## Performance results

| Scenario | P50 frame | P95 frame | P99 frame | Long tasks | Notes |
|---|---:|---:|---:|---:|---|
| Stationary playback | | | | | |
| Pan during playback | | | | | |
| Zoom during playback | | | | | |
| Scrub | | | | | |
| Site switch | | | | | |
| Context recovery | | | | | |

### Pipeline timing

| Stage | P50 | P95 | Worst |
|---|---:|---:|---:|
| Download | | | |
| Assembly | | | |
| Decode | | | |
| Normalize | | | |
| IPC | | | |
| GPU upload | | | |
| Resident selection to paint | | | |

## Memory results

| Resource | Normal | Peak | Budget | Result |
|---|---:|---:|---:|---|
| Raw cache | | | | |
| Rust decode working set | | | | |
| Normalized CPU loop | | | | |
| In-flight IPC | | | | |
| GPU radar resources | | | | |
| Total process | | | | |

Long-run trend result:

## Live latency comparison

- Sites and weather regimes:
- Observation count:
- Collection period:

| Path | P50 measurement-to-paint/availability | P95 | Worst | Failure/gap rate |
|---|---:|---:|---:|---:|
| Mistr Level II chunks | | | | |
| Completed Level II archive | | | | |
| NOAA `SR_BREF` | | | | |
| IEM selected-site product | | | | |

Raw path wins/ties/loses:

## Fault and recovery results

| Scenario | Expected visible state | Actual result | Resource outcome | Pass/fail |
|---|---|---|---|---|
| Missing chunk | | | | |
| Corrupt object | | | | |
| Rapid site switch | | | | |
| Slow decode | | | | |
| IPC cancellation | | | | |
| GPU upload failure | | | | |
| WebGL context loss | | | | |
| Sleep/wake | | | | |
| Raw-to-tile fallback | | | | |

## Demonstrated defects

For each defect:

- Identifier/severity:
- Reproduction fixture/scenario:
- Exact wrong result:
- Root cause:
- Status:
- Remaining uncertainty:

## Risk register update

- Risks retired:
- Risks reduced:
- Risks increased:
- New risks:

## Integration impact

- GustAVO modules that would change:
- Current selected-site tile responsibilities removed:
- Responsibilities retained for national/other rasters:
- New dependencies:
- Feature flag/fallback design:
- Documentation changes required:

## Final recommendation

State clearly:

- Whether Mistr should integrate.
- Whether raw reflectivity and raw `N0S` have separate recommendations.
- Which cases retain tiles.
- Whether any platform rewrite is still justified.
- Exact remaining work before user approval.

Unavailable evidence must be listed as uncertainty, never summarized as a pass.
