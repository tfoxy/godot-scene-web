## G8kb result (2026-10-24)

G8kb ([protocol/texture-delivery-design.md](../../protocol/texture-delivery-design.md) "Increments"
G8kb, D6, D14, D15, Q3, Q6 "GSW" and "As built (G8kb)") passes: the GSW canvas receiver takes
`uastc` variants at render-stream/9. A basisu 1.60 transcoder wasm (the vendored D15 sources, the
pinned emscripten 4.0.11, nothing downloaded) runs in a Web Worker; GSW verifies each KTX2 in rs-core
before posting it, transcodes it to Godot's D14 target for its own WebGL context, and uploads the
blocks through `gl.rs`'s `compressedTexImage2D` (ASTC 4x4 and ETC1 on the g31, BC7 on the desktop,
RGBA8 where the context has none). It advertises `uastc` in its /9 hello, keeps or upgrades by D6
(upgrade on a phone-class context), and falls back to `decoded` when a transcode fails. Its live /9
hello ran for the first time (g8l's new `basis` leg).

### What landed

| part | where |
| ---- | ----- |
| transcoder wasm (C wrapper, D14 in C, build script, digest-keyed reuse) | `web/basis-transcoder/transcoder.cpp`, `scripts/build-basis-transcoder.sh` |
| Web Worker, main-thread client, message types, WebGL's BC alignment rule | `web/basis-transcoder/{worker,client,protocol}.ts` |
| the arrival path (verify, transcode, stage, fallback), both modes | `web/gsw-receiver/transcode.ts`, `main.ts`, `live.ts`, `fetcher.ts` (async staging), `source.ts` (`.ktx2`), `config.ts`, `evidence.ts`, `common.ts` |
| wasm API: `is_ktx2`, `stage_ktx2`, `stage_transcoded`, `transcode_failed`; default `block,uastc,decoded`; D6 default | `web/gsw-rs/src/lib.rs` |
| D6 `keep` in the browser applier (`kept` map, resident version), `DeliveryPrefs::refuse`, `texture_transcoded`, `verify_ktx2`, `PayloadStage::put` | `rs-core/src/apply/{mod,payloads,residency}.rs`, `rs-core/src/delivery.rs` |
| the bundle carries the worker and the wasm | `scripts/lib/gsw-bundle.ts`; the remote workflow restores emsdk for every g7 job |
| g7-8: g8kp and g8ku in the source; GSW legs and checks | `scripts/run-gate7.sh` (`G8_FILE_LEGS`), `scripts/lib/gate7-gsw-g8.ts`, `scripts/lib/gate7-gsw-g8-checks.ts` |
| g8l `basis` (/9 live) | `scripts/run-gate8.sh`, `scripts/lib/gate8-live-checks.ts`, `scripts/lib/gate8-adopt-checks.ts` (`loadRecording` version), `scripts/lib/gate7-live-legs.ts` (browsers may ask for /9) |
| the bench arm | `scripts/gate7-bench.ts --arm gsw-basis`, `web/bench/basis.{html,ts}` |
| self-test, smoke-map rule | `scripts/test/self-test-gate8kb.ts`, `scripts/smoke-map.json` |

### Checks (development host, RTX 2060)

| check | result |
| ----- | ------ |
| transcoder vs Godot (Node, the store's 5 KTX2) | BC7 blocks of every level equal the native oracle's `data_sha256` bit for bit (`Image.load_ktx_from_buffer`, libktx) |
| `gsw-transcode-oracle@gsw` | pass: 5 transcodes, 4 on the oracle's BC7 and bit-identical; npot (150x110) RGBA8 by the WebGL alignment rule |
| `gsw-delivery-policy@gsw` | pass: upgrade re-uploads the 5 uastc textures at seq 12 exactly as native; keep uploads equal native's, no transcode |
| `gsw-delivery-pixels@gsw` | pass: within channel 1 of the native upgrade and keep legs, except the half-size mip draw (declared: GSW uploads level 0 only) and npot (RGBA8: 46.2 dB against the procedural reference) |
| `gsw-transcode-rgba@gsw` | pass: every family masked, 6 RGBA8 transcodes at 46.2-63.3 dB |
| `gsw-transcode-fallback@gsw` | pass: 5 `delivery-transcode-failed` rows, no uastc upload, final image equals keep's exactly |
| `sabotage-perturb-ktx2@gsw` | pass: GSW refuses the perturbed KTX2 with `resource-hash-mismatch` before transcoding |
| `delivery-select@gsw`, `delivery-pixels-native@gsw` (g8kp in g7-8) | pass (block where the family is stated, decoded under the mask; pixels through the band) |
| g7-8 GSW file half (`run-gate7.sh --receiver gsw --legs g7-8 --make-sources`) | `gate_passed=true`; `gsw-band@gsw` 78 shots, other 0 |
| native g8l with `basis` (`run-gate8.sh --legs g8l`) | 30/30, including `g8l-basis-{host,live,states,delivery}` and `live-replay-equals-live-g8l-basis` |
| g7-8 live, GSW (`run-gate7.sh --live --legs g7-8`) | see "Runs" |

### The g31 (moto g31, Mali-G52, Chrome 155, ETC2 + ASTC only; real time)

Battery 100 % on USB power throughout, battery temperature 24.4-26.4 °C, thermal status 0 before and
after every run; Chrome was running before and is running after (the GPU-memory runs restart it
between arms, see below).

**Transcode cost in GSW's worker** (`gate7-bench.ts --arm gsw-basis --env device --device g31`, the
fixture's 6 KTX2, warmup 1 + 5 repeats; ms per Mpx of every level transcoded, the worker's own
`bt_transcode` time; two runs):

| target (D14) | used for on the g31 | ms/Mpx run 1 / run 2 | round trip ms/Mpx |
| ------------ | ------------------- | -------------------- | ----------------- |
| ASTC 4x4 | RGBA textures | 56.8 / 77.3 | ~73 |
| ETC1 (`ETC2_RGB8`) | RGB textures | 129 / 117 (small textures only: per-call overhead) | |
| ETC2 RGBA8 | not taken (ASTC ranks first) | 83.7 / 81.6 | |
| RGBA8 | none | 57.0 / 56.6 | |
| BC7 (not uploadable here) | | 61.0 / 63.6 | |

In the real receiver (file mode on the g31, `gl.rs` uploads): the 1024x512 texture's ASTC transcode
took 58.8 ms (112 ms/Mpx, cold), the page's first transcode 21.9 ms for 0.02 Mpx (the worker's
table setup is ~150 ms at start, off the main thread). The desktop worker is 25-36 ms/Mpx (native
basisu 3-10 ms/Mpx, G8ku; the web export's engine call 38 ms/Mpx).

**GPU memory** (64 copies of each texture uploaded through GSW's calls, Chrome restarted before
each arm because a freed texture's memory is pooled by the GPU process; delta on the same page
before/after its uploads):

| delivery | level-0 bytes uploaded | Lost RAM delta | MemAvailable delta |
| -------- | ---------------------- | -------------- | ------------------ |
| decoded (RGBA8) | 149.6 MiB | +157 / +163 MB | -171 / -175 MB |
| uastc (ASTC 4x4 + ETC1) | 36.4 MiB | +17 / +22 MB | -12 / +29 MB (noise) |

The Mali driver's texture memory is invisible to the process's memtrack (`EGL mtrack` of Chrome's
GPU process stays 7,971 KB in every arm) and to `dumpsys gfxinfo com.android.chrome` (HWUI's own
caches: 4.0 MB + ~0.8 MB in every arm); it shows up as system `Lost RAM` (`dumpsys meminfo -S`). So
on the g31 the transcode costs a quarter or less of `decoded`'s memory, as Q6 predicts (1 B/px ASTC,
0.5 B/px ETC1, 4 B/px RGBA8).

