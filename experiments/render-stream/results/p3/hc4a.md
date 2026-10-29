# HC4a: persistent item and canvas tables (2026-10-28)

HC4a of `protocol/host-cost-design.md` (D1 "Shape", "Dirty sets", "The snapshot", "The diff"; the
shadow oracle of "Byte-identity proof method"). No wire change. As built is recorded in the design
doc under D1, "As built (HC4a)".

1. **`rs2::SharedTable<T>`** (`rs2_snapshot.h`) holds `Snapshot::items` and `Snapshot::canvases`:
   entries keyed by wire id in chunks of 64 ids, each chunk an immutable shared array of
   `shared_ptr<const T>`. Copying a table bumps one refcount per chunk; a write copies its chunk's
   pointer array (in place while no other table holds it). It keeps `std::vector`'s read interface
   (`size`, `operator[]`, `begin`/`end`, `front`, `back`), so the codec and readers compile
   unchanged. Writers use `set`, `erase`, `push_back`, `mutate_if` (lowering, the perturb-transform
   sabotage) and `mut(i)` (tests). Iteration is always ascending by id.
2. **The mirror keeps the published state.** `pub_items_` and `pub_canvases_` are the tables every
   snapshot shares. The items sit in an `ItemMap` whose only mutable accessors (`mut`, `emplace`,
   `erase`, `mut_all`) mark the item dirty, so every write path is found by the compiler. A snapshot
   visits only the marked, erased and newly withheld or released items. For each it refreshes the
   /11 digest (HC2's rule), builds the entry, and republishes it only when `item_state_difference`
   finds a field that differs (every field, floats by bit pattern). A same-value setter costs one
   compare and publishes nothing. Canvases, a handful, are compared whole every snapshot.
3. **Derived parts are cached and recomputed where their inputs moved.**
   - Item-level `unsupported` entries are cached per item and rederived for the visited items. The
     `use_parent_material` descendants of an item whose material inputs moved are rederived too.
     Every item is rederived when an input other items read moves: the set of unsupported or
     delivery-pending textures, the set of unsupported meshes, or the verdict of a referenced
     multimesh, emitter or effective material.
   - Draw-index ties are recomputed for each container a visited item, or a changed canvas, can
     move.
   - Each item's sorted entries, and their concatenation, are rebuilt only when they change.
   - The multimesh and emitter references and the lowering flags are counted per published item.
   - The tombstone walk over every item's commands runs only while a tombstone exists.
   - Under Skip, the items parented to an unknown RID are tracked, so the withheld walk runs only
     while one exists.
4. **`make_patch` diffs items and canvases by chunk** (`diff_tables`). A chunk both snapshots
   share is skipped whole, and so is an entry both share. Only differing entries are compared field
   by field.
5. **The shadow oracle** (`GRC_HC_SHADOW=1`, a test knob). Every snapshot is also built by the full
   walk the tables replaced (`full_walk_items`, with no side effects; the /11 digest is computed
   fresh when the cache is stale). The oracle compares:
   - the withheld set, the items and canvases entry by entry, and the item-level entries;
   - the multimesh and emitter references, and the lowering flags;
   - the encoded `make_patch(previous, current)` at the stream's version against the same patch
     over the full walk's snapshots.

   The first difference ends the stream with `hc-shadow-mismatch: <table> id <id>: <field> at
   frame <f>`. `counters.json` reports `hc_shadow {enabled, checked, mismatches, first}` and
   `hc_tables {items_visited, items_republished, full_rebuilds, derived_all, dirty_marks_dropped}`.

   Runners pass `HC_SHADOW=1` from their environment to every launch as `GRC_HC_SHADOW=1`
   (`lib/gamescope.sh gs_strip_env_args`, `run-hc1.sh`). `validate-increment.sh` sets it for every
   correctness run of the full tier and of a milestone sweep, never in the timing phase. After each
   such run, `lib/hc-shadow-scan.py` reads every host's `counters.json` into `<run>/hc-shadow.json`
   and fails the run on any mismatch. `validate-summary.json` lists the account per run
   (`hc_shadow`).

## Perf (capture-scale, /11, product hand-off env: inline 4096, hook log off, no tap)

The HC3 configs (`hc4a-perf.sh`, from `hc3-perf.sh`). "Before" is main 60ddee77 (HC3), "after"
is this branch: same scripts and fixture, only the extension differs. Runs alternate base, hc4a.
Load was 3 to 9 from other agents.

**Retired instructions** (`RS_BENCH_PERF_ARGS="-e instructions -c 1000000"`, `perf-capture-split.py
--freq 1000`), M instructions per frame on the main thread. Capture is the main thread minus the
engine.

| leg | capture before | capture after | saved |
| --- | ---: | ---: | ---: |
| 1 viewer, static | 16.36 | 9.83 | 6.53 (40 %) |
| 1 viewer, churn (`RS_SCALE_REDRAWS=170`) | 25.70 | 20.71 | 4.99 |
| 1 viewer, churn (repeat) | 24.40 | 20.36 | 4.04 |
| 0 viewers, static | 0.04 | 0.03 | 0 (HC1: no snapshot) |
| 0 viewers, churn | 2.16 | 2.23 | −0.07 (the hooks' dirty marks) |

Per bucket, 1 viewer, static → churn (M instructions per frame, before → after):

| bucket | static | churn |
| --- | --- | --- |
| snapshot: item walk and copies | 3.92 → 1.45 | 4.32 → 2.78 |
| diff (`make_patch`) | 3.08 → 0.79 | 2.92 → 1.04 |
| previous-snapshot release / publish | 1.06 → 0.34 | 1.22 → 0.57 |
| frame callback, other | 1.11 → 0.62 | 1.37 → 0.90 |
| hub | 0.31 → 0.09 | 0.65 → 0.15 |
| record planning, serving, textures/meshes/shaders (HC4b's) | 6.53 → 6.31 | 7.46 → 7.74 |

The "item walk" bucket after HC4a is mostly not items. It holds the payload map's rebuild (string
map inserts for every texture, about 0.9 M) and the texture fingerprint walk. `publish_items`
itself costs about 0.25 M a static frame.

**Real time** (no perf, ms; `perf.json` histogram means, and p50 as the median bucket's upper
bound):

| leg | callback p50 before → after | callback mean | snapshot mean | diff mean |
| --- | --- | --- | --- | --- |
| 1 viewer, static | ≤ 3.84 → ≤ 2.30 | 4.07 → 2.46 | 2.14 → 1.12 | 0.65 → 0.21 |
| 1 viewer, churn | ≤ 5.38 → ≤ 4.61 | 5.75 → 5.08 | 2.41 → 2.09 | 0.77 → 0.31 |
| file sink, no viewer, static (`bench-capture-scale.sh --mode file`) | 3.20 → 1.92 | 3.87 → 2.66 | | |

**HC4a saves about 1.6 ms of a static frame and 0.7 ms of a churn frame** at one viewer, against
the design's ~1.6 / ~1.4.

**`static-near-zero` (callback p50 ≤ 0.5 ms) is not met by HC4a alone.** The static p50 is 2.3 ms
with a viewer and 1.9 ms with a file sink. What remains is HC4b's resource-table work, still a full
walk every frame:
- `records_before` and `inline_names`' name sets: 3.9 M;
- the payload map rebuild and the texture, mesh and material walks: about 2 M;
- serving and the budget: 1.2 M.

The milestone sweep re-judges the timing.

Evidence: `artifacts/render-stream/p3/hc4a/perf/` (`instr-table.txt`, `instr/` split JSON and
text per leg, `realtime/` bench JSON and `perf.json` per leg, drivers `hc4a-perf.sh`,
`instr-table.py`).

## Byte identity (`cmp-rec.ts --tree`, main 60ddee77 against this branch)

| layer | files | result |
| ----- | ----: | ------ |
| gate 0 (every leg; preexisting-skip is the unknown-item skip leg) | 16 | 15 identical; `corrupt/recording.rs2` is the corrupt sabotage's undecodable file, which differs from main's in exactly the 71 bytes (ids) its identical source capture does |
| gate 1 (g1a, g1b) | 12 | identical |
| gate 2 (g2a, g2b, g2d) | 24 | identical |
| gate 3 (g3a) | 3 | identical |
| gate 5 (g5c, g5e) | 11 | identical |
| gate 5.5 (g55c, g55d) | 23 | identical |
| gate 8 (g8t, g8a, g8m, g8w11, g8mm, g8pt; Skip legs included) | 106 | 104 identical. g8a `late-workers` (both sinks) differs in publication frames: its texture workers run an 8 ms delay against 16.7 ms frames. A second run of **main** differs from the first in the same way and equals this branch's run (`g8a-base-vs-base-rerun-cmp.txt`, `g8a-hc4a-vs-base-rerun-cmp.txt`) |
| capture-scale /8, /10, /11, /12, 300 frames, sync workers, 64x48, redraws 170, Skip, hook log off; and /11 with the shadow oracle on (final code) | 5 x 300 records | identical; stores `diff -r` equal |
| `resources.jsonl`, hook log on, minus timing fields | 69 | 61 equal. The 8 that differ are the ones HC2 and HC3 met: the g8w11 coding hosts and `gate2/live-inline` (live pacing), the g8pt captures (only `particles_set_seed`'s engine seeds), and `late-workers` (as above) |
| goldens 2–12, window-1 transcripts, unit tests (ctest) | 42/42 | pass (the new `rs_mirror_shadow` included) |

The gate layers ran before a last change, which keeps the verdict maps in place instead of
rebuilding them every snapshot (only the incremental bookkeeping changed). The capture-scale layer
was rerun on the final code, and the remote full tier ran every gate leg on it with the oracle on.

Outputs: `artifacts/render-stream/p3/hc4a/ident/` (cmp-rec output per layer, the `resources.jsonl`
comparison, the shadow scale leg's `counters.json`, drivers `hc4a-ident.sh`, `hc4a-resjsonl.py`).

## Checks (in `run-hc1.sh`, the `native-rust-hc1` run; `lib/hc1-checks.ts`)

- `shadow-oracle-agrees`: `rr-vary` (/11 re-records) and `dyn-off` (/11 mesh, mover and
  parameter churn) always run with the oracle. Each compares 150 of 150 snapshots, with no
  mismatch.
- `sabotage-hc-skip-dirty-oracle-caught`: `GRC_HC_SABOTAGE=hc-skip-dirty` loses every 16th dirty
  mark (env-only, never on the wire). On the churn leg with the oracle on, 4 marks were dropped, and
  the stream ended at `items id 204: xform at frame 3`.
- `sabotage-hc-skip-dirty-gate1-caught`: the same sabotage under `run-gate1.sh --legs g1a` (oracle
  off) fails gate 1's receiver pixel checks:
  - `receiver-vs-reference`: 4,608 px at steps 2 onward, max delta 204;
  - `expected-image-receiver`;
  - also `retained-invariants`: P.xform stuck at step 1, V1.visible stale.
- `sabotage-hc-stale-derived-oracle-caught`: `hc-stale-derived` skips one item's derived recompute
  (the first that would change its entries). Under `run-gate2.sh --legs g2a` with the oracle, it
  ends `capture-unsupported` at `unsupported id 12: canvas_item_add_texture_rect_region (1
  item-level entries, the full walk 2) at frame 1`.
- `sabotage-hc-stale-derived-gate2-caught`: the same under `--legs g2a,g2b` (oracle off) fails
  gate 2's unsupported checks:
  - `recordings-decode-2`: `unsupported-mismatch`, a tex-bearing command names an unsupported
    texture with no unsupported-texture entry;
  - `leg-class-unsupported-textures`: the receiver reports neither `unknown-texture` nor
    `unsupported-texture`.
- The unknown-item skip legs (withheld subtrees): gate 0's `preexisting-skip` and gate 8's Skip
  captures, byte-identical above and run with the oracle in the full tier. The mirror tests'
  `test_skip_*` cases also run under the oracle.
- Unit tests:
  - `rs2_diff_test::test_shared_table`: order, chunks, copy-on-write, erase, `mutate_if`, and
    `make_patch` over shared chunks encoding like fresh tables;
  - `rs_mirror_test::test_hc4a_persistent_tables`: a static snapshot shares every chunk and visits
    nothing; a same-value setter republishes nothing; a change replaces one entry of one chunk;
    ties and entries follow; a freed item leaves;
  - `rs_mirror_test::test_hc4a_shadow_sabotages`: both sabotages are caught, and the honest twin
    passes;
  - the new ctest `rs_mirror_shadow` runs all 673 mirror checks with the oracle on every snapshot.
- `self-test-validate-tier.sh`:
  - `HC_SHADOW=1` reaches the correctness runs of a milestone and not the timing ones;
  - each such run gets its `hc-shadow.json`;
  - `gs_strip_env_args` ends every launch's env with `GRC_HC_SHADOW=1`.

## Deviations from the design

- **Same-value setters are decided at the snapshot.** A hook marks the item it touches, and the
  snapshot republishes only a real difference. The design compares before the write. The result is
  the same: nothing is published and no chunk moves. It costs one entry compare per touched item,
  and no setter needed its own compare path.
- **Canvases are compared whole every snapshot, not marked.** They are few, and the root canvas's
  item list is a `memcmp`.
- **A moved input that other items read rederives every item's entries** (the design's "marks
  every item dirty for one snapshot"). The trigger is a per-snapshot fingerprint of those inputs
  rather than per-hook marks. The fingerprint is a walk over the texture and mesh tables, which
  HC4b removes along with the rest of their walks.
- **`Snapshot::unsupported` stays a `std::vector`.** The item-level part is kept per item and
  concatenated only when it changes, then copied into each snapshot (a handful of entries on the
  fixture).
- **The pixel half of `hc-skip-dirty` is gate 1's** (g1a), and the `unsupported` half of
  `hc-stale-derived` is gate 2's (g2a and g2b). Both run as nested gate runs inside `run-hc1.sh`,
  through the new `HC_SABOTAGE` runner variable, with each gate's own sabotage legs skipped.
- **`static-near-zero` is reported, not met.** See Perf: what remains is HC4b's.
- `make_patch`'s P3-CAP tolerance of unsorted or repeated item ids in a hand-built table is gone:
  a `SharedTable` is keyed by id, so the last entry wins and order is ascending. The one unit test
  that asserted table order was updated (`test_make_patch_table_order`).

## Validation

- **Remote full tier** (`remote-validate.sh --tier full`, run 40800183623, key
  `rv-20261029T012355Z-42739ab-21359`, tree 42739ab4 on 60ddee77, before the rebase): 20/22 pass.
  That includes native gates −1, 0, 1, 2, 3, 4, 5, 5.5 and 8, and `bench-instr` (−0.27 to +0.52 %).
  - **The shadow oracle ran on every correctness gate leg**: 713 armed hosts and 193,997
    snapshots compared, with no mismatch on an honest host. Per run, hosts with the oracle on and
    snapshots compared:

    | run | hosts | snapshots |
    | --- | ---: | ---: |
    | gate 0 | 7 | 712 |
    | gate 1 | 13 | 4,828 |
    | gate 2 | 28 | 16,707 |
    | gate 3 | 11 | 1,568 |
    | gate 4 | 19 | 3,348 |
    | gate 5 | 14 | 2,620 |
    | gate 5.5 | 22 | 4,686 |
    | gate 8 | 95 | 10,596 |
    | hc1 | 18 | 3,427 |
    | g7-gsw | 199 | 45,366 |
    | g7-web-rust | 199 | 45,310 |
    | g7live-gsw | 44 | 27,593 |
    | g7live-web-rust | 44 | 27,236 |

    Gate −1 arms no stream, and the hc1 hosts with the oracle off are the nested pixel-check runs.
  - The two failures:
    - `native-rust-hc1`: its runner passed 20/20 checks, but the new scan counted the two
      sabotage oracle hosts' intended mismatches as failures. Fixed: `counters.json`'s `hc_shadow`
      names the host's HC4a sabotage, and `hc-shadow-scan.py` lists such hosts under `sabotaged`
      instead of failing on them.
    - `g7-web-rust` g7-8 (`mm-reference@web`, `web-repeat-identical@web`): the known hosted-runner
      flake.

    Both were rerun locally, below.
- **Rebased onto 74e58b5d (PM7: pre-arm GPU emitter adoption, which also edits the mirror).** The
  rebase was clean, and ctest passed 42/42. Byte identity against the new main:
  - gate 8 g8pt, PM7's late legs included: 23/23 identical;
  - gate 1: 12/12 identical;
  - capture-scale /11 and /12, and /11 with the oracle: identical, stores equal.

  The outputs are in `ident/rebased-74e58b5d/`. A local smoke of the overlapping runs passed 7/7
  (`--only native-rust-gate4,native-rust-gate8,native-rust-hc1,g7-gsw,g7-web-rust,g7live-*-g7-1`;
  run `validate-smoke2`). A first full smoke before the rebase passed gates −1, 0, 1, 2, 3, 5 and
  5.5. Its `pure` run failed only the known load-sensitive `self-test-report` (throttle-proxy
  latency), its `bench-instr` returned 3 (no valgrind locally), and its gate 4 failed because its
  extension was rebuilt under it; gate 4 is green in the rebased run.
- **Local, after the scan fix:**
  - `native-rust-hc1` at `--tier full` (oracle on, every sabotage): rc 0. 18 hosts ran the oracle
    over 3,437 snapshots with 0 honest mismatches, and the 11 sabotage hosts are listed apart.
  - `g7-web-rust` g7-8 at full (`RS_VALIDATE_GROUPS=g7-8`): rc 0. 79 hosts ran the oracle over
    8,436 snapshots with no mismatch.
- **Rebased onto 86de9ab9 (GRH: GSW coding resync, rs-core and run-gate8 g8w11).** No file is
  shared with this diff. ctest passed 42/42 after the rebuild. The refused live runs then ran
  locally at full on that tree: `g7live-gsw` and `g7live-web-rust` g7-1
  (`RS_VALIDATE_GROUPS=g7-1`). Both passed (2/2), and each ran the oracle on 16 hosts over 11,860
  snapshots with no mismatch.
- Not run: `lock-tests` changed nothing (it passed in the first smoke), and the timing runs
  (native gate 6, `g7live-*-timing`, g7x) go to the sweep. Receivers and the GDScript cores are out
  of scope: the wire is byte-identical. HC4b's resource tables (textures, meshes, shaders,
  materials) are unchanged.

## For HC4b

- **Most of the static frame is now resource tables.** `records_before`/`inline_names`' string
  sets cost 3.9 M instructions, the payload map rebuild about 0.9 M, the texture, mesh and material
  walks about 1.2 M, and serving and the budget 1.2 M. HC4a's static total is 9.8 M.
- **`SharedTable` takes any `T` with an `id`.** `make_patch`'s `diff_tables` is generic, so the
  four resource tables switch with a type change plus their writers: `wire_entry`, `wire_mesh`,
  `wire_shader`, `wire_material` called for marked entries only.
- **Remove the derived-input fingerprint** in `publish_items` (`bad_textures_`, `bad_meshes_`)
  once textures and meshes carry their own dirty marks. Mark "an input other items read moved"
  where a texture's status, kind, diffuse or pending state, or a mesh's status, changes. That walk
  is the last per-frame item-side cost proportional to a table size.
- **Keep `publish_surface` as the only way a mesh's bytes leave the mirror** (HC3). A surface's
  `key` changes exactly when its published bytes do, which can serve as its dirty mark.
- **The oracle's `full_walk_items` and `shadow_compare` are where HC4b's twin goes.** Extend
  `FullWalk` with the resource tables and the payload map, and compare them as items are compared.
  `item_state_difference` and `canvas_state_difference` have `sizeof` tripwires (264, 80 bytes);
  the resource entries need their own.
- **`ItemMap`'s pattern (const reads, marking writes) found every write site at compile time.** It
  is the cheapest way to make the resource maps dirty-tracked too.
