# Gate 8g result (2026-10-24)

G8g ([protocol/gate8-design.md](../../protocol/gate8-design.md) "Increments" G8g, D14, Q7 and
"As built (G8g)") passes. Gate 8's recordings, one live leg per fixture and D14's reverse-proxy leg
run through both browser receivers, the GSW canvas receiver (`gsw`, Rust core) and the Godot web
export (`web`, Rust core), as gate 7 group `g7-8`. Every check of check-gate8.ts that reads a
receiver leg is judged in each browser's view, and every g8l live check passes in both.

## What the code does

- **`g7-8`, file half.** `run-gate7.sh --legs g7-8` makes one native gate 8 source
  (`run-gate8.sh --legs g8t,g8a,g8h,g8f,g8m`) and replays its 23 file receiver legs (g8t's
  decoded textures, g8f's floats, g8a's adoption with G8r's lazy resources and faults, g8h's late
  presentation size, g8m's adopted materials) in each browser. The web half is one `GATE7B_GATES`
  entry, judged through G7b's native, blank, web and banded views. The GSW half is
  `lib/gate7-gsw-g8.ts` and `lib/gate7-gsw-g8-checks.ts`.
- **GSW is judged against the native leg of the same recording** (deviation below): a GSW shot
  whose every pixel differing from the native shot is within channel 1, or inside a region the
  fixture scene declares (gate8-tex's linearly filtered row B, its nearest-stretched nine-patch row C
  and its nearest-stretched region row D as `undecided`; the float scene's two gain-scaled strips as
  `excluded`,
  `float-texture-quantized`), stands in for the native shot, and the gate's own checks judge it.
- **GSW floats.** GSW takes every float payload as RGBA8 through rs-core's `texture_rgba8`
  (`golden-8/float-quantize.json`) and now reports it: applied.json `receiver.caveats`
  `["float-texture-quantized"]` with `receiver.float_quantized` (the formats).
- **`g8l`, a new native live group in run-gate8.sh**, and its browser half
  (`run-gate7.sh --live --legs g7-8`). Per fixture (tex, float, adopt, size, mat): a live host at
  render-stream/8 with its /8 file sink under the fixture's own policy, a rendered live receiver, and
  that receiver replaying the host's file sink; plus `proxy`, tex through
  `scripts/lib/reverse-proxy.ts` (an HTTP/1.1 reverse proxy: Host rewritten, X-Forwarded-*, the
  WebSocket upgrade and every GET forwarded).
- **Receivers speak /8 live on request.** `RS_RECEIVER_PROTOCOL=8` (native receiver.gd and
  rs_live_client.gd, the web export through them, GSW's live.ts and its wasm `live_session`)
  offers `render-stream.8` only, sends /7's hello with protocol `render-stream/8`, and taps
  `received.rs8`. Defaults are unchanged (/6 native, /7 browsers).
- **Unique check ids**: g8f's `sabotage-perturb-decode` is now `float-sabotage-perturb-decode` and
  g8m's `adopt-reference` is `mat-adopt-reference`.

## Checks

### File half (`g7-8`, 23 receiver legs per browser)

| receiver | gate 8 checks judged `@<kind>` | other g7-8 checks |
| -------- | ------------------------------ | ----------------- |
| web (rust) | 18/18 pass: `decode-reference`, `sabotage-perturb-decode`, `g8a-legs`, `adopt-reference`, `fault-no-resources`, `fault-atlas-from-dummy`, the three adopt sabotages, `g8h-legs`, `late-size-reference`, `late-size-needed`, `sabotage-size-before-adopt`, `float-exact`, `float-sabotage-perturb-decode`, `g8m-legs`, `mat-adopt-reference`, `adopt-include-refused`; 7 of them only within G7b's readback/delta1 band (raw: 11/18) | browser-provenance, console-clean, evidence-complete, applied-equals-native, web-refusals, compositor-equals-readback (12 legs exact), web-repeat-identical (71 shots), legs-not-replayed; pw1-classes: 71 shots, readback 2,956,177 px, delta1 21,505, other 0 |
| gsw | the same 18/18 pass through the band | browser-provenance, console-clean, evidence-complete, no-source-scene, record-digest-complete (712 transactions), compositor-equals-readback per fixture (5, all comparable and exact), `float-texture-quantized@gsw` (RF, RGF, RGBF, RGBAF, RH, RGH, RGBH, RGBAH quantized on both g8f legs; g8t's receiver has no caveat); `gsw-band@gsw`: 71 shots, 1 identical, 70 within the band (delta1 3,130,885 px, undecided 94,611, excluded 32,880, other 0) |

The hardware-vs-CPU band (`decode-hardware-band`, reference-hw against reference: S3TC/BPTC 23,827
px at max delta 5, ETC2/ASTC 0 px) is G8t's and does not read a receiver leg; both browsers draw the
host's CPU decode, so `decode-reference` is the receiver check, and it passes in both views.

### Live half (`g8l`, 6 legs per receiver)

| receiver | checks |
| -------- | ------ |
| native (run-gate8.sh --legs g8l) | 25/25: `g8l-<f>-host`, `-live`, `-states`, `live-replay-equals-live-g8l-<f>` for tex, float, adopt, size, mat, proxy, and `g8l-proxy-fronted` (1 upgrade, 13 GETs through the proxy) |
| gsw | every g8l check that reads a browser leg (19) `@gsw`, plus native-legs, live-run, live-vs-replay, browser-provenance, console-clean, hello-recorded (6 connections at version 8), credit-from-paced-loop, token-not-logged: all pass |
| web (rust) | the same `@web`, plus fetch-impl (65 GETs, browser fetch): all pass |

`-states` is timing-independent: each live transaction of `received.rs8` equals the host's /8
file-sink state at its frame (e.g. tex: 285 live against 300 file transactions on both browsers),
and the final images equal the same receiver's replay exactly (0 px) everywhere.

## Deviations from the design

- **GSW pixels: a band against the native leg, not gsw-tolerance.json masks.** Q7's GSW policy
  judges a GSW shot against the rendered reference under masks derived from each gate's model.
  Gate 8's fixtures have no per-pixel model, and gate 8 asks what the /8 additions deliver, not how
  GSW rasterizes. So GSW is judged as the web export is: against the native receiver's same leg,
  within channel 1, plus regions declared from the scenes (never from a GSW run). Measured: no
  pixel outside the band.
- **GSW float-exact holds only outside the two gain-scaled strips.** `clamp(v * gain)` of an HDR
  value differs from the same of a value GSW already clamped at 1; those two strips are excluded
  with the typed reason `float-texture-quantized`, which its own check judges.
- **A new native group.** Gate 8 had no live leg, so G8g adds `g8l` to run-gate8.sh (and to its
  default groups) instead of only a browser runner entry: the live legs exist natively first, and
  the browsers rerun them, as every other gate 7 live group does.
- **Check ids renamed** (above), because a gate 7 view keys checks by id.

## Remote capability

`g7-8` is remote-capable on lavapipe, file and live halves, with no refusal: a `--determinism 2,1`
dispatch over g7-gsw, g7-web-rust, g7live-gsw and g7live-web-rust restricted to g7-8 (run
[40088061009](https://github.com/tfoxy/godot-scene-web/actions/runs/40088061009)) agreed over 12
runs, 205/205 shots and 70/70 dumps. That run also found the missing row D region (GSW failed
`decode-reference@gsw` deterministically, 5.9k px up to delta 42 outside the declared regions,
because lavapipe's GSW resolves row D's ties unlike the native receiver while NVIDIA's matched);
with row D declared, the full tier passes g7-8 on the runners. The four run ids were already in
`remote.capable`; `capable_doc` records the verdict.

## What ran

| what | where | result |
| ---- | ----- | ------ |
| development: native gate 8 source (g8t..g8m), web and GSW file halves on it, native g8l, both browsers' live halves | local NVIDIA | source 57/57; web 18/18 `@web` within the band; GSW 18/18 `@gsw` through the band; native g8l 25/25; live gsw and web all pass |
| remote determinism, g7-8 only | run 40088061009 | agrees over 12 runs (above) |
| remote full tier | run [40090159686](https://github.com/tfoxy/godot-scene-web/actions/runs/40090159686), evidence `artifacts/render-stream/gate8/g8g/remote-full/` | 15/15 runs pass: pure, cargo-gsw-rs, native gates -1, 0, 1, 2, 3, 4, 5, 55 and 8 (with g8l and their sabotage legs), g7-gsw and g7-web-rust (g7-0..g7-6, g7-55, g7-8), g7live-gsw and g7live-web-rust (g7-2, g7-5, g7-55, g7-8) |
| local, the group the remote refuses | `RS_VALIDATE_GROUPS=g7-1 validate-increment.sh --tier full --only g7live-gsw,g7live-web-rust` | gsw 38/38, web/rust 39/39 |
| after rebasing onto G8kp (bfbb874b; conflicts in the receivers' hello code, both now offering .7, .8 or .9 by `RS_RECEIVER_PROTOCOL`) | local NVIDIA | native `run-gate8.sh --legs g8kp,g8l` 34/34; `run-gate7.sh --live --legs g7-8` both browsers 55/55; GSW file half 18/18 `@gsw`, band other 0; smoke `g7live-{gsw,web-rust}-g7-1` 2/2 (the /7 hello path) |

The plan reached every target (receiver.gd, rs_live_client.gd and lib/legs.sh are shared). Not run,
by the brief: the timing runs (native gate 6, `g7live-*-timing`, `g7live-native-timing`, `g7x`),
the remotely skipped timing groups (g1c-rate, g1d, g2c-pins, g5f, g55f, decode-cost) and
`lock-tests`. A first full-tier dispatch (run 40089466386) was cancelled after `pure` shard 1
failed `self-test-validate-tier`: g7-8 in the combined correctness live run had turned fast frames
off for g7-1/2/5/55 there; validate-increment.sh now counts g7-8 among the fast-eligible groups (its
own g8l legs are not in `RS_FAST_ALLOW_LEGS`, so they stay real time).

## Out of scope, and why

- `/9` delivery legs. G8kp landed during G8g; its `g8kp` group already runs its own GSW legs
  (`gate8-delivery-tool.ts`, inside run-gate8.sh) and the web export does not speak /9, so g8kp is
  not in `g7-8` yet. G8kb (GSW Basis) or a web /9 increment adds it: one word in `G8_FILE_LEGS`
  and `GATE8_FILE_GROUPS` and one entry per leg in `GATE8_LEGS`. The receivers' live hello now
  takes `RS_RECEIVER_PROTOCOL` 7, 8 or 9 (9: native and GSW only, G8kp's).
- The phone, and every timing group (gate 8's `decode-cost` runs in the native source only; it
  judges no receiver leg).
- Pixel models of GSW for the gate 8 fixtures (the band above stands in).
- Fast frames for g8l: its checks are frame- and state-based, so its legs could join
  `RS_FAST_ALLOW_LEGS`, but they stay real time until a fast run proves them (each leg costs ~5 s).

## Feature manifests (for G8z)

`protocol/features/render-stream-8/` should record, per receiver kind:

- every kind reads GRS8 files and speaks /8 live with `RS_RECEIVER_PROTOCOL=8` (`stream_protocols`
  gains `render-stream/8`); a product receiver behind a gate 8 policy host must set it;
- `gsw-canvas`: float payload formats `supported` with exactness `quantized` and the caveat
  `float-texture-quantized` (evidence `float-texture-quantized@gsw`, `float-exact@gsw`); decoded
  textures, adopted items, adopted materials and the late presentation size `supported` within the
  native band (evidence the 18 `@gsw` checks of `g7-8`);
- `web-export`: the same entries within G7b's readback/delta1 band, floats sampled natively (no
  caveat);
- `native`: unchanged entries plus /8 live (`g8l`);
- D14: `reverse-proxy` fronting supported with no wire change (evidence `g8l-proxy-fronted@*`).

## Time

Wall time 2 h 45 min. Writing about 1 h 15 min, the G8kp merge 15 min. Validation: development
runs about 25 min, remote determinism 14 min, the cancelled and the passing full tiers 10 + 52 min
(with local g7-1, 6 min, beside them), the post-rebase reruns 35 min; the remote waits overlapped
with writing the docs.
