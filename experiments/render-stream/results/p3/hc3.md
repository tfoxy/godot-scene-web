# HC3: lazy mesh surfaces (2026-10-28)

HC3 of `protocol/host-cost-design.md` (D2 "Hashing", the dynamic mesh surface row). No wire
change. W11b's deferred "dynamic surfaces skip SHA-256" (`render-stream-11.md` "As built (W11b)"
rule 3, now rewritten) is done.

1. **A region update is a memcpy into the mirror's payload.** The hook still applies every
   `mesh_surface_update_*_region` to its own retained buffers (bounds, D8), but no longer re-encodes
   and re-hashes the whole GRM1 payload. It hands the mirror the region (`MeshRegionWrite`: offset
   in the GRM1 payload, bytes). The mirror memcmps it against its copy of the surface's payload,
   which is the W11b change test: equal bytes are no change. If they differ it writes them in,
   copying the payload first when a snapshot has published it, so each surface gets one copy per
   snapshot (`MeshSurf::writable`). The surface's hash, /11 body and perturb-vertex copy are
   dropped. The hook re-hashes for its own log line only while `resources.jsonl` is open.
2. **The SHA-256 is computed when something reads it.** At the snapshot, a static surface (and
   every surface below /11) is hashed once per content. The hook's creation hash is reused.
   Before HC3 every region call was hashed: twice per skeletal pose. A dynamic /11 surface is
   hashed only while there is a reader: the hook log (its serve events name payloads) or an open
   connection below /11 (`Hub::has_connection_below_v11`, entry.cpp, before each snapshot). Without
   a reader the payload sits in the snapshot's payload map under a capture-local key
   (`hc3-key:<n>`, `MeshSurface::hash_is_key`). The pin, budget and union bookkeeping see it as
   before, and no /11 transaction, record, store file or log line carries it. `make_patch` doesn't
   compare a key with a real hash, because the content serial already decides a dynamic mesh (equal
   serials mean equal bytes outside the stale-dynamic sabotage, which always hashes).
3. **A below-/11 connection's first transaction waits for a hashed snapshot.** G8kw's hold-back
   can publish a snapshot taken before the connection opened. `Captured::keyed_surfaces` marks
   one, and the hub defers that connection's session and first transaction to the next callback.
4. **Counters.** `counters.json` `mesh_hashes`: `{mirror_surfaces, mirror_dynamic_surfaces,
   hook_region_rehashes, mirror_payload_copies}`.

## Perf (capture-scale, /11, product hand-off env: inline 4096, hook log off, no tap)

HC2's configs (`hc3-perf.sh`, from `hc2-perf.sh`): churn is `RS_SCALE_REDRAWS=170` with the
fixture's default 76 skeletal meshes updated every frame (a vertex and an attribute region each).
"Before" is main 6bb21e59, "after" this branch. Same scripts and fixture; only the extension
differs. Runs alternate base, hc3, base, hc3. Load 3–13 from other agents' work throughout.

**Retired instructions** (`RS_BENCH_PERF_ARGS="-e instructions -c 1000000"`, `perf-capture-split.py
--freq 1000`: M instructions per frame, main thread):

| leg | capture before | capture after | region hooks (vertex + attribute) before | after | snapshot: meshes/textures/shaders before | after |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 0 viewers, churn | 3.68 | 2.13 | 1.95 | 0.57 | — | — |
| 0 viewers, churn (repeat) | 3.93 | 2.18 | 2.25 | 0.59 | — | — |
| 1 viewer, churn | 28.62 | 25.87 | 2.15 | 0.70 | 1.10 | 1.20 |
| 1 viewer, churn (repeat) | 30.97 | 24.89 | 2.38 | 0.63 | 1.05 | 1.16 |

The functions HC3 touches: the two region hooks lose about 1.5–1.75 M instructions a frame (their
GRM1 re-encode and SHA-256, twice per pose). The snapshot's mesh bucket gains 0.1 M (one copy per
changed surface and the static meshes' one hash per content; the 187 meshes are promoted, so at
/11 none is hashed). With no viewer, where only the hooks run, the capture is 42–45 % cheaper. The
1-viewer totals also move in buckets HC3 doesn't touch (diff, encode, zstd, hub: transactions
formed per run), as in HC2, so read the hook rows, not the totals.

