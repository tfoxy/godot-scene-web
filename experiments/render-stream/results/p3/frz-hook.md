# FRZ-HOOK: the client freeze-subtree hook (2026-10-31)

Status: **built.** FRZ-HOOK is the GSW half of the weak-host freeze work
([frz-d.md](frz-d.md) §5, §6): the shared client `frozen` hook. It lands the `frozen` flag in the
override table and rs-core's applier, so a client module can hold a subtree — keep its last
records and stop applying updates to it — with no cost to the pure stream. Base: `main` 8525f7bd.

## What it proves

- **Zero pure cost.** With no freeze set and an empty extension list, the applier's new work is
  one `frozen.is_empty()` test per apply (the table is empty, so `sync_frozen` returns early and
  nothing per item runs). The packed transport stays 12 floats *only when the table is set*; a
  clean table is never copied (TAG2's existing dirty check).
- **Hold.** Freezing a subtree skips the upserts and removals of its items (the nearest frozen
  ancestor's subtree), keeping their records (rows, lowering, attach entries). A transform change
  under a frozen root leaves the picture unchanged.
- **Retention.** The held records keep their textures and meshes resident, so the retention sweep
  (`referenced_payload_hashes`) keeps their payloads. Unfreezing marks the subtree changed and the
  next apply re-reads it from the state (a full item reconcile: re-classify every item, drop the
  records that left the state), matching the state's shot.

## The wire and API

- `@godot-scene-web/render-stream-client` (`packages/render-stream-client/src/extensions.ts`):
  `OverrideValues` gains `frozen?: boolean`; `OverrideTable` gains `freeze(id, on)`; the packed
  table widens from 11 to 12 floats per item (6 affine, 4 modulate, 1 visible, 1 frozen). The
  existing `set(id, { frozen })` also works.
- rs-core (`apply/overrides.rs`, `apply/mod.rs`, `apply/meshes.rs`): `Override.frozen`,
  `OVERRIDE_FLOATS = 12`, and the applier's hold:
  - `sync_frozen` recomputes the frozen membership (`Applier::frozen`, the set of items under a
    frozen root) once per apply, only when the table's `frozen` flags changed.
  - `apply` tests `frozen.is_empty()` once; when set, it filters the removed and upserted ids
    (a new item under a held ancestor is held from its first frame), and `frozen_resources` keeps
    the held records' textures and meshes resident through `sync_textures` / `mesh_res.sync`.
  - Unfreezing (a `frozen` flag cleared or removed) sets a reconcile flag; the next apply does a
    full item reconcile and drops the records that left the state.

## Deviation from frz-d.md §5 (one)

The sketch says "the item map needs no parent links (`state.items` has them)". That is true for a
frozen root that is still in the state, but fails the §6 check's own *removal* case: once the
frozen root is removed from the state, `state.items` no longer links its descendants, so an
ancestor walk cannot tell which removed items are held. FRZ-HOOK therefore keeps a **frozen
membership set** (`Applier::frozen`), synced while the root is still in the state and persisted
across the removal. The per-apply cost is still zero (the set is empty without a freeze), and the
semantics are exactly the sketch's.

## Checks and sabotages

rs-core unit tests (`apply/override_tests.rs`):

- `frozen_holds_records_through_change_and_removal_then_unfreeze` — freeze, change (held), remove
  (records stay), unfreeze (re-reads the state, drops the records, matches the state's shot).
- `unfreeze_reapplies_a_skipped_change` — a change skipped while frozen is re-applied on unfreeze.
- `frozen_payloads_survive_and_frozen_sweeps_drops_them` — a held subtree's texture stays resident
  after the subtree and its texture leave the state (`referenced_payload_hashes` keeps it); the
  `frozen-sweeps` sabotage drops it.
- `sabotage_frozen_still_applies_is_caught` — the `frozen-still-applies` sabotage (skip only the
  removals) applies the change, so the held shot changes.

Live gate 8 `g8tag2` legs (`run-gate8.sh`, `web/client-ext-check/page.ts` `frz`,
`lib/gate8-tag2-checks.ts`):

- `frz-holds` — the `frz` extension freezes Hand, so its step-80 move is held: `ext-frz` differs
  from `variant-base` and an override reached the core.
- `frozen-still-applies-caught` — the sabotage applies the step-80 move, so `ext-frz` no longer
  differs from `variant-base`.
- `sabotage-frozen-sweeps` runs the sabotage through the live client; its shot-observable verdict
  is the rs-core unit test (the tag-scene Hand subtree holds no payload to drop).

## Validation

Smoke tier (`validate-increment.sh --tier smoke -j 1`), local, `19/21 runs pass`:

- `cargo-rs-core` rc=0 — the rs-core suite, including the four new frozen tests and both
  sabotage catches.
- `cargo-gsw-rs` rc=0, `cargo-rs-core-capi` rc=0, `pnpm-test` rc=0 (the client package's tests and
  typecheck, including `freeze` and the 12-float pack).
- `native-rust-gate0..gate8` and `hc1` rc=0 — gate 8's `g8tag2` ran the new `ext-frz`,
  `sabotage-frozen-still-applies` and `sabotage-frozen-sweeps` legs: `frz-holds` **pass**,
  `sabotage-frozen-still-applies-caught` **pass** (`0 px differ` from `variant-base` — the move
  was applied), `sabotage-frozen-sweeps-caught` not-run (the tag-scene freeze holds no payload; its
  verdict is the unit test).
- `g7-gsw`, `g7-web-rust`, `g7live-gsw-g7-1`, `g7live-web-rust-g7-1` rc=0.
- `bench-instr` rc=3 — valgrind is not installed on this machine (the remote run is the producer).
- `native-rust-gate6` rc=1 — `motion-monotonic` frame-gap under concurrent load (another agent's
  timing leg shared the machine); a timing leg, left to the milestone sweep.

Full tier: `scripts/remote-validate.sh --tier full` (run `41216820374`, run_key
`rv-20261031T155111Z-b32945b-17571`). `19/20` runs passed remotely: `bench-instr` **pass** (with
valgrind; the pure-client instruction deltas are within noise — g3-inline +0.37 %, g4-inline
+0.31 %, g5-inline +0.53 %, g6-inline −0.89 %, g6-snap +0.91 %, g7-window2 +1.00 %), and
`native-rust-gate8` **pass** (the `frz` legs ran clean on a hosted runner). The one failure,
`g7live-gsw@g7-55`, is a hosted-runner **"no shot" flake** on the GSW shader live leg
(`live-shader step 1: no shot`), unrelated to FRZ-HOOK (its web-rust twin passed); re-run with
`--only g7live-gsw` (run `41224138393`) — **pass**, confirming the flake. The refused local-only `g7live-*-g7-1` groups passed through
`validate-increment.sh --only` (`RS_VALIDATE_GROUPS=g7-1`). The timing runs (gate 6,
`g7live-*-timing`, `g7x`) are refused remotely and left to the milestone sweep, per the brief.

The **pure-client-unchanged** numbers (host ms, wire bytes, client apply/draw µs with
`extensions: []`) are the milestone sweep's real-time A/B against the base; FRZ-HOOK adds no work
on that path (empty table → `sync_frozen` returns early, `frozen.is_empty()` once).

## Evidence

- rs-core: `experiments/render-stream/rs-core/src/apply/override_tests.rs` (the four frozen tests).
- Live: `experiments/render-stream/web/client-ext-check/page.ts` (`frz`), the `g8tag2` legs in
  `experiments/render-stream/scripts/run-gate8.sh`, judged by
  `experiments/render-stream/scripts/lib/gate8-tag2-checks.ts`.
- Smoke summary: `/tmp/frz-hook-smoke/validate-summary.json`; gate 8 `g8tag2` shots under
  `/tmp/frz-hook-smoke/native-rust-gate8/run/g8tag2/`.
