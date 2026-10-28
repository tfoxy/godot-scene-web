# GSI: GSW runs `INSTANCE_ID` in canvas_item `vertex()` (2026-10-28)

P3-VX (f843a22d) made GSW run canvas_item `vertex()` but refused `INSTANCE_ID`, `VERTEX_ID` and
`CUSTOM0/1` with a typed reason. PM3 (c714a819) then drew multimesh instanced, so `INSTANCE_ID` has
a real source. GSI measures what STS2 hits, then implements `INSTANCE_ID`.

**Headline:** STS2 hits none of the refused builtins, so the STS2 pixels do not move. GSW now
compiles `INSTANCE_ID` as `gl_InstanceID`, and `fixtures/gate8-mm`'s B_CUSTOM shader (a stock
template) tints per instance with it. Before the change GSW refused that shader and five g8mm GSW
checks failed in B_CUSTOM; after it every g8mm GSW check passes against the unarmed reference.

## 1. What STS2 hits

Every canvas_item shader in every kept STS2 recording was run through
`transpileGodotItemShader` (tool: `artifacts/render-stream/p3/gsi/count-shader-reasons.mts`;
shader sources found by scanning each `recording-patch.rs*` for `shader_type`).

| Input | Distinct canvas_item shaders | Transpiled | Refused |
| ----- | ---------------------------- | ---------- | ------- |
| `pm-a11-1` | 64 | 64 | 0 |
| all 13 kept recordings (`late-1`, `mx-*`, `pm7-a12-1`, `pm-a11-1`, `w11*-a11-*`) | 114 | 114 | 0 |

None of the 114 sources contains `INSTANCE_ID`, `VERTEX_ID`, `CUSTOM0` or `CUSTOM1` (8 have only
`shader_type` and a render mode, no function, and are admitted). The replay of `pm-a11-1` agrees:
its console has no `not transpiled` line. The only `unsupported-material` rows in its
`applied.json` are the 5 particle-process materials, and its `unsupported-op` rows are
`canvas_item_add_particles` (/11 carries no emitters). So the measured refusal counts by builtin are
all 0: `INSTANCE_ID` 0, `VERTEX_ID` 0, `CUSTOM0` 0, `CUSTOM1` 0. (`INSTANCE_CUSTOM` was admitted by
P3-VX and PM3.)

## 2. What changed

- **`packages/effects` `transpileGodotItemShader`:** `INSTANCE_ID` in `vertex()` is
  `#define INSTANCE_ID gl_InstanceID` in the vertex module. Godot renames it the same way
  (`drivers/gles3/storage/material_storage.cpp:1248`), and `shader_types.cpp:275` admits it in
  `vertex()` only. The fragment module still refuses it (`unsupported built-in "INSTANCE_ID"`),
  and so does a helper function, which Godot also cannot give built-ins.
- **No renderer change.** `canvas_items` already draws a multimesh with
  `drawElementsInstanced`, so `gl_InstanceID` is the instance's index in the draw, from 0, as in
  Godot's `TYPE_MULTIMESH` call (`rasterizer_canvas_gles3.cpp:1478-1523`, `instance_count`
  instances, no base instance). Every other GSW draw is a plain `drawElements`: `gl_InstanceID` is 0.
- `VERTEX_ID`, `CUSTOM0/1` stay refused with their typed reasons (nothing hits them; `CUSTOM0/1`
  need mesh custom attribute arrays GSW does not carry).

## 3. Fixture and checks

