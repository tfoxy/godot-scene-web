## Gate 7w result (2026-10-14)

G7w ([protocol/gate7-design.md](../../protocol/gate7-design.md) "G7w") passes: render-stream/7 is
implemented as a live-transport-only protocol-version switch on the same `rs2_codec.*`/
`rs2_diff.*`/`render-stream-2.ts`/`rs2_decoder.gd` modules /3-/6 already extended (memory:
g4e1-rs3-version-switch-pattern), plus the C++ live control parser (`rs_live.{h,cpp}`'s
`parse_control`), touching no Hub, socket or receiver-live-path behaviour -- both still speak /6
by default until G7n. [protocol/render-stream-7.md](../../protocol/render-stream-7.md) specifies the
delta as a document like render-stream-6.md.

/7 adds, on top of /6: a new magic/protocol/subprotocol string; a hello with nine new keys
(`receiver_kind`, `credit_window`, `token`, `manifest_sha256`, five presentation integers); the
top-level session key `publication` gains `credit_window` (1 or 2, always 1 on a file stream);
`error.reason` gains `unauthorized`; and HTTP gains CORS for a request carrying `Origin` (all
specified in render-stream-7.md, since they are part of /7's wire contract regardless of which
increment enacts them -- G7n for the Hub/CORS, G7q for credit-window-2 behaviour, gated on fork
F1). Records, transactions, blocks, items and commands are byte-identical to /6.

Unlike every earlier version switch, golden-7 does **not** re-derive the shared full/patch/inline
states (gate7-design.md D2: they are byte-identical to /6), so there is no full.rs7/patch.rs7/
inline.rs7. Instead it re-encodes golden-6's own `rate.rs6` scene as two small independent legs:
`rate.rs7` (credit_window 1) and `window2.rs7` (credit_window 2, a full transaction plus two
CONSECUTIVE no-op patches whose bases chain, proving window-2's wire shape without enabling
window-2 host behaviour). `invalid/` carries the three new failure modes (`bad-magic` reusing
golden-6's own `rate.rs6` bytes verbatim; `publication-window` and `publication-file-window`, both
`publication-entry`). `control/` carries hello vectors: four valid (every `receiver_kind`, both
credit windows, with and without a token) and six invalid (missing/unknown key, `credit_window` 0
and 3, a non-hex token, a `render-stream/6` protocol string).

**As built**: window2.rs7's three transactions compare against resolved-rate.json's ONE
transaction per-transaction (state only, `seq`/`frame`/`encoding` excepted as /1's rule already
is) rather than as a whole document, since gate7-design.md Q2 doesn't spell out how a
three-transaction and a one-transaction stream can "both resolve to" one file otherwise -- all
three self-tests (TypeScript, GDScript, C++) implement this same comparison, recorded explicitly
in render-stream-7.md "As built" rather than left implicit in test code. `credit_window`'s range
check follows the same wide/narrow split `target_fps`'s `1..240` bound already uses (a generic
integer-shape check, then a narrower business-rule recheck reported `publication-entry`).
`rs_live.cpp`'s hand-written control-message JSON parser gained its first `null` literal (for
`token`/`manifest_sha256`), and the existing `num()` helper was tightened to reject `null` on an
integer field (previously it would have silently decoded as `0`).

**How it was tested**:

- `protocol/golden-7/make_golden.py --check` (stdlib only): 21 outputs match, deterministic
  regeneration. `make_golden.py --check` for golden-2 through golden-6 still match unchanged.
