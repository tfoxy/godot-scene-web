# render-stream experiment — gates −1, 0, 1, 2, 3, 4, 5 and 5.5: capture seam, first stream, retained state, live delivery, textures, clipping, text, geometry, meshes and materials

Gates −1 through 6 have passed: a GDExtension observes every `RenderingServer` drawing and
texture call on an **unmodified official** Godot release template under `--headless`, ships it
over a versioned wire format (`render-stream/0` through `/6`), and an independent receiver
replays it pixel-exact, live or from a file, surviving stalls, resync and reconnects. Gate 7
(browser receivers) is in progress: see
[protocol/gate7-design.md](protocol/gate7-design.md) and the increments table below. The
baseline phone is the moto g31 (browser receivers must reach 60/60 on 2020-era phones).

## Gates −1 to 6

One row per gate; "Result" links to that gate's file under `results/`.

| Gate | Outcome | Result |
| ---- | ------- | ------ |
| −1 | A GDExtension copies the `RenderingServer` vtable and hooks up to 64 slots with pass-through recording hooks on a stock release template, no engine patch. | [results/gate-minus1.md](results/gate-minus1.md) |
| 0 | One opaque rectangle and a step marker, captured headless, replayed pixel-exact by an independent receiver. | [results/gate0.md](results/gate0.md) |
| 1 | Retained state, patch encoding (`render-stream/1`), live delivery over a loopback WebSocket, draw-index ties, stall/resync/reconnect recovery. | [results/gate1.md](results/gate1.md) |
| 2 | Textures on the wire (`render-stream/2`): content-addressed payloads, live HTTP by hash with pins and retirement, `CanvasTexture` filter/repeat, bearer-token auth. | [results/gate2.md](results/gate2.md) |
| 3 | Nested axis-aligned and rotated/scaled `Control` clips resolve to the engine's own scissor; `canvas_item_add_clip_ignore` hooked. | [results/gate3.md](results/gate3.md) |
| 4 | Grayscale, layout, `RichTextLabel`, multilingual and MSDF text reach the wire host-rasterized, float32-exact against an independent oracle. | [results/gate4.md](results/gate4.md) |
| 5 | Immediate geometry, meshes and styleboxes travel on `render-stream/4`→`/5`; live mesh recovery through dropped presentations. | [results/gate5.md](results/gate5.md) |
| 5.5 | `CanvasItemMaterial` and `ShaderMaterial` (code + params) travel on `render-stream/5`; live shader recovery through dropped presentations. | [results/gate5-5.md](results/gate5-5.md) |
| 6 | Presentation size, font oversampling, snap and rate are session-declared (`render-stream/6`); `CanvasLayer`s, follow-viewport and a committed supported-feature manifest. | [results/gate6.md](results/gate6.md) |

## Gate 7 increments (browser receivers)

Contract: [protocol/gate7-design.md](protocol/gate7-design.md). Landed increments link to their
result under `results/gate7/`; the rest link to their design section under `protocol/gate7/`.

