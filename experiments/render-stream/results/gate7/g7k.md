## Gate 7k result: startup, memory and soak on both browser receivers

Design: [protocol/gate7/g7k.md](../../protocol/gate7/g7k.md) (gate7-design.md Q10, D16, D29).

**Both browser receivers, GSW and the web export on the Rust core, pass every `g7-k` check: a
cold and a warm start (five repeats each, warm served wholly from the HTTP cache) and a 300 s
soak under the 1 MiB memory budget with bounded renderer RSS, JS heap, wasm heap, GL textures and
GPU memory. Both sabotages fail with exactly their predicted check sets.** Verdicts are the
committed checkers' (`check-gate7.ts --legs g7-k --live --web-core rust`): web 33/33, GSW 45/45.

Tree: G7k merged onto main's `49390cb7` (G7o3), core `rs-core/e9e378decf29`, web bundle
`99ea42fedf43a67f` (Rust core), Chromium 148.0.7778.96 (`chromium-1223`, headless=new, ANGLE
Vulkan, RTX 2060). The `g7-k` run is `final/` (soak and a first startup pass, run while other
repos pushed the load average to 12-17); the startup numbers below are the **quiet rerun**
`startup-quiet/` (load average 2.4-4 during its legs; the runner's per-leg lock held exclusively),
judged 71/71 together with `final/`'s soak.

### Startup (five repeats, median / min-max, ms from navigation start)

| Receiver | Start | `rs-session-decoded` | `rs-first-applied` | `rs-first-submitted` |
| --- | --- | --- | --- | --- |
| GSW | cold | 86 (80-121) | 269 (259-307) | 279 (268-317) |
| GSW | warm | 526 (475-545) | 698 (663-729) | 705 (672-736) |
| web (Rust core) | cold | 1680 (1627-1896) | 1754 (1720-2016) | 1815 (1783-2082) |
| web (Rust core) | warm | 1579 (1551-1696) | 1661 (1630-1762) | 1701 (1663-1799) |

Warm legs `r1..r5` serve every static resource from the HTTP cache (`startup-warm-fetches`
passes); `r0` of each kind is a cold load and is not judged for that. The warm static server needs
validators (`GATE7_STATIC_CACHE=1`, the harness server's `staticCache`): without them the browser
never revalidates and warm never hits the cache.

Read these as follows:

- **A warm start is not a faster start here.** The cache removes bytes, not time. GSW's warm
  `rs-session-decoded` is later because the cached page connects before the host publishes
  (host-side wait, about 450 ms), not because the receiver is slower. Take the intervals instead:
  session-decoded to first-submitted is 194 ms cold vs 188 ms warm on GSW, and 156 vs 110 ms on the
  web export. GSW's first apply is compute-bound (172-189 ms in both).
- The web export is dominated by wasm and engine initialisation (about 1.6 s, same cold and warm),
  which the HTTP cache does not shorten.
- Desktop only. The g31 was not run (optional in the handoff); G7v owns phone acceptance.

### Soak (300 s, `soak-scene`; budget `RS_RECEIVER_MEMORY_BUDGET_BYTES` = 1 MiB)

| Measure | web (Rust core) | GSW |
| --- | --- | --- |
| max memory-cache bytes (budget 1,048,576) | 1,047,804, 7 evictions | 1,048,576, 16,274 evictions |
| `no-evict` sabotage, max memory-cache bytes | 1,311,695 | 2,810,270 |
| renderer RSS growth | 0 B | +1.06 MB (148 KB/min) |
| GPU-process RSS growth | -0.58 MB | +0.95 MB |
| JS heap growth | n/a (wasm) | +2.0 MB |
| wasm heap | 127,139,840 B flat | 7.14 -> 11.27 MB (+4.1 MB, bound 16 MiB) |
| GL textures (first / last third max) | n/a | 6 / 6 |
| `nvidia-smi` GPU memory growth | 0 | 0 |
| pixels | identical 220,550, readback 9,691, delta1 159, other 0 | Q7: decided 0, delta1 3,873 (max 1), undecided 5,809 |

- **Budget accounting.** The web export counts the GDScript payload cache that lives in wasm memory
  (`RsResourceCache`). Since G7o3 the core also holds a staged copy of each in-memory payload; the
  cache unstages on eviction, so the core never holds more than the cache, and the staged copy shows
  in the wasm-heap line, not the budget. GSW's budget is the store's payload bytes plus the resident
  texture GL bytes (D29 amendment); the unevictable floor (referenced entries, 1,066,260 B on the
  gate 6 scene) is about 1 KB over the 1 MiB bound, so the check judges
  `cache_bytes_memory - max(0, floor - budget)`.
- **Web soak pixel rule.** The web export's gate 6 exact-budget pixel check (budget-0, 9,850 pixels
  differ by +1 on grey text anti-aliasing edges) cannot pass against a rendered reference on this
  stack: it is the same readback rounding and ANGLE AA that G7b measured. The web soak is judged
  with G7b's `classifyShot` band against a **native** reference (`reference-step11`): `other` must
  be 0; the result, identical 220,550 / readback 9,691 / delta1 159 / other 0, equals G7b's oracle
  9691/159/0. The G6sx diagnostic confirmed that equality. The raw budget-0 count is still reported,
  non-gating. GSW is judged by Q7 (`gate6-animate` step-11 masks), unchanged.
- **Web soak shutdown.** The web export mirrors received bytes into MEMFS and PUTs them at exit
  (about 420 MB, about 20 min for a 300 s soak, and the final shots never arrived). New
  `RS_RECEIVER_RECEIVED_MAX_BYTES` caps the mirror (stream report `received_truncated`);
  `run-gate6.sh` sets 1 MiB for web soak legs. The web soak exits at once.

### Sabotages (failure sets judged exactly, one gating `-failure-set` check each)

| Leg | Receiver | Failing set | Verdict |
| --- | --- | --- | --- |
| `sabotage-soak-no-evict` | web | `{residency-bounded:receiver memory-cache entries}` | exactly as predicted |
| `sabotage-soak-no-evict` | GSW | `{js-heap-bounded, residency-bounded:receiver memory-cache entries, wasm-heap-bounded}` (wasm 9.6 -> 58.9 MB) | exactly as predicted |
| `sabotage-leak-gl-textures` | GSW | `{residency-bounded:gl-textures}` (86 -> 186 textures) | as predicted, with the deviation below |

**Deviation: `gpu-mem-bounded` is typed `unavailable` for `leak-gl-textures`, not required to fail.**
The design predicted the leak would also fail `gpu-mem-bounded`. It does not: the leak allocates on
a throwaway WebGL2 context, and `nvidia-smi`'s per-process figure stays flat (25,165,824 B) even
after the textures are real 512x512 with data, drawn into and `finish()`ed (two reruns). The
check's verdict is `unavailable` with its reason and not a silent pass; the required set is
`{residency-bounded:gl-textures}`. The GL-texture count is the sound detector here.

### Other checks re-run (scoped to what the diff reaches)

- Pure self-tests: every `scripts/test/self-test-*.ts` (including `self-test-gate7k.ts`, 19 cases)
  passes; `self-test-record-digest.ts` and `self-test-rs-core.ts` (with `--goldens`) pass on the
  g7d-r1 bench inputs.
- `rs-core`: `cargo test` 40/40; `rs-core-check goldens` native all pass; Node wasm goldens 587/587.
  **rs-core output is unchanged**: G7k adds accessors only (`Applier::resident_texture_hashes`,
  `PayloadStore::bytes_of`). `web/gsw-rs`'s `cargo test` does not build natively (a wasm32-gated
  item), as before.
