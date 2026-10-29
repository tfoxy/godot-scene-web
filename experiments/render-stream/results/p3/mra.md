# MRA: material residency proportional to the delta (2026-10-29)

PHN (183d2f6d, [phn.md](phn.md)) put the moto g31 in front of a capture-scale `/12` host through
`@godot-scene-web/render-stream-client`. The phone applied 12.8 distinct transactions a second
against a bar of 58. Wasm's byte-loop `memcmp` took 48% of its main thread, and all of it came from
rs-core's `MaterialResidency::apply`. On every transaction, that function walked every named
material's every parameter and compared stale names quadratically. That is ~1.1 M name
comparisons a frame on capture-scale (560 materials × 64 parameters).

MRA makes that walk follow the delta, in rs-core and in the native/web adapter's planner
(`rs-core-capi`), which had the same walk. The results are identical, and a differential replay
of the three kept STS2 recordings proves it.

Fixing that walk alone took the phone from 12.8 to only 19.0 applies/s, and `memcmp` was still
32% of the thread. PHN had put every `memcmp` sample on the residency, because the samples sat
directly under `Applier::apply`. A second walk was inlined in the same function:
`refresh_bindings`. It rebuilt every live custom-shader binding on every transaction, and it looked
up each uniform's parameter with a linear scan, which is the same O(params²) name comparison.
MRA makes that refresh follow the delta too.

**Headline.**

- **g31, PHN's leg 1 rerun** (capture-scale `/12`, window 2, W11t, 180 s, real time):
  - **41.3 distinct applies/s** at the host tap (PHN: 12.8; bar ≥ 58);
  - rAF 58.1/s with a 17.1 ms frame p95 (PHN: 19.3/s, 85.1 ms), so presentation runs at vsync;
  - credit RTT 32.5 / 45.3 ms at p50 / p95 (PHN: 132.0 / 147.1).

  That is PHN's host-only A/B (`RS_SCALE_PARAMS=4`, 40–41/s), reached with no host change. The
  rate bar is still missed. The main thread is 88% busy, spread over accept (with the record
  SHA-256), apply and draw.
- **Native, `pm7-a12-1` combat (2,713 transactions):** the materials phase drops from 27.4 to
  6.2 µs per transaction at p50 (30.6 → 7.4 at p95). Apply drops from 224.5 to 196.6 µs at p50.
  Natively the old walk was cheap, because `memcmp` is SIMD there. The phone is where it mattered.
- **Equality:** the incremental and full walks agree on every transaction of all three kept
  recordings (11,686 transactions). They agree on the needed list, the counters, the residency
  itself, the paint, the whole packed list and the stats. The planner's call streams, stats and
  needed lists agree as well, including with three transactions folded into one apply. The
  `mra-skip-changed` sabotage breaks both walks on `pm7-a12-1`.

## What changed

### rs-core `MaterialResidency::apply` (`rs-core/src/apply/material_residency.rs`)

