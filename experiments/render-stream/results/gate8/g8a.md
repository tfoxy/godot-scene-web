## Gate 8a result (2026-10-23)

G8a ([protocol/gate8-design.md](../../protocol/gate8-design.md) D3-D5, D13, Q2 and "As built (G8a)")
passes. Under `GRC_ADOPT=arm`, a capture loaded at runtime after the scene exists adopts every canvas
layer and canvas item reachable from the root window at arm. It reads them through node getters,
requests one `queue_redraw` per item and re-raises the top-level items. From the arm frame on, its
stream equals that of a capture armed at the scene's birth, at every frame, apart from Q2's
exception list. The native receiver's replay of both captures equals the rendered reference pixel
for pixel at every checkpoint. The default (non-adopting) path is unchanged.

### What adoption covers, what it withholds

- **Covered.** Canvas items: parent and child order, child draw index, top-level draw order
  (re-raised), transform, modulate, self-modulate, visibility, z, z-relative, behind-parent,
  visibility layer, filter and repeat resolved through the parent chain, the material RID, and
  use-parent-material. Commands, a Control's custom rect and clip, and its snapped transform arrive
  through the redraw. Canvas layers: canvas, attach, transform, stacking, follow-viewport. Each
  canvas gets its CanvasModulate colour. The hooks' typed node state is also declared: Light2D
  canvas lights, ParallaxLayer mirroring, Parallax2D repeat.
- **Withheld or typed, as the hooks would.**
  - RS-only items and canvases with no node (the residue): under skip they are counted and
    withheld; under strict the first one is `pre-existing-object`.
  - Subtrees of non-root viewports (not walked; counted).
  - A redrawn command naming a pre-arm texture or mesh is the hooks' `unknown-texture` /
    `unknown-mesh`. A pre-arm material is `unknown-material`. These resources are G8r's and G8m's.
  - Instance shader parameters (G8m), Polygon2D skeletons, identity-transform items, and RS state a
    script set directly on a node's own canvas item. These are listed in "As built (G8a)".
- **Refused before publishing.**
  - `adopt-thread`: the arm is off the main thread.
  - `adopt-unavailable`: a method bind is missing at its 4.5.1 hash.
  - The walk sabotages without `GRC_ADOPT=arm`.
  - An invalid `GRC_MIRROR_MAX_ITEMS` / `GRC_MIRROR_MAX_COMMANDS` (D13's caps; defaults 4096 and
    1024).

### Born/late equivalence (fixtures/gate8-adopt)

| check | result |
| ----- | ------ |
| `adopt-equivalence` | 39 of 39 frames from the arm (frame 12) to the end are equal under the id bijection; residue 1 |
| `adopt-reference` (exact) | late full sink, late patch sink and born each equal the reference at 4 of 4 checkpoints with 0 differing px; late also equals born |
| `adopt-noop-at-birth` | `GRC_ADOPT=arm` at birth adopts 0 objects; all 50 frames equal born's |
| `adopt-account` | 20 items, 1 layer and canvas, 2 hidden, 7 re-raised, 20 redraws, 1 CanvasModulate. Skip: residue = 1 unknown RID, 0 withheld. Strict: `pre-existing-object` at K+4 (frame 16), nothing before it |
| `adopt-thread-refused` | `adopt-thread: armed on thread 32, main thread 1`; 0 transactions |
| `adopt-no-scene-mutation` | stored-property hash of the 22 probed nodes is equal at K-1 and K+1, and equal to born's; 18 draw signals (one per visible item) |
| `adopt-wire` | both /8 recordings validate; late's session declares `{"mode":"arm","frame":12}`; its first transaction (frame 12) holds all 20 adopted items and the adopted canvas |
| `sabotage-adopt-skip-state` | detected: 358 state problems, 137,372 px differ |
| `sabotage-adopt-no-redraw` | detected: 858 state problems, 262,000 px differ |
| `sabotage-adopt-skip-layers` | detected: 39 state problems, 32,400 px differ; its account changes (0 layers, 2 unknown RIDs) |

