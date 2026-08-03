# Risk Register

## Scales

- Probability: Low / Medium / High
- Impact: Low / Medium / High / Critical
- Status: Open / Mitigated / Accepted / Retired

## Active risks

| ID | Risk | Probability | Impact | Early warning | Mitigation / required evidence | Status |
|---|---|---|---|---|---|---|
| R1 | Young Rust decoder produces incorrect or unsupported Level II output | High | Critical | Oracle disagreements, panics, unsupported current fixtures | Adapter boundary; pin revision; numeric differential corpus; fuzz/bounds tests; fork/replace decision before renderer work | Open |
| R2 | Real-time chunks are incomplete, gapped, duplicated, or mishandled at rollover | High | Critical | Missing end boundaries, inconsistent radial counts, stale volume index | Explicit chunk state machine; captured chunk corpus; gap/rollover injection; archive fallback; never publish incomplete data | Mitigated for Phase 5 reflectivity; broader live corpus remains open |
| R3 | Lowest-sweep progressive publication is scientifically or structurally unsafe | Medium | High | Later chunks revise/complete required metadata or radials | Publish only after proven end-of-elevation and required metadata; compare against completed volume; otherwise wait for complete volume | Mitigated for the observed Phase 5 sites/VCPs; future formats remain fail-closed |
| R4 | Raw Level II base velocity is mistaken for GustAVO's current storm-relative velocity | Medium | Critical | UI/product naming says SRV while source is Level II velocity | Separate product enums; label base velocity explicitly; use raw Level III `N0S` for parity; product-label tests | Open |
| R5 | Level III `N0S` decoding path is not sufficiently trustworthy | Medium | Critical | IEM/reference disagreement or unsupported packets | Independent decoder/oracle, pinned corpus, numeric parity gate, retain IEM tile fallback | Open |
| R6 | Polar radar is misregistered in Web Mercator | Medium | Critical | Gate markers drift by zoom, direction, site, or range | Independent CPU geodesic gate coordinates; multi-site/zoom pixel alignment tests; restrict unsupported camera modes | Open |
| R7 | Chosen GPU representation exceeds memory budget | Medium | High | Allocations >200 MiB, failures on integrated GPU | Reject naïve mesh; compact integer textures; explicit allocation ledger; hard 256 MiB ceiling; reduce retained frames/encoding only through documented decision | Mitigated on primary GPU: 50.639 MiB current / 101.278 MiB replacement peak; lower-GPU gate open |
| R8 | WebGL context loss leaves blank/stale radar or leaks resources | Medium | Critical | Context epoch mismatch, restore fails, old handles reused | Context-epoch state; visible-first reupload; retained normalized data; automated loss/restore tests; tile fallback | Mitigated on primary Phase 6 workstation; multi-machine and manual sleep/wake remain |
| R9 | Custom layer corrupts MapLibre GL state or breaks after library updates | Medium | High | Labels/layers disappear, visual corruption after radar draw/style reload | Own all GL state; coexistence golden tests; pin MapLibre during prototype; public API only | Open |
| R10 | Binary IPC creates large copies, stalls, or unbounded queueing | Medium | High | Main-thread long tasks, queued bytes climb, old generations arrive late | Raw bytes not JSON; one-sweep payloads; transfer credits; bounded concurrency; packaged transfer benchmarks | Open |
| R11 | Decode/decompression runs on the Windows UI thread | Medium | Critical | Input/UI freezes correlate with decode | Explicit bounded blocking pool; thread/latency instrumentation; UI long-task gate | Open |
| R12 | Resident playback still performs hidden I/O or uploads | Medium | High | Network/disk/decode/IPC counters move during playback | Stage counters; test assertion of zero hot-path activity; pre-residency definition | Mitigated in Phase 4 packaged fixture playback; live acquisition path remains open |
| R13 | Timeline reports a frame that did not paint | Medium | Critical | Playhead/time differs from paint receipt | Authoritative paint receipt with generation/context/observation; invariant tests | Mitigated for Phase 4 playback; site/context fault paths remain open |
| R14 | Rapid site/product changes publish stale work | High | High | Old site appears after switch | Generation IDs at every stage; cancellation; publish-time generation checks; stress tests | Mitigated for Phase 5 packaged supersession; product/context stress remains open |
| R15 | Raw source is not fresher or is less reliable than IEM/NOAA | Medium | Medium | Latency losses, frequent gaps, missing sites | Measure P50/P95/worst and failure rate; preserve current provider fallback; do not make speed claims early | Mitigated for the Phase 5 observation window; nationwide/seasonal reliability remains open |
| R16 | National implementation is conflated with Site or exposed before it is complete | Medium | Critical | Automatic zoom handoff, shared timeline, placeholder source control, or Level II client mosaicking | Explicit source choice; separate sessions/renderers; no Phase 1 UI; old source remains until matching paint; phased review gates | Open |
| R17 | CPU point interrogation and shader color use different scale/offset semantics | Medium | High | Tooltip value disagrees with color/reference | Shared scale/offset metadata; exact unrounded code-to-dBZ conversion; exhaustive palette/code tests; native inspection assertions | Mitigated for Alpha reflectivity; future products remain open |
| R18 | Visual smoothing invents intermediate measured values | Medium | High | Filtered color is reported as dBZ, gaps bridge, or UI implies a generated frame | `Smooth`/`Native` labels; spatial-only filtering inside one observation; native-gate inspection; no temporal interpolation; status-aware edge tests; packaged visual validation | Mitigated for Alpha reflectivity; future products remain open |
| R19 | Fixture corpus is too narrow and overfits one site/VCP | High | High | New live volume fails despite green tests | Corpus matrix including severe/quiet/non-CONUS/VCP/negative/chunks; add every demonstrated failure | Open |
| R20 | Large raw fixtures bloat Git or become unavailable | Medium | Medium | Repository growth, broken external URLs | Manifest plus hashes; approved large-binary/artifact storage; preserve essential golden subsets | Open |
| R21 | Prototype turns into a full weather app/rewrite | High | High | Work begins on alerts, cameras, shell, 3D, national mosaic | Enforce charter/non-goals and phase exits; separate backlog; no UI polish before gates | Open |
| R22 | Two permanent renderers double maintenance | Medium | High | Raw and tile paths both accumulate features indefinitely | Fallback has an observation period and deletion decision; shared product/timeline contracts; deletion only after evidence | Open |
| R23 | AI agents make speculative fixes that weaken correctness | High | Critical | Arbitrary delays, relaxed readiness, missing regression test | Mandatory failing scenario/debug bundle; state invariants; packaged tests; review checklist | Open |
| R24 | Performance success on one GPU hides broader failures | Medium | High | Integrated/other-vendor GPU fails | Multi-machine/vendor matrix; capability logging; fallback; do not claim universal support from one system | Open |
| R25 | WebView2 update changes WebGL behavior | Medium | High | Packaged regression after runtime update | Record version; scheduled compatibility replay; avoid undocumented APIs; fallback path | Open |
| R26 | Cache startup trusts corrupt normalized/raw entries | Medium | High | Wrong radar after restart, parse/hash failure | Canonical keys; headers, size, schema and hash validation; quarantine/rebuild; cache corruption tests | Open |
| R27 | Disk writer/eviction recreates current cache contention | Medium | High | Queue grows, downloads block on eviction | Separate bounded/coalescing writer and janitor; deterministic ownership; playback independent of disk | Open |
| R28 | Crossfade is mistaken for a measured intermediate frame | Low | High | UI shows interpolated timestamp or “smooth motion” claim | Defer; hard-cut baseline; discrete timestamps; explicit visual-blend label | Open |
| R29 | Velocity dealiasing expands scope without scientific validation | Medium | Critical | Prototype adds “corrected velocity” with no oracle | Explicit non-goal; separate future research/ADR; use established algorithms and meteorological validation only | Open |
| R30 | Prototype success is declared from browser development only | Medium | Critical | No packaged artifacts or WebView2 traces | Packaged Windows gate is mandatory and cannot be waived as “equivalent” | Mitigated through committed packaged 4K runner; every later phase must repeat it |
| R31 | Palette styling hides meaningful weak precipitation or visually overstates reflectivity | Medium | High | Drizzle or snow disappears; ordinary rain shifts into yellow/red too early; a presentation cutoff is mislabeled as clutter removal | Preserve every valid raw code and native inspection; pin NOAA/NWS operational `SR_BREF` RGB anchors; bound the display-only alpha curve to non-positive through 20 dBZ; test exact unrounded conversion and all 256 entries; validate clear-air plus weak-precipitation scenes | Accepted presentation tradeoff for Alpha; broader seasonal corpus remains open |
| R32 | Source coordination lets intent, stale work, or persistence outrun paint truth | Medium | Critical | Requested source labels early, old generation commits, failed request overwrites stored source | Typed `RadarSourceKey`; one coordinator; matching source/generation receipt; tested supersession and rollback; persistence callback only after accepted paint | Mitigated in Phase 1 unit tests and packaged Phase 5 supersession; future National path remains open |
| R33 | Phase 1 refactor breaks established selected-site packaged diagnostics | Medium | Critical | Missing `__MISTR_PHASE*__` methods, archive race, history/polling change, or different GPU evidence | Preserve public diagnostic APIs; run Phase 4/5/6 packaged paths; compare existing gates without threshold relaxation | Mitigated by Phase 1 packaged Phase 4/5/6 passes; repeat every later phase |
| R34 | NOAA MRMS changes object, GRIB2, PNG, grid, scaling, or status structure | Medium | Critical | Strict decoder rejects a new observation or numeric oracle disagrees | Fixed product-specific contract; exact diagnostic reason; multi-season oracle; fail closed and preserve painted radar; review provider changes before acceptance | Mitigated for the Phase 2 corpus and live packaged run; future format drift remains open |
| R35 | Fixture observations become an accidental raw-code allowlist | Medium | Critical | Rare structurally valid code is rejected despite accepted metadata | Store exact `u16` raw codes plus GRIB scaling/status metadata; decode the complete structural domain by formula; test valid never-observed endpoints | Mitigated by Phase 2 formula tests and four-season full-cell oracle |
| R36 | National chunks bypass or leak the global two-credit IPC bound | Medium | Critical | More than two leases, stuck credits after parse/cancel, or separate National pool | Reuse the sole `TransferBroker`; repeat identity in every payload; release on every failure; unit and packaged three-request backpressure proof | Mitigated by Phase 2 packaged acquisition/transfer; renderer upload ownership remains Phase 3 work |
| R37 | A 20/30-frame National overview exceeds the GPU radar budget | Medium | Critical | Halo/staging ledger reaches 200 MiB target or 256 MiB ceiling | Value-aware level selection; separate retained/resident/painted truth; include halos and one staged frame; measured 30-frame diagnostic before product rendering | Mitigated for factor-4 payload ledger: 20+stage 65,197,524 bytes and 30+stage 96,243,964 bytes; actual GPU/fixed-resource evidence remains open |
| R38 | Diagnostic MRMS plumbing is mistaken for shipped National radar | Medium | Critical | UI control, source label, timeline, or documentation claims National before a complete paint path | Hidden diagnostic API only; non-persisting coordinator transition; restore Site after evidence; explicit current-state/product wording; no National renderer in Phase 2 | Mitigated in Phase 2 branch; remains a release-review gate |

