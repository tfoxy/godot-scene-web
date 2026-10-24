# Gate 8 texture fixture (`gate8-tex`, G8t and G8f)

The fixture for gate 8's host decode of block-compressed textures
([`../../protocol/gate8-design.md`](../../protocol/gate8-design.md) D8, "Q3. Compressed and float
textures"). Every texture is created after arm, as in the STS2 census (Q1e), so it needs no
adoption. The project does not know about the capture and runs the same whether `GRC_EXTENSION`
is set or not.

## Sources are generated, never committed

Release templates cannot encode S3TC/BPTC/ETC2/ASTC (the encoders are `TOOLS_ENABLED` only), and the
repository commits no generated binaries. So `run-gate8.sh`'s import leg builds everything with the
pinned editor:

```bash
mise exec -- godot --headless --path experiments/render-stream/fixtures/gate8-tex --script res://make_sources.gd
mise exec -- godot --headless --path experiments/render-stream/fixtures/gate8-tex --import
```

`make_sources.gd` writes synthetic PNG/EXR sources and their `.import` settings into `tex/`
(gitignored); `--import` VRAM-compresses them into `.godot/imported/` (ignored repo-wide). With
`import_s3tc_bptc` and `import_etc2_astc` both on and `compress_with_gpu` off, each VRAM import yields
a desktop variant (`.s3tc.ctex` or `.bptc.ctex`) and a mobile one (`.etc2.ctex` or `.astc.ctex`)
from the CPU encoders (etcpak, cvtt, astcenc), so the import does not depend on the host's GPU.
Every pixel is a pure function of its coordinates, so the sources are identical on every host.

## Files

- `project.godot`: gate 2's settings (640×360, stretch `disabled`, `gl_compatibility`,
  `msaa_2d=0`, `hdr_2d=false`, clear colour `(0.2, 0.2, 0.4, 1)`, default filter Nearest, the
  `[debug]` warning-to-error keys, autoload `GrcLoader`), plus the three VRAM-compression keys above.
- `loader.gd`: gate 1's loader (loads `GRC_EXTENSION` in `_enter_tree`).
- `textures.gd`: the texture table, shared by the three scripts below.
- `make_sources.gd`: the source and `.import` writer (editor only).
- `gate8_tex.gd` / `gate8_tex.tscn`: the scene. Each drawn texture gets one column of four drawers:
  a `Sprite2D` at scale 1 (nearest), a `Sprite2D` at 1.25 with item filter linear (`alpha_mip` at
  0.3125 with linear-with-mipmaps, so its decoded mip chain is sampled), a 72×56 `NinePatchRect`
  with 16 px margins, and a custom item's `draw_texture_rect_region`. Step 0 (frame 1) draws the
  desktop family; step 1 (frame S+N = 11) swaps every drawer to the mobile family; each step
  settles at its frame + 7 and the fixture quits at S+N+11 = 22. `hdr` is created in both steps
  and never drawn. `RS_FIXTURE_SOURCE=decoded` draws the oracle's decoded payloads instead of the
  `.ctex` files (the `reference` leg); `RS_FIXTURE_VARIANT=cost` creates only the 2048×2048 cost
  textures, one per frame from frame 2 (the `decode-cost` leg).
