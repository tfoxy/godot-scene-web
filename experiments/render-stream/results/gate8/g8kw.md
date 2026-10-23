## G8kw result (2026-10-23)

The capture can now copy, decode and hash textures off the RenderingServer caller.
`GRC_TEXTURE_WORKERS=<N>` (1..16) hands each texture's content to a pool of N capture-owned
threads; the calling thread keeps only the facts and a copy-on-write duplicate of the Image.
**The calling thread's share of a 2048² create falls from 31-112 ms to 6-16 µs** on every format,
and publication waits for the hashes (the hold-back) without a wire change. The default stays
`sync`, which is the pre-G8kw capture byte for byte. Design: texture-delivery-design.md D11, Q7
"As built (G8kw)".

### Default: `sync`, and why

D11 names 2 workers as the default. The capture default stays `sync`; 2 is the product value, which
couch-coop's streaming seat sets together with `GRC_STREAM_VERSION=8`, `GRC_TEXTURE_DECODE=engine`
and `GRC_ADOPT=arm`, all opt-in the same way.

- At N, which callbacks publish depends on worker timing. A file recording is a frame-for-frame
  subset of the synchronous one, state for state (`worker-states-equal`), but it is no longer
  reproducible run to run. Every frame-exact leg (seq-keyed shots, window-1 transcripts, goldens)
  would need `sync` pinned, and the brief's bar for an async default (equal states at every
  checkpoint across every native gate) is a sweep of its own.
- Flipping the capture default later is one line plus that sweep. It belongs with gate8-design's
  "switch the defaults to /8" cleanup after release.

### Main-thread hook time per 2048² create (decode-cost, real time)

`run-gate8.sh --legs g8t`, `RS_SMOKE_LEGS=import,oracle,decode-cost`, under the exclusive quiet lock
at loadavg 2.98-3.07 (`decode-cost-r1/`). **Before** is the synchronous capture's
decode + copy + hash on the calling thread (`decode-cost/capture`); the rest of the hook is
microseconds. **After** is `hook_ns` at `GRC_TEXTURE_WORKERS=2` (`decode-cost/capture-workers`):
the whole hook on the calling thread minus the forwarded engine call. That covers facts, prediction,
duplicate, hand-off, mirror and registry. `dup_ns` is the copy-on-write duplicate within it, and
"worker" is the same decode + copy + hash, now on a worker thread.

| format | before: decode + copy + hash | before total | after: hook | of which dup | worker | worker hash = sync hash |
| ------ | ---------------------------- | ------------ | ----------- | ------------ | ------ | ----------------------- |
| DXT1 | 10.3 + 14.9 + 8.4 ms | 33.6 ms | 7.2 µs | 0.8 µs | 33.7 ms | yes |
| ETC2_RGB8 | 15.6 + 14.7 + 8.4 | 38.7 | 5.7 µs | 0.4 µs | 38.5 | yes |
| DXT5 | 12.6 + 14.4 + 8.8 | 35.8 | 14.7 µs | 1.4 µs | 35.9 | yes |
| ETC2_RGBA8 | 11.0 + 11.7 + 8.4 | 31.1 | 14.0 µs | 1.1 µs | 41.9 | yes |
| BPTC_RGBA | 30.2 + 10.9 + 8.5 | 49.6 | 16.1 µs | 1.5 µs | 56.0 | yes |
| ASTC_4x4 | 89.2 + 14.9 + 8.3 | 112.4 | 9.8 µs | 0.8 µs | 94.1 | yes |

The 2 ms budget (`worker-hook-time`) holds with a margin of about 100×.

- **The copy the caller still makes** is the copy-on-write duplicate, `Resource.duplicate(false)`:
  0.4-1.5 µs. It allocates an Image object and shares the CowData. The 11-15 ms byte copy
  (`copy_ns`: payload assembly into a fresh 16 MiB buffer, first-touch page faults) moved to the
  worker. So did the decode and the 8.3-8.8 ms SHA-NI hash.
- **Engine safety.** The engine may free or rewrite its Image as soon as the hook returns: the
  duplicate keeps the old buffer alive, and the engine copies on its next write. The worker reads
  through the const `image_ptr`, which never triggers a copy.
- **Hold-back cost.** The cost leg's 6 jobs held 7 callbacks back, with a lag of at most 7 frames
  (`stream.texture_workers` in its result.json). The two workers' 304 ms of job time ran while the
  main thread kept going.
- The oracle's best-of-3 `Image.decompress` times match G8sha's and G8t's (2.7-66 ms).

### What the workers legs prove (run-gate8.sh g8t, new legs)

