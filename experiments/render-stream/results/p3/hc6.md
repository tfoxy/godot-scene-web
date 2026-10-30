# HC6: the hook fast path (2026-10-29)

HC6 of `protocol/host-cost-design.md` (D5 "Hook overhead per RenderingServer call"). No wire
change, no new behaviour. As built is recorded in the design doc under D5, "As built (HC6)".

## Measured first

`hc6-perf.sh` (from `hc5-perf.sh`): capture-scale, /11, the product hand-off env (inline 4096,
hook log off, no tap), one null viewer, `RS_BENCH_PERF_ARGS="-e instructions -c 1000000"`.
`hook-leaves.py` charges every main-thread sample with a `hook_*` frame to that hook and lists
its leaf symbols; `counters.json` gives the calls per frame. Main (1e9ed59a), churn
(`RS_SCALE_REDRAWS=170`), per hook:

| hook | calls / frame | instr / call | where (share of the hook's samples) |
| ---- | ------------: | -----------: | ----------------------------------- |
| `canvas_item_add_rect` | 681 | 740 | `Command` construct and two moves 47 %, the two lookups 22 % |
| `canvas_item_clear` | 170 | 1,700 | the two lookups 49 %, `clear_for_rerecord` and `~Command` 31 % |
| `mesh_surface_update_vertex_region` | 76 | 3,300–5,100 | the region handler 34 %, census `memcmp` 8 %, `Line` strings, the log's `std::map` |
| `canvas_item_set_transform` | 102 | 1,900 | the two lookups 94 % |
| `mesh_surface_update_attribute_region` | 76 | 2,400–2,700 | as the vertex region |
| `canvas_item_set_material` | 76 | 1,700–2,200 | the lookups 70 %, the log's `Line` 10 % |
| `canvas_item_add_mesh` | 89 | 1,300–1,400 | the RID lookups 54 % (`knows_mesh`, `knows_texture`, `peek_mesh`) |
| `mesh_set_custom_aabb` | 76 | 1,400–1,800 | the log's `Line` (strings, `strlen`, `clock_gettime`) about half |
| `canvas_item_add_texture_rect` | 85 | 1,100 | the RID lookups 61 % |

Instruction samples are biased toward the instruction after a stall (skid), so "instructions" here
behave partly like cycles: the lookups are expensive because they miss the cache, two dependent
misses (the `unordered_map` bucket, then its node) plus a `std::map` walk. All mutexes together were
5 % of hook samples. Two base runs of 900 frames disagree by up to 40 % on a single hook (the
vertex region: 0.50 and 0.28 M a frame), so the comparison below uses 1,800-frame legs with 25 s
windows, two per side, interleaved.

## What changed (chosen by that measurement)

1. **Direct entry pointers.** `RidMap` (`capture/src/rs_rid_map.h`), an open-addressed flat table
   (Fibonacci hashing, linear probing, at most half full, backward-shift deletion), replaces the
   mirror's eight `std::unordered_map<uint64_t, uint32_t>` RID maps. It offers only what the mirror
   used: `find`/`end`, `count`, `operator[]`, `erase` by key and by iterator, `clear`, `size`; none
   was ever iterated. `item_by_rid_` and `mesh_by_rid_` hold the entry's `std::map` node pointer
   beside its id; the node is stable until erased, and every erase leaves the RID map first
   (`free_rid`, `retire_mesh`; a mesh tombstone has RID 0). `rekey_subtree` writes the new nodes'
   pointers after it re-emplaces them.
2. **Commands built in place.** `Mirror::emplace_command` checks the command cap and returns a
   default command at the end of the item's list; `add_rect`, `add_texture_rect`,
   `add_texture_rect_region`, `add_msdf_texture_rect_region`, `add_set_transform` and
   `add_clip_ignore` fill it there. Nothing between their lookup and their push has a side effect
   (`texture_ref` and `perturbed_glyph` are const), so checking the cap first changes nothing.
   `push_command` now takes `Command &&`, one move instead of two, for the other ops.
3. **No line, no line work.** With the hook log's lines off,
   `ResourceLog::mesh_surface_update_region` and `mesh_set_custom_aabb` move the registry exactly
   as their line paths do (version, surface copy, status) and build no `Line`. The
   `canvas_item_set_material` hook does not call the log at all then (that method keeps no
   registry). `tap_context()` reads the clock only when lines are kept: `t_ns` is a line field
   only, and a context taken before `start()` formats `t_us` 0 either way.
4. **Two locks fewer on the resource hooks.** `ResourceLog::active()` reads an atomic (every method
   re-checks it under its mutex); `Mirror::omits()` returns without the mirror's mutex unless an
   omit-op sabotage is armed (`omit_armed_`). Lock pairs per call: `set_material` 4 → 2, a mesh
   region update 7 → 5, `mesh_set_custom_aabb` 6 → 4; the canvas-item ops stay at 2.
5. **The census, indexed.** A `PodEntry` census log (every gate −1 calibration log but the three
   geometry logs, whose entries hold vectors) keeps an open-addressed index of its entries, keyed by
   a hash of the key's bytes (padding is zero-filled). A call finds its identical entry, or learns
   there is none, in about one compare. The entries, their order, counts, frames and drops are the
   linear scan's (`counters.json` is equal on every leg below).

Not done, by measurement:

- **One lock per call.** After the above, all mutexes are 9 % of hook samples (68 of 717 in the
  final churn profile), every one uncontended. Folding the census's `g_mutex`, `g_texture_order`,
  the mirror's and the log's mutexes into one main-thread lock would save part of that, for a
  locking change across four modules that loader threads also enter. Not worth it.
- **Same-value early-outs.** A same-value setter still bumps the mirror's epoch, which the live
  hub reads for `coalesced` and its pending state, so skipping it would move live counters; and
  its dirty mark costs one compare at the snapshot (HC4a). HC1's same-material `set_material`
  early-out stays the only one.

## Perf (instructions; capture-scale, /11, churn, 1 viewer)

`hc6-instr-table.py`, M instructions per frame on the main thread under each hook, and per call.
Base is main 1e9ed59a's library, copied before any change; both sides ran this branch's scripts and
fixture. Two interleaved 1,800-frame legs per side, 25 s windows (load 8–11, which instruction
counts tolerate):

| hook | calls / frame | before M / frame | after M / frame | before instr / call | after instr / call |
| ---- | ------------: | ---------------: | --------------: | ------------------: | -----------------: |
| `canvas_item_add_rect` | 681 | 0.502 | 0.315 | 737 | 463 |
| `canvas_item_clear` | 170 | 0.287 | 0.231 | 1,688 | 1,357 |
| `mesh_surface_update_vertex_region` | 76 | 0.251 | 0.195 | 3,307 | 2,566 |
| `canvas_item_set_transform` | 102 | 0.204 | 0.155 | 1,993 | 1,515 |
| `mesh_surface_update_attribute_region` | 76 | 0.183 | 0.071 | 2,408 | 930 |
| `canvas_item_set_material` | 76 | 0.127 | 0.068 | 1,671 | 897 |
| `canvas_item_add_mesh` | 89 | 0.118 | 0.109 | 1,323 | 1,222 |
| `mesh_set_custom_aabb` | 76 | 0.106 | 0.033 | 1,395 | 439 |
| `canvas_item_add_texture_rect` | 85 | 0.097 | 0.078 | 1,143 | 923 |
| `material_set_param` | 28 | 0.026 | 0.024 | 904 | 857 |
| **all hooks** | ~1,460 | **1.90** | **1.28** (−33 %) | 1,300 | 880 |
| capture total (main thread minus engine) | | 5.79 | 5.13 | | |

The first, shorter series (900 frames, 8 s windows, two base runs against one of the final
code) gave 2.16 → 1.54 (−29 %). The static frame makes no hooked call; its capture total is 0.23
M a frame on both sides.

The design's estimate for HC6 was ~0.3 ms of the fixture's churn frame. 0.62 M instructions of
hook work is about 0.15–0.25 ms at this machine's rates. **Real time was not measured:** the
machine stayed at load 7–14 (other agents' runs and this increment's identity sets), above the
brief's 4, and the hooks run outside the frame callback that `perf.json` times, so the callback
p50 is not their measure. The milestone sweep owns the ms. The real-time legs that ran, for
reference only (900 frames, `perf.json` means, p50 as the median bucket's upper bound, ms):

| leg (load) | callback p50 before → after | callback mean | snapshot mean | encode mean (encode thread) |
| --- | --- | --- | --- | --- |
| 1 viewer, static (4.9 / 3.2) | ≤ 0.10 → ≤ 0.11 | 0.16 → 0.17 | 0.04 → 0.05 | 0.05 → 0.05 |
| 1 viewer, churn (8.1 / 6.1) | ≤ 1.22 → ≤ 1.28 | 1.31 → 1.32 | 0.87 → 0.88 | 0.39 → 0.35 |

The callback is unchanged within noise, as it should be: HC6 touched no callback code. The
snapshot visits the same dirty items (the direct pointer marks exactly what `items_.mut` marked).

Evidence: `artifacts/render-stream/p3/hc6/perf/`: `instr-table.txt`, the split and leaf JSON per
leg, `hook-leaves.py`, `hc6-instr-table.py`, `hc6-perf.sh` and the series drivers.

## Byte identity (`cmp-rec.ts --tree`, main 1e9ed59a against this branch)

`hc6-ident.sh` (from `hc5-ident.sh`). Base is main 1e9ed59a's library, copied before any change;
both sides ran this branch's scripts, `RS_SABOTAGE_TIER=skip`. Beside the recordings,
`hc6-evidence-cmp.py` compares every `counters.json` (the census included: every kept entry, its
calls and frames, and the drops) and `result.json` minus timing fields and paths, and every
`resources.jsonl` line by line minus timing.

| layer | files | result |
| ----- | ----: | ------ |
| gate 1 (g1a, g1b) | 12 | identical |
| gate 2 (g2a, g2b, g2d) | 24 | identical |
| gate 5 (g5c, g5e) | 11 | identical |
| gate 8 (g8t, g8a, g8m, g8w11, g8mm, g8pt; Skip legs included) | 138 | 133 identical. `g8a/late-workers` (both sinks) and `decode-cost/capture-workers` are the known worker-timing set the brief excludes. The two others are GSW's own recordings of a live /13 session (`g8w11/gsw/scale13{,-v12}/gsw/recording.rs2`, magic `GRSC`/`GRSD`, which `cmp-rec` does not read): byte for byte they differ only in the session and stream ids and the end record's timing stats |
| capture-scale /8, /10, /11, /12, /13 (300 frames, sync workers, 64x48, redraws 170, Skip, hook log off) | 5 x 300 records | identical; stores `diff -r` equal |
| capture-scale /11, hook log on (`scale11log`) | 300 records, `resources.jsonl` | identical; store equal; `resources.jsonl` equal line for line |
| capture-scale /11, armed from a worker thread (`RS_FIXTURE_ARM=thread`, hook log on) | evidence | `counters.json` and `result.json` equal. The stream refuses adoption (`adopt-thread`, as gate 8's `late-thread` leg), so there is no recording; the census and every counter of the 289 armed frames agree |
| capture-scale /11 with the shadow oracle on (this branch) against base /11 | 300 records | identical; store equal; no `hc-shadow-mismatch` |
| `counters.json` (70), `result.json` (74), `resources.jsonl` (63) | 207 | equal but for HC5's known classes: the g8w11 coding hosts (5 legs, live-paced: their frame counts differ, so every counter does), `gate2/live-inline` (live pacing, its port), the five g8pt captures' `resources.jsonl` (`particles_set_seed`'s engine seeds: a g8pt-only rerun of both sides, `gate8pt-cmp.txt`, gave 36/36 recordings identical and all 11 `resources.jsonl` equal once `seed` is masked, `g8pt-seed-check.txt`), the three worker-timing legs, and the gate-level `result.json` files that quote them |
| every check verdict of those gate runs | 308 | the same check by check: gate 1 28/36, gate 2 46/57, gate 5 35/46, gate 8 152/169 (the failures are the sabotage legs `RS_SABOTAGE_TIER=skip` leaves out) |

Outputs: `artifacts/render-stream/p3/hc6/ident/` (the cmp-rec output per layer, `evidence-cmp.txt`,
`verdicts.txt`, both sides' gate `result.json`, the drivers). The recordings were pruned after the
comparison.

## Checks

- **`rs_rid_map_test`** (new ctest `rs_rid_map`, 19 checks): every operation the mirror uses;
  colliding runs (keys sharing a home slot, at the table's start and wrapping its end) that survive
  erasures in their middle; key 0; and 200,000 random operations per seed against
  `std::unordered_map`, with dense Godot-like RIDs (validator in the high word, a small slot index)
  and sparse ones, four seeds each.
- ctest 46/46 (main's 45 plus `rs_rid_map`), goldens and window-1 transcripts included.
- No sabotage: the design row has none ("no new behaviour; the byte-identity layers are the
  check").

## Validation

- **Remote full tier** (`remote-validate.sh --tier full`, run 40968074833, key
  `rv-20261029T224356Z-a1af8e2-4618`, on main 1e9ed59a): 21/22 runs passed.
  - The one failure was `g7live-web-rust` g7-5's `stale-coalesce@web` (the
    `sabotage-mesh-stale-coalesce` leg's step-3 mismatch showed region DF only, where the check
    wants exactly DF, Marker and RM). It is a live, timing-dependent sabotage leg on a hosted
    runner. The shadow oracle was clean in that run (44 hosts, 27,265 snapshots), and its other
    checks passed. `--only g7live-web-rust` was rerun at once (run 40979045385): 1/1 pass.
  - The runs: `pure`, `capture-build`, the four crates, `pnpm-test`, `bench-instr` (every case
    within its 1 % threshold), native gates −1, 0, 1, 2, 3, 4, 5, 5.5 and 8, `native-rust-hc1`
    (sabotage legs included), `g7-gsw`, `g7-web-rust`, `g7live-gsw` and `g7live-web-rust` (g7-2,
    g7-5, g7-55, g7-8).
  - **The shadow oracle ran on every correctness gate leg:** 774 hosts and 205,050 snapshots, no
    mismatch (gate 0 712, gate 1 4,828, gate 2 16,707, gate 3 1,568, gate 4 3,348, gate 5 2,620,
    gate 5.5 4,686, gate 8 13,449, hc1 4,533, g7-gsw 48,076, g7-web-rust 48,072, g7live-gsw
    29,186, g7live-web-rust 27,265; the rerun another 27,273).
- **Local, full tier, the groups the remote refuses:** `RS_VALIDATE_GROUPS=g7-1
  validate-increment.sh --tier full --only g7live-gsw,g7live-web-rust`: 2/2 pass, the oracle on 16
  hosts and 11,860 snapshots each, no mismatch.
- **Local smoke** (`validate-increment.sh`, sabotage legs run because the CMake file is in the
  diff): `lock-tests`, `pure`, `capture-build` (ctest 46/46), the crates, `pnpm-test`, native
  gates −1 to 8, `native-rust-hc1`, `g7-gsw`, `g7-web-rust` and both g7-1 live smokes pass.
  `bench-instr` returned 3 (no valgrind here; it passed remotely). The timing run
  `native-rust-gate6` (sabotage legs included) passed too, at loads up to 14 (59 min): 23/24.
- **Not run:** the other timing runs (`g7live-*-timing`, g7x) and the real-time callback and hook
  ms, which are the milestone sweep's.
- **Time:** implementation about 1 h 15 min (measurement included); validation and evidence about
  2 h 45 min, mostly waiting on the quiet lock behind other agents' timing legs.

## Notes for HCz

- **What to measure.** MX's legs (`results/p3/mx.md`, "Method"): menu, map and combat, 60 s each,
  one GSW viewer, /11, coding on, `GRC_HOOK_LOG=off`, no file sink, the streaming seat under
  `gamescope --backend headless`. The number is the main thread's on−off ms per frame from `/proc`
  task ticks at 1 Hz (`/proc/<pid>/task/<tid>/stat` utime+stime of the main thread), on window
  [24, 44) s against off [6, 21) s, and for combat also against its own post-disarm window (MX's
  headline 9.03/8.90 ms used that, so cross-leg load drops out). Wire from `ss -tni` `bytes_sent`
  on the server port; it should stay within 2 % of MX's.
- **How to attribute.** `perf record -g -F 499 -p <game>` over [44, 53) s, then
  `scripts/perf-attribute.py` (it resolves .NET JIT frames through the perf map by IP). For the
  capture's own split, `perf-capture-split.py --freq 499 --fps 60` on the same `perf.data`, and
  `artifacts/render-stream/p3/hc6/perf/hook-leaves.py` for the per-hook view (its m_per_frame
  assumes `-c 1000000`; with `-F 499` read its sample counts as time).
- **What STS2 calls.** `fidelity/legs/a8-2`'s `counters.json` (5,000 frames): per frame 281
  `canvas_item_add_set_transform`, 231 `canvas_item_clear`, 121
  `canvas_item_add_msdf_texture_rect_region`, and 76 each of `set_material`, `add_mesh`, the vertex
  and attribute region updates and `mesh_set_custom_aabb`; about 1,150 hooked calls. All of the
  top ones are on HC6's fast paths (the in-place command for the first and third, the direct
  pointer for every item and mesh op, the census index for the 32- and 256-entry logs they feed).
  At the fixture's after-HC6 rate (about 880 instructions a call) that is about 1 M instructions,
  roughly 0.3 ms, of combat's main thread: inside the ≤ 3 ms target with room, if the frame
  callback's share falls as HC4–HC5 projected.
- **What is left in the hooks** is mostly the first cache miss on the entry each call writes, and
  a mesh region's three passes over its bytes. If HCz finds the hooks above ~0.5 ms of combat,
  look first at `canvas_item_clear` (231 a frame; `clear_for_rerecord` and destroying the old
  commands) and at the hook's own copy of each region's bytes (`g_mesh_buffers`): with the hook
  log's lines off only its sizes are read (the bounds check), the bytes only by the line hash
  (`rehash_mesh_surface`). Skipping the copy would need the copy rebuilt whenever lines turn on.
