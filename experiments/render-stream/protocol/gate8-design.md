# Gate 8 design: the STS2 blockers, generic halves

Status: contract for gate 8, written 2026-10-22/23. G8w (the /8 wire, policy parsing and empty seams,
2026-10-23) is landed: [render-stream-8.md](render-stream-8.md), [results/gate8/g8w.md](../results/gate8/g8w.md).
G8t (host decode of block-compressed textures, the `gate8-tex` fixture and the gate 8 runner) is
landed: Q3 "As built (G8t)", [results/gate8/g8t.md](../results/gate8/g8t.md). G8a (arm-time adoption
of canvases, layers and items, the `gate8-adopt` fixture) is landed: Q2 "As built (G8a)",
[results/gate8/g8a.md](../results/gate8/g8a.md). G8sha (the capture's SHA-256 on SHA-NI, 5.7x, output
unchanged) is landed: [results/gate8/g8sha.md](../results/gate8/g8sha.md). Nothing else here is
implemented. The user decided on
2026-10-22 that public release needs the gate 8 blockers first (memory g31-good-enough-release-first).
Gate 8 is "integrate behind couch-coop's instance rules, with the streaming seat opting out of the
headless visual freeze/suspender" (`docs/handoff-headless-render-stream.md`, gate table). The single
STS2 shim leg (2026-10-10, memory rs-sts2-shim-leg-findings) found four generic blockers:

1. **Late-join adoption.** The capture arms at mod init, after 46 roots exist; 1302 items are
   withheld under `GRC_UNKNOWN_ITEM=skip` and both replays are flat clear colour.
2. **Compressed textures.** 940 of 1451 textures are refused `unsupported-format` (DXT1/5, BPTC,
   and the float formats RGBF/RGBAF/RGBAH).
3. **Host size.** The headless root is 64×64 against a 1920×1080 `canvas_items`/`expand` project
   (`degenerate-host-size`, visible rect 1920×1920, final transform scale 1/30).
4. **Pre-arm materials.** Materials and shaders made before arming are `unknown-material` /
   `unknown-shader`, including the process-global `CanvasItemMaterial` cache (gate5_5-design D7).

Every blocker splits into a **generic part**, which lands in this repository with fixtures on the
stock 4.5.1 template, and a **product part**, which lands in `../sts2-couch-coop` under its own
rules. Nothing here adds an STS2, couch-coop or product concept to the capture, the wire or
`packages/` (AGENTS.md "Architecture Rules"). Gate 7 files are not touched by this document; G8g is
the only increment that extends gate 7's runner, after G7z lands.

Hand it out piecewise: G8w, G8t, G8a, G8h, G8f, G8r, G8m, G8g, G8z, each one verified commit on
`main` from its own worktree (`agents/rs-increment.md`).

## Split by blocker

| Blocker | Generic part (here) | Product part (couch-coop) |
| ------- | ------------------- | ------------------------- |
| Late join | `GRC_ADOPT=arm`: an arm-time adoption pass over the scene tree (canvases, layers, items, item state, commands by redraw) and lazy adoption of pre-arm textures, meshes and glyph atlases by RID (D3-D7). Residue (RS-only items with no node) stays typed and counted. | Arm the streaming seat with `GRC_ADOPT=arm` plus `GRC_UNKNOWN_ITEM=skip`; the seat opts out of the visual suspender **and of `HeadlessTextureImageEvictor`**, which overwrites the very images adoption reads (Q1c); land the env-gated loader (F2). |
| Compressed textures | `GRC_TEXTURE_DECODE=engine`: the host decodes block-compressed payloads with the engine's own `Image::decompress` to RGBA8/R8/RG8 (D8). Float formats travel exact (D9). | Turn both on for the seat; measure host CPU, host memory and wire bytes on the game (F1). |
| Host size | `presentation:<W>x<H>` applied at a **late** arm, after adoption, so the running scene relayouts under the hooks (D10). | Pick the game's presentation size (default its logical 1920×1080). |
| Pre-arm materials | Adoption of materials and shaders through the item's node: `ShaderMaterial` code re-preprocessed through a capture-owned temporary `Shader`, params and instance params read back, `CanvasItemMaterial` shaders rebuilt from the builtin templates (D11, D12). | Choose `GRC_SHADER_POLICY` for game shaders (default `source`, served only to the operator's own receivers, gate5_5-design D4). |

