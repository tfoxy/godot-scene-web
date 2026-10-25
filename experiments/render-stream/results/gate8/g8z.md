# G8z: gate 8's manifests, summary and product hand-off

Increment G8z of [protocol/gate8-design.md](../../protocol/gate8-design.md) "Increments". It closes
gate 8 in documentation and in the same discipline gate 7 closed with (G7z, Q11): a feature
manifest per receiver kind, judged by the seven manifest checks against the runs that back it.

## What it adds

- **`protocol/features/render-stream-8/{native,web-export,gsw-canvas}.json`**, schema
  `render-stream-features/2`, protocol `render-stream/8`, `stream_protocols` 6 to 9. Every file has
  gate 7's 123 entry ids plus nine, and three of gate 7's change meaning at /8:
  - new: `delivery.stream_protocol_8`, `delivery.http_content_coding`,
    `delivery.reverse_proxy_fronting`, `payload.host_decoded_block_textures`,
    `payload.float_texture_formats`, `control.adopted_pre_arm_resources`,
    `viewport.late-presentation-size`, `delivery.texture_variant_block`,
    `delivery.texture_variant_uastc` (nine);
  - changed from `unobserved` to `supported`: `payload.compressed_and_float_texture_formats`,
    `control.late-join-adoption`, `material.late-join-materials`;
  - `limits.receiver` gains the float formats in `texture_formats` and `texture_encodings` (what the
    receiver lists in its /9 hello).
  `collected.json` holds the receiver blocks (build sha, platform, WebGL compression extensions)
  that `make-features.ts --collect --protocol 8` derives from the quoted runs.
- **`scripts/lib/feature-evidence-8.ts`**: the editorial content (`SPECS_8`, `OVERRIDES_8`) and the
  quoted runs. Gate 7's runs are carried (re-rooted under `render-stream/gate7/`) except the keys
  gate 8 reruns: native gate 8, `g7-8` file and live on both browsers, and live `g7-2` (G8kz's
  coding checks). The evidence root is `<main checkout>/artifacts`, because /8 evidence spans both
  gates.
- **`scripts/check-gate8z.ts`**: Q11's seven checks (`manifest-check`, `-matches-session`,
  `-evidence`, `-no-substitution`, `-refused`, `-matches-hello`, `-device-target`) plus the
  report-only `evidence-builds`, through `lib/gate7z-checks.ts` with `PROFILE_8`. The profile
  generalizes gate 7z's checker in three ways: the quoted runs and primary build are the profile's;
  `manifest-matches-hello` reads only runs flagged `hello` (a carried gate 7 run cannot have sent a
  file that did not exist); and native gate 8's report (`render-stream-gate8-report/1`) is indexed
  as group `gate8`, kind `native`, with its `...-gsw` and `...-web` checks (the legs the gate 8
  runner drives itself: g8kp's GSW legs, g8ku's web legs) also indexed under those kinds.
- **Hello plumbing**: `run-gate7.sh --manifest-hello --manifest-features 8` sends the /8 files'
  sha256 from the browsers' live hellos; `RS_G8_MANIFEST_HELLO=1 run-gate8.sh --legs g8l` sends the
  native file's from the native g8l receivers (run again after the manifests are final, quoted as
  `g8l-hello@native`).
- **`scripts/test/self-test-gate8z.ts`** (pure, 41 checks, synthetic evidence root): the /8 ids
  contain gate 7's; shape rules; no browser entry cites another kind; GSW's `uastc` is
  supported and listed in its encodings; device targets are `unverified`; the checks pass on an honest synthetic root and
  fail on a failed cited check, a stale file and a wrong hello sha, and ignore a carried run's /7
  hello; and every `GRC_*` name in the hand-off note appears in `capture/src/`.
- **[protocol/gate8-product-handoff.md](../../protocol/gate8-product-handoff.md)**: the product
  hand-off (environment, delivery and cache settings, what the seat opts out of, P1 to P3, F1 to
  F3).
- **[results/gate8.md](../gate8.md)** and the README's gate 8 row.

## Manifest content by receiver

