## G8kwh result (2026-10-24)

G8kwh ([protocol/texture-delivery-design.md](../../protocol/texture-delivery-design.md) "Deferred,
with owners" and "As built (G8kwh)") passes: the web export states, and uploads, only the texture
formats its WebGL context takes.

1. **The `etc2` claim.** Godot 4.5.1 sets `etc2_supported = true` on every non-desktop-GL build
   (`drivers/gles3/storage/config.cpp`, the `!is_gles_over_gl()` branch), whatever the context's
   extensions; the other four families read them. The web export now states a family only when
   `has_os_feature` reports it AND the page's WebGL 2 context lists its extension (read through
   `JavaScriptBridge`). Desktop (RTX 2060, pinned Chromium): engine `s3tc,bptc,rgtc,etc2`, context
   `WEBGL_compressed_texture_s3tc`, `EXT_texture_compression_bptc`, `EXT_texture_compression_rgtc`,
   stated `s3tc,bptc,rgtc` (was `s3tc,bptc,rgtc,etc2`). The CI runner's ANGLE-on-lavapipe WebGL lists
   the same three extensions (GSW's own hello there: `s3tc,bptc,rgtc`), so the web export states
   `s3tc,bptc,rgtc` there too (it stated `s3tc,bptc,rgtc,etc2` and took 11 blocks before); the
   runner's native llvmpipe GL states `s3tc,bptc,rgtc,astc`. g8kp's web leg takes 6 `block` and 8
   `decoded` (was 11 and 3: 5 ETC2 blocks refused with `INVALID_ENUM`) and logs no `WebGL: ` error.
2. **WebGL's BC alignment rule.** rs-core `DeliveryPrefs.bc_aligned_only` (and `transcoder_aligns`
   for GSW): D3 skips BC `block`, and `uastc` while a BC family is stated, for a texture whose level 0
   is not 4-aligned. g8ku's 150x110 `npot` is `decoded` on the web export (no KTX2 fetched); the four
   aligned uastc textures still transcode to BC7, bit for bit the native oracle's.
