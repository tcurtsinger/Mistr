# Deferred review findings

This ledger keeps review feedback visible without turning low-probability edge cases into an endless prototype-review loop.

## Disposition policy

1. A demonstrated defect that can produce a wrong result, unsafe behavior, or broken phase gate is fixed in the current pull request. The implementation reply explains the fix and the thread is resolved only after validation.
2. A plausible but non-blocking edge case is recorded here, answered on the pull request with a link to this entry, and resolved without another review round.
3. A finding is never silently dismissed. Every closed thread receives a written disposition.
4. Deferred items are reconsidered before the affected subsystem is promoted from prototype code into GustAVO.

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

## Closed items

None.
