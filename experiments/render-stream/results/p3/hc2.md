# HC2: shared command lists (2026-10-28)

HC2 of `protocol/host-cost-design.md` (D1 "Shape" and "An identical re-record is not a change",
D2's `content_version` row). No wire change.

1. **`ItemState::commands` is a `SharedVector<Command>`.** The mirror, every snapshot and every
   base a connection holds share one list until the item records again, so a snapshot copies a
   pointer per item, not its commands. `SharedVector` (P3-CAP's, `rs2_snapshot.h`) gains
   `clear_for_rerecord(spare)`: a sole holder clears in place (capacity kept). A shared list is
   left to its holders, and the item takes its spare buffer, or failing that a fresh list sized
   like the old. Its sole-holder test now pairs with another thread's release through an acquire
   fence. `push_back` takes the element by reference: by value it moved a 320-byte `Command` twice
   per `canvas_item_add_*` hook.
2. **An identical /11 re-record keeps its list and its digest.** The mirror keeps the list each
   item's digest describes (`cv_commands`). At the snapshot, an item whose counter moved compares
   its new list with that one field by field, every float by bit pattern
   (`rs2::command_lists_equal_bits`, every `Command` field whatever the kind; a `static_assert` on
   `sizeof(Command)` trips when a field is added). If they are equal, it publishes the kept list
   (shared with earlier snapshots) and the kept digest. No JSON encode and no SHA-256 run, and the
   new list's storage becomes the item's spare for the next clear, so a steady identical re-record
   allocates nothing. If they differ, it digests as before. Below /11 nothing changes: the
   counter is the wire's `content_version`, so a re-record stays a change there.
3. **Counters.** `result.json` `stream.gate8.content_version` (/11 file streams):
   `{digests, rerecords_kept}`.

## Perf (capture-scale, /11, product hand-off env: inline 4096, hook log off, no tap)

Same configs as HC1 (`hc-drive2.sh` → `artifacts/render-stream/p3/hc2/hc2-perf.sh`). "Before" is
main at 37c41892 (HC1), "after" this branch, same scripts and fixture, only the extension differs.

**The machine was loaded throughout:** load averages 4–35 from other repositories outside the
quiet lock. Cycle profiles could not resolve a sub-millisecond change, because untouched buckets
(the engine included) moved ±20–30% between runs, and two ABBA repeats did not settle it. So the
primary measure is a **retired-instruction profile**. `bench-*-scale.sh` now take
`RS_BENCH_PERF_ARGS` (`-e instructions -c 1000000`), split with `perf-capture-split.py --freq 1000`,
whose "ms" column is then millions of instructions per frame. Instructions barely move with load.
Per-frame totals still move with how many transactions the credit loop formed in that run (zstd,
diff and encode scale with it), so compare the functions HC2 touches. The repeat of the 1-viewer
churn leg shows the spread.

Main-thread capture (main minus engine), M instructions per frame:

| scene | viewers | before | after | saved |
| ----- | ------: | -----: | ----: | ----: |
| static | 0 | 0.02 | 0.03 | 0 |
| churn | 0 | 3.73 | 3.67 | 0.07 |
| static | 1 | 16.67 | 16.77 | −0.10 (pacing noise; snapshot below) |
| churn | 1 | 30.43 / 30.71 | 29.94 / 28.11 | 0.49 / 2.59 |
| static | 4 | 16.94 | 17.53 | −0.59 (pacing noise; zstd/encode/diff) |
| churn | 4 | 32.51 | 30.53 | 1.98 |

The functions HC2 changes, M instructions per frame (1-viewer churn, both runs):

| function | before | after |
| -------- | -----: | ----: |
| `Mirror::snapshot`, inclusive | 7.14 / 7.08 | 5.80 / 5.12 |
| of which `command_list_digest` (JSON encode + SHA-256) | 1.35 | 0 |
| of which the `ItemState` copy (`vector::push_back`) | 1.73 / 1.83 | 1.44 / 1.35 |
| snapshot release (`~Snapshot`) | 1.40 / 1.41 | 1.32 / 1.19 |
| hooks `canvas_item_add_rect` / `canvas_item_clear` | 0.45 / 0.34 | 0.47 / 0.31 |

Static, 1 viewer: snapshot 5.06 → 4.79, its `ItemState` copy 1.39 → 0.91, release 1.04 → 0.99.
4-viewer churn: snapshot 6.96 → 5.80.

In time, from the cycle profile least disturbed by load (load 4–5, 1-viewer churn):
`Mirror::snapshot` 2.41 → 2.06 ms, its `ItemState` copy 0.57 → 0.36 ms, the digest and its SHA-256
0.23 → 0 ms. The first branch build, which allocated a list per re-record and took `push_back`'s
argument by value, also cost +0.04 ms on the clear and add hooks. The spare buffer and the
by-reference `push_back` removed that cost (instructions above). **HC2 saves about 0.35–0.45 ms a
frame under churn and about 0.1 ms static** on this fixture, against the design's ~0.7 / ~0.5.

**Why less than designed.** capture-scale draws from only 357 of its 4,200 items (187 meshes and
170 texture rects; the rest are chain links with no commands), so command lists were a small part
of the snapshot copy. The rest of that copy is `ItemState`'s own vectors, mostly the
`children` list every chain item holds: one allocation per item per snapshot. HC4a's `SharedTable`
makes the whole entry a shared pointer, which removes that copy too, so `children` was left alone
here. STS2's items draw far more often (Controls, Labels: WB counted 231 clears a frame), so its
share of commands, and HC2's saving there, should be larger. HCz measures it.

Evidence: `artifacts/render-stream/p3/hc2/perf/` (`instr-table.txt`, `cycles-abba-table.txt`,
`snapshot-callees-*.txt`, the split JSON/text per run), drivers `hc2-perf.sh`, `hc2-snapcallees.py`.

## Byte identity (`cmp-rec.ts --tree`, main against this branch: 37c41892, then 3111688e after the rebase)

| layer | files | result |
| ----- | ----: | ------ |
| gate 1 (g1a, g1b) | 33 | identical |
| gate 2 (g2a, g2b, g2d) | 41 | identical |
| gate 5 (g5c, g5e) | 20 | identical |
| gate 8 (g8w11, g8mm; g8pt not landed) | 64 | identical |
| capture-scale /8, /10, /11, 300 frames, sync workers, 64x48, churn + redraws 170 (final code) | 3 x 302 records | identical; stores `diff -r` equal |
| capture-scale /10, /11 with `RS_SCALE_REDRAW_VARY=17` (5,100 unequal re-records; both sides run this branch's fixture) | 2 x 302 records | identical; stores equal |
| `resources.jsonl`, hook log on, minus timing fields | 56 | 49 equal; 7 live hosts (g8w11 coding legs, `gate2/live-inline`) differ only in serve/GET events and frame numbers (live pacing); their hook lines are equal, 119,029 and 85 lines |
| after the rebase onto 3111688e: gate 8 (g8w11, g8mm, g8pt) | 82 | identical |
| after the rebase: capture-scale /8, /10, /11, /12 (as above) | 4 x 302 records | identical; stores equal |
| goldens 2–12, window-1 transcripts (ctest; 36 before the rebase, 41 after) | 41/41 | pass |

Outputs: `artifacts/render-stream/p3/hc2/ident/` (`ident-rebased/` after the rebase).

## Checks (in `run-hc1.sh`, the `native-rust-hc1` run; `lib/hc1-checks.ts`)

New legs: /11 file sinks, `RS_SCALE_REDRAWS=40` of the small fixture's 60 drawing items, 150
frames, about 10 s each.

- `cv-stable-on-rerecord` (`rr-same`): every steady patch has 0 items; one digest per item
  (400, its first publication); `rerecords_kept` ≥ 40 × patches (5,960 of 5,960).
- `rerecord-unequal-patched` (`rr-vary`, new fixture knob `RS_SCALE_REDRAW_VARY=8`: 8 of the 40
  re-record with the first `add_rect`'s height toggled by 0.5): every steady patch carries exactly
  those 8 items, with their lists under a moved `content_version`; one digest per varied re-record.
- `sabotage-rerecord-stale-caught`: `GRC_HC_SABOTAGE=rerecord-stale` (a re-record with the same
  command kinds counts as identical, so one differing float keeps the stale list) fails
  `rerecord-unequal-patched` (0 items a patch).
- `sabotage-cv-churn-caught`: W11b's `cv-churn` fails `cv-stable-on-rerecord` (40 items a patch,
  every one a `content_version` move).
- Unit tests: `rs2_diff_test::test_shared_command_lists` (sharing, copy-on-write divergence, the
  sole-holder and spare reuse, `command_lists_equal_bits` field by field incl. −0/+0 and NaN,
  resolve sharing the base's list); `rs_mirror_test::test_hc2_shared_command_lists` (share and
  divergence below /11, re-record equal and unequal at /11, two re-records in one frame, A-B-A, the
  sabotage).

## Deviations from the design

- The design's "keeps the previous vector at clear" is done at the snapshot instead: the item
  keeps the list its digest describes, which is the last published one. The result is the same, and
  the compare stays where HC4a's dirty rule will put it ("an item whose counter moved compares its
  new list with the kept one").
- `rerecord-stale` is caught by a generic capture-scale oracle (the fixture's own varied re-records
  must reach the patches), not by gate 6 receiver pixels or `dyn-wire`. It is cheaper and
  deterministic, and it names the item count it missed. Like HC1's `pin-late`, it is env-only
  (`GRC_HC_SABOTAGE`) and never declared on the wire, so no sabotage name joins the protocol.
- `cv-stable-on-rerecord` runs on the small fixture (40 re-records of 60 drawing items) rather than
  4,200 items with 170: same rule, about 10 s a leg.
- Measurement: retired instructions are the primary before/after measure, because machine load made
  cycle shares unusable for a change this size (above). `RS_BENCH_PERF_ARGS` is the opt-in that
  made it possible; the default sampling is unchanged.

## Validation

Rebased onto 3111688e (PM5, UIT). The one conflict was the /11 digest block: PM5's /12 lowering
(`cv_digest_below12`, `lower_particles_commands`) now runs in HC2's "list changed" branch, and
`command_lists_equal_bits` gained PM5's `Command::particles`. The `sizeof` tripwire fired on it
(320 → 328 bytes) as intended. Post-rebase identity against 3111688e: capture-scale /8, /10, /11,
/12 identical, stores equal; gate 8 g8w11, g8mm, g8pt below. ctest 41/41; `native-rust-hc1` full
pass (run 20261028T173050Z).

- Local smoke before the rebase (`validate-increment.sh --tier smoke`, run 20261028T143625Z): pure,
  capture-build, cargo (4), pnpm-test, native gates −1, 0, 1, 2, 3, 4, 5, 5.5 pass. `lock-tests`
  failed (known load-sensitive; no lock file in the diff). `bench-instr` returned 3 (no valgrind
  here; the remote job produces it). I stopped the run during gate 8, because the remote full tier
  covers the rest.
- Remote full tier before the rebase (`remote-validate.sh --tier full`, run 40727924253, key
  `rv-20261028T163813Z-510c85f-7630`): 20/22 pass, `native-rust-hc1` and native gates −1 to 5.5
  included. The two failures:
  - `native-rust-gate8` `ktx2-wire`: the g8ku live probe's KTX2 GET answers 404. **It fails the same
    way on main 3111688e locally** (`run-gate8.sh --legs g8ku`, both trees), so it is not HC2's,
    which touches neither textures nor serving. Probable cause: HC1's pin-on-hello. The probe GETs
    the first `.ktx2` as soon as the file sink stores it, before the late receiver's hello pins
    anything. See "Open" below.
  - `g7-web-rust` g7-8: `web-repeat-identical@web` (the known hosted-runner flake) and
    `mm-reference-catches-stale-buffer@web`. Rerun locally after the rebase (`RS_VALIDATE_GROUPS=g7-8
    --tier full --only g7-web-rust`, run 20261028T174733Z): pass.
- Refused by the remote, run locally: `g7live-gsw` and `g7live-web-rust` g7-1 (full,
  `RS_VALIDATE_GROUPS=g7-1`, run 20261028T165721Z): 2/2 pass.
- Not run: the timing runs (native gate 6, `g7live-*-timing`, g7x), which go to the sweep.

## Open

- `ktx2-wire` on main: the g8ku probe in `run-gate8.sh` (`run_g8ku_live`) should wait until the
  host has pinned the hash, for example for a `pin` line naming it in the host's `resources.jsonl`
  (the hook log is on there), before its GET.
