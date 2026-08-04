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
| R12 | Resident playback still performs hidden I/O or uploads | Medium | High | Network/disk/decode/IPC counters move during playback | Stage counters; test assertion of zero hot-path activity; pre-residency definition | Mitigated for Site fixture playback and active-branch live National playback/scrub; long-session concurrency remains Phase 5 |
| R13 | Timeline reports a frame that did not paint | Medium | Critical | Playhead/time differs from paint receipt | Authoritative paint receipt with generation/context/observation; invariant tests | Mitigated for Phase 4 playback; site/context fault paths remain open |
| R14 | Rapid site/product changes publish stale work | High | High | Old site appears after switch | Generation IDs at every stage; cancellation; publish-time generation checks; stress tests | Mitigated for Phase 5 packaged supersession; product/context stress remains open |
| R15 | Raw source is not fresher or is less reliable than IEM/NOAA | Medium | Medium | Latency losses, frequent gaps, missing sites | Measure P50/P95/worst and failure rate; preserve current provider fallback; do not make speed claims early | Mitigated for the Phase 5 observation window; nationwide/seasonal reliability remains open |
| R16 | National implementation is conflated with Site or exposed before it is complete | Medium | Critical | Automatic zoom handoff, shared timeline, placeholder source control, or Level II client mosaicking | Explicit source choice; separate sessions/renderers; no early UI; old source remains until matching paint; phased review gates | Mitigated for merged Phase 3 and active-branch Phase 4; merge/release wording remains gated |
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
| R32 | Source coordination lets intent, stale work, or persistence outrun paint truth | Medium | Critical | Requested source labels early, old generation commits, failed request overwrites stored source | Typed `RadarSourceKey`; one coordinator; matching source/generation/coverage receipt; tested supersession and rollback; persistence only after accepted paint | Mitigated in unit tests and packaged Site/National handoffs; rapid-switch soak remains Phase 5 |
| R33 | Phase 1 refactor breaks established selected-site packaged diagnostics | Medium | Critical | Missing `__MISTR_PHASE*__` methods, archive race, history/polling change, or different GPU evidence | Preserve public diagnostic APIs; run Phase 4/5/6 packaged paths; compare existing gates without threshold relaxation | Mitigated by Phase 1 packaged Phase 4/5/6 passes; repeat every later phase |
| R34 | NOAA MRMS changes object, GRIB2, PNG, grid, scaling, or status structure | Medium | Critical | Strict decoder rejects a new observation or numeric oracle disagrees | Fixed product-specific contract; exact diagnostic reason; multi-season oracle; fail closed and preserve painted radar; review provider changes before acceptance | Mitigated for the Phase 2 corpus and live packaged run; future format drift remains open |
| R35 | Fixture observations become an accidental raw-code allowlist | Medium | Critical | Rare structurally valid code is rejected despite accepted metadata | Store exact `u16` raw codes plus GRIB scaling/status metadata; decode the complete structural domain by formula; test valid never-observed endpoints | Mitigated by Phase 2 formula tests and four-season full-cell oracle |
| R36 | National chunks bypass or leak the global two-credit IPC bound | Medium | Critical | More than two leases, stuck credits after parse/cancel, or separate National pool | Reuse the sole `TransferBroker`; repeat identity in every payload; release after upload/failure; unit and packaged backpressure/release proof | Mitigated through Phase 3 packaged upload and zero-held-credit evidence |
| R37 | A 20/30-frame National overview exceeds the GPU radar budget | Medium | Critical | Halo/staging ledger reaches 200 MiB target or 256 MiB ceiling | Value-aware level selection; separate retained/resident/painted truth; include halos and one staged frame; measured 30-frame diagnostic before product rendering | Active Phase 4 20-frame/detail peak is 64,227,072 bytes; Phase 2 30-frame payload diagnostic is 96,243,964 bytes; lower-GPU/30-frame runtime remains Phase 5 |
| R38 | Diagnostic MRMS plumbing is mistaken for shipped National radar | Medium | Critical | UI, source label, timeline, or documentation claims National before a complete paint path or before branch merge | Expose control only with complete renderer; one-frame truth; branch-versus-main wording; phased PR review | Phase 3 is merged; Phase 4 documentation explicitly labels history/playback as review-branch truth until merge |
| R39 | Partial National coverage or a stale detail level becomes UI truth | Medium | Critical | Missing chunks, mismatched coverage version, or old camera viewport advances time/source | Coverage manifest validation; active/staged separation; receipt after complete draw and GPU fence; rollback on cancel/context loss | Mitigated by controller tests and packaged overview/detail receipts |
| R40 | Numeric-grid shader corrupts MapLibre state or smooths across status gaps | Medium | Critical | Basemap breaks, missing regions fill, or inspection/color disagree | Explicit GL state capture/restore; integer textures; valid-four-cell smoothing rule; exact backend interrogation; 4K mode pixel evidence | Mitigated on primary packaged WebView2; broader GPU matrix remains open |
| R41 | Main-thread chunk upload breaks interaction budget | Medium | High | Upload task exceeds 4 ms or all chunks upload in one frame | One chunk per animation frame; measured/enforced 4 ms ceiling; record maximum in receipt; fail and retain prior source | Mitigated at 2.80 ms maximum with 20 common residents/detail/two recovery passes in Phase 4 packaged WebView2; broader hardware remains open |
| R42 | National context loss requires network or loses visible identity | Medium | Critical | Blank map, changed observation, or old staged detail commits after restore | Retain active CPU chunks; restore previous complete presentation; context-epoch receipt; real loss/restore package gate | Mitigated for all 20 common residents with zero backend activity on primary packaged WebView2; lifecycle matrix remains Phase 5 |
| R43 | High-zoom playback visibly alternates coarse and fine observations | Medium | High | Presentation factor changes by frame or fine staging stalls cadence | Require a complete all-frame factor-4 level; lock play/scrub to it; refine only after pause/settle | Mitigated by controller tests and packaged high-zoom factor-4 lock |
| R44 | GPU and backend chronology diverge across commit, context loss, supersession, or a lost finalization response | Medium | Critical | UI/renderer names a frame absent from retained history, Rust evicts a frame that the renderer restored, a repeated backend seal is rejected, or playback accepts a pre-loss context receipt after both sides finalize | Provisional fence receipt; retain prior resource graph; identity-bound reversible Rust commit journal including evicted ownership; renderer finalize then backend seal; retain one bounded last-sealed identity for idempotent retry; wait for the renderer's same-presentation current-context receipt before publication; compensating rollback tests | Mitigated by working-set, reversible-eviction, duplicate-finalization, presentation-receipt tests, and packaged post-finalization context-loss evidence |
| R45 | Background National polling contaminates resident-only playback evidence | Medium | High | Network/decode/IPC counters move during play or scrub | Resident-only reservation waits active acquisition and blocks new backfill/polls; activity snapshots inside reservation | Mitigated by packaged 1,000-transition and direct-scrub zero-activity evidence |
| R46 | National-to-Site replacement leaves the visible National loop inactive, collides with old playback, or supersedes an irreversible National mutation | Medium | Critical | Old National paint remains but its history generation cannot poll/backfill, an old selection waiter blocks replacement staging, or renderer/backend advance while timeline truth remains old | Wait the observed National acquisition/finalization transaction before advancing transfer generation; revalidate Site intent; on failed Site, pause and await existing playback/working-set operations and start a newer National session without removing old paint; packaged forced-failure proof begins with playback active and binds coordinator, backend, renderer, and transfer generations | Mitigated by session tests, transaction ordering, and the Phase 4 packaged active-playback failed-Site recovery scenario |
| R47 | Playback queues unbounded exact interrogation decodes | Medium | High | Every 120 ms paint waits behind older Rust re-decodes, current inspection lags, and CPU work continues after pause | One active frontend lookup plus one latest-only pending slot; replace older waiting receipts; keep receipt/inspection identity rejection; wait-for-idle packaged assertion | Mitigated by deterministic coalescing tests and packaged active-playback queue evidence |
| R48 | Repeated paused high-zoom pans rebuild the same full exact CONUS presentation | Medium | High | Gzip decode and full factor-1 encoding repeat before each new viewport transfer | Reuse the matching Rust prepared-detail frame by generation/time/hash/factor; rebuild only on identity or level change; cache-hit regression | Mitigated by Rust same-frame reuse test; broader long-session cache behavior remains Phase 5 |

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
