// G7t's own checks for the GSW canvas receiver on gates 4 and 5 (gate7-design.md "G7t" Checks and
// Sabotages, Q7, Q14d), beside each gate's receiver checks that lib/gate7-gsw.ts keeps `@gsw`:
//
//   g7-4  atlas-upload-parity: every text leg's texture uploads (applied.json `uploads[]`: id, hash,
//         op, bytes, seq) equal the native receiver's row for row, so GSW uploads once per wire
//         atlas version, as the native census does. glyph-boxes-exact (P-G2, report only): per
//         glyph box (each step's text_regions) of every settle shot, whether it equals the
//         reference byte for byte. gsw-never-shapes: the bundle's inputs hold no shaper or font.
//         sabotage-msdf-no-median, sabotage-msdf-px-range (G7tm): each GSW-only MSDF sabotage
//         differs from the honest gsw leg in exactly gate 4e's text regions at every settle step,
//         and nowhere outside them.
//   g7-5  mesh-upload-parity (gate 5e): every mesh leg's `mesh_uploads[]` equal the native
//         receiver's row for row. lowering-parity (Q14d "Lowering"): every hand-lowered shape of
//         gate 5's three fixtures (make_expected.py, the vertex arrays geometry-raster.ts
//         rasterizes) is found bit for bit, with its colours and triangles, in the Rust lowering of
//         the same item at the same settle seq (`rs-core-check lowered`). sabotage-polygon-winding:
//         the GSW-only reversed-fan sabotage differs from the honest gsw leg exactly in the regions
//         holding a concave add_polygon (gate 5b's PG), at every settle step.
//   both  compositor-equals-readback on the main legs (Q7).
// Predictions come from the gates' own expected.json and the source recordings, never from a GSW
// run (Q7).

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { decodePngRgba } from "./gate-minus1-checks";
import { loadRecording, RECORDING_NAME } from "./gate0-checks";
import type { Gate4Expected } from "./gate4-expected";
import type {
  Affine,
  Gate5Expected,
  Gate5Op,
  MeshShape,
} from "./gate5-expected";
import { itemIdsByName } from "./gate5d-checks";
import type { Gate7Check } from "./gate7-adapters";
import { compositorProblems, mk } from "./gate7-gsw";

export interface G45Ctx {
  out: string;
  sourceDir: string;
  experimentDir: string;
  rsCoreCheck: string;
}

type Rgba = { width: number; height: number; data: Uint8Array };

async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function settleSeqs(dir: string): number[] {
  try {
    return readFileSync(join(dir, "shot-seqs.txt"), "utf8")
      .trim()
      .split(",")
      .filter(Boolean)
      .map(Number);
  } catch {
    return [];
  }
}

function fixture<T>(ctx: G45Ctx, name: string): T {
  return JSON.parse(
    readFileSync(
      join(ctx.experimentDir, "fixtures", name, "expected.json"),
      "utf8",
    ),
  ) as T;
}

const gswLeg = (ctx: G45Ctx, gate: string, leg: string) =>
  join(ctx.out, gate, "gsw", leg);

async function compositor(id: string, dir: string): Promise<Gate7Check> {
  const problems = await compositorProblems(dir);
  const comparable = !problems.some((p) => /is not of the state/.test(p));
  return mk(
    id,
    "Q7: the CDP screenshot of the canvas equals the receiver's own readback of the same opaque frame, channel 0",
    problems,
    "screenshot equals the last shot exactly",
    comparable,
  );
}

