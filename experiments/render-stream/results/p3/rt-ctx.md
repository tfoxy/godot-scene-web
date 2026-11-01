# Late-arm runtime CanvasTexture adoption via the node map (RT-CTX, 2026-11-01)

This increment closes the remaining late-arm gap from `late-arm.md` ("Deferred" bullet "Runtime
`CanvasTexture`s (spine)"). A `CanvasTexture` built in code (spine-godot's atlas pages) has no
resource path for the census and no `canvas_texture_get_channel` RenderingServer getter, so the
cached `.tres` path (PM9) cannot read it. RT-CTX reads it from the drawing item's node instead.

## Node-map path chosen

The draw's CanvasTexture RID is threaded through `adopt_texture_ref` as `item_rid` at the geometry
hooks (the `add_texture_rect`, `add_texture_rect_region`, `add_msdf_texture_rect_region`,
`add_polygon`, `add_triangle_array`, `add_mesh`, `add_multimesh`, `add_nine_patch`, `add_primitive`
and `add_particles` hooks). When `texture_2d_get` returns no image (a CanvasTexture) and the cached
`.tres` path fails, `adopt_canvas_texture_via_node` looks up the item's CanvasItem node
(`node_of(item_rid)`), reads its `texture` property through `Object.get("texture")` (a Variant), and
— when that resource is a `CanvasTexture` whose RID matches — adopts its channels through the same
getters the cached path uses (`adopt_canvas_texture_resource`). The channel textures (diffuse/
normal/specular) are adopted first, then `hooks_adopt_canvas_texture` registers the entry with
origin `adopted`. A draw whose node is missing or whose `texture` is not the named CanvasTexture
stays `unknown-texture`, counted in `textures_refused`.

Two code facts worth recording:

- `Object.get` and `ShaderMaterial.get_shader_parameter` share the same signature hash
  `2760726917` (`(StringName) -> Variant`); the bind is keyed under `Object`.
- `Mirror::canvas_texture_adopt` now sets `adopted_content = Current` (the channels/filter/repeat
  are the live resource's getters; a CanvasTexture has no creation copy). Without it, the /8
  validator rejects the entry (`adoption-entry: adopted_content must be non-null exactly when
  origin is adopted`) — this also completes PM9's cached `.tres` path, which had the same defect.

## Fixture, check, sabotage

- **Fixture** `fixtures/gate8-ct-late`: three 64x64 cells, every image built in code at `_ready`
  (`ImageTexture.create_from_image`) and drawn only through a runtime `CanvasTexture` assigned to the
  item's `texture` — a `Sprite2D` (`add_texture_rect`), a `TextureRect` (a Control's
  `add_texture_rect`) and a `MeshInstance2D` over an `ArrayMesh` quad (`add_mesh`, the spine shape).
  The loader arms LATE at frame 12 (`RS_FIXTURE_ARM=late`), after every CanvasTexture and item
  exists, under `GRC_ADOPT=arm` on a private 640x360 gamescope (a headless host's dummy storage
  allocates no CanvasTexture RID).
- **Check** `scripts/lib/gate8-ct-late-checks.ts`, group `g8ctl`:
  - `ctl-legs`: every leg that ran exited 0.
  - `ct-late-adopt`: `adopt_stats.resources.textures_canvas == 3`, `textures_refused == 0`; the
    last transaction's canvas entries are all `origin: adopted`, `status: ok`, each diffuse an ok
    image; no `unknown-texture` command; both /8 sinks pass the TypeScript validator.
  - `ct-late-fault`: under `GRC_ADOPT_FAULT=no-resources` nothing is adopted (the pre-RT-CTX
    capture), and the draws through a CanvasTexture stay `unknown-texture`.
- **Sabotage** is the `no-resources` fault capture (the pre-RT-CTX capture): the node-map path is
  disabled and every draw through a CanvasTexture is refused `unknown-texture`.

## Byte-identity of unchanged paths

The change touches only the adoption path for a CanvasTexture reached at a late arm through a
geometry hook. A texture drawn by any other route (armed at birth, a plain `ImageTexture`/
`CompressedTexture2D`, a material/shader parameter, `texture_replace`) is byte-identical: the new
`item_rid` argument is ignored unless `texture_2d_get` returns no image and the RID is a
CanvasTexture, and `adopt_texture_ref`'s single-argument call sites pass `item_rid = 0`. The
`canvas_texture_adopt` `adopted_content` fix only affects late-arm CanvasTexture adoption (never an
armed-at-birth recording). The smoke tier re-runs gate 0 and the unchanged gate 8 groups to confirm.

## Owed: STS2 spine confirmation (a later game leg)

This is the generic capture-side proof only. The STS2 spine confirmation — replaying the kept
recordings through the fixed receiver, or a fresh `late12` game capture with the spine atlases
adopted from their drawing mesh's node — is a LATER game leg and is NOT run here (no game launch,
per the brief). It is owed in the P3 fidelity tracking.