The residency only does accounting (`applied.json`'s /5 counters). Take a material that is
resident and still named, whose entry did not change, and whose shader neither became nor stopped
being resident. A full walk counts nothing for it, because its held parameters already equal its
entry's. So the walk now visits only:

- every named material, on `all` (a fresh applier);
- the newly named materials: the named set minus the previous transaction's, a merge of two
  sorted sets. This also covers a material that changed while it was not named;
- the named materials this transaction upserted. A material entry changes only through
  `materials_upserted`/`materials_removed`. The validator's insert and remove paths are the only
  writers, and a full transaction lists every carried entry as upserted;
- the named materials whose shader became or stopped being resident in this transaction's shader
  pass. That pass still walks every named shader, which is a handful;
- materials whose entry names a parameter twice. The full walk counts two sets for such a material
  on every transaction, so it is visited every time. No recording has one; the random test does.

The candidates for "gone" (freed) are the removed and upserted ids. The stale-name check builds
one hash set over the entry's names, and only scans the held names when it holds more names than
the entry has distinct ones. Per-item instance parameters use the same linear check.

The walk before MRA is kept verbatim as `MaterialResidency::full_walk` (`apply_full`), the
oracle. `skip_changed` is the `mra-skip-changed` sabotage: on each transaction, it drops the
lowest-id resident upserted material from the visit set.

### rs-core `Applier::refresh_bindings` (`rs-core/src/apply/mod.rs`)

A custom-shader binding holds its program's uniforms (from its material's parameters, and from its
item's instance parameters for instance uniforms), its samplers, the canvas modulate and, for a
program with its own vertex stage, the canvas transform. Every apply recomputed every live slot
and compared it with `DrawList::set_binding`. Each uniform found its parameter with
`programs::param`, a linear scan. On capture-scale that is ~170 bindings × 64 uniforms × 64
parameters a frame.

A binding's values read:
- its program;
- its material and its item;
- its material's shader (default textures);
- its canvas;
- the entries and residency of the textures it samples.

Each slot now remembers its key and the texture ids its last values read: sampler parameters,
shader defaults, a canvas texture and its diffuse. The refresh rules:
- every slot, on a fresh applier, when a program was registered or replaced, when a shader or
  canvas changed, and under `stale-param`;
- otherwise, only:
  - a new or re-keyed slot;
  - a slot whose material or item the transaction upserted or removed;
  - a slot that reads a texture the transaction upserted or removed, or whose residency changed.
    `sync_textures`'s `resized` covers every resident image or placeholder that appeared, went,
    or changed kind or size, and that is all `binding_of` reads of the residency.

`binding_of` builds one name table per binding when the parameter list is longer than 8
(`ParamIndex`: the first non-`nil` parameter of each name, `programs::param`'s rule). The oracle
is `Applier::always_refresh_bindings`. The sabotage `skip_binding_refresh` (`mra-skip-binding`)
ignores the "material upserted" reason.

### rs-core-capi `Planner::apply_materials` (`rs-core-capi/src/plan.rs`)

The native receiver's and web export's planner had the same walk, and a heavier one:
- every named material re-encoded every parameter's Variant;
- each parameter looked up its held entry with a linear `find`.

Outside `full_scan` (the O(state) oracle that `delta_equals_full_scan_on_golden_6` already compares
against), it now visits only the named materials that can send a call (`MatWalk`):
- newly named, or touched since the last apply (the union of the applied transactions'
  `Touched`);
- whose shader entry was touched, or whose shader RID appeared, disappeared or changed in
  `apply_shaders` (the handles are diffed around the call);
- with a `rid` parameter, when a texture RID was created or freed (`tex_rid_changed`), or when a
  texture they name was touched;
- visited at every apply: a shader that reads `TIME` sets the host time every transaction, and a
  duplicated parameter name re-sends every time;
- everyone, when `gl_compatibility`, `host_linear_colors` or the sabotages change.

Freed-material candidates are the touched ones. A held parameter is first looked for at the
entry's own position, which is the common case, before the scan. The call order is unchanged:
ascending material id, entry parameter order, held order for the stale ones.

### Tools

- `rs-core-check material-diff <recording>... --store <dir> [--sabotage
  mra-skip-changed|mra-skip-binding] [--baseline]` replays through two appliers in lockstep. One is
  incremental; the other is the oracle (`full_walk` and `always_refresh_bindings`). After every
  transaction it compares:
  - the needed list (fetch order);
  - `material_counts`;
  - the residency (`same_residency`: shader codes, bindings, parameters, instance parameters);
  - `paint_digest` (every draw with its binding's values) and the stats less their timings.

  Natively there is no transpiler, so each newly named shader gets a synthetic program on both
  sides (`synthetic_program`). Its uniforms are its materials' scalar and vector parameters, its
  instance uniforms come from its items, its samplers are the texture parameters, and odd hashes
  get a vertex stage. That way the binding refresh runs.

  The whole packed list's digest is reported but not judged. Two appliers number their binding
  slots differently, because released slots go back in `HashMap` order. `--baseline` puts the
  oracle on both sides, and it shows exactly the same count (3,492 on `pm7-a12-1`).
- `rs-core-capi-check recordings <recording>... --store <dir> [--every N] [--sabotage
  mra-skip-changed]` does the same for the planner against `full_scan`. It compares every apply's
  needed list, the call stream (words and arena) and the stats Variant. `--every N` applies after
  every Nth transaction, so the deltas of N transactions fold into one apply.
- rs-core unit tests `mra_incremental_walk_equals_full_walk` and `mra_skip_changed_sabotage_is_caught`
  (`cargo test` in rs-core) run 400 random runs of 120 transactions each. The runs create, change,
  remove and un-support shaders and materials; name and un-name materials; skip withheld shaders;
  and rename, drop and duplicate parameters. They run with and without `stale-param`. The sabotage
  must fail all 50 of its runs.

## Equality

rs-core (`material-diff`, residency and binding refresh against the oracle):

| recording | transactions | honest | `mra-skip-changed` | `mra-skip-binding` |
| --- | ---: | --- | --- | --- |
| `pm7-a12-1` (/12, menu, map, combat) | 4,955 | 0 mismatching | **4,948 mismatching** (counts, residency) | **2,750 mismatching** (paint, stats) |
| `pm-a11-1` (/11) | 4,947 | 0 mismatching | — | — |
| `late-1` (/8, late join) | 1,784 | 0 mismatching | 0 (no resident material changes) | — |

The planner (`rs-core-capi-check recordings`, against `full_scan`):

| recording | every transaction | `--every 3` | `mra-skip-changed` |
| --- | --- | --- | --- |
| `pm7-a12-1` | 0 mismatching applies | — | **183 mismatching** (calls, stats) |
| `pm-a11-1` | 0 | — | — |
| `late-1` | 0 | 0 | 0 (as above) |

`late-1` upserts its 115 materials only while they are new, so dropping a "changed resident"
material has nothing to drop. That recording cannot show the sabotage; `pm7-a12-1` shows it on
both sides. The full walk on `pm7-a12-1` counts only 1,294 parameter sets over 4,955
transactions, against 561 materials re-walked on every one: the visit set is almost always empty.
The capi's golden test `delta_equals_full_scan_on_golden_6`, and its sabotage test, also hold the
planner to `full_scan` call for call.

## Native cost (`rs-core-check profile`, `pm7-a12-1`, 3 repeats, minimum per transaction)

"Before" is main (183d2f6d) built from `git archive`, and "after" is this tree. Both ran under the
exclusive quiet lock, back to back. Combat is the recording's last 2,713 transactions (w13a.md's
split).

Two runs, each a before/after pair. Run 1 had the residency fix only; run 2 is the final tree.

| µs per transaction | run 1 before → after (p50 / p95 / mean) | run 2 before → after (p50 / p95 / mean) |
| --- | --- | --- |
| combat: materials phase | 27.4 / 30.6 / 27.7 → **6.2 / 7.4 / 6.4** | 26.0 / 29.1 / 26.3 → **6.5 / 7.8 / 6.7** |
| combat: apply | 224.5 / 252.2 / 227.5 → 196.6 / 223.3 / 199.9 | 215.2 / 232.4 / 217.2 → 212.5 / 259.9 / 217.4 |
| menu + map: materials phase | 17.5 / 20.8 / 18.3 → 4.8 / 5.5 / 5.2 | 16.9 / 20.4 / 17.7 → 4.9 / 5.7 / 5.3 |
| menu + map: apply | 63.7 / 115.6 / 84.1 → 48.7 / 94.7 / 68.0 | 60.5 / 112.6 / 81.5 → 51.8 / 99.0 / 71.2 |

The materials phase drops by ~20 µs a transaction, and repeats exactly. Natively, the whole apply
moves within its run-to-run noise (run 2's combat apply did not move). The quiet lock does not see
other repos' load. The `profile` replay registers no programs, so its bindings phase is ~0 µs
either way; the phone is where the binding refresh shows.

What remains in the materials phase is O(named) integer work: `Names` hands over cloned named
sets, and the walk diffs them against the previous transaction's. It does no string work.

## g31: PHN's leg 1 again

The command is phn.md's, with this tree's capture and client core
(`packages/render-stream-client/scripts/build-web.sh`). It ran in real time under the bench's
exclusive lock, after a load gate (< 4 at start). The phone was on USB at 100% battery, with
thermal status `none` before and after every leg. Column 3 (L1a) is the residency fix alone;
column 4 (L1b) is the final tree.

| | PHN leg 1 (before) | L1a: residency only | **L1b: MRA** |
| --- | ---: | ---: | ---: |
| distinct applies/s, host tap (bar ≥ 58) | 12.8 | 19.0 | **41.3** (sent 41.5, folded 49) |
| applies/s, page (folds included) | 13.7 | 20.4 | 44.2 |
| credit RTT p50 / p95, host tap | 132.0 / 147.1 ms | 90.0 / 100.5 | **32.5 / 45.3** |
| latency p50 / p95, host tap | 128.3 / 143.0 ms | 86.3 / 96.3 | 28.4 / 41.5 |
| rAF rate; frame interval p50 / p95 | 19.3/s; 68.0 / 85.1 ms | 27/s; 34.1 / 51.1 | **58.1/s; 17.0 / 17.1** |
| rAF callback p50 / p95 | 57.9 / 60.8 ms | 35.0 / 38.6 | 8.6 / 14.3 |
| `onmessage` p50 / p95 (busy per s) | 12.3 / 13.8 ms (165) | 11.8 / 12.9 (238) | 7.4 / 11.7 (368) |
| remounts 2–4, applies/s | 14.4 / 14.4 / 14.4 | 22.2 / 22.1 / 21.9 | 45.8 / 45.0 / 45.0 |
| first frame after `mount()` | 13.35 s | 13.72 s | 14.03 s |
| wasm heap; renderer PSS streaming | 322.7 MiB; 411.9 | 322.7; 424.4 | 322.7; 429.3 |
| renderer PSS after each dispose + GC | 79.3 / 79.0 / 79.1 / 76.1 | 84.2 / 82.0 / 81.7 / 85.3 | 89.7 / 89.4 / 89.5 / 89.6 |
| host fps | 57.9 | 59.7 | 59.9 |
| machine load (1 min), leg start; driver start / end | 3.77; 1.98 / 3.92 | 3.73; 3.73 / 0.84 | 3.72; 1.95 / 1.89 |
| battery temperature | 26.3 → 28.1 °C | 27.0 → 28.9 °C | 27.4 → 29.6 °C |

All five driver checks pass on both legs: `mounts-streamed`, `instance-released`,
`remount-no-growth`, `heap-baseline` and `device-provenance`. `rate-60` is reported as failed, as
in PHN. The bench's `update-rate` (≥ 15) and `credit-rtt` (≤ 100 ms) pass on both legs.

`onmessage` busy time grows because the phone now takes 44 messages a second instead of 14, while
each message gets cheaper.

**Profile (10 s CPU profile at 500 µs sampling, L1b).** By entry point:

| | PHN L1 | L1a | L1b |
| --- | ---: | ---: | ---: |
| `GswRs::apply` | 75% | 64% | **25%** |
| `GswRs::live_accept` | 14% | 19% | 28% |
| `GswRs::draw` | 4% | 7% | 14% |
| zstd decode | 3% | 4% | 7% |
| other JS / program | — | 5% | 13% |
| idle | 0% | 1% | 12% |
| self `memcmp` | 48% | 32% | **< 0.5%** (not in the top 25) |
| self `sha2::compress256` | 7% | 9% | 11.4% |

L1a's 32% of `memcmp` sat under `Applier::apply` itself (3,071 of 3,223 ms). That was
`refresh_bindings`, inlined. In L1b, the top self functions are:

| function | share |
| --- | ---: |
| `sha2::compress256` | 11.4% |
| `Applier::cull` | 5.8% |
| `dlmalloc` free/malloc | 5.7% |
| `CanvasItemsExecutor::draw` | 4.1% |
| `Applier::apply` | 2.1% |

## Next phone bottleneck

At 41/s the g31's main thread is 88% busy (12% idle). Window 2's credit loop at a 32.5 ms RTT would
allow ~60/s, so the phone is still the limit, and no single function dominates any more. The
candidates, in order of the profile:

1. **The record SHA-256 in `Validator::accept`** is 836 ms of 10 s (8.4% of the thread). Live mode
   digests every record inline (`rs-gsw-wasm` `start`: `digest: Inline` whenever `live`), and only
   `last_digest_ptr` exposes it. `@godot-scene-web/render-stream-client` never reads it. A
   `digest: "none"` option, which the client would pass and the harness receiver would not,
   removes it. That touches the published client package and its tests, so it was left for its
   own increment (**next: MRD**).
2. **Mesh-body and multimesh SHA-256s in `Validator::apply`** take 301 ms (3%). These are the /11
   dynamic body hashes of capture-scale's 76 updated meshes. They are mesh identity, not
   evidence, so they need a cheaper identity, not a removal.
3. **`Applier::cull`** (5.8%) and allocator churn (5.7%), both per frame.
4. **Draw**: 14% (`CanvasItemsExecutor::draw` 4.1%; the GPU process at 1.03 cores in the trace).

STS2's combat has fewer custom-shader bindings than capture-scale, and the same 561-material
residency. Its phone apply should gain at least the residency share; that was not measured here
(no recording→hub replayer, phn.md).

## Validation

`validate-increment.sh --plan` reaches every native gate, the GSW and web-rust gate 7 groups and
both crates. The capi check tool names a sabotage, so the sabotage legs run.

- **Crates.** `cargo test` passes in rs-core (with the two MRA tests) and in rs-core-capi
  (`delta_equals_full_scan_on_golden_6` and `sabotages_change_the_calls` included). Clippy
  reports nothing new.
- **Smoke tier (local, base 183d2f6d).** These runs pass: pure, both cargo runs, native gates
  -1, 0, 1, 2, 3, 4, 5, 5.5, 8 and hc1, g7-gsw, g7-web-rust, and the g7-1 live smokes on GSW and
  web-rust. `bench-instr` exits 3 locally (valgrind is not installed; the remote job produces it).
  The timing run (native gate 6) was stopped after 43 minutes with no failure so far, because
  timing is deferred to the milestone sweep. The smoke's `cargo-rs-core` predates the binding
  change; the crate tests above re-ran it.
- **Full tier, once, remotely** (`rv-20261029T175532Z-caadb80-18312`, run 40925949646). 17 of 18
  runs pass. `g7live-web-rust` failed g7-55's `live-shader-warm`: "no shot" for step 9, the known
  hosted-runner flake. Its rerun (`rv-20261029T192001Z-d231884-3333`, run 40939141082) passes. An
  earlier dispatch (run 40915456197) predates the binding change and was cancelled.
  `bench-instr` on the Intel runner is +0.03% to +0.69% in Ir.
- **Refused groups, locally at the full tier** (`RS_VALIDATE_GROUPS=g7-1`): `g7live-gsw` and
  `g7live-web-rust` g7-1, 11 legs each, both pass.
- **Timing runs** (native gate 6, the g7-6/g7-lc/g7-r/g7-k live runs, g7x) are deferred to the
  milestone sweep. The phone leg above is this increment's timing evidence.

## Deviations

- **Scope grew by one function.** The brief named `MaterialResidency::apply`. The phone showed
  that `refresh_bindings` was half of PHN's `memcmp`, so it follows the same rule here, with its
  own oracle and sabotage.
- **The "before" for the phone is PHN's leg 1.** It ran at 900afa5c (before HC5), not at this
  increment's base. HC5 moved the host's transaction forming off its main thread, and every leg
  is phone-bound (phn.md), so the comparison holds. L1a, the residency fix alone at this base, is
  the intermediate point.
- **The record SHA-256 was measured, not fixed** (see "Next phone bottleneck").
- **The whole-list digest is not judged in `material-diff`** (binding slot numbering; see
  "Tools"). The paint digest and the stats are judged.

## Evidence

`artifacts/render-stream/p3/mra/` (main checkout):
- `material-diff.txt`, `capi-recordings.txt`: the equality runs and their sabotages;
- `profile-run1-summary.txt`, plus `profile-run2-{before,after}.jsonl.gz`: the native table
  (`rs-core-check profile` rows);
- `L1a/` and `L1b/`: the phone legs, each with `client-device.json`, `cpu-profile.json`,
  `bench-live-scale.json`, `result.json`, `launcher.out` and `scale-report.json`; `L1b/trace.json.gz`
  is L1b's trace;
- `tools/`: the leg wrapper (`mra-leg.sh`, phn-leg.sh with a load gate), the differential driver
  and the profile summary script. PHN's `tools/phn-entry.py` and `phn-callers.py` made the profile
  tables.

## Memory-worthy facts

- **One `memcmp` hotspot was two functions.** Each was inlined into `Applier::apply`:
  `MaterialResidency::apply` and `refresh_bindings`. PHN put all 48% on the first. After a fix,
  profile the phone again before calling the share gone. `phn-callers.py <profile> memcmp` shows
  which frame the samples sit under.
- **Two appliers number binding slots differently.** Released slots go back in `HashMap` order.
  So whole-list digests differ between any two `Applier` instances (3,492 of 4,955 transactions on
  `pm7-a12-1`, oracle against oracle). Compare `paint_digest`, which compares binding values.
- **Native `rs-core-check` replays register no programs.** Natively `refresh_bindings` never runs,
  so its cost and its correctness need either the phone or `material-diff`'s synthetic programs.
- **Natively the residency walk cost only ~20 µs a transaction** (SIMD `memcmp`). On the g31 it cost
  ~35 ms. Desktop numbers say nothing about wasm string work.
- **Without valgrind, `bench-instr` exits 3 locally.** The remote job is its producer.
- **A refused group runs locally with `RS_VALIDATE_GROUPS`.** Use `RS_VALIDATE_GROUPS=g7-1
  validate-increment.sh --tier full --only g7live-gsw,g7live-web-rust`, because `--only
  g7live-gsw-g7-1` is a smoke-only id.
