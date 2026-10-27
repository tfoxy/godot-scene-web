# RM8: regenerate the render-stream-8 manifests after P3

**Result.** `protocol/features/render-stream-8/{native,web-export,gsw-canvas}.json` and `collected.json`
are regenerated, and `check-gate8z.ts` passes 24/24 rows (it was 20/24 on main: GSW stale, and every
live hello off the files' sha256 since P3-ST changed the notes). Evidence: 145 native, 125 web and 130
GSW checks pass in their quoted runs; 7, 28 and 28 live hellos carry the files' sha256.

## What was stale

- **GSW's `material.shader-outside-transpile-subset` note** still said TIME and the
  `hint_default_*` samplers were refused (P3-TM).
- **No entry cited** `g8c` (P3-CT), `g8cg` (CG1/CG3) or gate 5.5's `g55s`/`g55v`/`g55t`.
- **`canvas_item_set_canvas_group_mode` / `_copy_to_backbuffer`** said "never hooked"; /10 carries both.
- The sha256 in every G8z live hello, because the files changed after P3-ST.

## Changes (`lib/feature-evidence-8.ts`)

- New entries `payload.canvas_texture_diffuse` (g8c: `ct-reference`, `ct-diffuse-uploaded`,
  `ct-channel-refused`) and `delivery.canvas_group_state_10` (g8cg: `cg-native-exact`, `cg-wire`,
  `cg-toggle-patch`, `cg-adopt`, GSW's `cg-gsw-untyped`).
- Override `material.shader-transpile-subset`: adds the `g55s`/`g55v`/`g55t` receiver-equals-reference
  checks (native from gate 5.5, browsers from the g7-55 live legs).
- Notes of the two item setters now say "carried on /10 only"; they stay `unobserved` on /8.
- The closing run moved to `render-stream/gate8/rm8/` on build `4b0de2f7`; `session@native` still
  quotes G8z's g6a captures (`ea402b95`), since nothing in it changed.
- **Guard.** `GROUP_COVERAGE_8` maps every landed group of `run-gate8.sh` and `run-gate55.sh` to
  its entries or a `none:` reason; `self-test-gate8z` (43/43) fails on a landed group with no
  decision, or one naming a missing entry.

## Runs (local; the remote wrapper cannot pass `--manifest-hello`)

All under `artifacts/render-stream/gate8/rm8/`, all rc=0, no failing row:
`native-gate8` (every group, sabotage legs), `native-gate55` (every group), `g7-gsw-g8` and
`g7-web-rust-g8` (`--legs g7-8,g7-55` file legs), `native-g8l-hello`, `live-g8` (live g7-8 and g7-55,
both browsers, `--manifest-hello --manifest-features 8`), `live-g7-2-{gsw,web}` (fast frames).
The first browser live runs predated a ref-tuple fix, so they were rerun after the final sha was frozen.
Small evidence: `artifacts/render-stream/p3/rm8/` (check-gate8z output, frozen shas).

Not rerun: timing groups, gate 6 beyond G8z's g6a, the gate 7 carried runs (still `6a454065`).

P3-CK (f3337f03) landed after these runs: its g55t evidence is from `4b0de2f7`; P3-CK did not touch the manifests.
