## Gate 7b result (2026-10-15)

G7b ([protocol/gate7-design.md](../../protocol/gate7-design.md) "G7b", Q4, Q7, Q8, D34) replays every
file receiver leg of gates 1 to 6 in the G7e web export. The web export still runs the GDScript
decoder (D34). Each gate is judged by its own unforked checker. **Six of the seven groups pass. g7-5
fails on one finding:** Godot 4.5.1's GLES3 index-buffer update is invalid on WebGL 2, and the web
receiver now refuses that call with a typed reason.

P-W1 ("W = N byte for byte") **held only on flat colours.** On gates 0, 1 and 3, all 296 shots are
byte-identical to native. Every other gate differs, but each differing pixel is one of two classes,
both explained from the source and both at most one level per channel (Finding 1). Q7's band,
recorded "As built", is exactly those two classes. Every web leg that differed from native was
replayed a second time on the same build, and each repeat was byte-identical to its first run.

The run used one build: the branch rebased onto `main` `5d5ad294`, with G7n's capture rebuilt
(20/20 ctests). Its sources are the native gate runs listed below. After the run, `main` gained
G7a (`b499932b`). G7a changes no receiver or capture file and adds one fixture-root JSON that no
Godot project loads (`fixtures/gsw-tolerance.json`), so the runs were not repeated. The merged
`check-gate7.ts` re-judged the same evidence with the same verdicts, apart from
`source-run-valid`. That check failed only on its `git_commit` field, because the sources were
made at the pre-merge commit (`g7b-r1/result-recheck-post-rebase.json`). The command:

```bash
pnpm render-stream:gate7 -- --legs g7-0,g7-1,g7-2,g7-3,g7-4,g7-5,g7-55,g7-6,g7-dev,g7-bench \
  --source gate0=<n>/gate0,gate1=<n>/gate1,gate2=<n>/gate2,gate3=<n>/gate3,gate4=<n>/gate4,\
gate5=<n>/gate5,gate55=<n>/gate55,gate6=<n>/gate6
```

Evidence (ignored): `artifacts/render-stream/gate7/g7b-r1/` (2.6 GB). The native sources are in
`artifacts/render-stream/gate7/g7b-native2/`, and the g7-bench rerun is in `…/g7b-r1-bench-rerun/`.

