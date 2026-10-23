## Gate 8t result (2026-10-23)

G8t ([protocol/gate8-design.md](../../protocol/gate8-design.md) D8, Q3 and "As built (G8t)") passes:
under `GRC_TEXTURE_DECODE=engine` the capture decodes block-compressed textures on the host with the
engine's own `Image::decompress`, on a duplicate of the hooked Image, and publishes the RGBA8/R8/RG8
result as an ordinary content-addressed payload whose /8 texture entry names its `source_format`.
Every payload equals an independent headless oracle's decode of the same `.ctex`, and the native
receiver's replay equals a reference drawing the CPU-decoded images, pixel for pixel.

### What decodes, what stays refused

| source formats | payload | in the fixture |
| -------------- | ------- | -------------- |
| DXT1, DXT5, BPTC_RGBA | RGBA8 | yes (desktop family) |
| RGTC_R / RGTC_RG | R8 / RG8 | yes |
| ETC2_RGB8, ETC2_RGBA8, ETC2_R11, ETC2_RG11, ASTC_4x4 | RGBA8 | yes (mobile family) |
| DXT3, ETC, ASTC_8x8 | RGBA8 | no: the 4.5.1 importer never produces them |
| BPTC_RGBF/RGBFU, ASTC_4x4_HDR/8x8_HDR | refused `unsupported-format` (half-float decodes are G8f's) | BPTC_RGBFU, ASTC_4x4_HDR |
| DXT5_RA_AS_RG, ETC2_RA_AS_RG, ETC2_R11S, ETC2_RG11S, ETC2_RGB8A1, every uncompressed format outside `GRC_RESOURCE_FORMATS` | refused `unsupported-format` | no |

The editor produced every format `expected.json` derives from the importer on the first try,
including RGTC_R/RG (which needs `channel_pack` Optimized: sRGB-friendly packing promotes R and RG
to RGB) and the ETC2/ASTC variants (`import_etc2_astc=true`, CPU encoders, `compress_with_gpu`
off).

### Decode cost (decode-cost, real time, exclusive lock, loadavg 3.83)

2048×2048 synthetic sources on the release template (Ryzen 5 5500). "Oracle" is the best of 3
`Image.decompress()` calls on fresh duplicates (as the design measured on the editor); "hook" is the
capture's own time on the calling thread (main) for one create: decode (duplicate + decompress),
copy into the GRT1 payload, SHA-256 of the 16 MiB payload.

| format | oracle ms | Mpx/s | design ms / Mpx/s | hook decode | copy | hash | hook total ms |
| ------ | --------- | ----- | ----------------- | ----------- | ---- | ---- | ------------- |
| DXT1 | 2.7 | 1569 | – | 10.2 | 14.9 | 52.2 | 77.3 |
| ETC2_RGB8 | 7.7 | 547 | – | 16.0 | 14.4 | 52.3 | 82.7 |
| DXT5 | 5.3 | 798 | 6.8 / 618 | 13.0 | 15.1 | 52.2 | 80.3 |
| ETC2_RGBA8 | 11.1 | 377 | 10.7 / 392 | 11.0 | 11.8 | 52.2 | 75.0 |
| BPTC_RGBA | 29.4 | 142 | 35.6 / 118 | 28.8 | 11.5 | 52.1 | 92.3 |
| ASTC_4x4 | 67.8 | 62 | 73.1 / 57 | 77.7 | 14.7 | 51.8 | 144.2 |

The template's decoders match the design's editor numbers within 10-30% (the template is a little
faster). The largest calling-thread hitch is ASTC_4x4 at 144 ms. For every format but ASTC the hook
is dominated by the SHA-256 (~52 ms, ~320 MB/s) and the payload copy (~12-15 ms, first-touch page
faults on a fresh 16 MiB buffer), not by the decode: the hook's decode is also 2-4× the oracle's
best for the fast formats, for the same reason (the decompress writes a fresh 16 MiB buffer each
time; the oracle's repeats reuse freed pages). ASTC also has a fixed per-call setup cost: a 64×64
ASTC_4x4 decode took 4.1 ms in the fixture capture, against 5-50 µs for every other 64×64 format.
The design's follow-up stands: defer the hash off the calling thread (G7o1's pattern) if the STS2
leg shows the hitch matters. Two earlier runs at loadavg 5-6 gave the same numbers within 10%.

### Informative band (reference-hw vs reference)

The `.ctex` drawn directly differs from the CPU-decoded reference by 23,827 px (max channel delta
5) on the S3TC/BPTC step and by 0 px on the ETC2/ASTC step, on this host's NVIDIA GLES3: BC1/BC3/BC7
hardware interpolation rounds differently from bcdec, while desktop GLES3 has no ETC2/ASTC and
decodes them with the same CPU decoders itself. Not gating (the design's band).

### What ran

| where | runs | result |
| ----- | ---- | ------ |
| local, iterating | capture ctests (24, new `rs_texture_decode`), `cargo test` rs-core-capi, `run-gate8.sh` g8t (four full runs, sabotage legs included) | pass; the last three 8/8 |
| local smoke (`validate-increment.sh --tier smoke --only pure,capture-build,cargo-rs-core-capi,native-rust-gate0,native-rust-gate2`) | `artifacts/render-stream/validate/g8t-smoke/` | 5/5 pass |
| remote full tier | run 39907912822, key `rv-20261023T054934Z-5958202-19586`, https://github.com/tfoxy/godot-scene-web/actions/runs/39907912822: pure, capture-build, cargo ×4, pnpm-test, bench-instr, native gates −1, 0, 1, 2, 3, 4, 5, 55 and 8 (full, sabotage legs run; timing groups skipped remotely), g7-gsw and g7-web-rust (all eight groups), g7live-gsw and g7live-web-rust (g7-5, g7-55) | 20 of 21 runs pass (evidence `artifacts/render-stream/remote/20261023T063445Z`); `native-rust-gate8` passes on the runner in 32 s (its import gives the same formats, `decode-reference` exact on lavapipe); the 21st, `cargo-gsw-rs`, is the known failure (rc 101) |
| local full, the groups the remote refuses | `RS_VALIDATE_GROUPS=g7-1,g7-2 validate-increment.sh --tier full --only g7live-gsw,g7live-web-rust` (`artifacts/render-stream/validate/g8t-live-full/`) | gsw 73/73 checks, `warm-host-no-gets@gsw` and `resync-full@gsw` pass; web/rust 74/75: `live-acks-staged@web` failed once on gate 2's `live-reconnect` (connection 1: 662 sent, 660 read, the receiver closed with two transactions in flight at credit window 2, where the check allows one), rerun once (`g8t-live-web-g7-2-rerun/`): pass |
| local, timing | `decode-cost` (the table above), real time, once at loadavg < 4 | measured |

**g7-2 live is now verified in full on both browser receivers**, closing G8w's gap:
`warm-host-no-gets` passes on gsw and web/rust. The one web/rust failure is the credit-window-2
in-flight count at a receiver close, the same model gap class as `resync-full` (f0de33d6 fixed that
one for g7-1); the connection negotiated `render-stream.7` (the browser offers only `.7`), so G8w's
`.7,.6,.8` listener offer is not involved.

Out of scope, deferred to the pre-release delta sweep: the timing phase (`native-rust-gate6`,
`g7live-*-timing`, `g7x`, `lock-tests`) and the timing groups inside gates 1, 2, 5 and 55. Known
failures ignored: `cargo-gsw-rs` rc 101.

### Deviations from the design

- **The native receiver reads /8 files** (`receiver.gd`, `rs_wire.gd`, `rs-core-capi`'s
  `VERSIONS`). The brief expected no receiver change, but D2 forbids a decode policy on a /6 sink
  and the receiver spoke only /6 and /7, so without it no receiver could be judged. The web
  export's core gets the same version; the live hello is unchanged.
- **GSW and web receivers are not exercised on gate 8 recordings.** Browser file legs route only
  GRS7 recordings (`lib/legs.sh` `gate7_browser_leg`), and `run-gate7.sh`'s group table is G8g's
  (gate8-design.md "Increments").
- **Fixture**: no float textures (G8f's float legs), plus RGTC_RG, the whole ETC2/ASTC family, an
  HDR EXR for the declared refusals, and 2048² cost textures (DXT1, DXT5, BPTC, ETC2 RGB/RGBA,
  ASTC). Sources and imports are generated by the editor at fixture build time; nothing binary is
  committed. The reference draws the oracle's own decoded payloads (so it is exactly the engine's
  CPU decode); the `.ctex` reference is the informative band.
- **Extra checks**: `g8t-import`, `decode-wire`, and the non-gating `decode-hardware-band`.
  `decode-off` runs the default /6 file sink (no gate 8 policy), the literal "today".
- **Decode cost** lives in the hook log (`decode_ns`, plus a trailing `source_format` key on
  decoded lines only) and `result.json`'s `stream.gate8.decode_stats`; perf.json is unchanged.
- `native-rust-gate8` is remote-capable (smoke-map.json `remote.capable`); its `decode-cost` group
  is skipped on hosted runners like g5f/g55f (`RS_SKIP_TIMING_GROUPS`).

### Implementation versus validation time

About 50 minutes of writing and debugging (the seam, the hook path, the receiver, the fixture,
runner and checker, two fixes after the first full run), of which ~12 minutes were lock waits on
the first editor runs behind the sweep's timing legs. Validation took about an hour of wall
time, run in parallel: the remote full tier (~45 minutes from dispatch to collection), the local live g7-1/g7-2
full runs (1761 s, 2480 s of it lock wait), the web/rust g7-2 rerun (280 s), the local smoke subset
(1270 s) and the quiet decode-cost run (102 s).
