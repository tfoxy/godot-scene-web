# P3-CAP: the capture's per-frame cost at STS2 scale (2026-10-25)

**The armed STS2 seat now holds 60 fps on the menu, the map and in combat, where it ran at 21–54
fps.** C3's gap 6 measured a 25 ms frame callback, 11 ms of it the snapshot. The profile put most of
that in three places:

- copying every material's parameters every frame (STS2's 561 materials carry 23,749 of them);
- walking the mirror's node-based tables several times per snapshot;
- writing every new mesh payload to the resource store on the frame callback.

The fix is wire-neutral. Recordings and the store are byte-identical to `main`'s for the same input:
every record, payload file and index line, apart from the session/stream ids and timing stats that
always differ.

On the STS2 a8 leg (C3's harness, same route and disarm frame as `a8-2`), the frame callback went
from 19.3–24.9 ms to **6.4–6.7 ms** (mean, whole session), and the snapshot from 9.5–11.3 ms to
**2.7–3.3 ms**. In combat, the capture's share of a frame fell from 22 ms to about 7–8 ms.

## Method

- **Timers.** The capture's own `evidence/perf.json` histograms (`frame_callback_us`,
  `snapshot_us`, `frame_interval_us`) give the totals.
- **Profiles.** `perf record -g` (frame pointers; `perf_event_paranoid` 1, so no sysctl change)
  gives the attribution. It was attached by pid to the game, and wrapped around the fixture. Shares
  below are of the main thread's samples in a steady window, converted to ms with that window's
  frame time. `libstdc++` and `libc` have no frame pointers, so a leaf in them is charged to its
  caller's caller; `std::_Rb_tree_increment` under `mirror_snapshot` is snapshot time.
- **Game legs.** C3's harness (`run-leg.sh`, mode a8, route menu, map, combat,
  `LEG_DISARM_FRAMES=5000`). Each ran under `live-qa-lock.mjs with --resource
  exclusive:game:p3-sts2` (plus `shared:install` and `exclusive:port:13767`), and inside the GSW
  quiet lock held exclusive, so no GSW work ran beside it. A private copy of the harness
  (scratchpad `p3cap-harness/`) adds only a `P3CAP_PERF` hook that attaches `perf record -p` to the
  game pid and stops it before teardown. Every leg ended `survivors: none`, and the five hash sets
  were unchanged.
- **Fixture.** `fixtures/capture-scale` is a stock-template scene with STS2 combat's shape (its
  README has the table), run by the new `scripts/bench-capture-scale.sh`: headless, `--max-fps 60`,
  real time, the quiet lock exclusive per leg, unarmed and then armed. Without its 64 parameters per
  material, the fixture measured only 1.8 ms of snapshot. With them it reproduced STS2's profile
  shape (8.6 ms snapshot, 20 ms callback, 47 fps).
- **Load.** Real-time legs ran at load averages of 1–3.6 (`uptime`). The other P3 agents' Node
  processes, outside the quiet lock, took about 2 cores during the later fixture benches.

## Top costs before (STS2 a8, combat, 25 fps, 40 ms frames)

