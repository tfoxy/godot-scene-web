## Gate 2a result (2026-10-09)

G2a ([protocol/gate2-design.md](../protocol/gate2-design.md) "G2a") passes:
`pnpm render-stream:gate2 -- --legs g2a` is 15/15 in
`artifacts/render-stream/gate2/20261009T110836Z/` (an earlier run with the same build,
`20261009T105103Z`, matched every image and hash and taught the census one engine call, below).
The same build passed gate −1 28/28 with 55 hooks planned and none omitted
(`artifacts/render-stream/gate-minus1/20261009T104748Z/`, `armed.png == unarmed.png`), gate 0 19/19
(`artifacts/render-stream/gate0/20261009T105733Z/`) and gate 1 65/65 with all four groups
(`artifacts/render-stream/gate1/20261009T105916Z/`). Nothing changed on the render-stream/1 wire:
the capture leg classifies `unsupported`, and only because its texture draws are unsupported
commands.

What landed:

- **Calibrator 5**, eleven optional slots at exactly the contract's indices: placeholder create 34,
  `texture_replace` 40, the root default filter/repeat 321/322, canvas textures 441/442/444/445,
  item default filter/repeat 448/449, LCD text 470. `calibrate.sh --check` is clean. On /1 the new
  hooks are counted, captured into `counters.json` and logged; they make no mirror tap. The two
  texture-rect draws now capture every argument. The spike drives all eleven off-screen.
- **Copy and hash at the hook.** With a stream enabled, `texture_2d_create` and `_update` read the
  image's shape through the `Image` binds (`has_mipmaps` added), copy `image_ptr`'s bytes into a
  GRT1 payload and SHA-256 it on the calling thread before forwarding
  (`capture/src/rs_texture_payload.*`, `rs_sha256.*`; ctests on the FIPS vectors and on literal
  payload bytes for golden-2's four shapes). Formats outside `GRC_RESOURCE_FORMATS` and payloads
  over `GRC_RESOURCE_MAX_PAYLOAD_BYTES` are logged and not copied. G2a keeps no payload.
- **The hook log**, `evidence/resources.jsonl` (`capture/src/rs_resource_log.*`, ctest), with the
  wire ids and versions G2b2's mirror will assign.
- **The arm-time root texture defaults**, read through the two `Viewport` binds into `root.json`.
- **The gate 2 fixture and runner** (`fixtures/gate2/`, `scripts/run-gate2.sh`, `check-gate2.ts`,
  `lib/gate2-*.ts`, `test/self-test-gate2.ts`).

Images (all under the run directory): `reference/shots/step-{0..10}.png`,
`reference-repeat/shots/step-{0..10}.png` and `reference-armed/shots/step-{0..10}.png`. Every
reference shot equals `synthesizeGate2` exactly outside its `synth_exclude` regions (the linear,
mipmapped and semi-transparent ones: `s2` from step 3, all eight default-filter drawers at step 4,
`sb` from step 7, `mm` from step 9). The repeat is identical in every region of every step, so the
recorded budget is 0 everywhere. The armed reference is byte-identical to the unarmed one.

The measured census, per step window, identical in the headless capture and the rendered armed
reference and equal to `expected.json` (`<op>@other` is off the main thread):

| step | RenderingServer texture calls                                                                    |
| ---- | ------------------------------------------------------------------------------------------------ |
| 0    | `texture_2d_create` 5, `texture_2d_placeholder_create` 2, item default filter 11, item repeat 11 |
| 1    | none (flips, region, transpose are draw arguments)                                               |
| 2    | none (transform only)                                                                            |
| 3    | item default filter 1 (`S2`)                                                                     |
| 4    | `viewport_set_default_canvas_item_texture_filter` 1 (LINEAR, 2)                                  |
| 5    | `viewport_set_default_canvas_item_texture_filter` 1 (NEAREST, 1), item repeat 1 (`DR` MIRROR)    |
| 6    | `texture_2d_update` 1                                                                            |
| 7    | `texture_2d_create` 2, `texture_replace` 2                                                       |
| 8    | `texture_2d_create` 1, `texture_2d_create@other` 1, `free` 2                                     |
| 9    | `texture_2d_create` 1, `texture_replace` 1, item default filter 1 (`MM`)                         |
| 10   | none (transform only)                                                                            |

After the quit frame the scene teardown frees five textures (A, B, M, C, D); `P2` and the two raw
items are left to the engine's exit, as gate 1's raw items were. The `unsupported` variant adds
U1's create (logged `unsupported-format`, not copied) and two items' filter/repeat calls at step
0, and draws exactly one texture RID the log never saw created (`PRE`, made before arming); the
main capture draws none.

Copy and hash at the hook, headless capture, median ns (copy = header + `memcpy`, hash = SHA-256
of the whole payload):

| shape                | payload bytes | copy  | hash   |
| -------------------- | ------------- | ----- | ------ |
| LA8 4×4              | 137           | 140   | 1 120  |
| RGBA8 4×4            | 171           | 130   | 970    |
| RGBA8 16×16          | 1 135         | 1 160 | 5 330  |
| RGBA8 32×32          | 4 207         | 1 030 | 13 310 |
| RGBA8 800×6 (theme)  | 19 312        | 1 830 | 55 380 |
| RGBA8 64×64, mipmaps | 21 955        | 2 200 | 62 880 |

The rendered armed reference measures the same within noise. The portable SHA-256 runs at about
350 MB/s, so hashing, not copying, is the cost; lazy hashing stays a gate 6 measurement.

### Findings

- **The engine makes a texture of its own after arming.** The default theme gives ColorPicker an
  800×6 `GradientTexture2D` hue strip (`scene/theme/default_theme.cpp:1093-1097`) whose deferred
  `update_now` (`scene/resources/gradient_texture.cpp:220-225`) runs at the first MessageQueue
  flush, in frame 1, as a plain `texture_2d_create` (`:273-278`). It is the "800×6 format-5 image"
  gate −1 counted without explaining. Every armed run sees it, so `expected.json` declares it
  (`engine_textures`) and the census counts it.
- **Every texture prediction held on the first run.** The synthesized flips, the transposed
  region, `S3`'s 90° turn (transpose + flip in the shader's sampling), the flipped tile, mirror
  repeat, the LA8 alpha, the freed `P1` drawing white (D11), the placeholder becoming `E` through
  `texture_replace`, and `C` showing its pre-fill content all matched the reference exactly.
