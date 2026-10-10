# CanvasTexture on a headless capture host

Status: decision record and options study, 2026-10-09, written with G2d
([gate2-design.md](gate2-design.md) "G2d"). The decision is the user's: **a headless capture host
refuses `CanvasTexture`, typed, until one of the options below is proven.** Source citations are
`path:line` in the pinned `../godot-4.5.1-stable` checkout unless another version is named.

## The problem

A headless host (`--headless`) runs the dummy rasterizer. `DisplayServerHeadless` offers exactly
one rendering driver, `dummy` (`servers/display_server_headless.h:43-47`), and its `create_func`
calls `RasterizerDummy::make_current()` whatever driver was asked for (`:49-52`). `--headless`
itself only selects the `headless` display driver and the dummy audio driver
(`main/main.cpp:1399-1402`).

The dummy texture storage never allocates a canvas texture:

- `canvas_texture_allocate()` returns `RID()`; `canvas_texture_initialize`, `canvas_texture_free`
  and every `canvas_texture_set_*` are empty
  (`servers/rendering/dummy/storage/texture_storage.h:54-62`).
- `RenderingServer::canvas_texture_create()` is `FUNCRIDSPLIT(canvas_texture)`
  (`servers/rendering/rendering_server_default.h:951`): allocate, then initialize the allocated
  RID, then return it (`servers/server_wrap_mt_common.h:56-65`). `RendererCanvasCull` forwards the
  allocation to the storage unchanged (`servers/rendering/renderer_canvas_cull.cpp:2419-2420`).
- So `CanvasTexture`'s constructor stores `RID()` (`scene/main/canvas_item.cpp:1914`), `get_rid()`
  returns it (`:1874-1876`), every setter calls the server with `RID()` (for example the diffuse
  setter, `:1741-1749`), and the destructor frees `RID()` (`:1916-1918`), which
  `RenderingServerDefault::_free` ignores (`servers/rendering/rendering_server_default.cpp:44-47`).
- A draw of a `CanvasTexture` goes through `Texture2D::draw_rect_region`, which passes `get_rid()`
  (`scene/resources/texture.cpp:77-82`): the command names `RID()`. `RendererCanvasCull` stores
  whatever RID it gets without validating it (`renderer_canvas_cull.cpp:1610-1619`).

The capture hooks still fire (the vtable slots are called), but every call names `RID()`, and a
draw naming `RID()` is indistinguishable from a draw with no texture. Before this decision the
mirror recorded it as `tex: null`, which a receiver replays as the engine's white default texture
(`drivers/gles3/rasterizer_canvas_gles3.cpp:2340-2342`): a silent substitute, which D10 forbids.

Measured: a `--headless --script` probe creating one `CanvasTexture` and one `ImageTexture` prints
`canvas_texture_rid=0` and a non-zero image RID on the 4.5.1 editor, on the 4.6.2 runtime and on
the 4.7.2 editor (`mise` installs). The 4.6.2 source has the same line
(`../godot-4.6.2/servers/rendering/dummy/storage/texture_storage.h:54`).

## Why CanvasTexture is special

Added 2026-10-10 from a source read of 4.5.1 and the upstream history. Claims are cited. The
**Inference** paragraphs are marked as such.

### What `--headless` swaps in

`--headless` is commented "no audio, no rendering" (`main/main.cpp:1399`). The headless display
server's only driver, `RasterizerDummy` (`servers/display_server_headless.h:43-52`), builds a
`RendererCompositor` from stub storage classes. The classes are `RendererDummy::TextureStorage`,
`MeshStorage`, `MaterialStorage`, `LightStorage`, `ParticlesStorage`, `Utilities`,
`RasterizerCanvasDummy` and `RasterizerSceneDummy`. The texture storage is wired in at
`servers/rendering/dummy/rasterizer_dummy.h:62,73`. Everything above that layer is the normal
engine: `RenderingServerDefault`, `RendererCanvasCull`, `RendererSceneCull` and
`RendererViewport`.

`RenderingServerDefault` reaches the stubs in two ways:

- **Textures go straight to storage.** Every `texture_*_create` is a `FUNCRIDTEX*` macro that calls
  `RSG::texture_storage->texture_allocate()` and then the per-kind `_initialize`
  (`servers/rendering/rendering_server_default.h:133-193`). That covers 2D, layered, 3D, proxy and
  placeholder textures.
