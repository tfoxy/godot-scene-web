# G8kc: the persisted host texture cache, the prepare step and the texture_set_path hook

Increment G8kc of [texture-delivery-design.md](../../protocol/texture-delivery-design.md) (D7-D10;
"As built (G8kc)" there records the decisions). Evidence: `artifacts/render-stream/gate8/g8kc/`
(ignored).

## What it proves

- With `GRC_TEXTURE_CACHE_DIR` set, a block-compressed texture's host decode is stored under
  (source key, `decoded`, `engine-decompress/4.5.1`), the source key being D7's SHA-256 of the
  hooked image as a GRT1 payload in its own format. A second session on the same directory runs
  **zero** engine decodes and zero encodes and publishes the **same** hashes: the fixture's 12
  decodable textures are all hits (synchronously and at `GRC_TEXTURE_WORKERS=2`), and every source
  key and decoded hash equals the oracle's independently built payload hashes, not just the first
  session's.
- The cache serves a file only after it verifies against its name and recorded size. With one file
  byte-flipped, one truncated and one deleted, the session detects the two bad ones (`corrupt` 2),
  never serves them, derives and stores all three keys again (3 derivations) with the oracle's
  hashes, and the next session is clean.
- `GRC_TEXTURE_CACHE_MAX_BYTES` is an LRU by last use: 60,000 B over 188,383 B of decoded payloads
  keeps 49,488 B after 9 evictions, files on disk = hashes in the index, the most recent entries
  kept.
- `scripts/prepare-textures.sh --list` over the fixture's imported `.ctex` files, with no session,
  computes the same source keys the hooks compute and fills the same index rows (identical hashes
  to the live session's); the next session is 12 hits and 0 derivations. `--project`, `--images`
  and `--list` all work; the cache directory is refused inside a git repository.
- The `texture_set_path` hook (slot 42) names the `res://` path of every fixture texture: 17 calls
  in `counters.json`, 16 fixture textures all present in `evidence/texture-cache.json` with their
  source key and outcome.
- A pre-arm texture adopted at a late arm (`GRC_ADOPT=arm`) goes through the same cache (D9a): the
  cold session derives the adopted DXT5 texture, the warm one hits it, with equal states.
- With no cache directory nothing changes: 79 hooks planned, no `texture_set_path` in the plan, the
  counts or the session, no `texture_cache` block, no `texture-cache.json`, and the recording
  resolves to the same state at every frame as every cached session's. Against a build of main
  the only difference in a /9 recording is the `end` record's timing stats; `counters.json` is
  identical.

## Checks (gate 8 group `g8kc`, development host)

| check | result |
| ----- | ------ |
| `cache-off-identical` | 79 hooks, no cache artifacts; 6 cached sessions equal off's states (22 transactions), hook-log texture lines and stored hashes |
| `cache-paths` | 80 hooks planned under a directory; 17 calls; 16/16 fixture textures named |
| `cache-cold` | 12 derived = 12 stored, 188,383 B; keys and hashes equal the oracle's; index rows match |
| `cache-warm` | synchronous and workers: 12 hits, 0 derivations, 0 encodes, hashes = cold = oracle |
| `prepare-key-match` | 14 fixture textures matched (12 decoded hits, 2 sources); prepared index = live index; 0 derivations |
| `cache-corrupt` (sabotage) | 2 corrupt detected, 3 re-derived, clean afterwards |
| `cache-lru` | 9 evicted, 49,488 / 60,000 B |
| `cache-adopt` | 1 derived cold, 1 hit and 0 derivations warm, same states |

The checker is exercised by `scripts/test/self-test-gate8kc.ts` (an honest tree and ten
mutations). The ctest `rs_texture_cache` (put/get, reopen, verify, corrupt, LRU, sharing, key
validation, parallel gets, compaction, the config parser) runs in `build-capture.sh`.

## Validation

- **Remote, full tier** (`scripts/remote-validate.sh --tier full`, run
  https://github.com/tfoxy/godot-scene-web/actions/runs/40097815840): 21/21 runs pass (pure,
  capture-build, the four crates, pnpm-test, bench-instr, native gates -1 to 5, 55 and 8, g7 gsw
  and web/rust file groups, g7live gsw and web/rust correctness groups), no known flake hit. The
  plan was not the narrow rule plus `native:gate8@*` the increment row expected: the call sites in
  `hooks.cpp`, `entry.cpp`, `rs_resource_log.h` and the calibration record are shared capture
  files, so the plan reaches every gate; the narrow rule covers only the new files. The tooling
  refused or skipped, as always, `lock-tests`, gate 6, the g7 timing live runs, g7x, the g1c/g1d/
  g2c/g5f/g55f/decode-cost timing groups, and g7live g7-1 (its own standing refusal). No timing is
  claimed or deferred-to by this increment.
- **Local** (development host): the pure self-tests (75 units, 696 s), `build-capture.sh` (30
  ctests), native gates -1 and 0 (hook plan unchanged at 79) and the whole of native gate 8, all
  groups, with `g8kc` 8/8.
- **Against main:** a build of main run on the same fixture produced a /9 recording that differs
  from this build's uncached one only in the `end` record's timing stats; `counters.json` is
  identical.

## Not done

- **UASTC entries**: G8ku had not landed. The cache is encoding-agnostic and `texture_cache.encodes`
  is wired (always 0 for now); the hookup is a paragraph in the design's "As built (G8kc)".
- **Warming from a pack** (K3 all / selective): not built. `--list` is the explicit-list form it
  will use.
- **Timing**: no rate or latency number is claimed; the cache saves the engine decode, whose
  cost g8t measured.