- `build-capture.sh`: all 20 ctests pass, including the new `rs7_codec_test` (`rate.rs7`/
  `window2.rs7` byte-for-byte against `rs2_codec.cpp`'s V7 output, magic(V7)) and `rs_live_test`'s
  new `test_v7_control_parser` (golden-7/control's four valid and six invalid vectors, a hand-built
  minimal hello with null `token`/`manifest_sha256`, a bad `null` spelling refused, and
  bidirectional protocol-string rejection against the V6 parser).
- `scripts/test/self-test-rs2.ts` (TypeScript): all golden-2 through golden-7 suites green,
  including both new independent legs, the three new invalid vectors with their exact codes,
  bidirectional bad-magic checks against /6, and a new self-contained `/7` hello checker exercised
  against the same golden-7/control vectors.
- `receiver/tests/codec2_selftest.gd` (GDScript, headless): `[rs2-selftest] ok` against all six
  golden directories plus its own `/7` hello checker, same coverage as the TypeScript suite.
- `mise exec -- pnpm exec biome check` clean on every TypeScript file this increment touched.

**Rebased onto G6s (f4720922, receiver cache budgets + the live-buffer fix) and re-validated end to
end**, since G6s landed on `main` touching three files this increment also touches
(`rs2_snapshot.h`, `rs_live.{h,cpp}`, `rs2_decoder.gd`, `render-stream-2.ts`, `rs_live_test.cpp`).
The rebase (`git rebase main`) auto-merged every file except `README.md` (both increments append a
section at the end); the only conflict resolved was ordering the two sections. All codec
self-tests above were rerun clean against the rebased tree (`make_golden.py --check`: golden-6
65/65, golden-7 21/21; `build-capture.sh`: 20/20 ctests, `rs_live_test` 295/295 checks including
G6s's `test_carried_bounded` and `retain-superseded` leg alongside this increment's
`test_v7_control_parser`; `self-test-rs2.ts` and `codec2_selftest.gd` both green).

**Full gate regression on the rebased tree** (same extension/calibration, sequential; other
agents' gate runs shared the machine throughout): gate −1 **29/29**, gate 0 **24/24**, gate 1
**66/66**, gate 2 **85/85** (first attempt, no retry needed), gate 6 `--legs g6a,g6l` **54/54**
relevant checks (`group-g6h`/`group-g6b`/`group-g6s` report "did not include" by design --
`--legs` excluded them). `motion-monotonic` failed on the first two gate 6 attempts (53/57 both
times, different frames each time: `live-scene`/`live-stall` seqs held 12.9-16.6 us under the
one-frame attribution threshold) and passed clean on the third -- gate6-design.md "As built (G6l)"
2 already documents this exact failure mode ("a slow frame (one or two per run under load)") as a
property of the check's own attribution margin, not of any codec; this increment touches no live
pacing, credit or frame-timing code (`Hub::on_frame`, `creditToSend`, the receiver's per-frame
loop), and the failing instances differed between runs, which a deterministic regression would not
do. Credit RTT/staleness medians were visibly elevated on the contended runs (e.g. `live-reconnect`
34.2 ms median credit RTT on the failing run against 11.9-16.9 ms on the clean one), confirming
concurrent load, not a code path, was the variable.

**Per-transaction decode benchmark** (headless, no network; ad hoc, mirroring G6s's own
methodology): `Rs2Decoder.decode_record()` + `Stream.accept()` timed per transaction record, 400
iterations over `golden-6/inline.rs6`'s 19 transactions at version 6 (the production default, the
path every existing caller still takes), comparing this branch's `rs2_decoder.gd` against `main`'s
(f4720922) by swapping the file content in place between runs:

| Run | main mean (us) | branch mean (us) | main p50 | branch p50 |
| --- | --- | --- | --- | --- |
| 1 | 554.4 | 591.9 | 430 | 448 |
| 2 | 549.0 | 561.0 | 430 | 431 |
| 3 | 602.8 | 605.3 | 450 | 451 |

No measurable slowdown: p50 differs by at most 1 us across all three pairs, and the mean
differences (1.1-6.7%) are within the run-to-run noise visible on `main` alone (549.0 to 602.8,
9.8%) from other agents' concurrent load. The `/6` decode path only gained one more `or version ==
7` in each `is_v6`-cascading boolean (session/transaction schema, resolved invariants) -- an O(1)
comparison already on the hot path's existing branches, not a new pass over the data.

**Rebased a second time onto `main` (9388a787, G7e's web-export receiver plus the decode-profile
increment) and re-validated end to end**, since `main` gained both between the first rebase and
this one. `git rebase main` auto-merged every file except `README.md` (the same append-order
conflict as the first rebase -- resolved by ordering this section after G7e's) and
`scripts/lib/render-stream-2.ts` (the decode-profile increment refactored `validateRecording` into
an incremental `createRecordingValidator`/`RecordingValidator` pair over the same region this
increment's `version: ... | 7` touched): resolved by widening `createRecordingValidator`'s and the
`validateRecording` wrapper's version type to `2 | 3 | 4 | 5 | 6 | 7` and giving the incremental
validator the same `isV7`/`isV6` cascade every other function in the file already uses, rather than
reverting the refactor or forking a second validator. All codec self-tests were rerun clean against
the twice-rebased tree: `make_golden.py --check` (golden-2 47/47, golden-3 37/37, golden-4 51/51,
golden-5 62/62, golden-6 65/65, golden-7 21/21), `build-capture.sh` (20/20 ctests, including
`rs7_codec_test` and `rs_live_test`'s 295/295 checks), `self-test-rs2.ts` (622/622 checks),
`codec2_selftest.gd` (`[rs2-selftest] ok`), and `biome check` (clean).

G7e's web-export receiver was re-verified against the rebased decoder: `run-gate7.sh --legs g7-0
--make-sources` (a fresh native gate 0 source run plus the web export's own legs) passed in full,
including `pw1-web-equals-native` 25/25 shots identical and `compositor-equals-readback` -- proof
this increment's version widening and the incremental-validator merge changed nothing about the /6
decoding the web export still speaks exclusively.

**Full gate regression on the twice-rebased tree** (sequential; other agents' gate 7 and device
runs shared the machine throughout): gate -1 **29/29**, gate 0 **24/24**, gate 1 **66/66**, gate 2
**83/85 on the first attempt**, clean **85/85** on retry (the failures were `pins-bounded` and
`obsolete-retired` on `live-animate`, the same pins-under-load flake gate6-design.md "As built
(G6l)" 2 already documents as a property of the check's own attribution margin under concurrent
load, not of any codec -- `live-animate`'s `RS_RECEIVER_FETCH_DELAY_MS=100` makes it the most
load-sensitive g2c leg), gate 6 `--legs g6a,g6l` **54/54** relevant checks (`group-g6h`/
`group-g6b`/`group-g6s`/`group-g6c`/`group-g6z` report "did not include" by design -- `--legs`
excluded them, two more groups than the first rebase's note since G6c and G6z landed on `main`
meanwhile) -- `motion-monotonic` passed on the first attempt this time, no rerun needed.

**Rebased a third time, in three more steps onto `main` (`534095d6`, then `6db4c1ad`, then
`37929592`)**, to track G7o1 (D31/D33: `createRecordingValidator` gained a `recordDigest:
"inline"|"deferred"` option, `digestPending()`/`digest()`/`checkRecordDigestComplete()`, deferring
the GSW bench's whole-record SHA-256 off the frame path) and G7m's web-export bench arm. The
`534095d6` step conflicted on `scripts/lib/render-stream-2.ts`'s `decodeRecord` and
`createRecordingValidator` signatures (both increments added a parameter in the same spot --
G7o1's `opts?: DecodeRecordOptions`, this increment's `version: ... | 7`); resolved by keeping
both, widening `version` to include 7 on every signature G7o1 touched and leaving the digest
machinery itself untouched, since `decodeRecord`'s digest branch
(`opts?.recordDigest === "deferred" ? "" : hashBytes(...)`) never inspects `version` -- deferred
digest was already version-agnostic by construction. Verified directly (golden-7's `rate.rs7` and
`window2.rs7` through `createRecordingValidator(records, 7, { recordDigest: "deferred" })`): every
accepted /7 record's deferred `digest(i)` equals its inline digest, and `digestPending()`/
`checkRecordDigestComplete()` transition correctly before and after every `digest()` call --
`self-test-record-digest.ts` itself needs real G7x bench recordings (`--inputs`, not committed)
that were not available in this rebase, so this ad hoc check stood in for it; the committed
self-test is unmodified and still exercises only its existing /2-/6 scope. `6db4c1ad` (G7m's
web-export bench arm: `gate7-bench.ts`, `run-gate7.sh`, no codec files) and `37929592`
(docs-only) both rebased with zero conflicts. Reran clean on the final, thrice-rebased tree:
`self-test-rs2.ts` 622/622, `self-test-browser-decoder.ts` (all sections; golden-2..6 unchanged
by this increment), `make_golden.py --check` (golden-2..7 all match), `biome check` clean on both
touched TypeScript files, and `run-gate7.sh --legs g7-0 --make-sources` full PASS (including
`pw1-web-equals-native` 25/25) against every one of the three rebased tips.

### What G7w does not prove

- That the capture or receiver speak /7 at all, or that any hello is ever acted on: the Hub's
  bearer check, `GRC_LIVE_CREDIT_WINDOW_MAX`, the `Origin` allowlist and CORS headers do not exist
  on the wire this capture serves yet (G7n's job -- `rs_live.cpp`'s parser change here is parsing
  only, with no `ConnectionSummary` field and no behaviour change for any existing version).
- Credit window 2's actual in-flight accounting, pinning over two bases, or resync-of-the-earlier-
  seq semantics: `window2.rs7` proves only that the wire CAN carry `credit_window: 2` and two
  chained patches, never that a host produces them (fork F1, G7q, pending the user's decision).
- Anything about the web export or GSW canvas receivers, browser harness, CORS enforcement, or
  pacing/lifecycle/startup/memory: all later increments in gate7-design.md's wave graph.

