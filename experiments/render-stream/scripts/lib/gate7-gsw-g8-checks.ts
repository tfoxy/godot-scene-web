// Gate 8's GSW-only checks (G8g), beside the gate's own checks the gsw view judges (`@gsw`, through
// lib/gate7-gsw-g8.ts's tables):
//   compositor-equals-readback:<fixture>@gsw  Q7, one per fixture's honest full-sink leg; gating
//                    only when the leg's last shot is of the state the canvas shows at exit (a
//                    gate 8 fixture changes after its last checkpoint, as gate 5.5's shader scene)
//   gsw-band@gsw     report: each gate 8 gsw shot's classes against the native shot
//                    (lib/gate7-gsw-g8.ts gate8BandViews): delta1, undecided, excluded, other
//   float-texture-quantized@gsw  render-stream-8.md "As built (G8f)": GSW samples no float texture,
//                    so it takes every float payload as RGBA8 through rs-core's `texture_rgba8`
//                    (pinned by protocol/golden-8/float-quantize.json) and says so: the g8f legs'
//                    applied.json `receiver.caveats` holds `float-texture-quantized` and
//                    `receiver.float_quantized` names exactly the float formats the source carried
//                    (check-gate8.ts g8f.carried_formats); a leg with no float payload (g8t's
//                    `receiver`) has no caveat.
//   G8kb (texture-delivery-design.md D6, D14, D16, Q3, Q6 "GSW"; GSW-only legs of g8ku, from the
//   native receiver-upgrade and receiver legs; the oracle is g8ku/reference-oracle's
//   Image.load_ktx_from_buffer on the native GPU):
//   gsw-transcode-oracle@gsw   g8ku/gsw-upgrade transcodes exactly the KTX2s the native upgrade
//                    leg transcodes, each in its Web Worker without a failure, at the entry's size
//                    and mips, to D14's target for GSW's own stated gpu_formats (minus the BC
//                    families where WebGL refuses a level 0 that is not 4-aligned); where that is
//                    the oracle's target, the blocks equal the oracle's bit for bit
//   gsw-delivery-policy@gsw    D6: gsw-upgrade uploads what the native upgrade leg uploads at each
//                    seq (texture, encoding), and gsw-keep what the native keep leg does (no uastc,
//                    no transcode)
//   gsw-delivery-pixels@gsw    gsw-upgrade's and gsw-keep's final shots against the native legs':
//                    within channel 1, except the declared half-size mip draw (GSW samples level 0
//                    only) and, for a texture GSW transcoded to another target than the native
//                    receiver, that texture's region at PSNR >= 30 dB against the procedural
//                    reference (D16's quality floor)
//   gsw-transcode-rgba@gsw     with every family masked (gsw-rgba), D14's last resort: each uastc
//                    variant transcoded to RGBA8 and uploaded, its region at PSNR >= 30 dB
//   gsw-transcode-fallback@gsw Q3: under RS_RECEIVER_TRANSCODE_FAULT=fail every transcode fails;
//                    each is a typed delivery-transcode-failed row, the texture falls back to
//                    `decoded` (no uastc upload) and the final image equals gsw-keep's exactly
//   CG3 (render-stream-10.md "Receivers": GSW composites the /10 state; g8cg's own checks judge
//   its legs through the band, lib/gate7-gsw-g8.ts):
//   cg-gsw-untyped@gsw  no g8cg GSW leg types anything unsupported but the headless capture's
//                    degenerate-host-size (as on native): no gsw-canvas-group or
//                    gsw-backbuffer-copy row is left, and every checkpoint shot of the honest /10
//                    legs (receiver, receiver-patch, late/receiver) is within the band (channel 1)
//                    of the native shot

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { decodePngRgba } from "./gate-minus1-checks";

import type { Gate7Check } from "./gate7-adapters";
import { compositorProblems, mk } from "./gate7-gsw";
import { type BandShot, GATE8_COMPOSITOR_LEGS } from "./gate7-gsw-g8";
import { BASIS_HALF_MIP, BASIS_REGIONS } from "./gate8-basis-checks";

