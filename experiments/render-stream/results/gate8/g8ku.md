## G8ku result (2026-10-24)

G8ku ([protocol/texture-delivery-design.md](../../protocol/texture-delivery-design.md) D1, D6, D12,
D13, D14, D16, Q5, Q6 and "As built (G8ku)") passes: `basis-uastc` texture delivery works end to
end at render-stream/9 on the host, the native receiver and the web export. A /9 capture under
`GRC_TEXTURE_DELIVERY=basis-uastc` publishes every texture at once with its `decoded` payload (and
`block` for a block source), encodes a UASTC KTX2 for each D12-eligible texture on its own encode
pool, and publishes each one lazily as a patch entry with one more variant at an equal `version`.
The native receiver and the web export pick it by D3, verify its hash in rs-core, transcode it
with Godot's own `Image.load_ktx_from_buffer` (D14: BC7 on this GPU) and upload the blocks, which
equal an independent transcode of the same payload bit for bit; their pixels equal the fixture
drawing that transcode exactly. The default UASTC level is **1**, chosen on speed and PSNR below.
`rgba`, `passthrough` and every /6 to /8 stream are byte-identical to `main`.

### What landed

| part | where |
| ---- | ----- |
| capture: the policy (`GRC_TEXTURE_UASTC_LEVEL`, `GRC_TEXTURE_BASIS_MIN_PX`, `GRC_TEXTURE_ENCODE_WORKERS`, the `GRC_TEXTURE_ENCODE_WAIT_FRAME` test knob, the `perturb-ktx2` fault), D12, the uastc variant, the counters | `capture/src/rs_texture_delivery.*`, `entry.cpp` |
| the encode pool and job (GRT1 levels to RGBA8, UASTC, SHA-256) | `capture/src/rs_texture_basis.*`, `rs_texture_worker.*` (`discard_queued`), `rs_basis_encode.*` (the level, `encoder_name`, `transcode_rgba8`) |
| lazy variants (D6) at the frame boundary | `capture/src/rs_mirror.*` (`service_basis`), `entry.cpp` (`stream_publish`, `encoders_finish`) |
| store and HTTP | `rs_publish.cpp`, `rs_resource_store.cpp` (`<hash>.ktx2`, index `texture-ktx2`), `rs_ws.cpp` (`image/ktx2`) |
| G8kc's persisted cache (rebased onto 229a93cc) | `rs_texture_basis.cpp` (get before encoding, put after), `entry.cpp` (`texture_cache.encodes`); g8kc's `uastc-cold`/`uastc-warm` legs, `cache-cold`/`cache-warm` and `self-test-gate8kc.ts` |
| D3 with uastc, D6 keep/upgrade | `rs-core/src/delivery.rs` (`select`, `keeps`, `upgrade`) and its tests |
| native receiver | `rs-core-capi` (`Payloads::ktx2` with `check_ktx2_shape`, `KTX2_FORMAT`, `ktx2_hashes`, `rsc_set_variant_upgrade`, `rsc_sha256_hex`), `receiver/ext/rs_core_ext.cpp` (`make_ktx2_image`: `Image.load_ktx_from_buffer`, the transcode log), `receiver.gd`, `rs_rust_applier.gd`, `rs_resource_cache.gd` |
| web export | the same files: it now reads the delivery variables and may speak /9 |
| gate 8 group g8ku | `fixtures/gate8-basis/`, `scripts/run-gate8.sh` (`run_g8ku`), `scripts/gate8-delivery-tool.ts` (`web-legs`), `scripts/lib/gate8-basis-checks.ts`, `scripts/check-gate8.ts`, `scripts/test/self-test-gate8ku.ts` |
| the level bench | `capture/test/rs_basis_level_bench.cpp`, `scripts/test/g8ku-png-to-rgba.gd` |

### UASTC level (development host, Ryzen 5 5500, single thread, 2026-10-24)