| cost | share of main thread | ms per frame |
| ---- | -------------------- | ------------ |
| frame callback (`on_frame`) | 55 % | 22 |
| - snapshot (`Mirror::snapshot` with its map walks) | 24 % | 9.8 |
| -- material parameter copies (`wire_material`, in the table and again per item in `material_unsupported`) | 8 % | 3.2 |
| -- `std::map` iteration (items 4,196, textures 1,573, materials' 23,749 parameter nodes; several walks) | ~10 % | ~4 |
| -- parent-chain walks for unknown-item skip (`is_withheld`), tie groups, item copies | 3 % | 1.2 |
| - store writes: one file per new mesh payload (open, write, close, rename, index append), ~70 per frame | 15 % | 5.9 |
| - `make_patch` (12 node-based maps and sets per frame, every entry compared) | 4.8 % | 1.9 |
| - releasing the previous snapshot (`Snapshot` move-assign) | 3.1 % | 1.2 |
| - encode and file write of the patch transaction | 1.7 % | 0.7 |
| - evidence log drain (`resources.jsonl`, harness only) | 1 % | 0.4 |
| hooks outside the callback (mesh region copy and hash, about 150 per frame; log lines) | 4.1 % | 1.6 |
| NVIDIA driver spin (`clock_gettime` under `libnvidia-glcore`) | 25 % | 10 |
| the game | ~16 % | ~6 |

The other candidates the brief named were small:

- **Hashing.** SHA-NI SHA-256 of a mesh payload costs about 0.6 µs. All mesh hook work, copies
  included, was 0.8 ms per frame.
- **Mesh payload copies.** Part of the same 0.8 ms.
- **Publication lock.** Under 1 %. The mirror mutex is held for the snapshot, so it shrank with it.
- **Texture table walk.** About 0.2 ms of `wire_entry` per frame.

C3's hypothesis, "the snapshot copies whole resource tables", held for the material table, where the
parameters dominate, and not for the texture table. The late-arm contrast came from 7x fewer
materials, not from 16x fewer textures.

## Fixes (capture C++, no wire change)

1. **Shared, cached material parameters.**
   - `MaterialEntry::params` is now a `rs2::SharedVector<Param>`: an immutable, shared sequence with
     `std::vector`'s read interface and copy-on-write mutation.
   - The mirror rebuilds a material's published parameters (plus its first unsupported-parameter
     reason and its rid texture ids) only when the material's `version` moves. Every parameter
     change bumps it: `material_set_param` is the only writer, and adoption goes through it.
   - A snapshot, a patch comparison (pointer-equal shortcut) and a release then cost O(1) per
     unchanged material.
   - `material_unsupported` reads the cache instead of building the entry, once per material per
     snapshot (memo), not once per item.
2. **Fewer table walks.**
   - One walk of the items does the tombstone references, the item-level entries and the published
     items (it was four).
   - The diffuse references join the first texture walk.
   - Unknown-item skip walks no parent chains when no item has an unknown parent.
   - `find_ties` returns at fewer than two children and sorts a vector instead of building a map.
   - The item-level distinct-pair check scans only the current item's entries (it scanned all, which
     is quadratic).
3. **`make_patch` on sorted id vectors.** `IdIndex` keeps `std::map`'s semantics (last duplicate
   wins, ascending removals) with one allocation per table instead of 12 trees per frame.
4. **File I/O off the frame callback.**
   - `rs::FileWriter` (`capture/src/rs_file_writer.h`) is one thread per stream for the patch and
     full sinks and the resource store.
   - The publisher decides everything on the callback as before: new hashes, index lines, the
     wrong-hash corruption, record bytes. Only the I/O is queued, strictly FIFO.
   - So a payload is on disk before any record naming it, and the bytes are the synchronous ones.
   - A failed write is sticky and ends the stream at the next publication (one later than before).
   - The queue is bounded (256 MiB) and blocks the producer rather than dropping.
   - `GRC_FILE_WRITER=sync` restores the old path. The store's hash set became an `unordered_set`:
     a long session holds 350k mesh hashes.
5. **Budget accounting without map copies.** `payload_union_bytes` and
   `ServedResources::retained_bytes_beyond` replace copying the snapshot's, the pinned and the
   served maps into one every frame.

## Results

### STS2 a8 leg (real time; C3's harness and route)

