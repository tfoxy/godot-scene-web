# Host cost proportional to churn (HC, 2026-10-28)

The capture's main-thread cost per frame should follow what changed in the frame, not how many
canvas items, textures and materials the scene holds. This doc designs that change. The profile it
rests on is `results/p3/hc.md`; the implementation lands as HC1.. after PM1.

**Target.** Warm render-stream should cost the game no more than live video encoding does: NVENC
takes about 1–3 ms a frame, off the game's CPU. MX (`results/p3/mx.md`) measured STS2's main
thread, path on minus off: menu 2.7–3.7 ms, static map 6.2–6.4, idle combat 9.0. The capture-scale
fixture reproduces that shape (`results/p3/hc.md`): about 3.7 ms a frame with **nothing** changing
and one viewer, and 7.5 ms under STS2-like churn.

**Constraints**, for every idea below:

- **Wire byte-identity.** Every record and every transaction is byte-for-byte what `main` emits
  for the same calls, at every version, in file sinks and on live connections. Only volatile fields
  (ids, timing stats) may differ, as today.
- **Shared encodes stay shared** (P3-SP, W11b decision 4). Lockstep viewers of one (B, T) still
  share one transaction, one record list and one coded message.
- **No per-frame host work for a feature nobody uses.** A hook log that is off, a census nobody
  reads, a listener with no viewer and a /10 hash at a /11-only host must cost nothing per frame.
- **Generic.** Nothing below knows STS2 or any game. It keys on RenderingServer calls and on the
  capture's own tables.

## Where the time goes

From `results/p3/hc.md` (capture-scale, /11, `perf record -g` on the armed host, an 8 s steady
window, main thread, ms per frame):

| | static, 1 viewer | churn, 1 viewer |
| --- | ---: | ---: |
| snapshot: walk every item, copy every `ItemState` (commands included), every texture, mesh, shader and material entry, rebuild the payload map | 2.0 | 2.4 |
| previous-snapshot release (free those copies) | 0.24 | 0.66 |
| diff (`make_patch`: compare every entry of every table) | 0.53 | 0.59 |
| record planning (`records_before`: two `std::set<std::string>` walks of every table) | 0.52 | 0.60 |
| serving and budget (`ServedResources::pin`/`retire` over every payload; serve-event log lines) | 0.28 | 0.71 |
| hub, encode (JSON and blocks), zstd | 0.15 | 0.98 |
| cv digests (/11 `content_version`: command JSON + SHA-256 per re-recorded item) | 0 | 0.22 |
| hooks (all per-call work) | 0 | 1.2 |
| **capture total** | **3.7** | **7.5** |

The fixture's real-time callbacks run 1.0–1.8× these perf-wrapped figures (`results/p3/hc.md`,
"Real time against perf"); the shares agree.

Three facts drive the design:

1. **The static cost is the table walk, not the wire.** With no RenderingServer call at all,
   the frame callback still copies 4,200 items with all their commands, compares them all,
   rebuilds every name set and payload map, and frees the previous copies. The patch it encodes
   is empty.
2. **A live listener with no viewer still snapshots every frame** (`stream_publish`'s `serving`
   rule, kept so the served set is current, G2c2 D7): 2.5 ms static and 5.0 ms churn on the
   fixture, for nobody.
3. **The hook log formats JSON lines it then discards.** `GRC_HOOK_LOG=off` (the product
   setting) skips only the file write: every texture, mesh and material hook, and every serve
   event, still formats its `resources.jsonl` line. That is 0.66 ms a frame of the churn case,
   more than half of all hook time.

## D1. Dirty tracking: a persistent published state

### Shape

The mirror keeps the **published state** as shared, immutable entries, and each snapshot shares
every entry that did not change since the last one.

