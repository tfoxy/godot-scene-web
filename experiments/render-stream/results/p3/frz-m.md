# FRZ-M: per-seat host-cost measurement for the three weak-host freezes (2026-11-01)

Status: **measured.** FRZ-M is the deferred measurement half of the freeze work (`frz-d.md` §7): the
per-seat host CPU saved by each of the three host freezes, measured on a deterministic combat, to
decide whether to build FRZ-T (tweenReplay), FRZ-S (Spine clip channel) and FRZ-DC (decor replay).
No product code changed; this doc lands the decision and the numbers.

Base: GSW `a47e3a88`, couch `dddda51f`. Both the seat capture and the client were rebuilt from GSW
`a47e3a88`; the couch mod was built from `dddda51f` with one **temporary, never-landed** measurement
lever (see Method).

## The one decision-changing fact first

**The render-stream streaming seat does not install the couch visual suspender.** In couch
`StreamingSeatRole.InstallsVisualSuspender(streamingSeat, isWindowless) => isWindowless && !streamingSeat`,
and `StartCapture` logs it verbatim: the streaming seat runs with `visual suspender and texture
evictor are not installed`. The three host freezes (`freezeParticles`/`freezeSpines`/`freezeDecor`)
are live only on the *old* browser-mirror headless clients, which are not the render-stream path.
So today the render-stream seat pays the full game-side sim, and each freeze is something to **add**
to that seat (with a client continuation), not something already there. FRZ-M measures what adding
each one saves.

## Method

- **Harness:** C3's control route (`menu,map,combat`), `C3_HEADLESS=1` — a plain `--headless` host
  with **no capture and no streaming-seat flag**, so `CouchCoopHeadlessVisualSuspender` installs
  (windowless) and the game-side spine/particle/decor sim is exactly what the streaming seat also
  runs. `COUCHCOOP_HEADLESS_PROFILE=1` emits the 1 Hz `[profile] cpu% … process_ms …` lines.
- **ON/OFF legs:** a temporary env lever in the suspender (see below) forces the freeze rescan
  without a viewer and disables the idle fps throttle, so every leg measures the **active 60 fps**
  per-frame sim, differing only in which freeze category is applied:
  `COUCHCOOP_FREEZE_TEST=none|spines|particles|decor|all`. Each value calls the suspender's *own*
  `FreezeAllSpine` / `FreezeAllParticles` / `FreezeDecorativeAnimators` walks (the exact toggles the
  task pointed at), so ON/OFF legs differ only by the freeze.
- **Metric:** `cpu%` = the process's total CPU as a % of one core (the profiler's own "how loaded"
  number, robust to per-frame timer phase). `process_ms` is reported but is **not** the deciding
  number — it is confounded by the rescan walk's cost (below).
- **Quiet machine:** every leg waited for load < 4 and held GSW's quiet lock exclusive. The 5 legs
  ran at 1-minute load 0.7–1.6.

### The temporary lever (never landed)

In `CouchCoopHeadlessVisualSuspender.Tick`, a `COUCHCOOP_FREEZE_TEST` block runs the requested
freeze walk every `RescanIntervalMs` (1 s), flushes finish nudges, and returns before the idle
throttle. `none` freezes nothing but still skips the throttle. This is measurement tooling in the
`frz-m-couch` worktree, not a product change; the couch checkout is left dirty and is discarded.

## Per-seat host cost, ON vs OFF (minimal deterministic combat)

The C3 combat fixture is a **single-player** Ironclad first fight (1 Ironclad + 4 slimes) — the
weakest combat, chosen for determinism, *not* the weak host's 4-seat co-op fight. Per-seat numbers
are median `cpu%` over the steady combat window (~30 s, 60 fps):

| leg (`COUCHCOOP_FREEZE_TEST`) | nodes frozen | cpu% (median, 100 % = 1 core) | Δ vs `none` |
| ----------------------------- | ------------ | -----------------------------: | ----------: |
| `none` (baseline)             | 0            | 6.90                          | —           |
| `spines`                      | 231 spine    | 4.40                          | **−2.5 pp** |
| `particles`                   | 63 particle  | 7.15                          | +0.25 pp    |
| `decor`                       | 5 animator   | 7.25                          | +0.35 pp    |
| `all`                         | 231 + 63 + 5 | 5.30                          | −1.6 pp     |

At 60 fps, 1 core = 16.67 ms/frame, so the per-seat **host saving** is:

- **Spine:** −2.5 pp ≈ **0.42 ms/frame/seat** of host CPU (freezing 231 spine-family nodes). This is
  the only meaningful saving, and it matches the suspender's claim that skeletal deformation
  dominates the headless budget.
- **Particles:** ~0 (63 particle nodes, but the minimal combat has few live emitters).
- **Decor:** ~0 (5 animator nodes — one energy orb, one intent icon, three process-only churn nodes).
- **All:** −1.6 pp ≈ 0.27 ms/frame/seat. (Noisier than the spine-only leg; the extra two rescan walks
  and the particle end-of-burst nudges offset part of the spine saving.)

