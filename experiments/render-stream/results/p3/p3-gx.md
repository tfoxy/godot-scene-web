# P3-GX: GSW on the newest STS2 recording (2026-10-25)

**Not a GSW bug, and not a recording bug: the browser harness served a stale bundle.** Every GSW
replay of `p3st-a8-1` loaded the bundle the leg's static root was first linked to, a P3-ST
work-in-progress build that predates P3-CT. That build never fetches a canvas texture's diffuse, so
the spines stayed white and the menu blur read white. The fix is in the harness: a static root
now serves the bundle the leg asked for. Replayed through main's own bundle, GSW reaches menu 31.1,
map 53.3 and combat 25.0 dB on `p3st-a8-1`, against native's 31.1, 64.1 and 26.2.

## Root cause

- A browser receiver leg serves its bundle from the static root, through a `gsw-bundle` (or
  `web-bundle`) symlink to `--bundle`. `ensureLink` (`gate7-live-legs.ts`, `gate7-web-legs.ts`)
  and the device legs' copy of it kept a link that already existed.
- Gate runners give every run a fresh out directory, so they never reuse a link. C3's replay
  harness reuses each leg's data root as the static root, for every replay of that leg.
- `p3st-a8-1`'s root was first linked at 08:21 to `p3st-gsw-bundle`. Its wasm came from
  `rs_core_build sha=f7c548534106-dirty`: C3's commit plus P3-ST's uncommitted work, without
  P3-CT. Every later replay of that leg loaded this bundle: `gsw-p3st` (bundle `92dc8856`),
  `gsw-p3st-b`, and `gsw-main` (c780d463, `af4a301d`). Meanwhile `RS_RECEIVER_BUILD_SHA256` named
  the bundle each one asked for.
- `a8-2`'s root was first linked to P3-CT's bundle. So every later `a8-2` replay ran P3-CT's code
  too, including P3-ST's: this is why it "reproduced P3-CT's combat shot byte for byte".
- None of the listed candidates holds: ordering, adoption, the cut, P3-CAP's writer thread or a
  version bump. Both recordings have the same structure. The canvas textures 33, 37 and 40 arrive
  at seq 5 and are named one or two transactions later; every one is `created`, `v=2`, with an
  older diffuse.
