## Gate 8 summary (2026-10-24)

Gate 8 closes the generic halves of the four blockers that kept the capture from a running game:
**late join** (adopting a scene that exists before the capture arms), **compressed textures**
(block-compressed and float payloads), **host size** (a presentation size applied at a late arm)
and **pre-arm materials**. It adds two wire versions, `render-stream/8` and `/9`, opt-in beside the
unchanged /6 and /7 defaults, and a texture-delivery layer (HTTP content coding, pass-through of
the game's own blocks, KTX2/UASTC, a persisted host cache) so wire bytes and receiver GPU memory
are settings. Everything is proven on stock-template fixtures (`fixtures/gate8-*`) by the native
receiver and, from G8g on, by both browser receivers. Whether the installed game is captured
correctly is the product leg's (P3), not this gate's.

Contract: [protocol/gate8-design.md](../protocol/gate8-design.md) and
[protocol/texture-delivery-design.md](../protocol/texture-delivery-design.md). Wire:
[render-stream-8.md](../protocol/render-stream-8.md), [render-stream-9.md](../protocol/render-stream-9.md).
What a product sets and opts out of: [protocol/gate8-product-handoff.md](../protocol/gate8-product-handoff.md).
Per-receiver support: [protocol/features/render-stream-8/](../protocol/features/render-stream-8/).
Closing run and the manifest checks: [gate8/g8z.md](gate8/g8z.md).

## Increments

Each is one commit on `main`; the result doc has the checks, the evidence paths and the deviations.

| Id | Commit | What it adds | Result |
| -- | ------ | ------------ | ------ |
| G8w | b129dd0c | `render-stream/8` codecs and validators in both oracles and rs-core, `golden-8/`, `render-stream.8` subprotocol, `GRC_STREAM_VERSION`, policy parsing and refusals, empty adoption/decode seams | [g8w](gate8/g8w.md) |
| G8t | 8d2b8292 | `GRC_TEXTURE_DECODE=engine`: block-compressed textures decoded on the host with the engine's own decoder; `gate8-tex`; gate 8's runner and checker | [g8t](gate8/g8t.md) |
| G8sha | fc9b0792 | SHA-256 on x86 SHA-NI with a portable fallback, bit-identical output | [g8sha](gate8/g8sha.md) |
| G8a | 23b0e212 | `GRC_ADOPT=arm`: adoption of canvases, layers and items; a late arm equals a born one | [g8a](gate8/g8a.md) |
| G8h | 6d1d5207 | `presentation:WxH` applied at a late arm, after adoption | [g8h](gate8/g8h.md) |
| G8kw | b32b9d51 | `GRC_TEXTURE_WORKERS`: copy, decode and hash off the calling thread, with a publication hold-back | [g8kw](gate8/g8kw.md) |
| G8kz | 5b43df18 | HTTP content coding of payload GETs (`GRC_HTTP_ENCODING`, zstd by default) | [g8kz](gate8/g8kz.md) |
| G8f | d0911ac1 | The eight float payload formats end to end; GSW quantizes them (`float-texture-quantized`) | [g8f](gate8/g8f.md) |
| G8r | 489c05c8 | Lazy adoption of pre-arm textures, meshes and glyph atlases | [g8r](gate8/g8r.md) |
| G8k9 | 1426ca50 | `render-stream/9` codecs and validators (texture `variants`, KTX2 profile, the hello keys), `golden-9/` | [g8k9](gate8/g8k9.md) |
| G8m | b726d69b | Adoption of pre-arm materials and shaders; the last capture blocker | [g8m](gate8/g8m.md) |
| G8kv | 66633e20 | basisu 1.60 vendored, the UASTC encoder in the capture build | [g8kv](gate8/g8kv.md) |
| G8kp | bfbb874b | `passthrough` delivery: the `block` variant, D3 variant selection in rs-core, native and GSW upload of blocks | [g8kp](gate8/g8kp.md) |
| G8g | 586f8b32 | Gate 8 through both browser receivers (group `g7-8`), the native live group `g8l`, D14's reverse-proxy leg | [g8g](gate8/g8g.md) |
| G8kc | 229a93cc | Persisted host texture cache, `prepare-textures.sh`, the `texture_set_path` hook | [g8kc](gate8/g8kc.md) |
| G8ku | ca12d291 | `basis-uastc` delivery: lazy UASTC variants, native and web-export transcode and upload | [g8ku](gate8/g8ku.md) |
| G8kb | 06c453ce | GSW's Basis transcoder (Web Worker wasm), ASTC/ETC/BC7 upload, `uastc` in its /9 hello, fallback to `decoded`, the g31 | [g8kb](gate8/g8kb.md) |
| G8kb2 | 1753970e | GSW transcodes RGB UASTC to ASTC 4x4 when the context has ASTC | [g8kb2](gate8/g8kb2.md) |
| G8kf | 12c704b1 | `prepare-textures.sh` warms UASTC, opt-in `delivery-pending`, `delivery-transcode-failed` falls back to `decoded` | [g8kf](gate8/g8kf.md) |
| G8kwh | ea402b95 | The web export states only the families its WebGL context uploads; BC alignment rule; web `block` pixels | [g8kwh](gate8/g8kwh.md) |
| G8z | this commit | The three feature manifests, this summary, the product hand-off, the manifest checks | [g8z](gate8/g8z.md) |

Still open and owned elsewhere (texture-delivery-design.md "Increments"): G8ke (ETC1S and the
throttled link). Tooling since G8ku: GRT6 ([grt6](../grt6.md), 714e877c) made the remote gate 8 and
`g7-8` runs trustworthy (the g8ku live receiver uses `RS_RECEIVER_VARIANT_POLICY=upgrade`).

## Supported features

The manifests are the authority ([features/render-stream-8/](../protocol/features/render-stream-8/);
`render-stream-features/2`, the same 123 entries as gate 7's plus nine, with three of gate 7's
changed). They differ in status, exactness and evidence per receiver:

| Capability | native | web export | GSW canvas |
| ---------- | ------ | ---------- | ---------- |
| render-stream/8 file and live (`RS_RECEIVER_PROTOCOL=8`) | supported, exact | supported, exact | supported, exact |
| Late-join adoption of items, layers, canvases (`GRC_ADOPT=arm`) | supported, exact | supported, delta1 | supported, delta1 |
| Lazy adoption of pre-arm textures, meshes, atlases | supported, exact | supported, delta1 | supported, delta1 |
| Pre-arm materials and shaders | supported, exact | supported, delta1 | supported, delta1 |
| `presentation:WxH` at a late arm | supported, exact | supported, delta1 | supported, delta1 |
| Host-decoded block-compressed textures | supported, exact | supported, delta1 | supported, delta1 |
| Float texture formats | supported, exact | supported, delta1; sampled natively | supported, **quantized** to RGBA8 (`float-texture-quantized`) |
| HTTP content coding (zstd, gzip) | declared-unverified (judged by native gate 2) | supported | supported |
| Reverse-proxy fronting (D14) | supported | supported | supported |
| /9 `block` variant | supported, exact | supported, delta1 (BC only; states `s3tc,bptc,rgtc`, never `etc2`) | supported, delta1 on BC |
| /9 `uastc` variant | supported, exact against the engine's own transcode | supported, exact (unaligned BC and unstated targets fall back to `decoded`) | supported, delta1 (worker transcode; BC7 blocks equal the oracle's; ASTC on the g31) |

