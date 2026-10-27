# WX: the web export replays a store bigger than its heap (CG4 gaps 2 and 3, 2026-10-27)

**The web export now replays STS2's full combat cut.** Its file replay fetches each payload when
the transaction that needs it is applied, instead of staging the whole store up front. CG4's cut
(`cg4-cut.rs10`, 2,847 transactions, the full 288k-file store served in place) now replays with a
**peak wasm heap of 769 MB**, where it used to abort at the 2 GiB limit after 13 min. It takes
191 s.

Web combat is **37.31-43.46 dB**, against native's 37.25-43.22 dB. Web and native agree within 1
on every shot. The HP bars come out at 60.8 / 60.8 / 51.0 dB, against native's 56.3 / 56.3 /
50.2 dB.

`applied.json` matches native's: the same 73,128 fetch rows in order, the same 93 uploads and the
same `resources_summary`. The harness's `?list` no longer overflows the stack on a large store.

## The change

**Lazy store** (`receiver/receiver.gd`, `rs_io.gd`, `rs_resource_cache.gd`). This is the web
export's file mode with `RS_RECEIVER_WEB_STORE=lazy`, the default.

- **Sources.** `prepare_sources()` no longer lists or stages `RS_RECEIVER_STORE_DIR`.
- **The recording.** It is fetched once through the browser's `fetch()` (`RsResourceFetcher`'s
  G7wf path) straight into memory. There is no in-memory file copy and no `HTTPClient` chunk
  growth.
  - It stays whole, because the receiver frames the whole recording before its first
    RenderingServer call. That is the receiver-visible contract a chunked reader would have to
    change.
  - At 162 MB it costs one copy.
- **Per transaction.** Once the core has accepted a transaction, `_begin_store_fetch` takes
  `needed()`'s hashes that are not in memory.
  - It GETs `<store>/sha256/<file>` through a pool of 8 `RsResourceFetcher`s. That is the same
    browser-fetch code live mode uses, unchanged. Under `RS_RECEIVER_FETCH_DELAY_MS` the pool
    runs one GET at a time, so the delay precedes each GET as it precedes each store read
    natively.
  - The transaction waits until the GETs are in, and the previous state stays on screen.
  - A transaction that needs nothing applies in the same frame as before.
- **Arrival.** Each body goes through `add_fetched` with the store path as its origin, which is
  `obtain()`'s directory branch exactly. The receiver then records it through the same
  `_note_directory_fetch` helper `_obtain_needed` now uses.
  - The result is the same row (`source: "directory"`, `status: null`, bytes, verified, kind),
    the same counters and the same first-failure rule.
  - A 404 gets `obtain()`'s wording, `the store has no <path>`.
  - G8kf's variant screen runs after the GETs. A refused variant makes a second pass, so the
    rows keep native's order.
- **Drop.** After the apply, payloads fetched this way that are **64 KiB or larger**
  (`RsResourceCache.DROP_MIN_BYTES`) and are no longer in `needed()` are dropped from memory and
  unstaged from the core.
  - Smaller ones stay, as natively.
  - The drop is off under a G6s memory budget, whose LRU rule stays exact.
  - A payload needed again after its drop is fetched again, as a real row, and the
    `web store:` line counts those.
- **Logging.** One new receiver line, `[receiver] web store: lazy, N GETs (B bytes), D payloads
  dropped …, R fetched again after a drop …, M still in memory`. `applied.json` has no new field.
- **Staged.** `RS_RECEIVER_WEB_STORE=staged` keeps the pre-WX path. The runners set it through
  `GATE7_WEB_STORE=staged` (`lib/gate7-web-legs.ts` `webStoreEnv`, for file legs and
  `browser-receiver`).
- **Out of scope.** The shader library is still staged. Live mode and native receivers are
  unchanged: `_lazy_store` is false in live mode and natively, and the live fetcher code is
  untouched.

**Why the 64 KiB threshold.** The first STS2 run dropped every payload after its upload. It
peaked at the same 769 MB heap, but 9,960 mesh surfaces (3.15 MB, 555 B on average) were needed
again later, which made 83,088 fetch rows against native's 73,128.