/** Row-for-row equality of an applied.json array between the native and the gsw leg. */
async function rowsParity(
  ctx: G45Ctx,
  gate: string,
  legs: string[],
  field: "uploads" | "mesh_uploads",
  keys: string[],
): Promise<{ problems: string[]; rows: number }> {
  const problems: string[] = [];
  let rows = 0;
  for (const leg of legs) {
    const native = await readJson<Record<string, unknown>>(
      join(ctx.sourceDir, leg, "applied.json"),
    );
    const gsw = await readJson<Record<string, unknown>>(
      join(gswLeg(ctx, gate, leg), "applied.json"),
    );
    if (!native || !gsw) {
      problems.push(`${leg}: applied.json missing`);
      continue;
    }
    const pick = (r: Record<string, unknown>) =>
      JSON.stringify(keys.map((k) => r[k] ?? null));
    const a = ((native[field] as Record<string, unknown>[]) ?? []).map(pick);
    const b = ((gsw[field] as Record<string, unknown>[]) ?? []).map(pick);
    rows += a.length;
    if (a.length !== b.length)
      problems.push(`${leg}: ${b.length} ${field} rows, native ${a.length}`);
    for (let i = 0; i < Math.min(a.length, b.length); i++)
      if (a[i] !== b[i]) {
        problems.push(`${leg} row ${i}: ${b[i]} != native ${a[i]}`);
        break;
      }
  }
  return { problems, rows };
}

// ------------------------------------------------------------------------------------------ g7-4

const TEXT_LEGS: [string, string, string][] = [
  ["receiver", "reference", "gate4"],
  ["layout/receiver", "layout/reference", "gate4-layout"],
  ["rich-receiver", "rich-reference", "gate4-rich"],
  ["i18n/receiver", "i18n/reference", "gate4-i18n"],
];

async function gate4Checks(ctx: G45Ctx): Promise<Gate7Check[]> {
  const out: Gate7Check[] = [];
  const legs = [
    "receiver",
    "receiver-patch",
    "layout/receiver",
    "layout/receiver-patch",
    "rich-receiver",
    "rich-receiver-patch",
    "i18n/receiver",
    "i18n/receiver-patch",
    "msdf/receiver",
    "msdf/receiver-patch",
  ];
  const atlas = await rowsParity(ctx, "gate4", legs, "uploads", [
    "seq",
    "id",
    "hash",
    "op",
    "data_bytes",
  ]);
  out.push(
    mk(
      "atlas-upload-parity@gsw",
      "G7t: every text leg uploads its glyph atlases exactly as the native receiver does, row for row (seq, id, hash, op, bytes): one upload per wire atlas version",
      atlas.problems,
      `${atlas.rows} upload rows on ${legs.length} legs equal the native census`,
    ),
  );
  // P-G2, per glyph box (G7tm: gate 4e's MSDF glyphs too).
  let boxes = 0;
  let exact = 0;
  const notes: string[] = [];
  const perLeg: string[] = [];
  for (const [leg, ref, fix] of [
    ...TEXT_LEGS,
    ["msdf/receiver", "msdf/reference", "gate4-msdf"] as const,
  ]) {
    const e = fixture<Gate4Expected>(ctx, fix);
    const [boxes0, exact0] = [boxes, exact];
    let legMax = 0;
    for (const [k, seq] of settleSeqs(join(ctx.sourceDir, leg)).entries()) {
      const a = await decodePngRgba(
        join(ctx.sourceDir, ref, "shots", `step-${k}.png`),
      );
      const b = await decodePngRgba(
        join(gswLeg(ctx, "gate4", leg), "shots", `seq-${seq}.png`),
      );
      const step = e.steps.find((s) => s.step === k);
      if (!a || !b || !step) continue;
      for (const [name, box] of Object.entries(step.text_regions)) {
        boxes++;
        let px = 0;
        let max = 0;
        for (let y = box[1]; y < box[3]; y++)
          for (let x = box[0]; x < box[2]; x++) {
            const i = (y * a.width + x) * 4;
            let d = 0;
            for (let c = 0; c < 4; c++)
              d = Math.max(d, Math.abs(a.data[i + c] - b.data[i + c]));
            if (d > 0) px++;
            max = Math.max(max, d);
          }
        legMax = Math.max(legMax, max);
        if (px === 0) exact++;
        else if (notes.length < 12)
          notes.push(`${leg} step ${k} ${name}: ${px} px, max ${max}`);
      }
    }
    perLeg.push(`${leg} ${exact - exact0}/${boxes - boxes0} (max ${legMax})`);
  }
  out.push({
    id: "glyph-boxes-exact@gsw",
    criterion:
      "P-G2 (report only; Q7 judges the glyph boxes as delta1): each glyph box of every text leg's settle shots equals the rendered reference byte for byte",
    passed: exact === boxes,
    gating: false,
    detail: `${exact}/${boxes} glyph boxes exact (${perLeg.join(", ")})${notes.length ? `; ${notes.join("; ")}` : ""}`,
  });
  // The GSW bundle never shapes: no shaper, no font among its inputs.
  {
    const problems: string[] = [];
    const build = await readJson<{ inputs?: string[] }>(
      join(ctx.out, "gsw-bundle", "build.json"),
    );
    if (!build?.inputs?.length)
      problems.push("no gsw-bundle/build.json inputs");
    for (const p of build?.inputs ?? [])
      if (/hb-gpu|harfbuzz|\.(ttf|otf|woff2?|fnt|fontdata)$/i.test(p))
        problems.push(`${p} is a shaper or a font`);
    out.push(
      mk(
        "gsw-never-shapes@gsw",
        "G7t (receiver-never-shapes' GSW half): the GSW bundle's inputs hold no shaper (hb-gpu, harfbuzz) and no font file; glyphs arrive as atlas textures only",
        problems,
        `${build?.inputs?.length ?? 0} bundle inputs, none a shaper or a font`,
      ),
    );
  }
  out.push(
    await msdfSabotage(
      ctx,
      "msdf/sabotage-gsw-msdf-no-median",
      "sabotage-msdf-no-median@gsw",
      "the MSDF program takes the smallest of the three distances instead of their median",
    ),
    await msdfSabotage(
      ctx,
      "msdf/sabotage-gsw-msdf-px-range",
      "sabotage-msdf-px-range@gsw",
      "every MSDF draw takes half the wire's px_range",
    ),
  );
  for (const [leg] of TEXT_LEGS)
    out.push(
      await compositor(
        `compositor-equals-readback-g4-${leg.replace(/\/receiver$/, "").replace(/^receiver$/, "main")}@gsw`,
        gswLeg(ctx, "gate4", leg),
      ),
    );
  return out;
}

