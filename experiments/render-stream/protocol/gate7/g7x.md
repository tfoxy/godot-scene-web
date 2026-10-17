### G7x — the Rust slice: core to `canvas-items` on the g31 (opus, gsw-renderer agent)

D32's proof. It is the smallest end-to-end path that a decision can rest on: real recordings,
through `render-stream-core`, to a packed draw list, drawn by the Rust renderer on the phone, and
timed per phase against the TypeScript path.

- **Inputs**, verbatim and never regenerated: G7d's final desktop run's bench recordings, which G7m
  reused.
  - Location: the main checkout's ignored
    `artifacts/render-stream/gate7/g7d-r1/g7-bench/inputs/`, retained from G7d with checksums in
    [`docs/worktree-evidence-2026-10-17.json`](../../../../docs/worktree-evidence-2026-10-17.json).
  - Copy them into this worktree's ignored artifacts first, then rewrite `inputs.json`'s absolute
    paths, and verify the sha256s (memory worktree-removal-loses-artifacts):

  | Input | Recording | Tx | sha256 |
  | ----- | --------- | -- | ------ |
  | `scene-full` | `scene/capture/recording.rs2` | 400 | `3a1a08752d99c33dac1e567203141259fc08b6fe03a68f774eff6b9b4722831c` |
  | `scene-patch` | `scene/capture/recording-patch.rs2` | 400 | `0a7daa1cb5ebaf2070e84134492713165c6f844ec4eb800484d629d0b7c429df` |
  | `hd-patch` | `hd/capture/recording-patch.rs2` | 122 | `c9aaaccaddc82e2825dbeb2d94ff1c1c8b9bd63989d9e900b26fd14c9e6b967b` |
  | `pace-patch` | `pace/capture/recording-patch.rs2` | 400 | `6b26220e1a642f5064e61d780c2b1c6f9c410b3c648476fe8ec49f9eb679a006` |

  Each input's `store/` sits beside its recording. Desktop correctness also uses
  `fixtures/gate7-pace/` and its `expected.json`.
- **Scope**, the smallest honest one:
  - The core: /6 framing, meta and blocks; validate and resolve, delta-driven; payload
    verification; the digest (D31, with an `inline` switch for R2); the retained state.
  - The applier: canvases by layer; D7's ordering (z, behind-parent, `top_level`, visibility);
    modulate; transforms; scissors.
  - Lowering for **every op class the four inputs contain**. The first step is an op census of the
    four recordings from the TypeScript decoder, recorded in "As built".
  - Lowering may be approximate where exactness belongs to a later increment. Lines and polylines
    become triangles with the vertex count of Godot's lowering, but not its exact joint geometry
    (G7t owns that). Custom `ShaderMaterial`s draw with
    the builtin program and are typed `slice-shader-builtin`. Every shortcut is listed, and none
    drops a draw. golden-2 to golden-5, /7 and every sabotage of Q5 wait for G7a.
- **Files**: the crates of Q14a marked "G7x"; `scripts/build-rs-core.sh`;
  `scripts/test/self-test-rs-core.ts`; `web/bench/` gains the `gsw-rs` page path;
  `gate7-bench.ts --arm gsw-rs` (and `gsw-rs-inline`); the TypeScript arm is renamed `gsw-ts`,
  with `gsw` kept as an alias until G7a.