interface Ctx {
  out: string;
  sourceDir: string;
}

const gswDir = (ctx: Ctx, leg: string) => join(ctx.out, "gate8", "gsw", leg);

async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

/** The fixture a compositor leg shows (`receiver` is g8t's gate8-tex). */
function fixtureOf(leg: string): string {
  return leg === "receiver" ? "g8t" : (leg.split("/")[0] ?? leg);
}

export async function gate8Checks(ctx: Ctx): Promise<Gate7Check[]> {
  const out: Gate7Check[] = [];
  for (const leg of GATE8_COMPOSITOR_LEGS) {
    const problems = await compositorProblems(gswDir(ctx, leg));
    const comparable = !problems.some((p) => /is not of the state/.test(p));
    out.push(
      mk(
        `compositor-equals-readback:${fixtureOf(leg)}@gsw`,
        "Q7: the CDP screenshot of the canvas, taken while the leg's applied.json PUT is held, equals the leg's last shot channel for channel",
        problems,
        "screenshot equals the last shot exactly",
        comparable,
      ),
    );
  }
  {
    const problems: string[] = [];
    const source = await readJson<{ g8f?: { carried_formats?: string[] } }>(join(ctx.sourceDir, "result.json"));
    const floats = new Set(["RF", "RGF", "RGBF", "RGBAF", "RH", "RGH", "RGBH", "RGBAH"]);
    const carried = (source?.g8f?.carried_formats ?? []).filter((f) => floats.has(f)).sort();
    if (carried.length === 0) problems.push("the source's g8f.carried_formats lists no float format");
    for (const leg of ["g8f/receiver", "g8f/receiver-patch"]) {
      const a = await readJson<{ receiver?: { caveats?: string[]; float_quantized?: string[] } }>(
        join(gswDir(ctx, leg), "applied.json"),
      );
      if (!a?.receiver?.caveats) {
        problems.push(`${leg}: applied.json receiver.caveats missing`);
        continue;
      }
      if (!a.receiver.caveats.includes("float-texture-quantized"))
        problems.push(`${leg}: caveats ${JSON.stringify(a.receiver.caveats)} lack float-texture-quantized`);
      const q = [...(a.receiver.float_quantized ?? [])].sort();
      if (JSON.stringify(q) !== JSON.stringify(carried))
        problems.push(`${leg}: quantized ${JSON.stringify(q)}, carried ${JSON.stringify(carried)}`);
    }
    const plain = await readJson<{ receiver?: { caveats?: string[] } }>(join(gswDir(ctx, "receiver"), "applied.json"));
    if ((plain?.receiver?.caveats ?? ["missing"]).length !== 0)
      problems.push(`receiver (g8t, no float payload): caveats ${JSON.stringify(plain?.receiver?.caveats)}`);
    out.push(
      mk(
        "float-texture-quantized@gsw",
        "G8g (render-stream-8.md As built (G8f)): GSW takes every float payload as RGBA8 by rs-core's quantization and reports the caveat float-texture-quantized naming exactly the float formats carried; a stream without floats has none",
        problems,
        `g8f legs quantized ${carried.join(",")}; g8t's receiver has no caveat`,
      ),
    );
  }
  {
    const band = await readJson<Record<string, BandShot[]>>(join(ctx.out, "gate8", "gsw-band.json"));
    const t = { shots: 0, banded: 0, identical: 0, raw: 0, delta1: 0, undecided: 0, excluded: 0, other: 0 };
    const raw: string[] = [];
    for (const [leg, shots] of Object.entries(band ?? {}))
      for (const s of shots) {
        t.shots++;
        t.delta1 += s.delta1;
        t.undecided += s.undecided;
        t.excluded += s.excluded;
        t.other += s.other;
        if (s.differing === 0) t.identical++;
        else if (s.banded) t.banded++;
        else {
          t.raw++;
          raw.push(`${leg}/${s.shot}: ${s.other} px beyond channel 1 outside the declared regions (max ${s.max_other})`);
        }
      }
    out.push(
      mk(
        "gsw-band@gsw",
        "G8g (report): each gate 8 gsw shot against the native receiver's same shot: within channel 1 or inside the fixture's declared regions (undecided filtering and nine-patch ties, excluded float-gain strips) it stands in for the native shot; any other difference stays the GSW shot for the gate's own checks",
        band === undefined ? ["gsw-band.json missing"] : raw,
        `${t.shots} shots: ${t.identical} identical, ${t.banded} within the band; pixels delta1 ${t.delta1}, undecided ${t.undecided}, excluded ${t.excluded}, other ${t.other}`,
        false,
      ),
    );
  }
  out.push(...(await g8kuChecks(ctx)));
  out.push(...(await g8cgChecks(ctx)));
  return out;
}

