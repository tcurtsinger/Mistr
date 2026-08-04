# National Phase 3 Static Renderer

**Status:** Phase 3 implementation evidence on `codex/mistr-national-static-renderer`
**Baseline:** merged PR #16, commit `d87f27f`
**Date:** 2026-08-03

## Scope

This report covers the first static end-to-end National product path:

- one newest NOAA MRMS `MergedBaseReflectivityQC_00.50` CONUS observation;
- separate numeric-grid WebGL2 rendering;
- complete overview and exact viewport working sets;
- explicit National/Site source selection and source-aware recenter;
- exact Rust-owned point interrogation;
- atomic source transitions and paint-only persistence;
- real WebGL context recovery; and
- preservation of every existing Site diagnostic surface.

It does not cover National history, polling, playback, scrubbing, or playback-quality locking.

## Packaged Windows/WebView2 evidence

Command:

```text
npm run test:national:phase3:packaged
```

Final result: **PASS** at 3840 by 2160.

| Measurement | Result |
|---|---:|
| NOAA object | `MRMS_MergedBaseReflectivityQC_00.50_20260804-012808.grib2.gz` |
| Compressed bytes | 1,194,536 |
| Retained backend bytes | 64,312,500 |
| Discovery | 203.85 ms |
| Download | 277.29 ms |
| Decode and level generation | 218.01 ms |
| Complete overview | factor 4, 28 chunks |
| Overview wire chunk bytes | 3,109,572 |
| Active overview GPU bytes | 3,108,788 |
| Overview staging | 186.4 ms across animation frames |
| Working-set upload maximum | 0.70 ms, below the 4 ms ceiling |
| Exact viewport | factor 1, 8 chunks |
| Exact viewport staging | 83.3 ms |
| Stable/peak detailed GPU bytes | 4,173,812 |
| Recovery upload maximum | 1.40 ms, below the 4 ms ceiling |
| Exact peak sample | 61.5 dBZ |
| Native/Smooth changed pixels | 1,219,013 |
| Real recovery receipt | context epoch 2, identity/coverage preserved |
| Final transfer credits | 2 available, 0 held, 0 in flight |
| Final source transition | National to KTLX Site, accepted paint truth |

The prepared level ledger reported 392 factor-1 chunks/49,744,808 projected GPU bytes, 98 factor-2 chunks/12,425,624 bytes, and 28 factor-4 chunks/3,104,644 bytes. Phase 3 first uploads the complete overview, then retains those 28 chunks as a complete-domain fallback while eight camera-required exact chunks cover the visible viewport. It does not upload every level simultaneously. The stable and peak detailed state used 4,173,812 bytes and reported 36 resident chunks (eight exact plus 28 fallback). The exact chunk count remains camera-dependent and is bounded by receipt-declared viewport coverage rather than hard-coded product behavior.

The packaged runner also proved:

- the source control says `National CONUS` only after National paint;
- the National panel contains explicit National and Site choices with CONUS supporting copy;
- the panel remains within a 1024 by 640 viewport, focuses the National choice, and is exercised under forced-colors and reduced-motion media;
- the one-frame National timeline does not invent transport activity;
- an identity-bound exact point lookup returns a valid raw code and dBZ;
- Native and Smooth preserve observation/time identity;
- a real context reset rehydrates visible detail first and the complete fallback one chunk per animation frame before issuing a new matching receipt; and
- returning to Site ends with one settled KTLX source and the Site renderer's own observation truth.

Generated evidence is under ignored `artifacts/national-phase-3/` and is not committed.

## Source tests

The implementation adds tests for:

- complete-domain and viewport coverage selection;
- chunk identity, complete staging, lease release, and rollback;
- raw formula, Native/Smooth sampling, and missing/no-coverage boundaries;
- National session acceptance, persistence, rollback, and supersession;
- exact base-grid point status/value and stale identity rejection;
- explicit newest-for-source age semantics; and
- packaged-report rejection of partial coverage or identity drift.

The age test uses a 30-second-old Site observation followed by a 3-minute-30-second-old newest National observation. National remains green as newest for its active source while exposing the exact larger numeric and accessible age.

The final source suite passes 40 frontend/script test files with 251 tests, the production TypeScript/Vite build, and 115 Rust library tests plus the Rust binary targets. The merged National Phase 2 packaged gate and the existing packaged Phase 4, 5, and 6 gates also pass unchanged. Repository scans and explicit staged-file inspection are rerun immediately before commit.

Final commands completed on the review branch:

```text
npm run verify                         PASS
npm run test:national:phase2:packaged PASS
npm run test:national:phase3:packaged PASS
npm run test:phase4:packaged          PASS
npm run test:phase5:packaged          PASS
npm run test:phase6:packaged          PASS (two consecutive recovery passes)
npm run docs:check                     PASS
npm run public:check                   PASS
git diff --check                       PASS
```

## Rollback

- Any failed or superseded National transition leaves the prior Site presentation enabled.
- Any failed detail mutation leaves the prior complete National presentation active.
- Context loss during replacement restores the prior complete presentation before rehydration.
- Source/time/age/timeline/persistence change only after the matching receipt.
- Reverting the Phase 3 commit returns to merged Phase 2 diagnostic-only behavior without changing `PackedGrid v1`, the Site renderer, or the shared broker.
