// Gate 8's gsw legs, receiver checks and Q7 plan (G8g, gate8-design.md "Increments" G8g; gate7-design.md
// Q7, Q8). Kept beside lib/gate7-gsw.ts, which merges them into its per-gate tables (`gate8`), as
// gate 5.5's lib/gate7-gsw-55.ts is: a new gate 8 file leg (G8kp's and G8kb's delivery legs) is one
// entry in GATE8_LEGS, plus its check ids in GATE8_RECEIVER_CHECKS when it adds a check.
//
// The file legs are every file-mode receiver leg of the gate 8 groups g8t (host decode), g8f (float
// payloads), g8a (adoption, with G8r's lazy resources and faults), g8h (presentation size), g8m
// (materials and shaders) and g8c (P3-CT: canvas-texture diffuses), replayed from a native gate 8
// source run (D21: run-gate8.sh --legs g8t,g8a,g8h,g8f,g8m,g8kp,g8ku,g8c,g8cg,g8w11) and judged by
// check-gate8.ts's own checks (`@gsw`). G8kb adds the texture-delivery groups: g8kp's receiver
// legs (judged by g8kp's checks through the band), g8ku's perturbed-KTX2 sabotage, and four
// GSW-only g8ku legs judged by lib/gate7-gsw-g8-checks.ts (GSW transcodes in its own worker to its
// own context's D14 target). g8l's live legs are the live half's (lib/gate7-live.ts). CG1 added g8cg
// (gate8-cg: clip_children, CanvasGroup, BackBufferCopy on /10); since CG3 GSW composites that
// state itself (render-stream-10.md "Receivers"), so every g8cg receiver leg, the /9 negative
// control and both receiver sabotages included, replaces the native one and g8cg's own checks judge
// it through the band.

