# Radar core optimization — September 10, 2026

## Scope and status

This is the first implementation pass for boot-to-complete-loop latency and longer
history. It supersedes the shipping 20-observation capacity and memory budgets in
earlier phase documents; those documents and their packaged artifacts remain
historical evidence, not validation of this build.

## Implemented

- National history uses up to 16 unchanged PackedGrid v1 chunks per `MGB1` envelope.
  A native 392-chunk frame requires 25 chunk-batch calls rather than 392 individual
  chunk calls. Manifest, acquisition, commit and finalization calls are additional.
- A two-credit pipeline overlaps the next response/parse with ordered GPU uploads.
  It never admits a third request before a release acknowledgment and drains
  speculative leases after failure/supersession. No parallel GPU mutation or
  partial-frame publication was introduced.
- Each chunk retains its hash, generation, observation and manifest checks. The
  envelope is big-endian: `MGB1`, u32 count, then u32 byte length plus chunk bytes
  for each member. Count is 1–16, indices are unique and ordered as requested,
  each chunk is at most 512 KiB, and trailing bytes are rejected. Thus a batch is
  bounded by 8 MiB plus 72 bytes; typical native batches are substantially smaller.
- Both source clients reuse process-wide HTTP connection pools while retaining
  per-operation activity counters.
- National discovery/retention and both frontend renderers now support 60 frames.
  Normal history chrome uses the same 60-frame capacity. National's conventional
  two-minute sequence would span 118 minutes; this is a capacity, not a guarantee
  that a provider supplies every observation. Site duration depends on scan cadence.
- Site predecessor loading retries a failed step up to three total attempts with
  500/1000 ms backoff, checking ownership before retry. A permanent failure retains
  the painted partial loop and moves on to newer scans.
- National backfill now stops after three consecutive failed attempts rather than
  retrying one predecessor forever and starving live polling. Successful commits
  reset the attempt count. Existing commit/rollback settlement remains authoritative.

## Memory and rendering contract

National remains full-domain, native 7000×3500 numeric data for every retained frame.
Pan, zoom, playback and scrub still operate on resident data; no camera-based
downloads or reduced-resolution historical frames were added.

- Approximate 60-frame National texture residency: 2.8 GiB.
- GPU target: 3.25 GiB; hard ceiling: 3.5 GiB, including tracked transient resources.
- National backend target: 4 GiB, with its existing admission/accounting rules.
- Two outstanding batch leases bound transfer memory independently of frame count.

This increases memory requirements. It does not qualify integrated/low-memory GPUs.
Native GPU allocation, context-loss recovery, and full-loop latency still require
fresh packaged-runtime validation at 60 frames.

## Validation and remaining gate

`npm run verify` passes (public-repository check, documentation links, frontend
tests/build, Rust formatting, warning-free clippy, Rust tests and cargo check).
Additional transfer-client coverage exercises the batch command, invalid index
rejection, idempotent release and parse-failure acknowledgment. The packaged
acceptance harness now requires 60 observations and uses the revised memory limits;
it must not accept an old 20-frame report as proof of this change.

The native release executable is built separately with
`npm run tauri:build -- --no-bundle`. That is build validation, not an observed
startup or playback speedup. No fresh native WebView boot-to-loop benchmark has
been recorded in this pass.

Before calling either user issue resolved, measure cold boot to first paint and
fully resident loop separately for National and Site, including a 60-frame loop,
pan/zoom, scrubbing, source switching during loading, and context recovery. Compare
equal-length loops as well as old 20 versus new 60; fewer IPC calls alone do not
prove the larger loop loads faster.

## Not implemented in this pass

- Persistent decoded/on-disk history caching for warm starts.
- Concurrent observation acquisition/decode or parallel Site chunk downloads.
- Completed-archive fallback when Site's real-time predecessor is unavailable.
- ~~Interleaving fresh observations with a successful long backfill.~~ Done
  2026-09-28: National checks for a newer observation every 30 seconds and Sites
  probe every 2 minutes while history backfills; continuous polling still begins
  after backfill completes or gives up.

These are follow-up candidates, not capabilities to infer from the higher capacity.

## Playback follow-up from the first hands-on test

The operator reported skipping back and forth while backfill committed, plus an
unavailable banner with 21 observations. Inspection found a missed independent
20-frame cap in `NationalPlaybackController`: backend and renderer could commit
frame 21 before the controller rejected the expanded timeline. Its default now
uses the shared 60-frame capacity, with regression coverage for every growth step
from 20 to 60 and rejection at 61.

History commits also captured selection before uploading and restarted the entire
frame dwell afterward. Selection is now resolved after staging and after any
pending playback paint settles, so adding a frame does not rewind to the position
at which its upload began. Automatic mutation pauses preserve the remaining dwell
time rather than restarting it, preventing frequent commits from starving playback
advancement. Explicit operator pause/play intent retains priority.

Regression coverage includes rapid mutations at 25 ms intervals with a 100 ms
dwell (all intermediate frames must play), post-staging selection resolution, and
operator pause during a mutation. Native user validation remains required; this
follow-up does not claim a measured runtime speedup or eliminate every possible
cause of the generic unavailable banner.