- `oracle.gd`: the decode oracle (D15 (3)), a separate headless template process run with
  `--script`: it loads every `.ctex`, decodes a duplicate with `Image.decompress()` and records the
  GRT1 payload's SHA-256 (`oracle.json`) and the payload itself (`<name>.<family>.grt1`); since
  G8kp also the `.ctex`'s own block bytes as a GRT1 payload in their block format
  (`<name>.<family>.block.grt1`, `block_payload_sha256`), what a `passthrough` capture's `block`
  variant must equal (run-gate8.sh's `g8kp` group). With
  `RS_ORACLE_TIMING=1` it times the decode of the cost textures instead, best of 3.
- `payload.gd`: this fixture's own `render-stream-texture/1` encoder and decoder (a copy of gate
  2's, deliberately not shared with the capture or the receiver).
- `expected.json` (`render-stream-gate8-tex-expected/1`): per texture and family, the format the
  importer produces and the payload format the decode publishes, or the typed refusal; the cost
  textures; the design's measured decode times for comparison; the engine's hue strip.

## Expected

Derived from the 4.5.1 importer and decoders, not measured:

| texture | channels (`detect_used_channels`) | desktop → payload | mobile → payload |
| ------- | --------------------------------- | ----------------- | ---------------- |
| `opaque` | RGB | DXT1 → RGBA8 | ETC2_RGB8 → RGBA8 |
| `alpha`, `alpha_mip` (mipmaps) | RGBA | DXT5 → RGBA8 | ETC2_RGBA8 → RGBA8 |
| `hq` (`high_quality`) | RGBA | BPTC_RGBA → RGBA8 | ASTC_4x4 → RGBA8 |
| `mask_r` (`channel_pack` Optimized) | R | RGTC_R → R8 | ETC2_R11 → RGBA8 |
| `mask_rg` (`channel_pack` Optimized) | RG | RGTC_RG → RG8 | ETC2_RG11 → RGBA8 |
| `control` (Lossless) | RGBA | RGBA8, not decoded | (one variant) |
| `hdr` (opaque float EXR) | HDR | BPTC_RGBFU, refused | ASTC_4x4_HDR, refused |

Channel detection: `core/io/image.cpp:3412-3488` (sRGB-friendly packing turns R/RG into RGB, hence
`channel_pack` Optimized for the masks); format choice: `modules/etcpak/image_compress_etcpak.cpp:41-80`,
`editor/import/resource_importer_texture.cpp:891-960` (high quality or HDR selects BPTC/ASTC);
decoders and their outputs: `modules/bcdec/image_decompress_bcdec.cpp:224-267`,
`modules/etcpak/image_decompress_etcpak.cpp:189-216` (always RGBA8),
`modules/astcenc/image_compress_astcenc.cpp:183-232`.

**Not produced by the 4.5.1 importer, so not in the fixture:** DXT3, ETC (ETC1), ASTC_8x8,
ETC2_R11S/RG11S/RGB8A1 and the `*_RA_AS_RG` swizzles. The capture's decode table still names DXT3,
ETC and ASTC_8x8 (same decoders, RGBA8 output); the other five stay `unsupported-format`.

## The float scene (G8f)

`gate8_float.tscn` / `gate8_float.gd` is a second main scene of the same project, run by
`run-gate8.sh`'s `g8f` group (`expected-float.json`, `render-stream-gate8-float-expected/1`). It models
STS2's float textures (gate8-design.md Q1e, D9): small curve and gradient textures, mostly made on
loader threads, used as shader inputs. Thirteen float textures, all created after arm:

| texture | made by | format and shape |
| ------- | ------- | ---------------- |
| `curve_rf`, `curve_rgb`, `curve_xyz` | `CurveTexture` (RED, RGB), `CurveXYZTexture`, main thread, deferred update | RF, RGBF, RGBF, 256x1 |
| `grad_hdr` | `GradientTexture1D` `use_hdr`, main thread | RGBAF 256x1, then 192x1 (create + replace) |
| `img_rgf`, `img_rh`, `img_rgh`, `img_rgbh`, `img_rgbah`, `img_rgbaf_mip`, `img_rf_odd` | images built and uploaded on a loader `Thread` | RGF, RH, RGH, RGBH, RGBAH 16x16; RGBAF 16x16 + 5 mips; RF 5x3 + 2 mips |
| `hdr_bptc`, `hdr_astc` | the imported `hdr.exr` (desktop BPTC_RGBFU, mobile ASTC_4x4_HDR) | decoded to RGBH and RGBAH 16x16 |

Every texture is the `src` uniform of a `ColorRect` with a small canvas_item shader (nearest,
clamped); `img_rgbah`, `img_rgbh`, `hdr_astc` and `hdr_bptc` are also drawn by a `Sprite2D`. Step 1
(frame 11) changes the curves (`texture_2d_update` of the float image), re-creates the gradient at
width 192 (`texture_replace`) and `ImageTexture.update`s `img_rh` and `img_rgbah`.

The fixture is its own oracle (`textures.jsonl`): it logs the GRT1 payload hash it expects for each
texture and step, from values it computes itself (`Curve.sample_baked`, `Gradient.sample`, the images
it built, `Image.decompress` of the imported EXR in a headless run). `RS_FIXTURE_HDR_DUMP` writes
those two decoded half-float payloads; the rendered `reference` reads them back
(`RS_FIXTURE_SOURCE=decoded`, `RS_FIXTURE_DECODED_DIR`) because a rendered GLES3 run's own
`CompressedTexture2D.get_image()` is not the creation-time image (desktop cannot sample ASTC HDR).
