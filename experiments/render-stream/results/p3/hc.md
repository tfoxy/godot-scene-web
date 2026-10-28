# HC: where the host's capture time goes, and how to make it follow churn (2026-10-28)

**The capture's main-thread cost scales with the scene's tables, not with what changes.** On
`fixtures/capture-scale` (STS2 combat's shape) at /11 with one live viewer, a frame in which
**nothing at all changes** costs 3.7 ms of capture work (perf-attributed); STS2-like churn costs
7.5. Most of it is the snapshot walking and copying every item and every resource entry, then
the diff, record planning, serving and release walking them again:

- **Static cost, one viewer: 3.7 ms.** Snapshot 2.0 (4,200 `ItemState` copies with their
  commands, every texture, mesh, shader and material entry, the payload map rebuilt), diff 0.53,
  record planning 0.52, serving 0.28, release of the previous snapshot 0.24. The patch it encodes
  is empty: encode 0.01, zstd 0.03.
- **With no viewer at all, a live listener still costs 2.5 ms static** (3.4 ms of callback under
  churn): the listener snapshots every frame so its served set stays current.
- **The hooks cost 1.2 ms under churn, and more than half is the hook log formatting JSON lines
  that `GRC_HOOK_LOG=off` then throws away** (0.66 ms a frame, `ResourceLog::format`).
- **Viewers are cheap** thanks to P3-SP: 4 viewers cost 0.3 ms more than 1.

The design, `protocol/host-cost-design.md`, makes the published state persistent and shared
(dirty sets at hook time, chunked shared tables, pointer-equal diffs), stops formatting unread
log lines and hashing unread surfaces, takes no snapshot without a viewer, and can move per-(B, T)
formation to a thread. It projects STS2's warm combat from 9.0 ms to about **1.5–2.0 ms** after
HC1–HC4 (1.2–1.6 with HC5), and the static map and menu to 0.3–0.8 ms, all wire-byte-identical.

## Method

- **Fixture.** `fixtures/capture-scale` at its defaults (4,200 items in chains of 10, 700 RGBA8
  textures, 800 unsupported textures, 187 meshes, 560 materials with 64 parameters), stock 4.5.1
  release template, headless, `--max-fps 60`, 900 frames.
- **Armed config.** The bench's product hand-off environment plus `GRC_STREAM_VERSION=11`,
  `GRC_RESOURCE_INLINE_MAX_BYTES=4096` and `GRC_HOOK_LOG=off` (the product's settings). Live legs
  run with no tap (`GRC_LIVE_TAP_DIR=` empty), as MX did: a tap loads the timed host. The
  evidence directory stays set, because `perf.json` lives there; its `resources.jsonl` is not
  opened with the hook log off.
- **Scenes.**
  - *static*: `RS_SCALE_MESH_UPDATES=0 RS_SCALE_MOVERS=0 RS_SCALE_PARAM_UPDATES=0`: no
    RenderingServer call after setup.
  - *churn*: the defaults (76 mesh poses a frame, each with a vertex region, an attribute region,
    a custom AABB and a material re-set; 100 moving items; 8 parameter sets) plus
    `RS_SCALE_REDRAWS=170` (170 items cleared and re-recorded identically, WB's STS2 shape).
- **Viewer counts.**
  - *0*: `bench-capture-scale.sh --mode live` (a listener, nobody connects), and *no stream*
    (`GRC_LIVE_LISTEN=` empty: armed, no sink, no listener).
  - *1 and 4*: `bench-live-scale.sh --receiver null --protocol 11`. The null receiver now speaks
    /11 with `live_coding` (below), so the host runs W11t's base-prefix zstd as in the product.
  - *file*: `bench-capture-scale.sh --mode file`, a patch file sink and a store.
- **Profiles.** `perf record -g` on the armed host (999 Hz for `bench-capture-scale`, 499 Hz for
  `bench-live-scale`), then the new `scripts/perf-capture-split.py`: main thread only, an 8 s
  steady window before the end, each sample charged to the innermost capture function (or to the
  hook it runs under, or to the engine). Per-frame ms = samples / Hz / (8 s × 60 fps).
  Perf-wrapped legs are attribution, not rate numbers.
- **Real-time legs.** The same 9 configurations without perf, for the capture's own histograms
  (`frame_callback_us`, `snapshot_us`, `diff_us`, `encode_us`) and the process CPU on minus off.
- **Load.** The legs held the quiet lock exclusive per leg. Load averages were 2.9–9.9, from
  other agents' work outside the lock (W11z's game leg held the lock for 35 minutes before the
  first leg). The perf shares are what the design uses; absolute real-time ms vary with load.
- **No game launch.** The fixture reproduces MX's per-scene shape (callback, snapshot, diff), and
  W11z holds the STS2 lease for its acceptance legs. STS2 numbers below are MX's and P3-CAP's.

## The profile (perf, main thread, ms per frame)

`artifacts/render-stream/p3/hc/profile-table.json`; the per-leg splits are `split.json` beside each
`perf.data`.

| ms/frame (perf, 8 s steady window) | file, static | file, churn | live 0 viewers, static | live 0 viewers, churn | live 1 viewer, static | live 1 viewer, churn | live 4 viewers, static | live 4 viewers, churn |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| hooks: mesh region updates (vertex+attribute) | 0.00 | 0.78 | 0.00 | 1.00 | 0.00 | 0.62 | 0.00 | 0.67 |
| hooks: canvas_item_set_material | 0.00 | 0.14 | 0.00 | 0.18 | 0.00 | 0.18 | 0.00 | 0.12 |
| hooks: mesh_set_custom_aabb | 0.00 | 0.26 | 0.00 | 0.11 | 0.00 | 0.11 | 0.00 | 0.08 |
| hooks: all others | 0.01 | 0.43 | 0.00 | 0.34 | 0.02 | 0.35 | 0.01 | 0.39 |
| snapshot (mirror walk, entry copies, table entries) | 2.39 | 2.10 | 2.08 | 2.23 | 1.98 | 2.43 | 2.03 | 2.38 |
| cv digests (command JSON + SHA-256) | 0.00 | 0.18 | 0.00 | 0.19 | 0.00 | 0.22 | 0.00 | 0.20 |
| diff (make_patch) | 0.58 | 0.70 | 0.00 | 0.00 | 0.53 | 0.59 | 0.60 | 0.63 |
| record planning (inline names, payload refs) | 0.39 | 0.34 | 0.00 | 0.00 | 0.52 | 0.60 | 0.48 | 0.55 |
| encode (JSON and blocks) | 0.03 | 0.37 | 0.00 | 0.00 | 0.01 | 0.29 | 0.00 | 0.33 |
| zstd (live coding) | 0.00 | 0.00 | 0.00 | 0.00 | 0.03 | 0.34 | 0.00 | 0.38 |
| previous-snapshot release | 0.26 | 0.47 | 0.24 | 0.37 | 0.24 | 0.66 | 0.35 | 0.73 |
| store bookkeeping | 0.07 | 0.12 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 |
| serving: pin/retire/budget + serve-event lines | 0.00 | 0.00 | 0.16 | 0.55 | 0.28 | 0.71 | 0.22 | 0.74 |
| hub (per connection: restamp, send) | 0.00 | 0.00 | 0.00 | 0.00 | 0.11 | 0.35 | 0.12 | 0.54 |
| adoption, evidence, other capture | 0.00 | 0.04 | 0.00 | 0.03 | 0.00 | 0.01 | 0.00 | 0.03 |
| engine (game script, servers) | 0.08 | 0.67 | 0.07 | 0.59 | 0.08 | 0.60 | 0.11 | 0.67 |
| main thread total | 3.80 | 6.58 | 2.55 | 5.59 | 3.78 | 8.07 | 3.93 | 8.45 |
| capture total (main) | 3.72 | 5.92 | 2.48 | 5.00 | 3.70 | 7.47 | 3.82 | 7.78 |
| other threads (writer/IO) | 0.06 | 0.24 | 0.04 | 0.00 | 0.14 | 0.12 | 0.15 | 0.21 |

"Snapshot" includes the frame callback's own inlined lines (`mirror_snapshot` and the walks the
compiler folded into it). "Engine" is the fixture's GDScript making the calls. File legs' writer
thread and live legs' I/O thread are the last row, off the main thread.

**Hook cost per call** (churn, 1 viewer; calls per frame from the fixture's knobs):

| hook | calls / frame | ms / frame | µs / call |
| ---- | ------------: | ---------: | --------: |
| `mesh_surface_update_vertex_region` | 76 | 0.32 | 4.2 |
| `mesh_surface_update_attribute_region` | 76 | 0.31 | 4.0 |
| `canvas_item_set_material` (same material every frame) | 76 | 0.18 | 2.4 |
| `mesh_set_custom_aabb` | 76 | 0.11 | 1.5 |
| `canvas_item_set_transform` | 100 | 0.07 | 0.7 |
| `canvas_item_clear` | 170 | 0.09 | 0.5 |
| `canvas_item_add_rect` / `add_texture_rect` / `add_mesh` (re-records) | ~850 | 0.11 | 0.1 |
| `material_set_param` | 8 | 0.01 | 1.0 |

Inclusive across the leg: `ResourceLog::format` 0.66 ms a frame (hook-side 0.4, serve events
0.26), SHA-256 0.21 (half of it the /11 cv digests), the gate -1 census (`log_entry`) 0.013. The
armed host with no stream (no sink, no listener: the mirror is off, the hooks only count and keep
the census) costs 0.3 ms a frame of process CPU under churn and nothing static.

## Real-time legs

The capture's own histograms (ms; `bench-*.json` and `perf.json`), and for `bench-capture-scale`
legs the whole process's CPU, armed minus unarmed, per frame. The 1-minute load is the machine's
at the leg's start.

| leg | load | fps | callback mean | p50 | p95 | snapshot mean | diff mean | encode mean | process CPU on−off, ms/frame |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| no stream, static | 3.4 | 60.0 | 0.004 | | | | | | 0.03 |
| no stream, churn | 4.5 | 60.0 | 0.004 | | | | | | 0.32 |
| live 0 viewers, static | 5.1 | 60.0 | 3.53 | 3.20 | 4.86 | 2.86 | | | 3.45 |
| live 0 viewers, churn | 4.5 | 60.0 | 3.47 | 3.33 | 4.61 | 2.08 | | | 5.17 |
| file, static | 4.4 | 60.0 | 4.74 | 3.84 | 5.12 | 2.48 | | | 4.22 |
| file, churn (run 1) | 3.5 | 60.0 | 9.15 | 8.19 | 10.75 | 4.06 | | | 12.15 |
| file, churn (run 2) | 9.1 | 60.0 | 8.88 | 7.68 | 10.24 | 3.88 | | | 10.97 |
| live 1 viewer, static | 3.8 | 59.9 | 3.96 | 3.71 | 4.35 | 2.08 | 0.61 | 0.05 | |
| live 1 viewer, churn (run 1) | 2.9 | 59.9 | 6.07 | | | 2.09 | 0.78 | 0.33 | |
| live 1 viewer, churn (run 2) | 9.9 | 59.7 | 10.24 | 9.73 | 12.80 | 3.82 | 1.23 | 0.49 | |
| live 4 viewers, churn | 4.5 | 59.6 | 8.50 | 7.68 | 12.29 | 2.99 | 0.25 | 0.11 | |

(Run 1 of the 1-viewer churn leg was overwritten by its rerun; its mean figures are from the
first table pass.) The fixture held 60 fps in every leg: it does little else, so the capture has
headroom here that a game does not.

**Real time against perf.** The real-time callbacks are 1.0–1.8× the perf-wrapped legs' own
histograms for the same configuration (file churn: 8.9–9.2 ms against 5.0; the snapshot 3.9–4.1
against 1.9), at loads of 3.5 and 9. Load alone does not explain the file-churn gap, which held at
both. A likely cause is frequency scaling: a 60 fps-paced burst on an otherwise idle core runs at a
low clock, and perf's 1 kHz sampling keeps the core busier. HC did not chase it. The design uses
the perf **shares**, which both kinds of run agree on (snapshot about half of the callback; diff,
record planning, serving and release the rest), and HCz measures the result as MX did: main-thread
CPU on minus off, on the game.

## Answers

- **Is there cost with no viewer?** Yes. A live listener with no connection snapshots every frame
  (`stream_publish`: `serving` keeps the served set current, G2c2 D7), so it costs 2.5 ms static
  and 5.0 churn (perf), hooks included. The design's D6 removes it: no hello'd connection and no
  file sink, no snapshot.
- **Static cost and its cause.** 3.7 ms with one viewer, 2.5 with none, all of it O(table): the
  snapshot copies all 4,200 items with their command vectors (each `Command` holds a string and
  four vectors) and rebuilds the payload map and the name sets keyed by 64-character hex strings;
  the diff compares every entry; record planning builds two `std::set<std::string>` of every
  payload name; serving re-pins every payload; the previous snapshot's copies are freed. None of
  it depends on what changed.
- **Churn adds**: the hooks (1.2 ms, half of it unread log lines), the encode and zstd of a real
  patch (0.6), cv digests of re-recorded items (0.2), and more release and serving work.
- **Viewers.** 4 viewers cost 0.3 ms more than 1 (hub and zstd 0.2, serving): P3-SP's shared
  transactions and coded messages hold.
- **Hashing** is small: 0.21 ms in all, including the cv digests. The dynamic-surface SHA-256 W11b
  kept (decision 3) is under 0.1 ms here, about 0.2 ms in STS2 (twice the region calls).
- **JSON**: encode 0.29–0.37 ms under churn, 0.01 static. It is proportional to the patch already.

## The design in one table

From `protocol/host-cost-design.md`, ordered by saving per risk:

| Id | What | Saving, fixture churn (1 viewer) | STS2 combat, est. |
| -- | ---- | -------------------------------: | ----------------: |
| HC1 | hook log formats nothing while off; same-value `set_material` keeps the adoption epoch; no snapshot without a viewer | 0.66 ms (0 viewers: the whole callback) | 1.2–1.5 ms |
| HC2 | shared command lists; /11 identical re-record keeps its digest | ~0.7 ms | ~1.0 ms |
| HC3 | lazy mesh surfaces (GRM1 once per snapshot, SHA-256 only when read) | ~0.3 ms | ~0.4 ms |
| HC4a | persistent item and canvas tables, dirty sets, pointer diff, shadow oracle | ~1.4 ms (static ~1.6) | ~2.5 ms |
| HC4b | persistent resource tables, COW payload map, incremental planning and serving | ~1.2 ms (static ~1.1) | ~1.0 ms |
| HC5 | per-(B, T) formation on an encode thread | ~0.6 ms | ~0.4 ms |
| HC6 | hook fast path (one lock, direct pointers) | ~0.3 ms | ~0.5 ms |
| HCz | STS2 acceptance (MX's legs) | | combat ≤ 3 ms |

**Projected warm combat host time: about 1.5–2.0 ms a frame after HC1–HC4, 1.2–1.6 with HC5**,
against MX's 9.0 and NVENC's 1–3. The bytes on the wire do not change.

## Tools landed

- `scripts/perf-capture-split.py`: splits a `perf record -g` profile of an armed host's main
  thread by capture function (generic buckets over the capture's own symbols), with an optional
  frame rate for ms per frame.
- `scripts/lib/null-receiver.ts` `--protocol 11`: the /11 hello with `live_coding` (offer
  `zstd-base,zstd` by default). It reads a coded transaction's seq from its envelope and decodes
  only the plain-coded messages (session, resources, end), with Node's zstd. So
  `bench-live-scale.sh --receiver null --protocol 11` measures the product's /11 coded host; at /8
  it is unchanged.

## Validation

- The diff (two docs, `perf-capture-split.py`, `null-receiver.ts`, a comment in
  `bench-live-scale.sh`, two `smoke-map.json` paths) reaches only the pure self-tests:
  `validate-increment.sh --tier full` passed 1/1 (`pure`, 796 s).
- `null-receiver.ts` at both protocols, real time, 300 frames, tap on, every bench check passing:
  - `--protocol 8`: 297 transactions, 59.4 applies/s, credit RTT p50 2.5 ms;
  - `--protocol 11` with inline 4096: 300 transactions and 296 resource records acked, 60.0
    applies/s, RTT p50 3.0 ms; coded bytes 2.9 MB against the tap's ~51 MB uncoded (1/17.9).
- No capture code changed, so no byte-identity run was needed.

## Deviations

- **No STS2 launch.** The fixture reproduced the shape, and W11z holds the game lease for its
  acceptance legs. The STS2 projection scales the fixture's shares to MX's and P3-CAP's splits;
  HCz measures it.
- **Real-time numbers ran at load 2.9–9.9** (other repositories and agents outside the quiet
  lock). They are reported, but the design's savings come from the perf shares, which load moves
  far less.
- **Hook calls per frame** come from the fixture's knobs, not a counter of the steady window
  (`counters.json` totals include setup).

## Evidence

`artifacts/render-stream/p3/hc/`: per leg `bench-*.json`, `perf.json`, the perf splits
(`split.json`), `profile-table.json`, and the driver script (`hc-drive.sh`). The `perf.data`
files were not kept (about 0.5 GB).