/** G7tm's MSDF sabotages: at every settle step the sabotage leg's shot differs from the honest
 * gsw leg (`msdf/receiver`) in exactly the MSDF text regions that step draws (gate 4e's
 * expected.json `text_regions`), and in no pixel outside them. */
async function msdfSabotage(
  ctx: G45Ctx,
  leg: string,
  id: string,
  what: string,
): Promise<Gate7Check> {
  const problems: string[] = [];
  const e = fixture<Gate4Expected>(ctx, "gate4-msdf");
  const seqs = settleSeqs(join(ctx.sourceDir, "msdf/receiver"));
  const honest = join(gswLeg(ctx, "gate4", "msdf/receiver"), "shots");
  const sab = join(gswLeg(ctx, "gate4", leg), "shots");
  let steps = 0;
  let changed = 0;
  for (const [k, seq] of seqs.entries()) {
    const a = await decodePngRgba(join(honest, `seq-${seq}.png`));
    const b = await decodePngRgba(join(sab, `seq-${seq}.png`));
    const step = e.steps.find((s) => s.step === k);
    if (!a || !b || !step) {
      problems.push(`step ${k}: shot or step missing`);
      continue;
    }
    steps++;
    const regions = Object.entries(step.text_regions);
    const failed = new Set<string>();
    let outside = 0;
    for (let y = 0; y < a.height; y++)
      for (let x = 0; x < a.width; x++) {
        const i = (y * a.width + x) * 4;
        if (
          a.data[i] === b.data[i] &&
          a.data[i + 1] === b.data[i + 1] &&
          a.data[i + 2] === b.data[i + 2] &&
          a.data[i + 3] === b.data[i + 3]
        )
          continue;
        changed++;
        const inside = regions.filter(
          ([, r]) => x >= r[0] && x < r[2] && y >= r[1] && y < r[3],
        );
        if (inside.length === 0) outside++;
        for (const [name] of inside) failed.add(name);
      }
    const want = regions
      .map(([n]) => n)
      .sort()
      .join(",");
    const got = [...failed].sort().join(",");
    if (want !== got)
      problems.push(`step ${k}: differs in {${got}}, predicted {${want}}`);
    if (outside > 0)
      problems.push(
        `step ${k}: ${outside} px differ outside every text region`,
      );
  }
  if (steps === 0) problems.push("no shots compared");
  return mk(
    id,
    `G7tm: ${what}; at every settle step the shot differs from the honest gsw leg in exactly the MSDF text regions gate 4e's expected.json lists for that step, and in no pixel outside them`,
    problems,
    `${steps} steps, ${changed} px changed, each step exactly in its text regions`,
  );
}

