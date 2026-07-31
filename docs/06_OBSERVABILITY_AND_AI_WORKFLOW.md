# Observability and AI Development Workflow

## 1. Why this is mandatory

Codex and Claude will be the engineering team. No model should be expected to repair radar behavior from a prose description such as “the map froze” or “the timeline moved but radar did not.” Mistr must turn every visible result into inspectable, replayable evidence.

The goal is not more logging. The goal is a small set of correlated facts sufficient to answer:

- Which observation did the operator intend to view?
- Which generation owned it?
- Where was it in acquisition/decode/upload state?
- Which GPU context contained it?
- Which observation actually painted?
- What source and measured time did it represent?
- What resource or deadline prevented progress?

## 2. Correlation identifiers

Every structured event includes relevant identifiers:

- `session_id`
- `generation_id`
- `request_id`
- `site_id`
- `product_id`
- `observation_id`
- `source_object_id` or redacted stable hash
- `decode_job_id`
- `transfer_id`
- `gpu_resource_set_id`
- `webgl_context_epoch`
- `paint_sequence`

IDs are generated once by the owning stage and propagated, not reconstructed from timestamps.

## 3. Structured event vocabulary

Minimum event families:

### Acquisition

- `inventory_started/completed/failed`
- `object_download_started/progress/completed/failed/cancelled`
- `chunk_discovered/downloaded/duplicate/gap`
- `volume_started/elevation_completed/volume_completed/incomplete`

### Decode and normalization

- `decode_queued/started/completed/failed/cancelled`
- `sweep_selected`
- `normalize_started/completed/failed`
- `reference_comparison_completed`

### IPC and upload

- `transfer_credit_granted/revoked`
- `transfer_started/completed/failed/cancelled`
- `wire_rejected`
- `upload_queued/started/completed/failed`
- `resource_resident/evicted/released`

### Render and playback

- `frame_selection_requested/accepted/rejected`
- `paint_receipt`
- `playback_held/advanced/skipped`
- `context_lost/context_restored/rehydration_completed`
- `fallback_activated/deactivated`

### Budgets

- `memory_budget_snapshot`
- `queue_depth_snapshot`
- `frame_timing_summary`
- `latency_sample`

## 4. Event requirements

- Use monotonic duration fields for timing and UTC only for cross-system chronology.
- Keep payloads bounded.
- Never log raw radar arrays.
- Never log arbitrary response bodies or credentials.
- Record stable error codes and stage, not only prose.
- Emit explicit cancellation and supersession events so silence is not ambiguous.
- Rate-limit repeated provider or frame events.

## 5. In-app diagnostic overlay

Mistr's minimal UI should expose a toggleable diagnostic overlay showing:

- Selected versus last-painted observation.
- Measurement age.
- Current generation and context epoch.
- Loop frame count and resident count.
- Current acquisition/decode/upload queue depths.
- Radar CPU/GPU byte budgets.
- Last frame P50/P95 timing window.
- Network/disk/decode activity indicators.
- Current source path: fixture, Level II archive, Level II chunks, Level III, or tiled fallback.
- Most recent structured error.

The overlay is diagnostic, not production visual design.

## 6. Debug bundle

One command/button must create a timestamped archive containing:

- Build/commit/version manifest.
- OS, WebView2, GPU, driver, display, and WebGL capability snapshot.
- Effective non-secret configuration.
- Recent bounded structured event log.
- Radar state-machine snapshot.
- Inventory and observation metadata.
- Decoder/normalizer/wire schema versions.
- Loop residency table and resource byte estimates.
- Last paint receipts.
- Performance trace or summary.
- Current screenshot.
- Optional short screen recording when the test harness enables it.
- Fixture IDs/hashes used, without automatically copying large source data.
- Test/fault-injection scenario identity.

The bundle must be safe to attach to an AI task without leaking credentials or unbounded data.

## 7. Deterministic replay

A replay command accepts:

- Fixture manifest.
- Site/product/elevation selection.
- Scripted timing/fault scenario.
- Camera actions.
- Playback actions.
- Expected state/event assertions.

It produces:

- Exit status.
- Structured event log.
- Screenshots.
- Performance summary.
- Final resource ledger.

The same replay should run locally and in CI where GPU capabilities permit. When CI cannot reproduce hardware rendering, the packaged local runner remains required and its artifact format stays identical.

## 8. AI change protocol

For every defect:

1. Capture the debug bundle or deterministic fixture/scenario.
2. State the exact wrong visible or numeric result.
3. Add or identify a failing test that demonstrates it.
4. Locate the owning state/resource boundary.
5. Change the smallest responsible module.
6. Run focused tests.
7. Run the full decoder/wire/renderer/state regression set.
8. Run the packaged scenario when behavior crosses WebView2, IPC, or GPU boundaries.
9. Compare performance/memory budgets before and after.
10. Update the relevant decision/spec only if durable behavior changed.

No AI agent should “fix” a playback issue by weakening paint truth, adding arbitrary delays, or declaring readiness from a different stage.

## 9. Review checklist for Codex/Claude

Every material radar change is reviewed for:

- Stale generation publication.
- Unbounded task/queue/buffer growth.
- Work accidentally running on UI/main thread.
- Missing cancellation ownership.
- Resource release on failure and context loss.
- Integer/offset/allocation bounds.
- Incorrect product labels or units.
- Silent smoothing/interpolation.
- Timeline/paint divergence.
- Browser-dev-only assumptions.
- Changes to national mosaic/handoff behavior.
- Fallback honesty.
- Missing diagnostics.

## 10. Module boundaries for AI comprehension

Prefer small explicit modules rather than a single map component:

```text
rust/
  acquisition/
  level2_adapter/
  level3_adapter/
  chunk_assembly/
  normalization/
  packed_sweep/
  cache/
  diagnostics/

web/
  radar-coordinator/
  packed-sweep/
  radar-resources/
  raw-radar-layer/
  playback/
  diagnostics/
```

Each module has:

- One responsibility.
- Public invariants.
- Tests at its boundary.
- No direct dependency on React unless it is UI.
- No access to MapLibre except the custom-layer adapter.
- No third-party decoder types outside decoder adapters.

## 11. Performance regression protocol

Every renderer/acquisition change records before/after:

- Fixture/scenario.
- Build and machine.
- P50/P95/P99 frame time.
- Long-task count.
- Decode/upload timing.
- CPU/GPU resource bytes.
- First-paint and resident-switch latency.

A correctness fix that materially regresses a budget is not silently accepted. It is either optimized, explicitly approved with rationale, or rolled back.

## 12. Documentation discipline

Durable changes update:

- Architecture when ownership or flow changes.
- Wire spec when binary compatibility changes.
- Fixture manifest when coverage expands.
- Validation plan when a new failure mode is demonstrated.
- Risk register when probability/impact changes.
- Decision log for material tradeoffs.

Implementation completion means implemented, verified, documented, and supported by reproducible artifacts—not merely merged code.
