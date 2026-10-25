# P3-HX: the STS2-scale harness and receiver memory gaps (C3 gaps 8 and 7)

**Gap 8: fixed. Gap 7: the growth was the receiver's own evidence rows, not a resource leak; fixed.**
The full kept `a8-2` recording (4,960 transactions, 640 MB) now replays through the GSW browser
receiver and finishes (exit 0), and the native receiver's peak RSS on it drops from 5.98 GB to
2.68 GB with byte-identical shots and an applied.json equal modulo timings.

## Gap 8: `ERR_STRING_TOO_LONG`

**Cause.** Not `applied.json` crossing the Playwright pipe as a page-to-Node string, as C3 guessed.
The page `PUT`s applied.json to the harness server with `fetch`, and Playwright's network tracking
receives that request body whole: Chromium's `Network.requestWillBeSent` event carried a
587,250,141-byte message (`postData` inline) for the single PUT, over the 536,870,888-character (2^29-24)
(512 MB) limit of `PipeTransport._dispatch`'s `Buffer.toString`. The page-side string itself
(`JSON.stringify(doc, null, 2)`, 237 MB) was under V8's limit; it would hit it at about 2x this scale.
The failing run is reproducible with the pre-fix bundle: a Buffer hook printed the head of the
oversized message.

**Fix.**

- `web/gsw-receiver/evidence.ts` `put()`: a body over 8 MiB (string, list of strings, Uint8Array
  or Blob) goes out as ordered `?part=k&of=n` PUTs of at most 8 MiB. Small bodies are the same
  single PUT as before.
- `prettyJsonParts()`: `JSON.stringify(value, null, 2)` as a list of pieces (arrays and objects
  with at least 64 entries split per entry), so applied.json is never one string either. `main.ts`
  and `live.ts` PUT `[...prettyJsonParts(doc), "\n"]`.
- `scripts/lib/browser-harness.ts` `handlePut`: streams the request body to the file (part 0
  creates, later parts append) and answers, and calls `onPut`, only for the last part, so the
  held-PUT screenshot semantic is unchanged. A bad `part`/`of` is a 400.
- Every other dump (shots, state dumps, perf timeline, shader params) is below the threshold or goes
  through the same `put()`.

**Inputs are byte-identical.** `scripts/test/self-test-pretty-json-parts.ts` (pure) asserts that
the pieces concatenate to exactly `JSON.stringify(value, null, 2)` for nested, empty, undefined-
holed and large documents at five split thresholds, and that `put()` sends ordered parts whose
bytes equal the input (a 20 MB string of surrogate pairs). `self-test-browser-harness.ts` gained two
checks against the real Chromium and `HarnessServer`: `evidence-put-parts-assembled` (a part
boundary inside a multi-byte character, a bad part refused) and `evidence-put-640mb-in-parts`
(640 MB in 80 parts, more than the 512 MB message limit, lands whole). On the real recording the
237,101,723-byte applied.json satisfies `file == JSON.stringify(JSON.parse(file), null, 2) + "\n"`,
which is the old writer's output for the same document.

**Confirmed on STS2.** `replay-gsw.sh a8-2` on the full, uncut `a8-2` recording: exit 0 in 500 s,
4,960 transactions, `status: ok`, the 9 shots, a 237 MB applied.json. (Before: `ERR_STRING_TOO_LONG`
at the end of the run, with the pre-fix bundle.)

## Gap 7: native receiver memory

**Method.** `RS_RECEIVER_RSS_EVERY=N` (new, file mode, off by default) logs one line per N applied
transactions: process RSS, the cache's in-memory payload bytes and entries, the evidence rows kept
and the resident RID counts. `a8-2` full, 4,960 transactions, N=200, as fast as possible.
(`RS_RECEIVER_PERF_OUT` is not a way to sample this: with it on, the replay took more than 20
minutes instead of 2, from the per-frame render-time query. `OS.get_static_memory_usage()` is 0 in
release templates.)

| seq   | RSS (before) | cache payload bytes | fetch rows | mesh_upload rows | items | textures |
| ----: | -----------: | ------------------: | ---------: | ---------------: | ----: | -------: |
|   400 |      994 MB  |               91 MB |      5,165 |           10,687 | 2,478 |       20 |
| 1,200 |    1,247 MB  |              207 MB |     12,880 |           30,814 | 4,019 |       42 |
| 2,000 |    1,610 MB  |              367 MB |     49,336 |          103,530 | 4,196 |       92 |
| 3,200 |    2,478 MB  |              434 MB |    172,194 |          349,454 | 4,196 |       92 |
| 4,800 |    3,632 MB  |              522 MB |    335,745 |          677,448 | 4,196 |       92 |

**Not a leak.** Resident items, textures and meshes are flat from seq 2,000 on (4,196 / 92 / 33 for
meshes), the RIDs are freed on `free`, and the 4,574 remaining RIDs are all freed at dispose. GLES3
keeps no CPU image copy (`image_cache_2d` is editor-only, checked in the 4.5.1 source); the
extension unreferences every `Image` right after `texture_2d_create`.