// ------------------------------------------------------------------------------------------ g7-5

const f32 = Math.fround;

/** `Math::make_half_float` then `unpackHalf2x16` (math_funcs.h:748-794): truncated mantissa,
 * values below 2^-14 to zero. GLES3 carries TYPE_PRIMITIVE colours this way, and the hand model
 * keeps some of them at float32 (both round to the same UNORM8 level). */
function godotHalf(v: number): number {
  const b = new DataView(new ArrayBuffer(4));
  b.setFloat32(0, v);
  const x = b.getUint32(0);
  const sign = x >>> 31;
  const mantissa = x & 0x7fffff;
  const exponent = x & 0x7f800000;
  let bits: number;
  if (exponent >= 0x47800000) bits = (sign << 31) | 0x7f800000;
  else if (exponent <= 0x38000000) bits = 0;
  else bits = ((sign << 31) | exponent | (mantissa & ~0x1fff)) >>> 0;
  b.setUint32(0, bits >>> 0);
  return b.getFloat32(0);
}

/** The area a triangle list covers, in float64 (`|cross| / 2` summed). */
function trianglesArea(pos: number[][], tris: number[][]): number {
  let a = 0;
  for (const [i, j, k] of tris)
    a += Math.abs(
      (pos[j][0] - pos[i][0]) * (pos[k][1] - pos[i][1]) -
        (pos[j][1] - pos[i][1]) * (pos[k][0] - pos[i][0]),
    );
  return a / 2;
}

/** `geom::xform_point` in float32, operation by operation. */
function xformPoint(t: readonly number[], p: readonly number[]): number[] {
  return [
    f32(f32(f32(t[0] * p[0]) + f32(t[2] * p[1])) + t[4]),
    f32(f32(f32(t[1] * p[0]) + f32(t[3] * p[1])) + t[5]),
  ];
}

interface Lowered {
  id: number;
  pos: number[];
  col: number[];
  idx: number[];
}

/** Finds `shape` (draw transform applied) in `item` at or after vertex `from`: positions bit-equal,
 * colours bit-equal, every hand triangle among the item's triangles. Returns the next cursor, or
 * a reason. */
