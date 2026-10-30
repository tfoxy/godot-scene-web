# PH2: the second phone-throughput pass for the live client (2026-10-29)

MRA (ed671b61, [mra.md](mra.md)) left the moto g31 at 41.3 distinct applies/s on PHN's leg 1
(capture-scale `/12`, credit window 2, W11t `zstd-base`, 180 s), with a 17.1 ms frame p95 and the
main thread 88% busy. No single function dominated. MRA's profile ranked the record SHA-256 first,
then `Applier::cull`, allocator churn and the mesh-body SHA-256s.

PH2 removes or shrinks each of those, plus three more costs that the phone profiles turned up after
each step. All of them sit in rs-core, the GSW adapter (`rs-gsw-wasm`), the GL executor and the
client package. Equality is proven by a new two-pipeline differential over the kept recordings
(the harness configuration against the client configuration), with a sabotage per new skip rule.

**Headline.**

- **The bar is not met.** On PHN's leg 1 the g31 draws **45.4 distinct applies/s** (before:
  41.4 on this base). The frame p95 holds at 17.2 ms. The credit RTT is 27.1 / 42.0 ms at
  p50 / p95 (before: 32.3 / 45.1). At `/13` the same leg gives 45.6/s.
- **The main thread is no longer the limit.** It went from 88% busy to 73% busy (idle
  12% → 27%). The per-transaction work dropped by about a third on the phone (rAF callback
  p50 8.5 → 6.6 ms, `onmessage` p50 7.3 → 5.2 ms). Natively, capture-scale stopped
  re-walking (170 of 540 transactions before, none after) and allocates a third as often. Native
  timings moved 2× with the machine's load during this session, so the phone is the measure.
- **What limits the rate now is the credit loop's latency, and the phone's governor.**
  - At window 2 the host can sustain 60/s only while a transaction's credit returns within two host
    frames (33.3 ms).
  - The g31's RTT is (send → `received`) + (`received` → `applied`) + (`applied` → `submitted`):
    15.4 + 8.3 + 2.6 ms at p50 in L2.
  - The middle term includes the wait for the next vsync, up to 17 ms by construction.
  - Before PH2, 44% of RTTs exceeded 33.3 ms; after it, 22%.
  - As the work fell, schedutil lowered the A75's mean clock from 1.91 to ~1.59 GHz in the measured
    windows, so each millisecond of work saved returned less than a millisecond of latency.

## What changed

### 1. No record digest in the client (`DigestPolicy::Never`, `"digest":"none"`)

- **rs-core.** `validate::DigestPolicy` gains `Never`: `accept` records `None` for every record,
  and nothing fills it. Every check stays:
  - the resource payload hash (`resource-hash`), still SHA-256, since it is compared with the
    host's declared hash;
  - the seq and base rules, W11t's checksum (XXH64) and `/13`'s `predict-check`.
- **Body digests.** The dynamic mesh body and multimesh buffer digests are state identity: no-op
  detection, `mesh-version` and `multimesh-version` compare them with each other, never with a
  host's value. So under `Never` they stay, but as a cheaper 256-bit identity (`fast_identity`):
  two XXH64 lanes seeded apart, the length, and a tag. The harness policies keep SHA-256.
- **`rs-gsw-wasm`.** `"digest":"none"` selects `Never`, even in live mode, where `inline` was
  forced before. Under it:
  - `digest()` owes nothing;
  - `last_digest_ptr` stays zeros;
  - the `dynamic-applied` evidence (a SHA-256 comparison) is skipped.
- **The client package.** `@godot-scene-web/render-stream-client` builds its core options in
  `coreStartOptions(protocol)` (`hello.ts`), which sends `digest: "none"`. Nothing in the package
  read a digest. The harness receiver still sends `inline`, so its checks keep reading digests.

On the phone this removes the record SHA-256: 8.5% of the main thread in L0. The mesh-body
SHA-256 (3.0%) becomes XXH64, at about a third of its cost.

### 2. `Applier::cull` stops re-walking for moves on and off screen (parked attach entries)

