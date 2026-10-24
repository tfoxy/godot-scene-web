## G8kp result (2026-10-24)

G8kp ([protocol/texture-delivery-design.md](../../protocol/texture-delivery-design.md) D1, D3, Q3,
Q6 and "As built (G8kp)") passes: `passthrough` texture delivery works end to end at
render-stream/9. A /9 capture under `GRC_TEXTURE_DELIVERY=passthrough` offers, beside the `decoded`
base entry G8t's host decode publishes, a `block` variant that is the hooked `.ctex` bytes
exactly; the native receiver and GSW each pick their payload by D3's fixed rule from their own
`texture_encodings` and `gpu_formats`, fetch it like any payload and upload it in its block format
(`Image.create_from_data` natively, `compressedTexImage2D` in GSW). The native receiver's pixels
then equal `reference-hw`, the fixture sampling the `.ctex` on the same GPU, exactly. The default
`rgba` and every /6 to /8 stream are unchanged.

### What landed

| part | where |
| ---- | ----- |
| capture: the `block` variant, Basis modes refused typed at /9, `delivery_stats` | `capture/src/rs_texture_delivery.*`, `hooks.cpp` (`attach_block_variant`), `rs_mirror.cpp`, `rs_texture_worker.*`, `rs_publish.cpp`, `rs_resource_store.*`, `entry.cpp` |
| D3, once for every Rust receiver | `rs-core/src/delivery.rs` (`DeliveryPrefs`); the applier (`apply/mod.rs`) and payload store keep block level 0 compressed |
| native receiver | `rs-core-capi` (`rsc_set_delivery`, the planner picks D3's hash, block formats in `make_image`), `receiver/ext/rs_core_ext.cpp` (`set_delivery`), `receiver.gd` (`RS_RECEIVER_TEXTURE_ENCODINGS`, `RS_RECEIVER_GPU_FORMAT_MASK`, GRS9 replay, `RS_RECEIVER_PROTOCOL=9`), `rs_live_client.gd` (`hello_v9`) |
| GSW | `packages/canvas/rust-draw-list` (`TextureOp::UploadCompressed`, `CompressedFormat`), `rust-prototype/src/canvas_items/gl.rs` (`compressedTexImage2D`, `gpu_families`), `web/gsw-rs` (delivery options, `delivery_json`, /9 live session), `web/gsw-receiver` (`hello.ts`, config, report) |
| gate 8 group `g8kp` | `scripts/run-gate8.sh` (`run_g8kp`, `run_g8kp_live`), `scripts/gate8-delivery-tool.ts` (the GSW legs), `scripts/lib/gate8-delivery-checks.ts`, `scripts/test/self-test-gate8kp.ts`, `fixtures/gate8-tex/oracle.gd` (the block payloads) |
| plumbing | `smoke-map.json` (the GSW page and canvas crates reach native gate 8), `remote-validate.yml` (native gate 8 gets the pinned Chromium, wasm-bindgen and the lavapipe allowance) |

The web export stays on `decoded`: it reads neither delivery variable, keeps the core's default and
never offers /9 (a /9 file replays there as /8 would).

### Checks (gate 8 group g8kp, development host, RTX 2060)

| check | result |
| ----- | ------ |
| `delivery-capture` | full and patch `.rs9` validate at /9 (delivery-entry included), declare `{passthrough, null}`; `delivery_stats` 12 built, 45,102 B, 0 declined |
| `block-exact` | 12 block variants (6 desktop: DXT1, DXT5 x2, BPTC, RGTC_R, RGTC_RG; 6 mobile: ETC2 RGB8/RGBA8 x2, ASTC 4x4, R11, RG11) equal the oracle's `.ctex` GRT1 byte for byte (hash, format, size, the store file); the 2 lossless textures and the engine's hue strip carry none |
| `delivery-workers` | at `GRC_TEXTURE_WORKERS=2` (delayed workers) all 80 entries carry the synchronous capture's variants |
| `delivery-refused` | `basis-uastc` at /9: `texture-delivery-unimplemented: GRC_TEXTURE_DELIVERY=basis-uastc is not implemented yet` |
| `delivery-select` | native full / patch: 6 block, 8 decoded each; native masked: 0 / 14; GSW: 6 / 8; GSW masked: 0 / 14; every upload is D3's choice under the receiver's stated keys (on the hosted runner llvmpipe's GL also states `astc`, so the masked native leg takes ASTC 4x4 as `block`, as D3 says) |
| `sabotage-ignore-format-mask` | GSW stating `gpu_formats: none` but picking as unmasked: 6 wrong choices caught |
| `delivery-live` | native at `RS_RECEIVER_PROTOCOL=9`: the host's live summary records `block,decoded` / `s3tc,bptc,rgtc`, version 9; 6 block uploads, each fetched over HTTP |
| `delivery-pixels-native` | `receiver` and `receiver-patch` vs `reference-hw`: 0 px at both steps (reference-hw vs the CPU-decoded reference: 23,827 px, max delta 5, on the desktop step); `receiver-masked` vs `reference`: 0 px |
| `delivery-pixels-gsw` | on GSW's decided pixels (where its decoded draw equals the native decoded reference: 209,605 of 230,400 on the desktop step), 203,702 equal `reference-hw` exactly and 5,903 differ by exactly 1; the mobile step (no block drawn) equals the masked leg exactly |

**Deviation: GSW is delta 1, not exact.** Hardware BC decode yields texels between 8-bit steps; ANGLE
on Vulkan and Godot's GLES3 path on the same NVIDIA GPU round them into the RGB10A2 target at
different points. The native claim (same engine path as `reference-hw`) is exact; GSW's is "exact or
one rounding apart" on the pixels GSW already rasterizes like Godot.

### Byte identity

- `golden-2/` to `golden-9/` untouched (no golden file in the diff; `make_golden.py --check` in `pure`).
- The window-1 transcripts (`capture/test/golden/live-window1-transcripts.txt`) untouched; the ctests
  that compare them pass.
- Record compare against `main` (b726d69b) built separately, with G8sha's `cmp-rec.ts`: gate 0 (14
  files: /6 recordings and hook logs) and gate 8 g8t's `capture`, `decode-off/capture` and
  `sabotage-perturb-decode/capture` (9 files, /6 and /8) are equal apart from session/stream ids and
  timings. The workers captures are left out: their frames depend on timing by design (G8kw).
- G8k9's `delivery9/capture` leg now declares `rgba` (the Basis modes it used are refused) and still
  equals the /8 capture state for state (`delivery-v9-wire`).

### Runs

Full tier from a clean worktree, `scripts/remote-validate.sh --tier full` on base b726d69b (run
[40085852753](https://github.com/tfoxy/godot-scene-web/actions/runs/40085852753), summary
`artifacts/render-stream/gate8/g8kp/remote/validate-summary.json`): **20 of 21 remote runs pass**:
`pure`, `capture-build`, every `cargo-*` (`cargo-gsw-rs` included), `pnpm-test`, `bench-instr`,
native gates -1 to 5.5, `g7-gsw` and `g7-web-rust` (every file group), and the remote halves of
`g7live-gsw` and `g7live-web-rust` (g7-2, g7-5, g7-55). The one failure was native gate 8's
`delivery-select`, and it was the check, not the receivers: the hosted runner's llvmpipe GL reports
`astc`, so the native receiver with s3tc, bptc and rgtc masked still (correctly, by D3) took the ASTC
4x4 texture as `block`, and the check had demanded `decoded` only from a masked leg. The check now
refuses a block of a masked family per upload instead (`self-test-gate8kp.ts` covers it). After a
rebase onto G8kv (66633e20, vendored basisu; no conflict outside the design doc's status line and
"As built" order), `native-rust-gate8` alone again (run
[40089488703](https://github.com/tfoxy/godot-scene-web/actions/runs/40089488703), summary
`artifacts/render-stream/gate8/g8kp/remote-rerun/validate-summary.json`): **pass**, on llvmpipe GL
and lavapipe-backed Chromium.

Locally, the runs the hosted runners refuse: `g7live-gsw` and `g7live-web-rust` group g7-1
(`RS_VALIDATE_GROUPS=g7-1`, `--tier full`): both rc 0 (166 s and 241 s). The timing runs
(`native-rust-gate6`, the `g7live-*-timing` runs, `g7x`) and `lock-tests` were not run: deferred to
the pre-release delta sweep (nothing timed changes here; gate 8's own timing group `decode-cost` is
skipped on remote runners and excused by tier). After the rebase, locally: `capture-build` (29
ctests) and gate 8 `g8t,g8kp` (all non-timing checks pass).

### Out of scope

| receiver or group | owner | state |
| ----------------- | ----- | ----- |
| web export | G8ku | `decoded` only, no /9 hello |
| GSW live at /9 (hello implemented and self-tested, never run live) | G8g | gate 8's live leg is native |
| GSW ETC2/ASTC uploads (wired, the desktop GPU exposes neither to WebGL) | G8kb | first run on the g31 |
| Basis variants, transcoders | G8ku, G8kb, G8ke | typed refusal at /9 |
| gate 7 groups | none | unreachable: `GRC_STREAM_VERSION` is unset in every one |
