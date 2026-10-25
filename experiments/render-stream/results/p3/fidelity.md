# P3 part 2 (C3): first visual-fidelity leg on the installed STS2 (2026-10-25)

**Verdict: the capture side works at STS2 scale, but the replays do not look like the game yet.** On
the product path the stream covered the main menu, the Act 1 map and the first combat. The arm is at
mod init, with C1's streaming seat, `/8`, adoption, host decode and `skip`. Every transaction was
`ok`, with zero withheld items and zero 1x1 evicted images. `degenerate-host-size` is gone, and step
pairing was exact.

The map replays nearly pixel-exact on both receivers. The menu and combat do not:

- **Menu, both receivers: a white screen.** A full-screen `hint_screen_texture` rect is drawn
  without its material, and every spine mesh is drawn white.
- **Combat:** every spine creature is a white silhouette.

Two generic receiver gaps cause most of this. With them patched out diagnostically, the native
replay reaches 31 dB on the menu and 26 dB in combat. What remains is particles, multimesh, `TIME`
shaders, half-float textures and nine-patch caps.

The user approved game launches for this increment. Every launch was an owned, isolated instance
under sts2-couch-coop's live-QA rules. Evidence, including the game-derived frames, stays in
sts2-couch-coop's ignored research folder `.sts2/research/render-stream-p3-20261025/c3/` (its
`README.md` lists one command per leg). A copy is in this repository's ignored
`artifacts/render-stream/p3/fidelity/`, and the kept recordings are in
`artifacts/render-stream/p3/fidelity-data/`. Nothing game-derived is committed.

## What ran

