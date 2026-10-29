# HC4b: persistent resource tables (2026-10-29)

HC4b of `protocol/host-cost-design.md` (D1 "Shape", "Dirty sets", "The snapshot", "The diff, record
planning, serving and budget"; "Byte-identity proof method"). No wire change. As built is recorded
in the design doc under D1, "As built (HC4b)".

1. **The resource tables are `SharedTable`s.** `Snapshot::textures`, `meshes`, `shaders` and
   `materials` hold HC4a's chunked, shared entries, so a snapshot shares every resource entry that
   did not move. `make_patch` diffs them with `diff_tables` (a shared chunk or entry is skipped
   without a compare). `make_full` copies them out with `vector()`, and PM5's `lower_particles`
   rewrites the /12-only entries with `mutate_if`.
2. **The mirror marks what its hooks write.** The four resource maps are `ResMap`s, with
   `ItemMap`'s rules: `find`/`all` read, and `mut`/`emplace`/`erase`/`mut_all` write and mark.
   `find_texture`, `find_mesh`, `find_shader` and `find_material` mark; `add_mesh` and
   `multimesh_set_mesh` read through the new `peek_mesh`. The snapshot rebuilds only the marked
   entries (`wire_entry`, `wire_mesh`, `wire_shader`, `wire_material`) and republishes an entry
   only when `*_entry_difference` finds a field that differs. Those functions compare every field,
   including the host-only ones (a surface's body and key flag, the /11 forms), and carry `sizeof`
   tripwires as HC4a's do.
   - Textures that a worker or a pending recovery still holds (`tex_jobbed_`) are revisited every
     snapshot, so `settle` and `resolve_pending` still run on each of them.
   - A change of `dynamic_hashes_read()` rebuilds the mesh entries.
   - The shader policy, the inline threshold and `reset()` rebuild everything.
3. **The payload map is persistent.** `Captured::payloads` is a `SharedStrMap<PayloadPtr>`
   (`capture/src/rs_shared_map.h`):
   - a sorted map whose chunks hold at most 128 entries and are shared copy-on-write;
   - `std::map`'s read interface, a byte total (`weight()`), `same()` for root identity, and
     `diff_shared_maps()`, which walks two maps over their differing chunks.

   Each resource entry keeps its share: the hashes and bytes it puts in the map, and the names it
   adds to the index (item 4). A hash stays while an entry names it. The newest bytes win, so
   `spurious-update`'s fresh copy replaces the old one, as before.
4. **Record planning works over differing entries.** `Captured::names` (`NameIndex`) counts, per
   hash, the entries naming it by `payload_names()`'s rule, separately as a main name and as a
   texture variant, along with its payload bytes. It also keeps `|inline(state)|` for the stream's
   threshold.

   `rs_records.h plan_v11_records(B, T)` computes `records_before(B, T)` and `|inline(T)|` from the
   entries B and T do not share:
   - A candidate is any name of T's differing entries.
   - B holds a candidate when one of B's differing entries names it, or when T counts more entries
     naming it than its differing ones (then a shared entry names it).
   - It falls back to the full walk when T has no valid index: a hold-back snapshot that
     `resolve_captured` filled in, the `stale-texture` sabotage's table, or PM5's lowering. Both
     cases clear `names_valid`.

   The hub's `v11_records` and the publisher's /11 file lanes use it. Lifelong planners (below
   /11, `keep-carried`) are unchanged.
5. **Store bookkeeping** (`Publisher::store_payloads`) visits only the entries the publication
   does not share with the previous one. That is sound because the store only grows, and every name
   the previous publication held was stored then. The entries are visited in `payload_refs` order
   (textures, meshes, shaders, then the differing textures' variants), so the store events keep
   their order.
6. **Serving and the budget** (`ServedResources`, `payload_union_bytes`) also work over map
   differences. After `retire()`, the served set is exactly the current map plus each base's map,
   and the class remembers those maps.
   - `pin()`: a map that is one of them, or was pinned whole since, pins nothing. Any other map is
     pinned over its differences from the current map.
   - `retire()`: the retirement candidates are the hashes pinned beyond those maps, and the hashes
     that the old current map and the dropped bases hold but the new current map lacks. They are
     retired in key order, the full walk's event order.
   - `retained_bytes_beyond` and the budget's union use the same differences.
   - The unpin and retain-superseded sabotages keep the full walk.
7. **HC4a's per-snapshot fingerprint is gone.** The derived inputs (a texture's
   unsupported-or-pending bit and diffuse link, a mesh's unsupported status) are compared only for
   the textures and meshes that were marked or erased.
   - Tombstones are kept as sets, so the tombstone rule's reference walks run only while a
     tombstone exists.
   - Material verdicts are recomputed when a texture or shader moved, and only the moved
     materials' verdicts when only materials moved.
   - The pending set (G8kf) is updated in place.
8. **The shadow oracle covers all of it** (`GRC_HC_SHADOW=1`, `HC_SHADOW=1` for runners).
   - `full_walk_resources` rebuilds the four tables, the payload map (the first entry naming a
     hash supplies its bytes) and the name index the old way. Meshes go through `wire_mesh_peek`,
     which touches no cache or counter.
   - `shadow_compare` checks each table entry by entry, the map's keys, bytes and byte total, the
     index's counts and inline counts, the pending textures, and the flags they derive
     (`keyed_surfaces`, `shader_time`, `particles_commands`). It then checks `plan_v11_records`
     against `records_before`, with and without variants, from the previous snapshot. HC4a's
     encoded-patch comparison now runs over the full walk's resource tables too.
   - Serving has its own twin: the retained set after each `retire()` against the union of the
     current map and the bases, and `retained_bytes_beyond` against the walk. The budget's union is
     checked against P3-CAP's walk.
   - Any difference ends the stream with `hc-shadow-mismatch: <table> id <id>: <field>`.
   - `counters.json` `hc_tables` gains `resources_visited`, `resources_republished` and
     `texture_marks_dropped`.

## Perf (capture-scale, /11, product hand-off env: inline 4096, hook log off, no tap)

The HC4a configs, driven by `hc4b-perf.sh` (from `hc4a-perf.sh`). "Before" is main 667687af
(HC4a) and "after" is this branch: the same scripts and fixture, with only the extension differing.
Load from other agents was 2 to 14.

**Retired instructions** (`RS_BENCH_PERF_ARGS="-e instructions -c 1000000"`, `perf-capture-split.py
--freq 1000`), in M instructions per frame on the main thread. Capture is the main thread minus the
engine.

| leg | capture before | capture after | saved |
| --- | ---: | ---: | ---: |
| 1 viewer, static | 11.49 | 0.43 | 11.06 (96 %) |
| 1 viewer, churn (`RS_SCALE_REDRAWS=170`) | 22.82 | 12.81 | 10.01 (44 %) |
| 0 viewers, static | 0.03 | 0.03 | 0 (HC1: no snapshot) |
| 0 viewers, churn | 2.26 | 2.20 | 0.06 |

This run measured HC4a's static frame at 11.49 M, where `hc4a.md` reported 9.83 M. The difference
is sampling under other agents' load, and both sides were measured in the same series.

Per bucket, 1 viewer (M instructions per frame, before → after):

| bucket | static | churn |
| --- | --- | --- |
| record planning (`records_before`, `inline_names`) | 4.71 → 0.00 | 4.46 → 0.01 |
| snapshot: item walk and copies (payload map rebuild, fingerprint walk) | 1.69 → 0.07 | 2.95 → 1.54 |
| budget and serving (pin, retire, union) | 1.33 → 0.00 | 2.25 → 1.03 |
| diff (`make_patch`) | 1.15 → 0.09 | 1.43 → 0.31 |
| snapshot: textures, meshes, shaders | 0.97 → 0.00 | 1.32 → 0.45 |
| frame callback, other | 0.71 → 0.02 | 1.01 → 0.09 |
| previous-snapshot release / publish | 0.47 → 0.03 | 0.78 → 0.25 |
| snapshot: material params (verdicts) | 0.24 → 0.00 | 0.53 → 0.35 |
| hub | 0.13 → 0.12 | 0.17 → 0.24 |
| encode (JSON and blocks), zstd: HC5's | 0.07 → 0.06 | 5.34 → 5.92 (the same patches; run-to-run noise, as HC4a's two churn runs differed by 0.4) |

What a static frame still spends is the hub (0.12 M), the empty patch and the snapshot's session
scalars. Churn's remainder is the frame's real changes:
- the encode and zstd of the patch, 6 M (HC5's);
- the items HC4a visits, 1.5 M;
- the 76 meshes and 8 materials a frame that really change, 0.8 M;
- serving's per-hash work for the 76 dynamic-surface keys that change every frame, 1 M (see
  "Notes for HC5").

**Real time** (no perf, ms; `perf.json` histogram means, and p50 as the median bucket's upper bound):

| leg | callback p50 before → after | callback mean | snapshot mean | diff mean |
| --- | --- | --- | --- | --- |
| 1 viewer, static | ≤ 2.30 → **≤ 0.16** | 2.29 → 0.21 | 1.01 → 0.05 | 0.20 → 0.03 |
| 1 viewer, churn | ≤ 4.35 → ≤ 1.98 | 4.18 → 2.06 | 1.70 → 0.91 | 0.26 → 0.07 |
| file sink, no viewer, static (`--mode file`) | ≤ 1.92 → **≤ 0.10** | 2.43 → 0.62 | 1.03 → 0.05 | |
| file sink, no viewer, churn | ≤ 3.58 → ≤ 1.28 | 5.45 → 1.84 | 2.61 → 0.83 | |

The file sink's static mean is above its p50 because of the file writer's occasional long
callbacks. The p50 sits at the floor.

**`static-near-zero` is met**: the capture-scale static callback p50 is ≤ 0.16 ms with a viewer and
≤ 0.10 ms with a file sink, against a target of ≤ 0.5 ms (real time, and these are
instruction-count reductions, not timing luck). At one viewer, HC4b saves about 2.1 ms of a static frame and 2.1 ms of a
churn frame (callback means; 2.4 ms at the churn p50), against the design's ~1.1 and ~1.2. The milestone sweep
re-judges the timing.

Evidence: `artifacts/render-stream/p3/hc4b/perf/`:
- `instr-table.txt`, and `instr/` with the split JSON and text per leg;
- `realtime-table.txt`, and `realtime/` with `perf.json` per leg;
- the drivers `hc4b-perf.sh`, `instr-table.py` and `realtime-table.py`.

## Byte identity (`cmp-rec.ts --tree`, main 667687af against this branch)

Both sides ran with this branch's scripts. Base used main's library, copied before any change.
The branch's gate and scale runs had the shadow oracle on, which does not change the wire.

| layer | files | result |
| ----- | ----: | ------ |
| gate 0 (every leg) | 16 | 15 identical. `corrupt/recording.rs2` is the corrupt sabotage's undecodable file (HC4a's note) |
| gate 1 (g1a, g1b) | 12 | identical |
| gate 2 (g2a, g2b, g2d) | 24 | identical |
| gate 3 (g3a) | 3 | identical |
| gate 5 (g5c, g5e) | 11 | identical |
| gate 5.5 (g55c, g55d), final code | 23 | identical |
| gate 8 (g8t, g8a, g8m, g8w11, g8mm, g8pt; Skip legs included), final code | 113 | 108 identical. See below |
| capture-scale /8, /10, /11, /12 (300 frames, sync workers, 64x48, redraws 170, Skip, hook log off), and /11 with the shadow oracle on, final code | 5 x 300 records | identical; stores `diff -r` equal |
| `resources.jsonl`, hook log on, minus timing fields | 71 | 61 equal. See below |
| goldens 2–12, window-1 transcripts, unit tests (ctest) | 42/42 | pass |

**The 5 gate 8 files that differ all depend on worker timing.** Their texture workers run real
decodes (about 100 ms) or an 8 ms delay against 16.7 ms frames, so the hold-back publishes at
frames that depend on when each job finishes. The files are `g8a/late-workers` (both sinks),
`workers/capture` (both sinks) and `decode-cost/capture-workers`. Main's own reruns disagree on
each of them, and this branch's runs equal one of main's reruns:
- `late-workers` and `workers/capture`: base differs from a base rerun, and the branch equals that
  rerun.
- `decode-cost/capture-workers` publishes a frame-3 transaction in some runs and not in others.
  Base runs: frame 3 in 1 of 4. Branch runs: frame 3 in 3 of 3. The branch equals the base run that
  published it.

The comparisons are in `ident/g8-workers-rerun-cmp.txt`.

**`resources.jsonl`:** 61 of 71 files are equal. The 10 that differ are HC4a's 8 (the three g8w11
coding hosts and `gate2/live-inline`, by live pacing; the three g8pt captures, by
`particles_set_seed`'s engine seeds; `late-workers`) plus the two worker captures above.
`gate2/live-inline`'s pin and retire events are the same 13 events, the same hashes in the same
order, as main's; only the join frame differs.

Outputs: `artifacts/render-stream/p3/hc4b/ident/`. That holds the cmp-rec output per layer and the
first-round outputs (`round1/`, gates 0–5 and gate 8 before the final material-verdict change),
the `resources.jsonl` comparison, and the drivers `hc4b-ident.sh` and `hc4b-resjsonl.py`.

## Checks (in `run-hc1.sh`, the `native-rust-hc1` run; `lib/hc1-checks.ts`)

The `native-rust-hc1` run at the full tier passed 26/26, all its sabotages included
(`ident/hc1-result.json`).

- **`shadow-oracle-agrees`**: `rr-vary` and `dyn-off` now compare the resource tables, the payload
  map, the name index and the record plan too. 150 of 150 snapshots each, no mismatch. Across every
  host of that run, 24 had the oracle on and 4,542 snapshots were compared, with no honest mismatch
  (`ident/hc-shadow.json`).
- **`sabotage-hc-skip-dirty-texture-oracle-caught`** (new): `GRC_HC_SABOTAGE=hc-skip-dirty-texture`
  under `run-gate2.sh --legs g2a,g2b` with the oracle on. `capture` ends at `textures id 1: entry
  at frame 61`, the step-6 `texture_2d_update`, which lost its mark.
- **`sabotage-hc-skip-dirty-texture-gate2-caught`** (new): the same sabotage without the oracle
  fails gate 2's texture checks:
  - `texture-versions-current` ("texture 1 is image/ok v1 2b32ed0e3bfd, the hook log says image/ok
    v2 ded286941ff5");
  - `receiver-vs-reference` (4,608 px at step 6, max 255);
  - `expected-image-receiver`.

  It also fails `texture-invariants`, `upload-accounting` and every receiver leg's class
  (`texture-log-divergence`).
- **`sabotage-serve-skip-caught`** (new): `GRC_HC_SABOTAGE=serve-skip` on the late-join leg. The
  joining viewer's 66 GETs all answer 404, which fails `late-join-served`.
- **`sabotage-serve-skip-gate2-caught`** (new): the same under `run-gate2.sh --legs g2a,g2c` fails
  `http-gets-match-fetches` ("2b32ed0e3bfd: HTTP 404" on every live leg) and `leg-class-live`
  (`resource-unavailable`). It also fails `pins-bounded` and `live-vs-reference`.
- HC1–HC4a's checks are unchanged and pass: `late-join-served` (static, churn, hook log off; every
  GET 200), `no-pin-without-viewer`, `pin-late`, HC2's re-record checks, HC3's dynamic-hash checks,
  and HC4a's sabotages.
- **Unit tests** (ctest 42/42):
  - `rs_mirror_test::test_hc4b_resource_tables`:
    - a static snapshot shares the texture table, the payload map and the name index, and visits
      nothing;
    - a texture update replaces one chunk and swaps one hash;
    - the record plan names exactly the new hash;
    - a hash two entries share and one leaves is no record, and the plan equals `records_before`
      from three older bases;
    - a freed texture leaves the table, the map and the index.
  - `rs_mirror_test::test_hc4b_skip_dirty_texture`: the oracle catches the sabotage.
  - `rs_live_test::test_hc4b_shared_maps_and_serving`:
    - the shared map against `std::map` over 60 rounds of random writes, and `diff_shared_maps`
      against a set difference;
    - an incremental `ServedResources`, with its oracle on, against a full-walk model: the same pin
      and retire events in the same order every frame, with random bases;
    - `retained_bytes_beyond` and `payload_union_bytes` against the walks;
    - `serve-skip` pins nothing.
  - `rs_mirror_shadow` runs all 693 mirror checks with the oracle on every snapshot, the resource
    half included.
- W11b's `carried-equals-names` and `resend-on-return`, gate 2's and gate 8's serving checks (pins,
  retires, GET status) and G8kw's hold-back legs run in the native gate 2 and gate 8 runs below.

## Validation

- **Remote full tier** (`remote-validate.sh --tier full`, run 40826403611, key
  `rv-20261029T055803Z-93fcca4-21002`, tree 93fcca4a on 667687af): 20/22 runs pass.
  - The passing runs: native gates −1, 0, 1, 2, 3, 4, 5, 5.5 and 8, `native-rust-hc1` (every
    sabotage), `g7-gsw`, `g7live-gsw`, the crates, `pure`, `pnpm-test`, and `bench-instr` (−0.27 %
    to +0.61 %).
  - **The shadow oracle ran on every correctness gate leg, its resource half included**: 726 hosts
    and 196,100 snapshots compared, with no mismatch on an honest host.

    | run | hosts | snapshots |
    | --- | ---: | ---: |
    | gate 0 | 7 | 712 |
    | gate 1 | 13 | 4,828 |
    | gate 2 | 28 | 16,707 |
    | gate 3 | 11 | 1,568 |
    | gate 4 | 19 | 3,348 |
    | gate 5 | 14 | 2,620 |
    | gate 5.5 | 22 | 4,686 |
    | gate 8 | 97 | 10,812 |
    | hc1 | 24 | 4,521 |
    | g7-gsw | 201 | 45,531 |
    | g7-web-rust | 201 | 45,533 |
    | g7live-gsw | 45 | 27,975 |
    | g7live-web-rust | 44 | 27,259 |

  - The two failures are hosted-runner flakes, both rerun locally at the full tier below:
    - `g7-web-rust` g7-8: the known `mm-reference@web` / `web-repeat-identical@web` flake (and the
      sabotage check that leans on `mm-reference`);
    - `g7live-web-rust` g7-5: `live-mesh` step 5 "no shot".
- **Local, full tier (oracle on):**

  | run | result | oracle |
  | --- | --- | --- |
  | `g7-web-rust` g7-8 (`RS_VALIDATE_GROUPS=g7-8`) | rc 0 | |
  | `g7live-web-rust` g7-5 | rc 0 | 6 hosts, 3,906 snapshots |
  | `g7live-gsw` g7-1 (refused remotely) | rc 0 | 16 hosts, 11,860 snapshots |
  | `g7live-web-rust` g7-1 (refused remotely) | rc 0 | 16 hosts, 11,860 snapshots |
  | `native-rust-hc1` | 26/26 | 24 hosts, 4,542 snapshots |

- **Local smoke** (`validate-increment.sh`, on 667687af): 22/24.
  - Passed: `lock-tests`, `pure`, every native correctness gate, `native-rust-hc1`, `g7-gsw`,
    `g7-web-rust`, and the g7-1 live smokes.
  - `bench-instr` returned 3 (no valgrind locally; it passed remotely).
  - The timing run `native-rust-gate6` failed `pins-bounded` and `obsolete-retired` on g6l's
    `live-reconnect`, which **fails identically on main**. A g6l rerun with main 667687af's library
    gives the same verdicts, the same frames 609–611 and the same hashes
    (`ident/g6l-main-667687af.txt`, `ident/g6l-hc4b.txt`). Between the receiver's close and its
    reconnect the host has no viewer for three frame callbacks. HC1 pins and retires nothing then,
    so the replayed served set misses those frames' hashes and keeps the old ones. The serving code
    HC4b changed does not run in those frames. This is a pre-existing gap (since HC1) for the sweep
    to own, not an HC4b regression.
- **Rebased onto 60074a1a** (GLJ, PFB, HYG, PSE, WB-D; none touches the capture, `run-hc1.sh` or
  the checks HC4b changed): the rebase was clean, ctest passed 42/42 after the rebuild, and
  `native-rust-gate8` at the full tier (oracle on, with PFB's and PSE's new gate 8 legs) passed
  (rc 0). The oracle covered 100 hosts and 10,914 snapshots with no mismatch
  (`validate/rebased-gate8-summary.json`).
- **Not run:** the timing runs (native gate 6 apart from the g6l check above, `g7live-*-timing`,
  g7x), which go to the sweep. The receivers and the GDScript cores are out of scope, since the
  wire is byte-identical. HC5's encode thread is out of scope too.
- **Time:** implementation about 2 h (code, unit tests, sabotage legs, oracle). Validation and
  measurement took about 4.5 h: two identity rounds, three main reruns of the worker legs, perf,
  smoke, the remote run, local reruns and the g6l bisection.

## Notes for HC5

- **Every published state is now immutable and shared.** A snapshot (`Captured`) holds its
  tables, payload map and name index by shared chunks, and the mirror copies a chunk before it
  writes one that anything else holds. An encode thread can therefore read any (B, T) pair the hub
  holds without a lock. It must not call the mirror; `plan_v11_records`, `make_patch` and
  `encode_transaction` do not.
- **The hub's per-frame memo** (`frame_v11_`, `frame_records_`) keys on (B, T) pointers.
  `plan_v11_records` is O(entries B and T do not share), so a formation job can recompute it rather
  than share it.
- **What the churn frame still spends:**
  - encode 3.2 M and zstd 2.7 M instructions (HC5's);
  - HC4a's item visits, 1.5 M;
  - serving, 1 M.

  Serving's share is the 76 dynamic-surface payload keys (`hc3-key:<n>`) a churn frame swaps. They
  are pinned and retired each frame, though no /11 viewer ever GETs a keyed surface. Leaving keyed
  surfaces out of the served set (they would still count toward the budget through the map) would
  remove it. That is a behaviour change for the serve events and the retained counts, so it was not
  made here.
- `ServedResources::served_` is still a `std::map<std::string, PayloadPtr>`, and a pin or retire
  copies a 64-character key. A `SharedStrMap` would make it shareable with an I/O-thread reader.
- **The record plan falls back to the full walk** for a hold-back snapshot that `resolve_captured`
  filled in (G8kw workers) and for PM5's lowered pair (a /11 viewer of a /12 host). Both are
  O(table) per frame while they apply. Carrying the resolved names into the index at resolve time
  would cover the first.
- **`perf-capture-split.py`** buckets `plan_v11_records` as record planning, and
  `res_publish_resources`, `res_share_update` and `res_names_add` with the resource tables.