function findShape(
  shape: MeshShape,
  draw: Affine | null,
  item: Lowered,
  tris: Set<string>,
  from: number,
): number | string {
  const pts = shape.vertices.map((v) =>
    draw ? xformPoint(draw, v) : [f32(v[0]), f32(v[1])],
  );
  const n = item.pos.length / 2;
  const colour = (k: number) =>
    shape.colors.length === shape.vertices.length
      ? shape.colors[k]
      : shape.colors[0];
  const at = (i: number) =>
    `${f32(item.pos[2 * i])},${f32(item.pos[2 * i + 1])}`;
  const key = (p: number[]) => `${p[0]},${p[1]}`;
  let best = "";
  for (let s = from; s + pts.length <= n; s++) {
    // The hand vertex k is lowered vertex map[k]: in order (every op but rects), else as the
    // same set of positions (TYPE_RECT's corner order is canvas.glsl's, not the hand model's).
    let map: number[] | null = pts.every((p, k) => key(p) === at(s + k))
      ? pts.map((_, k) => s + k)
      : null;
    if (!map) {
      const window = new Map<string, number[]>();
      for (let i = s; i < s + pts.length; i++)
        window.set(at(i), [...(window.get(at(i)) ?? []), i]);
      const used = new Map<string, number>();
      const m: number[] = [];
      for (const p of pts) {
        const list = window.get(key(p));
        const u = used.get(key(p)) ?? 0;
        if (!list || u >= list.length) break;
        m.push(list[u]);
        used.set(key(p), u + 1);
      }
      if (m.length === pts.length) map = m;
    }
    if (!map) continue;
    let ok = true;
    for (let k = 0; k < pts.length && ok; k++)
      for (let c = 0; c < 4; c++) {
        const got = f32(item.col[4 * map[k] + c]);
        const want = f32(colour(k)[c]);
        if (!sameColour(got, want)) {
          best = `colour of vertex ${k} channel ${c}: ${got} != ${want}`;
          ok = false;
          break;
        }
      }
    if (!ok) continue;
    // Triangles: the hand model's own, or (gate 5's polygons, which make_expected.py tiles with
    // "any triangulation", Q1c; rect quads split along the other diagonal) as many lowered
    // triangles over the shape's vertices covering the same area.
    const toHand = new Map(map.map((i, k) => [i, k]));
    const own = shape.triangles.every((t) =>
      tris.has(
        t
          .map((v) => map[v])
          .sort((a, b) => a - b)
          .join(","),
      ),
    );
    if (!own) {
      const mine = [...tris]
        .map((t) => t.split(",").map(Number))
        .filter((t) => t.every((v) => toHand.has(v)))
        .map((t) => t.map((v) => toHand.get(v) as number));
      const want = trianglesArea(pts, shape.triangles);
      if (
        mine.length !== shape.triangles.length ||
        Math.abs(trianglesArea(pts, mine) - want) > 1e-9 * Math.max(1, want)
      ) {
        best = `${mine.length} lowered triangles over the shape's vertices (area ${trianglesArea(pts, mine)}), hand ${shape.triangles.length} (area ${want})`;
        continue;
      }
    }
    return s + pts.length;
  }
  return best || "vertices not found bit for bit";
}

/** A lowered colour channel against the hand model's: equal, or equal at binary16 precision
 * (GLES3 packs TYPE_PRIMITIVE colours with `make_half_float`, which truncates; the hand model
 * keeps float32 for some ops and rounds others to nearest; all of them meet at UNORM8). */
function sameColour(got: number, want: number): boolean {
  if (got === want || got === godotHalf(want)) return true;
  if (want === 0) return got === 0;
  const ulp = 2 ** (Math.floor(Math.log2(Math.abs(want))) - 10);
  return Math.abs(got - want) <= ulp;
}