- **Copy at the hook is proven twice.** `C`'s hook hash equals the fixture's hash of the image
  before `fill(black)`, and the reference shows those colours. `D`'s create is the only line off
  the main thread, and its hash equals the worker's own.
- **Two independent encoders agree.** The C++ hook and the fixture's GDScript `payload.gd`
  produce the same SHA-256 for all twenty creates and updates across the capture and the armed
  reference; A0's and B's hashes also equal the ctest's Python-derived literals.

### Deviations from the contract

- Every sprite is `centered = false`: the layout table's regions put each sprite's top-left at its
  position. `DR`'s step-1 source is (4,0,8,8), not (8,0,8,8), which lies wholly in A0's green
  quadrant and would look the same with or without the transpose.
- The hook log appends five keys to Q3's (`target`, `ref_id`, `value`, `layer`,
  `root_viewport`): the census, `replace-retires-temp` and `viewport-defaults` need the argument
  an op names. A `texture_replace` line repeats its by-texture's payload fields. The census keys
  thread as `<op>@other`.
- `GRC_RESOURCE_MAX_PAYLOAD_BYTES` defaults to 64 MiB; the contract names no default.
- `reference-armed` runs with the default root-size policy (`observe`), so the only difference
  from `reference` is the armed extension and its stream; its window is 640×360, so it declares
  `match`.
- One check beyond the contract's list, `unsupported-variant`, judges the `capture-unsupported`
  support leg ("census of unknown RIDs"). `expected.json` is generated by
  `fixtures/gate2/make_expected.py`, which encodes the hand derivation and cites its sources.
- `gate0-checks.ts` `GATE0_HOOKS` grows to the 55 names the shared record plans, so gates 0 and 1
  keep requiring exactly the committed record's hooks.

### What G2a does not prove

- Anything a receiver does with textures: the wire is still render-stream/1 (G2b2).
- Payload retention, the store, HTTP delivery and pinning (G2b2, G2c1, G2c2), or the
  `CanvasTexture` hooks beyond their counts (G2d).
- That the texture capture covers formats other than the six 8-bit uncompressed ones, textures
  created before arming, or the target game's 1 526 textures (gate 8).

## Gate 2b result (2026-10-09)

G2b2 ([protocol/gate2-design.md](../protocol/gate2-design.md) "G2b2" and its "As built") passes:
`pnpm render-stream:gate2 -- --legs g2a,g2b` is 47/47 in
`artifacts/render-stream/gate2/g2b2-final/` (an earlier run of the same tree, `g2b2-try1`, also
passed once the checker classified the patch receiver against the patch recording). The same build
passed gate −1 28/28 with 55 hooks and `armed.png == unarmed.png`
(`artifacts/render-stream/gate-minus1/g2b2-final/`), gate 0 19/19 on /2
(`artifacts/render-stream/gate0/g2b2-final/`) and gate 1 65/65, all four groups, on /2
(`artifacts/render-stream/gate1/g2b2-final/`). All under the ignored `artifacts/`.

What landed:

- **The capture speaks render-stream/2.** `rs_mirror` keeps the texture table (one id counter for
  images and placeholders, versions, `freed` tombstones that leave at the first snapshot nothing
  names them, `texture_replace` retiring the by-texture, the payload bytes the hook copied), the
  item and root-viewport filter/repeat, and the texture draws as commands (`unknown-texture` for a
  RID it never saw created, derived `unsupported-texture` entries). `rs_publish` (was
  `rs1_publish`) writes both sinks, the content-addressed store (`rs_resource_store`) and inline
  resource records per sink; `rs_live` (was `rs1_live`) serves /2 with every payload inline until
  G2c2. The /1 codecs left the library; `render-stream-1.ts`, `golden-1/` and `self-test-rs1.ts`
  stay as frozen history.
- **The receiver consumes /2**: `Rs2Decoder.Stream`, `RsResourceCache` (memory, a verified cache
  directory, the store as origin), lazy residency and the D5 upload rule in `RsApplier`, typed
  refusal of unsupported textures, `applied.json` `/3`.
- **Gates 0 and 1 run on /2** (`recording.rs2`, stores, caches, the /2 features), and gate 2 has
  group g2b (`lib/gate2b-checks.ts`).

