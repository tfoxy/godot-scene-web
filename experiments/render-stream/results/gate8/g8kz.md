# G8kz: HTTP content coding for payload GETs

Increment G8kz of [texture-delivery-design.md](../../protocol/texture-delivery-design.md) (D2, Q5;
"As built (G8kz)" there records the decisions). Spec: `render-stream-2.md` "HTTP (live)" >
"Content coding (G8kz)". Evidence: `artifacts/render-stream/gate8/g8kz/` (ignored).

## What it proves

A host negotiates `Accept-Encoding` into `Content-Encoding` zstd or gzip per request, with
`Vary: Accept-Encoding`, per-coding ETags and the coded `Content-Length`, compressing once per hash
on the HTTP I/O thread and logging the coded bytes per GET. The content hash stays the identity
hash and every receiver (native decode, Chromium's transparent decode in GSW and the web export)
verifies it after decoding. A coded body with a byte flipped is refused by all three. Default:
`GRC_HTTP_ENCODING=zstd` (opt-out `off`; native receiver opt-out
`RS_RECEIVER_ACCEPT_ENCODING=off`), because the coding is negotiated and a client that sends no
`Accept-Encoding` gets today's bytes.

## Bytes before and after

| scene | identity | zstd 3 | gzip 6 |
| ----- | -------- | ------ | ------ |
| gate 6 `animate`, live, headless native receiver, 128 GETs (host `live-summary.json`) | 1,525,360 B | 70,380 B (21.7x) | 73,498 B (20.8x) |
| `gate8-tex`, offline over the host's 14 stored payloads (zstd/gzip CLIs at the host's levels) | 224,191 B | 118,273 B (1.9x) | 105,828 B (2.1x) |

Compression cost on the I/O thread for the gate 6 scene: 35 bodies, 1,479,511 B in, 4.4 ms (zstd)
and 10.6 ms (gzip) in total (`coded_ns`). Both receivers matched the host: wire 70,380 B, identity
1,525,360 B, every fetch verified.

## What ran

- Setup/native/g7 (remote, `scripts/remote-validate.sh --tier full`, run 39987705685): 20 of 21 runs
  pass: pure (6 shards, including `self-test-gate2` with the new legs and 8 new scenarios),
  capture-build (25 ctests, with new `rs_ws` negotiation/coding/sabotage and `rs_live` coded-body
  tests), cargo (rs-core, capi, decode-proto), pnpm-test, bench-instr, native-rust gates -1, 0, 1, 2,
  3, 4, 5, 55, 8, and g7-gsw, g7-web-rust (file groups g7-0..g7-6). The one failure is the known
  `cargo-gsw-rs` rc 101.
- Local half (live correctness, fast frames):
  - `g7live-gsw` g7-1, g7-2, g7-5, g7-55 in full: 116 PASS, 0 FAIL, `gate_passed=true` (the new
    `coding-gzip`, `coding-off`, `sabotage-corrupt-coded-body` legs and `http-content-coding`,
    `corrupt-coded-body` checks under Chromium via GSW).
  - `g7live-web-rust` g7-1, g7-2, g7-5, g7-55 in full: 119 PASS, 1 FAIL
    (`leg-class-sabotage-wrong-hash-live@web`: failure at seq 621, expected 620, the known g7-2
    web fold flake class); rerun once, g7-2 alone: 41 PASS, `gate_passed=true`.
  - `native-rust-gate2`, full tier including the `g2c-pins` timing group (fast frames): PASS 91/91.
- Native g2e during development (all 16 checks, rust core): coding-gzip, coding-off,
  coding-receiver-off success; sabotage-corrupt-coded-body `resource-hash-mismatch` at seq 1.
- Real time, one run: gsw `g7-r` at window 2 (load average 2.0 to 2.4 at launch): `gate_passed=true`,
  host 60.00/s, published 59.58/s (r1) and 59.84/s (r2), receiver frame 60.00/s, credit RTT mean
  1.02 to 1.05 frames. The rate is unharmed. Evidence: `artifacts/render-stream/gate8/g8kz/gsw-g7-r/`.
- Browser facts from the runs: Chrome 148 sends `zstd` and gets zstd; `Content-Length` in fetch is
  the coded length (195 B for a 1,135 B payload) while the body arrives decoded; GSW refuses the
  corrupted body as `resource-hash-mismatch`.

## Out of scope and why

- The pre-release delta sweep owns the timing phase: native gate 6, `g7live-*-timing`
  (g7-6, g7-lc, g7-r on web and native, g7-k), `g7x`, and the rest of the g1c-rate/g1d/g5f/g55f
  timing groups (skipped remotely; native gate 2's g2c-pins ran locally). `lock-tests` do not touch
  the quiet lock, so they were not rerun.
- A gate 8 texture fixture was measured offline from its store (no live receiver at /8 over HTTP in
  this tree), so its row above is a CLI estimate of the host's bodies, not a leg.
- Compression of very large payloads on the I/O thread (about 30 ms for 16 MiB) is accepted until
  G8kw's worker pool exists.
- The smoke tier was not run separately: the full tier is a superset and ran once.

## Deviations from the design

- Default `zstd`, not `off` (D2 text updated).
- Native zstd decode uses `decompress` with the frame's content size, not `decompress_dynamic`
  (which has no zstd in 4.5.1).
- Compression is on the I/O thread, not a worker (no pool yet).
- Vendored zstd 1.5.7 and zlib 1.3.1 are under `capture/vendor/` (digest-pinned in
  `PROVENANCE.md`), not `third_party/`.
- The `corrupt-coded-body` sabotage is a listener sabotage (`GRC_SABOTAGE=corrupt-coded-body`,
  `live.json` `listener_sabotage`), like `no-cors`.

## Time

Implementation (capture, receiver, checks, fixtures, spec, docs): about 2.7 h of agent time.
Validation (ctests, pure, native g2e, the remote and local tiers with lock waits, the reruns): about
3 h wall, mostly waiting on gsw/web real-time legs and other agents' exclusive holds.