async function loweringParity(ctx: G45Ctx): Promise<Gate7Check> {
  const problems: string[] = [];
  let shapes = 0;
  let matched = 0;
  let skipped = 0;
  for (const [fix, prefix] of [
    ["gate5", ""],
    ["gate5-mesh", "mesh/"],
    ["gate5-style", "style/"],
  ] as const) {
    const e = fixture<Gate5Expected>(ctx, fix);
    const capture = join(ctx.sourceDir, `${prefix}capture`);
    const recording = join(capture, RECORDING_NAME);
    const seqs = settleSeqs(join(ctx.sourceDir, `${prefix}receiver`));
    if (!existsSync(recording) || seqs.length === 0) {
      problems.push(`${fix}: no source recording or settle seqs`);
      continue;
    }
    const { ids } = itemIdsByName(e, await loadRecording(recording));
    const r = spawnSync(
      ctx.rsCoreCheck,
      [
        "lowered",
        recording,
        "--seqs",
        seqs.join(","),
        "--store",
        join(capture, "store"),
      ],
      { encoding: "utf8", maxBuffer: 1 << 30 },
    );
    if (r.status !== 0) {
      problems.push(`${fix}: rs-core-check lowered: ${r.stderr.trim()}`);
      continue;
    }
    const bySeq = new Map<number, Map<number, Lowered>>();
    for (const line of r.stdout.split("\n").filter(Boolean)) {
      const j = JSON.parse(line) as { seq: number; items: Lowered[] };
      bySeq.set(j.seq, new Map(j.items.map((i) => [i.id, i])));
    }
    for (const [k, seq] of seqs.entries()) {
      const step = e.steps.find((s) => s.step === k);
      const lowered = bySeq.get(seq);
      if (!step || !lowered) {
        problems.push(`${fix} step ${k}: no lowering at seq ${seq}`);
        continue;
      }
      for (const item of step.items) {
        const id = ids.get(item.name);
        const got = id === undefined ? undefined : lowered.get(id);
        const ops = (e.op_lists[item.ops] ?? []) as Gate5Op[];
        if (!got) {
          if (ops.some((o) => "kind" in o && o.kind === "mesh"))
            problems.push(`${fix} step ${k} ${item.name}: no lowered item`);
          continue;
        }
        const tris = new Set<string>();
        for (let t = 0; t + 2 < got.idx.length; t += 3)
          tris.add(
            [got.idx[t], got.idx[t + 1], got.idx[t + 2]]
              .sort((a, b) => a - b)
              .join(","),
          );
        let draw: Affine | null = null;
        let cursor = 0;
        for (const op of ops) {
          if (!("kind" in op)) {
            if (op.op === "set_transform") draw = [...op.transform] as Affine;
            continue;
          }
          if (op.kind !== "mesh") {
            skipped++;
            continue;
          }
          shapes++;
          const at = findShape(op, draw, got, tris, cursor);
          if (typeof at === "number") {
            matched++;
            cursor = at;
          } else if (problems.length < 12)
            problems.push(`${fix} step ${k} ${item.name}/${op.name}: ${at}`);
        }
      }
    }
  }
  return mk(
    "lowering-parity@gsw",
    "Q14d/G7t: every hand-lowered mesh shape of gate 5's three fixtures (make_expected.py's float32 lowering, which geometry-raster.ts rasterizes) is found bit for bit in the Rust lowering of the same item at every settle seq: positions (draw transform applied in float32), straight colours (or their binary16 truncation, where GLES3 packs TYPE_PRIMITIVE colours) and triangles (the hand model's own, or for its 'any triangulation' polygons as many covering the same area)",
    problems,
    `${matched}/${shapes} shapes bit-equal (${skipped} thin lines and nine-patches are not vertex shapes)`,
  );
}

