# Phase 1 independent decoder oracle

Mistr's production candidate is Rust. Phase 1 compares that decoder with the independent Python ARM Radar Toolkit (Py-ART) implementation instead of treating a second invocation of the Rust crate as proof.

## Reproduce

Use Python 3.12 on Windows:

```powershell
python -m venv .oracle-venv
.\.oracle-venv\Scripts\python.exe -m pip install -r scripts\oracle\requirements.txt

cargo run --locked --manifest-path src-tauri\Cargo.toml --bin mistr-decode -- fixtures\cache\KTLX20240520_230512_V06 --product reflectivity --json artifacts\phase-1\rust-reflectivity.json --text artifacts\phase-1\rust-reflectivity.txt

.\.oracle-venv\Scripts\python.exe scripts\oracle\dump_pyart.py fixtures\cache\KTLX20240520_230512_V06 --output artifacts\phase-1\pyart-reflectivity.json
.\.oracle-venv\Scripts\python.exe scripts\oracle\compare_reports.py artifacts\phase-1\rust-reflectivity.json artifacts\phase-1\pyart-reflectivity.json --json artifacts\phase-1\comparison.json --markdown artifacts\phase-1\comparison.md

# Optional Phase 3 independent visual reference (artifact remains ignored).
.\.oracle-venv\Scripts\python.exe scripts\oracle\render_pyart.py fixtures\cache\KTLX20240520_230512_V06 --output artifacts\phase-3\pyart-reference.png --reference-json fixtures\expected\phase-3\pyart-ground-range.json
```

The virtual environment, downloaded radar bytes, and generated reports are intentionally ignored by Git. The committed Phase 1 report records the stable results and hashes without publishing a multi-megabyte radar object.

## Independence and limitations

- Py-ART `2.2.5` is version-pinned here. Its installed dependency graph can be captured with `pip freeze` in an evidence bundle when needed.
- The oracle sorts the selected sweep by azimuth to match Mistr's renderer-independent normalization order.
- Py-ART's high-level field exposes one mask for unavailable gates. The oracle also reads Py-ART's independent low-level moment records, derives a full-array detailed-status digest (`valid`, `below_threshold`, `range_folded`) from every raw code, and verifies that the high-level mask agrees. The current public fixture contains no range-folded reflectivity gates, so a Rust synthetic adapter test separately exercises raw codes `0`, `1`, and `2+`.
- This Phase 1 oracle validates base reflectivity only. Level II base velocity is decoded by the same adapter for later renderer work, but it is not mislabeled as storm-relative velocity and is not accepted by this report.

## Phase 6 Level III `N0S` oracle

Phase 6 uses the exact-pinned MIT `nexrad-level-3-data@0.6.1` package as an implementation-independent structural oracle for Mistr's bounded Rust code-56/AF1F parser. A separate Python/Pillow comparator decodes the raw RLE product itself and compares its projected categories with the identical IEM RIDGE indexed PNG/world file. Neither oracle invokes the Rust production decoder.

```powershell
npm run fixture:verify:phase6

cargo run --locked --manifest-path src-tauri\Cargo.toml --bin mistr-decode -- fixtures\cache\TLX_N0S_2024_05_20_23_05_12 --product n0s --site KTLX --json artifacts\phase-6\rust-n0s-ktlx.json
node scripts\oracle\level3-n0s.mjs fixtures\cache\TLX_N0S_2024_05_20_23_05_12 KTLX artifacts\phase-6\oracle-n0s-ktlx.json
node scripts\compare-level3-n0s.mjs artifacts\phase-6\rust-n0s-ktlx.json artifacts\phase-6\oracle-n0s-ktlx.json artifacts\phase-6\comparison-n0s-ktlx.json

.\.oracle-venv\Scripts\python.exe scripts\oracle\compare_iem_n0s.py fixtures\cache\TLX_N0S_2024_05_20_23_05_12 fixtures\cache\TLX_N0S_202405202305.png fixtures\cache\TLX_N0S_202405202305.wld --output artifacts\phase-6\iem-comparison.json
```

The committed, derived expected reports live under `fixtures/expected/phase-6/`; raw provider objects remain ignored.