Images (all under the run directory): the receivers' `receiver-{cold,warm,patch,inline}/shots/seq-<n>.png`
at the eleven settle seqs are byte-identical to `reference/shots/step-<k>.png`, full frame,
`synth_exclude` regions included; `receiver-cold`'s equal `synthesizeGate2` outside them. RAW1 is
white at step 8 (the freed `P1` tombstone), S3 shows C's pre-fill content. The unsupported variant's
receiver differs from `reference-unsupported/` in exactly `u1` and `u2` (1 024 px each) at every
step.

Bytes, 400-frame captures:

| recording                             | bytes     | median transaction | seq 1 | resource records |
| ------------------------------------- | --------- | ------------------ | ----- | ---------------- |
| `capture/recording.rs2` (full)        | 3 434 197 | 8 697              | 8 109 | 0                |
| `capture/recording-patch.rs2` (patch) | 211 669   | 461                | 8 109 | 0                |
| `capture-inline/recording.rs2` (full) | 3 486 461 | 8 697              | 8 109 | 10 (50 493 B)    |
| `capture-inline/recording-patch.rs2`  | 263 933   | 461                | 8 109 | 10 (50 493 B)    |
| `live-inline` tap (892 transactions)  | 490 726   | 461                | 8 110 | 10 (50 493 B)    |

The store holds 10 payloads, 50 493 B (A0, A1, A2, B0, B1, M, C, D, E and the engine's hue strip);
the retained maximum (the mirror's payloads plus the last publication's) is 49 050 B. The inline
records are byte-identical to the store files, and the inline capture resolves to the out-of-band
one at all 400 frames.

The receivers, per step (fetched / uploads), equal `expected.json` `receiver_resources`: step 0
2 fetched (A0 once for A and Atwin, B0), 5 created (A, Atwin, B, P1, P2); step 6 1 / 1 updated; step 7
2 / 2 replaced; step 8 2 / 2 created and 2 RIDs freed; step 9 2 / 1 created, 1 replaced; every
other step 0. `receiver-cold` fetched 9 distinct payloads (31 181 B) from the store, about 37 µs
per fetch (median, max 45 µs, verification included), and uploaded 10 times (31 220 data bytes);
its cache ends with exactly those 9 files. `receiver-warm`, a new process on that cache, fetched
0 with 9 cache hits, and its uploads, `rs_calls`, shots and state dumps are identical.
`receiver-patch` costs what `receiver-cold` does; `receiver-inline` and the live receiver take
every payload from the stream and fetch nothing. In the transform-only windows (steps 2 and 10:
frames 21–30 and 101–400) every receiver counter is 0, the hook log has no texture call and the
patch transactions carry no texture entry.

| leg                                                          | class (expected)          | why                                                                           |
| ------------------------------------------------------------ | ------------------------- | ----------------------------------------------------------------------------- |
| `receiver-cold`, `-warm`, `-patch`, `-inline`, `live-inline` | success                   | as above                                                                      |
| `unsupported-textures`                                       | unsupported               | U1 `unsupported-format` (unsupported-texture), U2 `unknown-texture`           |
| `sabotage-omit-update`                                       | pixel-mismatch {6}        | A keeps A0 at step 6; step 7's replace re-converges                           |
| `sabotage-omit-replace`                                      | pixel-mismatch {7,8,9,10} | A keeps A1 at its old size; step 9's replace of P2 is dropped too             |
| `sabotage-stale-texture`                                     | capture-failure           | texture-log-divergence at seq 61: the stream keeps A v1, the hook log says v2 |
| `sabotage-wrong-hash`                                        | replay-failure            | resource-hash-mismatch at seq 61 (step 6), A1's store file corrupted          |
| `sabotage-spurious-update`                                   | resource-violation        | transform-only-resource-traffic at frame 21 (A v2, same hash; no re-upload)   |
| `sabotage-receiver-reupload`                                 | resource-violation        | redundant-upload (and traffic in the transform-only windows)                  |
| `sabotage-receiver-ignore-cache`                             | resource-violation        | warm-cache-fetch: a warm receiver fetched every hash its cache held           |

### Findings

- **G2b1's goldens carried the wrong `payload_bytes`.** The texture entry's `payload_bytes` is the
  whole `render-stream-texture/1` payload (1 135 B for RGBA8 16×16), the size the inline threshold
  and the store compare; golden-2 had the image data size (1 024 B), and both decoders compared
  the resource record's data length against it. golden-2 was regenerated and both decoders fixed.
- **omit-op needs the hook log's cooperation.** A texture call the capture misses must be missed by
  the log's registry too, or the stream and the log diverge and the sabotage lands as
  `capture-failure` instead of pixels. The omitted call is still logged, marked.
- **The texture mirror and the hook log assign ids independently**, so their identity taps share
  one hook-side lock; a worker-thread create (D) cannot interleave differently in the two.
- **Every gate 0 and gate 1 stream now carries one texture** (the engine's hue strip): stores of
  one payload, and every live connection sends one 19 312-byte resource record before seq 1. Gate
  1's queued-bytes bound now counts a credit window (a transaction and the records sent ahead of
  it) rather than one message.

### What G2b does not prove

- HTTP delivery, pins and retirement (G2c2), canvas textures and per-command filter/repeat (G2d),
  bearer tokens (G2e).
- Payload sizes beyond the fixture's (the largest is M's 21 955 B) or a store write failure and the
  retained budget in a real run (both are unit-tested only).