The `none` → `spines` gap is the headline: freezing the spine family is worth ~2.5 pp of a core per
seat on this combat. Scaled from the minimal fight to a real 4-seat co-op fight (4–8× the creatures,
each with its own skeleton), the per-seat spine saving plausibly reaches ~10–20 pp — but that is a
projection, not what was measured here.

## The `process_ms` trap (why it is not the deciding number)

`process_ms` (`Performance.Monitor.TimeProcess`, the per-frame process-step time) goes **up** when a
freeze is on: `none` 1.07 ms → `spines` 5.14 → `particles` 4.76 → `decor` 4.77 → `all` 11.01 ms. That
is not the game sim getting slower — it is the suspender's 1 s rescan walk, which runs a full DFS
over ~3,300 nodes with two managed string allocations per node (`node.GetType().Name`,
`node.Name.ToString()`) per walk, every second, even when every node is already frozen. One walk ≈
4 ms; `all` runs three walks ≈ 11 ms. The 1 Hz profiler phase-locks onto that walk frame, so the
per-frame sample reads the walk cost. The honest total-CPU number is `cpu%` (above), which falls.

This is a real, memory-worthy suspender fact: **the always-on freeze rescan is not free in steady
state** — it is ~4 ms per category per second (~1.2 % of a core/seat for all three) because each
walk re-allocates a string per node to test the exemption and offscreen-extraction names. Not
blocking, but a future couch cleanup should cache the name/type probe.

## Decisions

| freeze | decision | deciding number | rationale |
| ------ | -------- | --------------- | --------- |
| **FRZ-T** (`tweenReplay`) | **SKIP** (defer) | 0 — saves no host CPU | client-only smoothness lever; the smoothness leg is not a host-cost leg, and the module is a generic client add-on that can wait. |
| **FRZ-S** (Spine clip channel) | **SKIP** (defer) | host saving **0.42 ms/frame/seat** (2.5 pp) on minimal combat | the clip channel is a large product-coupled build (spine-godot clip baking + spirectl + a client spine runtime the render-stream does not carry); a sub-ms-per-seat saving on the weakest combat does not justify it now. |
| **FRZ-DC** (Decor replay) | **SKIP** (defer) | host saving **~0 ms/frame/seat** (0 pp) | five churn nodes; the replay is product-authored motion bindings over FRZ-HOOK — not worth the couch module for zero measured saving. |
| **Particles (GPU)** | **already built** | wire-free by construction (emitter, not positions) | FRZ-P/PM6b already ship the continuation; FRZ-M confirms the host freeze costs the wire nothing, so the win is pure waste elimination. |

GPU particles stay "build now" (already done). The other three stay **defer**; FRZ-M's numbers do not
flip any of `frz-d.md`'s defer calls. If a later round re-visits them, the gate is a **real 4-seat
co-op combat** measurement (the minimal fixture under-reports the spine load ~4–8×), not a re-run of
this leg.

## What was not measured

- **A true 4-seat run under a 2-core `taskset`.** The machine's load window and the cost of launching
  4 co-op seats made the single-seat deterministic leg the deciding measurement; the 4-seat projection
  is stated, not measured.
- **g31 client sim cost.** The moto g31 (`ZY22FD8XP3`) was attached and reachable, but the GPU
  particle simulator's device cost is already covered by PM6b/G7x; the device leg was not re-run.
- **The `tweenReplay` smoothness leg** (dropped/late-frame injection). It saves no host CPU; it is
  deferred with the module.
- **MIR-3 real-seat confirmation.** The freeze is already off on the streaming seat (the fact above);
  the "opt-in + byte-identical pure stream" half is FRZ-P's `GRC_FREEZE_PARTICLES` grant, already
  proven byte-identical in `frz-p.md`. A real-seat leg belongs to the wave that actually builds
  FRZ-S/FRZ-DC.

## Hygiene

All five legs ended `survivors: none`; steam-remote, operator-profile, install binaries, install
mods and the mod build hashed unchanged on every leg; no `SlayTheSpire2`/`crashpad`/`gamescope`
process survived. Evidence (ignored, game-derived) lives under the couch research legs
`c3/legs/frzm-{none2,spines,particles,decor,all}/`; the per-leg `game.stdout.log` holds the
`[profile]` lines and the `froze N node(s)` lines quoted above.

## Evidence

- `artifacts/render-stream/p3/frz-m/analysis.txt` — the per-leg cpu%/process_ms table and deltas.
- `artifacts/render-stream/p3/frz-m/freeze-lines.txt` — the `[suspend] froze …` lines per leg.
- `artifacts/render-stream/p3/frz-m/none-vs-spines-profile.txt` — the combat `[profile]` lines for
  the `none` and `spines` legs.