- **`workers/capture`** runs `capture/` again with `GRC_TEXTURE_WORKERS=2 GRC_TEXTURE_WORKER_MIN_BYTES=0
  GRC_TEXTURE_WORKER_DELAY_MS=8`. Every copy, decode and hash goes to a worker, and each job waits
  8 ms, so publication is held back on any machine.
  - **`worker-states-equal`:** both /8 sinks validate. Every transaction equals the synchronous
    capture's transaction of the same frame, state for state, and both recordings end on the same
    frame and state. The run must hold at least one callback back.
  - In the full local run (`g8t-full/`), 7 of the 22 synchronous transactions were published and
    the other 15 frames held, with 15 jobs, and both sinks agreed. Local iteration with a 15 ms
    delay held 19 of 22 back, leaving only 3 frames to compare, so the leg now uses 8 ms.
  - The lag is 0 frames: once a job finishes, the next callback's own snapshot is ready, so stale
    snapshots are coalesced, never published late.
- **`worker-hook-log`:** the texture lines are the synchronous log's, in the same order, with the
  same facts and hashes. Only the cost columns differ, plus the trailing `worker`/`hook_ns`/`dup_ns`
  keys. The stored payloads are the same, and every ok create is a worker copy.
- **`sabotage-publish-before-ready`** (`GRC_TEXTURE_WORKER_FAULT=publish-before-ready`) publishes a
  pending entry at once, with 64 zero hex digits and no payload. It is caught twice: the publisher
  refuses the hash it has no payload for (`resource-store-failed: no payload for hash 000…`), and
  the recording no longer matches the synchronous one.
- **Unit level** (`capture/test/rs_texture_worker_test.cpp`, a new ctest):
  - A mirror fed predictions plus jobs gives full transactions byte-identical to the synchronous
    snapshots at every published frame. The newest ready snapshot wins over an older pending one,
    and a superseded job never reaches its entry.
  - A mispredict becomes the typed `texture-worker-mispredict` error and is never published.
  - A pending free holds nothing back.
  - The hook log's held lines come out in order, byte-identical to the synchronous log.
  - The pool runs jobs in parallel (at most N at a time). `stop()` drains, then joins. A stop that
    races 800 submits from 4 threads loses none: each job either runs on the pool or is refused and
    run by its caller.
  - Configuration parsing, the delay knob and the fault knob are covered.

### Byte identity at the default