- Cache eviction, parallel fetches, lazy hashing (gate 6), browser receivers (gate 7), late join and
  the target game's textures (gate 8).

## Gate 2c result (2026-10-09)

G2c2 ([protocol/gate2-design.md](../protocol/gate2-design.md) "G2c2" and its "As built") passes:
`pnpm render-stream:gate2` (groups g2a, g2b, g2c) is 72/72 in
`artifacts/render-stream/gate2/g2c2-final/`. The same build passed gate −1 28/28
(`artifacts/render-stream/gate-minus1/g2c2-final/`), gate 0 19/19
(`artifacts/render-stream/gate0/g2c2-final/`) and gate 1 65/65, all four groups
(`artifacts/render-stream/gate1/g2c2-final/`). All under the ignored `artifacts/`.

What landed:

- **The live host serves payloads by hash.** `ServedResources` (`capture/src/rs_resource_store.h`)
  is the rs_ws `ResourceSource`: at each frame callback the published snapshot's payloads are
  pinned before the hub sends, and after the sends the servable set is exactly the current state's
  payloads united with every open connection's base (the payloads of its last sent transaction);
  everything else is retired and its bytes released. Pins, retirements and every GET go to the
  hook log (`pin`, `retire`, `http-get`), the summary gains the serving totals, and the retained
  budget counts the servable set. Live connections follow the configured policy (`fetch: "http"`,
  inline capped at 1 MiB). Sabotages `unpin` and `drop-resource`; `wrong-hash` serves the store's
  corrupted copy.
- **The live receiver fetches before it applies.** `RsResourceFetcher` (one keep-alive
  `HTTPClient`, sequential GETs, a timeout, the delay as a timed wait) fills the cache; a
  transaction stays unapplied (acked `received`) until every payload it needs is verified and
  cached, while the previous state stays on screen.

Numbers (host `live-summary.json` and hook log; receiver `applied.json`):

| leg              | GETs | HTTP bytes | pinned / retired | retained max (hashes / bytes) | fetch latency p50 / p95                |
| ---------------- | ---- | ---------- | ---------------- | ----------------------------- | -------------------------------------- |
| `live`           | 9    | 31 181     | 10 / 3           | 7 / 49 050                    | 16.1 / 16.7 ms                         |
| `live-headless`  | 9    | 31 181     | 10 / 3           | 7 / 49 050                    | 19.4 / 20.9 ms                         |
| `live-stall`     | 9    | 31 181     | 10 / 3           | 7 / 49 050                    | 16.1 / 16.7 ms                         |
| `live-reconnect` | 9    | 31 181     | 10 / 3           | 7 / 49 050                    | 16.2 / 16.7 ms                         |
| `live-warm`      | 0    | 0          | 10 / 3           | 7 / 49 050                    | – (9 cache hits)                       |
| `live-animate`   | 15   | 33 365     | 905 / 897        | 10 / 49 778                   | 16.9 / 17.1 ms (100 ms delay excluded) |

Fetch latency is the same for 137 B and 21 955 B payloads (15.8–16.7 ms in `live`): a fetch costs
one receiver frame at `--max-fps 60`, since the fetcher is polled from `_process`; the loopback
transfer itself is not visible at this resolution. `pins-bounded` holds at all 911 frames of every
good host (the replayed servable set equals the full recording's ok hashes united with every open
connection's tapped base, peak 48 086 B after retirement; the summary's 49 050 B includes the
phase-1 pins of a callback before its retirements), against a 512 MiB budget.

`live-animate`: 911 ANIM updates, 661 ANIM versions reached the wire (in 661 transactions), six
distinct ANIM hashes (k = frame mod 6), 15 distinct hashes fetched (the six ANIM contents and the
nine fixture payloads, every one named by a sent transaction), 897 retirements: every superseded
ANIM version left the servable set at the next callback once no base named it.

| leg                        | class (expected) | why                                                                                                                  |
| -------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------- |
| `live`                     | success          | 853 transactions, 9 fetches (one per payload), 11 shots equal to the reference                                       |
| `live-warm`                | success          | a new host and receiver on `live`'s cache: the host answers no GET, 9 cache hits, shots equal `live`'s               |
| `live-replay`              | success          | file replay of `live`'s `received.rs2` with `live`'s cache as its store: same seqs, payloads, shots and state dumps  |
| `live-headless`            | success          | 808 transactions, `applied` credit, under strace                                                                     |
| `live-stall`               | success          | stall after seq 559 (frame 607); seq 560 at frame 687 carries A1, fetched once; its step 6 shot equals the reference |
| `live-reconnect`           | success          | connection 2 starts full: 0 fetched, 3 cache hits, 5 uploads for 5 resident textures; then C and D fetched once each |
| `live-animate`             | success          | anim region equal to `synthesizeGate2` at each shot's frame, the rest equal to the reference                         |
| `sabotage-unpin`           | replay-failure   | `resource-unavailable` at seq 1: the third GET (ANIM, ~21 frames after the send) found its version retired, HTTP 404 |
| `sabotage-drop-resource`   | replay-failure   | `resource-unavailable` at seq 568, the first transaction naming A1, which the host answers 404                       |
| `sabotage-wrong-hash-live` | replay-failure   | `resource-hash-mismatch` at seq 571: the served A1 has its first data byte flipped                                   |

