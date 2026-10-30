# TAG1: item identity on the host, the `item_meta` record and its validators (2026-10-30)

TAG1 is the first increment of the opt-in client-extension layer
([protocol/client-extensions-design.md](../../protocol/client-extensions-design.md), the TAG1
row of §6). "As built (TAG1)" there is the spec of what was built, and lists every place the design
text moved on contact with the code.

A viewer that asks for identities in its /13 hello gets them as an `item_meta` JSON record before
the transaction it describes, if the operator granted them (`GRC_ITEM_META`). Identities are Godot's
own tags: the instance scene, the scene-relative path, the class, the script, and group membership
and meta values for names the viewer asks about. Every viewer that does not ask, and every host
without a grant, gets exactly what main sends. Receivers do not opt in yet (TAG2). rs-core, the
native receiver and GSW validate the record and skip it.

## What changed

**Capture** (`capture/src/`).
- `rs_item_meta.{h,cpp}` (new, pure):
  - the request and grant;
  - the formation-side `Store`;
  - the per-grant string tables;
  - `form()`, which writes a full or delta record.
- `rs_item_meta_host.{h,cpp}` (new): the main thread's watermark pass.
  - It runs after the snapshot and waits for publication.
  - Pending items back off (+1, +2, +4 … frames) for 120 frames.
  - It has the 2 ms budget and the union of requests.
  - Rekeys are copied by RID.
  - It writes `evidence/item-meta.json` and, under `GRC_ITEM_META_LOG`, the id log.
- `rs_adopt.cpp`:
  - eight new binds (`get_class`, `get_script`, `has_meta`, `get_meta`, `get_scene_file_path`,
    `get_owner`, `get_path_to`, `is_in_group`);
  - the node map shared by adoption and TAG (`node_map_acquire_tag` / `node_map_release_tag`);
  - `item_identity()`.
- `rs_mirror.h`: `next_item_id()` and `item_info()`, read-only.
- `rs_live.{h,cpp}`:
  - the hello parser takes `item_meta` at /13 (the one nested value);
  - the grant at hello and the union version;
  - `FormState`'s range;
  - `Hub::form_item_meta` (memo, coded), placed after the resource records and before the
    transaction;
  - the summary's `item_meta` object.
- `rs_publish.{h,cpp}`: the file lanes' records under `GRC_ITEM_META_FILE*`.
- `entry.cpp`:
  - configuration;
  - the frame-callback branch;
  - batches to the hub and the publisher;
  - `GRC_LIVE_AWAIT_HELLOS`.

**Validators** (the subagent half).
- rs-core: `item_meta.rs`, `Accepted::ItemMeta`, `Options::item_meta` (Unknown, NotAsked or Asked),
  the seven codes, and the table accessor.
- `predict::to12` drops the records.
- `rs-core-check validate --item-meta-asked … --item-meta-dump …`.
- capi `KIND_ITEM_META` = 6; gsw-rs `ACCEPT_ITEM_META` = 5.
- `receiver.gd`, GSW's `main.ts`/`live.ts` and the client package skip the record.
- TS `render-stream-2.ts`: decode, the validator option and the table.
- golden-13: `item-meta.rs13` and `invalid/item-meta-{orphan,form,missing,id,string,schema}.rs13`.
  `item-meta-unexpected` is `item-meta.rs13` under NotAsked, and `item-meta-refused` is
  `patch.rs13` under Asked.
- `make_golden.py` has its own reference checker.

**Tools and tests.**
- `lib/coding-receiver.ts`:
  - `--item-meta`, `--connect-delay-ms` and `--close-after-tx`;
  - records held with their transaction;
  - each message line gains `wire_sha256`, `sha256`, and (for a transaction) `seq`, `frame` and
    `encoding`.
- `fixtures/tag-scene` (new).
- `run-gate8.sh` group `g8tag` (default), with `lib/gate8-tag-checks.ts`.
- `fixtures/capture-scale` gains `RS_SCALE_NODES`, `RS_SCALE_NODE_BURST` and `RS_SCALE_NODE_CHURN`
  (default 0: unchanged).
