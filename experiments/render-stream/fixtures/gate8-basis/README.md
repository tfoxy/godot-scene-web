# Gate 8 Basis fixture (G8ku)

The fixture for gate 8's `g8ku` group (`scripts/run-gate8.sh --legs g8ku`,
[`../../protocol/texture-delivery-design.md`](../../protocol/texture-delivery-design.md) "As built
(G8ku)"). It makes every texture at runtime from integer-only procedural code (no import, no
committed image), each with its own size, and draws them 1:1 in the receiver's 640x360 viewport.
`gate8_basis.gd`'s header has the table: six textures D12 admits (`rgba`, `rgb`, `bc1` from DXT1
blocks the host decodes, `npot`, `mip` with a mip chain, also drawn at half size with linear
mipmaps, and `big`) and three it refuses (`small` by size, `gray` by format, `updated` because step
1 updates it in place).

- Step 0 (frame 1) creates everything; step 1 (frame 12, `RS_FIXTURE_UPDATE_FRAME`) updates
  `updated`. The capture legs attach every lazy encode at that frame
  (`GRC_TEXTURE_ENCODE_WAIT_FRAME=12`), so their recordings are exact.
- `big` (1024x512, a 128x128 region drawn) gives the transcode cost per Mpx, native and web.
- `RS_FIXTURE_SOURCE=oracle` is the `reference-oracle` leg: it runs every `.ktx2` of a capture's
  store through `Image.load_ktx_from_buffer` on the current renderer (D14 picks that GPU's target),
  writes `oracle.json` (format, size, mip chain, data size and SHA-256 of the transcoded blocks) and
  each transcode's CPU decode, and draws the uastc textures from those decodes from step 1.
- `expected.json` names, per texture, whether it gets a uastc variant and what a `keep` and an
  `upgrade` desktop receiver upload; `lib/gate8-basis-checks.ts` reads it.