- **Everything else is `FUNCRIDSPLIT`.** The server calls `<server>->X_allocate()`, then
  `X_initialize(ret)`, and returns whatever `allocate` returned (`servers/server_wrap_mt_common.h:56-65`).
  For 2D the `<server>` is `RendererCanvasCull` (`rendering_server_default.h:940-958`). The canvas
  cull layer keeps its own `RID_Owner`s for canvases, items, lights, occluders and occluder
  polygons (`servers/rendering/renderer_canvas_cull.h:140-188`, for example
  `renderer_canvas_cull.cpp:2036-2037`). So those resources get real RIDs on any backend. Even the
  canvas light gets one, although its backend handle is the dummy `light_create()`, which returns
  `RID()` (`dummy/rasterizer_canvas_dummy.h:42`). The one 2D resource the cull layer does **not**
  own is the canvas texture: `canvas_texture_allocate()` just forwards to texture storage
  (`renderer_canvas_cull.cpp:2419-2420`). That matches the real backends, where canvas textures
  live in texture storage (`drivers/gles3/storage/texture_storage.h:412`).

### Ordinary textures and CanvasTexture in the same file

In `servers/rendering/dummy/storage/texture_storage.h`:

- An ordinary texture gets a real identity. `texture_allocate()` makes an RID from a
  `RID_PtrOwner<DummyTexture>` (`:41-44`, `:68-72`). `texture_2d_initialize` keeps a duplicate of
  the initial image (`:82-86`) so `texture_2d_get` can return it (`:104-108`). Everything else is a
  no-op: `texture_2d_update` (`:94`), the layered, 3D and proxy initializers (`:87-90`) and the
  placeholders (`:100-102`). So the dummy keeps only the _first_ image, but every texture kind gets
  a distinct, valid RID.
- A canvas texture gets nothing. `canvas_texture_allocate() override { return RID(); }`
  (`:54`), and `initialize`, `free` and all four setters have empty bodies (`:55-62`).

For capture, identity matters and contents do not. The tap reads contents from the call arguments
(the `texture_2d_update` image is in the hooked call even though the dummy drops it). It cannot
invent identity: every `CanvasTexture` comes back as the same `RID()`, its setters name `RID()`,
and its draws name `RID()`. That is the same value a deliberate `draw_texture(null)` names (see
"The problem").

### One of a class, not a unique outlier

| Resource (2D users)                                                                                              | Dummy behaviour                                                                                                                                                                                  | Distinct id headless? |
| ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------- |
| Texture, all kinds (`ImageTexture`, atlases, fonts)                                                              | `RID_PtrOwner`, keeps the initial 2D image (`texture_storage.h:44,68-86`)                                                                                                                        | yes                   |
| Mesh (`Polygon2D`, `MeshInstance2D`, spine)                                                                      | `RID_Owner`, keeps surfaces; region updates are no-ops (`mesh_storage.h:50,75-96,103-106`; `mesh_storage.cpp:46`)                                                                                | yes                   |
| MultiMesh (`CPUParticles2D`, `MultiMeshInstance2D`)                                                              | `RID_Owner`, keeps the buffer (`mesh_storage.h:52-56`; `mesh_storage.cpp:75`)                                                                                                                    | yes                   |
| Shader, material                                                                                                 | `RID_Owner`, parses uniforms; material keeps shader and next pass (`material_storage.h:46-60`; `material_storage.cpp:147,235`)                                                                   | yes                   |
| Lightmap and lightmap instance (3D)                                                                              | `RID_Owner` (`light_storage.h:41-52`; `light_storage.cpp:64,81`)                                                                                                                                 | yes                   |
| Canvas, canvas item, `Light2D`, `LightOccluder2D` and its occluder polygon                                       | owned by `RendererCanvasCull`, not by the backend (`renderer_canvas_cull.h:140-188`)                                                                                                             | yes                   |
| **`CanvasTexture`**                                                                                              | `return RID()`, setters empty (`texture_storage.h:54-62`)                                                                                                                                        | **no**                |
| Skeleton (`Skeleton2D`, `scene/2d/skeleton_2d.cpp:834`)                                                          | `return RID()` (`mesh_storage.h:188`)                                                                                                                                                            | no                    |
| Particles (`GPUParticles2D`, `scene/2d/gpu_particles_2d.cpp:983`)                                                | `return RID()`; particle collision too (`particles_storage.h:41,100`)                                                                                                                            | no                    |
| 3D lights, reflection probe, decal, voxel GI, fog volume, visibility notifier, sky, render target, mesh instance | `return RID()` (`light_storage.h:63-67,120`; `texture_storage.h:135,164`; `environment/gi.h:41`; `environment/fog.h:41`; `utilities.h:58`; `rasterizer_scene_dummy.h:112`; `mesh_storage.h:140`) | no                    |