**hd-patch p95 unchanged** (`gate7-bench.ts --interleave gsw-rs-base,gsw-rs --env device --device
g31 --only hd-patch --rounds 5`, G7o2's before/after protocol; base = main ca12d291's rs-gsw-wasm,
inputs `artifacts/render-stream/gate7/g7o1-inputs`): total p95 per round, T_p 17.0 ms:

| build | r1 | r2 | r3 | r4 | r5 | median |
| ----- | -- | -- | -- | -- | -- | ------ |
| main (ca12d291) | 10.57 | 10.56 | 9.14 | 9.63 | 9.43 | 9.63 |
| G8kb | 8.63 | 8.45 | 8.51 | 8.43 | 9.63 | 8.51 |

No regression: G8kb's rounds are at or below main's, inside the phone's known ±1 ms band (G7o4:
9.33-10.61 for one build; G7z's own g31 runs were live g7-dev, not this bench). A /7 recording
lists no variants, so the only new work on this path is the applier's `kept` lookup.

**Real GSW on the g31**: the receiver replaying g8ku's upgrade recording took D14's ASTC 4x4 for the
four RGBA textures (the 150x110 one included: ASTC has no alignment rule) and ETC1 for the two RGB
ones, uploaded through `gl.rs` without a GL error, status ok. Against the procedural reference:
ASTC regions 44.9-54.2 dB; ETC1 34.7 dB (rgb) and **18.8 dB on bc1's per-pixel noise** (ETC1's two
colours per 2x4 subblock; the decoded arm draws 48.2 dB there). See "Open for the orchestrator".