3. **The loader's target, bounded.** Godot's KTX2 loader picks its target from `has_os_feature`
   (still `etc2` on the web, and blind to the mask). Under the web export's rules a transcode whose
   family is not stated, or BC at an unaligned size, is refused (`refused_target`) and falls back to
   `decoded` (G8kf's path). Masked, all six uastc transcodes are refused (`bptc`), 10 `decoded`
   uploads.
4. **The G8kb asymmetry** ("wrong live, right in the replay of the same sink"): the replay in G8kb's
   evidence ran on the *native* receiver (`web-npot-defect/replay/applied.json`: `receiver.kind`
   `native`, X11), and desktop GL accepts an unaligned BC7 level 0. The live web final shot and that
   replay's last checkpoint differ on all 16,500 px of the `npot` box and elsewhere by channel 1 only
   (6,173 px). Under the landed harness (`lib/legs.sh` sends a GRS9 replay to the browser) the replay
   is the web export and draws the same box.

### Checks (development host, RTX 2060)

| check | result |
| ----- | ------ |
| `delivery-select-web` (g8kp, extended) | pass: 6 block, 8 decoded; stated `s3tc,bptc,rgtc`, engine `s3tc,bptc,rgtc,etc2`, each stated family's extension listed, `bc_aligned_only` stated |
| `delivery-pixels-web` (g8kp, new) | pass: desktop step (6 BC blocks) 212,483 decided px, 206,487 exact, 5,996 at delta 1, 0 beyond, against `reference-hw`; mobile step (no ETC2/ASTC taken) 0 px from the masked leg; no `WebGL: ` console line |
| `sabotage-advertise-etc2` (g8kp, new) | pass (caught): the pre-G8kwh hello takes 5 ETC2 blocks; 67,324 decided px beyond delta 1 (max 255), 11 `WebGL: ` console errors |
| `delivery-web` (g8ku, updated) | pass: 4 transcodes on the oracle's target (BC7, bit for bit); `npot` decoded by WebGL's rule |
| `delivery-pixels-web` (g8ku, new) | pass: 0 px beyond channel 1 of the native upgrade leg at both steps; `npot` region against the native keep leg (decoded) |
| `delivery-web-masked` (g8ku, new) | pass: 6 targets refused (`bptc`), 6 fallbacks, 10 decoded uploads, status ok |
| `delivery-fallback` (g8ku, updated) | pass: native 5 fallbacks, web 4 (`npot` never fetched as uastc) |
| every other g8kp and g8ku check | pass (26/26) |
| g7-8 web half (`g7-web-rust`, group g7-8) | pass: g8kp's `receiver`, `receiver-patch`, `receiver-masked` replayed again: `applied-equals-native@web` 26 legs equal, `console-clean@web` 26 legs clean, `pw1-classes@web` other 0; `legs-not-replayed@web` lists g8ku's five legs as `web-judged-in-gate8` |
| g7-8 live, web (`g7live-web-rust`, group g7-8) | pass: g8l `basis` runs for the web export again: `g8l-basis-delivery@web` (4 uastc uploads, BC7), `g8l-basis-states@web`, `live-replay-equals-live-g8l-basis@web` 0 px |
| g7-8 GSW halves (`g7-gsw`, `g7live-gsw`, group g7-8) | pass (GSW now states `bc_aligned_only`; no fixture has an unaligned BC block) |
| rs-core `webgl_alignment_rule`, `self-test-gate8kp.ts` section 5 | pass |

### Re-enabled, and what stays out

- **Re-enabled:** g8kp's three receiver legs in g7-8's web half; the web export's live g8l `basis` leg.
- **Replayed but differing by design where contexts differ:** on the CI runner native llvmpipe GL
  states `astc` and the web export does not, so g8kp's replayed legs make different D3 choices; the
  new report-only `delivery-context-differs@web` lists such legs and their pixel differences are
  attributed there (as a `web-*` refusal's are). The first remote full tier failed
  `g7-web-rust@g7-8` before this rule (its logs were lost to the hung "Trim artifact"; the cause is
  inferred from the runner's stated families in a same-day remote gate 8 run, see the record).
- **Still out, by design:** g8ku's five receiver legs in g7-8's web half, now typed
  `web-judged-in-gate8` (was `gsw-only-group`). The web export keeps `npot` decoded where the native
  receiver uploads its BC7 transcode, so `applied.json` and that region differ from every native g8ku
  leg; gate 8 replays them in the web export itself (`g8ku-web/{web,web-fallback,web-pending,
  web-masked}`) and judges them with web-aware checks. The same reason covers `g8l/basis/replay`,
  which a full gate 8 source (one the source cache reuses from a native gate 8 run) contains: a
  local rerun on such a source replayed it and failed on exactly the `npot` difference (6,802 px,
  max delta 32; native 15 fetches, web 14).

### Deviations from the brief

- Beyond the plan: a backstop in the extension's transcode (`refused_target`), because the web
  export's uastc target is Godot's loader's choice, which still reads `has_os_feature`: the stated
  families alone do not bound it. Exercised by the new masked leg; a real context with neither BC
  nor ASTC nor ETC (where the loader would pick ETC2) is not available here.
- `bc_aligned_only` skips an unaligned uastc variant whenever a BC family is stated, without
  predicting the loader's component-dependent order: conservative on a context with both ASTC and
  BC (a four-component texture would get ASTC); no desktop GPU has both.
- GSW sets the rule too (for `block` only, its transcoder already aligns): no fixture exercises it.

### Out of scope

A fixture with an unaligned BC `block` variant; Android/iOS native exports (they share Godot's `etc2`
claim); ETC1S (G8ke); gate 8 manifests for the new checks (G8z); the g31 (unchanged path: it has
ETC2 and ASTC); timing runs (native gate 6, `g7live-*-timing`, g7x, gate 8 `decode-cost` and
`worker-hook-time`), deferred to the pre-release sweep.

### Validation record

- Remote full tier on the landed commit (rebased on GRT6's 714e877c): run
  [40160668046](https://github.com/tfoxy/godot-scene-web/actions/runs/40160668046), **18/18 pass**
  (pure, cargo x3, bench-instr, native gates -1 to 8 with sabotage legs, `g7-gsw`, `g7-web-rust`,
  `g7live-gsw`, `g7live-web-rust`; remote `native-rust-gate8` included).
- The first remote full tier, before the rebase and before `delivery-context-differs@web`: run
  [40154158484](https://github.com/tfoxy/godot-scene-web/actions/runs/40154158484), 15/18:
  `native-rust-gate8` (the remote failure GRT6 fixed), `g7-gsw` (its g7-8 job's validate step passed;
  the job hung in "Trim artifact" and was cancelled) and `g7-web-rust` (its g7-8 job failed: g8kp's
  replayed legs, where the runner's native receiver states `astc` and the web export does not; the
  log was lost to the hang). Two reruns (40157872013, 40159137933) were cancelled before finishing.
- Local, development host: gate 8 `g8kp,g8ku` 26/26; `validate-increment --tier full --only
  native-rust-gate8` rc=0 (403 s); the refused group, `g7live-gsw` and `g7live-web-rust` with
  `RS_VALIDATE_GROUPS=g7-1`, rc=0 on the landed content; g7-8 alone (`RS_VALIDATE_GROUPS=g7-8`):
  `g7-gsw`, `g7-web-rust` (on a fresh source and on a full gate 8 source from the cache),
  `g7live-gsw`, `g7live-web-rust` rc=0; `pure` 79/79, `cargo-rs-core`, `-capi`, `gsw-rs`;
  `receiver_selftest.gd` 52 checks ok.
- Not run, by the brief: the timing runs (native gate 6, `g7live-*-timing`, `g7live-native-timing`,
  g7x), deferred to the pre-release sweep.