| Increment | Outcome | Link |
| --------- | ------- | ---- |
| G7w | render-stream/7 delta, codecs, golden-7 — landed | [results/gate7/g7w.md](results/gate7/g7w.md) |
| G7j | browser-loadable decoder — landed | [results/gate7/g7j.md](results/gate7/g7j.md) |
| G7h | browser harness, provenance, probes — landed | [results/gate7/g7h.md](results/gate7/g7h.md) |
| G7hp | live legs keep Chromium profiles in a removed temp dir, out of evidence — landed | [results/gate7/g7hp.md](results/gate7/g7hp.md) |
| G7c | `packages/canvas`: vertex colours, premul_alpha, wrap, straight alpha, RGB10_A2 — landed | [results/gate7/g7c.md](results/gate7/g7c.md) |
| G7f | bounded live decode buffer, conditional on G6s | [protocol/gate7/g7f.md](protocol/gate7/g7f.md) |
| G7d | device harness, pace fixture, decode/apply bench — landed | [results/gate7/g7d.md](results/gate7/g7d.md) |
| G7e | web export: build, shims, gate 0 — landed | [results/gate7/g7e.md](results/gate7/g7e.md) |
| G7a | GSW receiver on the Rust core: gates 0–3 file legs — landed | [results/gate7/g7a.md](results/gate7/g7a.md) |
| G7n | capture: /7 listener, hello token, origin, CORS — landed | [results/gate7/g7n.md](results/gate7/g7n.md) |
| G7m | decode/apply microbench on both phones, g31 first — landed | [results/gate7/g7m.md](results/gate7/g7m.md) |
| G7o1 | record digest off the frame path, TypeScript — landed | [results/gate7/g7o1.md](results/gate7/g7o1.md) |
| G7x | the Rust slice: core to `canvas-items` judged on the g31 — landed | [results/gate7/g7x.md](results/gate7/g7x.md) |
| G7b | web export: every gate's file legs — landed | [results/gate7/g7b.md](results/gate7/g7b.md) |
| G7t | GSW text, geometry, meshes: gates 4 and 5 — landed | [results/gate7/g7t.md](results/gate7/g7t.md) |
| G7s | GSW materials and shaders: gate 5.5 — landed | [results/gate7/g7s.md](results/gate7/g7s.md) |
| G7l | live in browsers: gates 1, 2, 5f, 5.5f over /7 — landed | [results/gate7/g7l.md](results/gate7/g7l.md) |
| G7xn | native GDExtension adapter for the core, `RS_RECEIVER_CORE=rust`, off by default — landed | [results/gate7/g7xn.md](results/gate7/g7xn.md) |
| G7xw | web-export dlink adapter for the core, `Web (rust core)`; g7-5 passes on the web; g31 misses scene-full and hd-patch — landed | [results/gate7/g7xw.md](results/gate7/g7xw.md) |
| G7tm | GSW MSDF text (gate 4e): canvas.glsl's MSDF branch in `canvas-items`; `gsw-msdf` retired — landed | [results/gate7/g7tm.md](results/gate7/g7tm.md) |
| G7xwl | the web export's live legs (/7) on the Rust core, `--live --web-core rust`; `receiver-core@web` — landed | [results/gate7/g7xwl.md](results/gate7/g7xwl.md) |
| G7o2 | g31 step transactions: payloads verified on arrival (GSW), deferred digest (web, Rust core); GSW hd-patch p95 13.1→10.6 ms, web-rs scene-full 10.0→7.5 ms (pass), hd-patch still `device-decode-over-budget` — landed | [results/gate7/g7o2.md](results/gate7/g7o2.md) |
| G7xd | flips the native and web-export default to `RS_RECEIVER_CORE=rust`/`Web (rust core)`; `gdscript` frozen at /7, selectable, milestone-swept (D34 amended); full sweep — landed | [results/gate7/g7xd.md](results/gate7/g7xd.md) |
| G7gd | removes the GDScript decode/apply core (user decision 2026-10-21, D34 amended): the Rust core is the only receiver core; `gdscript` selectors, `@gdscript` smoke targets, `receiver-core@*` and the `Web` preset retired — landed | [results/gate7/g7gd.md](results/gate7/g7gd.md) |
| G7o | decode/apply optimization — restructured into G7o1 and tier 2; lands nothing | [protocol/gate7/g7o.md](protocol/gate7/g7o.md) |
| G7g | gate 6 scene and HD on both browsers, both web cores — landed | [results/gate7/g7g.md](results/gate7/g7g.md) |
| G7u | suspension and lifecycle: real hidden/frozen on the g31, desktop `simulated-suspension` never counted; reload, close, context loss pass on gsw and web; D14 amended: a CDP freeze closes the socket (1006), and both receivers recover by gate 1d's reconnect (newest first, no burst, bounded pending), so frozen-30s passes on both; the web fetch timeout counts only running time — landed | [results/gate7/g7u.md](results/gate7/g7u.md) |
| G7r | pacing, rates, phase study, dual on all three receivers (window 1): native 45/45, gsw 59/59, web 76/78 (its fetch tail); no variant holds 60/60 on every phase — landed | [results/gate7/g7r.md](results/gate7/g7r.md) |
| G7wf | the web export's payload GETs through the browser's `fetch` (`JavaScriptBridge`, both web cores): 66.2→2.8 ms p50; web `g7-r` 79/79, `rate-achieved` at 15/30 now passes, good phase 58.4–59.0/s; `fetch-impl@web` — landed | [results/gate7/g7wf.md](results/gate7/g7wf.md) |
| G7o3 | web export stages payloads on arrival like GSW (G7o2); rs-core step-transaction cuts (−23% native, −22% wasm); GSW hd-patch p95 10.7→9.3 ms (still a stretch-target miss); web-rs hd-patch 11.7→11.8 ms, unchanged (its p95 is `RenderingServer`-call bound, `execute` ≈6.4 of a 9.1 ms apply p95) — landed | [results/gate7/g7o3.md](results/gate7/g7o3.md) |
| G7k | startup, memory, soak on both browsers (Rust core): GSW cold 279 / warm 705 ms and web 1815 / 1701 ms to first submit (the HTTP cache removes bytes, not time); 300 s soak holds the 1 MiB budget, flat heaps and GL textures; `no-evict` and `leak-gl-textures` fail exactly their sets (`gpu-mem-bounded` typed `unavailable` for the leak) — landed | [results/gate7/g7k.md](results/gate7/g7k.md) |
| G7uf | live `g7-6` `motion-monotonic@web` flake: not G7u (pre-G7u G7wf fails the same at matched load); causes are outside load (late receipts, host hitches) plus a check boundary (a fetch held a frame by count but under 16.667 ms); no code change, attribution fix proposed — findings | [results/gate7/g7uf.md](results/gate7/g7uf.md) |
| G7mm | `motion-monotonic` counts a receiver hold in frames (`received_process_frame` / `submitted_process_frame` on all three receivers; microsecond rule kept as the fallback and as a second excuse for a slow frame) and is judged as a timing check: load recorded per g6l leg, one automatic rerun of a failed leg above load 4; bound of 2 unchanged — landed | [results/gate7/g7mm.md](results/gate7/g7mm.md) |
| G7q | credit window 2, opt-in (fork F1): ≥ 0.95 × 60 on 15 of 15 phase runs, including GSW at a 1.4-frame RTT; window 1 byte-identical (ten pinned transcripts); browser live groups at window 2 with exact window-w rules; GSW folds in place (its window-2 p95 19.5–28.7 ms, 59.84/s); default flip recommended after G7v | [results/gate7/g7q.md](results/gate7/g7q.md) |
| G7o4 | GSW hd-patch step transactions on the g31: untextured draws merge with textured runs (hd 387→190 calls/frame, pixels unchanged), an id-indexed resolved state, smaller per-frame cuts (step transactions −11 % instructions natively); g31 hd-patch p95 10.61→9.99 ms, still a stretch-target miss about the size of the phone band; the p95 is a per-frame cold start (a 4 ms pre-frame busy-wait diagnostic takes the same build to 6.8–7.3 ms), not instruction count — landed | [results/gate7/g7o4.md](results/gate7/g7o4.md) |
| G7v | phone acceptance on the g31 (g86 descoped by the user): neither browser meets the target at either window; window 2 lifts g31 drawn rates (gsw pace 47→58, scene 36→54; web pace 28→56, scene 9→16), so G7v recommends it as the default; GSW misses on `phase-alias` at a 58.8 Hz panel, the web export on Godot's own 15–36 ms iteration — landed | [results/gate7/g7v.md](results/gate7/g7v.md) |
| G7p | `render-stream-report/2` (browser, device and env fields, validated with sabotages), the `g7-p` matrix driver on all three receivers, and the g31 device rows from G7v's run; the g86 is descoped | [results/gate7/g7p.md](results/gate7/g7p.md) |
| G7z | three manifests, gate 7 summary | [protocol/gate7/g7z.md](protocol/gate7/g7z.md) |

