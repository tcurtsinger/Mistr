# National Phase 2 expected evidence

This directory contains only small, reviewable expected results. It does not contain downloaded MRMS observations.

- `mrms-oracle.json` records four seasonal NOAA object identities, hashes, independent ecCodes metadata, exact point samples, small raw-code windows, and formula comparisons across all 24,500,000 cells in each source grid.
- `packed-grid-v1-manifest.bin` is the complete Rust-produced `PackedGrid v1` manifest for the reviewed 2026-08-03 sample.
- `packed-grid-v1-chunk-000.bin` is one bounded Rust-produced numeric chunk used by the TypeScript cross-language parser test.
- `packed-grid-v1.json` records the source identity and wire hashes for those binary vectors.

Large `.grib2.gz` inputs are fetched only into ignored `fixtures/cache/` paths. Install `scripts/oracle/requirements-national.txt` into the ignored `.oracle-venv`, then regenerate with `npm run oracle:national`; the binary vectors are regenerated with `mistr-national-wire` and the reviewed sample key documented in `docs/26_NATIONAL_RADAR_IMPLEMENTATION_PLAN.md`.