Images, all under the run directory: `live/receiver/shots/seq-<n>.png` (11 steps; equal to
`reference/shots/step-<k>.png`), `live-replay/shots/seq-<n>.png` for the same seqs,
`live-stall/receiver/shots/seq-560.png` (step 6, after the stall),
`live-reconnect/receiver/shots/stream-2-seq-<n>.png` (steps 8–10 on connection 2) and
`live-animate/receiver/shots/seq-<n>.png`.

### Findings

- **Pinning has to precede the send.** rs_ws's I/O thread transmits a transaction as soon as it
  is queued, so a receiver can GET a hash new at that frame before the callback ends; the host
  therefore pins everything it may send before the hub runs and retires after it.
- **The contract's 100 ms delay with a six-content ANIM.** A fresh receiver caches all six ANIM
  contents by host frame ~90, so `unpin` from S + N was unobservable (it retired 11 base-named
  hashes and the leg succeeded); the leg arms it from frame 1. The delay itself is safe: a fetch
  costs ~7 frames, so the GET lands three ANIM phases off the current content and is served only
  by the base pin.
- **A 2 s stall after step 5 skips step 6 entirely.** It would end at ~728, after step 7 replaced
  A, so A1 never reaches the wire; `live-stall` uses 1.3 s, ending inside step 6's window.
- **One HTTPClient state per frame cost 2–3 frames per fetch.** The fetcher now polls repeatedly
  within a frame while it makes progress (each poll non-blocking), bringing a fetch to one frame.

### What G2c does not prove

- Bearer tokens (G2e) and canvas textures (G2d); non-loopback serving (gate 8).
- Fetch costs below one frame, parallel fetches, large payloads (the largest is 21 955 B),
  constrained links and cache eviction (gate 6); browser receivers and their HTTP caches (gate 7).

## Gate 2d result (2026-10-09)

G2d ([protocol/gate2-design.md](../protocol/gate2-design.md) "G2d" and its "As built") passes,
integrated onto `main` after G2c2 and G2e: `pnpm render-stream:gate2` with every group is 85/85 in
`artifacts/render-stream/gate2/g2d-final/`. The same build passed gate −1 28/28 with 55 hooks
(`artifacts/render-stream/gate-minus1/g2d-final/`), gate 0 19/19
(`artifacts/render-stream/gate0/g2d-final/`) and gate 1 65/65, all four groups
(`artifacts/render-stream/gate1/g2d-final/`). The calibrator did not need a bump: the four slots
(441/442/444/445) were reserved by calibrator 5.

What landed:

- **`CanvasTexture` in the mirror and on the wire.** `rs_mirror` taps `canvas_texture_create`,
  `_set_channel` (diffuse, normal, specular), `_set_texture_filter` and `_set_texture_repeat`. A
  canvas texture with a normal or specular channel is `unsupported`/`canvas-texture-channel`. The
  texture table gets `kind: "canvas"` entries with `canvas: {diffuse, filter, repeat}`.
- **The receiver applies it.** `rs_applier.gd` creates the canvas texture on first sight and
  re-issues the channel, filter and repeat calls whenever the wire version advances.
- **A headless host refuses it, typed.** The dummy storage never allocates a canvas texture
  (`servers/rendering/dummy/storage/texture_storage.h:54` returns `RID()`; the same on 4.6.2 and
  4.7.2), so a headless host declares
  `features.unsupported_resources: [{"resource":"canvas_texture","reason":"canvas-texture-headless"}]`
  and makes a texture draw naming `RID()` an `unsupported` command `canvas-texture-headless`. It is
  never replayed as the white default. The hook log marks each `canvas_texture_*` call the same
  way. The options for real support are in
  [protocol/canvas-texture-headless.md](../protocol/canvas-texture-headless.md).
- **The fixture's step 11.** `SC` draws `A`'s 64×64 region at 1.125× with nearest filtering and
  repeat enabled. The main fixture sets them on the item, so no headless leg meets a
  `CanvasTexture`. The `canvas` variant gets the same pixels from a `CanvasTexture` `CT` while the
  item says linear/disabled.

| leg                           | host     | class (expected)                        | why                                                                                                          |
| ----------------------------- | -------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `canvas-headless`             | headless | unsupported (`canvas-texture-headless`) | 4 refused `canvas_texture_*` calls, no canvas entry; SC's draw refused from step 11, the receiver reports it |
| `canvas-host`                 | rendered | success                                 | CT on the wire (canvas, diffuse A, nearest/enabled, version 4); the receiver equals the reference            |
| `canvas-normal`               | rendered | unsupported (`unsupported-texture`)     | `CT.normal_texture = B`: canvas-texture-channel; region `sc` only, only step 11 (5 184 px)                   |
| `sabotage-omit-canvas-filter` | rendered | pixel-mismatch {11}                     | `omit-op canvas_texture_set_texture_filter` at step 11's frame; 1 088 px differ (nearest vs linear)          |

The three rendered legs are host-renderer evidence for the capture and replay path, not headless
support. `canvas-texture-override` holds on `canvas-host`'s own step-11 frame: region `sc` equals
`synthesizeGate2`'s nearest/enabled exactly (0 px differ), although SC's item says linear/disabled.

### Findings

- **A headless host cannot create a `CanvasTexture`** (above). Only the refusal makes that loud.
  Before it, the draw replayed as `tex: null`, which is white.