Two more product items have no generic blocker behind them: **transport fronting** (the seat's
listener stays loopback; couch-coop's server proxies it with its own TLS and LAN exposure, D14), and
the **game legs** −0.5/−0.25 plus one visual leg on the current binary, which need the operator's
explicit go-ahead (F1).

## Decisions

| #   | Topic | Decision |
| --- | ----- | -------- |
| D1  | Protocol version | **`render-stream/8`, a small delta on the version-parameterized modules** (memory g4e1-rs3-version-switch-pattern): `Session::version` gains `V8` in `rs2_codec.*`/`rs2_diff.*`; `render-stream-2.ts` and rs-core take `version: … \| 8`. No forked files, no renames. `golden-2/` to `golden-7/` pass unchanged. Delta in Q6: resource tables accept `origin:"adopted"` (textures, meshes, shaders, materials refuse anything but `created` today: `render-stream-2.ts:1963`, `:2040`, `:2094`, `:2183`); texture and mesh entries gain `adopted_content`; texture entries gain `source_format`; the session gains `adoption`; float payload formats become legal; new sabotage kinds. Items and canvases already accept `adopted` since /0 (`render-stream-0.md:200`, reserved "for late join"). |
| D2  | Which sinks speak /8 | **Opt-in, per sink.** File sinks gain `GRC_STREAM_VERSION=6\|8` (default 6; `entry.cpp:1428` hard-codes V6 today). The live listener accepts `render-stream.8` beside .6 and .7. Any gate 8 policy (`GRC_ADOPT`, `GRC_TEXTURE_DECODE`, a float format in `GRC_RESOURCE_FORMATS`) with a /6 file sink refuses to publish (`stream.status` `refused`, `policy-needs-v8`), and the listener then offers only `render-stream.8`, so no /6-/7 decoder sees a field it would reject. Existing gates are byte-identical. |
| D3  | Adoption: read, don't replay | **Synthesize mirror state from bound getters; ask the engine to re-issue only what it re-issues routinely.** The RenderingServer keeps the whole canvas state headless (`RendererCanvasCull` is created regardless of the rasterizer, `rendering_server_default.cpp:219`) but exposes no canvas-item getters beyond instance parameters and a debug rect (`rendering_server.h:1613-1615`, `:1715`). So structure and item state come from the nodes. Two engine requests are allowed, both of which a running game issues constantly: `queue_redraw()` on every adopted item (re-sends `clear`, every command, and a `Control`'s custom rect and clip, `canvas_item.cpp:133-160`, `control.cpp:3898-3902`), and the top-level re-raise `SceneTree.call_group_flags(UNIQUE\|DEFERRED, "_root_canvas<id>", "_top_level_raise_self")` (bound, `canvas_item.cpp:1297`; group name `:275`). Re-entering the tree (`NOTIFICATION_WORLD_2D_CHANGED`, `:418-422`) or toggling properties would re-send more, but fires game-visible notifications and signals; rejected. |
| D4  | Adoption: when, where, order | **Synchronously at arm, on the main thread:** root query → adoption walk → size policy (D10) → session record. The first transaction is the first frame callback after arm; every queued redraw and the deferred re-raise have run by then (the MessageQueue flush drains messages added during the flush, and the frame callback follows it, `main.cpp:4802-4839`). Arming off the main thread with `GRC_ADOPT=arm` refuses (`adopt-thread`). The capture's own temporary objects (D11) are tapped under a reentrancy flag and never enter the mirror. |
| D5  | Adoption: what the walk adopts | **Every `CanvasItem` and `CanvasLayer` reachable from the root window**, in tree order; non-root viewports stay `non-root-viewport`. Per item: RID `get_canvas_item()`; parent as `_enter_canvas` computes it (parent item's RID, or `get_canvas()` for top-level items and items under a `CanvasLayer` or the viewport, `canvas_item.cpp:237-289`); child order = tree order; child draw index = `get_index()` with the C++ default `include_internal=true` (`canvas_item.cpp:444`, `node.h:543`); transform `get_transform()`; modulate, self-modulate, z index/relative, behind-parent, visibility layer, texture filter/repeat resolved through the parent chain as the node's cache does; RS visibility = `is_visible_in_tree()` (draw-equivalent: `_handle_visibility_change`, `:92-111`, re-sends it on the next change); material, `use_parent_material` and instance parameters (D11). Per layer: canvas `get_canvas()`, attach, stacking `(layer, get_index())` (`canvas_layer.cpp:40`), transform (`:83`), `CanvasModulate` colour (`canvas_modulate.cpp:40-60`). **Rule: adoption declares exactly what the hooks would have declared.** A non-default state the mirror types `unsupported` when hooked (y-sort, clip-children, light mask, skeleton, identity-transform items …) is typed the same when read. |
| D6  | Adoption: resources by RID | **Lazy, at first reference by a hooked call or an adopted item.** Textures: `RenderingServer.texture_2d_get` (bound, `rendering_server.cpp:2283`) returns the dummy's creation-time image *by reference* (`dummy/storage/texture_storage.h:82-86`, `:104-108`); the capture copies it and never mutates it. Meshes: `mesh_get_surface` (bound, `rendering_server.cpp:2365`) returns creation-time surfaces (`dummy/storage/mesh_storage.h:75-90`, `:111-117`). Both are exact unless the engine changed the content in place before arm, which the dummy drops: `texture_2d_update` (`texture_storage.h:94`), `texture_replace` keeps the old image (`:112`), mesh region updates (`mesh_storage.h:103-106`). `texture_get_format` is useless on the dummy (`FORMAT_MAX`, `:118`): read the format from the image. |
| D7  | Adoption: glyph atlases | **Read glyph atlas pages back from the TextServer, not the dummy.** Atlases are updated in place as glyphs are added (`text_server_adv.cpp:3472-3489` → `ImageTexture::update` → `texture_2d_update`, `image_texture.cpp:124`), so their dummy copy is stale. The TextServer keeps each page's current image (`font_get_texture_image`, `text_server_adv.cpp:3081-3092`); `font_get_glyph_texture_rid` maps a page to its RS RID (bound, `text_server.cpp:324-348`) and flushes a dirty page through the hooked update on the way (`:3472-3489`). Fonts come from `ThemeDB` (fallback, default and project theme) and from the resource cache (`ResourceLoader.list_directory` + `get_cached_ref`, bound, `core_bind.cpp:147-150`), each expanded by `Font.get_rids()`. **Limit:** `font_get_size_cache_list` lists only integer, non-oversampled caches (`text_server_adv.cpp:2759-2771`), so pre-arm atlases drawn at oversampling ≠ 1 cannot be addressed. Under D10's late presentation at the logical size, oversampling becomes 1 and those caches are no longer drawn from (Q4). |
| D8  | Compressed textures | **Route A: the host decodes at capture with the engine's own decoder.** Recommended over carrying compressed payloads (Q3): the g31 exposes no S3TC/BPTC at all, so a phone needs decoded texels under any route, and A puts that cost on the host; the result equals Godot's own fallback on a GPU without the format (GLES3 calls the same `Image::decompress`, `drivers/gles3/storage/texture_storage.cpp:735-746`); the decoders are already linked into release templates (`modules/bcdec/register_types.cpp:40-41`, `modules/etcpak/register_types.cpp:47-48`, `modules/astcenc/register_types.cpp:44`; encoders are `TOOLS_ENABLED` only); no receiver changes; no download. `GRC_TEXTURE_DECODE=off\|engine`, default `off`, declared in the session. The decode runs at the hook on the calling thread, on a duplicate (`Image.decompress`, bound, `core/io/image.cpp:3567`). The texture entry carries the payload's format and `source_format`. |
| D9  | Float formats | **Carried exact, no conversion on the host.** `RF RGF RGBF RGBAF RH RGH RGBH RGBAH` become legal payload formats at /8, with Godot's pixel sizes (4, 8, 12, 16, 2, 4, 6, 8). Native and web-export receivers hand them to `Image.create_from_data`, and GLES3 applies its own rule (32-bit float → half when `OES_texture_float_linear` is missing, `texture_storage.cpp:390-450`; the g31 lacks it). The GSW receiver quantizes to straight RGBA8 in rs-core's payload conversion (`rs-core/src/apply/payloads.rs`) and types `float-texture-quantized` as a receiver caveat. `RGBA4444`, `RGB565` and `RGBE9995` stay refused (no census need). |
| D10 | Host size at a late arm | **Gate 6's `presentation:<W>x<H>`, unchanged in meaning, applied after adoption.** `Window.set_min_size` at arm resizes a scene that has already laid out; the relayout, stretch, oversampling (`viewport.cpp:1064-1101`) and stylebox feather it causes reach the hooks as ordinary calls on adopted items. Order matters: size first would name unknown RIDs. One presentation size per session (gate6-design D2, gate7-design D12); the product's default is the logical size, so `host_size_status` is `match` and font oversampling is 1. Browsers keep CSS-fitting and typing `presentation-mismatch` (gate 7). Negotiated sizes stay deferred. |
| D11 | Pre-arm materials and shaders | **Resolved through the item's node, at arm and lazily.** Dummy material storage keeps neither code nor params (`dummy/storage/material_storage.h:97`, `:120-121`), so a material RID alone recovers nothing. Resolution: item RID → node (a map built by the walk and kept current from `SceneTree.node_added`, `scene_tree.cpp:1949`) → `get_material()` → for a `ShaderMaterial`: `get_shader()`, its code preprocessed by a **capture-owned temporary `Shader`** (`set_code(original.get_code())`, then `get_rid()` creates it through the hooked `shader_create_from_code`, `shader.cpp:54-58`, `:85-131`), parameters from `get_shader_parameter` over the shader's uniform list; instance parameters from `canvas_item_get_instance_shader_parameter`, which `RendererCanvasCull` keeps headless (`renderer_canvas_cull.cpp:1943-1948`). A material or shader set by RenderingServer calls with no resource behind it stays `unknown-material` / `unknown-shader`. |
| D12 | `CanvasItemMaterial` cache | **Rebuilt from the mode, never from the cache.** The cache is process-global and keyed by mode (`canvas_item_material.cpp:37`, `:61-62`), so a post-arm material can name a pre-arm shader whose code never reached the hooks. The capture already holds the 36 templates it recognizes (gate5_5-design D7); an unknown shader on a material whose resource is a `CanvasItemMaterial` becomes an adopted shader with the template code for `(blend_mode, light_mode, particles_animation)` read from its getters, and the same `builtin` object. |
| D13 | Caps | **The mirror's caps become configuration**: `GRC_MIRROR_MAX_ITEMS` (default 4096, `gate0-design.md:335`) and `GRC_MIRROR_MAX_COMMANDS` (default 1024, `:347`). STS2 had 2393 live items armed late, before any adoption; adoption adds every pre-arm item. No wire change: `mirror-capacity` exists. |
| D14 | Non-loopback serving and TLS | **Not in the capture.** The listener stays loopback-only with its bearer token (gate2-design D13). A product that serves a phone on its LAN fronts the WebSocket and resource GETs with its own server, which owns TLS and exposure (couch-coop already runs a secure-origin browser server). Receivers fetch resources on the WebSocket's own host and port (`render-stream-2.md`, `resources.fetch`), so a reverse proxy that forwards both works without a wire change. G8g adds one proxy leg to prove it. |
| D15 | Independent expectations | **Three, none a replay of the capture.** (1) **Born-armed equivalence**: the late-armed capture's resolved state equals a capture of the same scene armed before it existed, at every checkpoint, modulo Q2's exception list. (2) **The rendered reference** (as every gate), compared with each receiver under the existing budgets. (3) **Engine oracles in a separate process**: decoded payload hashes from `Image.decompress` of the same imported `.ctex`, shader and parameter parity from a rendered reference's `shader_get_code`/`material_get_param` (GLES3 keeps both, gate5_5-design D12), and atlas content from that reference's TextServer. |
| D16 | Result classes | **Gate 7's, extended.** `capture-failure` gains `adopt-thread` and `policy-needs-v8`. `partial-unknown-items` (skip) still ranks just above `success` and still names the residue. An adopted texture or mesh with `adopted_content:"creation"` is not a failure; the leg's reasons count them. |

## Q1. Engine facts the design rests on

### Q1a. What exists before arm, and when arm happens

- Route (a) arms in an autoload's `_enter_tree`, after the root canvas (`world_2d.cpp:104`) and after
  the main scene's `canvas_item_create`s (`main.cpp:4557`); a startup-listed extension is no earlier
  (gate0-design Q1, memory gate0-route-a-fixture-rule). So *every* route sees pre-existing items,
  and adoption is needed even for a developer-installed capture whose main scene draws.
- The modder route (STS2) arms at mod init, much later: the root scene is built and has drawn.
- A runtime `GDExtensionManager.load_extension` initializes to the current level immediately, and
  the frame callback runs for it (the STS2 leg published 1000 transactions armed this way).
- Draw commands are produced in the MessageQueue flush (`CanvasItem::_redraw_callback`), so a
  headless host still records them although `RS::draw()` never runs (memory
  rs-interposition-megadot-facts).

### Q1b. What can be read back, and from where

| State | Readable? | From |
| ----- | --------- | ---- |
| Canvas item structure, transform, modulate, z, visibility, clip, filter, material | Not from RS (no getters) | Node getters (D5) |
| Draw commands | No | Re-issued by `queue_redraw()` (D3) |
| Top-level draw indices | No (values come from internal counters) | Re-issued by `_top_level_raise_self` (D3) |
| Instance shader parameters | Yes | `canvas_item_get_instance_shader_parameter` (`renderer_canvas_cull.cpp:1943`) |
| Texture pixels | Creation-time image only | `texture_2d_get` (D6) |
| Glyph atlas pixels | Current, integer non-oversampled caches only | TextServer (D7) |
| Mesh surfaces | Creation-time bytes only | `mesh_get_surface` (D6) |
| Shader code | No (`shader_get_code` returns `""` on the dummy) | `Shader` resource, re-preprocessed (D11) |
| Material parameters | No (`material_get_param` returns nil on the dummy) | `ShaderMaterial` resource (D11) |
| `CanvasTexture` | No: `canvas_texture_allocate` returns `RID()` headless | Unchanged: typed, or the opt-in shim (canvas-texture-headless.md) |
| Skeletons, particles | No: `RID()` stubs on the dummy | Unchanged: typed unsupported |

### Q1c. Dummy texture storage and the product's evictor

The dummy duplicates the image at `texture_2d_initialize` and returns that duplicate by reference
from `texture_2d_get`. couch-coop's `HeadlessTextureImageEvictor` (couch-coop `main`,
`src/CouchCoop.Mod/Session/HeadlessTextureImageEvictor.cs`) exploits exactly that: on headless
seats it replaces the dummy's copy of VRAM-compressed textures with 1×1 data to reclaim memory
(measured there: 1491 images, 456 MB on a live seat). On a streaming seat that would make every
adopted compressed texture 1×1, so the seat must not install it (product part). The capture cannot
detect it in general; the product leg's census (a 1×1 image behind a texture drawn at 4096 px) will.