`sync` runs no worker code: the mirror's `settle()` and the log's held-line queue are no-ops without
a job. Proof, before (main's library, built from `git archive 1b5bd348` into the scratchpad) against
after (this branch), compared record by record with `cmp-rec.ts` (G8sha's script, repointed;
`compare-*.txt`):

- **g8t** (capture, decode-off, sabotage-perturb-decode): 12 files equal. Every transaction record
  is byte-identical; only the session header and the end record's `*_ns_total` differ, as between
  any two runs. All three hook logs agree line for line, timings aside, and all 33 store payloads
  are byte-identical.
- **gate 2** g2a+g2b, 47/50 run checks on both sides; the 3 non-passes are `group-g2c/d/e`, "not in
  --legs". 42 recordings and hook logs are equal on the same terms, and all 96 store payloads are
  byte-identical. The exception is `live-inline`'s tap and received live transcripts: 489 vs 954
  transactions. That is credit pacing under load (window 1 phase-locks to every other frame;
  memory rs-g6c-60-60-phase-lock), not content. In both runs every tap transaction equals the
  host's file-sink state at its frame (`compare-g2-live-tap.txt`), and the host's own recordings
  (983 records) are byte-identical but for volatile fields.
- Goldens 2-8 are untouched (`git diff --stat` lists none). The codec ctests (`rs2..rs8_codec`,
  `rs_texture_payload`, `rs_mirror`, `rs_publish`) and the pure tier pass.

### What ran

| where | runs | result |
| ----- | ---- | ------ |
| local | capture ctests (26, `rs_texture_worker` new), before and after the rebase onto G8h | pass |
| local | `self-test-gate8.ts` (27 assertions, 7 new worker cases) | pass |
| local | `run-gate8.sh --legs g8t`, every non-timing leg (`g8t-full/`) | 10/12; the 2 non-passes are the skipped decode-cost timing group |
| local | g8t capture legs, old vs new library (`before-g8t/`, `after-g8t/`, `compare-g8t.txt`) | byte-identical but for volatile fields |
| local | `run-gate2.sh --legs g2a,g2b`, old vs new (`before-g2/`, `after-g2/`, `compare-g2*.txt`) | 47/50 both; equal (above) |
| local, timing | decode-cost ×1, at loadavg 2.98-3.07 (`decode-cost-r1/`) | the table above; `worker-hook-time` pass |
| local | lock-tests | pass |
| local | smoke live g7-2, gsw and web-rust (`smoke-g7-2/`) | only `warm-host-no-gets`, the smoke artifact G8w recorded (no warm leg runs in smoke) |
| local, after the rebase | gate 8, every group, timing skipped (`gate8-rebased/`); pure; smoke live g7-1 | gate 8 30/32 (the 2 non-passes are the skipped decode-cost timing group); pure pass; g7-1 smoke 2/2 |
| remote full tier | run 39988662792 (https://github.com/tfoxy/godot-scene-web/actions/runs/39988662792), evidence `artifacts/render-stream/remote/20261023T180154Z` | 19 of 21 runs pass; details below |

The remote full tier ran pure, capture-build, cargo ×4, pnpm-test, bench-instr, native gates −1,
0, 1, 2, 3, 4, 5, 55 and 8 (sabotage legs included; gate 8's workers legs passed on a 4-vCPU
runner), g7-gsw and g7-web-rust (all eight groups), and g7live-gsw and g7live-web-rust (g7-5,
g7-55). The two failures:

- `cargo-gsw-rs` rc 101, the known one.
- g7live-gsw g7-5: `leg-class-live-mesh-warm@gsw` and `receiver-vs-reference@gsw` (live-mesh-warm
  step 1: no shot). The GSW browser missed a shot. Rerunning the group (run 40000020994) passed
  g7-5 and g7-55, so this was a hosted-runner flake. The default capture is byte-identical, so it
  cannot reach a browser leg.

### Out of scope, and why

- **Every other timing run** is deferred to the pre-release delta sweep, by the brief: native gate 6,
  `g7live-*-timing`, `g7x`, and the timing groups inside gates 1, 2, 5 and 55. The remote tier
  refuses the same set.
- **A live leg at N.** The hub path a held callback takes (`on_frame` with no snapshot) is the
  stall path every live leg already runs. G8r's legs and the product's legs are the first to run
  live with workers.
- **The local smoke tier's native gates and file groups.** The remote full tier ran every one of
  them in full (a superset of smoke), so locally only what the remote refuses ran: lock-tests and
  live g7-1/g7-2 at smoke level. The brief allows smoke level because the default is `sync` and the
  capture is byte-identical; local live g7-1/g7-2 in full are out of scope for the same reason.
- Known failures, ignored: `cargo-gsw-rs` rc 101, a hosted-runner flake (above), and g7-2 smoke's
  `warm-host-no-gets`.

### Deviations

- **Default `sync` instead of D11's 2** (above).
- **The hold-back lives in `rs_texture_worker.*`**, not `rs_publish.*`. The Publisher still
  publishes one snapshot per call; deciding which snapshot to offer is the frame callback's job. That
  keeps the hold-back engine-free, unit-tested, and under the new narrow smoke rule.
- **`publish-before-ready` is a fault knob, not a `GRC_SABOTAGE` kind:** a new kind is a wire change
  in three validators (render-stream-8.md, `render-stream-2.ts`, rs-core `meta.rs`).
- **Two test knobs:** `GRC_TEXTURE_WORKER_MIN_BYTES` (default 64 KiB; smaller images stay
  synchronous, because the hand-off costs more than the hash) and `GRC_TEXTURE_WORKER_DELAY_MS`.
  Without them the fixture's 64×64 textures would never reach a worker or hold anything back.
- **"Equal states at every checkpoint"** is checked at every transaction the async recording
  publishes, plus the end state. A held frame has no transaction to compare, by design.

### Implementation versus validation time

- About 1 h 05 min of implementation: reading the design and code took 15 minutes, then the pool,
  hold-back, mirror and log changes, hooks and entry glue, ctest, checks, runner legs and docs.
- Two unit-test findings were fixed in minutes. A mispredicted job was silently settled by the
  mirror, and `texture_replace`'s log line did not wait for the replaced texture's job.
- About 2 h 35 min of validation wall time, most of it waiting on the quiet lock: up to 2,475 s
  of a 2,571 s gate 2 run went to waiting behind other agents' gate 6 and gate 1 timing legs.
- Validation ran partly in parallel with the remote full tier, which took about 1 h 20 min from
  dispatch to collection, plus a 20-minute rerun of one group. The local runs were the identity
  runs, decode-cost, smoke live g7-1/g7-2, and gate 8 plus pure after the rebase onto G8h, which
  was conflict-free.
