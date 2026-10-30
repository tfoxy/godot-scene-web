# PH3: credit latency on the phone (2026-10-30)

PH2 ([ph2.md](ph2.md)) left the moto g31 at 45.4 "distinct applies/s" on PHN's leg 1 (capture-scale `/12`,
credit window 2, W11t `zstd-base`), with the main thread 27% idle. The rate was bound by the credit round
trip: at window 2 the host sends at its frame rate only while each credit returns within two host frames
(33.3 ms), and 22% did not.

PH2 named three levers. PH3 measures each on the g31, and their combinations, and makes the winner the
client package's default:

- **(a) credit window 3**;
- **(b) crediting at `applied`** instead of `submitted`;
- **(c) applying in `onmessage`** instead of the next rAF callback. The draw stays on rAF.

**Headline.**

- **The bar is met.** With (b) + (c), the package's new default, the g31 applies **60.0 transactions/s**
  over the 180 s window of PHN's leg 1 (host tap, main window, every apply a distinct instant). Before:
  38.9 distinct apply instants/s, 48.1 transactions/s.
  - The credit RTT falls from 27.0 / 41.7 ms (p50 / p95) to 15.5 / 19.2 ms. 0.4% of RTTs exceed
    33.3 ms, against 22%.
  - The frame p95 holds at 17.2 ms.
  - The remount checks pass, at 59.6–59.9/s per remount.
- **Latency falls too.** Send → `applied` drops from 24.1 / 39.0 ms to 15.5 / 19.2 ms. Send → drawn
  (`submitted`) drops from 26.9 / 41.7 ms to 21.6 / 35.3 ms. Neither lever adds a frame. Window 3 would
  add a frame whenever the client falls behind.
- **Window 3 alone falls short, and it needs a protocol change.** It reaches 53.1 distinct applies/s.
  It also needs a host change and a new hello grammar. With (b) + (c) it adds 1.0 transaction/s
  (60.0 against 59.0, both legs at the host's frame rate). PH3 does not land it.
- **PH2's number was overstated.** The host tap counts a credit-window fold only when the folded
  `applied` acks share the receiver's `t_us`. The client stamped each ack separately, at a 100 µs
  clock, so most folds read as distinct applies. Clustered by gap, PH2's baseline is **38.9** distinct
  apply instants/s, not 48.1 (tap, main window) or 45.4 (tap, whole connection). The client now stamps
  one apply's acks, and one draw's acks, with one time. The tap's own rule then holds.
- **New frames shown per second stay at ~53.** The draws that show a new state are 53.3/s (rAF
  57.7/s). Arrivals jitter against a 58.8 Hz panel, so about 8% of vsync intervals get no new
  transaction, and as many get two. Reaching 58 *shown* frames/s is a pacing problem, not a rate
  problem; see "What is left".

## The A/B (g31, PHN's leg 1, real time)

Every leg ran PHN's leg 1 through PH2's wrapper (`tools/ph3-leg.sh`). Each held the bench's exclusive
quiet lock, with the machine at a 1-minute load under 4 at start. The phone was on USB at 100% battery,
thermal status `none` before and after every leg. Each leg ran 180 s of mount 1, then the three
attribution windows; F also ran PHN's three remounts. B0–ABC ran on this tree at 7b8da217 with the
pacing options passed explicitly. F and F13 ran the final tree with no options (the new defaults).

- **B0:** the old defaults (`submitted`, apply on frame); PH2's L3 configuration.
- **B:** credit at `applied`.
- **C:** apply on message.
- **BC:** both.
- **A:** window 3 (experimental host and core, `window3-experiment.diff`), `submitted`, apply on frame.
- **ABC:** window 3, `applied`, apply on message.
- **F:** the landed defaults (BC plus the undrawn cap and the shared ack stamps), with remounts.

The main window is mount 1 from its first frame + 2 s, 176 s long, from the host's tap
(`bench-live-scale.py tap --frames`). The whole-connection figure is the bench's own (PH2's headline).
It includes the ~13 s join and the attribution windows, so it cannot exceed ~56.7/s at a 13 s join.

