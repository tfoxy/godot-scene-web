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
| G7o | decode/apply optimization — restructured into G7o1 and tier 2; lands nothing | [protocol/gate7/g7o.md](protocol/gate7/g7o.md) |
| G7g | gate 6 scene and HD on both browsers, both web cores — landed | [results/gate7/g7g.md](results/gate7/g7g.md) |
| G7u | suspension and lifecycle | [protocol/gate7/g7u.md](protocol/gate7/g7u.md) |
| G7r | pacing, rates, phase study, dual | [protocol/gate7/g7r.md](protocol/gate7/g7r.md) |
| G7k | startup, memory, soak | [protocol/gate7/g7k.md](protocol/gate7/g7k.md) |
| G7q | credit window 2 — fork F1, opt-in | [protocol/gate7/g7q.md](protocol/gate7/g7q.md) |
| G7v | phone acceptance on both phones, g31 first | [protocol/gate7/g7v.md](protocol/gate7/g7v.md) |
| G7p | measurement matrix, report/2 | [protocol/gate7/g7p.md](protocol/gate7/g7p.md) |
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
