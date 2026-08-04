# National Phase 4 History and Playback

## Status

Implemented and packaged-validated on `codex/mistr-national-history` for review. This report describes branch evidence, not behavior shipped from `main`. Only the repository owner merges the pull request, and Phase 5 remains unauthorized until that merge and separate approval.

## Scope delivered

- newest-first National paint followed by bounded predecessor backfill with retry of an unconsumed transiently failed candidate;
- 20 exact chronological retained MRMS observations and strictly newer polling;
- complete factor-4 overview residency for every retained observation;
- direct resident playback and scrubbing at one common quality;
- paused/settled factor-1 selected-viewport refinement with bounded adjacent temporal detail;
- exact retained-observation Rust point lookup;
- provisional GPU/backend history transactions with rollback after supersession/failure;
- resident-only acquisition suspension and activity evidence;
- visible-first, network-free all-frame WebGL context recovery; and
- failed-Site recovery that restarts National on a newer generation while the prior National paint remains visible; and
- safe successful National-to-Site handoff without a second timeline or transfer-credit pool.

Phase 5 long-session, UTC rollover, lower-GPU/device-floor, installer, sleep/wake, clean-machine, and 30-frame packaged runtime validation are not part of this branch.

## Runtime architecture

`NationalHistoryState` retains immutable compressed provider objects plus complete factor-4 `PackedGrid v1` frames in chronological order under a 20-frame cap and 180 MiB backend target. It stages one current, predecessor, or newer identity at a time. Matching predecessor/newer preparation retry is idempotent: if Rust persisted the stage but its IPC response was lost, the exact same frame allocation and observation identity return with `reused: true` and zero repeated acquisition; frontend validation accepts that all-zero shape only for a reused non-current report, and a different staged kind fails closed. A commit remains identity-bound and reversible, including any evicted oldest object, until renderer finalization permits the frontend to seal it. The last sealed identity is retained as bounded metadata so retrying that same finalization after a lost IPC response succeeds idempotently. The initial current frame's full exact pyramid is only an acceleration cache; after a newer append seals, that superseded cache is released so it cannot overlap factor-1 packed detail and exhaust the backend target. Exact point lookup is bound to the painted generation, observation time, content hash, and geographic inspection identity; it re-decodes a retained object under one semaphore permit when needed. A persistent inspection is cleared and re-queried on every observation cut, and late values must still match the new receipt before display. The frontend runs one lookup at a time and replaces its sole pending request with the latest paint, rather than letting playback accumulate obsolete decodes behind the Rust semaphore.

`NationalHistoryWorkingSetController` transfers one manifest/chunk lease at a time through the existing global two-credit broker. `NationalGridLayer` indexes common and fine resources by observation identity and uploads each chunk texture in bounded row bands over animation frames under the enforced 4 ms slice. A history fence receipt is provisional: the prior residency graph and retired resources remain owned while Rust applies a reversible commit. Renderer finalization releases the prior GPU graph and then seals Rust; rejection or context loss before finalization rolls both journals back. After renderer finalization, the exact seal transaction retries with capped delay and no fixed attempt limit until Rust confirms it, or an identity-matching snapshot proves a lost response followed a successful seal. A loss during that interval also waits for the recovered receipt with the same presentation identity and new context epoch before history reaches playback.

`NationalPlaybackController` selects only complete factor-4 resources during play and active scrub. A resident-only reservation waits for in-flight acquisition/refinement and prevents new predecessor/poll work until interaction ends. After context loss, direct scrub awaits the same all-frame common-residency barrier as play; complete texture counts are insufficient until the renderer is painted, has an authoritative recovered receipt, and has no provisional mutation. The product disables playback controls and reports recovery until that repaint/fence completes. Paused high-zoom selection may refine, but refinement cannot change timeline time, numeric age, source, or exact interrogation identity.

National-to-Site acquisition waits for the currently observed National acquisition/history transaction before it advances the global transfer generation, then verifies the same Site transition still owns intent. Paused camera moves reuse a matching prepared Rust detail frame by exact generation/time/hash/factor identity rather than repeating full-grid decode and encoding. Overlapping camera and diagnostic requests join the active refinement promise instead of returning the prior overview report while exact chunks are staging. Predecessor backfill keeps a failed Rust candidate unconsumed, reports the failure, and retries it with the same capped jitter/backoff policy; a successful commit resets the backoff before the loop can move to the next predecessor or newer-only polling.

## Packaged Windows/WebView2 evidence

Command:

```text
npm run test:national:phase4:packaged
```

Five passing 3840 by 2160 results across review hardening, including the latest run after the paint-ready recovery barrier and transaction-bound seal retry:

| Measurement | Result |
|---|---:|
| Retained exact observations | 20 |
| Measured history span | 37.75 to 38.10 minutes |
| Complete common GPU residents | 20 |
| Resident transition receipts | 1,000 |
| Hot-path network requests | 0 |
| Hot-path response bytes | 0 |
| Hot-path decoder runs | 0 |
| Hot-path bulk IPC transfers/bytes | 0 / 0 |
| Hot-path point lookup decodes | 0 |
| Hot-path texture uploads | 0 |
| Detailed factor-1 residents after settle | 2 |
| Highest National GPU allocation | 65,201,668 bytes |
| Highest upload slice | 1.90 ms across initial staging, detail, and both recovery passes |
| Context epoch after real reset | 2 |
| Shared transfer credits after evidence | 2 available, 0 held, 0 in flight |
| Restored source | KTLX Site |

The history was strictly chronological and unique. The release runner holds one evidence-only resident reservation across its initial history snapshot, oldest/newest scrubs, 1,000 transitions, and exact inspection proof so a normal newly published MRMS observation cannot make the validator compare two different valid 20-frame timelines. Oldest/newest direct scrubs and all 1,000 transitions used factor 4 and matched retained generation/observation/content identities. One persistent inspection point was re-queried across newest-to-oldest-to-newest cuts, producing three distinct request identities and accepting only the matching retained observation each time. During active playback the inspection queue never exceeded one concurrent lookup, retained only one newest pending cut, and drained completely after pause. High-zoom paused selection refined to exact factor 1 while every common overview remained resident; active high-zoom playback returned atomically to and locked factor 4. Real `WEBGL_lose_context` recovery restored the selected frame first and all 20 common residents from CPU-owned bytes with zero backend activity.

The packaged runner starts National playback and then forces a Site transition to fail immediately after it advances the shared transfer generation and cancels National history work. The coordinator retains the old National paint, the Site session reports only the still-current failure, and Mistr pauses and awaits the old playback/working-set activity before advancing from National generation 3 through the failed Site generation 4 to restored National generation 5. The diagnostic forces another context loss after the new renderer finalizes but before backend sealing completes. The gate requires playback to be stopped, context epoch to advance, the recovered receipt, coordinator paint, retained history, renderer, and transfer owner to agree, and the backfill loop to start once before it attempts the normal successful KTLX handoff.

Generated JSON and screenshots remain under ignored `artifacts/national-phase-4/` and are not committed.

## Automated correctness coverage

- Rust store tests: chronology, staged rollback preservation, exact predecessor/newer stage reuse after a lost preparation response, explicit zero-cost replay reports, different-kind rejection, reversible post-eviction compensation, idempotent duplicate finalization, post-newer exact-cache release, one-oldest eviction at 20, and the same store/snapshot model at a non-shipping 30-frame limit.
- Rust detail-cache tests: same-identity/factor preparation returns the identical packed frame, while a different factor misses and requires a rebuild.
- TypeScript transfer/renderer/working-set tests: strict acceptance of explicitly reused zero-cost preparation with rejection of unmarked zeros, complete lease release, provisional paint, post-fence supersession rollback, recovery receipt matching that ignores only context/draw freshness while preserving the full presentation identity, a common-residency barrier that rejects complete texture counts until recovery paint/fence truth exists, transaction-bound sealing beyond three failures with matching-snapshot recovery, and a deterministic latest-only async queue proving one active lookup plus newest-pending replacement.
- Backfill-loop tests: transient prepare/commit failures retry the preserved candidate, successful work resets capped backoff, and supersession stops without another delay.
- Playback tests: common factor-4 play/scrub, recovery-time scrub waiting, pause-only refinement, overview-camera no-refinement behavior, and diagnostic 30-frame controller compatibility.
- Session tests: current Site failures report only after coordinator rollback, while superseded Site failures cannot trigger fallback restoration.
- Packaged validator tests: rejection of hot-path activity, mixed high-zoom presentation quality, or missing/stale failed-Site restoration evidence.
- The merged National Phase 3 packaged regression: an automatic camera refinement and explicit diagnostic caller converge on the same eight-chunk exact viewport, then retain overview fallback and recover the matching presentation.
- Existing `window.__MISTR_NATIONAL_PHASE2__`, `window.__MISTR_NATIONAL_PHASE3__`, `window.__MISTR_PHASE4__`, `window.__MISTR_PHASE5__`, and `window.__MISTR_PHASE6__` contracts remain present.

## Acceptance disposition

The dedicated National Phase 4 packaged gate passes five times across review hardening, including the latest exact code after the paint-ready recovery barrier and transaction-bound seal retry, across the primary release-runtime history, residency, zero-I/O playback, quality-lock, memory, context-recovery, credit-release, exact-lookup, inspection-refresh/coalescing, post-finalization recovery receipt, active-playback failed-Site restoration, and successful Site-return criteria. `npm run verify` passes 277 frontend/script tests and 133 Rust tests across the library and binaries, together with the production build, formatting, warnings-denied clippy, Rust check, documentation links, and public-repository scan. The merged National Phase 2/3 packaged gates and unchanged selected-site Phase 4/5/6 packaged regressions also pass.

Whitespace validation and staged-file inspection remain pre-commit controls. Pull-request review and CI remain required before the owner may merge.
