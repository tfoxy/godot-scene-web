## G8kf result (2026-10-24)

G8kf ([protocol/texture-delivery-design.md](../../protocol/texture-delivery-design.md) Q3, Q5, D9
and "As built (G8kf)") passes: the four G8ku follow-ups work, with no wire change.

1. `scripts/prepare-textures.sh` warms UASTC entries. A session on the prepared directory runs 0
   encodes and serves all six uastc variants from the cache (`prepare-uastc-warm`).
2. `delivery-pending` is published (opt-in, `GRC_TEXTURE_PENDING=publish`), and the native
   receiver and the web export recover from it (`delivery-pending`).
3. `delivery-transcode-failed` falls back to `decoded` on the native receiver and the web export
   (`delivery-fallback`, sabotage `corrupt-ktx2`).
4. The web export states `gpu_formats` (`s3tc,bptc,rgtc,etc2` here) and the BC `block` variants it
   is sent are the ones D3 picks (`delivery-select-web`, upload list only; pixels are G8kwh, below).

### What landed

| part | where |
| ---- | ----- |
| UASTC prepare: `GRC_TEXTURE_ENCODE_DRAIN` (end-of-stream drain, bounded queue), the /9 sink, `--no-uastc`, `--encode-workers`, `--uastc-level`, `.res` list entries | `capture/src/entry.cpp`, `rs_texture_delivery.*`, `rs_texture_worker.*` (`wait_outstanding_at_most`), `scripts/prepare-textures.sh`, `prepare_textures.gd`, `fixtures/gate8-basis/gate8_basis.gd` (`RS_FIXTURE_DUMP_RES_DIR`) |
| `delivery-pending`: `GRC_TEXTURE_PENDING`, pending entries, `resolve_pending`/`service_pending`, derived unsupported entries | `capture/src/rs_mirror.*`, `rs_texture_worker.*`, `entry.cpp` |
| planner: replay of items that skipped a command for a texture an apply now uploads | `rs-core-capi/src/plan.rs` (`skipped_items`) |
| fallback: `refused` variants, `rsc_refuse_variant`, `pretranscode`, `screen_variants`, the fault knob | `rs-core/src/delivery.rs`, `rs-core-capi/src/{core,lib}.rs`, `receiver/ext/rs_core_ext.cpp`, `receiver/rs_rust_applier.gd`, `receiver/receiver.gd`, `capture/src/rs_texture_basis.*` (`corrupt-ktx2`) |
| gate 8 | `scripts/run-gate8.sh`, `scripts/gate8-delivery-tool.ts`, `scripts/lib/gate8-{basis,cache,delivery}-checks.ts`, `scripts/test/self-test-gate8kc.ts` |

### Checks (development host, RTX 2060; g8ku + g8kc + g8kp together, 31/31)

| check | result |
| ----- | ------ |
| `prepare-uastc-warm` (g8kc) | pass: the prepare run ran 7 encodes (the cold live session's count, the `updated` texture's first content included) and stored 7 uastc rows; the next session ran 0 encodes, 0 misses, 0 puts and published the cold session's 6 uastc variants, all from the cache |
| `delivery-pending` (g8ku) | pass: 8 textures pending in the first transaction (250 ms jobs), all `ok` at `version + 1` (seq 12) with the synchronous capture's final table but for versions; both sinks validate; native (upgrade) and web upload nothing while pending; the native shots equal the reference (step 0) and the oracle's blocks (step 1) exactly |
| `delivery-fallback` (g8ku) | pass: 6 KTX2 stored, each hashing to its name; native (upgrade) and web both count 5 fallbacks and 5 failed transcodes, upload only `decoded` (`block` for the DXT1 source) and finish ok; native shots equal the reference exactly |
| `delivery-select-web` (g8kp) | pass: the web export replaying the /9 passthrough recording states `s3tc,bptc,rgtc,etc2`; 11 `block` and 3 `decoded` uploads, each the payload D3 picks under its own hello |
| every other g8ku, g8kc and g8kp check | pass |

Scoped runs, full tier and remote run: see below.

### Deviations from the brief

- `delivery-pending` follows render-stream-9.md's definition (the async path's missing *decoded*
  hash), not "a requested variant still encoding": a variant still encoding stays listed by
  omission, since a pending entry would withdraw the usable `decoded` payload.
- `delivery-pending` is opt-in (`GRC_TEXTURE_PENDING=publish`, default `hold`), because it turns a
  worker recording from a frame-for-frame subset of the synchronous one into one with pending
  frames, which the frame-exact legs cannot take. No golden-9 change: the spec's golden already
  has a pending entry, and the recovery is exercised by the capture leg and both validators.
- Only a *transcode* failure falls back. A hash mismatch (`perturb-ktx2`) and a shape mismatch
  still end the replay.
- The sabotage that makes the transcode fail is a new fault, `GRC_TEXTURE_ENCODE_FAULT=
  corrupt-ktx2` (level 0's Zstandard frame damaged before hashing); `perturb-ktx2` fails hashing.
- The planner needed a fix beyond the brief: an item that skipped a command for an undrawable
  texture was never revisited when the texture returned.
- `GRC_TEXTURE_ENCODE_WAIT_FRAME` now also waits for the texture workers first.

### Open: web `block` pixels (owner G8kwh)

`delivery-select-web` checks only the upload list: that each upload is the payload D3 picks under
the hello the web export stated. It does not compare pixels, and web `block` pixels do not work:
the export states `etc2` (Godot sets `etc2_supported` unconditionally on web) although the WebGL
context has no ETC2 extension, so the leg's console log shows `WebGL: INVALID_ENUM:
compressedTexImage2D` and the picture is wrong; a non-4-aligned BC level 0 (`npot`, 150x110) is also
refused by WebGL. G8kwh will state only what the context can upload and add the alignment rule
(texture-delivery-design.md, "Deferred, with owners"). Nothing here claims otherwise.

### Out of scope

GSW's transcoder, its fallback and its apply of a pending recovery (G8kb); the g31; ETC1S (G8ke);
all-pack and selective-pack warming (deferred library feature); a live leg at
`GRC_TEXTURE_PENDING=publish`; gate 8 manifests (G8z); receiver-driven encode priority. Timing runs
(gate 6, `g7live-*-timing`, g7x, lock-tests, gate 8 `decode-cost`/`worker-hook-time`) are deferred to the
pre-release delta sweep.

### Validation record

- Local, development host: gate 8 `g8ku,g8kc,g8kp` 31/31; `validate-increment --tier full --only
  native-rust-gate8` rc=0 (418 s); `g7live-gsw` and `g7live-web-rust` (g7-1, refused remotely) rc=0;
  `receiver_selftest.gd` 52 checks ok.
- Remote full tier on 75139c30 (rebased on G8kb2): https://github.com/tfoxy/godot-scene-web/actions/runs/40142291483
  (and an earlier run on the G8kb base, 40135559145). Every job passed except `native-rust-gate8`,
  whose `validate-increment` step failed on the hosted runner (the same job fails on unchanged main
  06c453ce, run 40139405185; it passes locally on the NVIDIA host). The jobs for `native-rust-gate8`,
  `g7-gsw@g7-8` and `g7-web-rust@g7-8` then hung in "Trim artifact" and were cancelled; both g7-8 jobs
  had a passing `validate-increment`. The failing checks' messages were not recoverable (job logs
  unavailable after the cancel); rerun 40147325147 failed the same way. Timing runs are deferred.
