# G8kv: vendored basisu 1.60 and the UASTC encoder in the capture build

Increment G8kv of [texture-delivery-design.md](../../protocol/texture-delivery-design.md) (D13, D15;
"As built (G8kv)" there records the decisions). Evidence: `artifacts/render-stream/gate8/g8kv/`
(ignored). A prerequisite split out of G8ku.

## What it proves

- `build-capture.sh` compiles basisu 1.60 (the copy Godot 4.5.1 vendors, `third_party/basis_universal/`,
  with provenance and digests) with the zstd the capture already vendors, no OpenCL, into the capture.
  `rs::basis::encode_uastc_ktx2` turns RGBA8 mip levels into a KTX2 file per D13 and `params_id()` names
  the settings: `basisu-1.60/uastc-l2/zstd6/linear`. Nothing calls it yet; the default capture output is
  unchanged.
- Six synthetic images (mip chains, odd sizes, 1x1, alpha) encode to files that pass the render-stream/9
  `ktx2` profile twice: a C++ check in `rs_basis_encode_test` and the shipped TS validator
  (`decodeKtx2Payload` + `checkKtx2Shape`, `scripts/test/g8kv-validate-ktx2.ts`).
- Stock Godot 4.5.1 (`Image.load_ktx_from_buffer`, headless, so it transcodes to BC7) decodes every file
  to the right size, mip count and alpha; PSNR against the source below.
- Six threads encoding concurrently produce byte-identical files to a single-thread run (`std::call_once`
  around `basisu_encoder_init`).

## PSNR through Godot's own transcoder (RGBA, dB; BC7 target, then `decompress()`)

| case | level 0 | worst other level | KTX2 bytes |
| ---- | ------- | ----------------- | ---------- |
| smooth 64x48, 7 levels | 50.6 | 39.2 (4x3) | 4,401 |
| smooth 256x256, 9 levels | 53.2 | 37.3 (4x4) | 64,474 |
| sprite 37x21 with alpha, 6 levels | 41.4 | 30.7 (9x5) | 1,363 |
| sprite 4x130 with alpha, 8 levels | 40.3 | 38.7 (1x4) | 1,237 |
| noise 64x64 (stress: +-20 uniform noise), 7 levels | 33.6 | 33.6 | 5,882 |
| 1x1 | exact | | 209 |

The design's 50-62 dB holds for the smooth, colour-correlated images (level 0). Two traps shaped the
set: independent R and G ramps inside one 4x4 block, and hard alpha edges, are worst cases for any 4x4
codec (27 dB and 35 dB on level 0 before the images were made colour-correlated), and the BC7 hop adds
loss, so the smoke floors per case (28-36 dB, `rs_basis_encode_test.cpp`) are bounds, not targets.
Real-asset PSNR is G8ku's `quality-band`.

## Encode cost, one thread (this host, Ryzen 5 5500; load average ~7 from other repos' work)

`rs_basis_encode_test --bench`, 1024x1024 level 0, under the quiet lock, UASTC level 2, zstd 6:

| content | ms per Mpx | KTX2 size vs RGBA8 |
| ------- | ---------- | ------------------ |
| smooth | 3,617 | 12.1% |
| alpha sprite | 3,301 | 7.7% |
| noise | 5,002 | 24.3% |

About 0.2-0.3 Mpx/s per thread, so a 12-thread pool is ~3 Mpx/s: an STS2-sized pack (hundreds of Mpx)
is minutes of eager preparation, not a lazy first-use cost. The design's Q2 figures of 28-60 Mpx/s are
the g31's transcode estimate, not encode.

## Build

| | before | after |
| - | ------ | ----- |
| `librender_stream_capture.so` (RelWithDebInfo) | 36.4 MB | 50.2 MB (+13.9 MB, nearly all debug info) |
| stripped | | 3.9 MB |
| clean `grc_basisu` build, `-j12` | | 25.6 s wall (48 s user) |
| incremental `build-capture.sh` incl. 29 ctests | | 28.8 s |

## What ran

`validate-increment.sh --plan` reaches `pure`, `capture-build`, `native:gate0@*` and `native:gate8@*`
(the narrow rule in `scripts/smoke-map.json`). Verdicts are in the commit message and the final report.