// --------------------------------------------------------------------------------------- CG1

/** The g8cg legs GSW replays (lib/gate7-gsw-g8.ts GATE8_LEGS), and the honest /10 ones. */
const CG_LEGS = [
  "g8cg/receiver",
  "g8cg/receiver-patch",
  "g8cg/late/receiver",
  "g8cg/receiver-v9",
  "g8cg/sabotage-drop-canvas-group/receiver",
  "g8cg/sabotage-full-backbuffer-copy/receiver",
];
const CG_HONEST = CG_LEGS.slice(0, 3);

/** cg-gsw-untyped@gsw (header). Not emitted when the source ran no g8cg. */
async function g8cgChecks(ctx: Ctx): Promise<Gate7Check[]> {
  if (!existsSync(join(ctx.sourceDir, "g8cg"))) return [];
  const band = await readJson<Record<string, BandShot[]>>(join(ctx.out, "gate8", "gsw-band.json"));
  const problems: string[] = [];
  let shots = 0;
  for (const leg of CG_LEGS) {
    const applied = await readJson<{ unsupported?: { reason?: string }[] }>(
      join(gswDir(ctx, leg), "applied.json"),
    );
    if (!applied) {
      problems.push(`${leg}: applied.json missing`);
      continue;
    }
    const others = (applied.unsupported ?? []).filter((u) => u.reason !== "degenerate-host-size");
    if (others.length > 0)
      problems.push(`${leg}: ${others.length} unsupported entries (${[...new Set(others.map((u) => u.reason))].join(", ")})`);
    if (!CG_HONEST.includes(leg)) continue;
    const legShots = band?.[leg];
    if (!legShots || legShots.length === 0) {
      problems.push(`${leg}: no band classes`);
      continue;
    }
    for (const s of legShots) {
      shots++;
      if (s.other > 0)
        problems.push(`${leg}/${s.shot}: ${s.other} px beyond channel 1 of the native shot (max ${s.max_other})`);
    }
  }
  return [
    mk(
      "cg-gsw-untyped@gsw",
      "CG3 (render-stream-10.md Receivers): GSW composites canvas groups and back-buffer copies itself: no g8cg GSW leg types /10 state (only the headless capture's degenerate-host-size, as on native), and every shot of the honest /10 legs is the native shot within channel 1",
      problems,
      `${CG_LEGS.length} legs; ${shots} honest shots within channel 1 of native`,
    ),
  ];
}

// ------------------------------------------------------------------------------------- G8kb

// gate8-basis's drawn textures and the half-size mip draw (GSW uploads level 0 only) are
// BASIS_REGIONS and BASIS_HALF_MIP (lib/gate8-basis-checks.ts).
const QUALITY_FLOOR_DB = 30;

interface TranscodeRow {
  hash: string;
  ok: boolean;
  format?: number | null;
  format_name?: string | null;
  width?: number;
  height?: number;
  mipmaps?: boolean;
  components?: number;
  data_sha256?: string | null;
}
interface BasisApplied {
  status?: string;
  failure?: unknown;
  receiver?: { texture_delivery?: { gpu_formats?: string; variant_policy?: string } };
  uploads?: Array<{ id: number; hash?: string | null; seq: number; encoding?: string | null }>;
  transcodes?: TranscodeRow[];
  delivery_fallbacks?: Array<{ hash: string; reason: string }>;
}
interface OracleRow {
  name: string;
  hash: string;
  format: number;
  width: number;
  height: number;
  mipmaps: boolean;
  data_sha256: string;
}