`fixtures/gate8-mm/mm.gd`: B_CUSTOM's `ShaderMaterial` gained `varying float v_id;
v_id = float(INSTANCE_ID);` in `vertex()` and `+ 0.1 * v_id` on blue in `fragment()`, so each of
its 6 instances has its own tint. Native and the web export compile it through Godot, so the
unarmed reference and the native g8mm checks (19/19) are unchanged in kind. The GSW checks are
g8mm's own (`gate7-gsw-g8-mm-checks.ts`): `mm-gsw-band@gsw` and the three sabotage-catch checks,
which judge B_CUSTOM against the reference within channel 1.

| Check (g7-8 GSW, `--only g8mm/`) | Before (old transpiler) | After |
| --- | --- | --- |
| `mm-gsw-band@gsw` | FAIL, B_CUSTOM 1280-1536 px beyond channel 1 (max 128) at every shot | PASS, 12 shots |
| `mm-gsw-flipbook@gsw` | pass | pass |
| `mm-gsw-catches-perturb-instance@gsw` | FAIL (B_CUSTOM wrong before the sabotage) | PASS |
| `mm-gsw-catches-undrawn-multimesh@gsw` | pass | pass |
| `mm-gsw-catches-ignore-identity-transform@gsw` | FAIL (B_CUSTOM outside the identity cells) | PASS |

The "before" run's console says `not transpiled: vertex(): INSTANCE_ID is GLES3's per-batch
instance index ...`, the typed refusal. Unit test: `item-shader.test.ts` ("maps vertex()
INSTANCE_ID to gl_InstanceID"; the refusal list now holds the fragment-side `INSTANCE_ID`).
Evidence: `artifacts/render-stream/p3/gsi/g8mm-gsw-{before,after}.txt`.

No sabotage was added: a receiver sabotage needs an rs-core apply switch plus a wasm rebuild, which
this gate's pattern does not make cheap, and the before/after pair above is the proof that the
check has teeth (B_CUSTOM's blue channel moves by 0.1 per instance, 128 levels at the last).

## 4. STS2 `pm-a11-1`, GSW dB

Replay through the GSI bundle (`rs_core_build sha=f73fb074ff10`, C3 `replay-gsw.sh`, port 8781),
`compare.py` over all six receiver dirs.

| Scene | GSW before (PM3 final) | GSW after PM6b | GSW after GSI | native | web |
| ----- | ---------------------- | -------------- | ------------- | ------ | --- |
| menu 1 / 2 / 3 | 31.30 / 31.17 / 31.04 | same | 31.30 / 31.17 / 31.04 | 31.27 / 31.14 / 31.01 | 31.29 / 31.17 / 31.04 |
| map 1 / 2 / 3 | 65.52 / 65.50 / 65.51 | same | 65.52 / 65.50 / 65.51 | 64.18 / 64.13 / 64.16 | 65.61 / 65.58 / 65.60 |
| combat 1 / 2 / 3 | 60.26 / 60.26 / 60.27 | same | 60.26 / 60.26 / 60.27 | 55.99 / 55.95 / 55.96 | 60.24 / 60.26 / 60.27 |

Identical to PM3 and PM6b at all nine steps, as section 1 predicts. `compare.json` for the leg:
`artifacts/render-stream/p3/gsi/pm-a11-1-compare.json`.

## Validation

- `vitest packages/effects`: 9 files, 184 tests.
- Local: `run-gate8.sh --legs g8mm` (native source, 19/19), then `gate7-tool.ts gsw-legs --group g7-8
  --only g8mm/` and `check-gate7.ts` over the before and after bundles (table above).
- Smoke and the remote full tier: see "Runs" below.

## Scope

- **In scope:** the GSW transpiler, g8mm's fixture shader, its GSW legs.
- **Out of scope:** the capture (HC3 and PM7 are editing it), the native and web receivers
  (Godot compiles the builtin itself), the GDScript cores, timing.
- **Deviation:** Godot numbers the rects of one batch (`rasterizer_canvas_gles3.cpp:1318`,
  `instance_count`), so a rect-drawing item's `INSTANCE_ID` is its position in a batch. GSW draws
  rects as merged `drawElements` ranges and gives 0. That is exact for mesh and polygon draws and
  a lone rect, and for every multimesh; a shader keyed on `INSTANCE_ID` over several batched rects
  is the one divergence.
- **Not done:** `VERTEX_ID` (GLES3's per-batch vertex index) and `CUSTOM0/1`; neither is hit.

## Runs

- Plan (`--plan`): every path reaches everything (no smoke-map rule matches `packages/effects`
  or `fixtures/gate8-mm`); full tier = pure, cargo-gsw-rs, pnpm-test, native-rust-gate8, g7-gsw,
  g7-web-rust, g7live-gsw, g7live-web-rust (timing runs `g7live-gsw-timing` and `g7x` are the
  milestone sweep's). No checker, runner or sabotage file changed except `lib/tier-verdict.py`
  (below), so native sabotage legs were skipped by tier.
- Local smoke: pure, cargo-gsw-rs, pnpm-test, g7-gsw, g7live-gsw-g7-1, g7live-web-rust-g7-8 rc=0.
  `native-rust-gate8` and `g7-web-rust` rc=1 in smoke: only checks whose legs the tier skipped
  or did not run (see tier-verdict below).
- Remote full tier, run 40781787413 (`remote-validate.sh --tier full`): pure, cargo-gsw-rs,
  pnpm-test, g7-gsw, g7-web-rust, g7live-gsw (g7-2/5/55/8), g7live-web-rust pass.
  `native-rust-gate8` failed on three "catches" checks of skipped sabotage legs. `g7live-gsw` g7-1
  is refused remotely; I ran `RS_VALIDATE_GROUPS=g7-1 validate-increment.sh --tier full --only
  g7live-gsw` locally: rc=0.
- **tier-verdict fix.** `lib/tier-verdict.py` excused a failing check of a skipped sabotage leg
  only when its id said `sabotage` or its text named the skipped leg. `coding-drop-base-caught`,
  `coding-wrong-prefix-caught` and `pt-lifecycle-catches-drop-restart` (PM6a/W11t) say neither, so
  any diff with no checker in it failed `native-rust-gate8`. An id containing `catches` or `caught`
  is now excused when sabotage was skipped (self-test cases added). Re-evaluating the remote and the
  smoke evidence with the fixed script gives `native-rust-gate8` pass (233 checks, 0 failing).
- Known: the smoke tier's one-leg `g7-web-rust` g7-8 run reports the checks of unrun legs as
  failing (rc=1); the full tier (remote) passes it.