## Top risks by immediate priority

1. R1 — decoder correctness/maturity.
2. R6 — geospatial/GPU correctness.
3. R8 — WebGL context recovery.
4. R13 — timeline/paint truth.
5. R2/R3 — real-time chunk correctness.
6. R30 — packaged-runtime proof.
7. R32/R33 — source-transition truth and selected-site regression safety.
8. R34/R36/R38 — strict National format, shared ownership, and no premature product exposure.

## Triggered stop/review conditions

Pause the current phase and perform a design review if:

- A fixture demonstrates silent incorrect data.
- A current live format cannot be represented without changing the wire schema.
- GPU memory exceeds the hard ceiling.
- Old-generation radar paints after a site/product change.
- Context restore cannot recover the visible frame.
- A performance repair requires weakening correctness or freshness labeling.
- Integration changes national mosaic semantics.
- A dependency requires unbounded or arbitrary network access.
- A stale source receipt or failed transition changes painted or persisted source truth.
- Any pre-renderer phase requires exposing an incomplete National control or changing selected-site behavior.
- A structurally valid raw code requires an observed-value allowlist, quantization, or wire-schema change.
- National manifests/chunks require a second transfer-credit pool or exceed the existing two-credit bound.
- The measured 30-observation working set reaches the 256 MiB hard radar ceiling or requires replacing `PackedGrid v1`.

## Risk review cadence

- Review at every phase exit.
- Add a risk for every new demonstrated failure class.
- Do not lower probability/impact without evidence.
- Retire risks only when the relevant adoption gate and long-run test pass.