Natively on capture-scale, 170 of 540 transactions re-walked the whole tree (`Why::MOVE_FALLBACK`).
A mover's subtree took an item on or off screen, and that changes the attach list, so the rows-only
move path gave up.

- **Parked entries.** A walk with no canvas group or back-buffer copy in the state now *parks*
  each off-screen item that would draw: it attaches the item at its place in the walk order, with
  `parked` set. `assemble` skips parked entries as if they were not attached, which is Godot's rule
  (renderer_canvas_cull.cpp:247).
- **A move.** When a move takes an item on or off screen, `move_rec` flips the item's entry in place
  (`emit`/`parked`) and the transaction re-assembles (`Why::MOVE_ATTACH`) instead of re-walking.
  The entry's index is recorded per walk (`ItemRec::attach_at`).
- **What still walks.** A clip or alpha-cut change still falls back to the walk. With a group or
  copy in the state, every apply walks, as before.
- **Oracle and sabotage.** `Applier::move_walks` is the oracle: no parking, a re-walk as before
  PH2. The sabotage `park_stale` (`ph2-park-stale`) moves the item but leaves its entry unflipped.

### 3. Dependency re-lowering follows the change (`DepIndex`)

When a mesh, multimesh or particles entry changed, or a resident texture resized, every apply
scanned **every** item for stale dependencies. On capture-scale that is 4,200 items a frame, because
76 meshes change every frame: 262 µs natively, and on the phone the `Map::next` inlined in
`Applier::apply` took 4.5%.

- **The index.** `DepIndex` lists each item under every texture and mesh its installed lowering
  reads, and under `instanced` when it reads a multimesh or particles.
- **The pass.** It visits the dependents of the textures that were resized, upserted or removed, and
  of the meshes that were upserted, removed or re-synced. It adds every instanced item when any
  mesh, multimesh, particles or membership changed. Each visited item gets the same test as
  the full scan.
- **Exactness.** A texture upserted or removed while the pass did not run is kept in `pending_tex`,
  because the full scan would have compared its size at the next pass. Listings are never removed,
  so a listing can be stale but never missing. The index rebuilds itself when stale listings
  outgrow the live ones.
- **Oracle and sabotage.** `Applier::always_scan_dependencies` is the oracle; `skip_dep_textures`
  (`ph2-skip-dep-texture`) is the sabotage.

### 4. Named materials' textures (`Names::update`)

Every transaction that upserted any material re-built the named materials' texture set. That means
every named material's every parameter: capture-scale's 560 × 66 a frame, since 8 materials change
every frame.

When a transaction only upserts materials (no naming, removal, shader or particles change), the set
can change only through what those materials name. `Names` now keeps each contributing material's
textures, and re-builds only when an upserted one names other textures than before.

- `always_rebuild_materials` is the oracle;
- `skip_material_rebuild` (`ph2-skip-material-textures`) is the sabotage.

### 5. Allocator churn on the per-transaction path

Natively, capture-scale allocated ~3,300 times a transaction. It now allocates ~1,100
(`rs-core-check profile --clock allocs`, new: every phase in allocations):

| phase | before | after | what |
| --- | ---: | ---: | --- |
| meta | 596 | 76 | the fast parser takes the previous transaction's parameter name at the same position when it is the same (`TxMeta::name_spare`) |
| resolve | 710 | 174 | a material resolves into a recycled entry (`Validator::material_pool`, like `item_pool`), reusing its parameter names and floats |
| post checks | 646 | 34 | `last_mesh` / `last_material` are overwritten in place (`Mesh::assign_from`, `Material::assign_from`) instead of cloned |
| payload decode | 456 | 0 | a dynamic body decodes into a replaced geometry's buffers (`mesh_geometry_reusing`, `DynamicMeshes::spare`) |
| prepare | 58 | 16 | (Names, above) |
| mesh sync | 559 | 559 | not changed: the evidence rows (`MeshUpload`) allocate; the per-mesh temporaries are gone |