- `smoke-map.json`: `fixtures/tag-scene` reaches native gate 8.

## Checks (`g8tag`, local: 15/15; evidence in `artifacts/render-stream/p3/tag1/g8tag/`)

| check | result |
| ----- | ------ |
| `tag-validate` | 13 streams (every viewer, with its ask; both file sinks) pass rs-core-check and the TS validator |
| `tag-meta-oracle` | live/a: 26 rows, 25 equal to the fixture's own dump (class, script, scene, path, group bits, meta), 1 no-node row (the TileMapLayer quadrant), every resolved node has a row |
| `tag-meta-file-oracle` | the patch recording: the same 26 rows |
| `tag-meta-shared` | A/B records equal raw and coded over every common range; 587 B/C transactions byte-equal raw and coded; every A/C pair equal with seq aside (A ran a frame out of lockstep); 7 memo hits |
| `tag-late-join` | D joined at frame 194: its full record's 20 rows equal A's table at that frame |
| `tag-reconnect` | F (after E closed at 60 transactions) at frame 316: 21 rows equal A's |
| `tag-rekey` | Mover re-keyed out of the SubViewport: its entry was copied to id 26, with a row equal to the original's |
| `tag-resync` | drop-message: 1 coding resync, 2 full records, the tap validates |
| `tag-refused` | `GRC_ITEM_META=class`: a groups-only request gets no record; a full request gets grant `{class}` |
| `tag-off` | grant set, nobody asking: no `item-meta.json` (never on), no record |
| sabotages | `in-shared` fails meta-shared; `before-ready` fails meta-oracle on a group (`Early`: `[]` against `["rs_hand"]`); `skip-full` fails `item-meta-missing`; `id-off-by-one` fails `item-meta-id` |

## Pure-client proof

### Byte identity

The base is main 83c589b3's capture library, built from `git archive`. Both sides ran this branch's
scripts with `RS_SABOTAGE_TIER=skip`. The driver is `artifacts/tag1-ident/tag1-ident.sh`, after
`hc6-ident.sh`. Three sides ran:
- `base`;
- `tag1`: this branch, no grant;
- `tag1g`: this branch with `GRC_ITEM_META=class,script,scene,path,groups,meta` exported to every
  host, and nobody asking.

Results:

| layer | tag1 | tag1g |
| ----- | ---- | ----- |
| capture-scale /12 and /13, 300 frames, both sinks, hook log off | 4/4 recordings identical, stores equal | the same |
| capture-scale /12 and /13, hook log on | 4/4 identical, stores equal, `resources.jsonl` equal line for line (136,975 lines, timing masked) | the same |
| gate 1 (g1a, g1b) | 12/12 identical | 12/12 |
| gate 2 (g2a, g2b, g2d) | 24/24 identical; 57 verdicts equal | 24/24; 57 equal |
| gate 5 (g5c, g5e) | 11/11 identical; 46 verdicts equal | 11/11; 46 equal |
| gate 8 (g8t, g8a, g8m, g8w11, g8mm, g8pt) | 147/147 identical (145 by cmp-rec; GSW's two live /13 session recordings record by record); 176 verdicts equal | 146/147: the extra one is `decode-cost/capture-workers`, HC6's known worker-timing leg; 176 verdicts equal |

Notes on the comparison:
- **Full sinks.** capture-scale's full sinks (300 full transactions of 4,200 items) exhaust
  `cmp-rec.ts`'s heap. `rec-cmp.py` compares them record by record: every record byte-equal, and
  the session and end records equal once their ids and `*_ns_total` are masked.
- **Gate 8 hook logs.** Of 48 `resources.jsonl` files, 35 are equal line for line. The 13 others
  are HC6's known classes: the live-paced g8w11 coding hosts (frame counts differ), the
  worker-timing legs, and g8pt's engine particle seeds.
- **Live sessions.** Layer 3 holds: all 46 capture ctests pass unchanged, the hub's window-1
  transcripts and the golden-2..13 encoders included. Live sharing between an opted-in and an
  opted-out viewer of one host is `tag-meta-shared`.
- **The hello is unchanged** for a viewer with no extension. coding-receiver adds the key only
  under `--item-meta`, and every receiver's hello code is untouched.

**After merging main.** The branch was merged with main 0c666fd4, which brings W13f's live /13
history reuse into `rs_live.cpp`. The merged build was compared once more against that main's
library:
- capture-scale /12 and /13, both sinks: identical, stores equal;
- gate 8 `g8w11`: 53/53 identical (51 by cmp-rec, plus GSW's two live /13 session recordings
  record by record);
- `g8tag`: 15/15 again, and the 46 ctests pass.

The sets were pruned after judging. The cmp outputs, verdict lists and drivers are in
`artifacts/render-stream/p3/tag1/ident/`.

### Host cost with item_meta off

Measured with retired instructions, the HC2 method: `bench-capture-scale.sh --perf` with
`RS_BENCH_PERF_ARGS="-e instructions -c 1000000"`, split by `perf-capture-split.py --freq 1000`.
That gives M instructions per frame over an 8 s window at 60 fps. The run is capture-scale at the
full default scale, /13, a patch file sink, armed at birth. ABBA order was base, branch, grant, then
branch, grant, base.

| arm | main thread | capture (main minus engine) | "frame callback, other" |
| --- | ----------: | --------------------------: | ----------------------: |
| main 83c589b3 | 7.754 / 7.954 | 6.281 / 6.473 | 0.075 / 0.079 |
| TAG1, no grant | 7.763 / 7.908 | 6.325 / 6.388 | 0.092 / 0.069 |
| TAG1, grant set, nobody asking | 7.723 / 7.900 | 6.296 / 6.398 | 0.094 / 0.094 |

The repeats' spread (±0.1 M) exceeds every difference between arms, so the off cost is unchanged
within noise.
- **No grant:** the code adds one branch per snapshot frame (`g_meta.grant != 0`).
- **Grant set, nobody asking:** one more counter compare. Nothing per item, no node map, no
  strings.
- **Evidence:** `tag-off` shows the host never turned on in that case (no `item-meta.json`).

### Cost with item_meta on (capture-scale, real time)

This run is real time, under the exclusive quiet lock. The fixture is capture-scale at /13, live,
with one coded viewer at window 2: the 4,200 RenderingServer-only items (no node), 2,000 tagged
ColorRect nodes at start, a 1,700-node burst at frame 500 (a screen load), and churn of 2 nodes a
frame. The request is all four fields, one group and two meta keys. It ran 900 frames
(`artifacts/render-stream/p3/tag1/cost/`).

| | asked | not asked |
| - | - | - |
| per-item resolve, a node (burst frames 500 and 501) | 2.9–3.0 µs: 673 and 698 items each filled the 2 ms budget, and 335 more took 1.04 ms at frame 502 | — |
| the 1,700-node burst | 3 frames at ≤ 2.0 ms each (the budget) | — |
| turn-on (first hello) | 2,000 nodes and 4,200 no-node items: frames 4–6 at the 2 ms budget; the no-node items resolved together at frame 124 (2.5 ms, 4,051 entries, map misses only) | — |
| burst records | 3 deltas of 35–45 KB raw, 5.3–6.5 KB coded (zstd-base) | none |
| churn records (2 new nodes a frame) | 248 B raw, 171 B coded per frame | none |
| frame callback p50 / p95 / mean | 6.7 / 13.8 / 8.1 ms | 6.4 / 15.4 / 8.3 ms |
| host totals | 9,694 entries, 25.2 ms of identity reads, 58.7 ms of passes over 900 frames | 0 |

- **Identity reads cost about 3 µs per node.** That is at the design's low estimate (2–10 µs). A
  burst the size of STS2's largest (1,689 items) is about 5 ms of main-thread work, spread over 3
  frames by the 2 ms budget.
- **The records are small.** A burst record is about 4 % of a 1 MB burst transaction raw, and
  smaller coded. Without churn a warm frame carries no record at all (the tag-scene legs show deltas
  only at its steps).
- **The frame callback did not move.** Asked and not asked agree within this machine's noise.
- **tag-scene** (`tag-cost`, live/a): 26 entries at 4.4 µs each, the largest pass 133 µs.

## Validation

- **Plan.** `validate-increment.sh --plan`: 60 changed paths, and the capture reaches every target.
- **Remote full tier**, run 41051376090 (`rv-20261030T115352Z-466e706-2585`, collected with
  `--collect`): 19/22 runs pass. Every native gate passes, `native-rust-gate8` with `g8tag` and its
  sabotage legs included, as do `g7-gsw`, `g7live-web-rust`, `capture-build`, the cargo crates,
  `pnpm-test` and `bench-instr` (every case within ±0.9 % Ir of its baseline). HC_SHADOW reported
  no mismatch. The three that failed:
  - **`pure` (shard 1).** `self-test-gate8z` wanted a `GROUP_COVERAGE_8` decision for `g8tag`, and
    tsc flagged a boolean in `gate8-tag-checks.ts`. Both are fixed. Local `--only pure`: 97/97.
  - **`g7live-gsw`.** Its `g7-8` job died at setup (`Unable to resolve action actions/cache@…`).
    Local `--only g7live-gsw` (g7-8): pass.
  - **`g7-web-rust`.** Its `g7-8` job died while judging, after two repeat legs timed out (exit
    124). g8tag is not in g7-8's gate 8 source run. Local `--only g7-web-rust` (g7-8):
    pass.
- **Refused remotely, run locally.**
  - `lock-tests`: pass.
  - `g7live-gsw` g7-1: pass.
  - `g7live-web-rust` g7-1: the first run failed `leg-class-sabotage-stale-coalesce@web` (class
    replay-failure) under heavy load, after 57 minutes of lock wait. The rerun passed.
- **Timing runs go to the milestone sweep**: gate 6, the g7live timing groups and g7x.
- **Local.** 46/46 capture ctests. rs-core 136, capi 17 and the gsw-rs wasm32 check, as the
  validator subagent reported. The experiment's tsc is clean apart from the three known files.
  `g8tag` 15/15 (`artifacts/render-stream/p3/tag1/g8tag/`).

## Deviations from the design

Each is written into the design (in place, and under "As built (TAG1)"):

1. **The delta range is per connection.** It covers (the frame of the connection's previous
   transaction, frame(T)], not (frame(B), frame(T)]. At window 2 two patches share a base. The
   memo key becomes (grant table, form, what the receiver holds, target).
2. **Resolution runs after the snapshot**, and only for items the mirror published. Before the
   snapshot, an item withheld under skip would be stamped earlier than any snapshot that carries
   it, and its row would never be sent.
3. **One string table per grant**, not one per session across grants. Otherwise a narrow grant
   would receive the strings a wider grant's columns carry.
4. **The record meta carries `"blocks":[]`**, like every other record. The design's key list
   omitted it.
5. **File sinks need `GRC_ITEM_META_FILE`** as well as the grant. Otherwise the grant alone would
   change every recording, against "grant set, nobody asking: byte-identical".
6. **A dropped transaction gets no record**, and does not advance its connection's range.
7. **Pending items back off** instead of being retried every frame. capture-scale's 600
   RenderingServer-only items cost 72,000 retries over 120 frames without it.
8. **capi's accept kind is 6**, because 5 is `KIND_HELD`. GSW's is 5.

## Memory-worthy

- Godot `born` arms see the main scene's nodes as created before the arm, because the main scene is
  instanced before the autoload's `_enter_tree`. Identity legs arm `late` with `GRC_ADOPT=arm`, so
  adoption makes the scene's items known.
- The listener takes at most four connections (`GRC_LIVE_MAX_CONNECTIONS` 1..4).
- Lockstep is not guaranteed between Node viewers that ack on arrival. One of three ran a frame
  behind, so seq-exact byte comparisons need a pair that is actually in step. Compare with seq
  aside otherwise.
- Editing a runner script while it runs breaks bash. It reads the file incrementally ("unexpected
  EOF").