`rs_basis_level_bench` on raw RGBA8 conversions (in a scratch directory, never the repository) of
six recovered STS2 PNGs read in place from `../sts2-couch-coop/.sts2/toolchain/recovered-project/images/`,
and the fixture's five eligible 16-20 kpx textures; one level, best of 1 (STS2) or 5 (fixture),
PSNR over RGBA through basisu's transcoder to RGBA8. Only numbers are kept.

| image | size | ms/Mpx L0 / L1 / L2 | PSNR dB L0 / L1 / L2 | KTX2 B/px L1 |
| ----- | ---- | ------------------- | -------------------- | ------------ |
| card portrait (RGB) | 1000x760 | 181 / 707 / 2502 | 47.2 / 50.2 / 50.5 | 0.22 |
| hand sprite (alpha) | 422x1200 | 209 / 562 / 1575 | 50.3 / 50.8 / 51.6 | 0.27 |
| vfx noise | 500x500 | 226 / 1047 / 3853 | 56.2 / 57.4 / 60.6 | 0.43 |
| event art (mostly flat) | 3440x1616 | 46 / 93 / 292 | 58.4 / 61.8 / 62.2 | 0.04 |
| epoch portrait (RGB) | 810x500 | 235 / 970 / 3648 | 40.8 / 43.4 / 43.5 | 0.67 |
| relic icon (alpha) | 256x256 | 233 / 820 / 2795 | 49.4 / 49.9 / 51.2 | 0.46 |
| card atlas (alpha) | 4032x4032 | 242 / 1008 / not run | 37.2 / 42.8 / — | 0.59 |
| fixture (5 textures) | 16-20 kpx | 237-332 / 1198-1461 / 4260-5794 | 44.2-53.5 / 44.8-54.0 / 44.9-54.6 | 0.65-0.96 |

**Level 1.** It is within 0.1-0.4 dB of L2 on the art (1.3 on the icon, 3.2 on the noise) at
2.8-4.1x the speed; L0 is 3-5x faster again but loses 0.4-5.5 dB (5.5 on the atlas). For STS2's
173 Mpx that is ~1.5 min of background encoding on two workers instead of ~4-5 min.

### Checks (gate 8 group g8ku, development host, RTX 2060)

| check | result |
| ----- | ------ |
| `basis-capture` | pass: 6 uastc variants, declines updated 1, format 1, small 2 (the fixture's and the engine's default texture) |
| `ktx2-wire` | pass: each `<hash>.ktx2` hashes to its name, has its `payload_bytes`, parses as UASTC + Zstandard, linear, the entry's size and mips; a live GET with `Accept-Encoding: zstd` is `image/ktx2`, identity |
| `delivery-lazy` | pass: every variant first at frame 12 (the wait frame) at an equal version (full and patch sinks, workers capture); the live host's variants at an equal version too; the updated texture never gets one after its update |
| `delivery-keep` | pass: `keep` uploads each texture once (and `updated` again for its content change) and never refetches for a variant; `upgrade` re-uploads exactly the five whose D3 choice becomes uastc at the variant's seq (the DXT1 source stays `block`) |
| `transcode-oracle` | pass: every transcode (file replay and live) equals the oracle's format, size, mips, data size and SHA-256; target BC7 (`BPTC_RGBA`) |
| `delivery-reference` | pass: 0 px against the oracle's blocks drawn by the GPU at step 1, 0 px against the procedural reference at step 0 and under keep; the CPU-decode band is 0 px too here |
| `quality-band` | pass: 44.3-53.0 dB (floor 30) |
| `sabotage-perturb-ktx2` | pass: every stored KTX2 perturbed; the receiver refuses with `resource-hash-mismatch` |
| `delivery-live` | pass: /9 hello with `uastc`, uastc uploads over HTTP |
| `delivery-web` | pass: the web export transcodes the same five KTX2 to the same blocks as the native oracle |

**Transcode cost on the desktop** (UASTC + zstd to BC7, `Image.load_ktx_from_buffer`, the fixture's
1024x512 texture): native 5.2 ms (~10 ms/Mpx), web export 20.1 ms (~38 ms/Mpx); the web export's
first transcode on a page adds ~5 ms. Fixture KTX2s are 0.65-0.96 B/px (smooth gradients); the
1024x512 one is 347 KB against 2.1 MB decoded.