### 6. The GL executor's binding upload (`CanvasItemsExecutor::draw`)

A binding upload looked up each of the binding's uniforms by name in a `HashMap<String, _>`
(SipHash). Capture-scale's shader declares 65 uniforms, of which the compiler keeps one. That
was 5.2% of the phone's thread (L0, `sip::Hasher::write`).

Each compiled program now keeps a plan: its active uniforms by position in the binding's list.
Every binding of a program lists the program's declared uniforms in the same order, so one plan
serves them all. The plan is checked by the list's length and the planned names, and re-planned
when they differ. An upload then touches only the active uniforms.

A first version kept a per-position name for *every* declared uniform. That made the executor
slower (L1: 8.2% self, byte-loop name compares). The final plan (L2) brings it to 1.5%.

This is `packages/canvas/rust-prototype`, a Rust crate that the npm package does not ship (its
`files` are `dist` and `LICENSE`).

## Equality

`rs-core-check client-diff <recording>... --store <dir> [--sabotage …]` (new) replays each
recording through two whole pipelines in lockstep. Each pipeline has its own validator, payload
store and applier:

- **harness:** `DigestPolicy::Inline`, plus the oracles: `always_scan_dependencies`, `move_walks`
  and `Names::always_rebuild_materials`;
- **client:** `DigestPolicy::Never` and the new paths.

After every transaction it compares:

- the accept result, and that a refusal carries the same code on both sides;
- the validator's delta and its `pruned`/`released` lists;
- the needed (fetch) list in order;
- the material counters and residency;
- the paint digest;
- the stats less their timings, `why`, `structural` and `reassembled`. The assembly's own counters
  are compared only when both sides assembled, because a parked move re-assembles, or does
  nothing, where the oracle re-walks;
- the upserted meshes' and multimeshes' body identities: the client's must change exactly when the
  harness's SHA-256 does, with every other surface field equal;
- at the end, that the harness digested every record and the client none.

| recording | transactions | honest | sabotage |
| --- | ---: | --- | --- |
| `pm7-a12-1` (/12) | 4,955 | 0 mismatching | `ph2-skip-body-digest`: **4,189 mismatching** (`body-digests`) |
| `pm-a11-1` (/11) | 4,947 | 0 mismatching | — |
| `late-1` (/8, late join) | 1,784 (1 parked move; the oracle re-walks 7) | 0 mismatching | `ph2-park-stale`: **49 mismatching** (paint, stats) |
| capture-scale `/12` (600 frames, recorded here) | 600 (75 parked moves; the oracle re-walks 188) | 0 mismatching | `ph2-park-stale`: **186 mismatching** (paint, stats) |

No kept recording resizes a drawn texture, or changes a named material's texture parameters,
during the stream. So `ph2-skip-dep-texture` and `ph2-skip-material-textures` find nothing there
(0 mismatching, shown in the evidence). They are proven by new randomized rs-core tests instead:

- `ph2_dependency_index_equals_full_scan`: 300 runs × 80 steps of resizes (resident and not),
  re-pointed, added and removed items, and removed and returning textures;
- `ph2_named_material_textures_fast_path_equals_rebuild`: 300 × 120 steps of material texture,
  status and shader changes, naming and un-naming, shader default changes and removals.

Each sabotage must fail at least 45 of 50 runs (`ph2_skip_dep_texture_sabotage_is_caught`,
`ph2_skip_material_textures_sabotage_is_caught`). The existing test
`custom_rect_off_screen_hides_on_screen_content_and_moving_on_screen_rewalks` became
`…_reassembles`: it checks the parked flip both ways, and the re-walk under `move_walks`.

## g31: PHN's leg 1

The command is phn.md's, through `artifacts/render-stream/p3/ph2/tools/ph2-leg.sh`, which is
mra-leg.sh with its load gate. All legs ran in real time under the bench's exclusive lock, with
the phone on USB at 100% battery and thermal status `none` before and after every leg.

- **L0** is this base (9a3d687d) with the client sending `inline`. Its core held only the new
  `DigestPolicy::Never` variant, which is inert under `inline`.