**Cycles** (default sampling, ms per frame, 1 viewer, churn, ABAB, load 2.5–7): region hooks
0.34 → 0.12 and 0.33 → 0.17 ms, snapshot mesh bucket 0.26 → 0.26 and 0.20 → 0.24 ms. **HC3 saves
about 0.15–0.2 ms a frame** on this fixture, against the design's ~0.3. The whole-capture deltas of
these runs (6.40 → 5.37, 5.93 → 5.41 ms) are mostly pacing noise. The real-time `frame_callback`
means (no perf: 8.8 / 7.1 ms before, 8.6 / 6.6 after) vary by 2 ms between repeats at this load and
exclude the hooks. **Why less than designed (probably):** this machine's SHA-256 runs on SHA-NI
(`build-capture.sh`: "sha256 default path: sha-ni"), which is much faster than a software SHA-256,
and the re-encode it replaces was mostly allocation and copy. A host without SHA-NI should save
more. That was not measured here.

Evidence: `artifacts/render-stream/p3/hc3/perf/` (`instr-table.txt`, the split JSON and text per
leg under `instr/` and `cycles/`, drivers `hc3-perf.sh`, `hc3-split.sh`).

## Byte identity (`cmp-rec.ts --tree`, main 6bb21e59 against this branch)

| layer | files | result |
| ----- | ----: | ------ |
| gate 1 (g1a, g1b) | 33 | identical |
| gate 2 (g2a, g2b, g2d) | 41 | identical |
| gate 5 (g5c, g5e) | 20 | identical |
| gate 8 (g8w11, g8mm, g8pt) | 86 | identical |
| capture-scale /8, /10, /11, /12, 300 frames, sync workers, 64x48, redraws 170, **hook log off** (the keyed path: /11 and /12 promote 187 meshes and make 0 dynamic-surface hashes) | 4 x 302 records | identical; stores `diff -r` equal |
| capture-scale /11, hook log on | 302 records | identical; store equal |
| run-hc1.sh `dyn-off` against `dyn-on` (same branch, hook log off against on, /11 full and patch) | 2 | identical (`dyn-wire-log-independent`) |
| `resources.jsonl`, hook log on, minus timing fields | 62 | 50 equal. The 6 g8w11 coding hosts and `gate2/live-inline` differ in serve/GET events and frames (live pacing, as in HC2). The 5 g8pt captures differ only in `particles_set_seed`'s `seed`: the engine's random particle seeds, a per-run value HC3 doesn't touch (their recordings are identical) |
| goldens 2–12, window-1 transcripts, unit tests (ctest) | 41/41 | pass |