| Group | Legs replayed (sabotages) | Gating checks | Shots identical to native | Differing shots: readback-only / with delta1 / other | Result |
| --- | --- | --- | --- | --- | --- |
| g7-0 (G7e's, rerun) | 9 | 20/20 | 25/25 | 0 / 0 / 0 | PASS |
| g7-1 | 11 (7) | 26/26 | 151/151 | 0 / 0 / 0 | PASS |
| g7-2 | 14 (7) | 29/29 | 46/108 | 53 / 9 / 0 | PASS |
| g7-3 | 14 (8) | 32/32 | 120/120 | 0 / 0 / 0 | PASS |
| g7-4 | 20 (8) | 70/70 | 10/222 | 0 / 212 / 0 | PASS |
| g7-5 | 18 (11) | 36/45 | 44/180 | 18 / 82 / 36 (web-refused mesh legs) | **FAIL** (Finding 2) |
| g7-55 | 21 (9) | 45/45 | 120/210 | 90 / 0 / 0 | PASS |
| g7-6 (scene, animate, refused, HD native and half) | 19 (8) | 31/31 | 0/285 | 0 / 285 / 0 | PASS |

The other groups in the same run:

- G7h harness: 7/7.
- g7-dev: 12/12.
- g7-bench: 16/17 in the run. The failing check was `bench-matches-g6c`: the native scene-full
  decode mean was 7 260 µs against G6c's 6 283 ±15 %, with G7a's compile running at nice 19 beside
  it. The one allowed rerun (`g7b-r1-bench-rerun/`) failed the same check by more: 10 039 µs
  decode and 1 418 µs apply. At that point the desktop was not quiet: load average about 8, with a
  Slay the Spire 2 process and a C# compiler server at nice 0. G7b's receiver change touches only
  the web branch of `_apply_meshes`, not decode. So this is a load finding, not a G7b regression,
  and the check needs a rerun on a quiet machine.

The gating checks of each gate are of two kinds:

- the gate's own checks that read a replayed leg, suffixed `@web`;
- gate 7's checks: `source-run-valid`, `browser-provenance`, `console-clean`,
  `evidence-complete`, `applied-equals-native`, `compositor-equals-readback`, `pw1-classes` and
  `web-repeat-identical`.

`compositor-equals-readback` was exact on 23 legs across g7-1 to g7-6, including both HD presentations: 1920×1080 and
960×540 backing stores at DPR 1, sized by the shell from the native leg's `--resolution`. It was not
applicable to three legs whose last shot is not the exit state (gate 5's mesh, gate 5.5's shader and
shader-refused).

**How a gate is judged.** `lib/gate7b-adapters.ts` discovers each source run's file receiver legs.
It then runs the gate's own CLI checker on four views of the source: native, blank, web and
banded (scripts/README.md "Gate 7 files, legs and criteria (g7-1 to g7-6 web export, G7b)"). A check
whose verdict differs between the native and blank views reads a replayed leg. It is reported
`@web`, and every other check judges only the source run. No leg list and no check list is written
by hand.

The banded view is the web legs with every shot whose differing pixels all fall in the band
replaced by the native shot. The gate's own budgets then judge N's pixels, which W equals within
the band. `raw-web-checks` (reported) lists the checks that fail on the raw web shots, and every
one of them fails only on band pixels: g7-2 12, g7-4 29, g7-5 21 (9 of them the mesh refusal), g7-55
11 and g7-6 21.

### Findings

1. **P-W1 fails only through two pixel classes, both from the source and both at most one level
   per channel.** The root target is RGB10_A2 on both platforms
   (`drivers/gles3/storage/texture_storage.cpp:2144-2149`), but G7e's at-risk readback really does
   differ (`:1104-1198`):
   - **`readback`**: one 10-bit value v reads back as different bytes. Natively,
     `glGetTexImage(GL_RGBA, GL_UNSIGNED_BYTE)` on NVIDIA's desktop GL returns `floor(v/4)`. On the
     web, the GLES path's shader copy into RGBA8 plus `glReadPixels` returns `round(v·255/1023)`.
     Gate 6's background, for example, is v = 143: 35 natively and 36 on the web, which is 225 477
     channel values in one 1920×1080 shot. On gate 6 HD's seq 13, the rendered reference agrees
     with native on all 91 183 differing pixels. The web canvas itself agrees with the web readback, since `compositor-equals-readback`
     is exact on 23 legs. Values on gates 0, 1 and 3's 0.2 grid give the same byte both ways
     (v = 205 gives 51 and 51), which is why those gates stay byte-identical, and why G7e's gate 0
     could not see this.
   - **`delta1`**: no single v explains the pair, but every colour channel is within 1 and alpha is
     equal. These are translucent blends and AA-feather vertex-colour edges (gate 6 HD's first one
     is the edge pixel (217,14): 208/169/90 natively, 208/168/90 on the web). They are rendered
     once by NVIDIA's GL driver and once by ANGLE over Vulkan on the same GPU. G7c measured that
     ANGLE/Vulkan converts the source colour to target levels before blending (memory
     g7c-gpu-blend-conversion-facts), so the 10-bit result can differ by one level. Such pixels
     occur on gate 2's canvas legs (66 per shot at most), gate 4's text (172), gate 5
     (10) and gate 6 (169 at 640×360, 1 468 at HD). None occur on gate 5.5.

   Q7's band is therefore `readback` ∪ `delta1`. It is no wider than Q7's `delta1` ceiling, and
   both classes are explained above from engine and ANGLE behaviour. `pw1-classes@web` gates that no
   other pixel exists, apart from Finding 2's refused legs. `pw1-web-equals-native` stays a report.
2. **Godot 4.5.1 cannot update a mesh's index buffer on WebGL 2, so the web receiver refuses that
   call (typed).** `MeshStorage::mesh_surface_update_index_region` binds the index buffer to
   `GL_ARRAY_BUFFER` (`drivers/gles3/storage/mesh_storage.cpp:591-593`). WebGL 2 forbids rebinding
   a buffer that was first bound as an element array buffer. The update is dropped, and Chromium
   logs `WebGL: INVALID_OPERATION: bindBuffer: element array buffers can not be bound to a
   different target`. Desktop GL allows the rebind, so native is correct.

   The receiver (`rs_applier.gd`, web only) now skips that one call. `applied.json` records
   `{seq, name: "mesh_surface_update_index_region", reason: "web-index-region-update", mesh,
   surface}` in `unsupported`, which is never a silent fallback. Gate 5's mesh fixture changes RM's
   index buffer at seq 41, so on the web RM keeps its old triangles: 936 px from step 4 on.

   The checks that fail are these nine (`console-clean` is clean now, because the call is never
   made):
   - gate 5's `leg-class-receiver-mesh{,-patch,-inline}`, `receiver-vs-reference-mesh`,
     `receiver-mesh-uploads` and `fresh-without-redraw-receiver`;
   - three mesh sabotage legs, which now classify `unsupported` instead of `pixel-mismatch`.

   A receiver-side rebuild (`mesh_clear` and every surface again) would draw the right triangles.
   It would change the upload record, and it would reset the surface AABB that D8 keeps, so it is
   not done here. The fix belongs in the engine, or to G7xw's native-code adapter, which can update
   index buffers through `GL_ELEMENT_ARRAY_BUFFER`.
3. **Some native-only checks of gate 2 cannot be asked of a browser.** `fresh-cache` and
   `warm-cache` judge a receiver-side cache directory, which Q4 makes native only. The web reports
   `cache.mode: "http-cache"`. Both checks are reported `not-applicable` (non-gating), and the two
   warm-cache legs (`receiver-warm`, `sabotage-receiver-ignore-cache`) are typed
   `native-only-warm-cache` and not replayed.

### Legs not replayed (typed, never silent)

| Reason | Legs |
| --- | --- |
| `native-only-trace` (strace of the native process) | the `receiver-headless-trace` legs of gates 1 to 5 (10) |
| `native-only-editor` | gate 1's `receiver-typecheck/minimal` |
| `native-only-warm-cache` | gate 2's `receiver-warm`, `sabotage-receiver-ignore-cache/receiver` |
| `live-derived` (replays a live receiver's tap) | gates 1 and 2's `live-replay` |

The web replays of natively headless legs (five of gate 2's) ran rendered, as G7e's did (D11 note).
Each one classified as it does natively.

### Native gates on the changed receiver (rebased build)

These runs are in `artifacts/render-stream/gate7/g7b-native2/` and double as the sources:

| Gate | Checks |
| --- | --- |
| −1 | 29/29 |
| 0 | 24/24 |
| 1 | 66/66 |
| 2 | 85/85 |
| 3 | 56/56 |
| 4 | 185/185 |
| 5 | 116/116 |
| 5.5 | 130/130 |
| 6, `--legs g6a,g6h,g6b,g6l,g6s,g6c,g6z` | 153/154 |

The one gate 6 failure was `rate-achieved-rate-30` (53.27/s outside [57, 61]), timing-sensitive
under G7a's background compile. The one allowed rerun of the g6c group passed all 41 of its checks
(`…/g7b-native2-g6c-rerun/`). Before the rebase, the same set was −1 29/29, 0 24/24, 1 66/66,
2 85/85, 3 56/56, 4 185/185, 5 116/116, 5.5 130/130 and 6 154/154
(`…/g7b-native-prerebase/`). Natively the receiver change is inert: the refusal list is always
empty there.

### For G7xw (the dlink adapter)

- **Harness.** `run-gate7.sh --legs g7-1,…,g7-6 --source …` with `--bundle <its preset's bundle>`
  replays the same legs. Q4 requires G7xw to reproduce G7b's legs byte for byte, and
  `<out>/gate<N>/web/<leg>/shots` plus `applied.json` from this run are the GDScript oracle.
  `gate7-tool.ts web-legs --only <substr>` replays a subset.
- **The band.** G7xw compares web against web. Both run the same engine, ANGLE path and readback,
  so the prediction is byte equality with G7b's shots; the `readback` and `delta1` classes do not
  apply between the two. `classifyShot` and `pw1-classes` still judge G7xw against native.
- **Finding 2.** It is G7xw's to close or to keep typed. A native-code adapter can upload index
  data through `GL_ELEMENT_ARRAY_BUFFER` itself, or it can keep `web-index-region-update`.

### What G7b does not prove

It does not cover live mode in a browser (G7l, and G7g for g6l), the GSW receiver (G7a, G7t, G7s),
any phone, warm startup or memory over time (G7k), or the web export's speed. G7m measured that
speed and found it over budget on the g31.