- **L1** has items 1–3, item 5's parser, resolve and post-check reuse, and the first executor plan.
- **L2** adds the active-uniform executor plan and the XXH64 body identity.
- **L3** is the final tree. It adds the named materials' fast path, the dynamic-body buffer reuse
  and the mesh-sync temporaries, on main 1e9ed59a (HSD, capture only).
- **L13** is L3 against a `/13` host.

| | L0 (before) | L1 | L2 | **L3 (final, /12)** | L13 (final, /13) |
| --- | ---: | ---: | ---: | ---: | ---: |
| distinct applies/s, host tap (bar ≥ 58) | 41.4 | 44.8 | 45.7 | **45.4** | 45.6 |
| applies/s, page (folds included) | 44.6 | 47.2 | 48.1 | 47.8 | 48.3 |
| credit RTT p50 / p95, host tap | 32.3 / 45.1 | 28.6 / 42.0 | 27.1 / 41.7 | 27.1 / 42.0 | 27.0 / 41.5 |
| RTTs over 33.3 ms (two host frames) | 44% | 25% | 23% | 22% | 22% |
| latency p50 / p95, host tap | 28.2 / 41.3 | 24.1 / 37.4 | 24.1 / 38.6 | 24.1 / 39.0 | 23.9 / 38.5 |
| rAF rate; frame interval p50 / p95 | 58.1; 17.0 / 17.1 | 57.8; 17.0 / 17.1 | 57.0; 17.0 / 17.1 | 56.9; 17.0 / 17.2 | 56.8; 17.0 / 17.2 |
| rAF callback p50 / p95 (busy ms/s) | 8.5 / 14.1 (405) | 7.7 / 11.6 (346) | 6.6 / 10.6 (306) | 6.6 / 11.1 (313) | 6.6 / 10.6 (310) |
| `onmessage` p50 / p95 (busy ms/s) | 7.3 / 11.6 (365) | 5.9 / 11.6 (322) | 5.7 / 12.0 (319) | 5.2 / 11.3 (294) | 5.4 / 12.3 (314) |
| idle in the CPU profile | 12% | 21% | 26% | 27% | 28% |
| A75 mean clock in the window (12 samples) | 1.91 GHz | 1.59 | 1.59 | 1.49 | 1.52 |
| wasm heap; renderer PSS streaming | 322.7; 431.8 | 325.6; 424.2 | 325.4; 424.6 | 325.6; 432.0 | 331.5; 437.4 |
| first frame after `mount()` | 13.27 s | 13.12 s | 13.18 s | 13.13 s | 13.29 s |
| battery temperature | 28.0 → 29.6 °C | 28.4 → 29.9 | 28.8 → 30.0 | 28.1 → 29.5 | 28.5 → 29.9 |
| machine load (1 min) at driver start / end | 2.50 / 1.73 | 4.19 / 2.36 | 3.16 / 3.72 | 3.95 / 7.17 | 3.38 / 4.32 |

All five gating driver checks pass on L3 and L13 (`mounts-streamed` 4/4, `instance-released`, `remount-no-growth` at 84.4–84.9 MiB after each dispose, `heap-baseline`, `device-provenance`); `rate-60` is reported failed, as in PHN and MRA. The bench's `update-rate` and `credit-rtt` pass on every leg. Remounts 2–4 of L3 applied 47.0 / 43.6 / 46.2/s (page). At `/13` the coded wire halves (240 KB/s against 507, a message 4.4 KB at p50 against 9.1) and the rate does not move: the phone is not transport-bound by bytes.

### The phone profile (10 s CPU profile at 500 µs, by entry point and by self time)

