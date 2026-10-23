## G8sha result (2026-10-23)

The capture's SHA-256 (`capture/src/rs_sha256.*`) now runs on the x86 SHA extensions when the CPU
has them: **2015 MB/s instead of 351 MB/s on a 16 MiB payload (5.7×)**, every output byte unchanged.
On G8t's 2048² cost textures the hook's hash drops from ~48.5 ms to ~8.4 ms, so the hook's
decode + copy + hash falls by ~40 ms on every format (DXT1 73.6 → 33.9 ms, ASTC_4x4 141 → 100 ms).
The calibration check's own SHA-256 of `/proc/self/exe` (calib.cpp, its private copy now removed)
uses the same code: the 70 MB template hashes in ~50 ms instead of ~250 ms on every armed launch.

### What changed

- `Sha256` keeps its API. Its compression function is a per-object function pointer: `portable`
  (the G2a code, unchanged) or `sha_ni` (sha256rnds2/sha256msg1/sha256msg2 intrinsics, the
  Intel/Linux-kernel shape, ~50 lines in a `__attribute__((target("sha,sse4.1")))` function, so
  the rest of the library keeps the baseline x86-64 ISA; `objdump` shows every SHA, `pshufb` and
  `pblendw` instruction inside `blocks_sha_ni`). `update()` hands every whole 64-byte block to it
  in one call. `finish()` pads in place instead of up to 64 one-byte `update()` calls, which makes
  small hashes faster on both paths (64 B: 673 → 396 ns portable).
- **Dispatch**: `sha256_default_path()` reads CPUID once per process (leaf 7 EBX bit 29 SHA, leaf 1
  ECX bits 9 SSSE3 and 19 SSE4.1) and caches it in a function-local static; a CPU without them gets
  `portable`. Nothing can fail: `Sha256(Sha256Path::sha_ni)` on a CPU without SHA-NI also falls
  back to portable. `build-capture.sh` prints the path after ctest
  (`sha256 default path: sha-ni (sha-ni available)`), so every local and runner build log says
  which one ran.
- **ARMv8**: the capture builds for x86-64 only (`CMakeLists.txt` refuses anything else), so there
  is no ARM path; `detect_default_path()` is the one seam a `vsha256hq_u32` path would join.
- **One implementation**: `calib.cpp`'s private SHA-256 (struct, block, update, finish: 98 lines)
  is gone; `sha256_file` uses `grc::Sha256`. Every capture hash (texture, mesh and shader payloads
  in `hooks.cpp` and `rs_mirror.cpp`, the binary fingerprint) goes through `rs_sha256.cpp`.
- The portable block function stays out of line (`noinline`), as G2a's member function was: inlined
  into the multi-block loop, GCC 13 scheduled it 6% slower (325 vs 347 MB/s).
- New: `capture/test/rs_sha256_bench.cpp` (built, not a ctest: `rs_sha256_bench [--path
  portable|sha-ni|default] [--json] | --which`). Not chosen: Godot's `HashingContext` (an object
  and Variant calls per hash through the extension API, and the 4.5.1 template's mbedTLS 3 SHA-256
  has no x86 SHA-NI path, only ARMv8 crypto) or linking OpenSSL (a new dependency for ~50 lines).

### Throughput (rs_sha256_bench, exclusive quiet lock, loadavg 1.95)

Best of 7-9 repeats, MB/s = 10^6 B/s; "before" is the bench built against main's `rs_sha256.cpp`
(`artifacts/render-stream/gate8/g8sha/bench-*.json`).

| input | before (main) | portable | sha-ni | sha-ni vs before |
| ----- | ------------- | -------- | ------ | ---------------- |
| 64 B | 95 (673 ns) | 162 (396 ns) | 542 (118 ns) | 5.7× |
| 256 B | 208 | 269 | 1201 | 5.8× |
| 1 KiB | 299 | 326 | 1727 | 5.8× |
| 4 KiB | 335 | 345 | 1939 | 5.8× |
| 16 MiB | 351 (47.8 ms) | 351 (47.9 ms) | 2015 (8.33 ms) | 5.7× |

The 32 sha256rnds2 of a block form one dependency chain; at its ~4-cycle latency on Zen 3 that
bounds one stream at ~2 GB/s, so the number is the instruction's, not memory bandwidth's.

### CPU feature

| host | CPU | SHA-NI | default path |
| ---- | --- | ------ | ------------ |
| development host | AMD Ryzen 5 5500 (Zen 3) | yes (`sha_ni` in /proc/cpuinfo) | sha-ni |
| hosted runners, run 39948057538 | AMD EPYC 7763, 9V74, 9V45; Intel Xeon Platinum 8370C, 8573C | yes on every job | sha-ni |

Every runner job's build log prints `sha256 default path: sha-ni (sha-ni available)`. No host here
lacks SHA-NI, so the fallback is proven by forcing it (`Sha256(Sha256Path::portable)`) in the
ctest, on every machine, rather than by dispatch.

### Decode cost (decode-cost, real time, exclusive lock)

`run-gate8.sh --legs g8t` with `RS_SMOKE_LEGS=import,decode-cost`, the old library (main) and the
new one alternated twice, each started at 1-min loadavg < 4 (2.8-3.3 when the capture leg took its
exclusive hold). Hook ms on the calling (main) thread for one 2048² create, mean of the two rounds
(`artifacts/render-stream/gate8/g8sha/cost-{before,after}-r{1,2}/`):