/** Godot's Image.Format value per name (transcode.ts IMAGE_FORMAT). */
const IMAGE_FORMAT: Record<string, number> = {
  RGBA8: 5,
  DXT1: 17,
  DXT5: 19,
  RGTC_R: 20,
  RGTC_RG: 21,
  BPTC_RGBA: 22,
  ETC2_RGB8: 30,
  ETC2_RGBA8: 31,
  ASTC_4x4: 35,
};

/** D14 (Godot's KTX2 loader rule) for a WebGL context, independently of transcoder.cpp and
 * client.ts: the BC families drop out when level 0 is not 4-aligned. */
export function predictGswTarget(
  components: number,
  families: readonly string[],
  width: number,
  height: number,
): string {
  const aligned = width % 4 === 0 && height % 4 === 0;
  const has = (f: string) => families.includes(f) && (aligned || !["s3tc", "bptc", "rgtc"].includes(f));
  if (components === 1) return has("rgtc") ? "RGTC_R" : "RGBA8";
  if (components === 2) return has("rgtc") ? "RGTC_RG" : "RGBA8";
  if (components === 3) {
    if (has("bptc")) return "BPTC_RGBA";
    if (has("astc")) return "ASTC_4x4"; // G8kb2: GSW departs from Godot's rule
    if (has("s3tc")) return "DXT1";
    if (has("etc2")) return "ETC2_RGB8";
    return "RGBA8";
  }
  if (has("astc")) return "ASTC_4x4";
  if (has("bptc")) return "BPTC_RGBA";
  if (has("s3tc")) return "DXT5";
  if (has("etc2")) return "ETC2_RGBA8";
  return "RGBA8";
}

type Png = { width: number; height: number; data: Uint8Array };
async function png(path: string): Promise<Png | undefined> {
  if (!existsSync(path)) return undefined;
  const img = await decodePngRgba(path);
  return img ? { width: img.width, height: img.height, data: new Uint8Array(img.data) } : undefined;
}

/** The last checkpoint shot of a leg (its shot-seqs.txt's last seq). */
async function lastShot(dir: string): Promise<Png | undefined> {
  let text = "";
  try {
    text = await readFile(join(dir, "shot-seqs.txt"), "utf8");
  } catch {
    return undefined;
  }
  const seqs = text.trim().split(",").filter(Boolean);
  const last = seqs[seqs.length - 1];
  return last ? png(join(dir, "shots", `seq-${last}.png`)) : undefined;
}

const within = (r: [number, number, number, number], x: number, y: number) =>
  x >= r[0] && x < r[0] + r[2] && y >= r[1] && y < r[1] + r[3];

/** Pixels differing by more than channel 1, outside `skip`, and the largest delta. */
function beyondOne(a: Png, b: Png, skip: Array<[number, number, number, number]>): { n: number; max: number } {
  let n = 0;
  let max = 0;
  for (let y = 0; y < a.height; y++)
    for (let x = 0; x < a.width; x++) {
      if (skip.some((r) => within(r, x, y))) continue;
      const i = (y * a.width + x) * 4;
      let d = 0;
      for (let c = 0; c < 4; c++) d = Math.max(d, Math.abs(a.data[i + c] - b.data[i + c]));
      if (d > 1) {
        n++;
        max = Math.max(max, d);
      }
    }
  return { n, max };
}

function regionPsnr(a: Png, b: Png, r: [number, number, number, number]): number {
  let se = 0;
  let n = 0;
  for (let y = r[1]; y < r[1] + r[3]; y++)
    for (let x = r[0]; x < r[0] + r[2]; x++) {
      const i = (y * a.width + x) * 4;
      for (let c = 0; c < 4; c++) {
        const d = a.data[i + c] - b.data[i + c];
        se += d * d;
        n++;
      }
    }
  return se === 0 ? Infinity : 10 * Math.log10((255 * 255 * n) / se);
}

