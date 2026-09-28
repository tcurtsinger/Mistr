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