| Fact | Value |
| ---- | ----- |
| Game | stable `v0.107.1`, `MegaDot v4.5.1.m.12.mono.custom_build`, exe sha256 `0c21999e…` (C2's calibration reused: `sts2-megadot-4.5.1-m12.p3.json`) |
| Renderer | GPU, not `--headless`: Vulkan `forward_plus` on the RTX 2060 inside a private `gamescope --backend headless` at 1920x1080, `--display-driver x11`, `--force-steam off` |
| Capture | GSW `main` `7a77b7aa`, `build-capture.sh` (library sha256 `34410516…`) |
| Mod | C1's private couch-coop `e86f9405` build (streaming seat + F2 loader), plus a copy of the installed `spirectlbridge` (it owns the IPC socket that `sts2 dev fixture load` uses) |
| Profile | private XDG, seeded offline `default/1` (operator settings: fullscreen, msaa 2, vsync adaptive; volumes 0; tutorials off through a progress file a private leg wrote) |
| Receivers | native: stock 4.5.1 release template, `opengl3`, Rust core (`build-rs-core-ext.sh`), in the GSW gamescope lib; GSW canvas: the gate 7 browser harness (`gate7-tool.ts browser-receiver --kind gsw`), pinned headless Chromium 1223 |

Capture environment (Leg A): `GRC_MODE=arm`, `GRC_STREAM_VERSION=8`, a patch file sink plus a
resource store (directory fetch), `GRC_ADOPT=arm`, `GRC_UNKNOWN_ITEM=skip`,
`GRC_TEXTURE_DECODE=engine`, `GRC_TEXTURE_WORKERS=2` and `GRC_ROOT_SIZE=presentation:1920x1080`.
The caps were raised: `GRC_MIRROR_MAX_ITEMS=32768`, `_COMMANDS=16384`, `GRC_RESOURCE_MAX_PAYLOAD_BYTES=256 MiB`
and `GRC_RESOURCE_BUDGET_BYTES=8 GiB`. The leg disarmed by frames. Leg B adds `GRC_STREAM_VERSION=9`,
`GRC_TEXTURE_DELIVERY=basis-uastc` and `GRC_TEXTURE_ENCODE_WORKERS=2`, with a private cache directory
in the scratchpad.

### The reference comes from the same process

The orchestrator's design call held, with no workaround needed. The streaming seat neither refuses
nor behaves differently when it is not headless. The suspender and evictor are skipped as on a
headless seat: no `suspend`/`evict` lines, and 0 1x1 images.

The frame is grabbed by an autoload, `c3_shot.gd`, that the private farm's copied `override.cfg`
adds. The install's `override.cfg` is never touched. It works as follows:

- On a request file, the next `_process` (iteration P) reads back the root viewport texture, which
  is iteration P−1's finished draw.
- Under `GRC_ADOPT=arm`, the capture dates iteration P−1's publish as frame P.
- So the replay of the last transaction with `frame <= P` is the pair.

**Measured: at every one of the 33 armed steps, that transaction's frame equals the shot's frame.**
Animation and RNG state never have to be matched across runs.

### Legs

| Leg | Arm | Route reached | Notes |
| --- | --- | ------------- | ----- |
| `pilot-1` | mod init, `/8` | menu (the map fixture failed: no bridge socket until `spirectlbridge` was added) | first-light, white-screen diagnosis |
| `a8-1` | mod init, `/8` | menu, map, combat | the combat was dimmed by the first-run tutorial overlay |
| **`a8-2`** | mod init, `/8` | **menu, map, combat** (tutorials off) | **the Leg A of record** |
| `late-1` | at the map, `/8`: the autoload calls `GDExtensionManager.load_extension` | map, then combat | real late-join adoption at STS2 scale (not the product's loader path) |
| `b9-1` | mod init, `/9` `basis-uastc` | menu, map, combat | Leg B |
| `control-1` | none (no extension, no seat flag) | menu, map, combat | the unarmed control for host overhead |

Every leg ended with `survivors: none`. The game, its crashpad and the compositor were killed by pid
from an EXIT trap; TERM ended in SIGABRT or needed KILL, as at C2. The five hash sets were unchanged
around every leg: operator profile, Steam remote store, install binaries, install mods and mod build.

## Per-step pixel stats

Each step compares the reference with the receiver's shot of the paired seq, in RGB over 1920x1080.
The columns give PSNR, the share of pixels whose largest channel differs by more than 16, and the
largest channel delta.

The `native-diag` column is a measurement aid, not a fix. It replays a rewritten recording in which
the screen-texture items are set invisible (gap 1). It also uses a local, uncommitted rs-core-capi
change that keeps a named canvas texture's diffuse image resident (gap 2). The patch is
`harness/c3-diagnostic-canvas-diffuse.patch` in the research folder.

Leg A (`a8-2`):

| step | seq | native | gsw | native-diag |
|---|---|---|---|---|
| menu-1 | 852 | 2.94 dB / 99.99 % / 255 | 2.94 / 99.99 / 255 | 30.81 / 8.20 / 131 |
| menu-2 | 942 | 2.93 / 99.99 / 255 | 2.93 / 99.99 / 255 | 31.20 / 7.49 / 134 |
| menu-3 | 1035 | 2.94 / 99.99 / 255 | 2.94 / 99.99 / 255 | 31.18 / 7.70 / 157 |
| map-1 | 1384 | 64.12 / 0.00 / 3 | 53.26 / 0.08 / 23 | 64.12 / 0.00 / 3 |
| map-2 | 1468 | 64.17 / 0.00 / 3 | 53.26 / 0.08 / 23 | 64.17 / 0.00 / 3 |
| map-3 | 1552 | 64.13 / 0.00 / 3 | 53.26 / 0.08 / 23 | 64.13 / 0.00 / 3 |
| combat-1 | 1789 | 17.02 / 5.24 / 255 | 16.86 / 7.04 / 255 | 26.22 / 1.72 / 251 |
| combat-2 | 1838 | 17.05 / 5.21 / 255 | 16.88 / 7.01 / 255 | 26.23 / 1.72 / 251 |
| combat-3 | 1885 | 16.99 / 5.24 / 255 | 16.83 / 7.05 / 255 | 26.22 / 1.69 / 251 |

Leg B (`b9-1`, `/9` `basis-uastc`), the same scenes in a new run: the menu is 2.93–2.94 dB on both
receivers. The map is 64.6 dB native and 53.3 dB GSW. Combat is 17.0 dB native and 16.8–16.9 dB GSW,
with 5.2–5.5 % and 7.0–7.3 % of pixels over 16. Within this gap set, the UASTC/BC variants cost no
visible fidelity against Leg A.

The late arm (`late-1`, native): the adopted map is 64.1–64.2 dB on all three shots. Combat after
the arm is 15.8 dB with 12.6 % of pixels over 16, and 17.2 dB with 10.7 % with the diagnostics.

Native against GSW, from `a8-1`: identical on the menu (max delta 1). On the map, 1,621 pixels differ
by up to 22, all of them the settings gear icon's edge filtering. In combat, 5,375 pixels differ by
up to 25. The diagnostic residency patch also went into GSW's `residency.rs`, but it did not change
GSW's frames, so GSW's canvas-texture path needs its own diagnosis (gap 2).

Contact sheets (reference | receivers | |diff| x4), in the research folder and the artifacts copy:

- `legs/a8-2/contact-sheet.png`: native, native-diag, gsw, gsw-diag;
- `legs/b9-1/contact-sheet.png`;
- `legs/late-1/contact-sheet.png`;
- `legs/a8-1/sheet-native-gsw.png`.

Stats are in `legs/<leg>/compare.json`; the census and step-to-seq pairing are in
`legs/<leg>/census.json`.

## Census (Leg A, from the capture's own stream and evidence)

- **Transactions:** 4,960, all `ok`, `failures` empty.
- **Unknown or withheld:** 0 RIDs, 0 items, 0 commands, at every step. This is the arm-at-init
  product path; `late-1` is different (gap 5).
- **Adopted at arm:**
  - mod init: 46 items, 7 textures, 1 material, 1 shader;
  - late arm on the map: 2,935 items, 29 textures, 46 materials, 6 shaders, 1 layer, 1 non-root
    viewport.
- **Evictor check:** 1x1 images behind a draw over 16 px, **0** at every step of every leg.
- **`degenerate-host-size`:** gone. Root size policy `presentation`, status `match` at 1920x1080.
- **Textures** (final state): 701 image `ok` and **847 `unsupported-format`**.
  - The unsupported ones are 796 RGBF, 49 RGBAF, 1 RGBAH and 1 RGF: small float textures, 4.8 MB in
    total, because `GRC_RESOURCE_FORMATS` was left at its default.
  - 189 BC textures were decoded on the host: BPTC 99, DXT5 82, DXT1 8.
  - Only one drawn reference to an unsupported texture is visible: the card glow's RGBAH 512x512
    (5 commands, 16,333 transaction-entries).
- **Meshes:** 183 `ok` and 4 `mesh-format`.
- **Materials and shaders:**
  - materials: 213 `ok`, 348 `param-type`. No `param-type` material was on a visible drawing item at
    any step.
  - shaders: 32 `ok`, 33 `shader-time`, 5 `shader-screen-texture`, 2 `shader-mode`.
- **Per-transaction `unsupported` entries over the session:**

  | entry | count |
  | ----- | ----- |
  | `canvas_item_set_material`/`unsupported-material` | 358,927 |
  | `canvas_item_add_multimesh` | 107,264 (32 visible items in combat) |
  | `canvas_item_add_particles` | 23,352 (6 visible in combat, 3 on the menu) |
  | `add_texture_rect`/`unsupported-texture` | 16,333 |
  | non-root-viewport canvas ops | 3,319–3,801 each |

- **Traffic:**
  - Spine is `add_mesh` with per-frame `mesh_surface_update_vertex_region`/`attribute_region`: 44,536
    surface updates replayed by 1,885 transactions.
  - No `canvas_item_attach_skeleton`, `Light2D` or triangle-array traffic was seen.

## Numbers at STS2 scale

These are rough, not timing legs. Some legs ran while other replays were running (labelled).

- **Scene size:**
  - menu: 2,478 items, 1,161 visible, 54 with commands;
  - map: 4,015 items, 1,357 with commands;
  - combat: 4,196 items, 358 with commands, 187 meshes, 1,573 textures, 561 materials.
- **Wire, Leg A patch recording:** 640 MB for 4,960 transactions (3.4 minutes).
  - The first full transaction is 538 KB. Patch p50 is 176 KB and the max is 965 KB.
  - Per step: about 36 KB per frame on the menu, about 15 KB on the map and about 175 KB in combat
    (8.5 MB over 49 frames).
  - `late-1`'s first full transaction (2,935 adopted items) is 1.5 MB.
- **Payloads, Leg A store:** 1.23 GB distinct.
  - Textures: 726 decoded payloads of 1.03 GB. Offline zstd −3, the level of the capture's HTTP
    coding, gives 135 MB (7.65x).
  - Meshes: **351,984 payloads of 199 MB**. Every spine frame is a new hashed mesh payload, about
    1,700 GETs per second over the session. zstd gains only 1.22x.
  - Shaders: 34.
- **Leg B:**
  - 382 KTX2 UASTC encodes (69 MB) over 83 s of wall time on 2 workers, spread over the session.
  - The native replay uploaded 81 MB of textures (34 `block`, 9 `uastc`, 33 `decoded`) against 281 MB
    at `/8`, and fetched 104 MB against 302 MB (directory fetch, no zstd).
  - GSW uploaded 83 MB with the same variant mix.
- **Host overhead** (`a8-2` against `control-1`, same route, rough):
  - rate: armed 21–50 fps (menu 36–50, map 50, combat 21–27) against 60 fps on every scene unarmed;
  - CPU: about 1.04 cores against 0.48 in steady state;
  - RSS: 2.78 GB against 1.82 GB (+0.96 GB, close to the 0.96 GB retained resource store).
  - The capture's frame callback averages 24.9 ms (p95 ≤ 31.7) and the snapshot 11.3 ms on the
    arm-at-init path. `late-1`, at a similar item count but with 97 textures and 76 materials
    resident against 1,573/561, measured 9.4 ms and 2.4 ms and held 58–60 fps. Gap 6 states the
    hypothesis this suggests.
- **Adoption walk:**
  - at mod init: 46 items in 10–14 ms, plus 163 ms for materials and the node map;
  - late on the map: 2,935 items in 3.6 ms, plus 38.6 ms for materials;
  - `load_extension` itself took 108 ms.
- **Arm to first full frame:** frame 1 at mod init. Late: armed in iteration 1174, first transaction
  at frame 1181, 7 frames later (asynchronous decodes under `GRC_TEXTURE_PENDING=hold`).
- **Receivers** (file replays, as fast as possible):
  - Native: 17–33 s for about 1.9k transactions. RSS peak 1.08 GB (`a8-2`), 0.88 GB (`b9-1`), and
    **9.8 GB after the full 6,965-transaction `a8-1`** (5k combat frames); gap 7.
  - GSW: 86–92 s for 1.9k transactions. It needed 15 minutes for the full `a8-1`, then the harness
    died (gap 8).

## Gap list, ranked by visible impact

1. **(a) Receiver, both: unsupported screen-texture material drawn as plain geometry.** The menu's
   full-screen blur rect (shader `hint_screen_texture`, `mix_percentage` 0) covers the whole frame
   in white on both receivers. The capture created 5 such shaders; 32 items named one.
   - gate5_5-design.md "draws those items without the material" is the wrong fallback for a
     screen-reading shader: an identity post-effect becomes an opaque rect.
   - Smallest reproducer: a stock fixture with a full-rect `ColorRect` whose ShaderMaterial samples
     `hint_screen_texture` over any scene.
   - Fix direction: do not draw an item whose effective shader is `shader-screen-texture`.
2. **(a) Receiver, both: a CanvasTexture's diffuse image is never made resident when only the canvas
   texture is drawn.** Spine meshes draw through canvas textures, here 3992x2684 BPTC and 5380x1320
   DXT5 atlases. Native `plan.rs` names only the canvas texture: the diffuse is never fetched, and
   `CanvasTextureSetChannel` binds `RID()`. So every spine draws white: the menu's sky, tower and
   city, and every creature in combat.
   - Native fix measured: keeping the diffuse resident lifts combat from 17 to 26 dB and the menu
     (with gap 1) to 31 dB.
   - GSW has the same symptom, but adding the diffuse to `residency.rs` names did not fix it. Its
     lowering or binding needs its own look.
   - Reproducer: a stock `MeshInstance2D` or `Polygon2D` whose texture is a CanvasTexture over an
     image no other item draws.
3. **(c) Particles and multimesh (gate 8 "does not prove").** Combat has 32 multimesh items
   (fireflies and vine glow) and 6 particles (the energy-orb sparks). The menu has the tower-top
   glow (particles) and the bottom fog (multimesh). This is most of the remaining 8 % of menu pixels
   and much of combat's 1.7 %.
4. **(c/b) `TIME` shaders plus a half-float texture.** All 5 hand cards' glow (`add_texture_rect`
   759x759, shader `shader-time`, RGBAH 512x512 `unsupported-format`) is missing; the cyan outlines
   are in every combat diff. Further `shader-time` items: the plant sway (5 items) and a relic pulse.
   - The RGBAH half is config (b): set `GRC_RESOURCE_FORMATS` to include the float formats. The
     `TIME` half is gate 5.5 deferred (c).
5. **(a) Capture, late arm only: pre-arm textures first drawn after the arm are unknown, and
   pre-arm items not in the tree at arm are unknown.** After the late arm on the map, combat showed
   53,988 `canvas_item_add_mesh`/`unknown-texture` entries and 170 unknown item RIDs.
   - Visibly, the Ironclad and the hand cards are missing: 10.7 % of pixels over 16 even with
     gaps 1 and 2 patched.
   - Adoption adopts only what the scene references at arm. Preloaded atlases (`Preloading 'Common'`)
     and pooled nodes are neither.
   - It does not affect today's product path (arm at mod init), but it blocks "arm on first
     subscriber".
   - Reproducer: a stock fixture that preloads a texture and a detached node before arming and draws
     them only after.
6. **(a) Capture cost at STS2 scale.** 25 ms of frame callback (11 ms snapshot) takes the armed seat
   from 60 to 21–50 fps. The `late-1` contrast (same item count, 16x fewer textures and 7x fewer
   materials resident: 9.4 ms) suggests the per-frame snapshot copies whole resource tables. That is
   a hypothesis, not a profile. Its visible impact is the game's own frame rate on the streaming
   seat.
7. **(a) Receiver memory under spine churn.** The native RSS reached 9.8 GB after replaying 6,965
   transactions (5k combat frames, about 350k distinct mesh payloads). Related wire cost: about 1,700
   mesh payload GETs per second, compressing only 1.22x. A soak reproducer exists in gate 5f's live
   mesh scene with per-frame vertex updates.
8. **(a) Harness: the gate 7 browser receiver harness dies at STS2 scale.** Playwright threw
   `ERR_STRING_TOO_LONG` (a pipe message of 512 MB or more). The page's `applied.json` was 367 MB
   after 6,965 transactions. The shots and `applied.json` had already been written; the replays here
   cut recordings after the last shot step to avoid it.
9. **(a) Nine-patch caps.** The enemy HP bars (`add_nine_patch` over 12–20 px textures) replay as
   square-ended full-height bars, where the game draws thin bars with pointed caps. This is visible
   under every creature in combat, on native (GSW is not checked separately).
   - Reproducer: a stock `NinePatchRect` with a 15x16 texture and margins near half its size,
     stretched to 223x18.
10. **(a) Minor.**
    - GSW against native: the settings gear's edge filtering differs on the map (1,621 px, max delta
      22).
    - The creature shadow ellipses look fainter in replay (not diagnosed).
    - The non-root-viewport canvas ops (3.3–3.8k entries each) had no visible effect at these steps.
11. **(b) Couch-coop/product.**
    - Seat `msaa 2` comes from the operator settings. The receivers draw without 2D MSAA, which
      softens edge pixels only.
    - Arming at mod init makes the seat pay capture cost while nobody watches (gap 6).
    - First-run tutorials would cover combat on a fresh seat profile.

## What was not reached, and why

- **Live transport.** The live listener, HTTP zstd on the wire and a live browser receiver were not
  run. The file sink plus directory fetch gives the same transactions and payloads, and zstd sizes
  were computed offline at the capture's level 3.
- **Real-time receiver numbers.** No receiver frame rate or GPU timing was measured (file replays
  run as fast as possible). Receiver GPU memory is given as texture upload bytes, not a GPU query.
- **Leg B's warmed cache.** `prepare-textures.sh` was not run, so Leg B encoded cold during the
  session.
- **Post-combat screens** (rewards, shop, events) were not driven.