import { existsSync, readdirSync, symlinkSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import { decodePngRgba } from "./gate-minus1-checks";
import type { GswLegDef, NotApplicable } from "./gate7-gsw";

/** The honest full-sink receiver of each fixture: its compositor screenshot is taken (Q7). */
export const GATE8_COMPOSITOR_LEGS = [
  "receiver",
  "g8f/receiver",
  "g8a/late/receiver",
  "g8h/late/receiver",
  "g8m/late/receiver",
] as const;

const leg = (l: string): GswLegDef => ({
  leg: l,
  replaces: true,
  ...((GATE8_COMPOSITOR_LEGS as readonly string[]).includes(l) ? { compositor: true } : {}),
});

export const GATE8_LEGS: GswLegDef[] = [
  // g8t (gate8-tex: S3TC/BPTC/RGTC and ETC2/ASTC decoded on the host)
  leg("receiver"),
  leg("receiver-patch"),
  leg("sabotage-perturb-decode/receiver"),
  // g8a (gate8-adopt, G8a and G8r)
  leg("g8a/born/receiver"),
  leg("g8a/late/receiver"),
  leg("g8a/late/receiver-patch"),
  leg("g8a/sabotage-adopt-skip-state/receiver"),
  leg("g8a/sabotage-adopt-no-redraw/receiver"),
  leg("g8a/sabotage-adopt-skip-layers/receiver"),
  leg("g8a/fault-no-resources/receiver"),
  leg("g8a/fault-atlas-from-dummy/receiver"),
  // g8h (gate8-size)
  leg("g8h/born/receiver"),
  leg("g8h/late/receiver"),
  leg("g8h/late/receiver-patch"),
  leg("g8h/late-observe/receiver"),
  leg("g8h/sabotage-size-before-adopt/receiver"),
  // g8c (gate8-ct, P3-CT: images drawn only through a CanvasTexture's diffuse)
  leg("g8c/receiver"),
  leg("g8c/receiver-patch"),
  // g8cg (gate8-cg, CG1; CG3: GSW composites canvas groups and back-buffer copies). The receiver
  // sabotages are the native ones (RS_RECEIVER_SABOTAGE drop-canvas-group, full-backbuffer-copy),
  // which GSW's applier implements on the same state.
  leg("g8cg/receiver"),
  leg("g8cg/receiver-patch"),
  leg("g8cg/late/receiver"),
  leg("g8cg/receiver-v9"),
  leg("g8cg/sabotage-drop-canvas-group/receiver"),
  leg("g8cg/sabotage-full-backbuffer-copy/receiver"),
  // g8w11 (W11d, render-stream-11.md "As built (W11d)"): the native receiver's /11 legs on W11b's
  // captures (capture-scale, gate6-scene animate, gate5-mesh at /11 and their /10 twins) and
  // W11c's receiver sabotages, which GSW implements on the same names; g8w11's native checks judge
  // GSW's replay of them (GSW against native on /11). W11e: the web half replays them too
  // (gate7b-adapters.ts GATE8_FILE_GROUPS).
  leg("g8w11/scale/receiver"),
  leg("g8w11/scale/v10/receiver"),
  leg("g8w11/scale/off/receiver"),
  leg("g8w11/scene/receiver"),
  leg("g8w11/scene/v10/receiver"),
  leg("g8w11/scene/off/receiver"),
  leg("g8w11/mesh/receiver"),
  leg("g8w11/mesh/v10/receiver"),
  leg("g8w11/scene/sabotage-stale-dynamic-rx/receiver"),
  leg("g8w11/scene/off/sabotage-no-prune/receiver"),
  leg("g8w11/scene/off/sabotage-evict-carried/receiver"),
  leg("g8w11/scale/off/sabotage-ignore-released/receiver"),
  // g8mm (PM3, render-stream-11.md "As built (PM3)"): PM2's native receiver legs on fixtures/gate8-mm
  // (/11 full and patch sinks, the /10 negative control, the receiver sabotage undrawn-multimesh
  // that GSW implements on the same name, and PM1's sabotaged patch sinks), judged by g8mm's own
  // checks through the band and by lib/gate7-gsw-g8-mm-checks.ts against the unarmed reference;
  // plus the GSW-only no-flipbook sabotage (the particles_animation template drawn as its builtin).
  leg("g8mm/receiver"),
  leg("g8mm/receiver-patch"),
  leg("g8mm/receiver-v10"),
  leg("g8mm/sabotage-undrawn-multimesh/receiver"),
  // UIT: the pre-UIT receiver (every /11 use_identity_transform ignored), GSW on the same name.
  leg("g8mm/sabotage-ignore-identity-transform/receiver"),
  leg("g8mm/sabotage-perturb-instance/receiver-patch"),
  leg("g8mm/sabotage-stale-buffer/receiver-patch"),
  {
    leg: "g8mm/sabotage-gsw-no-flipbook",
    from: "g8mm/receiver",
    env: { RS_RECEIVER_SABOTAGE: "no-flipbook" },
    replaces: false,
  },
  // g8pt (PM6b, render-stream-12.md "As built (PM6b)"): PM6a's native receiver legs on
  // fixtures/gate8-pt (/12 full and patch sinks, the receiver sabotages undrawn-particles and
  // ignore-particle-emits that GSW implements on the same names, and PM5's drop-restart patch
  // sink). GSW simulates every emitter itself (packages/effects GodotGpuEmitter), the approximate
  // tier: g8pt's own checks judge it against the unarmed reference through the band, with
  // expected.json's bands (pt-lifecycle structural, pt-coverage banded, pt-outside-exact exact).
  leg("g8pt/receiver"),
  leg("g8pt/receiver-patch"),
  leg("g8pt/sabotage-undrawn-particles/receiver"),
  leg("g8pt/sabotage-ignore-particle-emits/receiver"),
  leg("g8pt/sabotage-drop-restart/receiver-patch"),
  // PFB (render-stream-12.md "As built (PFB)"): fixtures/gate8-ptc's Forward+ capture, whose
  // particles material colours the host linearized; GSW's emitters read them so (rs-core
  // particles::describe), and `gl-particle-colors` is the pre-PFB GSW on the same name.
  leg("g8pt/ptc/receiver"),
  leg("g8pt/ptc/sabotage-gl-particle-colors/receiver"),
  // PSE (render-stream-12.md "As built (PSE)"): the same capture's switched cells (one process
  // shader whose emission shape is a uniform, two materials); GSW keys each material by its own
  // uniforms, and the GSW-only sabotage `shared-process-key` is the pre-PSE GSW (every material
  // keyed by the shader's builtin, the first material's). The native no-subparticle-stub leg is
  // not replayed: GSW simulates from the key and never compiles the host's process code.
  {
    leg: "g8pt/ptc/sabotage-gsw-shared-process-key",
    from: "g8pt/ptc/receiver",
    env: { RS_RECEIVER_SABOTAGE: "shared-process-key" },
    replaces: false,
  },
  // g8f (gate8-tex's float scene: GSW quantizes every float payload to RGBA8, rs-core's rule)
  leg("g8f/receiver"),
  leg("g8f/receiver-patch"),
  leg("g8f/sabotage-perturb-decode/receiver"),
  // g8m (gate8-mat)
  leg("g8m/born/receiver"),
  leg("g8m/late/receiver"),
  leg("g8m/late/receiver-patch"),
  leg("g8m/fault-no-include-path/receiver"),
  // G8kb: g8kp (gate8-tex at /9 passthrough: D3 picks `block` where the context has the family,
  // `decoded` under the mask), judged by g8kp's own receiver checks through the band
  leg("g8kp/receiver"),
  leg("g8kp/receiver-patch"),
  leg("g8kp/receiver-masked"),
  // G8kb: g8ku (gate8-basis at /9 basis-uastc). Its perturbed-KTX2 sabotage replaces the native leg
  // (g8ku's sabotage-perturb-ktx2 judges the refusal); the rest are GSW-only legs judged by
  // lib/gate7-gsw-g8-checks.ts: GSW transcodes to its own WebGL context's D14 target, which is not
  // always the native receiver's (WebGL refuses a BC level 0 that is not 4-aligned), so g8ku's
  // native-target checks cannot judge them as they stand.
  leg("g8ku/sabotage-perturb-ktx2/receiver"),
  { leg: "g8ku/gsw-upgrade", from: "g8ku/receiver-upgrade", replaces: false },
  {
    leg: "g8ku/gsw-keep",
    from: "g8ku/receiver",
    env: { RS_RECEIVER_VARIANT_POLICY: "keep" },
    replaces: false,
  },
  {
    leg: "g8ku/gsw-rgba",
    from: "g8ku/receiver-upgrade",
    env: { RS_RECEIVER_GPU_FORMAT_MASK: "s3tc,bptc,rgtc,etc2,astc" },
    replaces: false,
  },
  {
    leg: "g8ku/gsw-transcode-fail",
    from: "g8ku/receiver-upgrade",
    env: { RS_RECEIVER_TRANSCODE_FAULT: "fail" },
    replaces: false,
  },
];

const IMPORT_NA =
  "the editor --import of the native receiver project (receiver/); the GSW receiver is a bundle with nothing to import";

export const GATE8_NOT_APPLICABLE: NotApplicable[] = [
  { leg: "import/receiver", reason: IMPORT_NA },
  { leg: "g8a/import/receiver", reason: IMPORT_NA },
  { leg: "g8h/import/receiver", reason: IMPORT_NA },
  { leg: "g8c/import/receiver", reason: IMPORT_NA },
  { leg: "g8cg/import/receiver", reason: IMPORT_NA },
  { leg: "g8m/import/receiver", reason: IMPORT_NA },
  { leg: "g8w11/import/receiver", reason: IMPORT_NA },
  { leg: "g8mm/import/receiver", reason: IMPORT_NA },
];

/** The checks of check-gate8.ts that read a receiver leg, found mechanically
 * (scripts/test/probe-receiver-checks.ts gate8 over a passing source, every receiver leg emptied). */
export const GATE8_RECEIVER_CHECKS: {
  judged: string[];
  notApplicable: Record<string, string>;
} = {
  judged: [
    // g8t
    "decode-reference",
    "sabotage-perturb-decode",
    // g8a
    "g8a-legs",
    "adopt-reference",
    "fault-no-resources",
    "fault-atlas-from-dummy",
    "sabotage-adopt-skip-state",
    "sabotage-adopt-no-redraw",
    "sabotage-adopt-skip-layers",
    // g8h
    "g8h-legs",
    "late-size-reference",
    "late-size-needed",
    "sabotage-size-before-adopt",
    // g8c (P3-CT)
    "g8c-legs",
    "ct-reference",
    "ct-channel-refused",
    "ct-diffuse-uploaded",
    // g8f
    "float-exact",
    "float-sabotage-perturb-decode",
    // g8m
    "g8m-legs",
    "mat-adopt-reference",
    "adopt-include-refused",
    // g8cg (CG3)
    "g8cg-legs",
    "cg-native-exact",
    "cg-negative-control",
    "cg-sabotage-drop-group",
    "cg-sabotage-full-copy",
    "cg-adopt",
    // g8w11 (W11d)
    "native-w11-replays",
    "native-dynamic-applied",
    "native-w11-equals-v10",
    "native-store-bounded",
    "native-inline-fetch-zero",
    "native-stale-dynamic-rx-caught",
    "native-no-prune-caught",
    "native-evict-carried-caught",
    "native-ignore-released-caught",
    // g8mm (PM2's checks over the PM3 GSW legs)
    "g8mm-legs",
    "mm-premise",
    "mm-reference",
    "mm-state",
    "mm-reference-catches-undrawn-multimesh",
    "mm-reference-catches-ignore-identity-transform",
    "mm-reference-catches-perturb-instance",
    "mm-reference-catches-stale-buffer",
    // g8pt (PM6a's checks over the PM6b GSW legs)
    "pt-receiver",
    "pt-lifecycle",
    "pt-coverage",
    "pt-outside-exact",
    "pt-replay",
    "pt-lockstep",
    "pt-lifecycle-catches-drop-restart",
    "pt-lifecycle-catches-undrawn-particles",
    "pt-replay-catches-ignore-particle-emits",
    // g8pt ptc (PFB's checks over the GSW legs)
    "ptc-receiver",
    "ptc-receiver-catches-gl-particle-colors",
    // g8kp (G8kb)
    "delivery-select",
    "delivery-pixels-native",
    // g8ku (G8kb)
    "sabotage-perturb-ktx2",
  ],
  notApplicable: {
    // PSE: the native receiver sabotage leaves a RendererRD host's emit_subparticle calls in; GSW
    // simulates from the builtin key and never compiles the host's process code, so its leg is not
    // replayed (GSW's own PSE sabotage is shared-process-key, lib/gate7-gsw-g8-checks.ts).
    "ptc-receiver-catches-no-subparticle-stub":
      "GSW never compiles the host's process code (no emit_subparticle to stub)",
  },
};

/** Q7 for gate 8: no gsw-tolerance.json plan (gate 8's fixtures have no per-pixel model); the
 * legs are judged through gate8BandViews instead (below). */
export function gate8Q7Plan(
  _leg: string,
): { key: string; reference: string; live: boolean } | null {
  return null;
}

// ---------------------------------------------------------------------------------- the band
//
// Gate 8 asks what the /8 additions deliver (host decodes, float payloads, adopted objects, a late
// presentation size, adopted materials), not how GSW rasterizes, which gates 0 to 6 judged under
// Q7. So a GSW leg is judged against the NATIVE receiver's same leg of the same recording, the
// way the web export is (lib/gate7b-adapters.ts's readback/delta1 band): a GSW shot whose every
// differing pixel is within channel 1 (Q7's delta1 class: blend rounding and the native 10-bit
// target's readback) or inside a region the fixture declares below is that native shot in the
// view, and the gate's own checks judge it; any other difference keeps the GSW shot, so the checks
// see it. The regions come from the fixture scenes (never from a GSW run):
//   undecided  gate8-tex row B (Sprite2D at scale 1.25, filter linear, and alpha_mip at 0.3125 with
//              mipmaps: Q7's linearly filtered class), row C (NinePatchRect 72x56 over 64 px
//              texels, margins 16: its 40 px centre and edges stretch 32 texels at nearest, so
//              pixel centres fall on texel boundaries every 5 px, a tie the hand model leaves open)
//              and row D (draw_texture_rect_region of a 32 px source into 48 px at nearest: a tie
//              every 3 px; NVIDIA's GSW resolved them as the native receiver, lavapipe's did not)
//   excluded   gate8-tex float scene's view strips with a shader gain other than 1 (curve_rf x0.6,
//              grad_hdr x0.5): `clamp(v * gain)` of a value above 1 differs from the same of a
//              value quantized (clamped) first; typed `float-texture-quantized`, judged by its own
//              check (lib/gate7-gsw-g8-checks.ts)

export type Rect = [number, number, number, number];
export interface BandRegion {
  region: string;
  rect: Rect;
  class: "undecided" | "excluded";
  why: string;
}

const TEX_COLUMNS = 7; // textures.gd's drawn textures, at x = 16 + 88 i (gate8_tex.gd COLUMN_X0/DX)
function texRegions(): BandRegion[] {
  const out: BandRegion[] = [];
  for (let i = 0; i < TEX_COLUMNS; i++) {
    const x = 16 + 88 * i;
    out.push({
      region: `B${i}`,
      rect: [x, 96, 80, 80],
      class: "undecided",
      why: "row B: Sprite2D scaled with filter linear (alpha_mip: linear with mipmaps)",
    });
    out.push({
      region: `C${i}`,
      rect: [x, 186, 72, 56],
      class: "undecided",
      why: "row C: NinePatchRect 72x56, margins 16, nearest: texel-boundary ties at the stretch",
    });
    out.push({
      region: `D${i}`,
      rect: [x, 260, 48, 48],
      class: "undecided",
      why: "row D: draw_texture_rect_region of a 32x32 source into 48x48 at nearest (scale 1.5): texel-boundary ties every 3 px",
    });
  }
  return out;
}

const FLOAT_REGIONS: BandRegion[] = [
  {
    region: "curve_rf_0",
    rect: [8, 8, 256, 16],
    class: "excluded",
    why: "shader gain 0.6 over curve values up to 1.5: float-texture-quantized",
  },
  {
    region: "grad_hdr_0",
    rect: [8, 74, 256, 16],
    class: "excluded",
    why: "shader gain 0.5 over HDR gradient values above 1: float-texture-quantized",
  },
];

/** The regions a gate 8 gsw leg's shots may differ in beyond channel 1. */
export function gate8BandRegions(leg: string): BandRegion[] {
  if (leg.startsWith("g8f/")) return FLOAT_REGIONS;
  // G8kb: g8kp's legs draw gate8-tex's main scene.
  if (leg.startsWith("g8kp/")) return texRegions();
  if (!leg.includes("/") || leg === "sabotage-perturb-decode/receiver") return texRegions();
  return [];
}

export interface BandShot {
  shot: string;
  differing: number;
  delta1: number;
  undecided: number;
  excluded: number;
  other: number;
  max_other: number;
  banded: boolean;
}

function inside(regions: BandRegion[], x: number, y: number): BandRegion | undefined {
  return regions.find((r) => x >= r.rect[0] && x < r.rect[0] + r.rect[2] && y >= r.rect[1] && y < r.rect[1] + r.rect[3]);
}

/** One shot's classes against the native shot (null: either is missing or the sizes differ). */
export async function bandShot(
  gswPng: string,
  nativePng: string,
  regions: BandRegion[],
): Promise<Omit<BandShot, "shot" | "banded"> | null> {
  if (!existsSync(gswPng) || !existsSync(nativePng)) return null;
  const a = await decodePngRgba(gswPng);
  const b = await decodePngRgba(nativePng);
  if (!a || !b || a.width !== b.width || a.height !== b.height) return null;
  const out = { differing: 0, delta1: 0, undecided: 0, excluded: 0, other: 0, max_other: 0 };
  for (let p = 0; p < a.width * a.height; p++) {
    const i = p * 4;
    let d = 0;
    for (let c = 0; c < 4; c++) d = Math.max(d, Math.abs(a.data[i + c] - b.data[i + c]));
    if (d === 0) continue;
    out.differing++;
    const r = inside(regions, p % a.width, Math.floor(p / a.width));
    if (r) out[r.class]++;
    else if (d === 1) out.delta1++;
    else {
      out.other++;
      out.max_other = Math.max(out.max_other, d);
    }
  }
  return out;
}

/** Builds each gsw leg's band view (`<gswRoot>/../gsw-band/<leg>`: every file a symlink to the
 * gsw leg's, a shot within the band a symlink to the native shot) and returns the views and the
 * per-shot classes (written to gsw-band.json by the caller). */
export async function gate8BandViews(
  gswRoot: string,
  sourceDir: string,
  legs: string[],
): Promise<{ views: Map<string, string>; shots: Record<string, BandShot[]> }> {
  const views = new Map<string, string>();
  const shots: Record<string, BandShot[]> = {};
  for (const leg of legs) {
    const from = join(gswRoot, leg);
    const native = join(sourceDir, leg);
    const view = join(gswRoot, "..", "gsw-band", leg);
    if (!existsSync(from)) continue;
    await rm(view, { recursive: true, force: true });
    const regions = gate8BandRegions(leg);
    const legShots: BandShot[] = [];
    const walk = async (rel: string): Promise<void> => {
      for (const e of readdirSync(join(from, rel), { withFileTypes: true })) {
        const r = rel === "" ? e.name : `${rel}/${e.name}`;
        if (e.isDirectory()) {
          await mkdir(join(view, r), { recursive: true });
          await walk(r);
          continue;
        }
        let target = join(from, r);
        if (r.startsWith("shots/") && r.endsWith(".png")) {
          const c = await bandShot(join(from, r), join(native, r), regions);
          const banded = c !== null && c.other === 0 && c.differing > 0;
          if (c) legShots.push({ shot: r.slice("shots/".length), ...c, banded });
          if (banded) target = join(native, r);
        }
        await mkdir(dirname(join(view, r)), { recursive: true });
        symlinkSync(target, join(view, r));
      }
    };
    await mkdir(view, { recursive: true });
    await walk("");
    views.set(leg, view);
    shots[leg] = legShots;
  }
  return { views, shots };
}
