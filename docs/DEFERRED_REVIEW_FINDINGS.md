# Deferred review findings

This ledger keeps review feedback visible without turning low-probability edge cases into an endless review loop.

## Disposition policy

1. A demonstrated defect that can produce a wrong result, unsafe behavior, or broken phase gate is fixed in the current pull request. The implementation reply explains the fix and the thread is resolved only after validation.
2. A plausible but non-blocking edge case is recorded here, answered on the pull request with a link to this entry, and resolved without another review round.
3. A finding is never silently dismissed. Every closed thread receives a written disposition.
4. Deferred items are reconsidered before the affected subsystem becomes a Mistr Alpha release dependency.

## Open items

### DRF-001 - PuTTY private-key detection in the repository safety scanner

- **Origin:** Phase 0 pull-request review.
- **Area:** `scripts/check-public-repo.mjs`
- **Disposition:** Deferred edge case.
- **Reason:** The scanner rejects common PEM/OpenSSH key forms and GitHub secret scanning plus push protection are enabled. PuTTY `.ppk` content is not currently recognized by the local scanner. Mistr does not use PuTTY keys, so this does not block decoder work.
- **Revisit:** Before accepting contributions from a broader set of Windows environments or treating the local scanner as a general-purpose secret scanner.

### DRF-002 - Temporary AWS credential detection in the repository safety scanner

- **Origin:** Phase 0 pull-request review.
- **Area:** `scripts/check-public-repo.mjs`
- **Disposition:** Deferred edge case.
- **Reason:** The scanner detects long-lived AWS access-key patterns but does not explicitly detect temporary `ASIA` access-key IDs or session-token field names. Fixture downloads are anonymous and Mistr stores no AWS credentials. GitHub secret scanning and push protection remain the primary repository boundary.
- **Revisit:** Before adding authenticated AWS access or expanding the scanner's stated coverage.

### DRF-003 - Real Windows sleep/wake lifecycle pass

- **Origin:** Phase 6 packaged lifecycle validation.
- **Area:** Packaged Tauri/WebView2 runtime and `RadarCustomLayer` recovery.
- **Disposition:** Deferred manual environment check.
- **Reason:** Automatically suspending the primary workstation is disruptive and can sever the active development/review session. CDP page freezing is not an honest substitute because it intentionally suppresses `requestAnimationFrame`. Actual WebGL context loss, minimize/restore, offline/online, DPI overrides, and cold restart passed twice.
- **Revisit:** Before a public Mistr Alpha release, run one controlled Windows sleep/wake cycle while radar playback is active and save the Phase 6 report plus a post-wake paint receipt.

### DRF-004 - Isolated Phase 4 stabilized-heap measurement failure

- **Origin:** Alpha product-foundation packaged validation.
- **Area:** `scripts/phase4-packaged-cdp.mjs` and WebView2 `performance.memory` sampling.
- **Disposition:** Deferred measurement edge case.
- **Reason:** One intermediate 4K run exceeded the stabilized-heap-growth acceptance threshold after both 1,000-transition scenarios even though it had zero long tasks, zero hot-path uploads/acquisition, and normal frame/switch timings. Two subsequent runs of the final packaged build passed the same gate, including explicit garbage collection and stabilization sampling. There is no repeated product leak demonstrated on the current commit.
- **Revisit:** If the gate fails again on the same commit or on a second Windows machine, retain all per-scenario heap samples and investigate before relaxing any threshold.

## Closed items

None.