### Deviations from the design

- **WebGL's BC alignment rule ahead of D14.** WebGL refuses an S3TC/BPTC/RGTC level 0 that is not
  4-aligned, so GSW drops those families for such a texture (the desktop then takes RGBA8 for it;
  phones take ASTC/ETC2, which have no such rule). Godot's rule alone would pick BC7 and fail to
  upload.
- **Level 0 only** (as every GSW upload, G8kp): a mipmapped transcode's level 0 is uploaded; the
  half-size mip draw is a declared region in `gsw-delivery-pixels`.
- **`upgrade` is GSW's default on a phone-class context** (neither bptc nor s3tc), `keep` otherwise:
  D6 names `upgrade` "the phone default" without saying how a receiver knows it is a phone.
- **g8ku's GSW legs are GSW-only legs** judged by new `gsw-*` checks, not replacements of the native
  legs: GSW's target differs from the native receiver's where WebGL forbids BC (npot), so g8ku's
  native-target checks cannot judge them as they stand. The perturbed-KTX2 sabotage replaces the
  native leg (`sabotage-perturb-ktx2@gsw`).
- **The web export's g8l `basis` leg is not run** (`not-applicable.txt`): live, the web export draws
  the 150x110 texture wrong (16,500 px, up to 255) while its replay of the same sink draws it right;
  WebGL refuses that BC7 level 0, and the web export has no alignment rule. A web-export defect for
  G8kf (evidence: `artifacts/render-stream/gate8/g8kb/web-npot-defect/`).