Outputs: `artifacts/render-stream/p3/hc3/ident/` (cmp-rec output, `resources.jsonl` comparison,
both sides' counters for the scale legs, gate 5 and gate 8 `result.json`; driver `hc3-ident.sh`).

## Checks (in `run-hc1.sh`, the `native-rust-hc1` run; `lib/hc1-checks.ts`)

New legs: `dyn-off` and `dyn-on` (/11 file sinks, 150 frames, 10 of the small fixture's 20 meshes
take a vertex and an attribute region every frame), `late-dyn-v8` (/11 host, hook log off, a /8
null viewer joining at about frame 167 with `--fetch-first`), `sabotage-dyn-hash-unread`.

- `dyn-hash-log-off` (the design's counter check): `dyn-off` makes 0 dynamic-surface hashes and 0
  hook re-hashes, with meshes promoted and 1,520 content changes (1,500 copy-on-write copies).
  `dyn-on` makes 1,470 and 3,000, so the counter is live.
- `dyn-wire-log-independent`: the two legs' /11 recordings are cmp-rec-identical.
- `late-join-v8-on-v11`: every mesh surface of every transaction the /8 viewer gets names a
  64-hex SHA-256, its 85 first-transaction GETs answer 200 with bodies that hash to their names,
  and the host made 1,950 dynamic-surface hashes for it.
- `sabotage-dyn-hash-unread-caught`: `GRC_HC_SABOTAGE=dyn-hash-unread` (the /8 viewer isn't counted
  as a reader; env-only, never on the wire) fails `late-join-v8-on-v11`. The viewer gets no
  transaction at all, because the hub's guard (item 3) never sends a keyed snapshot below /11.
- Design checks, unchanged and passing on this branch (gate 8 `g8w11`, hook log on): `dyn-wire`,
  `dyn-classify`, and both sabotages, `dyn-wire-catches-perturb-vertex` and
  `dyn-wire-catches-stale-dynamic`.
- Unit test `rs_mirror_test::test_hc3_lazy_mesh_surfaces`: keys and no hash without a reader, a
  byte-equal write (no change, no copy), two writes in a frame (one copy, published buffer
  untouched), the hash once per content with a reader, `make_patch` across a reader's arrival and
  departure, the static path, stale-dynamic hashing and perturb-vertex starting at an equal write.
  The W11b and G5e mirror and publish tests now write regions (`whole()`), unchanged otherwise.

## Deviations from the design

- **"Store" as a hash reader.** A /11 store never holds dynamic surfaces (W11b: they travel in
  `mesh_u8`), so the store needs no dynamic hash. The readers are the hook log and a below-/11
  connection.
- **The hook log on now costs one more hash per changed dynamic surface per snapshot.** The hook
  hashes for its line, and the mirror hashes its own copy for the serve events. Keeping one code
  path (the mirror always computes what the wire and the map carry) means the log-on legs
  (`dyn-wire`) check the same mirror code a product host runs. Log-on is a test setting.
- **The payload map keeps unhashed dynamic surfaces under a key** rather than dropping them, so the
  budget (`retained_bytes`), the pins and the served set account for the same bytes as before. Only
  two distinct surfaces with identical content are counted twice (before, once by hash).
- **New guard:** the hub defers a below-/11 connection's first transaction past a keyed snapshot
  (item 3). The design did not name it; without it a hold-back snapshot could reach a /8 viewer
  with keys in its mesh table.

## Validation

- `run-hc1.sh` locally, full (sabotages included): 15/15 pass. The 11 HC1/HC2 checks are
  unchanged; the 4 HC3 checks above are new.
- ctest 41/41 (`build-capture.sh`).
- Remote full tier (`remote-validate.sh --tier full`, run 40775295093, key
  `rv-20261028T215049Z-90f0e75-8325`, tree e809fc58 on 6bb21e59): 21/22 pass. That includes
  `native-rust-hc1` and native gates −1, 0, 1, 2, 3, 4, 5, 5.5 and 8. **Gate 8's `ktx2-wire`
  passes**: `native-rust-gate8` rc 0, and `[PASS] ktx2-wire` in the g7 run's gate 8 sources. That
  validates main's KW-FIX (0f5f2a28, the g8ku probe waits for its `pin` line) on the full tier for
  the first time. `bench-instr` moves −0.5 to +0.5 %. The one failure, `g7-web-rust` g7-8
  (`mm-reference@web`, `web-repeat-identical@web`), is the web export's hosted-runner flake
  HC1/HC2 met. Rerun locally (`RS_VALIDATE_GROUPS=g7-8 --tier full --only g7-web-rust`,
  run 20261028T231407Z): pass.
- Refused by the remote, run locally: `g7live-gsw` and `g7live-web-rust` g7-1 (full,
  `RS_VALIDATE_GROUPS=g7-1`, run 20261028T220952Z): 2/2 pass.
- Rebased onto 90a7a341 (PM6b: GSW particles; GSI: GSW `INSTANCE_ID`). Neither shares a file
  with this diff, so nothing was rerun.
- Not run: `lock-tests` (no lock file in the diff) and the timing runs (native gate 6,
  `g7live-*-timing`, g7x), which go to the sweep. Receivers' apply paths and the GDScript cores are
  out of scope: the wire is byte-identical, so no receiver sees a difference.

## For HC4a

- `Mirror::wire_mesh(Mesh*, PayloadMap*)` now publishes a mesh's payloads itself. A persistent mesh
  table should call `publish_surface` / `surface_hash` only for meshes whose surfaces changed. A
  surface's `key` moves exactly when its published bytes do, which can serve as the "changed since
  the last snapshot" mark.
- `MeshSurf::writable` is reset at publication. If HC4b's COW payload map shares a `MeshSurf`'s
  bytes across snapshots without calling `publish_surface`, the next region write would overwrite
  a published buffer. Keep `publish_surface` as the only way out of the mirror.