function exactlyEqual(a: Png, b: Png): number {
  let n = 0;
  for (let i = 0; i < a.data.length; i += 4)
    if (
      a.data[i] !== b.data[i] ||
      a.data[i + 1] !== b.data[i + 1] ||
      a.data[i + 2] !== b.data[i + 2] ||
      a.data[i + 3] !== b.data[i + 3]
    )
      n++;
  return n;
}

const uploadKey = (u: { id: number; seq: number; encoding?: string | null }) => `${u.seq}:${u.id}:${u.encoding ?? "-"}`;

async function g8kuChecks(ctx: Ctx): Promise<Gate7Check[]> {
  const out: Gate7Check[] = [];
  const src = (l: string) => join(ctx.sourceDir, "g8ku", l);
  const leg = (l: string) => gswDir(ctx, `g8ku/${l}`);
  const oracle = (await readJson<{ ktx2?: OracleRow[] }>(join(src("reference-oracle"), "oracle", "oracle.json")))?.ktx2 ?? [];
  const byHash = new Map(oracle.map((o) => [o.hash, o]));
  const nativeUp = await readJson<BasisApplied>(join(src("receiver-upgrade"), "applied.json"));
  const nativeKeep = await readJson<BasisApplied>(join(src("receiver"), "applied.json"));
  const up = await readJson<BasisApplied>(join(leg("gsw-upgrade"), "applied.json"));
  const keep = await readJson<BasisApplied>(join(leg("gsw-keep"), "applied.json"));
  const rgba = await readJson<BasisApplied>(join(leg("gsw-rgba"), "applied.json"));
  const fail = await readJson<BasisApplied>(join(leg("gsw-transcode-fail"), "applied.json"));
  const expectedHashes = new Set((nativeUp?.transcodes ?? []).map((t) => t.hash));
  const statusProblems = (name: string, a: BasisApplied | undefined): string[] =>
    a === undefined
      ? [`${name}: applied.json missing`]
      : a.status !== "ok"
        ? [`${name}: status ${a.status} ${JSON.stringify(a.failure ?? null).slice(0, 160)}`]
        : [];
  // The target each GSW transcode took, by hash (for the pixel check).
  const gswTarget = new Map<string, string>();

  {
    const problems = [...statusProblems("gsw-upgrade", up)];
    if (oracle.length === 0) problems.push("the source's g8ku/reference-oracle/oracle/oracle.json lists no KTX2");
    if (expectedHashes.size === 0) problems.push("the native upgrade leg transcoded nothing");
    const families = (up?.receiver?.texture_delivery?.gpu_formats ?? "none").split(",").filter((f) => f !== "none");
    const rows = up?.transcodes ?? [];
    const got = new Set(rows.map((t) => t.hash));
    for (const h of expectedHashes) if (!got.has(h)) problems.push(`${h.slice(0, 12)}: not transcoded`);
    for (const h of got) if (!expectedHashes.has(h)) problems.push(`${h.slice(0, 12)}: transcoded, the native leg did not`);
    let exact = 0;
    const other: string[] = [];
    for (const t of rows) {
      const o = byHash.get(t.hash);
      if (!t.ok) {
        problems.push(`${t.hash.slice(0, 12)}: transcode failed`);
        continue;
      }
      if (!o) {
        problems.push(`${t.hash.slice(0, 12)}: no oracle row`);
        continue;
      }
      if (t.width !== o.width || t.height !== o.height || t.mipmaps !== o.mipmaps)
        problems.push(`${o.name}: ${t.width}x${t.height} mips ${t.mipmaps}, oracle ${o.width}x${o.height} ${o.mipmaps}`);
      const want = predictGswTarget(t.components ?? 0, families, o.width, o.height);
      gswTarget.set(t.hash, t.format_name ?? "");
      if (t.format_name !== want) problems.push(`${o.name}: target ${t.format_name}, D14 for gpu_formats ${families.join(",") || "none"} is ${want}`);
      if (t.format !== IMAGE_FORMAT[t.format_name ?? ""]) problems.push(`${o.name}: format ${t.format} is not ${t.format_name}'s`);
      if (t.format === o.format) {
        if (t.data_sha256 !== o.data_sha256) problems.push(`${o.name}: ${t.format_name} blocks differ from the oracle's`);
        else exact++;
      } else other.push(`${o.name} ${t.format_name} (oracle ${o.format})`);
    }
    out.push(
      mk(
        "gsw-transcode-oracle@gsw",
        "G8kb (D14, D16, Q6 \"GSW\"): GSW's worker transcodes exactly the KTX2s the native upgrade leg does, without a failure, at the entry's size and mips, to D14's target for its stated gpu_formats (BC needs a 4-aligned level 0 in WebGL); on the oracle's target the blocks equal the oracle's bit for bit",
        problems,
        `${rows.length} transcodes: ${exact} on the oracle's target and bit-identical; other targets: ${other.join(", ") || "none"}`,
      ),
    );
  }

  {
    const problems = [...statusProblems("gsw-keep", keep)];
    const cmp = (name: string, a: BasisApplied | undefined, b: BasisApplied | undefined) => {
      const ka = (a?.uploads ?? []).map(uploadKey).sort();
      const kb = (b?.uploads ?? []).map(uploadKey).sort();
      if (JSON.stringify(ka) !== JSON.stringify(kb))
        problems.push(`${name}: uploads ${JSON.stringify(ka)} vs native ${JSON.stringify(kb)}`);
    };
    cmp("gsw-upgrade", up, nativeUp);
    cmp("gsw-keep", keep, nativeKeep);
    if ((keep?.transcodes ?? []).length > 0) problems.push(`gsw-keep transcoded ${keep?.transcodes?.length}`);
    if ((keep?.uploads ?? []).some((u) => u.encoding === "uastc")) problems.push("gsw-keep uploaded a uastc variant");
    if (up?.receiver?.texture_delivery?.variant_policy !== "upgrade") problems.push("gsw-upgrade's policy is not upgrade");
    if (keep?.receiver?.texture_delivery?.variant_policy !== "keep") problems.push("gsw-keep's policy is not keep");
    const n = (up?.uploads ?? []).filter((u) => u.encoding === "uastc").length;
    out.push(
      mk(
        "gsw-delivery-policy@gsw",
        "G8kb (D6): under upgrade GSW re-uploads each texture whose D3 choice becomes uastc at the variant's seq, as the native upgrade leg does; under keep it uploads exactly what the native keep leg does (no uastc fetch, no transcode)",
        problems,
        `upgrade: ${n} uastc uploads, as native; keep: uploads equal native's`,
      ),
    );
  }

  const reference = await png(join(src("reference"), "shots", "step-1.png"));
  {
    const problems: string[] = [];
    const g = await lastShot(leg("gsw-upgrade"));
    const n = await lastShot(src("receiver-upgrade"));
    const gk = await lastShot(leg("gsw-keep"));
    const nk = await lastShot(src("receiver"));
    const notes: string[] = [];
    if (!g || !n || !gk || !nk || !reference) problems.push("a final shot or the reference's step-1 shot is missing");
    else {
      const skip: Array<[number, number, number, number]> = [BASIS_HALF_MIP];
      for (const t of up?.transcodes ?? []) {
        const o = byHash.get(t.hash);
        if (!o || t.format === o.format) continue;
        const r = BASIS_REGIONS[o.name];
        if (!r) continue;
        skip.push(r);
        const db = regionPsnr(g, reference, r);
        notes.push(`${o.name} (${t.format_name}) ${db.toFixed(1)} dB`);
        if (db < QUALITY_FLOOR_DB) problems.push(`${o.name}: ${db.toFixed(1)} dB against the reference, floor ${QUALITY_FLOOR_DB}`);
      }
      const a = beyondOne(g, n, skip);
      if (a.n > 0) problems.push(`gsw-upgrade: ${a.n} px beyond channel 1 of the native upgrade leg (max ${a.max}) outside the declared regions`);
      const b = beyondOne(gk, nk, [BASIS_HALF_MIP]);
      if (b.n > 0) problems.push(`gsw-keep: ${b.n} px beyond channel 1 of the native keep leg (max ${b.max})`);
    }
    out.push(
      mk(
        "gsw-delivery-pixels@gsw",
        "G8kb (D16): GSW's final images equal the native receiver's (upgrade and keep) within channel 1, except the declared half-size mip draw (GSW uploads level 0 only) and the regions of textures GSW transcoded to another target, which hold D16's quality floor against the procedural reference",
        problems,
        `other-target regions: ${notes.join(", ") || "none"}; half-size mip region undecided`,
      ),
    );
  }

  {
    const problems = [...statusProblems("gsw-rgba", rgba)];
    const rows = rgba?.transcodes ?? [];
    if ((rgba?.receiver?.texture_delivery?.gpu_formats ?? "") !== "none")
      problems.push(`gpu_formats ${rgba?.receiver?.texture_delivery?.gpu_formats}, expected none`);
    if (rows.length < expectedHashes.size) problems.push(`${rows.length} transcodes, expected at least ${expectedHashes.size}`);
    for (const t of rows) if (!t.ok || t.format_name !== "RGBA8") problems.push(`${t.hash.slice(0, 12)}: ok ${t.ok}, target ${t.format_name}`);
    const uastc = (rgba?.uploads ?? []).filter((u) => u.encoding === "uastc");
    if (uastc.length !== rows.length) problems.push(`${uastc.length} uastc uploads for ${rows.length} transcodes`);
    const g = await lastShot(leg("gsw-rgba"));
    const notes: string[] = [];
    if (!g || !reference) problems.push("gsw-rgba's final shot or the reference is missing");
    else
      for (const t of rows) {
        const o = byHash.get(t.hash);
        const r = o ? BASIS_REGIONS[o.name] : undefined;
        if (!o || !r) continue;
        const db = regionPsnr(g, reference, r);
        notes.push(`${o.name} ${db.toFixed(1)}`);
        if (db < QUALITY_FLOOR_DB) problems.push(`${o.name}: ${db.toFixed(1)} dB, floor ${QUALITY_FLOOR_DB}`);
      }
    out.push(
      mk(
        "gsw-transcode-rgba@gsw",
        "G8kb (D14's last resort): with every compressed family masked, GSW transcodes each uastc variant to RGBA8 and uploads it, at D16's quality floor against the procedural reference",
        problems,
        `${rows.length} RGBA8 transcodes; PSNR dB ${notes.join(", ")}`,
      ),
    );
  }

  {
    const problems = [...statusProblems("gsw-transcode-fail", fail)];
    const rows = fail?.delivery_fallbacks ?? [];
    const got = new Set(rows.map((r) => r.hash));
    for (const h of expectedHashes) if (!got.has(h)) problems.push(`${h.slice(0, 12)}: no fallback row`);
    for (const r of rows) if (r.reason !== "delivery-transcode-failed") problems.push(`${r.hash.slice(0, 12)}: reason ${r.reason}`);
    if ((fail?.uploads ?? []).some((u) => u.encoding === "uastc")) problems.push("a uastc upload despite the failed transcodes");
    const a = await lastShot(leg("gsw-transcode-fail"));
    const b = await lastShot(leg("gsw-keep"));
    if (!a || !b) problems.push("gsw-transcode-fail's or gsw-keep's final shot is missing");
    else {
      const d = exactlyEqual(a, b);
      if (d > 0) problems.push(`${d} px differ from gsw-keep's final image (decoded everywhere)`);
    }
    out.push(
      mk(
        "gsw-transcode-fallback@gsw",
        "G8kb (Q3): a failed transcode is a typed delivery-transcode-failed and the texture falls back to decoded (always servable): no uastc upload, and the final image is the decoded one",
        problems,
        `${rows.length} fallbacks, final image equals gsw-keep's`,
      ),
    );
  }
  return out;
}