- **The hook log did not recompute status on a channel-set call.** `rs_resource_log.cpp`'s
  `canvas_texture_set_channel` left `canvas/ok` after the mirror flipped to `unsupported`.
  `canvas-normal` caught it as `texture-log-divergence`. Fixed.
- **Nearest vs linear only shows under magnification here.** At 1:1 and at 0.75× no pixel differed
  on flat-colour content. `SC` draws at 1.125×.
- **Gate 2's TS checker listed only the landed groups g2a-g2c** while the runner listed g2e too.
  Both now list g2a-g2e, g2d's legs are judged only when g2d ran, and the self-test fabricates g2e
  evidence (`gate2c-fixture.ts` `buildG2eTree`).

### What G2d does not prove

- `CanvasTexture` capture on a headless host (refused; see the options study).
- `canvas_texture_set_shading_parameters`, `texture_set_size_override`, and proxy, layered, 3D,
  external and viewport textures.
- Textured polygons, meshes and nine-patch (gate 5), lazy hashing and cache eviction (gate 6),
  browser receivers (gate 7), late join and the target game's textures (gate 8).

## Gate 2e result (2026-10-09)

G2e ([protocol/gate2-design.md](../protocol/gate2-design.md) "G2e") passes: `pnpm render-stream:gate2
-- --legs g2a,g2b,g2c,g2e` is 77/77 in `artifacts/render-stream/gate2/g2e-run1/`. The same build
passed gate −1 28/28, gate 0 19/19 and gate 1 65/65 (all four groups), and `pnpm test` (2490
passed), `pnpm exec tsc --noEmit` on `experiments/render-stream`, and every pure self-test
(`self-test-rs0/1/2.ts`, `self-test-gate0.ts` 205/205, `self-test-gate1.ts` 402/402,
`self-test-gate2.ts` 354/354, `make_golden.py --check` on `golden/`, `golden-1/` and `golden-2/`).
All under the ignored `artifacts/`.

What landed:

- **`rs_ws` checks a bearer token on both routes.** `ServerConfig::auth_token` (empty disables the
  check, exactly as before G2e) gates the WebSocket upgrade and every resource GET.
  `constant_time_equals` (exposed in `rs_ws.h` for its own ctest) compares the presented token
  against the configured one in time that depends only on the longer string's length, never on
  where they first differ; the "Bearer " prefix check itself is allowed to short-circuit, since it
  names no secret. A missing or wrong token is `401`, never a close code: the upgrade's `reject()`
  closes the TCP connection after flushing the response (the same path every other rejected
  handshake already took); a GET's `401` honours `Connection: keep-alive` like its `404`, since an
  unauthorized request is not a broken connection.