### Q1d. Which compressed formats appear, and who can sample them

- A desktop host imports VRAM-compressed textures as S3TC/BPTC only, unless the project overrides
  (`editor/import/resource_importer_texture_settings.cpp:38-45`,
  `servers/rendering_server.cpp:3608-3609`).
  STS2 ships desktop: its armed census holds DXT1, DXT5 and BPTC_RGBA, no ETC2/ASTC.
- `CompressedTexture2D::load` hands the compressed image to `texture_2d_create` unchanged
  (`scene/resources/compressed_texture.cpp:143-148`), so the hook sees the block-compressed bytes.
- WebGL 2 extensions, from gate 7's probes (D19 there): desktop harness Chromium exposes
  `WEBGL_compressed_texture_s3tc(_srgb)`, `EXT_texture_compression_bptc`/`_rgtc`, ETC, ETC1 and ASTC;
  **the g31 (ANGLE on Mali-G52) exposes only `WEBGL_compressed_texture_etc`, `_etc1` and `_astc`**,
  and no `OES_texture_float_linear`.
- Godot's GLES3 decompresses on the CPU any compressed format the GPU lacks
  (`texture_storage.cpp:505-746`). bcdec decodes DXT1/3/5 and BPTC_RGBA to RGBA8, RGTC to R8/RG8,
  and BC6H to RGBH (`modules/bcdec/image_decompress_bcdec.cpp:224-267`).

### Q1e. The STS2 census, read again for gate 8

From the leg's `evidence/resources.jsonl` (couch-coop's ignored research tree, never committed):
every one of the 1437 logged `texture_2d_create`s happened **after** arming. So the 940 format
refusals are independent of late join, and pre-arm textures (not logged at all) will add to them
once adoption exists.

| Format | Textures | Compressed bytes | As RGBA8 | Created on main thread |
| ------ | -------- | ---------------- | -------- | ---------------------- |
| BPTC_RGBA | 65 | 92.5 MB | 370 MB | 14 (63.1 Mpx, the largest 16.4 Mpx) |
| DXT5 | 87 | 80.1 MB | 320 MB | 2 (3.9 Mpx) |
| DXT1 | 7 | 0.2 MB | 1.5 MB | 1 |
| RGBF / RGBAF / RGBAH | 742 + 39 + 1 creates, ≤ 256 px each (curve-sized) | 5.3 MB | — | mostly loader threads |

## Q2. Late-join adoption (blocker 1)

**Behaviour.** With `GRC_ADOPT=arm`, arming walks the root window's tree (D4, D5), registers every
canvas, layer and item with `origin:"adopted"`, synthesizes its state, queues its redraw and the
top-level re-raise, and builds the item-RID → node map. Resources are adopted lazily (D6, D7, D11).
Afterwards the mirror runs exactly as before: every later call is an ordinary hooked mutation.
`GRC_ADOPT=off` (the default) changes nothing. Under strict, any RID the walk did not reach is still
`pre-existing-object`; under `skip` it is withheld and counted, as today.

**Fixture `fixtures/gate8-adopt/`** (stock template, synthetic content, 640×360, stretch
`disabled`). One `PackedScene`, `adopt.tscn`, run two ways by the same loader autoload:

- `born`: the loader arms in `_enter_tree`; a plain `Node` main scene instantiates `adopt.tscn` in
  `_ready` (gate 0's rule), so every object is created armed;
- `late`: `adopt.tscn` is the main scene, so it is constructed before arming
  (`main.cpp:4557`); the loader arms at fixture frame K (`RS_FIXTURE_ARM_FRAME`, default 12), after
  the scene has drawn, moved, raised top-level items, hidden a subtree and changed a filter.

Content: nested `Node2D`/`Control` transforms, modulate and self-modulate, z and behind-parent,
a hidden subtree shown after arm, a `clip_contents` `Control`, two top-level items, a `CanvasLayer`
(layer 2) with a `CanvasModulate`, texture filter/repeat inheritance, post-arm textures only (pre-arm
resources are G8r's), and one RS-only item made by `RenderingServer.canvas_item_create` in a script
before arm (the residue). Step-driven timeline as gate 6 (D6 there).

**Wire.** /8: adopted origins already legal on items and canvases; the session `adoption` object.

**Impact.** Capture: a new `capture/src/rs_adopt.{h,cpp}` (walk, method-bind pins with their
`--dump-extension-api` hashes as gate 0 does, node map), `rs_mirror.*` adoption entry points,
`entry.cpp` arm order, D13's caps. rs-core and receivers: none beyond G8w's /8 decode; an adopted
item draws like any other.

**Checks.**
- `adopt-equivalence` (D15.1): at every checkpoint after K, `late`'s resolved state equals `born`'s,
  with these and only these exceptions: ids, versions and `content_version` values (compared through
  an id bijection); `origin`; draw-index *values* (order per parent compared instead); items that
  were hidden at arm carry no commands until shown; the RS visibility flag of items under a hidden
  ancestor (effective visibility compared); the residue item (absent from `late`, counted).
- `adopt-reference`: receiver shots equal the rendered reference under gate 6's budgets.
- `adopt-account`: the session's `adoption` and `result.json` counts equal `expected.json`'s census;
  under strict the residue gives `pre-existing-object`, under `skip` exactly one unknown RID.
- `adopt-no-scene-mutation`: a fixture probe hashes every node's stored properties at K−1 and K+1;
  equal. Only `draw` signal counts move.

**Sabotages** (capture kinds, new at /8): `adopt-skip-state` (structure without transforms or
modulate), `adopt-no-redraw` (no `queue_redraw`), `adopt-skip-layers` (canvas layers left
unknown). Each must fail `adopt-equivalence` and `adopt-reference`; the last also changes the
account.

**Stays unsupported, typed.** RS-only items, canvases and layers with no node (counted, withheld
under `skip`); a `_draw` that depends on state changed since its last redraw (it redraws with the
current state; documented, not detectable); non-root viewports; everything the hooks already type.

### As built (G8a)

Decisions taken where Q2 and D3-D5 left room, each the long-term option:

- **Two halves.** `rs_adopt.cpp` walks the tree into an `AdoptPlan` (read-only ptrcall binds, 41
  pinned at their 4.5.1 hashes) and applies it with an engine-free `apply_adopt_plan`, which drives
  the mirror through the hooks' own setters (`Mirror::adopt_canvas`/`adopt_item`, then
  `set_parent`, `set_visible`, ...). D5's rule ("adoption declares exactly what the hooks would
  have declared") therefore holds by construction, and `test/rs_adopt_test.cpp` drives a
  born-armed hook sequence and the equivalent plan into two mirrors and compares them.
- **Which calls.** Every item gets what `NOTIFICATION_ENTER_TREE` sends (parent, visibility layer,
  visible = `is_visible_in_tree()`, filter and repeat resolved through the parent chain as
  `_refresh_texture_filter_cache` does) and a child item its deferred draw index (`get_index(true)`);
  transform, modulate, self-modulate, z, z-relative, behind-parent, material and use-parent-material
  only where they differ from the server default, as the setters only call the server on a change.
  A layer gets attach, canvas transform, follow-viewport parent and stacking `(layer, get_index())`;
  a canvas its first visible-in-tree `CanvasModulate` in tree order (the engine's "active" one is
  whichever became visible first; with one per canvas, as the engine's configuration warning asks,
  they agree). Node-specific state the hooks type is declared too: a `Light2D`'s canvas light
  (`canvas-light`), a `ParallaxLayer`'s mirroring and a `Parallax2D`'s repeat (`canvas-repeat`). The
  walk includes internal children and does not descend into a non-root viewport (counted).
- **The re-raise is synchronous.** D3 names a deferred `call_group_flags(UNIQUE|DEFERRED,
  "_root_canvas<id>", "_top_level_raise_self")`. G8a calls the bound `_top_level_raise_self` itself
  on every canvas-group member, per canvas, in tree order, right after applying the plan: the same
  calls in the same order the group call makes, through the hooks, without building Variant
  arguments for a vararg bind (and without the one-iteration group-call lag of memory
  gate1-top-level-draw-index-lag). The bind is omitted from `--dump-extension-api` (a leading
  underscore) but resolves: a hash covers the signature only, so it is `queue_redraw`'s.
  `queue_redraw` stays deferred, so commands, a Control's transform, custom rect and clip arrive in
  the arm iteration's MessageQueue flush, before the frame callback publishes.
- **Frames.** Under `GRC_ADOPT=arm` the capture aligns its frame counter with
  `Engine.get_process_frames()` at arm (the 0-based index of the iteration running; it advances
  after the frame callback, `main.cpp:4852`). A runtime-loaded capture otherwise counted from its
  load, so `adoption.frame`, every hook stamp, transaction frame and `GRC_SABOTAGE_FRAME` are now
  the host's main-loop iteration, as they already were for a capture loaded at startup.
  `adoption.frame` is the iteration the walk ran in (G8w's "may refine").
- **Refusals.** `adopt-thread` (the caller is not `OS.get_main_thread_id()`) and
  `adopt-unavailable` (a bind is missing at its hash) refuse the stream before anything is
  published (`stream.status` `refused`); the three walk sabotages refuse without `GRC_ADOPT=arm`.
- **Caps (D13).** `GRC_MIRROR_MAX_ITEMS` and `GRC_MIRROR_MAX_COMMANDS`, integers 1..1048576,
  defaults 4096 and 1024; an invalid value refuses the stream. The canvas cap is the item cap, as
  before.
- **Accounting.** `result.json`'s `stream.gate8.adopt_stats` gains `error`, `hidden`, `top_level`,
  `redraws`, `canvas_modulates`, `lights`, `materials`, `non_root_viewports`, the walk, apply,
  engine and total times, and the caps. `residue` is discovered, not walked: under skip it is the
  mirror's distinct unknown canvas/item RIDs named after arm; under strict it is null (the first
  one is the sticky `pre-existing-object`).
- **Exceptions as checked.** `adopt-equivalence` applies Q2's list with one precision: an item not
  visible in tree in either capture is exempt from its *draw-derived* state, which is its commands
  and, for a Control, the custom rect and clip its `NOTIFICATION_DRAW` sends (a hidden Control's
  redraw sends neither). Texture references compare through payload hashes (a born capture also
  sees the engine's frame-1 default-theme texture). The bijection is per container in draw order;
  the residue is the born-only trailing commandless item.
- **Fixture.** As specified, plus a `born-adopt` capture (adoption at birth adopts nothing and
  publishes born's states exactly: `adopt-noop-at-birth`), a `late-thread` capture (the loader
  loads the extension from a worker `Thread`: `adopt-thread-refused`), a Control inside the hidden subtree, an
  adopted item freed after arm and a post-arm item added; the residue sits at draw index 1000 so the
  bijection meets it last. `adopt-no-scene-mutation` also counts the arm's `draw` signals (one per
  item visible in tree).
- **Stays unsupported, typed, beyond Q2's list.** Instance shader parameters of adopted items
  (G8m reads them with the materials); Polygon2D skeletons (`attach_skeleton` is not re-sent);
  `canvas_item_set_use_identity_transform` items (no getter: their transform is read as the node's);
  RS state a script set directly on a node's own canvas item (read as the node's state).

## Q3. Compressed and float textures (blocker 2)

### Options weighed

| | A: host decodes (D8) | B: carry compressed, receivers decode or upload | C: carry compressed, host serves a decoded variant on request |
| - | -------------------- | ----------------------------------------------- | ------------------------------------------------------------- |
| g31 (no S3TC/BPTC) | gets RGBA8 | must CPU-decode BC1-7 in the phone's browser | gets RGBA8 from the host |
| Desktop receivers | RGBA8 (4-8× GPU memory) | native upload | native upload |
| Wire, STS2 census | ~692 MB if every texture is fetched | ~173 MB | 173 MB desktop, 692 MB phone |
| Host memory, store | ~692 MB of payloads at worst (on top of the dummy's own copies) | ~173 MB | 173 MB + a bounded variant cache |
| Receiver changes | none | GSW: compressed upload + a BC decoder in rs-core; native and web export already decode | GSW: capability choice + compressed upload |
| New code dependency | none (the engine's decoder) | a BC decoder for rs-core: a crate download, or vendoring Godot's `thirdparty/misc/bcdec.h` (MIT) | none on receivers |
| Wire | `source_format` key (/8) | new payload formats + per-format receiver capability (/8+) | variant route + capability (/8+) |
| Oracle | engine `Image.decompress` hash | payload bytes = `.ctex` bytes | both |

**Cost of A, measured** 2026-10-22 on the development host (Ryzen 5 5500), one `Image.decompress`
call on a synthetic 2048² image, best of 3, with the pinned 4.5.1 editor binary (same decoder
sources as the template; G8t re-measures on the template): DXT5 6.8 ms (618 Mpx/s), BPTC 35.6 ms
(118 Mpx/s), ETC2 10.7 ms (392 Mpx/s), ASTC 4×4 73.1 ms (57 Mpx/s). Applied to the STS2 census:
~0.8 s of BPTC and ~0.13 s of DXT decode over the session. The worst single main-thread hitch is
the 16.4 Mpx BPTC atlas: ~140 ms decode plus ~190 ms SHA-256 of its 66 MB payload at the 352 MB/s
the leg's own `hash_ns` shows. Hashing the larger payload costs more than decoding it.

**Recommendation: A now.** It unblocks every receiver, the phone included, with no receiver change
and no download, and its texels are the engine's own fallback. C is the long-term optimization for
desktop receivers (¼ wire, ¼ GPU memory) and needs A's decoder anyway, as the phone's path. Revisit
C only if the STS2 leg measures A's wire bytes or host memory as a problem (F3). B is rejected: it
moves the decode onto the phone, the opposite of the perf goal. If the main-thread hitch matters, the
follow-up is to defer the hash off the calling thread (G7o1's pattern), not to change routes.

**Fixture `fixtures/gate8-tex/`** (independent of adoption: everything created after arm, as in
STS2's census). Synthetic textures imported by the pinned editor as VRAM Compressed: DXT1 (no
alpha), DXT5 (alpha), BPTC (high quality), RGTC (a single-channel mask), plus a lossless RGBA8
control and one `CurveTexture`/`CurveXYZTexture` and `GradientTexture1D` (HDR) each for RF, RGBF
and RGBAF. Imports land in the ignored `.godot/imported`. Drawn as sprites, nine-patches and
`draw_texture_rect_region` at filter nearest and linear, with mipmaps on one DXT5.

**Wire.** /8: `source_format` on texture entries; float formats legal; `data_bytes` per D9.

**Impact.** Capture: `rs_texture_payload.cpp` and the hook copy path (`hooks.cpp` around the
`unsupported-format` branch): duplicate → `decompress()` → RGBA8/R8/RG8 payload; `decode_ns` in the
hook log. rs-core: payload validation and RGBA8 conversion for float formats; rs-core-capi:
image format codes beyond the six (`receiver/rs_rust_applier.gd` passes `-1` for "not one of the
six" today). GSW: D9's quantization. Native and web export: nothing beyond rs-core-capi.

**Checks.** `decode-oracle` (every decoded payload's hash equals the hash an independent headless
script computes from the same `.ctex` with `Image.decompress`); `decode-reference` (receivers equal a
reference that draws the CPU-decoded image, exact; the hardware-sampled reference is recorded beside
it as an informative band, since BC1/BC3 interpolation rounding is vendor-defined and BC7 is not);
`decode-census` (every source format in `expected.json` appears with its `source_format`, none
`unsupported-format`); `decode-cost` (per-format Mpx/s and the largest calling-thread hitch, measured,
no budget); `float-exact` (native receivers equal the reference; GSW within its band).

**Sabotages.** `perturb-decode` (flip one texel after decoding, before hashing: the oracle and the
pixels must fail); the `GRC_TEXTURE_DECODE=off` control leg must reproduce today's
`unsupported-format` refusals exactly.

**Stays unsupported, typed.** BC6H/ASTC-HDR (decode to half floats: legal at /8 through D9, but
not in the fixture until a need appears), `DXT5_RA_AS_RG`/`ETC2_RA_AS_RG` (GLES3 converts them
further, `texture_storage.cpp:742-745`; typed `unsupported-format` until a fixture covers them),
`RGBA4444`/`RGB565`/`RGBE9995`, layered and 3D textures.

### As built (G8t)

Decisions taken where this section left room, each the long-term option:

- **What decodes.** `rs_texture_decode.cpp` holds the table: DXT1, DXT3, DXT5, BPTC_RGBA → RGBA8;
  RGTC_R → R8; RGTC_RG → RG8 (bcdec); ETC, ETC2_R11, ETC2_RG11, ETC2_RGB8, ETC2_RGBA8 → RGBA8
  (etcpak always writes RGBA8); ASTC_4x4, ASTC_8x8 → RGBA8 (astcenc LDR). Declined, so typed
  `unsupported-format` as before: BPTC_RGBF/RGBFU and ASTC_*_HDR (they decode to half floats:
  G8f's), DXT5_RA_AS_RG and ETC2_RA_AS_RG (as above), ETC2_R11S, ETC2_RG11S and ETC2_RGB8A1 (etcpak
  has no decoder for them: its ERR_FAIL would leave the image compressed), and every format that is
  not block-compressed. DXT3, ETC and ASTC_8x8 are in the table although the 4.5.1 importer never
  produces them (same decoders, same RGBA8 output); the fixture cannot cover them.
- **How.** The seam calls `Resource.duplicate(false)` on the hooked Image (`Image::_duplicate`
  shares the bytes copy-on-write) and `Image.decompress()` on the copy, through ptrcall method binds
  resolved at arm; the engine's image is only ever read. It then checks the result: exactly the
  table's format at the source's width, height and mipmaps, or the request is declined. That makes a
  missing or failed decoder (a release build without a module) a typed refusal, never a payload
  under the wrong name. A decoded payload outside `GRC_RESOURCE_FORMATS` or over
  `GRC_RESOURCE_MAX_PAYLOAD_BYTES` keeps the source's refusal fields. `hooks.cpp` builds the GRT1
  payload from the decoded bytes and hashes it, exactly as for an RGBA8 image.
- **Cost accounting.** Per texture, the hook log's existing `decode_ns` column (duplicate plus
  decompress on the calling thread, also on a decode that was tried and refused) beside `copy_ns`
  and `hash_ns`; a trailing `source_format` key appears only on a decoded line, so no other log
  changes. Per session, `result.json`'s `stream.gate8.decode_stats` (decoded, declined, decoded
  bytes, total and largest decode time). perf.json is unchanged.
- **perturb-decode** inverts texel 0's first byte on a private copy of the decoded bytes, from
  `GRC_SABOTAGE_FRAME` on; it refuses to start without `GRC_TEXTURE_DECODE=engine`.
- **Receivers.** The native receiver had to read /8 files to be judged at all (D2 forbids a decode
  policy on a /6 sink): `receiver.gd` replays a GRS8 recording at /8 and `rs-core-capi` accepts
  version 8. That is the receiver's only change, and the web export's core gets it too; the live
  hello still offers `.6`/`.7`. The GSW and web receivers' gate 8 legs stay G8g's (they need
  `run-gate7.sh`'s group table).
- **Fixture.** As above, minus the float textures (`CurveTexture`, `CurveXYZTexture`,
  `GradientTexture1D`: G8f's float legs) and plus RGTC_RG, the mobile family (ETC2_RGB8,
  ETC2_RGBA8, ETC2_R11, ETC2_RG11, ASTC_4x4, from `import_etc2_astc=true`) and an HDR EXR whose
  BPTC_RGBFU and ASTC_4x4_HDR imports are the declared refusals. Sources are generated by the
  editor (`make_sources.gd`) and never committed, nor are the `.ctex` imports. The reference
  (`reference`) draws the oracle's own decoded payloads; `reference-hw` draws the `.ctex`.
- **Checks as built.** `decode-oracle`, `decode-reference` (exact, full and patch sinks),
  `decode-census`, `decode-cost` and the `perturb-decode` sabotage as specified; plus `g8t-import`
  (the editor produced the formats `expected.json` derives), `decode-wire` (the /8 recording
  validates, its session declares `decode: "engine"`, its entries carry the hook's formats) and
  the non-gating `decode-hardware-band`. `decode-off` runs the default /6 file sink (no gate 8
  policy at all), which is what "today" means; `float-exact` is G8f's.
- **Measured on this host** (results/gate8/g8t.md): the hardware-sampled reference differs from the
  CPU-decoded one by 23,827 px (max channel delta 5) on the S3TC/BPTC step and by 0 px on the
  ETC2/ASTC step (desktop GLES3 decodes those on the CPU itself). The hook's cost on a 2048² texture
  is dominated by the SHA-256 of the 16 MiB payload, not the decode, except for ASTC. G8sha
  (results/gate8/g8sha.md) moved the hash to SHA-NI: ~48.5 -> ~8.4 ms, now the smallest of
  decode, copy and hash for every format.

## Q4. Host size at a late arm (blocker 3)

**Behaviour.** With `GRC_ROOT_SIZE=presentation:<W>x<H>` and a late arm, the capture calls
`Window.set_min_size(W,H)` after the adoption walk. Under `canvas_items` the engine recomputes the
stretch transform and font oversampling (`viewport.cpp:1064-1101`) and the window resize relayouts
`Control`s; under `expand`, the visible rect goes from the 64×64 window's aspect (STS2: 1920×1920)
to the logical size. All of it reaches adopted items through the hooks. Text redraws at the new
oversampling: at oversampling 1 glyphs come from the base caches, which are either rasterized fresh
under the hooks or readable through D7; the pre-arm oversampled caches (level 0.1 at a 64×64 window)
are released when unreferenced (`text_server_adv.cpp:1965-1982`).

**Fixture `fixtures/gate8-size/`**: logical 640×360, `canvas_items`, aspect `expand`, anchored
controls, a `StyleBoxFlat` panel (feather) and two `Label`s; run at the headless 64×64 window for K
frames, then a late arm with `presentation:640x360`. The reference renders at 640×360 from frame 0.
A `born` arm (route (a) with `presentation:`) is the equivalence control.

**Wire.** None beyond /6's root-size fields; the session's `adoption.frame` dates the resize.

**Impact.** Capture only (`entry.cpp` order; `rs_root_query.cpp`). No receiver change.

**Checks.** `late-size-match` (`host_size_status` `match` and `font_oversampling` 1 after arm);
`late-size-reference` (receivers equal the reference from the first checkpoint after a two-frame
settle); `late-size-equivalence` (equals `born`, Q2's exceptions); `late-size-atlas` (every atlas
page drawn after arm is a post-arm create or a D7 readback).

**Sabotage.** `size-before-adopt` (apply the size before the walk): strict gives
`pre-existing-object`, `skip` loses the relayout of every adopted control; both must fail.
(As built: under skip the walk's node reads recover the state, so detection is by the account, see
"As built (G8h)".)

**Stays unsupported.** A presentation aspect other than the logical one under `expand`/`keep_*`
(`root-size-enforce-failed`, as gate 6); several or negotiated presentation sizes; stretch mode
`viewport` (gate 6's census).

### As built (G8h)

G8h needed almost no capture code: G8a had already put D10's order into `entry.cpp` (root query,
adoption walk, then the size policy), so the late presentation is one `Window.set_min_size` call
the arm makes after the walk. What it adds is the fixture, the checks, and the sabotage.

- **What the policy does at a late arm.** The headless host is the 64x64 SceneTree minimum, so a
  `canvas_items`/`expand` scene is at stretch scale 0.1, visible rect 640x640, oversampling 0.1
  (measured, `fixtures/gate8-size/expected.json`). After adoption `set_min_size(640,360)` makes the
  window the logical size: scale 1, visible 640x360, oversampling 1, `host_size_status` `match`.
  The relayout, stretch and oversampling are synchronous inside the call; the Controls' re-layout
  and the Labels' redraw reach the hooks as ordinary calls on adopted items, before the first
  transaction (the arm frame).
- **Q4's `late-size-atlas` holds without D7.** After the resize every Label draws from oversampling-1
  caches that did not exist before the arm, so their glyph pages are created under the hooks. The
  check asks that every texture drawn from the arm on is `origin:"created"` and no `unknown-texture`
  is reported. It does not need the TextServer readback; a scene whose text was already drawn at
  oversampling 1 before the arm is G8r's.
- **`size-before-adopt` under skip is detected by the account, not by state or pixels.** The design
  predicted skip "loses the relayout of every adopted control". It does not: the walk reads the
  nodes (D3), so it reads them after the resize, and its `queue_redraw` re-sends every command.
  The capture's state equals `born` and the receiver's pixels equal the reference (0 problems, 0 px).
  What the sabotage does leave is the account: the relayout's calls named RIDs nothing had adopted,
  counted as `unknown_calls` (2 in the fixture; 0 in the honest capture). `late-size-account`
  asserts 0, and the sabotage check asserts that it would fail on the sabotaged capture. Under
  strict the first such call is the sticky `pre-existing-object`, as predicted. This makes the
  ordering rule of D10 a rule about the account and the strict policy, not about pixels: a product
  on skip that applied the size first would still render right.
- **Controls.** `born` (presentation armed at birth) is the equivalence control; `late-observe`
  (late arm, adoption, no `presentation:`) records `degenerate-visible` at oversampling 0.1 and its
  receiver differs from the reference (146,297 px over three checkpoints), so `late-size-reference`
  has teeth. The fixture also logs the engine's own window, visible rect, stretch and oversampling
  at K-1 and K+1 (`RS_FIXTURE_SIZE_LOG`), an independent read for `late-size-match`.
- **Sabotage wiring.** `GRC_SABOTAGE=size-before-adopt` (G8w's kind) refuses unless `GRC_ADOPT=arm`
  and `GRC_ROOT_SIZE=presentation:` are both set; it writes the size ahead of the walk and skips the
  second write.

## Q5. Pre-arm materials and shaders (blocker 4)

**Behaviour.** At arm, each adopted item's material is resolved (D11, D12). After arm, a hooked
call that names an unknown material or shader (a post-arm item given a pre-loaded material; a
post-arm `ShaderMaterial` on a pre-loaded `Shader`; a `CanvasItemMaterial` mode first used before
arm) is resolved at the next frame boundary through the item's node, before the transaction is
formed. Adopted shaders and materials publish with `origin:"adopted"`; their code and params are
ordinary `GRP1` payloads and `param_f64` values under `GRC_SHADER_POLICY`.

**Fixture `fixtures/gate8-mat/`**: a `ShaderMaterial` whose `Shader` `#include`s a `res://`
`ShaderInclude` (so preprocessed code ≠ raw code), with a texture parameter, an instance uniform,
and a parameter changed before arm; a `CanvasItemMaterial` (blend `add`) whose mode is first used
before arm; after arm, new nodes reuse the pre-arm material, a new `ShaderMaterial` takes the
pre-arm `Shader`, and a new `CanvasItemMaterial` reuses the cached mode. Run `born` and `late`.

**Impact.** Capture: `rs_adopt.*` (material path, node map from `node_added` connected with a
custom callable), the mirror's material and shader tables, the hook reentrancy flag (D4). No
receiver change: adopted entries are ordinary table entries.

**Checks.** `shader-hash-parity` and `param-parity` against the rendered reference's oracle (gate
5.5's `material_oracle.gd`), `adopt-cim-builtin` (the cached mode publishes with its `builtin`
object), `adopt-equivalence` and `adopt-reference` as in Q2.

**Sabotages.** `adopt-raw-shader-code` (publish `get_code()` unpreprocessed: hash parity must fail),
`adopt-skip-params` (param parity must fail).

**Stays unsupported, typed.** Materials and shaders created by raw RenderingServer calls; a shader
whose include resolves relative to the original resource path (the temporary `Shader` has none;
typed `shader-adopt-include` when the preprocessed code differs in its `@@` markers); D11 of gate
5.5's shader reasons (`TIME`, screen texture, SDF, globals) unchanged.

## Q6. Wire: render-stream/8 (G8w)

`render-stream-8.md` states /8 as /7 plus exactly:

- magic `GRS8`, protocol string, subprotocol `render-stream.8`; file sinks may speak it (D2);
- the session key `adoption`, right after `unknown_item_policy`:
  `null | {"mode":"arm","frame":<int>=1>}`;
- `origin` in the texture, mesh, shader and material tables: `"created" | "adopted"`;
- texture and mesh entries: `"adopted_content": null | "current" | "creation"`, non-null iff
  `origin` is `adopted`. `current` means provably current (a TextServer readback, D7, or a
  `CompressedTexture2D` reached through a node, which the engine never updates in place);
  `creation` means the dummy's creation-time copy (D6);
- texture entries: `"source_format": null | <format name>`, non-null iff the payload is a host decode
  (D8); `format` stays the payload's format;
- float payload formats legal, with D9's sizes (`render-stream-2.md` "Texture payload");
- `resources.decode`: `"off" | "engine"`;
- sabotage kinds: Q2-Q5's seven.

Records, blocks, items and commands are otherwise byte-identical to /7. Goldens: `golden-8/` gets a
full/patch/inline triple this time (resource tables change shape), built by `make_golden.py` from
`rs2_golden_states.h` plus adopted and decoded entries; verify inline `record_index` values by
decoding, not by counting (memory g4e1-rs3-version-switch-pattern). The TypeScript checker decoder
stays the independent oracle for rs-core (memory rust-core-direction).

## Q7. Runner, legs, smoke map

- `scripts/run-gate8.sh`, `scripts/check-gate8.ts`, `scripts/lib/gate8-*.ts`; groups `g8t`, `g8a`,
  `g8h`, `g8f`, `g8r`, `g8m`, each with its fixture's `born`/`late`/reference legs. Correctness legs
  are fast-frames eligible once they count frames (`RS_FAST_ALLOW_LEGS`); `decode-cost` is a
  timing leg (`timing_leg`).
- `smoke-map.json`: G8t adds `gate8` to `universe.native` and a rule mapping
  `run-gate8.sh`, `check-gate8.ts`, `lib/gate8-*`, `fixtures/gate8-*/**` to `native:gate8@*`. G8g
  adds `g7-8` to `universe.g7` and the gate 8 rule's reach.
- **Validation cost.** Every gate 8 increment but G8z touches `capture/**`, `rs-core/**` or the
  shared decoders, which the map sends to `*`. Each full tier is therefore milestone-sized
  (the pre-G7v sweep took 5.5 h). Two mitigations, both inside the existing rules: keep adoption and
  decode in new opt-in files and land the call sites once (G8w adds the empty `rs_adopt`/decode seams
  and the policy parsing under its `*` run); later increments then change mostly those files, and
  the orchestrator may add a narrow rule for them (`capture-build`, `pure`, `native:gate0@*`,
  `native:gate8@*`), keeping `*` for any shared capture file. A delta milestone sweep before the
  release covers `*` regardless.

## Increments

Texture delivery (HTTP zstd, BC pass-through, KTX2/Basis tiers and the host cache, which replace
"Route C" below and fork F3) has its own increments, G8kz, G8kw, G8k9, G8kp, G8ku, G8kb, G8kc and
G8ke, and their place in this order: [texture-delivery-design.md](texture-delivery-design.md)
"Increments".

Each is one commit on `main`, `feat(render-stream): …` or `test(render-stream): …` with
`Changelog: none` (G8f's GSW change stays inside `experiments/`; if it reaches `packages/canvas` it
needs a real `Changelog:` line). Times are writing plus validation at the map's reach.

| Id | Outcome | Files | Re-run scope (smoke-map targets) | Model, time | Depends on |
| -- | ------- | ----- | -------------------------------- | ----------- | ---------- |
| G8w | render-stream/8 codecs and validators, `golden-8/`, `render-stream.8` subprotocol, `GRC_STREAM_VERSION`, policy parsing and refusals (D2), empty adoption/decode seams | `protocol/render-stream-8.md`, `protocol/golden-8/`, `capture/src/rs2_codec.*`, `rs2_diff.*`, `rs_live.*`, `entry.cpp`, `scripts/lib/render-stream-2.ts`, `rs-core/src/{wire,validate,meta}.rs`, self-tests | `*` (capture, decoders, goldens): `pure`, `capture-build`, `cargo:rs-core`, `cargo:rs-core-capi`, `native:*@rust`, `g7:*@*`, `g7live:*@*`, `bench-instr` | sonnet, 3 h + full tier | G7z landed |
| G8t | Host decode of block-compressed textures (D8), `gate8-tex` fixture and its decode legs, `decode-cost` measured on the template; gate 8 runner, checker and smoke-map entries | `capture/src/rs_texture_payload.cpp`, `hooks.cpp` copy path, `fixtures/gate8-tex/`, `run-gate8.sh`, `check-gate8.ts`, `lib/gate8-tex*.ts`, `smoke-map.json` | `*` (capture); narrow rule if the seams hold | opus, 4 h + full tier | G8w |
| G8sha | The capture's SHA-256 on x86 SHA-NI with runtime CPUID dispatch and the portable fallback, one implementation (calib.cpp's copy removed), bit-identical output; landed | `capture/src/rs_sha256.*`, `calib.cpp`, `capture/test/rs_sha256_{test,bench}.cpp`, `build-capture.sh` | `*` (capture) | opus, 3 h + full tier | G8t |
| G8a | Adoption of canvases, layers and items (D3-D5, D13), `gate8-adopt` fixture, `born`/`late` equivalence | `capture/src/rs_adopt.*`, `rs_mirror.*`, `entry.cpp`, `fixtures/gate8-adopt/`, `lib/gate8-adopt*.ts` | `*` (mirror) | opus, 6 h + full tier | G8w |
| G8h | `presentation:` at a late arm (D10), `gate8-size` fixture | `capture/src/entry.cpp`, `rs_root_query.cpp`, `fixtures/gate8-size/`, `lib/gate8-size*.ts` | `*` (capture); narrow if `entry.cpp` is untouched beyond order | sonnet, 3 h + full tier | G8a |
| G8f | Float payload formats end to end (D9): capture size table and default formats, rs-core validation and RGBA8 quantization, rs-core-capi format codes; `gate8-tex` float legs | `capture/src/rs_texture_payload.cpp`, `rs-core/src/{payload.rs,apply/payloads.rs}`, `rs-core-capi/src/ops.rs`, `receiver/ext/rs_core_ext.cpp`, `fixtures/gate8-tex/` | `*` (capture, rs-core, receiver): includes `native:*@rust`, `g7:*@gsw`, `g7:*@web/rust`, `cargo:*` | sonnet, 4 h + full tier | G8t |
| G8r | Lazy adoption of pre-arm textures and meshes (D6) and glyph atlases (D7), through G8t's decode; `gate8-adopt` gains pre-arm resources, an in-place-updated `ImageTexture` (the declared `creation` region) and a `Label` whose atlas grew before arm | `capture/src/rs_adopt.*`, `rs_mirror.*`, `fixtures/gate8-adopt/` | `*`; narrow if confined to `rs_adopt.*` | opus, 5 h + full tier | G8a, G8t |
| G8m | Pre-arm materials and shaders (D11, D12), `gate8-mat` fixture, parity oracle reuse | `capture/src/rs_adopt.*`, `rs_mirror.*`, `hooks.cpp` (reentrancy flag), `fixtures/gate8-mat/`, `lib/gate8-mat*.ts` | `*` (hooks) | opus, 5 h + full tier | G8a, G8r |
| G8g | Gate 8 recordings and one live leg per fixture through both browser receivers (group `g7-8`), plus D14's reverse-proxy leg | `scripts/run-gate7.sh` group table, `lib/gate7-*` group entries, `smoke-map.json` | `g7:g7-8@*`, `g7live:g7-8@*` and the gate 7 runner rule's reach | sonnet, 3 h + scoped tier | G8m, G7z |
| G8z | `protocol/features/render-stream-8/` manifests, gate 8 generic summary (`results/`), the product hand-off note: env vars, defaults, what the seat must opt out of | `protocol/features/`, `results/gate8.md`, `README.md` | `pure` (manifests checked against sessions) | sonnet, 2 h | G8g |

Order rationale. G8w first, because every policy needs /8 to be expressible honestly. G8t next: it
is the largest STS2 count (940), it is independent of adoption (all post-arm in the census), it is
the lowest risk, and G8r reuses its decode path. G8a is the riskiest and gates the rest of the
picture, so it follows immediately; G8t and G8a can be written in parallel and landed in that order.
G8h is small and makes the game's text and panels right once G8a exists. G8f before G8r and G8m,
because STS2's float textures are shader inputs. G8m last among capture work: it needs the node map
(G8a) and adopted textures for texture parameters (G8r).

### Product sequence (couch-coop, under its own rules; specified there, not here)

- **P1 streaming seat role**: one seat flagged as the streaming seat skips
  `CouchCoopHeadlessVisualSuspender` and `HeadlessTextureImageEvictor`, and loads the capture with
  `GRC_ADOPT=arm`, `GRC_UNKNOWN_ITEM=skip`, `GRC_TEXTURE_DECODE=engine`, `GRC_STREAM_VERSION=8`,
  `GRC_ROOT_SIZE=presentation:1920x1080` and raised caps. Lands with or after F2.
- **P2 transport fronting** (D14): couch-coop's server proxies the seat's loopback listener.
- **P3 game legs** (F1): −0.5/−0.25 on the current binary, then one visual leg with the replay
  contact sheet, evidence in couch-coop's ignored research tree.

## What gate 8 does not prove

- That the installed game is captured correctly. That is P3, under F1; the generic gates only show
  the mechanisms on stock-template fixtures.
- That adoption is complete for arbitrary games: RS-only objects with no node, script `_draw`s
  depending on stale state, and pre-arm in-place texture or mesh updates outside the TextServer
  (`adopted_content:"creation"`) remain limits, counted or declared, not fixed.
- Exactness of host-decoded BC1/BC3 against a GPU's hardware decode (vendor rounding); gate 8 pins
  equality with the engine's CPU decoder only.
- Wire, GPU-memory or host-memory acceptability at STS2 scale: measured by P3, not by fixtures.
- Several or negotiated presentation sizes, non-logical aspects, stretch mode `viewport`.
- Arm on first subscriber and disarm on last (gate1-design D6). Adoption makes it possible; gate 8
  neither implements nor measures it.
- Non-loopback serving or TLS in the capture (D14).
- Particles, multimesh, skeletons, animation slices, LCD text, `Light2D`, and the shader reasons gate
  5.5 types; meshes refused `mesh-format` (STS2: 4 `mesh_create_from_surfaces`).
- Windows/macOS hosts, other engine builds, or a re-census of the MinGW PE (memory
  rs-interposition-megadot-facts).

## Deferred, with owners

- **Route C (compressed passthrough with host-decoded variants)**: after P3's numbers (F3).
- **Hash off the calling thread** for large decoded payloads: if `decode-cost` or P3 shows the
  main-thread hitch matters.
- **Arm on subscribe** (gate1-design D6): after gate 8; re-arming re-runs the walk.
- **Several presentation sizes, size negotiation**: after release, with gate 7's hello data.
- **`viewport` stretch, `follow_viewport`, parallax repeat, snap-to-pixel, script-set global canvas
  transform** (gate6-design "Deferred"): a census on the game in P3 decides which, if any, block.
- **Switching default file sinks and the live default to /8**: a cleanup increment after release.

## Open forks for the user

- **F1. Launching the installed game.** Gates −0.5/−0.25 must be re-run on the current binary
  (MegaDot changed between 2026-10-08 and 2026-10-10 and may again) and one visual leg added. Each
  launch needs the operator's explicit go-ahead; no agent launches STS2 or touches the Steam
  directory. **Default:** no launch until G8a, G8h, G8t, G8f, G8r and G8m are on `main` and P1 is
  ready; then ask once for a single isolated headless launch under couch-coop's instance rules.
- **F2. couch-coop's `worktree/render-capture-m05`.** It is one commit (14f4434b, the env-gated
  `GDExtensionManager.LoadExtension` loader at mod init) on an October 8 base, never merged.
  **Default:** rebase it and land it on couch-coop `main` together with P1, after G8z, under that
  repository's rules; until then game legs use a local rebuild as on 2026-10-10.
- **F3. Compressed passthrough and a decoder dependency.** Route C, or a BCn decoder in rs-core
  (a crate download or vendoring Godot's MIT `bcdec.h`), is a new dependency. **Default:** neither;
  route A only, revisited if P3 measures wire bytes or host memory as a problem.