| | native | web-export | gsw-canvas |
| --- | --- | --- | --- |
| /8 live and file | supported, exact | supported, exact | supported, exact |
| host-decoded block textures | exact | delta1 | delta1 |
| float formats | exact | delta1, sampled natively | **quantized**, caveat `float-texture-quantized` |
| adoption (items, resources, materials), late presentation size | exact | delta1 | delta1 |
| HTTP content coding | declared-unverified | supported | supported |
| reverse-proxy fronting | supported | supported | supported |
| `block` variant | exact | delta1 (BC only, G8kwh) | delta1 (BC only) |
| `uastc` variant | exact (engine transcode oracle) | exact | delta1 (G8kb: worker transcode, BC7 blocks equal the oracle's) |
| device targets | not-applicable | unverified | unverified |

Deviations from gate-8 design's manifest note (results/gate8/g8g.md "Feature manifests"): the
exactness value `quantized` is new (`FeatureExactness2`), since GSW's float handling is neither
exact nor a pixel band; GSW's `uastc` takes
`delta1` (blocks equal the oracle's on its target, pixels within channel 1 of native's); and gate 7's device-target rows are not re-derived
(gate 8 ran no phone legs).

## Not proven here

Rows quoted from gate 7 describe build 6a454065, not the gate 8 build; `evidence-builds` lists them.
The session check (`manifest-matches-session`) compares the g6a captures' feature lists to
each file, as gate 7's did: no gate 8 fixture exercises every op, so it cannot judge /8 lists, and
the /8 session feature lists equal /6's (G8w changed none).

## The closing run

Build `ea402b95` (main after G8kwh), development host (RTX 2060), all through
`validate-increment.sh --tier full` or the runner it names. Evidence root `<main checkout>/artifacts`,
run directories under `render-stream/gate8/g8z/`.

| run (key in `feature-evidence-8.ts`) | what | result |
| ------------------------------------ | ---- | ------ |
| `pure` | the full tier's pure self-tests (`--only pure,native-rust-gate8`) | rc=0 (667 s) |
| `native-gate8` | `run-gate8.sh`, every group, sabotage legs | rc=0 (428 s); 135 cited checks pass |
| `g7-gsw-g8`, `g7-web-rust-g8` | `run-gate7.sh --legs g7-8`, file halves (`RS_VALIDATE_GROUPS=g7-8`) | rc=0 both |
| `session@native` | `run-gate6.sh --legs g6a`: the scene, animate and refused captures with their recordings (gate 7's gate 6 run lost its recordings to the retention policy; the other g6 groups were not rerun, so this run backs only the session check) | 32/38: the six not-run groups, nothing else |
| `native-g8l-hello` | `RS_G8_MANIFEST_HELLO=1 run-gate8.sh --legs g8l` | rc=0 |
| `live-g8` | `run-gate7.sh --live --legs g7-8 --manifest-hello --manifest-features 8`, both browsers | rc=0 |
| `live-g7-2-gsw`, `live-g7-2-web` | `run-gate7.sh --live --legs g7-2 --receiver <k> --manifest-hello --manifest-features 8` | rc=0 both |

`check-gate8z.ts`: 24/24 rows ok (the three `evidence-builds` rows are reports). Evidence checks
quoted: native 135, web export 118, GSW 122. The files' sha256, frozen before the live runs
(`manifest-shas-frozen.txt`) and carried by their hellos: native `8cb5f0ba05d3` (7 hellos), web export
`62e7813a6561` (24), GSW `db450b89f6c3` (24). Counts of `supported` entries: native 75, web export 78,
GSW 78 of 132; the rest are 20 `typed-unsupported` each, 26 to 29 `unobserved`, 7 or 8
`declared-unverified`, and the web export's one `receiver-typed`.

What the main commits since G8ku changed in the files:

- GSW `delivery.texture_variant_uastc`: `supported`, `delta1` (G8kb, G8kb2), and `uastc` in its
  `texture_encodings`; its `block` entry cites the g31 only as an unrun block-source leg.
- Web export `delivery.texture_variant_block`: `supported`, `delta1` (G8kwh: `delivery-select-web`,
  `delivery-pixels-web`, BC only); its `uastc` entry cites the pixel and masked checks.
- Native and web `uastc` notes: the `decoded` fallback (G8kf), the prepare warming, `delivery-pending`.
- Tooling: `manifest-matches-session` reads the profile's `session@native` run; the run walks in
  `gate7z-checks.ts` and `make-features.ts` visit a real directory once (the gate 8 runs link each
  other's directories, and the walk was exponential on them).

Device targets stay `unverified`: G8kb's g31 numbers are bench and replay measurements, not g7-dev
verdicts. Timing checks are out of scope (the pre-release sweep).