- **The host generates and evidences the token without ever logging it.** `GRC_LIVE_AUTH=token`
  (default `none`) makes `entry.cpp` generate 32 random bytes as 64 lowercase hex
  (`getrandom()`, independent of `rs2::generate_id()`'s 16-byte session/stream ids), write them to
  `evidence/live-token` (mode 0600) before the listener starts, and declare the session's
  `resources.auth: "bearer"` (the wire field G2b1 had already reserved). A rejected upgrade is a
  new `rs_ws` event, `AuthRejected` — the connection never reaches `Opened`, so the hub has nothing
  to track; `entry.cpp`'s `live_drain()` logs it directly to `stdout.log` as `live: 401
unauthorized upgrade`, never to the structured hook log, since it carries no hash. A rejected GET
  stays on the existing `HttpGet`/`http-get` path with `http_status: 401`.
- **The receiver sends the token on both routes, or a deliberately wrong one.**
  `RS_RECEIVER_TOKEN_FILE` is read once at startup; `RsLiveClient.open()` sets
  `WebSocketPeer.handshake_headers` to `Authorization: Bearer <token>` before every
  `connect_to_url()` call, including reconnects; `RsResourceFetcher` sends the same header on every
  `HTTPClient.request()`. The new sabotage `RS_RECEIVER_SABOTAGE=wrong-http-token` corrupts only the
  fetcher's copy (appends `-wrong`) after the WebSocket has already opened with the correct one, so
  "correct on the upgrade, wrong on every GET" holds exactly as the contract asks.

Legs (group `g2e`), each a fresh live host (`GRC_LIVE_AUTH=token`, the live timeline, S = 300,
N = 60, quit 911) plus one receiver:

| leg                       | class (expected) | why                                                                                                                                       |
| ------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `live-auth`               | success          | as `live` (README "Gate 2c result") with tokens: 852 transactions, 9 fetches (31 181 B), 10 uploads (31 220 B), host 9 GETs / 0 errors    |
| `sabotage-no-token`       | replay-failure   | `live-connect-failed` at the very first connect: `WebSocketPeer` never reaches `STATE_OPEN` (state 3, close code −1) after the host's 401 |
| `sabotage-bad-http-token` | replay-failure   | `resource-unavailable` at seq 1: the first resource GET (needed by the initial transaction) answers HTTP 401                              |

`sabotage-no-token`'s host log shows exactly one `live: 401 unauthorized upgrade` line and zero
`http-get` 401s; `sabotage-bad-http-token`'s hook log shows exactly one `http-get` line with
`http_status: 401` and zero upgrade rejections; `live-auth` shows neither. `token-not-logged`
greps every file under each leg's directory (recordings, hook log, `stdout.log`, `applied.json`,
shots) for that leg's own 64-character token and finds it nowhere but `evidence/live-token` — this
was re-verified independently outside the checker (a raw-byte grep of the whole run directory,
each leg's token excluded only from its own `evidence/live-token` file) with zero hits.

### Findings

- **Bearer-auth evidence needed a channel `rs_ws` didn't have.** Every existing rejected-handshake
  path (wrong subprotocol, `max_clients`, a malformed request) produces no `Event` at all, which
  is fine when nothing downstream needs to know why. Proving the _host_ actually answered 401 (not
  just that the receiver failed to connect, which Godot's `WebSocketPeer` reports identically for
  any handshake failure — `get_close_code()` stays unset) needed a dedicated event
  (`AuthRejected`), following the exact precedent `HttpGet` set at G2c1/G2c2 for the same kind of
  "the switch must stay exhaustive under `-Wswitch`" extension.
- **Only the secret itself needs the constant-time property.** The "Bearer " prefix is a public
  RFC 6750 constant; letting `std::string::compare` short-circuit on it leaks nothing a timing
  attack could use, so `bearer_ok()` only pays for `constant_time_equals` over the token that
  follows the prefix (or an empty string, when the header is missing or malformed).
- **Node's WebSocket global cannot drive this test.** The WHATWG `WebSocket` constructor has no
  header parameter (the same restriction browsers have), so `self-test-rs-ws.ts`'s bearer-auth
  checks use `node:http`'s raw upgrade request directly: a 101 response arrives as an `upgrade`
  event, anything else (401 included) as an ordinary `response` event. The Godot interop tests hit
  the same wall from the other side — `WebSocketPeer` exposes no HTTP status for a failed
  handshake — so `ws_selftest.gd`'s auth phase can only assert "never reaches `STATE_OPEN`"; the
  host-side evidence above is what actually proves the status was 401.

### What G2e does not prove

- Non-loopback serving (gate 8, D13) and token transport without headers for a browser receiver
  (gate 7, deferred by D13 too).
- Token rotation while a connection is open, multiple valid tokens, or any authorization scheme
  beyond one static bearer token per host process.
- Canvas textures (G2d, landing in parallel); gate 2's full summary waits for it.

## Gate 2f result: the headless CanvasTexture shim, opt-in (2026-10-10)

The user approved option (a) of
[protocol/canvas-texture-headless.md](../protocol/canvas-texture-headless.md) as an experiment, and it
passes that doc's criteria 1–4 ("Experiment (a) result"). With
`GRC_HEADLESS_CANVAS_TEXTURE=synthesize`, the `canvas_texture_create` hook replaces the dummy
storage's `RID()` with a private RID, `0x47524354 << 32 | (2^31 + n)`, which no engine owner can
own. A headless host then captures `CanvasTexture` like a rendered one. Without the variable,
nothing changes, and the typed refusal (`canvas-texture-headless`) stays the default. The capture
refuses typed when the opt-in is set on a host that is not `headless`
(`canvas-texture-shim-not-headless`), and when the value is invalid
(`canvas-texture-shim-invalid`).

The final run is on `main` at `0605ea75` (calibrator 8). It is on render-stream/4, after G5d,
the /5 codecs and G5g. `pnpm render-stream:gate2 -- --legs g2a,g2b,g2c,g2d,g2e,g2f` is 97/97 in
`artifacts/render-stream/gate2/ctshim-v5/`: g2a–g2e's 85 unchanged, plus g2f's 12. The same build
passed:

- `build-capture.sh` 17/17 ctests
- `calibrate.sh --check`
- gate −1 28/28
- gate 0 19/19
- gate 1 65/65
- gate 3 56/56
- gate 4 185/185
- gate 5 (g5b, g5c, g5d, g5g) 78/78
- gate 5.5 (g55b, g55c) 52/52

All are in `artifacts/render-stream/<gate>/ctshim-v5/`. Every pure self-test and every
`make_expected`/`make_golden --check` also passed. g2d's `canvas-headless` is still `unsupported`
(`canvas-texture-headless`). Earlier full runs on earlier bases are `ctshim-v1` (before G5d,
96/96 with 11 g2f checks) and `ctshim-v3` (after G5d, 97/97).

An earlier full run, `ctshim-v2`, was 95/97. Its two failures were g2c's `pins-bounded` and
`obsolete-retired` on `live-animate`, at quit frame 971: one hash was still servable that nothing
named. It ran beside the pure self-tests. This is the known live-animate load flake: no
`CanvasTexture` and no shim in those legs. Every g2f check passed in that run, and the next full
run, `ctshim-v3`, passed.

| leg                                | host                                          | class                                   | why                                                                                                                                            |
| ---------------------------------- | --------------------------------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `shim-headless`                    | headless capture (no GPU) + rendered receiver | success                                 | all 12 settle shots byte-exact against `reference-canvas` (rendered, extension absent), step 11's region `sc` included; CT on the wire as canvas/diffuse A/nearest/enabled |
| `shim-sabotage-omit-canvas-filter` | headless + rendered receiver                  | pixel-mismatch {11}                     | 1 088 px at step 11, the same as G2d's rendered-host sabotage                                                                                 |
| `shim-off`                         | headless, `=off` + headless receiver          | unsupported (`canvas-texture-headless`) | exactly the default                                                                                                                            |
| `shim-refused-rendered`            | gamescope capture host, `=synthesize`         | refused, typed                          | `canvas-texture-shim-not-headless`; no vptr write, no private RID, no recording                                                                |
| `shim-invalid`                     | headless, `=bogus`                            | refused, typed                          | `canvas-texture-shim-invalid`                                                                                                                  |
| `shim-gate5-canvas`                | headless, `fixtures/gate5` `canvas`, `=synthesize` | success                            | gate 5's D11 refuses no `RID()` geometry draw; commands equal the main gate 5 fixture's                                                        |

**Gate 5's D11 is relaxed under the opt-in.** G5d landed while this experiment was in flight. Its
sticky "a canvas texture exists" flag is now set only by a `canvas_texture_create` that returned
`RID()`. With the opt-in on, `RID()` geometry stays `tex: null` after a `CanvasTexture` is created.
With it off, nothing changes: gate 5's `capture-canvas` still refuses its five predicted draws. The
g2f leg `shim-gate5-canvas` (`fixtures/gate5`'s `canvas` variant, headless, opt-in) classifies
`success`, with the main fixture's commands at every settle frame.

One private RID, `0x4752435480000000`, was created at frame 111 and freed once through the hooked
`free()` at teardown. It is disjoint from all 26 RIDs that the 8 hooked creators returned. The
run's engine `ERROR`/`WARNING` lines are exactly the shim-off run's: two exit-time leak reports
that every headless gate-2 capture prints.

Open items:

- **Criterion 5**, the same leg on the target game. Pending the user's approval for the launch.
- **A session-level wire declaration of the shim.** Today it is declared only in the evidence.

The doc's "Experiment (a) result" has the details, including why `Skeleton2D` and
`GPUParticles2D`, which share the stub, are not a mechanical extension.

## Gate 2 summary

Gate 2 passes: `pnpm render-stream:gate2` with all groups g2a-g2e is 85/85 in
`artifacts/render-stream/gate2/g2d-final/`, on the same build as gate −1 28/28, gate 0 19/19 and
gate 1 65/65 (`artifacts/render-stream/{gate-minus1,gate0,gate1}/g2d-final/`). Every leg is at its
expected class. Images are under each leg's `shots/` in the run directory, and the references are
`reference/shots/step-{0..11}.png`.

What it proves, by increment:

- **2a.** The stock release template's texture calls can be hooked (calibrator 5, 55 hooks). Image
  bytes are copied and hashed at the hook, on the calling thread (loader threads included), and
  agree with an independent derivation of the fixture's twelve steps.
- **2b.** render-stream/2 carries textures as a versioned table with content-addressed payloads,
  out of band (store) or inline. A receiver uploads a texture only when a command first needs it
  and re-uploads only on a hash change. Transform-only steps cost zero texture traffic, and a warm
  cache fetches nothing.
- **2c.** Live hosts serve payloads over HTTP by hash on the WebSocket's listener. Pins cover every
  fetch a correct receiver can make, and everything else is retired. Stall, reconnect, warm, replay
  and animate legs all draw the reference's pixels.
- **2d.** `CanvasTexture` per-command filter and repeat override the item's, on the wire and in
  pixels, on a host with a real renderer.
- **2e.** A bearer token gates the upgrade and every GET, compared in constant time, and is never
  logged.

Unsupported, each typed and never substituted: formats outside the permitted six
(`unsupported-format`), oversized payloads (`payload-too-large`), textures created before arming or
never hooked, such as proxy, layered, 3D and viewport textures (`unknown-texture`), canvas
textures with a normal or specular channel (`canvas-texture-channel`), and, as an **architectural
finding**, every `CanvasTexture` on a headless host (`canvas-texture-headless`). The dummy renderer
that `--headless` forces allocates no canvas texture on 4.5.1, 4.6.2 or 4.7.2, so no pass-through
tap can see one. The options (a synthesized-identity shim, a software-GL host, a host-renderer
opt-in) and the recommended next experiment are in
[protocol/canvas-texture-headless.md](../protocol/canvas-texture-headless.md). That experiment, an
opt-in shim that synthesizes the identities (`GRC_HEADLESS_CANVAS_TEXTURE=synthesize`), passes
criteria 1–4 (group g2f, "Gate 2f result" above). The refusal stays the default.

Costs measured in this run:

- **Copy and hash at the hook** (`capture`, 11 payloads): copy median 0.97 µs (max 2.7 µs for the
  800×6 hue strip). SHA-256 median 4.5 µs; 16 µs for 4 KiB, max 95 µs.
- **Bytes** (README "Gate 2b result"): median transaction 8 697 B full, 461 B patch. The store
  holds 10 payloads (50 493 B).
- **Fetches and uploads.** A cold receiver fetches 9 payloads (31 181 B) and uploads 10 times
  (31 220 B). A warm one fetches 0. Live fetch latency is p50 16.2 ms and p95 16.7 ms whatever the
  size (137 B to 21 955 B): one receiver frame at 60 fps. The retained maximum is 7 hashes
  (49 050 B).

What gate 2 does not prove: glyph atlases and MSDF text (gate 4); textured polygons, meshes and
nine-patch (gate 5); lazy hashing, spill-to-disk, cache eviction and parallel fetches (gate 6);
browser receivers and their HTTP caches (gate 7); non-loopback serving, late join, and the target
game's own textures (gate 8); `CanvasTexture` on a headless host (above).

