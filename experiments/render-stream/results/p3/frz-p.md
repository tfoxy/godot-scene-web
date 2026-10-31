# FRZ-P: the GPU-particle freeze (opt-in negotiation + verification)

Status: **built and verified.** FRZ-P is the render-stream half of `freezeParticles` for GPU
particles, per `frz-d.md` §2 and §6. It adds the opt-in negotiation (a `GRC_*` host grant read at
arm) and proves, with a frozen fixture and two sabotages, that a frozen GPU emitter still replays
its one-shot and looping bursts.

Base: `main` `da690556` (rebased after FRZ-HOOK landed). Nothing here modifies `sts2-couch-coop`;
the host-side freeze itself (the couch suspender's `ProcessMode.Disabled` + end-of-burst nudge) is
only *modelled* in the stock fixture, not shipped.

## What the freeze is

GPU particles are already the continuation (`render-stream-12.md`): the /12 wire sends the
**emitter, not per-frame positions** — the `particles_*` config, seed, restart/emit/emitting events,
emission transform and process material, and the client re-simulates (PM6b). So a game-side freeze
costs the render-stream **nothing on the wire**. FRZ-P's job is to (1) negotiate the freeze as an
opt-in host grant and record it in host evidence, and (2) prove a frozen emitter's bursts still
replay shot-equal.

## Decision: `GRC_FREEZE_PARTICLES`, a host grant read at arm

- **Variable:** `GRC_FREEZE_PARTICLES`, read once at arm. Empty / `off` / `0` = off (the default);
  `on` / `1` = the seat is particle-frozen; anything else refuses the capture
  (`invalid GRC_FREEZE_PARTICLES=…`).
- **Mechanism:** the grant *marks* the seat, it never changes what the capture sends. Off, it is
  byte-identical to today (no code path runs). On, it is recorded in host evidence
  (`result.json` `stream.gate8.particles.frozen: true`), so a live leg can show it was on, and it
  gates the two FRZ-P sabotages. The wire, the hello and the client are untouched.
- **Why this shape:** the freeze is a *seat* property the host already decides (the couch suspender
  freezes the emitter game-side). The render-stream only needs to observe and record it; the grant
  must not add anything to the pure stream, so it is a host-only opt-in with no wire surface.

## The two sabotages (new /12 `GRC_SABOTAGE` kinds)

Both are legal only at /12 **and** under `GRC_FREEZE_PARTICLES=on` (otherwise the capture refuses:
`… acts on a particle-frozen seat; set GRC_FREEZE_PARTICLES=on`). Both keep the hook log's true
counts and skew only the wire, the `drop-restart` pattern (`render-stream-12.md` "Sabotages").

| kind | behaviour (from `GRC_SABOTAGE_FRAME`) | caught by |
| ---- | ------------------------------------ | --------- |
| `freeze-drop-events` | the mirror drops every `particles_restart` and `particles_emit` on the wire (the `restarts`/`emits` counters and version are skewed, the emit list never gets them) | `frzp-catches-freeze-drop-events` (the frozen burst) |
| `freeze-send-positions` | the mirror appends every `ok` emitter's current emission transform (its position) as a per-frame emit, the anti-pattern the freeze forbids | `frzp-catches-freeze-send-positions` (wire byte-identity) |

## Fixture and legs

`fixtures/gate8-pt` gains a freeze mode (`RS_FIXTURE_FREEZE=1`): `A_BOX` (the looping burst) and
`D_ONESHOT` (the one-shot burst) are frozen with `ProcessMode.Disabled`, exactly as the suspender
does, and `D_ONESHOT` gets the end-of-burst nudge (`emitting = false` at
`lifetime*(2-explosiveness)+margin`, Godot's own `active_time`), so the one-shot still ends on the
wire. The restart/emit events keep firing: they are explicit calls from the root node's `_process`,
not the emitters' own processing.

One nuance the fixture models explicitly: `ProcessMode.Disabled` sends `NOTIFICATION_PAUSED`, whose
`GPUParticles2D` handler writes `particles_set_speed_scale(0)` — a *pause* side effect, not the
freeze. The freeze stops the script sim only; the browser owns the particle sim, so the fixture
restores the authored `speed_scale` (1.0) right after freezing. Without that, a frozen emitter's
`speed_scale` reaches the wire as 0 and the client's re-simulation freezes too (the first
`frzp-frozen-burst` run was dark in `A_BOX` and `D_ONESHOT` for exactly this).

New `g8pt` legs (rendered, `--fixed-fps 60`):

- `frzp/capture` — frozen seat (`GRC_FREEZE_PARTICLES=on RS_FIXTURE_FREEZE=1`).
- `frzp-grant/capture` — the grant alone, no game freeze (the wire-byte-identity witness).
- `sabotage-freeze-drop-events/capture` and `sabotage-freeze-send-positions/capture`.
- `frzp/receiver` (native) and `sabotage-freeze-drop-events/receiver` (native); g7-8's GSW half
  replays both (`lib/gate7-gsw-g8.ts` `GATE8_LEGS`), so the PM6b simulator is the receiver judged.

## Checks

| check | what |
| ----- | ---- |
| `frzp-validate` | the honest `frzp`/`frzp-grant` captures pass the TypeScript validator and `rs-core-check` |
| `frzp-freeze-evidence` | `result.json` `stream.gate8.particles.frozen` is true exactly under the grant (the `capture` leg is false) |
| `frzp-wire-byte-identical` | the grant alone (`frzp-grant`) is **byte-identical** to the freeze-off `capture` (both sinks) — the freeze never alters transaction bytes |
| `frzp-frozen-burst` | `frzp/receiver` (native and GSW) lights `A_BOX` and `D_ONESHOT` exactly as the unarmed reference at every shot, within the coverage band |
| `frzp-catches-freeze-drop-events` | the sabotage receiver's burst differs (the events are gone) |
| `frzp-catches-freeze-send-positions` | the sabotage capture's wire differs from the honest `frzp` (per-frame positions) |

The pure-client-unchanged check for host ms is a real-time bench (`bench-capture-scale.sh`,
`capture-scale`); it is left to the milestone sweep, as every timing leg is. The wire half of the
check is `frzp-wire-byte-identical` above and is deterministic, so it runs in every tier.

## Validation

Local (this worktree, `--fixed-fps 60`):

- `build-capture.sh`: 46/46 capture unit tests pass.
- `validate-increment.sh --only pure`: pass (the self-test suite, ~752 s).
- `run-gate8.sh --legs g8pt`: **PASS 47/47**, the six FRZ-P checks included (`frzp-validate`,
  `frzp-freeze-evidence`, `frzp-wire-byte-identical`, `frzp-frozen-burst`,
  `frzp-catches-freeze-drop-events`, `frzp-catches-freeze-send-positions`).
- `validate-increment.sh --tier smoke -j1`: **23/24 runs pass** (the one failure is `bench-instr`,
  refused locally because valgrind is not installed; it is remote-only and passed remotely). Every
  native gate (gate-minus1 through gate8, hc1), the cargo/pnpm/pure targets, g7-0 and g7live-g7-1
  pass.
- The pure-client-unchanged **wire** numbers: `frzp-grant/capture` (grant on, no game freeze) is
  byte-identical to `capture` (grant off) in every transaction and resource record — the recording
  is 8 438 136 B in both, differing only in the session's random ids and the end record's timing.

Remote (full tier, run `41224092722`): **22/22 runs pass**, g7-gsw and g7-web-rust included, so the
PM6b simulator and the web export replay the frozen `g8pt/frzp/receiver` and the drop-events
sabotage through `frzp-frozen-burst`/`frzp-catches-freeze-drop-events` against the reference. The
milestone sweep's host-ms pure-client-unchanged number (a real-time `capture-scale` bench) is left
to the sweep, as every timing leg is.

## Evidence

Copied into `artifacts/render-stream/p3/frz-p/`: `g8pt-result.json` (the 47/47 verdict),
`frzp-capture-result.json` (`stream.gate8.particles.frozen: true`) and `smoke-validate-summary.json`.