/** Whether a contour is convex (every turn the same way; collinear turns ignored). */
function convex(points: number[][]): boolean {
  let sign = 0;
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const [a, b, c] = [points[i], points[(i + 1) % n], points[(i + 2) % n]];
    const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (cross === 0) continue;
    const s = Math.sign(cross);
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

async function polygonWinding(ctx: G45Ctx): Promise<Gate7Check> {
  const problems: string[] = [];
  const e = fixture<Gate5Expected>(ctx, "gate5");
  // Each item's calls as last drawn (expected.json `calls`, listed for the items a step redraws;
  // step 0 draws them all), and the regions holding a concave add_polygon at each step.
  const seqs = settleSeqs(join(ctx.sourceDir, "receiver"));
  const current = new Map<string, { region: string; concave: boolean }>();
  const predicted = new Map<number, Set<string>>();
  for (const step of [...e.steps].sort((a, b) => a.step - b.step)) {
    for (const [region, calls] of Object.entries(step.calls)) {
      const items = new Set(calls.map((c) => c.item));
      for (const item of items)
        current.set(item, {
          region,
          concave: calls.some(
            (c) =>
              c.item === item &&
              c.op === "canvas_item_add_polygon" &&
              Array.isArray(c.points) &&
              (c.points as number[][]).length > 3 &&
              !convex(c.points as number[][]),
          ),
        });
    }
    predicted.set(
      step.step,
      new Set(
        [...current.values()].filter((v) => v.concave).map((v) => v.region),
      ),
    );
  }
  const honest = join(gswLeg(ctx, "gate5", "receiver"), "shots");
  const sab = join(
    gswLeg(ctx, "gate5", "sabotage-gsw-polygon-winding"),
    "shots",
  );
  let steps = 0;
  for (const [k, seq] of seqs.entries()) {
    const a = await decodePngRgba(join(honest, `seq-${seq}.png`));
    const b = await decodePngRgba(join(sab, `seq-${seq}.png`));
    if (!a || !b) {
      problems.push(`step ${k}: shot missing`);
      continue;
    }
    steps++;
    const failed = new Set<string>();
    for (const [name, box] of Object.entries(e.regions)) {
      let differs = false;
      for (let y = box[1]; y < box[3] && !differs; y++)
        for (let x = box[0]; x < box[2]; x++) {
          const i = (y * a.width + x) * 4;
          if (
            a.data[i] !== b.data[i] ||
            a.data[i + 1] !== b.data[i + 1] ||
            a.data[i + 2] !== b.data[i + 2] ||
            a.data[i + 3] !== b.data[i + 3]
          ) {
            differs = true;
            break;
          }
        }
      if (differs) failed.add(name);
    }
    const want = [...(predicted.get(k) ?? [])].sort().join(",");
    const got = [...failed].sort().join(",");
    if (want !== got)
      problems.push(`step ${k}: differs in {${got}}, predicted {${want}}`);
  }
  if (steps === 0) problems.push("no shots compared");
  return mk(
    "sabotage-polygon-winding@gsw",
    "G7t: add_polygon lowered as a triangle fan over the reversed contour fails exactly gate 5b's polygon regions: at every settle step the shots differ from the honest gsw leg in exactly the regions holding a concave add_polygon (from the source recording), and nowhere else",
    problems,
    `${steps} steps, each differing exactly in {${[...(predicted.get(0) ?? [])].join(",")}}`,
  );
}

async function gate5Checks(ctx: G45Ctx): Promise<Gate7Check[]> {
  const mesh = await rowsParity(
    ctx,
    "gate5",
    ["mesh/receiver", "mesh/receiver-patch", "mesh/receiver-inline"],
    "mesh_uploads",
    ["seq", "id", "op", "surfaces", "buffers", "bytes"],
  );
  return [
    mk(
      "mesh-upload-parity@gsw",
      "G7t (gate 5e): every mesh leg's mesh_uploads equal the native receiver's row for row (seq, id, op, surfaces, buffers, bytes): one GSW upload per wire mesh version, as the native census",
      mesh.problems,
      `${mesh.rows} mesh upload rows on 3 legs equal the native census`,
    ),
    await loweringParity(ctx),
    await polygonWinding(ctx),
    await compositor(
      "compositor-equals-readback-g5-main@gsw",
      gswLeg(ctx, "gate5", "receiver"),
    ),
    await compositor(
      "compositor-equals-readback-g5-mesh@gsw",
      gswLeg(ctx, "gate5", "mesh/receiver"),
    ),
    await compositor(
      "compositor-equals-readback-g5-style@gsw",
      gswLeg(ctx, "gate5", "style/receiver"),
    ),
  ];
}

export async function g45ExtraChecks(
  gate: "gate4" | "gate5",
  ctx: G45Ctx,
): Promise<Gate7Check[]> {
  return gate === "gate4" ? gate4Checks(ctx) : gate5Checks(ctx);
}

export type { Rgba };