| | L0 | L2 | L3 |
| --- | ---: | ---: | ---: |
| `GswRs::live_accept` | 28% | 19% | 17% |
| `GswRs::apply` | 26% | 18% | 19% |
| `GswRs::draw` | 15% | 12% | 12% |
| zstd (ruzstd) | 7% | 11% | 11% |
| other JS / program | 13% | 14% | 14% |
| idle | 12% | 26% | 27% |
| self `sha2::compress256` | 11.5% | 0 | 0 |
| self `Applier::cull` | 6.0% | < 0.1% | < 0.1% |
| self `sip::Hasher::write` | 5.2% | 0.7% | 0.9% |
| self `dlmalloc` free + malloc | 5.7% | 3.5% | 2.5% |
| self `CanvasItemsExecutor::draw` | 4.3% | 1.5% | 1.5% |

L3's top self functions: `(program)` 8.6%, `texSubImage2D` 2.7%, `send` 2.3%, `Applier::apply` 2.3%, the three ruzstd decoders 5.4% together, `xxh64` 1.8% (W11t checksum and the body identity), `dlmalloc` 2.5%, `CanvasItemsExecutor::draw` 1.5%, `meta::fast::param` 1.5%.

## Remaining attribution: why 58 is not reached

1. **The window-2 credit loop at a 58.8 Hz panel.** For 60/s, each credit must return within two
   host frames. A g31 RTT is:
   - **transport and queueing:** 15.4 ms p50 from the host's send to the `received` ack. This
     includes zstd + accept (`onmessage`, 5.7 ms p50) and any wait behind a running rAF callback;
   - **the wait for vsync:** 0–17 ms;
   - **the rAF callback:** apply (~4 ms), then draw and the `submitted` ack (2.6 ms p50).

   The p95 stays above 33.3 ms (27.1 / 42.0). Every missed two-frame window costs a host frame. Halving
   the remaining per-transaction work would still leave the vsync wait. The levers beyond this
   increment are protocol or configuration, not core cost:
   - a credit window of 3 (`bench-live-scale.sh` accepts 1|2);
   - crediting at `applied` instead of `submitted` (the hello's `credit_stage`);
   - applying in `onmessage` when the rAF is far.
2. **DVFS.** schedutil follows utilization. As the work fell, the A75 ran ~17% slower on average
   (12 samples a window), which costs back part of each saving in latency. G7o4 measured the same
   effect at the frame level.
3. **What is left on the thread** (L3 by self time): ruzstd 5.4%, `(program)` 8.6%, `texSubImage2D` 2.7%, `send` 2.3%, `Applier::apply` 2.3%, `xxh64` 1.8%, `dlmalloc` 2.5%, nothing else above 1.5%. Of these:
   - zstd (ruzstd) is the largest single block, and the coded stream needs it;
   - `texSubImage2D` is the 76 dynamic meshes' vertex uploads;
   - `send` is three acks a transaction.

## Validation

`validate-increment.sh --plan` reaches everything: rs-core, the capi through the validator, every
native gate, both g7 receivers and the live groups. It runs the sabotage legs, because
`apply/mod.rs` and `apply/meshes.rs` name sabotages.

- **Crates and packages.**
  - `cargo test` in rs-core: 128 passed, 2 ignored, including the four new PH2 tests and the
    rewritten off-screen test.
  - `pnpm` tests of `packages/render-stream-client`: 44 passed, including the new
    `coreStartOptions` test.
  - `pnpm typecheck` and `pnpm typecheck:ts6` are clean.
- **Smoke tier** (local). A first smoke on base 9a3d687d was stopped for main's HSD landing
  (1e9ed59a, capture only: no shared file). After the rebase it passed:
  - pure (bar the load-sensitive `self-test-report`, which is known);
  - the three crates and `pnpm-test`;
  - native gates −1 and 0;
  - native gate 8, which HSD touched;
  - g7-gsw, g7-web-rust and the g7-1 live smokes on both.

  `bench-instr` exits 3 locally (no valgrind). The remaining native gates' smoke was cut for time;
  the remote full tier ran them.
- **Full tier, once, remotely** (`rv-20261029T225204Z-e08e86f-14681`, run 40969079345, base
  9a3d687d). 19 of 20 runs pass:
  - every native gate with its sabotage legs;
  - g7-gsw and g7-web-rust in every group;
  - the remote-capable live groups.

  `pnpm-test` failed on a hosted-runner race in `packages/html/test/fixtures.test.ts` (ENOENT on
  another test's temporary font file). It passed on rerun (`rv-20261030T003045Z-37cb374-11597`, run
  40980154598) and locally (2,582 tests). `bench-instr` is within its 1% threshold on every case
  (−0.91% to +0.76% Ir).
- **After main moved again** (W13d 3f116c47 and HC6 5a479927; one adjacent setter in
  `validate.rs` merged by hand). Rebased onto 5a479927:
  - `cargo test` in rs-core (128) and rs-core-capi pass;
  - the smoke runs `cargo-rs-core`, `cargo-rs-core-capi`, `cargo-gsw-rs`, native gate 0, g7-gsw and
    g7-web-rust pass.
- **Refused groups, locally at the full tier** (`RS_VALIDATE_GROUPS=g7-1 … --only
  g7live-gsw,g7live-web-rust`, rebased tree): `g7live-gsw` and `g7live-web-rust` g7-1, 11 legs
  each, both pass.
- **Timing runs** (native gate 6, the live timing runs, g7x) are deferred to the milestone sweep.
  The phone legs above are this increment's timing evidence.

## Deviations

- **Scope.** The brief named three steps: digests, cull and allocations. The phone profiles after
  each step showed three more costs of the same order, and PH2 fixed them as well, each with its
  own oracle and sabotage:
  - the dependency scan;
  - the named materials' texture rebuild;
  - the executor's per-uniform SipHash.
- **The mesh-body digests were not skipped.** They are state identity, which the `mesh-version`
  and `multimesh-version` checks and the delta's no-op detection need. The client keeps them as
  XXH64 identity, not SHA-256.
- **The /13 leg.** `bench-live-scale.sh` accepts `--protocol` 8–12. So L13 runs the bench at
  `--protocol 12` with `GRC_STREAM_VERSION=13` for the host, which overrides the bench's own
  setting, and the driver at `--protocol 13`.
- **L0 is not PHN's leg 1.** It is this base's tree with the client sending `inline`, so it
  includes HC5 and W13c. Its 41.4/s matches MRA's 41.3.
- **L0 ran without remounts.** L3 and L13 ran with them, as in PHN.

## Evidence

`artifacts/render-stream/p3/ph2/` (main checkout):

- `client-diff-*.txt`: the differential and its sabotages;
- `alloc-profile-*.txt`: the allocation counts by phase;
- `L0/`, `L1/`, `L2/`, `L3/` and `L13/`: each with `client-device.json`, `cpu-profile.json`,
  `bench-live-scale.json`, `result.json`, `launcher.out`, `scale-report.json` and the host tap
  (`live-1.jsonl`);
- `tools/`:
  - `ph2-leg.sh` (the leg wrapper);
  - `ph2-diff-run.sh`;
  - `ph2-rtt.py` (the RTT split from the tap's acks);
  - `ph2-self.py` and `ph2-under.py` (profile tables).

## Memory-worthy facts

- **On the g31, freeing the main thread lowers the clock.** As PH2's work fell, the A75's mean
  clock fell from 1.91 to ~1.59 GHz in the measured windows. Rate is latency-bound, so judge a
  phone change by its RTT split (send → `received` → `applied` → `submitted`, from the tap's acks:
  `tools/ph2-rtt.py`), not by idle time.
- **At window 2, 58/s needs nearly every credit RTT under 33.3 ms.** The vsync wait (0–17 ms) is in
  every RTT.
- **Recordings never resize a drawn texture or change a named material's texture parameters.** A
  sabotage of those paths finds nothing in `client-diff`; it needs a randomized unit test.
- **A per-uniform name compare is no cheaper than SipHash in wasm.** Both are byte loops. A
  positional plan over every declared uniform made the executor slower. Plan the active ones only.
- **`rs-core-check profile --clock allocs`** turns every phase into an allocation count, which
  points at the phase that churns.
