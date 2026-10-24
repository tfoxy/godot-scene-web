## G8kb2 result (2026-10-24)

G8kb2 ([protocol/texture-delivery-design.md](../../protocol/texture-delivery-design.md) D14, "As built
(G8kb)" and "As built (G8kb2)") passes: when the context supports ASTC, GSW transcodes a 3-component
(RGB) UASTC texture to ASTC 4x4 as well, instead of Godot's ETC1. BC7 stays first (desktop
unchanged), and ETC1/ETC2/BC1 remain for contexts without ASTC. The native receiver and the web
export keep Godot's rule, untouched.

### Selection table (GSW; WebGL's BC alignment rule applies first, as in G8kb)

| components | bptc (no astc) | astc (+etc2, the g31) | bptc + astc | s3tc only | etc2 only | none |
| ---------- | ------------- | --------------------- | ----------- | --------- | --------- | ---- |
| RGBA | BC7 | ASTC 4x4 | ASTC 4x4 | BC3 | ETC2 RGBA8 | RGBA8 |
| RGB | BC7 | **ASTC 4x4** (was ETC1) | BC7 | BC1 | ETC1 | RGBA8 |

With both bptc and astc, RGBA takes ASTC (Godot's order) and RGB takes BC7 (ASTC sits after BC7 in the
RGB order, so the desktop is unchanged). The astc column's RGB cell is the only change. Tested by
`scripts/test/self-test-gate8kb.ts` (RGB x {BC7, ASTC+ETC2, ETC2 only, S3TC only, none, and
unaligned BC7-only}).

### Oracle and quality (development host, native basisu 1.60 vs GSW's wasm)

`scripts/test/g8kb2-astc-rgb.ts` (with `basis-astc-oracle.cpp`) takes g8ku's store (6 KTX2, 2 of them
RGB): GSW's wasm with the phone's family set (etc2, astc) gives `ASTC_4x4` for every file, and its
blocks, every level, equal basisu 1.60's own native `ktx2_transcoder` -> ASTC 4x4 byte for byte (6/6;
etc2 alone still gives ETC1 for RGB). The native CPU decode of the ASTC blocks equals the UASTC decode
exactly (PSNR 99 = identical): the ASTC output is a lossless repack of UASTC. PSNR against the source
pixels (the store's decoded payload), same as the UASTC decode: rgb 48.4 dB, bc1 54.0 dB.

### The g31 (moto g31, Chrome 155, ETC2 + ASTC; real time, one run)

Battery 100 % and 24.3 C before and after, thermal status 0 before and after; Chrome was running before
(pid 5820) and after (the bench uses its own tabs and closed them). Bench
`gate7-bench.ts --arm gsw-basis --env device --device g31 --basis-store <g8ku store>
--basis-deliveries none` (warmup 1, repeats 5). PSNR is of the phone's own GL decode of the uploaded
blocks (`compressedTexImage2D`, a `texelFetch` draw, `readPixels`).

| texture (RGB) | target | B/px | ms/Mpx | PSNR vs UASTC | PSNR vs source |
| ------------- | ------ | ---- | ------ | ------------- | -------------- |
| rgb 192x96 (gradient-like) | ETC1 (before) | 0.5 | | 34.8 | 33.5 |
| | ASTC 4x4 (after) | 1 | | 58.3 | 48.2 |
| bc1 136x124 (per-pixel noise) | ETC1 (before) | 0.5 | | 18.8 | 18.8 |
| | ASTC 4x4 (after) | 1 | | 59.0 | 54.7 |
| both RGB files (0.176 Mpx per pass) | ETC1 (before) | 0.5 | 80.1 | | |
| | ASTC 4x4 (after) | 1 | 66.2 | | |

The transcode is not slower: ASTC 66 ms/Mpx against ETC1 80 on these small textures (RGBA stays at
ASTC 53.7). The cost is memory: 1 B/px against 0.5 for RGB textures (still a quarter of RGBA8's 4).
The ASTC decode on the phone is 56-60 dB from UASTC (hardware rounding, not the blocks, which equal
the oracle's). The hd-patch per-frame path is untouched (the change is in the arrival-path
transcode), so it was not re-run.

### Runs

| what | where | result |
| ---- | ----- | ------ |
| remote full tier (pure, cargo-gsw-rs, native-rust-gate8, g7-gsw incl. g7-8, g7live-gsw) | run [40135033784](https://github.com/tfoxy/godot-scene-web/actions/runs/40135033784) | 4/5: pure, cargo-gsw-rs, g7-gsw, g7live-gsw pass; native-rust-gate8 fails 4 checks, none touched by this change |
| native-rust-gate8 rerun | run [40138195722](https://github.com/tfoxy/godot-scene-web/actions/runs/40138195722) | same 4 failures |
| native-rust-gate8 on main (06c453ce), forced into the plan | run [40139405185](https://github.com/tfoxy/godot-scene-web/actions/runs/40139405185) | the same `transcode-oracle` (live/receiver: 0 transcodes matched) and `delivery-live` (no uastc variant uploaded) failures, plus `decode-cost`/`worker-hook-time` (evidence of the skipped timing group), so they are the hosted runner's, not G8kb2's; the native live /9 receiver is untouched here |
| selection self-test, oracle check, g31 bench | local, g31 | pass (above) |

Not run: the timing runs and the g7-1 live group (refused remotely), deferred to the pre-release sweep.