"Distinct apply instants" and "draws with a new state" cluster the tap's `applied` and `submitted`
acks by receiver time (a gap over 3 ms starts a new instant). The tap's own fold rule is in the bullet
above.

| | B0 | B | C | BC | A (w3) | ABC (w3) | **F (final)** |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| distinct apply instants/s (bar ≥ 58) | 38.9 | 42.4 | 52.2 | 59.0 | 53.1 | 60.0 | **60.0** |
| transactions applied/s, tap, main window | 48.1 | 51.5 | 52.2 | 59.0 | 59.8 | 60.0 | 60.0 |
| host fps (main window) | 59.8 | 60.0 | 60.0 | 59.4 | 60.0 | 60.0 | 60.0 |
| tap applies/s, whole connection | 45.8 | 49.3 | 49.5 | 56.1 | 56.5 | 56.8 | 56.6 |
| draws with a new state /s | 38.9 | 42.4 | 44.5 | 52.9 | 53.1 | 52.7 | 53.3 |
| credit stage | submitted | applied | submitted | applied | submitted | applied | applied |
| credit RTT p50 / p95 (ms) | 26.9 / 41.7 | 23.1 / 37.5 | 23.1 / 36.0 | 14.8 / 19.1 | 24.5 / 38.6 | 15.0 / 18.9 | 15.4 / 19.9 |
| RTTs over 33.3 ms | 22.2% | 13.0% | 11.6% | 0.7% | 12.2% | 0.2% | 0.4% |
| send → `received` p50 / p95 | 14.7 / 22.0 | 13.8 / 20.9 | 13.1 / 20.2 | 11.4 / 16.7 | 12.5 / 18.6 | 11.7 / 16.1 | 12.0 / 17.1 |
| `received` → `applied` p50 / p95 | 8.8 / 22.7 | 8.7 / 22.2 | 3.7 / 7.4 | 3.3 / 5.6 | 8.6 / 19.8 | 3.3 / 5.3 | 3.4 / 6.0 |
| `applied` → `submitted` p50 / p95 | 2.6 / 5.8 | 2.6 / 5.7 | 4.7 / 19.4 | 5.8 / 18.6 | 2.5 / 6.4 | 5.9 / 19.9 | 5.7 / 19.4 |
| latency send → `applied` p50 / p95 | 24.1 / 39.0 | 23.3 / 38.1 | 16.4 / 26.4 | 14.8 / 19.1 | 22.3 / 35.1 | 15.2 / 18.9 | 15.5 / 19.2 |
| latency send → drawn (`submitted`) p50 / p95 | 26.9 / 41.7 | 25.9 / 40.3 | 23.1 / 36.0 | 21.0 / 34.4 | 24.5 / 38.6 | 21.5 / 35.0 | 21.6 / 35.3 |
| rAF/s; frame interval p50 / p95 / p99 | 56.8; 17 / 17.2 / 34.1 | 56.9; 17 / 17.2 / 34.1 | 56.9; 17 / 17.2 / 34 | 57.6; 17 / 17.2 / 34 | 58.1; 17 / 17.1 / 33.9 | 57.7; 17 / 17.2 / 34 | 57.7; 17 / 17.2 / 34 |
| frames over 1.5 Tp in 180 s | 347 | 337 | 330 | 208 | 113 | 199 | 191 |
| rAF callback p50 / p95 (busy ms/s) | 6.6 / 11.0 (310) | 6.6 / 10.6 (323) | 2.5 / 3.4 (122) | 2.5 / 3.4 (138) | 6.5 / 8.7 (360) | 2.4 / 3.2 (134) | 2.6 / 3.3 (141) |
| `onmessage` p50 / p95 (busy ms/s) | 5.2 / 11.0 (292) | 5.0 / 10.5 (291) | 8.8 / 16.9 (506) | 8.6 / 10.2 (511) | 4.7 / 6.0 (288) | 8.6 / 10.1 (515) | 8.7 / 10.2 (523) |
| idle in the CPU profile | 28.3% | 26.9% | 25.5% | 22.9% | 23.2% | 25.2% | 23.1% |
| A75 mean clock (12 samples) | 1.50 GHz | 1.60 | 1.72 | 1.75 | 1.72 | 1.70 | 1.69 |
| battery temperature | 27.3 → 28.2 °C | 29.2 → 30.0 | 28.9 → 30.1 | 28.2 → 29.6 | 28.9 → 30.2 | 28.9 → 30.2 | 29.3 → 30.8 |
| machine load (1 min) at driver start / end | 3.16 / 0.77 | 1.66 / 1.42 | 1.28 / 0.66 | 1.12 / 1.01 | 1.87 / 0.75 | 2.14 / 2.17 | 1.59 / 0.54 |