**What grew.** Past seq 2,000 the RSS climbs 0.71 MB per transaction while the payload cache grows
0.06 MB per transaction. Each transaction appends about 100 fetch rows and 200 mesh-upload rows to
the applied-log (`fetches`, `mesh_uploads`; applied.json keeps both whole, 237 MB at the end). As
GDScript Dictionaries they cost 2.1 KB each: 968k rows after seq 1,600 is about 2.1 GB of the 3.6 GB.
The rest: the 640 MB recording read whole into memory (a file-replay design, unchanged), about
350 MB engine and driver baseline, the payload cache (522 MB; unlimited by default, evictable
with `RS_RECEIVER_MEMORY_BUDGET_BYTES`) and per-hash bookkeeping. The textures actually resident at
the end are 92 (the cache's `uploads` rows: 92). The JSON write at the end added a further
2.3 GB (peak 5.98 GB against 3.63 GB at seq 4,800), the String for a 237 MB document being UTF-32.

**Fix** (`receiver/rs_row_log.gd`, new; `receiver.gd`). `fetches`, `uploads` and `mesh_uploads`
are `RsRowLog`s: append-only `var_to_bytes` blobs in one PackedByteArray with end offsets, 0.2 to
0.4 KB per row. A row decodes to the same Dictionary (same keys, order, types).
`RsRowLog.write_report_json()` writes the report in `JSON.stringify(report, "  ", false) + "\n"`'s
layout (including Godot's `{\n\n}` for an empty Dictionary) and streams the logs a row at a time, so
the report is never one String. The live path's fetch row, which was mutated after being appended,
is appended once final (same row content, same position).

| `a8-2` full, native      | before  | after   |
| ------------------------ | ------: | ------: |
| peak RSS                 | 5.98 GB | 2.68 GB |
| RSS at seq 4,800         | 3.63 GB | 2.35 GB |
| RSS growth per transaction after seq 2,000 | 0.71 MB | 0.32 MB |
| wall time                | 130 s   | 117 s   |

What still grows (0.32 MB per transaction) is proportional to the distinct payloads fetched: the
payload cache (memory budget unlimited by default), the `_fetched_hashes`/LRU bookkeeping, and the
compact rows (about 76 KB per transaction). The 2.35 GB at the end is: 640 MB recording, about
520 MB cached payloads, about 0.4 GB compact rows, about 0.8 GB engine, driver and the 92 resident
textures. I left the cache default alone: a default budget would change the eviction counters of
every gate's evidence.

**Outputs unchanged.** Native shots of all 9 steps are byte-identical before and after (`cmp`),
and the full applied.json is equal modulo timing fields after parsing (all keys, same key order).
`receiver_selftest.gd` (gate 0 and 1's `receiver-typecheck` sub-leg) gained the `RsRowLog` checks:
rows round-trip with keys in order, and the streamed report equals `JSON.stringify(...)` for
populated, null-log, one-row and empty reports.

## STS2 fidelity numbers (unchanged by this increment)

Neither change touches drawing. Native shots are byte-identical to the pre-fix replay. Per-step PSNR
(dB) of the full `a8-2` replays against the in-game reference:

| step         | native | GSW   |
| ------------ | -----: | ----: |
| menu (1-3)   | 2.94   | 2.94  |
| map (1-3)    | 64.1   | 53.3  |
| combat (1-3) | 26.2   | 25.0  |

(Menu is the screen-texture blur rect of gap 1, P3-ST.)

## Traps found

- `ensureLink` in `gate7-live-legs.ts` does not replace an existing `<static-root>/gsw-bundle`
  symlink, so a shared static root (C3's `fidelity-data/a8-2`) keeps serving the first bundle ever
  linked. Replaying a rebuilt bundle there ran the stale one (a fresh `C3_GSW_PORT` fixes only the
  HTTP cache). Use a private static root per bundle (this increment did).
- `self-test-browser-harness.ts` exits 0 without printing its summary in this environment (the
  `wsServer.close` callback never fires; `probes.json` is complete). Its checks are read from
  `evidence/probes.json`. Pre-existing: the same on `main`.

## Validation

- Remote full tier (GitHub run 40200037070, on the pre-rebase tree): `pure`, `cargo-gsw-rs`, native
  gates -1 to 8, `g7-gsw` and `g7-web-rust` (every file group, g7-8 included), `g7live-gsw`: all
  pass. `g7live-web-rust` failed `leg-class-live-mesh@web` and `receiver-vs-reference@web` in g7-5
  with the known hosted-runner "no shot for step 5".
- Local full tier, `--only g7live-gsw,g7live-web-rust` (the g7-1 group is remote-refused; also the
  rerun of the web flake): 2/2 pass (816 to 830 s each).
- Local smoke, partly run before it was replaced by the above: `pure`, `cargo-gsw-rs`, native gates
  -1, 0, 1, 2, 3, 4, 5 and 55 all rc=0.
- Not run: the timing runs (`native-rust-gate6`, `g7live-*-timing`, `g7x`) and the timing groups the
  remote run skipped; nothing here reaches rate, pacing or phase (the receiver's work per
  transaction is the same; the evidence write at the end is the only changed cost).
- Sabotage legs ran (the diff names `receiver.gd`), in the native gates above and the remote tier.
