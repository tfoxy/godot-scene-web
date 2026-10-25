# P3-CT: a canvas texture names its diffuse (C3 gap 2, 2026-10-25)

**Fixed in both receivers, and in the web export, which shares the native planner.** A
`CanvasTexture` whose diffuse no command names now draws its diffuse. Every STS2 spine was a white
silhouette before. On the kept `a8-2` recording, replayed with no game launch, combat goes from
17.0 to 26.2 dB on the native receiver and from 16.9 to 25.0 dB on GSW.

The generic reproducer is gate 8's new group `g8c` (`fixtures/gate8-ct`). On the pre-fix receiver
it fails, with six white cells. On the fixed one, both sinks equal the reference exactly outside
the two refused cells. GSW is pixel-identical to the native receiver on both sinks.

## Root cause

C3's `fidelity.md` gap 2 had it right for the native receiver, and wrong for GSW.

- **Residency, both receivers.** D5's lazy residency (gate2-design.md) makes a texture resident only
  when a command, an instance parameter or a named material names it.
  - spine-godot draws an atlas page through a `CanvasTexture`: `add_mesh` with the canvas texture.
    No command names the page.
  - So neither receiver ever fetched the page.
  - The native planner (`rs-core-capi` `plan.rs`) bound `RID()` as the diffuse.
  - GSW's applier (`rs-core` `residency.rs`) found the diffuse not drawable and lowered the draw to
    the white default.
- **Binding order, native only.** `canvas_texture_set_channel` was issued inside the id-ordered
  texture loop, and only when the canvas entry's version changed.
  - A diffuse created after its canvas texture has a higher id. It was not resident yet when the
    channel was set, so the receiver bound `RID()` and never bound it again.
  - The fixture's `POLY` cell is this case. STS2's atlases all come before their canvas textures.
- **Not causes.** The dependency walk, GSW's binding and the canvas texture's own filter and repeat
  were all already right.
  - GSW resolves a canvas texture to its diffuse at lowering (`texture_draw`) and at assembly. It
    applies the canvas texture's filter and repeat over the item's. The `RECT` cell checks this.
  - Normal and specular maps make the entry `unsupported`/`canvas-texture-channel` (lighting is out
    of scope). Every STS2 canvas texture is `ok` (22 at combat), so this is not STS2's problem. It
    stays a typed refusal (`ct-channel-refused`).
- **Why C3's GSW diagnostic "did not fix GSW".** C3's own `residency.rs` hunk does fix GSW. Applied
  to `rs-core`, it makes the GSW applier draw every spine's diffuse offline (a temporary
  `rs-core-check` dump at seqs 852 and 1789). Yet C3's `gsw-diag` shots are byte-identical to its
  `gsw` shots, though its diagnostic bundle carried the patched wasm.
  - Both replays served the bundle from the same port (13797) to a reused Chromium.
  - The likely cause is that the browser's HTTP cache served the old wasm (memory
    g7l-browser-live-facts: the cache is keyed by port). This fix's replays used fresh ports.

## Fix

No wire change: the canvas entry already carries `diffuse`.

- `rs-core-capi/src/plan.rs`:
  - `canvas_diffuses` adds the diffuses of the named `ok` canvas textures to the indirectly named
    set. That set holds the named materials' textures, so a new diffuse is a candidate, fetched by
    `needed()` and uploaded by `apply()`.
  - `canvas_ids` tracks which entries are canvas textures, so the set costs O(canvas textures), not
    O(named textures).
  - The set-channel, filter and repeat calls move after the image loop. They are issued again when
    the diffuse's RID serial changes.
  - The `full_scan` equivalence (`tests/replay.rs`) still holds.
- `rs-core/src/apply/residency.rs`:
  - `Names` keeps the same closure incrementally: the directly named `ok` canvas textures, and their
    diffuses.
  - It recomputes when a named canvas entry changes or the named set changes.
  - `is_named` and `all` include the diffuses, so the needed set and the upload accounting match the
    native receiver's.
- The web export runs `plan.rs` through its Rust core, so it is fixed by the same change. `g7-8`'s
  web half replays `g8c`.

## Generic fixture and check: gate 8 group `g8c`

`fixtures/gate8-ct` is a stock-template project. Every image is drawn only through a canvas texture,
and each 64x64 cell uses nearest sampling at an integer scale:

- `MESH`: a `MeshInstance2D` `ArrayMesh`.
- `POLY`: a `Polygon2D`. Its diffuse is created after the canvas texture.
- `RECT`: a `Sprite2D` region. The canvas texture's nearest and repeat-enabled override the item's
  linear and repeat-disabled.
- `TRECT`: a `TextureRect`.
- `SWAP`: the diffuse is replaced at step 1.
- `UPD`: the diffuse is updated in place at step 1.
- `NORM` and `SPEC`: a normal map and a specular map, both refused.

A headless dummy storage allocates no canvas texture, so the capture runs on the rendered host: the
group's private gamescope, beside the unarmed reference.