- **`rs2::SharedTable<T>`** replaces `std::vector<T>` for `Snapshot::items`, `canvases`,
  `textures`, `meshes`, `shaders` and `materials`.
  - Entries live in fixed id ranges: chunks of 64 consecutive wire ids, each chunk an immutable,
    shared, sorted array of `std::shared_ptr<const T>`. A table is a sorted vector of chunk
    pointers.
  - Copying a table is one refcount bump per chunk (66 chunks for 4,200 items), not a deep copy.
  - It keeps `std::vector`'s read interface (`size`, `operator[]`, `begin`/`end` yielding
    `const T &`, `back`, `empty`), as P3-CAP's `SharedVector` did for material parameters. The
    readers (codec, diff, hub, validators' C++ twins, tests) compile unchanged. Writers get
    `set(id, T)`, `erase(id)` and `push_back` (tests), each copy-on-write of one chunk.
  - Wire ids grow monotonically, so new entries append to the last chunk, and a freed id empties
    its slot. Order by id is the iteration order, as the wire requires.
- **`ItemState::commands`** becomes `SharedVector<Command>` (HC2, the first step). An item's
  command list is then shared between the mirror, every snapshot and every base a connection
  holds, until the item records again.
- **`Captured::payloads`** becomes a shared, copy-on-write map. A snapshot whose texture, mesh and
  shader chunks are all pointer-equal to the previous one's reuses the previous map.

### Dirty sets

Each hook that changes mirror state marks what it changed. Marking is O(1): a per-entry
`dirty` flag plus a push to the table's dirty vector when the flag was clear.

- **Items**: any item setter, `clear`, any `add_*`, parent and child changes (both ends), material
  and instance parameters, back-buffer state. A child's `draw_index` or z change also marks its
  container, whose draw-index-tie entry may change.
- **Canvases**: attach, stacking, transform, modulate, item list.
- **Textures, meshes, shaders, materials**: their own hooks, worker completions (`settle`,
  `resolve_pending`), Basis attachments, and a dynamic mesh's promotion.
- **Session-level fields** (`shader_time`, failures, session `unsupported`, default filter and
  repeat, `unknown_items`): rebuilt every snapshot. They are a handful of scalars.

**A same-value call is not a change.** A setter whose new value equals the old one bitwise marks
nothing. That needs no new state: the mirror compares before it writes. It matters because games
re-assert state every frame: STS2 re-sets 77 materials a frame (P3-CAP), and that alone reruns
adoption's pending-material pass (0.6 ms a frame) through `material_refs_epoch_`, which today
moves on every non-null `set_material`.

**An identical re-record is not a change (/11).** At /11 `content_version` is a digest of the
command list (W11b decision 1), so an item cleared and re-recorded with the same commands keeps
its published version. The mirror keeps the previous `SharedVector<Command>` at `clear`. At the
snapshot, an item whose counter moved compares its new list with the kept one (a field-wise
bitwise compare, far cheaper than JSON encoding and SHA-256). Equal: it keeps the kept vector and
its digest, and the item is not dirty. WB found 163 of 174 patched STS2 items carry nothing new,
and STS2 clears 231 items a frame. Below /11 the counter is the wire's `content_version`, so the
re-record stays a change there, exactly as today.

### The snapshot

`Mirror::snapshot` becomes:

1. Copy the last published `Snapshot` (one bump per chunk) and the payload map pointer.
2. For each dirty entry, rebuild its wire entry (`ItemState`, `wire_entry`, `wire_mesh`,
   `wire_shader`, `wire_material`) and `set` it, or `erase` a removed one.
3. Rebuild the **derived** parts only where their inputs moved:
   - Item-level `unsupported` entries are cached per item and recomputed for dirty items. A
     change to any input that another item reads (a texture's or mesh's status, a material's
     unsupported verdict, the pending set, a diffuse link) is rare, so it marks every item
     dirty for one snapshot rather than keeping reverse dependencies. The sorted list is a
     `SharedVector<UnsupportedRef>`, rebuilt only when an item's cached entries changed; an
     unchanged list is pointer-equal, so /11's patched `unsupported` (null when equal) costs one
     pointer compare.
   - Draw-index ties: recomputed per dirty container.
   - Tombstones: the reference walk runs only while a freed texture or mesh tombstone exists (a
     rare state), exactly as today.
   - The payload map: copy-on-write, updated for dirty textures, meshes and shaders.
4. Clear the dirty sets.

The order of the published entries, the derived lists and every field stay what the full walk
produces, so the wire cannot tell. HC4's shadow oracle (below) proves that per frame.

### What a static frame then costs

Copy 6 chunk vectors and a map pointer, rebuild the session scalars, diff by pointer compare,
encode an empty patch. Bounded by the fixture: the 3.7 ms static total minus the walk-, copy-
and compare-proportional parts leaves the encode, the hub and the chunk-level walks, **0.1–0.2 ms**.

### The diff, record planning, serving and budget

They operate on two published states, B and T, for any B a connection holds (window 1, 2,
resync). Pointer equality makes them O(changed chunks) for any pair, with no dirty-set history:

- **`make_patch`**: a chunk pointer-equal in B and T is skipped whole; inside a differing chunk,
  a pointer-equal entry is skipped. Only differing entries run `item_state_equal` and friends.
  Item commands compare by `SharedVector::shares` first.
- **`records_before(B, T)`**, `inline_names`, `payload_refs`: names come from differing chunks
  only. A name from T's differing chunks is new to B unless B holds it; B holds it if it is in
  B's differing chunks (a small set) or in the chunks B and T share. The second test uses a
  name-count index the mirror maintains for the newest state (a hash's count minus its
  occurrences in T's differing chunks). When T is not the newest state (never on the live path)
  the full walk runs, as today.
- **`ServedResources::pin`/`retire`** and `payload_union_bytes`: keyed on the payload map
  pointers. An unchanged map is a no-op; a changed one is walked over its differences.
- **Store bookkeeping** (`store_payloads`) visits only differing texture, mesh and shader chunks.

### As built (HC4a: items and canvases; `results/p3/hc4a.md`)

- **Dirty means touched; a change is decided at the snapshot.** The mirror's items sit in an
  `ItemMap` whose only mutable accessors (`mut`, `emplace`, `erase`, `mut_all`) mark the item, so
  the compiler finds every write. The snapshot rebuilds each marked item's entry and republishes
  it only when `item_state_difference` (every field, floats by bit pattern) finds a difference. A
  same-value setter therefore costs one compare at the snapshot and publishes nothing; the setters
  were not given compare-before-write paths of their own. `mut_all` (a material freed) and the
  first snapshot after `reset()` rebuild every item.
- **Canvases are compared whole every snapshot** rather than marked: there are a handful, and a
  compare without a copy costs about what a mark would.
- **Derived inputs other items read** (a texture or mesh turning unsupported or delivery-pending,
  a referenced multimesh's, emitter's or effective material's verdict) are fingerprinted each
  snapshot; a moved fingerprint rederives every item's own entries for that snapshot. The D9
  effective material is the one parent-chain dependency: when an item's material inputs move,
  its `use_parent_material` descendants are rederived.
- **Under Skip**, items parented to an unknown RID are tracked per marked item, so the withheld
  walk runs only while one exists.
- `Snapshot::unsupported` stays a `std::vector`: the item-level part is kept sorted per item and
  concatenated only when an item's entries change, then copied into each snapshot.
- **The shadow oracle** is `GRC_HC_SHADOW=1` (`HC_SHADOW=1` in a runner's environment;
  `validate-increment.sh` sets it for every correctness run of the full tier and of a milestone
  sweep). It compares items, canvases, item-level entries, the items' multimesh and emitter
  references and the lowering flags, then the encoded `make_patch(previous, current)` at the
  stream's version, and ends the stream with `hc-shadow-mismatch: <table> id <id>: <field>`.

### As built (HC4b: resource tables, payload map, planning, serving; `results/p3/hc4b.md`)

- **Textures, meshes, shaders and materials** are `SharedTable`s in `Snapshot`, and the mirror
  keeps them in `ResMap`s with `ItemMap`'s discipline (reads through `find`/`all`, writes through
  `mut`/`emplace`/`erase`/`mut_all`, each marking what it touches). The snapshot rebuilds the
  marked entries (`wire_entry`, `wire_mesh`, `wire_shader`, `wire_material`) and republishes one
  only when `*_entry_difference` (every field, the host's own included: a surface's body and key
  flag, the /11 forms) finds a difference. Textures a worker or a pending recovery still holds are
  revisited every snapshot (`settle`, `resolve_pending`), as the full walk did for all of them.
  Multimeshes and emitters stay vectors: their tables follow the items' references, and neither
  is walked when no item names one.
- **The payload map** (`Captured::payloads`) is an `rs::SharedStrMap` (`rs_shared_map.h`): a
  persistent sorted map whose chunks of at most 128 entries are shared copy-on-write, with
  `std::map`'s read interface and a byte total (`weight()`). Each resource entry keeps its share
  (the hashes and bytes it puts in the map); a hash stays while some entry names it. A snapshot
  whose payloads did not move holds the previous snapshot's map root.
- **The name index** (`Captured::names`, a `SharedStrMap<NameCount>`) counts the entries naming
  each hash by `payload_names()`'s rule (main and variant roles, payload bytes), with
  |inline(state)| kept for the stream's inline threshold. `rs_records.h plan_v11_records(B, T)`
  walks the entries B and T do not share: a candidate from T's differing entries is held by B
  when one of B's differing entries names it or T counts more entries naming it than its
  differing ones (a shared entry does). It falls back to `records_before()` when T carries no
  valid index (a hold-back snapshot `resolve_captured` filled in, a publisher sabotage's table,
  the PM5 lowering). The hub's `v11_records` and the file publisher's /11 lanes use it.
- **Store bookkeeping** visits only the entries a publication does not share with the previous
  one: the store only grows, so every name the previous one held is stored.
- **Serving and the budget** (`ServedResources`, `payload_union_bytes`): after a `retire()`, the
  served set is exactly the current map and each base's, so a map that is one of those (or was
  pinned whole since) pins nothing, and any other is pinned over its differences from the
  current one. Retirement candidates are the hashes `pin()` added beyond those maps and the
  hashes the previous current map and dropped bases hold that the new current map lacks, retired
  in key order (the full walk's event order). `retained_bytes_beyond` and the union's bytes use
  the same differences. The unpin and retain-superseded sabotages keep the full walk.
- **Derived inputs** are compared per marked texture and mesh (a texture's unsupported-or-pending
  bit and diffuse link, a mesh's unsupported status) instead of HC4a's per-snapshot fingerprint
  walk; tombstones are kept as sets, so the tombstone rule's reference walks (items, materials,
  shaders, canvas diffuses) run only while one exists. Material verdicts are recomputed when a
  texture or shader moved, and only the moved materials' when only materials did.
- **The shadow oracle** also builds the four tables, the payload map (first entry naming a hash
  supplies its bytes) and the name index by the full walk and compares them entry by entry, then
  `plan_v11_records` against `records_before` (with and without variants) from the previous
  snapshot. Serving runs its own twin (the retained set after each `retire()` against current
  and bases' union, `retained_bytes_beyond` against the walk) and the budget's union against
  P3-CAP's walk; the frame callback ends the stream on either, like the mirror's.
- **Sabotages**: `hc-skip-dirty-texture` (the first published texture marked loses that mark and
  every later one) and `serve-skip` (a payload map that differs from the last retained one pins
  nothing, from the first map on), both `GRC_HC_SABOTAGE` test knobs.

## D2. Hashing

| hash | today | after |
| ---- | ----- | ----- |
| dynamic mesh surface SHA-256 (W11b decision 3) | at every region update, twice per pose (vertex, then attribute), over a freshly rebuilt GRM1 payload | **lazy**: a region update copies into the shadow buffer and marks the surface dirty. The GRM1 body is built once per snapshot that needs it. The SHA-256 runs only when something reads the hash: a static mesh, a below-/11 connection, a file store, or the hook log when on (`dyn-wire`). A /11-only product host never hashes a dynamic surface. Change detection becomes the memcmp against the shadow copy that render-stream-11.md "Capture policy" already specifies |
| static mesh surface, texture, shader payload SHA-256 | once per content change | unchanged (it names the payload on the wire) |
| `content_version` digest (/11) | JSON encode + SHA-256 per item whose counter moved, including identical re-records | only for items whose command list really changed (D1's re-record rule) |
| texture worker hashes | on workers | unchanged |

No hash on the wire changes: every hash that is emitted is still computed from the same bytes. A
hash nothing reads is simply not computed.

## D3. JSON and encoding

The encoder already writes only the patch: encode was 0.01 ms static and 0.29 ms churn on the
fixture (0.09 ms in STS2 combat, MX). Its input becomes smaller once identical re-records stop
being patched entries (D1), but its share is small, so the design does not make it incremental
at a finer grain. Two items remain:

- **Per-entry encode memo.** A transaction's JSON is entries in id order. With shared entries, a
  changed entry's encoded bytes can be memoized per entry pointer for the frame callback, so N
  connections with different bases (window 1 after a fold, a resync) re-encode each entry once.
  P3-SP already shares whole transactions for lockstep viewers; this covers the non-lockstep ones.
  Bounded by `encode` × (distinct bases − 1); not worth it before HC5 measures it.
- **Restamp copies.** A shared transaction is re-stamped per connection by copying its bytes.
  At 4 viewers that is 3 copies of a ~12 KB transaction a frame, under 0.01 ms.

## D4. Moving work off the main thread

What must stay on the main thread: the hooks (they run on the engine's calling thread), the
snapshot (the frame boundary is the main thread's end of frame), and everything that decides
what is sent (the hold-back, credit, rate ticks, serving pins), because those decisions are
frame-paired. What can move: work that is a pure function of immutable published states.

- **Per-(B, T) formation**: `make_patch`, `records_before`, `encode_transaction`,
  `encode_resource`, the live coding (zstd). After D1 the inputs are immutable shared states, so
  they can run on one encode thread. The hub decides on the main thread which (B, T) each
  connection gets, enqueues the job, and the encode thread hands the bytes to the WebSocket I/O
  thread in the hub's order. The P3-SP memo moves with it: jobs are keyed by (B, T, version),
  and the second lockstep connection's job finds the first's bytes.
- **Frame pairing holds** because the transaction's `frame` and `seq` are fixed when the job is
  enqueued, and the I/O thread sends messages in enqueue order. The resource records of a
  transaction are part of the same job, ahead of it.
- **Serving**: payloads are pinned on the main thread before the job is enqueued (phase 1 of
  `stream_publish` today), so a receiver's GET for a record's hash can never arrive before its pin.
- **File lanes**: the patch and full lanes already queue their I/O on `rs::FileWriter`
  (P3-CAP); formation can move to the same thread for the same reason.
- **Cost of moving**: one frame of added latency at most when the encode thread is busy; the
  credit loop already tolerates it (window 2). At window 1 it shifts the credit phase, a timing
  question for the milestone sweep.

Saving: the per-(B, T) work, 1.6 ms of the churn fixture today, after D1 roughly the encode and
zstd (0.6 ms churn, 0.35 ms STS2 combat).

### As built (HC5: the formation thread; `results/p3/hc5.md`)

- **One job per sending connection per frame callback** (`rs_live.cpp`, `Hub::Job`). The callback
  decides on the main thread, as before, everything that is frame-paired: which connections
  send, the target, base, seq, frame and encoding, credit and the window, rate ticks, the
  drop-message, stale-coalesce, ignore-credit and window-overrun sabotages, the serving pins, and
  the below-/11 CarriedIndex marks (they mutate host-wide state, so the walk stays). The
  connection's state advances at once. The job carries the rest: the /11 record plan
  (`plan_v11_records`), the resource records, `make_full`/`make_patch` and `encode_transaction`
  (or a lockstep connection's re-stamp), and the live coding. It hands every message to the
  transport in order: a connection's session message first, then its records, then its
  transaction.
- **The jobs of one callback run in submission order on one encode thread** (`Hub::Former`).
  `LiveConfig::formation` selects `Thread` (entry.cpp's default) or `Inline` (the end of the
  frame callback, on its thread; the unit tests' default, and `GRC_HC_FORMATION=inline`). The
  P3-SP, W11b and W11t memos (`Hub::Memo`) belong to the job runner, so the second lockstep
  connection's job finds the first's transaction, records and coded bytes. A batch-end job hands
  the memo back to the main thread, which releases its snapshots, and flushes the taps.
- **A job touches only the memo, its own outputs and its connection's `FormState`.**
  `FormState` holds the transport id, the tap, the coding and the coding prefix (`last_tx`).
  The job reports what it did: its counters (`Hub::Counters`), its live-log lines, and a
  `message-too-large` error, whose text it sends itself so that nothing follows it. The main
  thread completes jobs (`Hub::sync()`, which waits for the queue) at the top of every entry
  point (an event, the next frame, finish, close, a GET) and at the top of each frame callback
  (`live_drain`). Completion applies the counters and writes the lines, the `message-too-large`
  close, and the frame line with the transaction's bytes, in the order a synchronous hub wrote
  them. A job's frame line is therefore written one callback later, before any later event line
  of that connection.
- **Frame pairing and serving are unchanged.** seq and frame are fixed at enqueue, and the
  payloads are pinned before `on_frame_shared` (phase 1), so a GET for a record's hash cannot
  arrive before its pin. Messages leave the transport in the hub's order per connection.
- **File lanes form on the P3-CAP writer** (`Publisher::set_former`, `form_lane`). Each
  publication queues one task per lane behind its store writes. The task encodes the lane's
  records and its transaction (`make_full`/`make_patch`) and writes them with the sinks'
  `write_direct`. The record plan, the carried set, the inline resource events and the
  patch-drop-item decision stay in `publish()`. The lanes' end stats belong to the writer until
  `finish()` drains it. The published snapshot is now held shared (`last_published_shared()`), so
  the live hub takes it without a copy.
- **Release on another thread.** Snapshots, records and transactions can now drop their last
  reference on the encode thread or the writer. Every copy-on-write site that writes in place
  when `use_count() == 1` takes an acquire fence: `SharedVector`, `SharedTable` (as before),
  `SharedStrMap::own_root`/`own_chunk`, the mirror's multimesh buffer and material floats.
- **Sabotage `reorder`** (`GRC_HC_SABOTAGE=reorder`, `LiveConfig::reorder_frame`): every job sends
  its transaction before its resource records.
- **W13b's hook:** a per-connection predictor state belongs in `FormState`, beside `last_tx`. It
  advances in job order, so the T−2 base it predicts from is the connection's own last formed
  transactions, never the main thread's view.

## D5. Hook overhead per RenderingServer call

Measured on the fixture (churn, one viewer; `results/p3/hc.md`):

| hook | calls / frame | µs / call | of which |
| ---- | ------------: | --------: | -------- |
| `mesh_surface_update_vertex_region` | 76 | 4.2 | hook-log line format ~1.5, GRM1 rebuild + SHA-256 ~1, two locks, mirror |
| `mesh_surface_update_attribute_region` | 76 | 4.0 | the same |
| `canvas_item_set_material` | 76 | 2.4 | hook-log line format ~1.6 |
| `mesh_set_custom_aabb` | 76 | 1.5 | hook-log line, mirror |
| `canvas_item_set_transform` | 100 | 0.7 | census entry, mirror lock and lookups |
| `canvas_item_clear` | 170 | 0.5 | mirror |
| `canvas_item_add_*` (re-records) | ~850 | 0.1 | mirror push |

The fast path, in order of payoff:

1. **No hook-log line without a reader.** `ResourceLog` keeps its registries (the mirror and
   `counters.json` read from the hooks, not from the file), but formats nothing when the file is
   off and no in-process consumer is attached. Serve events likewise.
2. **Lazy mesh surfaces** (D2).
3. **Same-value early-out** (D1): compare, then return before any lock beyond the mirror's.
4. **One lock per call.** The mesh region path takes `g_texture_order`, `g_mutex`, the mirror's
   mutex and the log's mutex in turn. Rendering-server calls come from the main thread in
   practice; a thread-id check can select an uncontended path, and other threads keep today's.
5. **Direct entry pointers.** `item_by_rid_` maps to an id, then `items_.at(id)` walks a
   `std::map`; the rid map can hold the entry pointer (node-stable) directly.
6. **The census** (`log_entry`, the gate -1 calibration tables) measured 0.013 ms a frame. It
   stays as it is.

A floor for a hooked call is then the mirror update and a dirty mark: about 0.1–0.3 µs. STS2
combat makes about 1,000–1,500 hooked calls a frame (`fidelity/legs/a8-2` counts average 1,060 over
the whole route), so the hooks' floor there is about 0.1–0.5 ms.

### As built (HC6: the hook fast path; `results/p3/hc6.md`)

Measured first (capture-scale, /11, churn, one viewer, `perf -e instructions -c 1000000`, every
main-thread sample under a `hook_*` frame): about 1,460 hooked calls a frame cost 1.9 M
instructions, 1,300 a call. Where they went was not what the table above assumed: the mirror's two
lookups per call (`item_by_rid_`'s `std::unordered_map`, then `items_`'s `std::map`) were half of
`canvas_item_set_transform`, `set_material`, `add_texture_rect` and `add_mesh`; building a
`Command` and moving it twice was half of `add_rect`; and the hook log, its lines off, still built
a `Line` (strings, a `std::string` op name, `clock_gettime`) for every mesh region and custom AABB
call. The uncontended mutexes were 5 % of hook samples. HC6 took what the measurement pointed at:

- **Direct entry pointers** (D5.5). The mirror's RID maps are `RidMap` (`rs_rid_map.h`): an
  open-addressed flat table, key and value in one slot, Fibonacci hashing, backward-shift deletion,
  never iterated. `item_by_rid_` and `mesh_by_rid_` hold the entry's node pointer beside its id
  (`std::map` nodes are stable until erased), so `find_item`, `peek_item`, `find_mesh` and
  `peek_mesh` make one probe and mark the entry they already hold. The pointer is written where
  the node is emplaced (`create_item`, `rekey_subtree`, the three mesh creators); every erase
  leaves the RID map first.
- **Commands built in place.** `emplace_command` checks the item's command cap and returns a
  default `Command` at the end of its list; `add_rect`, the three texture-rect ops,
  `add_set_transform` and `add_clip_ignore` fill it there (nothing between the lookup and the push
  has a side effect). `push_command` takes the command by rvalue reference, so the other ops move
  it once.
- **No line, no line work** (D5.1, finished). With the hook log's lines off,
  `ResourceLog::mesh_surface_update_region` and `mesh_set_custom_aabb` update the registry exactly
  as before and build nothing; `canvas_item_set_material`, which keeps no registry, is not called;
  `tap_context()` reads the clock only for a line.
- **Fewer locks, not one lock** (D5.4). `ResourceLog::active()` is an atomic read (the methods
  re-check it under their mutex), and `Mirror::omits()` returns without the mirror's mutex unless an
  omit-op sabotage is armed. That takes `set_material` from 4 lock pairs to 2, a mesh region update
  from 7 to 5 and `mesh_set_custom_aabb` from 6 to 4. Merging the census's `g_mutex`, the texture
  order lock and the mirror's and the log's mutexes into one would save at most the 9 % of hook
  samples the mutexes now take, for a cross-module locking change; it was not made.
- **The census stays, indexed** (D5.6). A `PodEntry` census log keeps an open-addressed index of
  its entries by a hash of the key's bytes, so a call finds its identical entry without comparing
  it to every kept one. The entries, their order, their counts and the drops are the linear
  scan's. It matters more on a game than on the fixture: STS2 combat makes 281
  `canvas_item_add_set_transform` and 121 msdf glyph calls a frame (`fidelity/legs/a8-2`), into
  logs of 32 and 256 entries.
- **No same-value early-outs were added** (D5.3). HC1 already returns from a same-material
  `set_material`; elsewhere a same-value setter still moves the mirror's epoch (the live hub's
  `coalesced` and pending counters read it) and marks its item, which costs one compare at the
  snapshot (HC4a).

Result: the hooked calls of a churn frame cost 1.28 M instructions instead of 1.90 (−33 %), 880 a
call. What is left is mostly the first touch of the item or mesh the call writes (a cache miss the
direct pointer cannot avoid), the census, and a mesh region's three passes over its bytes (the
hook's copy, the mirror's compare and the mirror's copy).

## D6. No viewer, unused features

- **No viewer, no snapshot.** A listener with no connection that has sent a hello, and no file
  sink, takes no snapshot. The served set is pinned from the first hello's snapshot, which that
  callback takes anyway (`wants_snapshot` is true for a hello'd connection), so every payload the
  first transaction names is servable before it goes out, as G2c2 D7 requires. The hooks keep the
  mirror current, so a late joiner's first transaction is the same full transaction it gets
  today. Saving on the fixture: the whole frame callback at 0 viewers, 2.5 ms static and 3.4 ms
  churn (the hooks stay).
- **A hash or a line nobody reads is not made** (D2, D5).
- **Below-/11 machinery on a /11-only host.** A /11 connection takes no `CarriedIndex` slot
  (W11b); the per-target `target_refs` memo is built only for below-/11 connections. No other
  per-frame work is version-only.

## Savings and projection

Measured shares are the fixture's (perf-wrapped). "STS2 combat" scales the fixture shares to MX's
combat split (callback 7.0 ms of the 9.0 on−off: snapshot 3.2, diff 0.8, encode 0.09, zstd 0.25)
and P3-CAP's after-profile (adoption pass 0.6). Each saving is bounded by the measured share of
the work it removes.

| idea | removes | fixture static / churn (ms) | STS2 combat, est. (ms) |
| ---- | ------- | ---------------------------: | ---------------------: |
| hook log formats nothing when off (D5.1) | `ResourceLog::format` everywhere | 0 / 0.66 | 0.6–0.9 |
| same-value `set_material` does not move `material_refs_epoch_` | adoption's per-frame resolve pass | 0 / 0 | 0.6 |
| no viewer, no snapshot (D6) | the whole callback at 0 viewers | 2.5 / 3.4 at 0 viewers | (seat idle) |
| shared command lists (HC2) | command copies and frees in snapshot and release | ~0.5 / ~0.7 | ~1.0 |
| lazy mesh surfaces (D2) | GRM1 rebuilds and SHA-256 per region call | 0 / ~0.3 | ~0.4 |
| identical re-record (D1, /11) | cv digests and patched entries of re-records | 0 / 0.22 | ~0.3 + smaller patches |
| persistent tables + pointer diff (HC4) | the rest of the walk, diff, release, planning, serving | ~2.7 / ~2.6 | ~3.5 |
| formation off the main thread (D4) | encode, zstd, residual diff | 0.05 / ~0.6 | ~0.4 |
| hook fast path (D5.3–5) | locks and lookups per call | 0 / ~0.3 | ~0.5 |

**Projected warm combat** (STS2, one viewer, /11, the MX leg): today 9.0 ms. After HC1–HC4 about
**1.5–2.0 ms**: hooks 0.5–0.8 (about 1,500 calls at the floor), snapshot and diff over the
frame's real changes (spine meshes, the few items that really move) 0.3–0.5, encode and zstd
0.35, the rest 0.2–0.3. With HC5's formation thread, about **1.2–1.6 ms**. The static map and the
menu would cost what their changes cost: a few hundred hooked calls and a near-empty patch,
**0.3–0.8 ms**. That is inside NVENC's 1–3 ms, on the CPU rather than a GPU engine. The NVIDIA
driver's spin (about a quarter of STS2's main thread) is not capture cost and stays.

These are projections from attributed shares, not measurements. HCz measures them.

## Byte-identity proof method

Every HC increment proves that the wire did not move, on three layers:

1. **Recordings.** `scripts/cmp-rec.ts --tree` (landed with PM1) compares every file-sink
   recording, record by record, between `main`'s library and the increment's, on the gate legs
   the diff reaches: g1a/g1b, g2a/g2b/g2d, g3a, g5c/g5e, g55c/g55d, g8m/g8a/g8t, and **g8w11**'s
   captures (`scale/capture`, `scene/capture`, `mesh/capture`), plus `resources.jsonl` line by
   line where the hook log is on. Equal apart from session/stream ids and timing stats.
2. **The fixture at scale.** `capture-scale`, 300 frames, synchronous texture workers and 64×48
   textures (P3-CAP's deterministic setting), at /8, /10 and /11, with churn and
   `RS_SCALE_REDRAWS`: the recording is cmp-rec-equal and the store `diff -r`-equal.
3. **Goldens and transcripts.** `golden-2/` to `golden-11/` ctests and the window-1 transcripts
   (`rs_live_window_test`) pass unchanged.

HC4 adds a fourth, per frame: the **shadow oracle**. Under `GRC_HC_SHADOW=1` (a test knob, never
the product default) every snapshot is also built by the old full walk, and the two must be equal
field by field, entry by entry, payload map included; so must `make_patch(prev, cur)`'s encoded
bytes. A mismatch fails the stream with `hc-shadow-mismatch` naming the table and id. Every gate
leg in the full tier runs once with it on.

## Increments

Ordered by saving per risk. Each lands as one commit with its result doc. Timing numbers come
from real-time legs (`bench-capture-scale.sh`, `bench-live-scale.sh`) and the milestone sweep.

| Id | Scope | Saving (fixture churn, 1 viewer; STS2 combat est.) | Checks | Sabotages |
| -- | ----- | --------------------------------------------------- | ------ | --------- |
| **HC1** quiet paths | `ResourceLog` formats nothing while the file is off (registries kept; serve events too); same-value `set_material` keeps `material_refs_epoch_`; no snapshot while no connection has sent a hello and no file sink is open | 0.66 ms; 0 viewers: the whole callback; STS2 ~1.2–1.5 ms | byte identity (layers 1–3); `resources.jsonl` with the hook log on unchanged line for line; `hook-log-off-formats-nothing` (a `ResourceLog` counter of formatted lines is 0 over a hook-log-off leg); `late-join-served` (a viewer joining at frame N of a 0-viewer leg gets a full transaction equal to a file sink's frame-N full, and every GET it makes succeeds); adoption's `resolve_passes` drops to the number of real material-set changes on `gate8-adopt` | `pin-late` (the first hello's snapshot is not pinned before the send) fails `late-join-served` with a 404; `epoch-frozen` (a changed material does not move the epoch) fails gate 8's adoption checks |
| **HC2** shared command lists | `ItemState::commands` as `SharedVector<Command>`; the mirror's items hold it; /11 identical re-record keeps the old vector and digest | ~0.7 ms (static ~0.5); STS2 ~1.0 ms | byte identity; `rs2_diff_test` and `rs_mirror_test` cases for share, divergence, re-record equal and unequal; `cv-stable-on-rerecord` (capture-scale `RS_SCALE_REDRAWS=170`: the re-recorded items' `content_version` never moves and they are absent from the patches) | `cv-churn` (exists, W11b) still fails `content-version-stable`; `rerecord-stale` (keep the old vector when the new list differs in one float) fails `dyn-wire`/receiver pixel checks on gate6-scene |
| **HC3** lazy mesh surfaces | region updates mark the surface; GRM1 built once per snapshot; SHA-256 only when read (static mesh, below-/11 connection, store, hook log on); change detection by shadow memcmp | ~0.3 ms; STS2 ~0.4 ms | byte identity at /8–/11; `dyn-wire` (hook log on, so hashes are made) unchanged; `dyn-classify` unchanged; a hook-log-off /11 leg's `counters.json` shows zero dynamic-surface hashes | `perturb-vertex`, `stale-dynamic` (exist) still fail `dyn-wire` |
| **HC4a** persistent item and canvas tables | `SharedTable<T>` for items and canvases; dirty sets and same-value setters; cached item-level `unsupported` and ties; pointer-equal diff; the shadow oracle | static ~1.6 ms, churn ~1.4; STS2 ~2.5 ms | byte identity; **shadow oracle on every full-tier gate leg**; `static-near-zero` (capture-scale static: callback p50 ≤ 0.5 ms, real time); unknown-item skip legs (withheld subtrees) | `hc-skip-dirty` (drop one dirty mark per N calls) fails the shadow oracle and the gate's receiver pixel checks; `hc-stale-derived` (skip one item's unsupported recompute) fails the oracle and gate 2's `unsupported` checks |
| **HC4b** persistent resource tables | textures, meshes, shaders, materials as `SharedTable`; COW payload map; `records_before`, `payload_refs`, store bookkeeping, `ServedResources` and the budget over changed chunks | static ~1.1 ms, churn ~1.2; STS2 ~1.0 ms | byte identity; shadow oracle; W11b's `carried-equals-names` and `resend-on-return`; gate 2/8 serving checks (pins, retires, GET status); G8kw hold-back legs | `hc-skip-dirty` on a texture (oracle, gate 2 texture checks); `serve-skip` (no pin for a changed map) fails `late-join-served` / gate 2's GET checks |
| **HC5** formation thread | per-(B, T) diff, records, encode and zstd on one encode thread; the P3-SP memo moves with it; file lanes form on the writer | ~0.6 ms; STS2 ~0.4 ms | byte identity; `rs_live_test` sharing and order tests; window-1 transcripts; g7-2/g7-5 live legs at /11; credit RTT and rate no worse (real time, milestone) | `reorder` (send a job's transaction before its records) fails `resource-missing` in the receiver |
| **HC6** hook fast path | one lock per main-thread call; direct entry pointers; early-outs | ~0.3 ms; STS2 ~0.5 ms | byte identity; hook-log-on legs line-equal; a threaded-caller leg (`RS_FIXTURE_ARM=thread`) | — (no new behaviour; the byte-identity layers are the check) |
| **HCz** STS2 acceptance | MX's legs (menu, map, combat; on−off main-thread ms; one GSW viewer, /11, coding on) | target: combat ≤ 3 ms, map and menu ≤ 1 ms | on−off main-thread ms per scene from `/proc` ticks; fidelity dB unchanged against W11c; wire within 2 % of MX | none in game |

HC1 can land now (PM1, which edited the same mirror and encoder, has landed). HC2 and HC3 are independent of each other. HC4a needs HC2; HC4b
needs HC4a; HC5 is easiest after HC4b, because its jobs need immutable inputs.

## Not proven here

- The STS2 per-scene split after each increment: the projection scales fixture shares to MX's
  totals. HCz measures it.
- Whether the formation thread shifts window 1's phase lock (G6c, G7r); a timing question for the
  milestone sweep.
- The writer thread's share once store bookkeeping is incremental: it was 0.05–0.23 ms a frame on
  the fixture, off the main thread already.