| format | decode before / after | copy before / after | hash before | hash after | total before | total after |
| ------ | --------------------- | ------------------- | ----------- | ---------- | ------------ | ----------- |
| DXT1 | 10.6 / 10.8 | 14.6 / 14.7 | 48.5 | 8.5 | 73.6 | 33.9 |
| ETC2_RGB8 | 15.8 / 15.2 | 14.8 / 14.9 | 50.1 | 8.5 | 80.6 | 38.5 |
| DXT5 | 13.6 / 12.8 | 15.1 / 14.5 | 49.7 | 8.4 | 78.4 | 35.7 |
| ETC2_RGBA8 | 11.4 / 11.2 | 12.6 / 11.7 | 48.5 | 8.6 | 72.5 | 31.5 |
| BPTC_RGBA | 30.3 / 28.8 | 12.0 / 10.9 | 48.2 | 8.4 | 90.5 | 48.0 |
| ASTC_4x4 | 78.0 / 77.0 | 14.8 / 14.9 | 48.2 | 8.4 | 141.0 | 100.3 |

The hash is now the smallest of the three for every format, below the payload copy (first-touch
page faults on the fresh 16 MiB buffer) and the decode. Applied to the STS2 census's 66 MB BPTC
atlas (gate8-design.md Q3: ~190 ms of SHA-256), the hash is ~33 ms. The full g8t runs agree
(`before-g8t/`, `after-g8t/`, at loadavg 7.1-7.4: hash 47.9-50.1 → 8.6-9.3 ms).

### Bit-identity

- **NIST vectors** (empty, "abc", the 448-bit message, one million 'a') on each path forced and on
  the default, whole and in pieces of 1, 3, 55, 56, 63, 64, 65 and 1000 bytes (`rs_sha256_test`).
- **Randomized**: sha-ni equals portable on every length 0..10,000 of xorshift bytes, whole, and
  every 97th length also fed in random pieces of 0-199 bytes; and on 16 MiB, whose digest is pinned
  from coreutils `sha256sum` over the same bytes (an oracle outside the code under test).
- **Dispatch**: the test fails if the default path is not sha-ni exactly when sha-ni is available.
- **Goldens 2-8**: untouched (`git diff` lists none); `rs2..rs8_codec`, `rs_texture_payload`
  (golden-2 payload bytes and hashes), `rs_mirror`, `rs_publish` ctests and the `pure` tier pass.
- **Recordings before/after** (old library vs new, same fixture), compared record by record
  (`compare-g8t.txt`, `compare-g2.txt`, a decode through `lib/render-stream-2.ts`):
  - g8t, all 8/8 checks on both: 10 recordings (/8 and the /6 `decode-off` control) and 4 hook
    logs equal. Every transaction and resource record is byte-identical; only the session header
    (`session_id`, `stream_id`) and the end record (`encode/snapshot/diff_ns_total`) differ, as they
    do between any two runs. All 95 store payloads (`.grt`, `.grt1`) are byte-identical.
  - gate 2 g2a+g2b (47/47 run checks on both; the 3 non-passes are `group-g2c/d/e` "not in
    --legs"): 32 recordings and 10 hook logs equal on the same terms, 173 store payloads
    byte-identical. `live-inline`'s tap and received recordings differ by one transaction (962 vs
    963, a live leg's wall-clock frame count); their 57 hashed hook-log lines are the same sequence.

### What ran

| where | runs | result |
| ----- | ---- | ------ |
| local | capture ctests (25, `rs_sha256` extended), `rs_sha256_bench` before/after | pass |
| local | `validate-increment.sh --tier full --only pure,capture-build` (`validate-local/`) | 2/2 pass |
| local | `run-gate8.sh --legs g8t` old and new library (`before-g8t/`, `after-g8t/`) | 8/8 both, recordings equal |
| local | `run-gate2.sh --legs g2a,g2b` old and new (`before-g2/`, `after-g2/`) | 47/47 run checks both, recordings equal |
| local, timing | decode-cost ×4 (old/new alternated, loadavg < 4) | the table above |
| remote full tier | run 39948057538, https://github.com/tfoxy/godot-scene-web/actions/runs/39948057538 | 20 of 21 runs pass (key `rv-20261023T114310Z-f59e9f8-21627`, evidence `artifacts/render-stream/remote/20261023T114321Z`): pure, capture-build, cargo ×3, pnpm-test, bench-instr, native gates −1, 0, 1, 2, 3, 4, 5, 55 and 8 (sabotage legs run; timing groups skipped remotely), g7-gsw and g7-web-rust (all eight groups), g7live-gsw and g7live-web-rust (g7-5, g7-55); the 21st, `cargo-gsw-rs`, is the known rc 101 |

**Out of scope, and why.** The change can alter no output byte, and the goldens, the ctests and the
before/after recordings show none did, so the local live g7-1/g7-2 groups and every timing run
(`native-rust-gate6`, `g7live-*-timing`, `g7x`, `lock-tests`, the timing groups inside gates 1, 2,
5, 55) were skipped by the brief, to keep this shared machine's load low while G7kh and G7w2c
validate. The remote tier refuses the same set (timing on a shared VM; g7-1/g7-2 live). Known
failures ignored: `cargo-gsw-rs` rc 101.

### Implementation versus validation time

About 25 minutes of writing (the bench first, the SHA-NI block function, dispatch, the calib swap,
the test), plus ~10 minutes chasing the portable path's 6% inlining regression. Validation took
about 70 minutes of wall time, mostly in parallel: the remote full tier (54 minutes from dispatch to collection), the local
before/after g8t and gate 2 runs (~41 minutes, 15 of them lock waits behind other agents' gate 6
timing legs), the pure tier (610 s) and the four decode-cost runs (~5 minutes).