| Check | What |
| ----- | ---- |
| `g8c-legs` | every leg exits 0 |
| `ct-premise` | no command names any diffuse; 6 ok and 2 `canvas-texture-channel` canvas textures; one diffuse is newer than its canvas texture; one swap, one in-place update |
| `ct-reference-textured` | the reference draws every cell textured (no white, no clear colour): the teeth |
| `ct-reference` | both sinks equal the reference exactly outside `NORM`/`SPEC`; the armed host's own frames equal it everywhere |
| `ct-channel-refused` | the refused cells stay the clear colour; each receiver reports 2 `unsupported-texture` commands |
| `ct-diffuse-uploaded` | each receiver uploaded every ok canvas texture's diffuse |

- **Native.** `run-gate8.sh --legs g8c` passes 6/6 (local run `p3-ct-g8c-2`).
- **Before the fix.** The same group on `main`'s planner fails `ct-reference` and
  `ct-diffuse-uploaded`. Six cells are white, 24,576 px at each checkpoint, which is C3's symptom.
  This run used the fixture before its final palette change; the cells and timeline are the same.
- **GSW.** `g7-8` replays `g8c/receiver` and `g8c/receiver-patch` through the band against the
  native legs. Locally they are pixel-identical to the native shots (0 px), with the same uploads
  and the same two refusals.
- **Self-test.** `test/self-test-gate8-ct.ts` drives the pure helpers: 24/24 assertions.

No receiver sabotage was added. The pre-fix run is the negative control, and
`ct-reference-textured` shows that a white or missing draw cannot pass `ct-reference`.

## STS2 confirmation (kept `a8-2` recording, no game launch)

These are replays of C3's `a8-2` capture, cut after seq 1885 with `hide-unsupported.py`. They ran
through this worktree's receivers: the native receiver (`replay-native.sh`) and the GSW bundle on a
fresh port (`replay-gsw.sh`). Each cell gives the PSNR against the in-process reference.

| step | native before | native after | GSW before | GSW after |
| ---- | ------------- | ------------ | ---------- | --------- |
| menu-1..3 | 2.93–2.94 | 2.93–2.94 | 2.93–2.94 | 2.93–2.94 |
| map-1..3 | 64.12–64.17 | 64.12–64.17 | 53.26 | 53.26 |
| combat-1 | 17.02 | **26.22** | 16.86 | **25.01** |
| combat-2 | 17.05 | **26.23** | 16.88 | **25.02** |
| combat-3 | 16.99 | **26.22** | 16.83 | **25.01** |

- **Combat.** Every creature is textured. Pixels over 16 drop from 108k to 35k (native) and from
  146k to 73k (GSW).
- **Menu.** It stays white because of gap 1: the screen-texture rect is drawn as plain geometry.
  With those items hidden, as C3's diagnostic recording does, the fixed receivers reach 30.8, 31.2
  and 31.2 dB (native) and 30.8, 31.2 and 31.2 dB (GSW).
- **Native matches C3's diagnostic exactly** (`native-diag`, every step). This fix is the same
  residency rule, made general.
- **Map.** It does not change. Its 53.26 dB on GSW is gap 10, the settings gear's filtering.
- **Combat remainder.** Particles, multimesh, `TIME` shaders, the half-float glow and nine-patch caps
  (gaps 3, 4 and 9).

No game process was launched by this increment.

## Validation

The diff reaches `rs-core`, `rs-core-capi` and a runner, so its plan reaches every target, sabotage
legs included.

- **Full tier on GitHub runners** (`remote-validate.sh --tier full`, run 40186991592): **17/17 runs
  pass**.
  - These are `pure`, both cargo crates, `bench-instr`, native gates -1 to 5.5 and 8 (g8c
    included), `g7-gsw` and `g7-web-rust` over g7-0 to g7-8, and `g7live-gsw` and `g7live-web-rust`
    over g7-2, g7-5, g7-55 and g7-8.
  - The remote `g7-8` legs include `g8c/receiver{,-patch}` in both browsers.
- **Locally**, the correctness groups the remote refuses (`g7live-gsw` and `g7live-web-rust`, group
  `g7-1`, `RS_VALIDATE_GROUPS=g7-1 validate-increment.sh --tier full`): **2/2 pass**.
- Timing runs (`native-rust-gate6`, the `g7live-*-timing` runs, `g7x`) are left to the milestone
  sweep.
- Also run by hand:
  - `cargo test --release` for `rs-core` (61) and `rs-core-capi` (8, the replay equivalence), all
    pass.
  - `tsc` over the experiment: only the three known errors.
  - `run-gate8.sh --legs g8c`: 6/6.
  - `gate7-tool.ts gsw-legs --group g7-8` on the g8c legs: 0 px from native.

## Deviations

- **The group lives in gate 8, not gate 2.** Gate 2's G2d covers CanvasTexture, but its scene is a
  per-pixel model with no meshes or polygons. Gate 8 already judges STS2 blockers against an unarmed
  reference, with a GSW band and a web half.
- **No feature-manifest row.** The `render-stream-8` feature manifests (G8z) are not regenerated
  for `g8c`.