| | control (`control-1`, C3) | before (`a8-2`, C3) | before (`p3cap-base-1`) | after (`p3cap-final-1`) |
| - | - | - | - | - |
| library | none | `34410516…` (main) | `34410516…` (main) | `2e70dd6b…` (this branch) |
| fps menu / map / combat (shots) | 59–60 / 60 / 60 | 41–44 / 39–40 / 21–22 | 48–54 / 46–48 / 24–25 | 60 / 60 / 50–54 |
| frame callback mean / p50 / p95 (ms) | — | 24.9 / 24.6 / 31.7 | 19.3 / 21.5 / 25.6 | 6.4 / 6.7 / 9.2 |
| snapshot mean / p50 / p95 (ms) | — | 11.3 / 11.3 / 14.3 | 9.5 / 9.7 / 11.8 | 3.3 / 3.3 / 4.9 |
| 5,000-frame disarm reached | — | — | 182 s after launch | 103 s after launch |
| CPU cores menu / map / combat | 0.41 / 0.50 / 0.55 | 1.05 / 1.05 / 0.98 | 1.05 / 1.03 / 1.03 | 0.77 / 0.82 / 1.38 |
| RSS menu / map / combat (GB) | 1.64 / 1.75 / 1.77 | 2.46 / 2.60 / 2.73 | 2.45 / 2.65 / 2.77 | 2.41 / 2.59 / 2.70 |

The after leg ran at load 3.6–4.3 (`uptime`; other agents' headless Chromium GPU processes shared
the GPU). An intermediate build (`p3cap-new1-1`, at load 1–2: fixes 1, 3, 4 and the first part of 2)
held 60 / 60 / 60 fps on the same route. Its callback was 6.7 / 6.4 / 13.3 ms (mean / p50 / p95),
its snapshot 3.1 / 2.7 / 6.4 ms, and it reached the disarm frame 106 s after launch. The capture's
per-frame cost is the same in both runs, within noise. In the after leg, the combat frame's
shortfall from 60 fps sits in the NVIDIA driver's spin-wait (`clock_gettime` under
`libnvidia-glcore`: 24 % of the main thread, against 23 % at 60 fps in `p3cap-new1-1`), not in
capture work.

CPU per second rose in combat, because the seat draws 50–60 frames a second instead of 25. Per
frame, the whole process uses about 26 ms of CPU in combat, against 41 ms before and 9 ms unarmed.
That includes the writer thread (0.3 cores) and the driver's spin.