`CanvasTexture` is the _only canvas-texture-like_ stub, but it belongs to a larger class of
`RID()` stubs. Two other 2D features fall in it: `Skeleton2D` skinning and `GPUParticles2D`. Under
`--headless` they will meet the same identity collapse when a gate reaches them.

### Bug, oversight, or deliberate?

**Verified history.**

- In October 2020 the dummy returned `RID()` for nearly _everything_: `texture_2d_create`,
  `shader_create`, `material_create`, `multimesh_create` and `canvas_texture_create`. The canvas
  texture stub was added in that state (commit
  [25d56e9](https://github.com/godotengine/godot/commit/25d56e9666a6ca6374c07e80347ae4514f7e21d0),
  PR [#43443](https://github.com/godotengine/godot/pull/43443)).
- Each resource that now has state was upgraded one at a time, and each upgrade cites a headless
  workflow that had to _read data back_:
  - Textures, February 2021
    ([0ae762a](https://github.com/godotengine/godot/commit/0ae762a7013f7191296d79dbe9e38f5f1afe095f),
    PR [#46119](https://github.com/godotengine/godot/pull/46119)). Its message says: "Avoid crash on
    start-up, we will need to slowly re-implement the various methods with dummy objects so
    exporting works again like in 3.2".
  - Meshes: headless collision-shape generation
    ([#63767](https://github.com/godotengine/godot/pull/63767)) and leaks
    ([#65068](https://github.com/godotengine/godot/pull/65068), fixes #64720).
  - Multimesh: "the bare minimum amount of data to store and retrieve the multimesh buffer for
    export" ([#87390](https://github.com/godotengine/godot/pull/87390), fixes #86396).
  - Shaders: "the minimal set of logic needed by `get_shader_parameter_list()`" for headless export
    ([#87392](https://github.com/godotengine/godot/pull/87392), fixes #66842).
  - Lightmaps: a crash ([#95103](https://github.com/godotengine/godot/pull/95103), fixes #89119).
- The RenderingServer canvas-texture API is write-only. It has `create`, `set_channel`,
  `set_shading_parameters`, `set_texture_filter` and `set_texture_repeat`, and no getter
  (`servers/rendering_server.h:1533-1546`). `CanvasTexture` answers `get_width`, `get_height`,
  `has_alpha`, `is_pixel_opaque` and `get_image` from its Object-side diffuse texture
  (`scene/main/canvas_item.cpp:1835-1872`). So no headless export, import or tool path ever reads
  server-side canvas-texture state, and none ever needed it.
- Still `return RID()` upstream: tag `4.6.2-stable` `:54`, tag `4.7.2-stable` `:55`, and `master`
  at `232e6b14ab` (2026-10-09) `:55`. All three were read via the GitHub API on 2026-10-10. In the
  same period `master` made the dummy texture owner thread-safe
  ([#121958](https://github.com/godotengine/godot/pull/121958)) and left the canvas texture stub as
  it was.
- A GitHub search (2026-10-10) for issues or PRs about `CanvasTexture` or `canvas_texture` under
  headless or the dummy renderer found none.

**Assessment (inference).** It is not a bug by Godot's own standard: nothing crashes, nothing is
lost on export, and headless means "no rendering". It is also not a decision aimed at
`CanvasTexture`. It is the dummy renderer's default policy: stub to `RID()`, then add the bare
minimum of state only when a headless workflow needs to read it back. `CanvasTexture` never met
that bar because nothing reads it back. It is an omission only for a use case Godot does not
support, which is observing the RenderingServer call stream. Upstream would plausibly accept a
minimal `RID_Owner` for canvas textures if someone made the case. The target game is pinned to a
4.5.1 fork, so that would not change the options below.

## The current refusal (G2d)

- **Session manifest.** A host whose `DisplayServer.get_name()` is `headless` declares
  `features.resources` without `canvas_texture` and
  `features.unsupported_resources: [{"resource":"canvas_texture","reason":"canvas-texture-headless"}]`
  ([render-stream-2.md](render-stream-2.md) "Session record"; `rs_publish.cpp`
  `gate2_features(headless_host)`). A rendered host lists `canvas_texture` and refuses nothing.
- **Commands.** On a headless host the mirror turns a texture-rect draw naming `RID()` into an
  `unsupported` command with reason `canvas-texture-headless`, plus the derived item-level entry
  (`rs_mirror` `set_canvas_texture_headless`). Receivers skip it and record it (D10), as for
  `unknown-texture`. Since `RID()` is also what a deliberate `draw_texture(null)` names, a headless
  host refuses that too: on a headless host `RID()` in a texture draw is ambiguous, and the refusal
  is the honest answer. No fixture of gates 0-2 draws a null texture.
- **Hook log.** `canvas_texture_create` returning `RID()` and every `canvas_texture_set_*` on
  `RID()` are logged with `status: "unsupported"`, `reason: "canvas-texture-headless"`, no id (no id
  is spent), so the log, the stream and the census agree.
- **Evidence.** Gate 2 group `g2d` leg `canvas-headless` (the fixture's `canvas` variant on a
  headless capture host and a headless receiver) classifies `unsupported` with reason
  `canvas-texture-headless`, and check `canvas-texture-headless-refused` holds every rule above.
  The legs `canvas-host`, `canvas-normal` and `sabotage-omit-canvas-filter` run their capture host
  under gamescope with a real renderer. They are **host-renderer evidence** that the
  `CanvasTexture` capture and replay path is correct, not headless support.

## Ways to support it later

Judged against the handoff's rules: the host stays headless with no host GPU, the hooks stay a
pass-through tap (forward first, observe, never alter what the engine sees), and the engine is
not patched.

### (a) The hook synthesizes CanvasTexture identities

The `canvas_texture_create` hook replaces the `RID()` result with a private RID and tracks the
`set_*` calls itself.

- Checked: the dummy storage ignores every `canvas_texture_*` call whatever the RID
  (`texture_storage.h:54-62`). A draw stores the RID unvalidated (`renderer_canvas_cull.cpp:1619`)
  and the dummy canvas renderer never dereferences it. `free()` of an unknown RID falls through
  every owner and returns silently: dummy utilities (`dummy/storage/utilities.cpp:53-73`), canvas
  (`renderer_canvas_cull.cpp:2664-2665`), viewport (`renderer_viewport.cpp:1631`), scene
  (`renderer_scene_cull.cpp:4214-4215`).
- Collision: an `RID_Alloc` RID is `validator << 32 | index` (`core/templates/rid_owner.h:167-170`)
  and `owns()` rejects any index at or past `max_alloc` (`:317-323`). Owners cap their element count
  (262144 by default, `:576`), so a private range with an index of 2^31 or above can never be owned.
  The only other RID source is a script's `rid_from_int64`.
- Cost: the hook stops being a pass-through. The engine receives a value the server did not
  return, and every later `canvas_texture_*` and `free` call must recognise it. A real renderer
  would crash on it, so it must only ever arm on a host whose display server is `headless`, and the
  arm-time check must prove that.
- Fit: headless, no GPU, no engine patch: yes. Pass-through tap: **no**, a deliberate exception.
  Feasibility: high (four slots already hooked). Risk: medium (an engine fork with a different
  dummy, or a future dummy that allocates, turns the synthetic RID into a crash or a collision).

### (b) Read the CanvasTexture Object through method binds at draw time

The draw command carries only `RID()` (`texture.cpp:81`); nothing in it names the Object. The hook
sees the canvas item's RID, and the RenderingServer keeps no Object back-reference for an item, so
reaching the `CanvasTexture` would mean walking the scene tree for the node whose
`get_canvas_item()` matches and reading class-specific properties (`Sprite2D.texture`,
`TextureRect.texture`, `NinePatchRect.texture`, ...). That is per-class knowledge, misses direct
`RenderingServer` users and custom `_draw()` code, and runs on every draw. **Not feasible** as a
general mechanism. It might serve as a diagnostic, never as capture.

### (c) A real storage backend with rasterization disabled

Real RIDs come from the GLES3 storage (`drivers/gles3/storage/texture_storage.cpp:282-284`), which
needs a real display server: X11 offers `opengl3` (`platform/linuxbsd/x11/display_server_x11.cpp:6273-6281`),
Wayland `opengl3` or `dummy` (`platform/linuxbsd/wayland/display_server_wayland.cpp:1860-1867`), and
the headless display server only `dummy`. So `--headless --rendering-driver opengl3` still gets the
dummy rasterizer. Godot 4.5 has no surfaceless-EGL display server.

What is possible without patching: a nested headless compositor (gamescope `--backend headless`,
already used by these runners) with Mesa llvmpipe (`LIBGL_ALWAYS_SOFTWARE=1`) and
`--disable-render-loop` (`main/main.cpp:1780-1781`, applied at `:3409`). With the render loop off
`Main::iteration` never calls `RenderingServer::draw` (`:4817-4819`), yet
`GDExtensionManager::frame()` still runs every iteration (`:4839`), so the capture's frame callback
keeps publishing. The root viewport could also be set to `VIEWPORT_UPDATE_DISABLED`. That gives
real RIDs, no scene rasterization and no host GPU. It still costs a GL context, a window, a
compositor process and llvmpipe's start-up. It changes the target game's display driver, which is
not "the shipped game run headless". Unchecked: whether a shipped game tolerates
`--disable-render-loop` (some read back viewport textures).

Fit: no GPU, pass-through, no engine patch: yes. Headless: **no** (a display server and a
compositor). Feasibility: medium. Risk: medium (environment drift from the real game).

### (d) A host-renderer capture leg

The capture host runs with the real renderer under a compositor, as `canvas-host` does now. This
violates headless outright. It is acceptable only as an explicit operator opt-in (for example a
`GRC_HOST_RENDERER=1` acknowledgement), never as a default, and every stream so produced must
declare it. Feasibility: done (the G2d legs). Risk: low technically. It defeats the point of
headless capture on a server.

### (e) Newer Godot

Checked locally: 4.6.2's dummy storage source still returns `RID()`
(`../godot-4.6.2/servers/rendering/dummy/storage/texture_storage.h:54`), and the 4.6.2 runtime and
4.7.2 editor probes print `canvas_texture_rid=0`. _Correction (2026-10-10):_ this said 4.7's
source and unreleased branches could not be checked. They have now been checked upstream through the
GitHub API. `4.7.2-stable` and `master` (`232e6b14ab`, 2026-10-09) both have
`canvas_texture_allocate() override { return RID(); }` at `texture_storage.h:55` (see "Why
CanvasTexture is special"). The target game is pinned to a 4.5.1 fork
(MegaDot), so an upstream change would not reach it anyway. Upstream will not fix this for us.

### A further option: a dummy-storage shim in the extension

A variant of (a) that keeps the shim out of the tap: the extension replaces the four
`canvas_texture_*` slots with a minimal canvas-texture registry that allocates from a private RID
range, but only when the arm-time check sees `RasterizerDummy` (display server `headless`). It is
still not pass-through, so it carries (a)'s risk, but the logic lives in one clearly named
"headless storage shim" layer rather than inside the capture taps. That separation is what makes
(a) reviewable.

## Recommendation and next experiment

Keep the typed refusal as the default. Next experiment: **(a) as a separately named, opt-in
headless shim** (`GRC_HEADLESS_CANVAS_TEXTURE=synthesize`). Pass criteria:

1. On the pinned 4.5.1 release template under `--headless`, the `canvas` variant's capture
   classifies `success` instead of `unsupported`, and its receiver's step-11 shot equals the
   rendered reference byte for byte (region `sc` included).
2. The synthetic RIDs come from an index range at or above 2^31. Across a whole run, no synthetic
   RID equals any RID the engine returned (all hooked creators logged), and `free()` of every
   synthetic RID returns with no engine error in `stdout.log`.
3. The shim refuses to arm on any host whose display server is not `headless` (a gamescope leg
   with the opt-in set gets a typed refusal, not a synthetic RID).
4. Gates −1, 0, 1 and 2 stay green with the opt-in off, and `canvas-headless` still classifies
   `unsupported` (`canvas-texture-headless`) with it off.
5. The same leg on the target game (gate −0.25's harness) arms, publishes, and disarms by frames
   with exit 0.