- **g7-8's web half does not replay g8kp's and g8ku's legs** (`gsw-only-group`, listed by
  `legs-not-replayed@web`). The first full tier replayed them and failed `g7-web-rust@g7-8`:
  `console-clean@web` (the web export's g8kp block uploads: `WebGL: INVALID_ENUM:
  compressedTexImage2D: invalid format`), `pw1-classes@web` (g8kp legs 77,881 px unexplained, g8ku
  receiver-upgrade 16,500 px: the npot BC7) and `applied-equals-native@web` (g8kp: the web export
  fetches different payloads). The web export's /9 delivery is G8kf's; its own g8ku leg stays where
  G8ku put it (`g8ku-web/web`, blocks only).
- **GPU memory is measured by `Lost RAM`/`MemAvailable`, not gfxinfo**: gfxinfo does not see WebGL
  textures on this phone (recorded anyway).
- **Upload failures** are not detected (no `getError` after `compressedTexImage2D`); D14 plus the
  alignment rule choose only formats the context accepts.

### Not done here (out of scope, with owners)

| item | owner | state after G8kb |
| ---- | ----- | ---------------- |
| `delivery-transcode-failed` fallback in the native receiver and the web export | G8kf | still a typed replay failure; rs-core's `DeliveryPrefs::refuse` is the core half |
| the web export's block-variant uploads (`INVALID_ENUM`) and non-4-aligned BC uploads (g8l basis web leg, `g8ku-web` pixels) | G8kf | not replayed in g7-8's web half; g8l basis not run for the web export |
| ETC1S (`basis-etc1s`), its g31 ETC1S -> ETC2 cost | G8ke | refused at /9 |
| phone-performance work on the transcode | none (user: g31 is good enough) | measured only |
| GSW mip levels beyond 0, GL error read-back on upload | later | level 0; no read-back |

### Runs

| what | where | result |
| ---- | ----- | ------ |
| remote full tier, every non-timing run the plan reaches (pure, cargo x3, bench-instr, native gates -1 to 8 with sabotage legs, g7-gsw, g7-web-rust, g7live-gsw, g7live-web-rust) | run [40128033714](https://github.com/tfoxy/godot-scene-web/actions/runs/40128033714) | 17/18 pass; `g7-web-rust@g7-8` failed on the web export replaying g8kp/g8ku (see Deviations), fixed by the `gsw-only-group` exclusion |
| the refused group, locally (`--and-local`: g7live-gsw and g7live-web-rust, g7-1) | local NVIDIA | 2/2 pass |
| GSW g7-8 file half (`--make-sources`) | local NVIDIA | `gate_passed=true` (every `gsw-*` check, `delivery-select`, `delivery-pixels-native`, `sabotage-perturb-ktx2` @gsw) |
| GSW g7-8 live half | local NVIDIA | 31/31, `g8l-basis-*@gsw` and `live-replay-equals-live-g8l-basis@gsw` (0 px) included |
| web g7-8 live half (basis not applicable) | local NVIDIA | all pass (28) |
| native g8l with `basis` | local NVIDIA | 30/30 |
| smoke subset (pure, cargo-rs-core, -capi, gsw-rs) | local | 4/4 |
| web g7-8 file half after the exclusion (on the earlier local source) | local NVIDIA | every check but `source-run-valid@web` (the local source predates the last edits; the remote rerun made its own) passes; `legs-not-replayed@web` lists the six `gsw-only-group` legs |
| remote rerun of g7-web-rust (every web group) | run [40132299292](https://github.com/tfoxy/godot-scene-web/actions/runs/40132299292) | 1/1 pass (9/9 group jobs) |

Not run, by the brief: the timing runs (native gate 6, `g7live-*-timing`, `g7live-native-timing`,
g7x), the remote's skipped timing groups (g1c-rate, g1d, g2c-pins, g5f, g55f, decode-cost) and
`lock-tests`, deferred to the pre-release delta sweep. The plan reached every target (rs-core's
applier and `lib/legs.sh` are shared).

### Open for the orchestrator

- **ETC1 for RGB on ETC-only phones is lossy on noisy content** (18.8 dB on bc1's noise on the g31,
  34.7 dB on a gradient) because Godot's 3-component rule never takes ASTC; UASTC -> ASTC 4x4 is a
  near-lossless repack at 1 B/px (vs ETC1's 0.5). A user fork if RGB art quality on the phone
  matters: keep Godot's rule (every receiver holds the same blocks, D14) or let GSW take ASTC for 3
  components.
- Godot's KTX2 loader names an ASTC 4x4 UNORM transcode `FORMAT_ASTC_4x4_HDR`; a native receiver on
  an ASTC device may then upload it as HDR (not exercised: no native phone receiver).

### Time

Wall time about 2 h 45 min (15:38 to 18:23). Writing about 1 h 40 min: the transcoder and worker
25 min, rs-core/gsw-rs and the receiver's arrival path 30 min, g7-8 legs and checks 20 min, g8l
`basis` 10 min, the bench arm 15 min, docs, and the web exclusion after the first remote tier.
Validation about 2 h 20 min of wall time, mostly overlapping the writing: local development runs
(g8ku, g8l twice, the GSW g7-8 file half 12 min, four live halves about 40 min, two local web
halves 16 min, the smoke subset 14 min), the g31 runs (about 40 min across transcode, GPU memory,
the receiver and hd-patch), the remote full tier 44 min (local g7-1 7 min beside it) and the remote
web rerun 22 min.