The first full `run-gate8.sh --legs g8a` passed 10/10. The 11th check, `adopt-thread-refused`, was
added afterwards. The smoke tier's `native-rust-gate8` run then passed 20/20 checks (g8t's 9 and
g8a's 11), and the remote full tier's `native-rust-gate8` run passed too (evidence copied to
`artifacts/render-stream/gate8/g8a/`).

### Adoption cost at arm

The time is measured inside the capture (`stream.gate8.adopt_stats`, steady clock, on this host).
The fixture's 20 items and 1 layer take **47 µs in total**:

| part | time |
| ---- | ---- |
| read-only tree walk | 29 µs |
| applying the plan to the mirror | 12 µs |
| 20 `queue_redraw` calls and 7 re-raises | 7 µs |

That is about 2.4 µs per item. At that rate, STS2's roughly 2,400 live items would take about 6 ms
for one arm. The redraws themselves run in the arm frame's MessageQueue flush, as any redraw does.

### What ran

| where | runs | result |
| ----- | ---- | ------ |
| local, iterating | capture ctests (25, including the new `rs_adopt`: 42 checks comparing a born hook sequence with the adoption plan in two mirrors, the sabotages, the residue under strict and skip, and the caps), manual captures, `run-gate8.sh --legs g8a` | pass |
| local smoke (`validate-increment.sh --tier smoke --only pure,capture-build,cargo-rs-core-capi,native-rust-gate0,native-rust-gate8`, `artifacts/render-stream/validate/g8a-smoke/`) | 5 runs | 4 pass on the first run. `pure` failed one self-test (`smoke-plan.py --self-test` still expected the seams rule's old reach); after the fix it passes 68/68 (`g8a-pure/`) |
| remote full tier | run 39919591156, key `rv-20261023T074234Z-c50d2f1-17899`, https://github.com/tfoxy/godot-scene-web/actions/runs/39919591156 (evidence `artifacts/render-stream/remote/20261023T083116Z`) | 18 of 21 runs pass, see below |
| remote reruns of `g7live-web-rust` (g7-5, g7-55) | branch: runs 39925474826 (fail, `rv-20261023T083318Z-1f6ddfa-31138`) and 39927898952 (pass, `rv-20261023T085336Z-794db20-18994`); main baselines: 39926722431 and 39927920936 (both pass) | see below |
| local full, g7-5 and g7-55 on web/rust | `RS_VALIDATE_GROUPS=g7-55,g7-5 validate-increment.sh --tier full --only g7live-web-rust` (`artifacts/render-stream/validate/g8a-live-web-55/`) | 40/40 |
| local full, the groups the remote refuses | `RS_VALIDATE_GROUPS=g7-1,g7-2 validate-increment.sh --tier full --only g7live-gsw,g7live-web-rust` (`artifacts/render-stream/validate/g8a-live-full/`) | gsw 73/73, web/rust 75/75 |

The remote full tier ran these runs, all of which passed:
- `pure` (except the shard noted below), `capture-build`, `cargo-rs-core`, `cargo-rs-core-capi`,
  `cargo-decode-proto-rs`, `pnpm-test` and `bench-instr` (every Ir within ±0.8% of baseline);
- native gates −1, 0, 1, 2, 3, 4, 5, 55 and 8, in full with their sabotage legs (gate 8 with
  both groups, g8t and g8a);
- `g7-gsw` and `g7-web-rust`, all groups;
- `g7live-gsw` (g7-5, g7-55).

Three runs failed:
1. `cargo-gsw-rs`: the known rc 101.
2. `pure`: shard 6, the same smoke-plan self-test, which was fixed after the dispatch.
3. `g7live-web-rust`: g7-55's `native-legs@web` failed `shader-fetches-latest-only:
   live-shader-stall: no stall recovery evidence`. That check depends on observing a stall window
   in time on the hosted VM. The leg's other 18 checks passed, `leg-class-live-shader-stall@web`
   included, and nothing in this diff reaches the /7 live path.

   The first remote rerun failed a different check of the same family (`native-legs@web`
   `stale-coalesce: sabotage-shader-stale-coalesce: no stall recovery evidence`). The second
   passed. Two baselines of `main` passed, and the same groups passed 40/40 locally.

   So on hosted runners the branch passed once in three runs and `main` twice in two. Each failure
   was a different stall-recovery check, and both checks read a stall window from wall-clock
   receiver timing. I judge it a hosted-runner flake and not this diff, whose default path is
   unchanged, but it is not proven. The orchestrator should watch g7-55's stall-recovery checks
   in the next remote sweep.

Default-path identity:
- `pure`'s golden-2 to golden-8 `--check` are unchanged.
- The window-1 transcripts (`rs_live_window` ctest) are unchanged.
- Native gates −1 to 5.5 passed in full, remotely.
- The only default-path code changes are the mirror's create refactor (same behaviour) and the
  caps, whose defaults are the old constants.

### Out of scope, and why

Not run: the timing phase (`native-rust-gate6`, `g7live-*-timing`, `g7x`), `lock-tests`, and the
timing groups inside gates 1, 2, 5, 55 and 8 (`decode-cost`), which hosted runners skip. They are
deferred to the pre-release delta sweep, which covers `*` anyway. Adoption is opt-in and adds no
work to any default session beyond reading two environment variables. Known failures ignored:
`cargo-gsw-rs` rc 101.

### Deviations from the design

- **The re-raise is synchronous.** It calls the bound `_top_level_raise_self` per canvas-group
  member, in tree order, instead of the deferred `call_group_flags` D3 names. The calls and their
  order are the same, there are no Variant varargs, and there is no one-iteration group-call lag.
- **Frames are the host's main-loop iterations under `GRC_ADOPT=arm`.** The capture aligns its
  counter with `Engine.get_process_frames()`, so `adoption.frame` is the iteration of the walk and
  late and born recordings share one clock. G8w had dated it from the library's load.
- **Two legs not in the design:**
  - `born-adopt` (`adopt-noop-at-birth`);
  - `late-thread` (`adopt-thread-refused`, proving D16's `adopt-thread`).

  The fixture also gained a Control in the hidden subtree, an adopted item freed after arm and a
  post-arm item added. Its residue sits at draw index 1000 so that the bijection meets it last.
- **The hidden-item exception is spelled out.** "No commands until shown" also covers a Control's
  custom rect and clip, which its `NOTIFICATION_DRAW` sends.
- **`adopt_stats` reports `residue` as discovered.** Under skip it is the distinct unknown RIDs
  named after arm. Under strict it is null, because the first one fails the session. A
  non-adopting /8 session keeps 0.
- **The smoke-map seams rule now reaches `native:gate8@*`** (G8t's note said it would) and lists
  `rs_adopt_test.cpp`.

### Implementation versus validation time

About 35 minutes of reading and writing (the seam and the mirror entry points, the walk, the unit
test, the fixture, the runner group and the checker), plus a 16-minute first `run-gate8.sh --legs
g8a`. That run passed on its first attempt, and 936 s of it was lock wait behind the milestone
sweep's timing legs. Validation took about 95 minutes of wall time, run in parallel:
- the remote full tier, about 50 minutes from dispatch to collection;
- the local live g7-1/g7-2 full runs, 2052 s and 854 s (6.7 ks of lock wait between them);
- the local smoke subset, about 23 minutes;
- the `pure` rerun, 509 s;
- the remote g7live-web-rust reruns and main baselines, about 10 minutes each;
- the local g7-5/g7-55 web/rust run, 235 s;
- the post-rebase `pure` and `capture-build`.