- g7-1 live on both receivers (shared live-leg code changed): 78 PASS, 0 FAIL.
- Native gate 6 under the Rust core (`receiver.gd` and `run-gate6.sh` changed). The first full
  run (load average 12-17 from other repos) failed four checks: `motion-monotonic`,
  `host-unperturbed-mismatch-60-recv30` (frame-interval p95 +14.5%), `pending-bounded-constrained`
  (queued 100,476 B vs 98,892 B) and the constrained sabotage's leg class. The rerun of `g6a,g6l,g6c`
  at load 1-4 passed every check except `motion-monotonic` (two 3-frame gaps behind a 16.1-16.5 ms
  receiver hold). That one is the known load-sensitive check that also failed on `main` in G7o2
  (153/154) and G7n; it is not G7k's. The other gate 6 groups (g6s, g6h, g6b) passed in the first
  run.

Evidence (ignored): `artifacts/render-stream/gate7/g7k/` (`final/`, `startup-quiet/`, `dev3/`,
`leak/`, `g7-1/`, `gate6-first/`, `gate6-rerun/`; no recordings, `.wasm` or bundles).

### Out of scope

- The g31 (phone) startup and memory numbers; G7v runs the phone acceptance.
- GSW and web on `--web-core gdscript`; the `g7-k` group is run on the Rust core only.
- The native receiver: `g7-k` is browser receivers only (`--receiver native` is refused).
- The `g7-6` live `motion-monotonic@web` intermittent failure (G7u; G7uf owns it).
- Memory accounting of texture and mesh memory in the engine: reported (`texture_mem_bytes`),
  not budgeted.
- Soaks longer than 300 s and soak under throttled CPU.