B0 reproduces PH2's L3: tap 45.8/s against 45.4, RTT 26.9 / 41.7 against 27.1 / 42.0, idle 28% against 27%.

**F's driver checks.** All five gating checks pass, and `rate-60` passes too (mount 1: 60/s).

- Remounts 2–4 apply at 59.9, 59.6 and 59.8/s.
- The page renderer's PSS goes from 440.7 → 57.1 MiB at the first dispose. After the remounts' disposes
  it is 60.9, 61.5 and 61.5 MiB.
- Every mount starts at a 1.25 MiB heap.
- First frame after `mount()`: 12.9 s, then 8.2–10.5 s for the remounts.

The bench's `update-rate` and `credit-rtt` checks pass on every leg.

F13 (/13): see "At /13" below.

### Reading the levers

- **(b) alone** saves the draw: `applied` → `submitted` is 2.6 ms at p50. It does not touch the vsync
  wait, which is in `received` → `applied` (8.7 / 22.2 ms).
- **(c) alone** moves the apply into `onmessage`. `received` → `applied` falls to 3.7 / 7.4 ms, but the
  credit still waits for the draw at the next vsync: `applied` → `submitted` rises to 4.7 / 19.4 ms.
- **(b) + (c)** take the vsync out of the round trip. What is left is the transport, the zstd decode
  and the accept, plus the apply (11.4 + 3.3 ms at p50). The p95 is 19 ms, well inside two host frames.
- **(a) alone** keeps the vsync in the RTT, but gives it 50 ms. The host then sends every frame (59.8/s)
  and the client folds, applying 53.1 distinct states/s. Its p95 latency stays at B0's level, and every
  queued transaction in it waits a frame.
- **Draws are cheaper with apply on message.** The rAF callback falls from 6.6 to 2.5 ms at p50. Frames
  over 1.5 Tp fall from 347 to ~200 in 180 s. The work moves to `onmessage` (busy 290 → 520 ms/s), which
  now does one apply per transaction instead of one per frame callback. The main thread stays 23% idle.

## The decision: credit at `applied`, apply on message (the package's default)

The call is mine, as delegated. Reasons:

1. **It meets the bar, and so does nothing else short of a protocol change.**
   - B and C alone reach 42–52 distinct applies/s.
   - Window 3 alone reaches 53.1.
   - Only (b) + (c), with or without window 3, reaches 58: 59.0 / 60.0 / 60.0.
2. **It is pure client.**
   - No host work and no wire bytes per frame change for any client.
   - `credit_stage: "applied"` has been in every hello grammar since `/1`. The hub's credit is per
     connection, so shared encodes across viewers (P3-SP) are untouched.
   - Neither the protocol nor the host changes, so no version-gated protocol note is due.
   - The semantics change is the client's own; `mirror-client-design.md` "The loop" records it.
3. **It lowers latency.** Window 3 raises it (one queued frame whenever the client trails). (b) + (c)
   cut send → applied by 9 ms at p50 and 20 ms at p95.