**RSS is unchanged:** +0.9–1.0 GB over control, the retained decoded payloads (C3: "close to the
0.96 GB retained resource store"). This increment does not address it; see "What remains".

### Fixture (`bench-capture-scale.sh`, real time, load 3.3–3.6)

| mode | build | armed fps (unarmed 60.0) | callback p50 / p95 (ms) | snapshot p50 (ms) | cores (unarmed 0.02) | RSS max (GB, unarmed 0.96) |
| ---- | ----- | ------------------------ | ----------------------- | ----------------- | -------------------- | -------------------------- |
| file (C3's a8 config) | main | 39.0 | 22.5 / 26.6 | 10.2 | 1.00 | 1.91 |
| file | this | 59.9 | 6.1 / 8.2 | 2.4 | 0.83 | 1.90 |
| live, no subscriber | main | 49.3 | 16.4 / 22.5 | 10.8 | 1.00 | 1.87 |
| live, no subscriber | this | 60.0 | 3.3 / 4.6 | 1.7 | 0.31 | 1.87 |

The live mode is the streaming seat's own path (no file sink, no store). With a subscriber the host
adds a diff and an encode per sent transaction. The native headless receiver could not keep up at
this scale (about 3 s of credit round trip per transaction, fetching each new mesh payload; C3's gap
7 territory), so no subscribed live number is given here.

## What remains (after-profile, STS2 combat at 60 fps, 16.7 ms frames)

| cost | share of main thread | ms per frame (52 fps) |
| ---- | -------------------- | --------------------- |
| frame callback | 42 % | 8.2 |
| - snapshot | 20 % | 3.9 |
| -- `std::map` walks (items x2, textures x3, materials, shaders) | ~8 % | ~1.6 |
| -- item copies, texture entries, tie groups | 5.6 % | 1.1 |
| - publish (patch diff 0.8, store bookkeeping 0.9, encode and queue 0.5, previous-snapshot release 0.4) | 16 % | 3.0 |
| - evidence log (`resources.jsonl`; the C3 harness sets `GRC_EVIDENCE_DIR`, the product does not) | ~5 % | ~1.0 |
| - adoption's pending-material pass, rerun on every frame because the game re-sets 77 materials a frame | 3 % | 0.6 |
| hooks outside the callback (mesh region copy and hash, `set_material`, log lines) | 8 % | 1.6 |
| NVIDIA driver spin-wait | 24 % | 4.6 |

The writer thread takes 0.3 cores for the store's file creates and renames, about 70 a frame.

Larger wins would need more than this increment, so they are designed here and not built:

- **Dirty-set publication** (capture only, no wire change). The mirror would record which ids each
  call touched. It would publish a patch from that set, and keep a persistent published state whose
  entries are shared (`SharedVector`-style) instead of copied. That needs shared item and texture
  entries in `rs2::Snapshot`, a type change across the codec, the diff, the live hub and about 180
  test references. It would take the snapshot and the diff from O(table) to O(changes).
- **Mesh churn** (config now, wire later).
  - Each animated skeleton frame is a new content-addressed GRM1 payload, and so a store file or a
    served payload plus an HTTP GET (C3: about 1,700 per second, 1.22x zstd).
  - Today's lever is config: `GRC_RESOURCE_INLINE_MAX_BYTES=1024` sends the ~565-byte meshes as
    inline resource records. That removes the store writes and the GETs, and changes no wire
    version.
  - The wire-level fix is a versioned delta: a dynamic mesh's changed vertex and attribute regions
    as an inline block naming the base payload hash. That would need a `/10` mesh-update record in
    `render-stream-4.md`'s mesh table, receiver support, and a fallback to whole payloads at a
    keyframe interval. It is out of scope here.
- **RSS.** The host keeps every retained payload's bytes in memory: 0.96 GB of decoded textures for
  STS2. With a file sink, a stored payload could be released and re-read from the store on demand.
  Live, it could be re-read from the engine (`texture_2d_get`) on a GET. Either is a capture-only
  change with a latency cost on a cold GET.

## Byte identity

- **Gate legs.** The same legs ran with `main`'s library (`34410516…`) and with this branch's,
  sabotage legs included. Every recording and every `resources.jsonl` were compared record by
  record and line by line (`cmp-rec.ts`, as G8kw, G8sha and G8r did). They are equal apart from
  session/stream ids and timing fields:

  | gate (groups) | files compared | result |
  | ------------- | -------------- | ------ |
  | 1 (g1a, g1b) | 43 | equal |
  | 2 (g2a, g2b, g2d) | 57 | 55 equal; `live-inline`'s live tap and received stream differ in record count (966 against 962), as live streams do run to run with credit timing; that leg's host file recordings are equal |
  | 3 (g3a) | 5 | equal |
  | 5 (g5c, g5e) | 26 | equal |
  | 5.5 (g55c, g55d) | 40 | equal |
  | 8 (g8m, g8a, g8t) | 85 | equal |

- **Fixture.** `capture-scale` ran 300 frames with synchronous texture workers and 64x48 textures,
  so the run is deterministic. It produced 302 records: 300 byte-identical, 2 different only in
  volatile fields. Its store (23,534 files and `index.jsonl`) is identical (`diff -r`). The same
  holds for `GRC_FILE_WRITER=sync` against the writer thread. The recording carries 53,400
  unsupported-material, 2,400 unsupported-texture and 300 draw-index-tie entries, so the merged
  item walk is exercised.
- **Goldens.** `golden-2/` to `golden-9/` and the window-1 transcripts are untouched, and their
  ctests pass.
- **New ctests.**
  - `rs_publish_test` `test_file_writer`: file sinks and a store through the writer equal the
    synchronous ones, wrong-hash corruption included. Tasks run FIFO under a 16-byte bound. A
    failure is sticky. A failed store write fails the next publication.
  - `rs2_diff_test`: `make_patch` on unsorted tables with a repeated id; `SharedVector` copy,
    divergence and compare.
  - `rs_mirror_test` `test_material_params_shared`: an unchanged material shares, a set rebuilds,
    and the unsupported-material entry follows.

## Validation

- **Remote full tier, before the rebase**
  ([run 40190574738](https://github.com/tfoxy/godot-scene-web/actions/runs/40190574738)): 20 of 21
  runs pass. That covers pure, the capture build with its 30 ctests, the four cargo crates,
  pnpm-test, bench-instr (every case within 1 %), native gates −1, 0, 1, 2, 3, 4, 5, 5.5 and 8 with
  sabotage legs, and g7 on gsw and web-rust. The one failure was `g7live-web-rust@g7-5`:
  `live-mesh step 9: no shot`, the hosted-runner no-shot flake.
- **Remote, after rebasing onto `c780d463`** (P3-CT's receiver fix and its gate 8 group `g8c`):
  `native-rust-gate8` (with `g8c`) and `g7live-web-rust` both pass
  ([run 40194661333](https://github.com/tfoxy/godot-scene-web/actions/runs/40194661333)). P3-CT
  changed no capture file, so the identity runs above stand.
- **Local runs the remote refuses**: `lock-tests` passes. `g7live-gsw` and `g7live-web-rust` group
  g7-1 pass (`RS_VALIDATE_GROUPS=g7-1`, full tier).
- **Timing.** The timing groups were not run (see below).


The diff reaches every native gate (it is shared capture code), so the timing groups it reaches are:

- gate 6 (all of its timing groups);
- g1c's rate legs, g1d, g2c's pins, g5f and g55f;
- gate 7's `g7live-*-timing` runs and g7x.

They are left to the milestone sweep, as the brief asks. `bench-capture-scale.sh` is a new timing
measurement too. It is not a tier target (smoke-map rule: it reaches `pure` only, through its
self-test).

## Deviations

- **Fixture location and check.** The fixture is `fixtures/capture-scale`, not a `gate*/` one, and
  its check is a bench script with a pure self-test, not a gate group. A timing leg belongs to the
  milestone sweep, and a new gate group would have added a sweep run for a measurement that is not
  a gate criterion. Its verdicts are:
  - armed fps ≥ 0.95x unarmed;
  - callback p50 ≤ 8 ms.

  `main`'s capture fails both on this fixture (39 fps, 22.5 ms), and this branch passes both.
- **Fixes 2–5 go beyond the brief's three "likely shapes".**
  - The incremental snapshot was done for the dominant table (materials) and by cutting walks, not
    as a full dirty-set snapshot (designed above).
  - Mesh hashing was not moved to the texture workers: it measured 0.8 ms per frame.
  - Per-frame allocation fell as a side effect: the parameter copies and the patch's maps.

## Evidence

- Repository (ignored), `artifacts/render-stream/p3/p3-cap/`:
  - `bench/` holds the four bench runs' JSONs;
  - `ident/` holds `cmp-rec.ts`'s output per gate;
  - `profiles/` holds the folded main-thread profiles, before and after;
  - `sts2/` holds the three game legs' `perf.json`, `/proc` samples, steps and notes, with
    `summary.jsonl` (the table above, control and `a8-2` included);
  - `tools/` holds the scripts: the fold script, the summary script, the identity runner and the
    harness copy with its perf hook.
- `artifacts/render-stream/p3/p3-cap-perf/*.perf.data` holds the raw game profiles.
- Game legs: sts2-couch-coop's ignored `.sts2/research/render-stream-p3-20261025/c3/legs/`
  (`p3cap-base-1`, `p3cap-new1-1`, `p3cap-final-1`). Each has `notes.txt` (`survivors: none`) and
  its hashes in `hashes/compare-p3cap-*.txt` (all unchanged).