## Loading and draw cost follow-up (2026-09-28)

A CPU profile of the packaged app (audit batch 3) found blocking WebGL round
trips dominating main-thread time.

- **Per-frame GL state capture (fixed).** Both custom layers saved and restored
  blend, texture, program, and VAO state through `getParameter`/`isEnabled` on
  every draw: 82% of regional-playback JavaScript time. MapLibre already marks
  its GL state dirty after every custom layer and restores it (`drawCustom`
  calls `context.setDirty()`), so each draw now sets only the state it uses.
- **Upload progress (fixed).** Chunk uploads emitted a full renderer snapshot
  each (about 440 a second during a fill) and rescanned every resident
  presentation for the GPU byte peak. Progress now emits once per animation
  frame and the peak is tracked incrementally during staging.
- **Per-slice upload error checks (kept, then replaced on 2026-09-29; see
  below).** Every upload slice drains and reads `getError`, about half of
  loading JavaScript time. Checking once per chunk was tried and reverted:
  those synchronous checks also keep the upload pacer's per-row estimate
  honest about GPU work. Without them the GPU queue filled, upload calls
  blocked on backpressure, the pacer collapsed to minimum bands, and
  context-loss recovery at 4K slowed from about 20 s to over 60 s in the
  packaged gate. Removing them needs fence-based flow control that bounds
  in-flight upload work, a separate change.

Measured on the same machine, old build (two runs) against new (three runs):

| | Before | After |
|---|---:|---:|
| Regional playback JavaScript busy time per 10 s | 2.63–2.68 s | 0.46–0.51 s |
| Long tasks during the 60-frame load | 9 | 2 |
| Main-thread CPU per uploaded chunk | 0.92–0.94 ms | 0.78–0.83 ms |
| GPU staging per frame (p50) | 585–604 ms | 427–580 ms |
| 60 frames loaded | 56.7 s | 50.6–56.9 s |

The first three rows are consistent across runs. Staging time and total load
time vary as much between runs of the same build as between builds, so they
are not claimed as gains.

Culling off-screen chunk draws was evaluated and not done: after the draw fix,
all draw submission is about 0.4 s per 10 s of playback, so the saving is small.

Benchmark: `scripts/run-national-load-bench.ps1` (results in `artifacts/bench/`).
For readable CPU profiles, `MISTR_UNMINIFIED=1 npm run tauri:build -- --no-bundle`
builds the frontend without minification.

## Loading speed (2026-09-29)

A per-step load log of a packaged National launch showed each of the 60
frames taking 925 ms, run strictly in sequence: 395 ms to download and decode
on the backend, then 520 ms to upload to the GPU.

- **Backend prefetch.** Once a predecessor is staged, the backend starts
  downloading and decoding the next one, and the next prepare picks it up
  already decoded. The frontend protocol is unchanged. Its network and
  decoder work is counted when it completes; a new National session drops it.
- **Fence-paced uploads, no per-slice `getError`.** A reproducible startup
  stall (3 of 4 National launches) spent 2.96 of every 3 s blocked in
  `getError`: each call waited on the GPU process for a whole vsync, so the
  first frame's upload crawled for a minute or never finished. This is the
  likely cause of the earlier reports of a loop stuck at one frame until
  Play. Uploads now issue no error queries. Each animation frame's uploads
  end with a fence; before more work is issued, the oldest fence is polled
  with a zero timeout, never waited on, keeping at most 6 frames of uploads
  ahead of the GPU. Fence status reaches WebGL several frames after the GPU
  finishes: with 2 in flight the first frame waited about 1 s on finished
  work, with 6 it never waited. Errors are read once per staged
  presentation, at commit, and once after context-loss rehydration. The
  4 ms per-frame upload budget is unchanged.
- **The KTLX startup scan only for a KTLX launch.** It painted KTLX in the
  wrong place for any other launch and held current radar back by its
  decode, about 1.1 s. (Removed from every launch later the same day; see
  [Visible-First Startup](24_VISIBLE_FIRST_STARTUP_AND_RECENT_BACKFILL.md).)

Measured from process launch, same workstation (120 Hz display):

| | Before | After |
|---|---:|---:|
| First National frame | 3.2 s | 1.5 s |
| 20 frames | 21.8 s | 8.1 s |
| 60 frames | 59.0 s | 22.3 s |
| Time per backfill frame (median) | 925 ms | 342 ms |
| Upload per backfill frame (median) | 520 ms | 299 ms |

The remaining per-frame time is the 4 ms upload budget: a frame's 392 chunks
need about 36 animation frames of it. Raising the budget trades frame time
during loading for load speed and is a separate decision.

Diagnostics: `__MISTR_NATIONAL_PHASE4__.loadTrace()` records each prepare's
discovery, download, and decode times, and the first frame's steps
(`current:*`); the renderer snapshot reports `uploadGpuWaitFrames` and
`uploadFenceGiveUps`.