Gate 8 group g8kc (rebased, with its two new UASTC legs): 8/8, `cache-cold` (7 UASTC encodes stored,
one a texture updated before its encode was published) and `cache-warm` (the second basis-uastc
session serves all 6 variants from the cache: 0 encodes, the same hashes).

### Byte identity

- `golden-2/` to `golden-9/` and the window-1 transcripts (`capture/test/golden/live-window1-transcripts.txt`)
  are untouched, and their ctests pass in the build.
- Gate 8 groups g8t and g8kp ran twice, once with a capture built from `main` (bfbb874b) and once
  with this one: every capture recording (/6 `decode-off`, /8, /9 `rgba` `delivery9`, /9
  `passthrough` `g8kp/capture`, full and patch sinks, and `decode-cost`) and every hook log is
  equal record by record apart from session/stream ids and timings (14 files, `cmp-rec.ts`). The
  workers and live captures are excluded (timing-dependent, G8kw).

### Runs

- **Remote full tier** (rebased onto 229a93cc), https://github.com/tfoxy/godot-scene-web/actions/runs/40107970181:
  20/21 runs pass, every native gate (-1 to 8, gate 8 with every group and sabotage leg on hosted
  llvmpipe), pure, capture-build, cargo, pnpm-test, bench-instr and every g7 file and live group
  but one: `g7live-web-rust@g7-2`'s `live-reconnect` leg shot no step 7 (one connection, not two),
  a hosted no-shot flake. Rerun alone, https://github.com/tfoxy/godot-scene-web/actions/runs/40112348262:
  `g7live-web-rust` (g7-2, g7-5, g7-55, g7-8) passes; local g7-2 web live passes too.
- **An earlier remote full tier** before the rebase (run 40098801041) passed every run but gate 8,
  whose job hung in the workflow's artifact trim: its provenance step globs `**/stdout.log` through
  symlinks, and the web leg's harness root, then `g8ku/web-run` linking the whole run, made a
  second symlink cycle beside g8kp's `gsw-run`. The root moved to `g8ku-web/`, linking `g8ku/`
  alone; that run was cancelled.
- **Local:** the full tier's native gate 8 (`validate-increment.sh --tier full --only
  native-rust-gate8`, every group and sabotage leg): 114/114; g7-1 live in full (refused remotely):
  GSW 38 and web 39 PASS, both `gate_passed`; the smoke tier before and after the rebase (all
  pass; `bench-instr` needs valgrind, absent here, which the remote job has).
- **Deferred** to the pre-release sweep, per the increment's brief: the timing runs (native gate 6,
  the `g7live-*-timing` runs, g7x) and `lock-tests`.
- Evidence: `artifacts/render-stream/gate8/g8ku/` (bench tables, identity compare, the final g8ku
  and g8ku+g8kc runs, the full gate 8 result, local g7-1 logs, the remote summaries).

### Deviations

- `delivery-reference` gates on the receiver against the fixture drawing the oracle's *transcoded
  blocks* (GPU-sampled), and records the CPU-decode comparison as the informative band, since a GPU
  that rounds its hardware decode differently would differ there without being wrong. Here both are
  0 px.
- The KTX2 upload is in `rs_core_ext.cpp`, the C++ glue that executes the core's texture ops, not
  in GDScript.
- Encodes have their own pool (`GRC_TEXTURE_ENCODE_WORKERS`), not G8kw's (D11): a seconds-long
  encode in G8kw's FIFO would hold publication back.
- `delivery-pending` is not published (Q5 reserves it for the decoded hash; G8kw's hold-back covers
  that at /9, and a variant still encoding is listed by omission).
- A transcode failure ends the replay with `delivery-transcode-failed`; the refetch of `decoded` is
  not built.

### Out of scope

GSW's transcoder and the g31 are G8kb's; warming UASTC through the prepare step is a G8kc follow-up;
ETC1S is G8ke's ("As built (G8ku)", "Out of scope here").