- In that cut, the 85 texture payloads hold 360.6 MB (90 % of the bytes) and the 73,023 mesh
  surfaces hold 40.5 MB.
- Keeping the small ones costs about 41 MB and gives back native's rows exactly. The drop then
  still removes 62 payloads (360.2 MB) and re-reads none.

**`listFiles`** (`scripts/lib/browser-harness.ts`): a directory work list and one output array.
The old version spread each recursive result into `push(...)`. The output is the same sorted
list. It is now exported for the self-test.

The design note is in [gate7-design.md](../../protocol/gate7-design.md), Q4 "As built (WX)". No
wire change was made.

## Generic proof: `scripts/bench-web-store.ts`

- **The input.** A synthetic render-stream/6 file recording built with `test/rs2-test-encoder.ts`:
  - 144 transactions;
  - each one draws a fresh 2048² RGBA8 texture of its own colour and drops the previous one;
  - the store holds **2,415,936,240 bytes (2.25 GiB)**, past the template's 2 GiB limit, while the
    live set is one texture.
- **The arms.** Both replay in the pinned Chromium through `runBrowserReceiver`:

| arm | result | peak wasm heap | wall |
| --- | ------ | -------------- | ---- |
| `lazy` (WX default) | ok: 144/144 applied, 144 verified `directory` rows = the store's bytes, 144 uploads, both shots' centre pixel = its texture's colour | **130.7 MB** | 27.5 s; 56.8 s on the final bundle under machine load |
| `staged` (pre-WX, `GATE7_WEB_STORE=staged`) | no `applied.json`; `Cannot enlarge memory, requested 2166738944 bytes, but the limit is 2147483648 bytes!`, then a hang to the 1800 s timeout | 2,147,483,648 | 1800 s (timeout) |

- **The verdict.** It is `PASS` (`lazy_passes: true, staged_fails: true`).
- **The heap check.** A lazy arm passes only when its peak heap is under half the store. The staged
  path holds the store twice (the in-memory file copy and the memory cache), so it cannot pass
  that check even on a store small enough to fit.
- **Run it** with `--arms lazy` (about 1 min), or with both arms and `--timeout-s 900` to watch the
  staged arm fail. It is a hand-run bench (smoke-map rule: `pure` only), because it writes 2.4 GB
  of input, which it deletes afterwards.

**`test/self-test-harness-list-files.ts`** (pure, 24 s):

- 260,000 store-shaped files plus nested and symlinked directories list correctly through
  `listFiles` and through a real `HarnessServer`'s `GET /store/?list` (200);
- the pre-WX spread, kept in the test as the negative control, throws `RangeError` on the same tree;
- 5/5 assertions passed.

## STS2 confirmation (no game launch)

- **The replay.** `replay-web.sh cg4-a10-2 web-wx`, run with:
  - `C3_GSW` set to this worktree;
  - `C3_REC=…/capture/cg4-cut.rs10`;
  - the full `capture/store`, served in place, never copied;
  - port 13964;
  - CG4's shot seqs;
  - `C3_CAL` set to the cg4 calibration record.