- **Bench protocol**:
  - One transaction per rAF, as G7d's bench does. For each input: a warmup per arm, then five
    rounds of (`gsw-ts` deferred, `gsw-rs` deferred, `gsw-rs-inline`), each arm on a fresh page
    load. Interleaving gives every arm the same thermal and frequency state.
  - The desktop control arms run first on D9's harness, then `--env device --device g31`, which
    may run unattended (D28).
  - Per transaction: `decode_us` (`accept`: framing, meta, validation, resolve, payload checks;
    for `-inline`, also the record digest), `apply_us`, `draw_us` (the CPU time until `draw()`
    returns), `total_us` (one wall timer over Q14c's steps 1 to 4, boundary included), and
    `evidence_hash_us` (deferred, outside every timer).
  - Report-only: `gpu_complete_ms` from a `fenceSync` polled on later frames (the g31 has no
    timer query, memory g31-device-probe-facts).
  - Per repeat: the wasm heap; T_p as the measured rAF median; cpufreq through `DeviceSampler`
    (`scaling_max_khz`, `scaling_cur_khz` per cluster, `derated`); thermal status.
- **Pass rule**, all on the g31:
  - **R1, correctness.** This is a prerequisite, not a measurement. golden-6 passes through the core
    natively and as wasm. `self-test-rs-core.ts` matches on all four inputs after every
    transaction. `draw-count-parity` holds: each frame's executed draws equal its visible lowered
    draws minus the listed typed skips, with merges accounted. The pace fixture's desktop shots
    are exact at its `expected.json` seqs (`gate7d-checks.ts`, 0-pixel budget). The gate 6 scene's
    desktop shots against the native receiver's are reported per region, report-only, because
    G7a and G7g own those pixels.
  - **R2, the user's rule, against G7m's recorded TypeScript p95 under the same digest policy.**
    `gsw-rs-inline`'s `decode_us` p95 must be below 12.990 ms (scene-full), 7.395 (scene-patch),
    16.790 (hd-patch) and 2.160 (pace-patch).
  - **R3, like for like in the same session.** `gsw-rs`'s `decode_us` p95 must be below `gsw-ts`'s
    decode, validate and resolve p95 (both deferred, G7o1) on every input. That holds pooled over
    the five rounds, and in at least 4 of the 5 paired rounds.
  - **R4, the budget (D25).** `gsw-rs`'s `total_us` p95 must be ≤ 0.5·T_p, with T_p measured in
    that session (≈8.5 ms, G7m), in each of the five repeats, on `pace-patch`, `scene-patch` and
    `scene-full`. `hd-patch` is judged and recorded as the stretch target (D25).
  - **Win** is R1 to R4. The desktop arms are only the early signal.
- **On a win**: one commit, `feat(canvas): …` with a real `Changelog:` line. The integrator-visible
  part is `canvas-items`, which is off by default. The commit carries every crate, the bench arms,
  `self-test-rs-core.ts`, README "Gate 7x result" (the per-phase table for all three arms against
  G7m's, cpufreq and T_p per repeat, the op census, the shortcut list) and "As built (G7x)" here.
  Q14f's downstream consumer check passes first.
- **On a loss** (R1 holds, but R2, R3 or R4 fails):
  - One commit, `test(render-stream): …` with `Changelog: none`. It carries `rs-core` and its CLI,
    `self-test-rs-core.ts` and the numbers, because G7xn and G7xw still need the core for the
    separate Rust-against-GDScript question (D34).
  - `rust-draw-list`, `canvas-items`, `rs-gsw-wasm` and the `gsw-rs` arm stay on the branch
    `rs/gate7-g7x`, which is kept, with its sha in "As built".
  - D29 goes back to the user before G7a starts.
- **If R1 fails**, there is no result. Fix it, or stop and report. Numbers from an incorrect
  pipeline never land.
- **Sabotages**:
  - `skip-payload-hash` must fail golden `resource-hash`.
  - `drop-draws` (the executor skips every second merged draw) must fail `draw-count-parity` and
    the pace shots.
  - `stale-item-row` (the dirty item-row upload is skipped) must fail the pace shot at every step
    after the first. This proves the transform-only path is real.
  - `digest-skip` must fail `record-digest-complete`.
- **Agent notes**: use the gsw-wgpu-renderer skill for `rust-prototype`, and gsw-perf only for
  harness conventions. Run `rustup target add wasm32-unknown-unknown` if it is missing; it is
  installed here, with wasm-bindgen 0.2.129. Never launch headed Chromium. The g31 has standing
  approval (D28).

- **As built (G7x, 2026-10-15)**, details in the README's "Gate 7x result": **win**, R1 to R4,
  on the g31's third run (Chrome 154, T_p 17.01 ms, 0.5·T_p 8.505 ms, thermal `none`).
  - R2: `gsw-rs-inline` decode p95 6.130 / 2.220 / 4.550 / 0.745 ms (`scene-full`,
    `scene-patch`, `hd-patch`, `pace-patch`) against 12.990 / 7.395 / 16.790 / 2.160.
  - R3: `gsw-rs` decode p95 2.820 / 1.330 / 2.465 / 0.660 against `gsw-ts`'s 6.110 / 5.450 /
    11.095 / 1.880, every input 5/5 paired.
  - R4: `gsw-rs` total p95 at most 5.930 (`scene-full`), 5.240 (`scene-patch`) and 1.575
    (`pace-patch`) in every round. `hd-patch`, the stretch target, misses: 10.545 to 12.870 ms,
    because 111 of its 122 transactions take the applier's structural path (`apply` 3.2/5.7 ms).
    An incremental structural apply is G7a's first optimization.
  - Runs 1 and 2 used the first core build, whose general JSON parser only tied V8's native
    `JSON.parse` on `scene-full`'s 98 KB full transactions; run 2 failed R3 there (6.175 against
    6.070 ms, 2/5 paired). On the g31, wasm runs about 11x slower than on the desktop and V8's
    JavaScript about 5x, so the desktop arms (Rust 2.8x faster) were not a usable signal for full
    snapshots. A schema-directed fast path for canonical transaction metas, with the general
    parser as fallback, and in-place full-transaction apply fixed it (native `scene-full` accept
    p50 120 to 34 µs); R1 was re-run on that build before run 3.
  - Op census: `add_rect`, `add_texture_rect`, `add_texture_rect_region`, `add_set_transform`,
    `add_triangle_array`, `add_nine_patch` (stretch), `add_polygon`, `add_polyline`, `add_line`
    (no AA), `add_circle`, `add_mesh` (untextured triangles); CanvasItemMaterial add/sub and one
    custom ShaderMaterial; no unsupported op.
  - The only shortcut that fired is `slice-shader-builtin`. Thirteen others are typed and
    unreached; the untyped approximations (CPU-baked `add_set_transform`, f32 primitive colours,
    no viewport culling, untested stretch, untested receiver context loss) are listed in the
    README for G7a and G7t.
  - Q14a's crates are as specified; the core parses meta with its own strict arena reader
    (`serde_json` only for dumps and goldens). Not built here: the core's
    wasm32-unknown-emscripten target and `rs-core-capi` (G7xw, G7xn). In
    `rust-prototype`, the existing `RustRenderer` exports are gated on the existing `webgl`
    feature, not on a new default-on `renderer` feature, because enabling any additional feature
    changed the default wasm bytes. The default build is byte-identical to `main`'s, and the
    couch-coop consumer check (Q14f) passed.
  - Scene shots against the native receiver (report-only) are within max delta 1 except `SM`
    (the builtin-shader shortcut), `LE` (max 7) and, from seq 108, `BG` (max 255). `LE` and `BG`
    are not root-caused and go to G7a/G7t.