## Protocol docs

- Per-gate contracts: `protocol/gate0-design.md` … `protocol/gate6-design.md`,
  `protocol/gate5_5-design.md`, [protocol/gate7-design.md](protocol/gate7-design.md).
- Wire formats: `protocol/render-stream-0.md` through
  [protocol/render-stream-7.md](protocol/render-stream-7.md) (each version supersedes the last;
  `/7` is live-transport-only).
- Feature manifests: `protocol/features/`. Golden vectors: `protocol/golden/` through
  `protocol/golden-7/`.
- Topical notes: `protocol/canvas-texture-headless.md`, `protocol/unknown-item-skip.md`.

## Where things are

- `capture/` — the GDExtension that hooks `RenderingServer` on the pinned binary.
- `receiver/` — the native (GDScript) receiver project.
- `rs-core/` — the shared Rust core (packed draw list, wasm/TS boundary; gate 7 track).
- `decode-proto-rs/` — Rust decode prototyping ahead of `rs-core`.
- `web/` — browser harness, bench and the web-export build.
- `calibration/` — committed calibration records, keyed by engine binary hash.
- `fixtures/` — scene fixtures used by gate runners and goldens.
- `scripts/` — gate runners (`run-gate*.sh`), `check-gate*.ts`, `analyze-*.ts`; see
  `scripts/README.md`.
- Measurement isolation (the per-leg quiet lock every runner takes):
  [results/measurement-isolation.md](results/measurement-isolation.md).
- Gate runtime (GRT: the lock's v2 scheduling, the input-keyed source cache, the smoke tier
  `scripts/validate-increment.sh` and the parallel-legs verdict): [results/grt.md](results/grt.md).
- Milestone sweeps: the pre-G7v sweep at c9026a06, each failure's cause and owner, and the
  supplementary g7-r/g7-k runs: [results/sweep-pre-g7v.md](results/sweep-pre-g7v.md).
- `results/` — this experiment's result write-ups, one file per gate (−1…6, 5.5) and one per
  gate-7 increment under `results/gate7/`, plus topical write-ups that aren't a single gate's
  result (e.g. `results/receiver-decode-profile.md`).
- `protocol/` — the versioned wire-format specs, per-gate design contracts and gate 7's design,
  with its own increments under `protocol/gate7/`.

## Docs layout

This README is an index, not a result log. When a new gate-7 increment lands:

- its result write-up goes in a new `results/gate7/<id>.md` (lowercase increment id, e.g.
  `g7xn.md`), and
- its row in the "Gate 7 increments" table above gets one line pointing at that file.

Its design note (the "As built" section included) stays in `protocol/gate7/<id>.md`, where the
increment's design already lives. Sections that are not a single gate's result (a fix note, a
profiling write-up, etc.) go in their own topical file under `results/`, named for the topic, with
a link added here rather than inline prose.