4. **Window 3 adds 1.0 transaction/s over BC**, by two different host runs (BC's host ran at 59.4 fps).
   F, BC's configuration, applied 60.0/s at a 60.0 fps host. That is not worth a protocol version, a
   host change and a pinned snapshot per connection.

### What the defaults now do (`packages/render-stream-client/src/loop.ts`)

- **The hello asks `credit_stage: "applied"`** (`DEFAULT_CREDIT_STAGE`).
- **`applyOn: "message"`** (`DEFAULT_APPLY_ON`). A transaction is applied in its own `onmessage` and
  acked `applied` there, when four things hold:
  - frame callbacks run: one within `MESSAGE_APPLY_MAX_FRAME_GAP_MS` (100 ms);
  - nothing waits ahead of it: no pending fetch, no queued transaction;
  - no rebuild is due;
  - fewer than `MESSAGE_APPLY_MAX_UNDRAWN` (2) applies wait for a draw.

  One that needs payloads starts its fetches in `onmessage` and applies at the frame callback that
  finds them in. Otherwise the MIR-1 path runs: queue, apply in the next frame callback.
- **The draw stays on rAF.** A frame callback with any apply since its last draw draws the newest
  applied state once, and acks `submitted` for each of those applies.
- **The two gates keep `submitted`'s pacing where it matters.**
  - *Hidden page:* no frame callback runs. After 100 ms, arrivals queue, no `applied` ack returns, and
    the hub stops publishing (G7u). At most a window's worth is applied in those 100 ms.
  - *Draws that fall behind:* a slow GPU or a busy thread. The client applies at most two
    transactions per draw, then waits for the frame callback again, so it never does far more apply
    work than it shows. Two absorbs a 60 fps host against the g31's 58.8 Hz panel.
- **A context loss holds applies.** The restore's redraw acks `submitted` for every apply that waited
  for a draw.
- **One time per batch.** The acks of one apply (a fold) share one `t_us`, and so do the acks of one
  draw.
- **Options.** `creditStage: "submitted"` and `applyOn: "frame"` keep the MIR-1 loop. Both are
  `RenderStreamClientOptions` fields, and their types `CreditStage` and `ApplyOn` are exported.
  `stats().creditRttMsP50` now measures from the credit-stage ack.
- **Couch-coop needs no change.** `RenderStreamStage.vue` passes only `creditWindow: 2`, and the seat's
  host environment is untouched.

## Correctness: several applies before one draw

With apply on message, one executor consumption can follow several applies. The draw list was built
for that: dirty ranges are a union, kept until `consumed()` (`apply/mod.rs`: "Pending ranges of an
unconsumed list are kept"), and texture operations queue in order.

PH3 proves it with a new differential, `rs-core-check draw-skip-diff <recording>... --store <dir>
[--every N] [--sabotage ph3-drop-pending]`.

- **Two appliers.** Both run in the client's configuration (`DigestPolicy::Never`), each with a CPU
  mirror of the GL executor's upload contract (`GpuMirror`).
  - The mirror's arrays take everything on `dirty.all`, on the first upload, or when an array outgrows
    its capacity. Otherwise they take the dirty ranges, clamped.
  - Bindings take every slot on `dirty.all` or when the slot count changes.
  - Texture operations run in order, and each texture's bytes are hashed.
- **Two cadences.** The oracle draws after every apply. The other side draws after a pseudo-random run
  of 1..=N applies.
- **The checks at each of its draws:**
  - its mirror equals its own list;
  - its list's arrays, draw table, screen operations and instanced draws equal the oracle's. Each
    draw is compared with the binding it names, because binding slots are numbered in each applier's
    own hash order: two appliers that both draw every apply differ in slot numbers in 1 of 3 runs;
  - its texture set equals the oracle's.

| recording | transactions | runs of 1..=1 / 2 / 3 / 5 | sabotage `ph3-drop-pending` (runs of 1..=3) |
| --- | ---: | --- | --- |
| `pm7-a12-1` (/12) | 4,955 | 0 / 0 / 0 / 0 mismatching (1,634–1,653 draws after several applies) | **1,749 mismatching** (items, textures, vertices) |
| `pm-a11-1` (/11) | 4,947 | 0 / 0 / 0 / 0 | **2,475 mismatching** (bindings, items, textures, vertices) |
| `late-1` (/8, late join) | 1,784 | 0 / 0 / 0 / 0 | **604 mismatching** (items, textures) |

The sabotage drops the pending dirty ranges and texture operations of an apply that is not drawn,
which is what a list cleared at every apply would do.

On the desktop, `client-live-check.ts` with `--credit-stage applied --apply-on message` passed every
check, including mount 1's mid-stream WebGL context loss and restore:

- 342 applied at the loss, 914 at mount 1's end;
- 58.7 applies/s over the steady window at a 2.8 ms RTT.

The loop's unit tests (`test/loop.test.ts`, 52 in the package) cover:
- the defaults;
- the message path, with the draw on the next frame;
- the hidden-page gap;
- a fetch started in `onmessage`;
- a context loss with undrawn applies;
- the undrawn cap;
- the shared ack stamps.

## The fold count trap

`bench-live-scale.py`'s rule ("`applied` acks sharing the receiver's t_us were applied together") is
right only when a receiver stamps a fold's acks with one time.

- **The harness receiver does** (`live.ts` passes `t`). MIR-1's client called `now()` per ack.
- **Most folds read as distinct.** At a 100 µs clock (no cross-origin isolation) most consecutive acks
  differ.
- **B0's evidence.** The tap counted 17 folds. The gaps between `applied` acks put 1,477 of 7,699 under
  2 ms: 19% of transactions were applied in the same callback as the one before. So PH2's "45.4" is
  ~38–39 distinct states a second, measured the same way as the 60.0 above.

The client now passes one time per apply and per draw. F's tap and its clustered count agree (60.0 /
60.0, 0 folds).

## At /13

F13 is F's tree against a `/13` host. The bench runs at `--protocol 12` with `GRC_STREAM_VERSION=13`,
and the driver at `--protocol 13`, as in PH2's L13.

F13 also carries the shared ack stamps. F's page bundle was built just before that change, and with
apply on message F has no folds anyway.

| | F (/12) | F13 (/13) |
| --- | ---: | ---: |
| distinct apply instants/s; tap, main window (folds) | 60.0; 60.0 (0) | 60.0; 60.0 (0) |
| tap applies/s, whole connection (folds) | 56.6 (0) | 56.7 (2) |
| draws with a new state /s; rAF/s | 53.3; 57.7 | 53.2; 57.8 |
| credit RTT p50 / p95 (`applied`) | 15.4 / 19.9 | 15.2 / 18.8 |
| latency send → drawn p50 / p95 | 21.6 / 35.3 | 20.8 / 34.5 |
| frame interval p50 / p95; over 1.5 Tp | 17 / 17.2; 191 | 17 / 17.1; 179 |
| `onmessage` p50 / p95 (busy ms/s); rAF callback p50 (busy) | 8.7 / 10.2 (523); 2.6 (141) | 8.9 / 10.4 (536); 2.5 (141) |
| idle in the CPU profile; A75 mean clock | 23.1%; 1.69 GHz | 21.8%; 1.62 GHz |
| remounts 2–4 applies/s | 59.9, 59.6, 59.8 | 59.1, 59.8, 59.8 |
| wire, page side | — | 231 KB/s |
| battery temperature; thermal | 29.3 → 30.8 °C; none | 29.5 → 30.7 °C; none |

As in PH2, `/13` halves the wire and does not move the rate: the phone is not bound by bytes.

## What is left: shown frames, not applies

The client now applies every transaction the host sends (60/s), but shows a new state at 53.3 of its
57.7 frame callbacks a second.

- **Arrival jitter.** Arrivals jitter against the vsync: send → `received` is 12.0 / 17.1 ms at
  p50 / p95. So ~8% of vsync intervals get two transactions (the older one is applied, never drawn),
  and as many get none.
- **The lever for shown frames is pacing, not throughput.** It is a one-frame playout buffer: draw at
  most one new transaction per vsync, the oldest undrawn, and keep the rest for the next. Like video
  playback, it trades one frame of latency (~17 ms) for evenly spaced frames.
- **It caps the bar metric.** Such a buffer applies ~57.7/s at this panel, so the applies/s bar as
  written (≥ 58) and "a new frame every vsync" pull in different directions on a 58.8 Hz panel. That
  is a product call, not made here.
- **The frame callbacks are near the panel already.** About 1.1 frames/s run late (191 over 1.5 Tp in
  180 s); rAF is 57.7/s against 58.8.

## Validation

`validate-increment.sh --plan` reaches everything, with the sabotage legs. `rs-core-check.rs` is in
rs-core, and its new subcommand names a sabotage.

- **Package.**
  - `packages/render-stream-client`: 52 tests pass (44 before, plus 8 PH3 loop tests).
  - `pnpm typecheck` and `pnpm typecheck:ts6` are clean.
  - Biome is clean on the changed package and page files.
  - `rustfmt` is clean on the new code. The file's 7 older hunks are untouched.
- **The differential.** `draw-skip-diff` and its sabotage: see "Correctness".
- **Local smoke tier.** These passed:
  - the pure self-tests, the three crates and `pnpm-test`;
  - native gates −1, 0, 1, 2, 3, 4, 5 and 5.5, with sabotage legs.

  `bench-instr` exits 3 locally (no valgrind). The smoke was stopped at gate 8 once the remote full
  tier had passed every run it covers; the remaining runs are all in that tier.
- **Full tier, once, remotely** (`rv-20261030T075242Z-1f3827b-14464`, run 41022785482, base 7b8da217):
  **20 of 20 runs pass.**
  - every native gate with its sabotage legs;
  - g7-gsw and g7-web-rust in every group;
  - the remote-capable live groups;
  - `bench-instr`, within its 1% threshold on every case (−0.91% to +0.76% Ir).
- **Refused groups, locally at the full tier** (`RS_VALIDATE_GROUPS=g7-1 … --only
  g7live-gsw,g7live-web-rust`): both pass.
- **Timing runs** (native gate 6, the live timing runs, g7x) are deferred to the milestone sweep. The
  phone legs above are this increment's timing evidence. The harness receiver's loop is unchanged; it
  shares only `hello.ts` with the client, and `clientHello`'s default is unchanged.

## Deviations

- **Window 3 was measured, not landed.** It ran on an experimental host and core: the hello and session
  grammars allow 1..3, `kHostCreditWindow` is 3, and `GRC_LIVE_CREDIT_WINDOW_MAX` goes up to 3. That
  is `window3-experiment.diff` in the evidence, run from a separate worktree. Landing it would need a
  `/14` hello grammar.
- **The bar metric.** The bar is checked on the host tap's applies over mount 1's measured window, and
  on clustered distinct instants. PH2's whole-connection figure includes the ~13 s join, which caps it
  near 56.7/s at any rate. F's whole-connection figure is 56.6.
- **A–ABC ran without remounts** (as PH2's L0), to keep each A/B leg short. F ran them.

## Evidence

`artifacts/render-stream/p3/ph3/` (main checkout):

- `B0/`, `B/`, `C/`, `BC/`, `A/`, `ABC/`, `F/` and `F13/`, each with:
  - `client-device.json`, `cpu-profile.json`, `bench-live-scale.json`, `result.json`, `launcher.out`
    and `scale-report.json`;
  - the host tap (`live-1.jsonl.gz`);
  - `sum.json`, the row above;
- `draw-skip-diff.txt`: the differential and its sabotage;
- `desktop-BC/`: the desktop client check;
- `window3-experiment.diff`;
- `tools/`:
  - `ph3-leg.sh`, the leg wrapper;
  - `ph3-sum.py`, the table: tap main window, clustered instants, RTT split, page probes;
  - PH2's `ph2-rtt.py`, `ph2-self.py` and `ph2-under.py`.

## Memory-worthy facts

- **The host tap's fold count needs one `t_us` per fold.** A receiver that stamps each ack separately
  at a 100 µs clock makes most folds look like distinct applies. MIR-1's client did, so PH2's "45.4
  distinct applies/s" was ~39. Cluster acks by gap (3 ms) to check any receiver.
- **On the g31, credit at `applied` plus apply in `onmessage` takes the vsync wait (0–17 ms) out of the
  credit RTT.** Either alone does not: (b) alone saves only the 2.6 ms draw, and (c) alone moves the
  wait to `applied` → `submitted`.
- **Applying in `onmessage` makes the rAF callback cheap** (6.6 → 2.5 ms p50) and halves late frames,
  even though `onmessage` work rises.
- **Shown new frames/s is bounded by arrival jitter against vsync** (~53 of 57.7 at the g31), not by
  rate. Only a playout buffer (+1 frame of latency) raises it.
- **Two appliers number binding slots in their own hash order.** Compare draw tables through the
  binding each draw names, never by slot.