## Validation

- **g8ctl alone** (`run-gate8.sh --legs g8ctl`): 3/3 checks pass (adopted 3 canvas textures, 0
  refused; the fault capture adopts nothing).
- **Smoke tier** (`validate-increment.sh --tier smoke -j 1`): every correctness run passed --
  `capture-build` (46 ctests), the four `cargo-*` runs, `pnpm-test`, the native gates -1, 0, 1, 2,
  3, 4, 5, 55, 8 and `hc1`, and the `g7-gsw`/`g7-web-rust`/`g7live-*` smokes. Native gate 8 passed
  316/316 including the new `g8ctl` group (`ctl-legs`, `ct-late-adopt` adopted 3, `ct-late-fault`).
  `pure` first failed on `self-test-gate8z` (the manifest had no `g8ctl` GROUP_COVERAGE_8 entry);
  after adding `g8ctl: ["payload.canvas_texture_diffuse"]` it passed. `pnpm-test` first hit the
  known `client.test.ts` core-load-failed 20 ms flake (unrelated) and passed on re-run.
  `bench-instr` exits 3 locally (no valgrind; the remote job is its producer). The native gate 6
  timing run was stopped: timing is the milestone sweep's.
- **Full tier** (`scripts/remote-validate.sh --tier full`, [run 41344689716](https://github.com/tfoxy/godot-scene-web/actions/runs/41344689716)):
  **21 of 22 runs pass.** Every correctness run passed remotely — setup (`pure` in six shards,
  `capture-build`, the four `cargo-*` runs, `pnpm-test`, `bench-instr` within ±0.93 % of baseline),
  native gates -1 to 8 and `hc1` (gate 8 passed 316/316 including `g8ctl`), `g7-gsw`, `g7live-gsw`
  and `g7live-web-rust`. The one miss was `g7-web-rust` (`rc=missing`): its `g7-8` shard (the
  web-rust replay of gate 8's receiver legs) is killed by the runner's `validate-increment`
  watchdog (`exceeded … min and was killed`, exit 124) — a hosted-runner resource limit, not a
  regression: this change is capture-side (g8ctl has no receiver legs, so the replay is unchanged)
  and the shard's other seven groups plus `native-rust-gate8` (316/316) all passed. Re-run via
  `--only g7-web-rust` (run 41353148958) reproduced the same watchdog kill, confirming it is a
  pre-existing runner limit, not a flake.
  Refused (local-only or timing, per smoke-map `remote`): `lock-tests`, the `g7live` `g7-1` groups,
  and every timing run/group — the milestone sweep's. Summary:
  `artifacts/render-stream/p3/rt-ctx/remote-validate-summary.json`.
- Timing is deferred to the milestone sweep.

## Evidence

Copied to `artifacts/render-stream/p3/rt-ctx/` in the main checkout:
`g8ctl-late-capture-result.json` (the late capture's result.json `adopt_stats.resources`:
`textures_canvas` 3, `textures_refused` 0), `gate8-result.json` (the full native gate 8 verdict,
316/316), and `remote-validate-summary.json` (the remote full-tier summary).