`delta1` is gate 8's definition for both browsers: against the native receiver's leg of the same recording, within
channel 1 plus regions the fixture scene declares (never derived from a browser run), as G8g's
deviation section explains. `declared-unverified` means the wire carries it but no leg of that
receiver replays it. The gate 7 entries keep their evidence from G7z's closing run on build
6a454065 (the manifests' `evidence_runs` say which rows are carried), and the browsers' g31 device
targets are `unverified` on these builds (gate 8 ran no phone legs); gate 7's phone verdicts stand
for their own build.

## Measured costs

Development host (Ryzen 5 5500, RTX 2060), real-time runs unless noted. Rate, pacing and soak are
gate 7's and were not re-measured; the timing groups are the milestone sweep's.

| What | Number | Source |
| ---- | ------ | ------ |
| Host decode of a 2048x2048 block texture, calling thread, synchronous | 75-144 ms (decode 10-78, copy 12-15, hash 52; ASTC 4x4 the slowest) | [g8t](gate8/g8t.md) |
| Same, with SHA-NI | hash 52 ms -> 8.4 ms; template hash 250 -> 50 ms per launch | [g8sha](gate8/g8sha.md) |
| Same, with `GRC_TEXTURE_WORKERS=2` | calling thread 6-16 us; worker 31-56 ms | [g8kw](gate8/g8kw.md) |
| Adoption walk at arm | 47 us for 20 items and 1 layer (about 2.4 us per item; about 6 ms for 2,400 items) | [g8a](gate8/g8a.md) |
| Pre-arm resource read-back | about 1 ms for the fixture's 7 | [g8r](gate8/g8r.md) |
| Material adoption | arm pass 1.1-1.8 ms; frame-boundary pass 0.4 ms | [g8m](gate8/g8m.md) |
| HTTP zstd on the gate 6 `animate` scene (128 GETs) | 1,525,360 B -> 70,380 B (21.7x), 4.4 ms of coding on the I/O thread | [g8kz](gate8/g8kz.md) |
| `gate8-tex` payloads, zstd | 224,191 B -> 118,273 B (1.9x) | [g8kz](gate8/g8kz.md) |
| UASTC level 1 encode | about 1 s per Mpx per thread (STS2's 173 Mpx: about 1.5 min on two workers); within 0.1-0.4 dB of level 2 at 2.8-4.1x the speed | [g8ku](gate8/g8ku.md) |
| UASTC payload against decoded RGBA8 | 6x smaller (0.52 Mpx: 347 KB against 2.1 MB), PSNR 44-53 dB through BC7 | [g8ku](gate8/g8ku.md) |
| KTX2 transcode to BC7 (0.52 Mpx) | native 5.2 ms, web export 20.1 ms (about 3.8x) | [g8ku](gate8/g8ku.md) |
| Pass-through `block` against the GPU's own decode | native 0 px; GSW 203,702 of 209,605 equal, the rest differ by 1 | [g8kp](gate8/g8kp.md) |
| Hardware BC decode against the engine's CPU decode | 23,827 px at max delta 5 (BC1/BC3/BC7); ETC2/ASTC 0 px | [g8t](gate8/g8t.md) |
| Remote determinism of `g7-8` (lavapipe) | 12 runs agree, 205/205 shots, 70/70 dumps | [g8g](gate8/g8g.md) |

The STS2 census's wire and memory numbers (texture-delivery-design.md Q8: about 855 MB decoded per
client, about 76 MB under HTTP zstd) are projections from recovered images, not gate 8 results.

## What gate 8 does not prove

- That the installed game is captured correctly. That is P3, under F1; the generic gates show the
  mechanisms on stock-template fixtures only.
- That adoption is complete for arbitrary games: RS-only objects with no node, script `_draw`s
  depending on stale state, and pre-arm in-place texture or mesh updates outside the TextServer
  (`adopted_content: "creation"`) remain limits, counted or declared, not fixed.
- Exactness of host-decoded BC1/BC3/BC7 against a GPU's hardware decode: gate 8 pins equality with
  the engine's CPU decoder, and records the hardware band (23,827 px, max 5) as informative.
- Wire, GPU-memory or host-memory acceptability at STS2 scale. No gate 8 leg ran the game.
- ETC2 and ASTC `block` variants (a block-source recording) in either browser: the desktop GPU
  exposes neither to WebGL, and the g31 ran GSW's `uastc` transcodes (ASTC 4x4, ETC1), not a block
  source. A pending recovery in GSW (`delivery-pending`; native and web export are judged). The
  throttled link and ETC1S (G8ke).
- Several or negotiated presentation sizes, non-logical aspects, stretch mode `viewport`.
- Arm on first subscriber and disarm on last (gate1-design D6). Adoption makes it possible; gate 8
  neither implements nor measures it.
- Non-loopback serving or TLS in the capture (D14).
- Particles, multimesh, skeletons, animation slices, LCD text, `Light2D` and the shader reasons gate
  5.5 types; meshes refused `mesh-format`.
- A phone verdict. G8kb measured GSW's `uastc` path on the g31 (transcode cost, GPU memory, ASTC
  and ETC1 pixels, hd-patch p95 unchanged; [g8kb](gate8/g8kb.md)), but gate 8 ran no g7-dev device
  legs, so the browsers' device targets are `unverified`.
- Windows or macOS hosts, other engine builds, or a re-census of the game's PE.
