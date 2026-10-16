## G6s live-buffer fix (2026-10-14)

Finding 5 above is fixed. `receiver.gd`'s live-mode `_receive_binary` grew `_data` by one
WebSocket message forever because `RsApplier.accept_record(_data, offset, _stream)` resolves
each record by an offset local to `_data` -- but every message after the first is already exactly
one whole record (the function's own framing check enforces this), so nothing in `_data` is ever
needed again once that record is accepted. `_data` is now reset to an empty `PackedByteArray`
right after each message is processed (and after the session record specifically, which is the
whole of the first message); the next message's `offset := _data.size()` is simply 0 from then
on. Memory is bounded by the largest single in-flight record, not by total bytes ever received.

Two fields used to read the running totals straight off `_data`, which no longer holds them:
`received_bytes` is now a running counter (`_data_received_bytes`, incremented alongside the
append, before the reset) and `received_sha256` is read back once, at connection end or
reconnect, from `_received_path` -- `_data`'s exact byte-for-byte mirror on disk, since every
message is `store_buffer()`+`flush()`ed as it arrives. A standalone check (`sha256_hex` over the
430 MB `g6s-final/soak-scene` recording read back from disk) reproduced that original run's
recorded `received_sha256` exactly, confirming the switch changes nothing about what is reported.

**Benchmark (headless, no network; `scripts/README` lacked a prior live-path bench, so this one is
ad hoc): real per-message byte-length distribution** framed out of the parked `g6s-final/
soak-scene/receiver/received.rs2` (22 013 messages, mean 4544 B, max 94 791 B) **replayed through
synthetic buffers of those exact sizes**, timing exactly what changed in the hot path:

| Variant | mean | p50 | p95 | p99 | max |
| --- | --- | --- | --- | --- | --- |
| main (02e6f4dc): `_data.append_array(message)` into the one ever-growing buffer | 18.2 us | 18 us | 21 us | 33 us | 1094 us |
| this branch: `_data.append_array(message)` into a buffer reset to empty every message, plus the counter | 10.1 us | 10 us | 14 us | 23 us | 149 us |

No slowdown -- the branch is faster (appending into a buffer that never grows past one message
beats appending into one that grows to the whole stream). Neither shows O(n^2) growth over the
run (first-10%-mean/last-10%-mean ratios 0.81x and 0.71x). An earlier attempt hashed every message
incrementally with a `HashingContext` instead of reading `received_sha256` back from disk once;
that measured **+36 us/message** on the same distribution (mean 54.9 us against main's 18.2 us) --
a real, measurable slowdown given G55d's precedent (a +150 us/transaction receiver cost alone
phase-locked the 60 Hz credit loop, `rs-g55d-rs5-switch-facts`) -- and was discarded for the
file-read-back approach actually shipped. The one-time read-back itself (not in the hot path):
~252 ms to read the 430 MB file plus ~1.28 s to hash it, paid once per connection at its end, not
per message.

**Full regression on the fixed tree**, same extension/calibration, sequential (no gate run
overlapped another in this worktree): gate −1 29/29, gate 0 24/24, gate 1 66/66, gate 2 85/85
(85/85 on retry; the first attempt hit the documented `live-animate` pins-under-load flake while
another agent's gate 6 legs ran concurrently on the same machine -- `rs-g55d-rs5-switch-facts`),
gate 5 (`g5b,g5c,g5d,g5e,g5f,g5g`) 116/116, gate 5.5 (`g55b,g55c,g55d,g55e,g55f`) 130/130, gate 6
(`g6a,g6h,g6l,g6b,g6s`) **109/109, including all four `g6s-rss-bounded-*` checks, now passing**.
g6l's `motion-monotonic` (the canary for exactly this kind of per-transaction slowdown) passed on
the first run, no rerun needed.

**RSS, per g6s leg, after the fix** (same median-of-last-30s minus median-of-first-30s window as
the original measurement; budget 16 MiB / 2 MiB per min): `soak-scene` +28 672 B, `soak-inline`
+8192 B, `sabotage-soak-no-evict` +36 864 B, `sabotage-soak-retain-superseded` +4096 B -- all four
near-flat, against the pre-fix 305.9 / 304.7 / 305.9 / 305.9 MiB. Host RSS stayed flat on every
leg, as before. `cache-budget-respected`, `residency-bounded` (including both sabotages still
failing exactly their predicted metric) and `soak-pixels` (0 mismatched pixels) all still pass,
unchanged by this fix.

Evidence: `artifacts/render-stream/gate-minus1/20261014T205802Z/`,
`artifacts/render-stream/gate0/20261014T205949Z/`, `artifacts/render-stream/gate1/
20261014T210436Z/`, `artifacts/render-stream/gate2/20261014T214216Z/` (the passing retry),
`artifacts/render-stream/gate5/20261014T220311Z/`, `artifacts/render-stream/gate55/
20261014T223109Z/`, `artifacts/render-stream/gate6/20261014T225650Z/`.