- The offline core shows it. The same rs-core, driven natively through the page's call sequence
  (accept, `prepare`, `needed`, provide from the store, `apply`, with deferred digests and the
  page's delivery preferences), uploads 31, 36 and 39 at seq 6 and 1975 at 1931 on `p3st-cut.rs8`.
  The browser did not.
- A 10-transaction cut showed the browser difference within seconds:
  - through the static root's stale link, it uploaded 17 textures, with no diffuse;
  - with the link pointed at main's bundle, it uploaded 20, with 31, 36 and 39 at seq 6, exactly
    as native does.

**The menu at 2.97 dB** has the same cause. In the stale bundle, the blur rect (shader `16909a22`)
reads the white spine silhouettes, which is P3-ST's own "without P3-CT the native menu stays at
2.97" case. Nothing else covers the menu. With the right bundle, GSW's blur gives 31.1 dB, level
with native. This is the first STS2 confirmation of P3-ST's GSW back buffer and mip chain.

## Fix

- `linkTo(target, link)` in `scripts/lib/browser-harness.ts` points the link at the requested
  bundle and handles each case:
  - a symlink resolving elsewhere, dangling or not, is replaced atomically, and its old target is
    returned;
  - a real file or directory at the link is refused;
  - a concurrent leg creating the same link is accepted.
- Every bundle link uses it: `gate7-live-legs.ts` (`runBrowserReceiver`, which logs a replaced
  link to `launcher.out`), `gate7-web-legs.ts` (and its `sources/<gate>` link) and
  `gate7-device-legs.ts`.
- No receiver, core, capture or wire change. Gate runs are unaffected: their links are always
  fresh.

## Reproducer: `test/self-test-bundle-link.ts` (pure)

A real `HarnessServer` serves a private static root. Each case GETs `/gsw-bundle/build.json`, the
bytes a page would load:

- a fresh root serves bundle A;
- a reused root asked for B serves B, and `linkTo` returns A. The negative control is the old
  keep-first rule on the same state: it still serves A;
- linking B again is a no-op;
- a dangling link is replaced;
- a real directory at the link is refused and left untouched;
- a relative target is stored resolved.

It passes 13/13. With the replacement step mutated back to keep-first, it passes 6/13, failing the
reused-root, dangling and refusal cases. Deviation from the brief: the brief asked for a
stock-template fixture (`g8c`/`g55s`). There is no recording construction to capture, because the
same recording replays correctly through the right bundle, so the reproducer tests the harness
instead.

## STS2 confirmation (`p3st-a8-1`, no game launch)

`p3st-cut.rs8`, replayed through this worktree:

- native: `replay-native.sh`, out `p3gx-native`;
- GSW: `replay-gsw.sh`, main's bundle `8b818b7b` on a fresh port, out `p3gx-gsw`. Its
  `launcher.out` records the replaced link.

PSNR in dB against the in-process reference, min-max over the three shots per scene:

| scene | native (P3-ST) | GSW before (stale bundle) | native, this run | GSW, this run |
| ----- | -------------- | ------------------------- | ---------------- | ------------- |
| menu | 31.06-31.16 | 2.97-2.98 | 31.06-31.16 | **31.09-31.19** |
| map | 64.09-64.18 | 53.25-53.26 | 64.09-64.18 | 53.25-53.26 |
| combat | 26.16-26.19 | 16.81-16.86 | 26.16-26.19 | **24.97-24.99** |

- GSW uploads 92 textures, the same set as native. The diffuses 31, 36, 39, 1679 and 1975 to 1981
  are all resident.
- **Combat** trails native by 1.2 dB, the same margin as on `a8-2` (25.0 against 26.2). It has
  72k pixels over 16, against native's 35k.
- **Map** is unchanged at 53.3 dB, against native's 64.1. It is the only scene outside the 1-2 dB
  target. All its 1,623 pixels over 16 are the settings gear, at x 1835-1893 and y 12-67, max
  delta 22.
  - C3 filed this as gap 10, "edge filtering". It is not filtering. The gear (item 2604) carries
    material 599: shader 2 (`03ddc06b`), an HSV adjustment with `v = 0.9`.
  - GSW refuses that shader: `vertex() is not supported`. Its `vertex()` only copies `COLOR` into
    a varying, which the fragment multiplies back in. GSW therefore draws the gear without its
    material, slightly brighter.
  - The same refusal hits three combat shaders (30, 31 and 32, from seq 1930) and the screen reader
    `ed56752c`.
  - Item-space `vertex()` support (a varying fed from the interpolated `COLOR`/`UV`) is a
    `packages/effects` transpiler and executor feature. It is left for its own increment rather
    than folded into this harness fix.

## Validation

The plan reaches `pure`, gate 7's file groups and its correctness live groups on both browser
receivers. No native gate is reached: the diff is harness-only.

- **Smoke, local:** 5/5 runs pass: `pure` (813 s), `g7-gsw` and `g7-web-rust` g7-0, and the g7-1
  live groups.
- **Full tier, remote** (run 40202495086, five runs): 4/5 pass. This covers `pure` in six shards,
  every `g7-gsw` and `g7-web-rust` file group, and the g7-2, g7-5, g7-55 and g7-8 live groups on
  both browser receivers.
  - The one failure is `stale-coalesce@web` in `g7live-web-rust@g7-5`: step 3 coalesced only DF.
    That is the load-sensitive credit-loop phase lock (memory g5f-stale-coalesce), not a bundle
    link.
  - Rerun locally, `RS_VALIDATE_GROUPS=g7-5 --only g7live-web-rust`: it passes.
- **Refused runs, local** (the g7-1 live groups, full tier): `g7live-gsw` and `g7live-web-rust`
  both pass.
- **Not run:** the timing runs (`g7live-*-timing`, `g7x`), deferred to the milestone sweep. They
  share only the bundle link, which a fresh run directory never reuses.
- `self-test-bundle-link.ts`: 13/13, and 6/13 under the keep-first mutation.
- `tsc`: only the known errors in `gate2b-checks.ts`, `gate8-cache-checks.ts` and
  `g8kv-validate-ktx2.ts`.

## Evidence

`artifacts/render-stream/p3/p3-gx/` (main checkout, ignored):

- `compare.json`: the four receivers above;
- `contact-sheet.png`;
- `gear.png`: reference | native | GSW at the gear, 5x;
- `cut10-stale.json` and `cut10-fixed.json`: the 10-transaction cut's upload lists through the
  stale link and through main's bundle;
- `trace-p3st.txt`: the offline core's canvas-texture and upload trace.