- **The bundle.** `artifacts/render-stream/web-receiver/7085144167394038`. Its `build.json`
  sha256 is `b620cbf0…` (the first run's bundle), and the page's `RS_RECEIVER_BUILD_SHA256` is
  `efd57716…`.
- **Before:** CG4, `web-oom-full`: an OOM after 13 min.

**PSNR (dB) against the in-process reference. In brackets: px over 16 and max delta.**

| scene | native (CG4) | web export (WX) | web vs native |
| ----- | ------------ | --------------- | ------------- |
| menu-1/2/3 | 31.34 / 31.79 / 31.89 | 31.38 / 31.83 / 31.92 | 57.0-57.1 (0, 1) |
| map-1/2/3 | 64.21 / 64.08 / 64.20 | 65.63 / 65.55 / 65.63 | 66.1-66.3 (0, 1) |
| combat-1/2/3 | 43.22 / 37.25 / 37.52 | **43.46 / 37.31 / 37.58** | 57.39 (0, 1) |

**HP bars** (`hpbar.py`, the five bar rows, CG4's rects):

| shot | native | web export |
| ---- | ------ | ---------- |
| combat-1 | 56.3 dB, 0 px over 16, max 2 | **60.78 dB, 0, max 1** |
| combat-2 | 56.3 dB, 0, max 2 | **60.78 dB, 0, max 1** |
| combat-3 | 50.2 dB, 24, max 30 | **51.03 dB, 23, max 30** |

combat-3's residual is CG4's animated third-enemy crop, not the bar.

**Resources.**

- The web line: `73128 GETs (401133631 bytes), 62 payloads dropped after upload (360195561 bytes),
  0 fetched again after a drop, 73066 still in memory (40938070 bytes)`.
- The recording was fetched in 609 ms.
- **The peak wasm heap is 768,606,208 bytes.** The first, drop-everything run measured the same.
- Against native's `applied.json`:
  - fetch rows equal (73,128, in order);
  - upload rows equal (93), timing fields aside;
  - `resources_summary` identical;
  - `status: ok`, 2,847 transactions, 51 unsupported.

## Gate 7 checks and up-front staging

No gate 7 web check depends on staging. What changes is only timing:

- `fetches[].start_us/end_us`;
- `process_frame` for a transaction that waited on its GETs and for the shots after it;
- the `web:` line's source count, now 1 for the recording plus the library files, instead of
  every store file.

`gate7-adapters.ts`'s `sources_staged_ms` still matches its line, which now ends `; store lazy`.
G7k's startup numbers move earlier, because the store is no longer counted in them. They are
timing, left to the sweep.

## Validation

- `validate-increment.sh --plan`:
  - the diff reaches every native gate (receiver), every `g7`/`g7live` web-rust group and the GSW
    groups (`browser-harness.ts`);
  - sabotage legs run, because `receiver.gd` names a sabotage;
  - the new bench gets its own smoke-map rule (`pure`).
- **Local, during development.** `run-gate7.sh --legs g7-2 --receiver web` ran on a lazy bundle
  that dropped every size:
  - every web check passed (31 PASS);
  - the only FAIL was `source-run-valid@web`: the source key moved because receiver files were
    edited mid-run;
  - `applied.json` for receiver-cold and receiver-patch differs from native only in
    cache/paths/kind/display fields, with fetch rows and uploads equal.
- **Remote full tier:** run 40518269895 (`rv-20261027T140823Z-f1f08df-10314`) passed **14/14 runs**:
  - `pure`, which includes the new list-files self-test;
  - native gates -1, 0 to 5, 5.5 and 8, with sabotage legs;
  - `g7-gsw` and `g7-web-rust` (every file group);
  - `g7live-gsw` and `g7live-web-rust` (every group but g7-1).
  - The timing groups of those runs were skipped by design.
- **Local, the groups the remote refuses** (g7live-gsw and g7live-web-rust, group g7-1,
  `RS_VALIDATE_GROUPS=g7-1`): **2/2 pass** (454 s and 282 s).
- **Out of scope:** the timing runs (native gate 6, `g7live-*-timing`, g7x), left to the sweep.
  There is no GDScript core anymore (G7gd).

## Evidence

- `artifacts/render-stream/p3/wx/` (main checkout):
  - `bench/`: the summaries of both arms and of the final lazy arm, the staged console OOM lines,
    and the `timings.json` of both arms;
  - `sts2/`: `compare-native-web-wx.json`, the `hpbar-combat-*-web-wx.{json,png}` files, the web
    lines of the final and the drop-everything runs, `timings.json`, `page-config.json` and the
    bundle's `build.json`.
  - `remote-40518269895-validate-summary.json` and `validate-local-g7-1-summary.json`.
- The replays are in couch-coop's research folder, under `c3/legs/cg4-a10-2/replay/web-wx`
  (final) and `web-wx-dropall` (the drop-everything run).
