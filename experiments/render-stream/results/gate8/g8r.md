## G8r result (2026-10-23)

G8r ([protocol/gate8-design.md](../../protocol/gate8-design.md) D6, D7 and Q2 "As built (G8r)")
passes. Under `GRC_ADOPT=arm` a texture, mesh or glyph atlas page that existed before the capture
armed is adopted at its first reference by a hooked call, instead of getting G8a's typed
`unknown-texture` / `unknown-mesh`. Its entry is a created one in every field but
`origin: "adopted"` and `adopted_content`, and its bytes go through the hooks' own copy path, so
G8t's host decode and G8kw's workers and hold-back apply unchanged. From the arm on, the late
capture's stream equals the born capture's at every frame, apart from the two declared resource
exceptions. The receiver's pixels equal the reference's everywhere outside those two declared
rects. The default (non-adopting) path is byte-identical.

### What is adopted, per resource kind

| resource | source of the bytes | `adopted_content` | in the fixture |
| -------- | ------------------- | ----------------- | -------------- |
| glyph atlas page (integer, non-oversampled cache) | the TextServer's current page (`font_get_texture_image`), matched by content and confirmed by `font_get_glyph_texture_rid` | `current` | Grown's page, grown before arm (exact vs born) |
| `CompressedTexture2D` (found in the resource cache) | the dummy's copy, which equals the file | `current` | Chip (RGBA8), ChipBc (DXT5, host-decoded to RGBA8) |
| a texture whose first post-arm reference is a whole-image update | that update's image | `current` | HiddenSprite's |
| any other texture | the dummy's creation-time copy (`texture_2d_get`) | `creation` | Stale (updated in place before arm: stale until K+14), Plain (exact) |
| mesh | `mesh_get_surface` per surface, `mesh_get_custom_aabb` | `creation` | Mesh's `ArrayMesh` (exact vs born) |
| oversampled atlas page (D7's limit) | the dummy's creation copy | `creation` | g8h's `late-observe` control: 2 pages at oversampling 0.1 |

An adopted entry becomes `current` once its whole content is the hooks' own, with the version bump
the call makes anyway: after an accepted whole `texture_2d_update` (Stale at K+14), a
`texture_replace` by a hooked texture, or a `mesh_clear`.

**Stays refused, typed and counted:** a texture `texture_2d_get` gives no image for (a
`PlaceholderTexture2D`, a proxy, a RID that is no texture) keeps `unknown-texture`
(`textures_refused`; the fixture's Placeholder). A reference from a thread other than the main
thread keeps `unknown-texture` until the next main-thread reference. A blend-shape surface keeps
`mesh-blend-shapes`. Everything G8a left typed stays typed.

### Born/late equivalence and checks (fixtures/gate8-adopt, run-gate8.sh `g8a`)

| check | result |
| ----- | ------ |
| `adopt-equivalence` | 39 of 39 frames from the arm (frame 12) are equal. Textures compare by payload hash, meshes by surface hashes. The exceptions are exactly the declared ones: Stale's creation copy at frames 12..25 (until its update at K+14), and the Placeholder refused at every frame. Residue 1 |
| `adopt-reference` | born equals the reference at 0 px at all 4 checkpoints. Late (full and patch sinks) differs from the reference and from born only inside the two declared rects: 1024 px in the creation rect at steps 0 and 1 (where it must differ), 256 px in the refused rect at every step, and 0 px outside them |
| `adopt-resources-account` | 6 textures (4 current: 1 atlas page, 2 CompressedTexture2Ds, 1 from an update; 2 creation), 1 decoded from DXT5, 1 refused, 1 mesh with 1 surface. result.json, the hook log's `adopt` lines and the wire agree. Born adopts nothing. Stale is `current` at the end |
| `adopt-resources-workers` | at `GRC_TEXTURE_WORKERS=2`, every adopted copy is a worker copy. 27 of the 39 synchronous transactions are published, 12 frames are held, and each published one is state-equal to the synchronous one |
| `fault-no-resources` | detected: 80 state problems, 22,338 px outside the regions, account 0 textures |
| `fault-atlas-from-dummy` | detected: 4 state problems (the page's content differs while declared `current`), 793 px (Grown's missing glyphs) |
| `fault-claim-current` | detected: 15 state problems (Stale's stale content declared `current`); its account reads 6 current, 0 creation |
| G8a's 13 checks | pass with the extended scene: 28 items, 3 hidden, 8 canvas-group members, 25 arm-time draws, 30 probed nodes |

### Adoption cost

The time is measured inside the capture (`adopt_stats.resources`, steady clock). The one-time census
(ThemeDB fonts, a 12-path `res://` walk, 1 font, 2 cached CompressedTexture2Ds) took 0.75-0.80 ms.
All 7 read-backs together took about 1.0 ms. That includes the atlas content test over the 256x256
LA8 page and the copies and hashes, which are small here. The census walks every file in the
project, so its cost scales with the pack.

### What ran

| where | runs | result |
| ----- | ---- | ------ |
| local, iterating | capture ctests (26; `rs_adopt` gains 36 G8r checks: adopted equals created but for origin and adopted_content, the refinement to current, the hook log's adopt lines, fault parsing), `self-test-gate8-adopt.ts` (36 assertions, a new group 4 for the resource exceptions), `run-gate8.sh --legs g8a` three times | the third g8a run 16/16; `run-gate8.sh` (every group: g8t, g8a, g8h) 37/37 |
| local, default-path identity | `run-gate5.sh --legs g5c` and `run-gate4.sh --legs g4a` with main's capture and with this branch's, compared record by record and hook-log line by line (`cmp-rec.ts`, as G8kw/G8sha) | identical apart from volatile fields: 102 of 104 records byte-identical in each, the other 2 differing only in session/stream ids and timing stats; every hook-log line equal beyond timings (mesh: 393 lines, atlas: 38) |
| local smoke (`validate-increment.sh --tier smoke --only pure,capture-build,native-rust-gate0,native-rust-gate8`, `artifacts/render-stream/validate/g8r-smoke/`) | 4 runs | 4/4 pass (pure 934 s) |
| local, the runs the remote refuses | `g7live-gsw-g7-1` and `g7live-web-rust-g7-1` at smoke (`g8r-live-g7live-*-g7-1/`); g7-2 in full, `RS_VALIDATE_GROUPS=g7-2 --tier full --only g7live-gsw` then `g7live-web-rust` (`g8r-live-g72-*`), since the smoke tier defers g7-2 | all pass: g7-1 smoke gsw 8/20 and web/rust 9/21 checks pass, the rest naming legs skipped by tier; g7-2 full gsw 40/40, web/rust 41/41 |
| remote full tier | run 40041468044, key `rv-20261023T234543Z-aa8f365-12563` (`artifacts/render-stream/remote/20261024T003103Z`) | 17 of 21 runs pass; the 4 others are below |
| remote reruns | `--only pnpm-test`: run 40045138316 (pass); `--only g7-web-rust,g7live-web-rust`: run 40045586433 (2/2 pass, every group) | pass |
| after the rebase onto d0911ac1 (G8f, G7rf) | capture ctests, `run-gate8.sh` (every group, G8f's g8f included) and pure | ctests 26/26; pure pass; gate 8 44/45 at first. Its one failure, G8f's `float-exact`, came from a stale receiver core: the rs-core extension was not rebuilt after the rebase. After `build-rs-core-ext.sh`, g8f passed 8/8 (`gate8/g8r-rebased`, `gate8/g8r-rebased-g8f`) |

The remote full tier passed `pure`, `capture-build`, `cargo-rs-core`, `cargo-rs-core-capi`,
`cargo-decode-proto-rs`, `bench-instr` (every Ir within ±0.74% of baseline), native gates −1, 0, 1,
2, 3, 4, 5, 55 and 8 in full with their sabotage legs, `g7-gsw` with every group, and `g7live-gsw`
(g7-5, g7-55). Of the four other runs:

1. `cargo-gsw-rs` failed with the known rc 101.
2. `pnpm-test` failed with an ENOENT on a transient
   `fixtures/assets/fonts/roboto/Roboto[wdth,wght].ttf.*.tmp`, which another test wrote while
   `packages/html/test/fixtures.test.ts` was scanning the directory. This diff touches neither. The
   suite passes locally (2518 tests) and in the remote rerun.
3. and 4. `g7-web-rust@g7-6` and `g7live-web-rust@g7-55` were **cancelled, not failed**. The
   pnpm-test rerun was dispatched from the same worktree, and the workflow's concurrency group is
   `remote-validate-<worktree>` with `cancel-in-progress`. Every other group of those two runs had
   already passed, and the rerun of both runs passed every group.

### Out of scope, and why

Not run: the timing phase (`native-rust-gate6`, `g7live-*-timing`, `g7x`), `lock-tests`, and the
timing groups inside the native gates (g1c-rate, g1d, g2c-pins, g5f, g55f, gate 8's
`decode-cost`). Hosted runners skip them, and the brief defers timing to the pre-release delta sweep,
which covers `*` anyway. Lazy adoption is opt-in: with `GRC_ADOPT` off, every hook gains one
atomic load and the default recordings are byte-identical (above). The rebased combination with
G8f/G7rf was not sent to the remote again; locally it passed the ctests, every gate 8 group and
pure. Known failures ignored: `cargo-gsw-rs` rc 101.

### Deviations from the design

- **CompressedTexture2Ds are recognised through the resource cache, not "reached through a node".**
  Every one of them is loaded by path, so the census that D7 needs for fonts finds them all, on any
  node, theme or material, without a getter table per class. A texture the census misses degrades
  to `creation`, never to a false `current`.
- **Atlas pages are matched by content before the RID is confirmed.** `font_get_glyph_texture_rid`
  creates a texture for a page that never had one, a side effect D3 does not allow. So it is called
  only on the page whose current image is consistent with the dummy's creation copy.
- **First reference by an update** adopts from the update's own image (`current`). The design names
  only draws ("first reference by a hooked call or an adopted item"), and an update is a hooked call
  that carries the whole content.
- **A fault knob, `GRC_ADOPT_FAULT`, instead of new sabotage kinds.** The design names no G8r
  sabotage, and a new `GRC_SABOTAGE` kind is a wire change, as G8kw's
  `GRC_TEXTURE_WORKER_FAULT` reasoned.
- **No `g8r` group.** G8r extends `g8a`: the same fixture and the same born and late legs, plus
  `late-workers` and three fault legs.
- **The rendered reference draws ChipBc decoded on the CPU.** A desktop editor always imports S3TC,
  and a GPU's BC3 interpolation differs from bcdec's: on this host, 420-454 px with max Δ 3. So the
  reference draws the `Image.decompress` result, as G8t's reference does.
- **A mesh RID always adopts**, at 0 surfaces when it is not a mesh. The dummy cannot tell the two
  apart, and both draw nothing.

### Implementation versus validation time

From 19:57 to 22:35, about 2.6 h of wall time:
- **Implementation, about 50 minutes.** Reading the design, the engine and the code took about 15
  minutes. The capture code, the unit tests, the fixture, the runner and the checker took about 35,
  through the first g8a run. The three g8a iterations took 1-2 minutes each, plus lock waits. Docs
  took about 20 more minutes, written while validation ran.
- **Validation, about 1.75 h of wall time, run in parallel:**
  - the remote full tier, about 75 minutes from dispatch until the cancellation, plus about 27
    minutes for the web-rust rerun;
  - the local smoke subset, 22 minutes;
  - the local g7-1 smoke runs, 2 and 2.3 minutes;
  - the local g7-2 full runs, 16 and 18.5 minutes (mostly lock waits behind other agents'
    gate 6 timing legs);
  - the default-path identity runs, about 12 minutes;
  - the post-rebase gate 8 run and pure, about 35 minutes (gate 8 waited 14 minutes for the lock
    behind a gate 6 soak).

  The one avoidable loss was the self-inflicted cancellation, about 30 minutes.
