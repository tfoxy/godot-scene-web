// G7s's own checks for the GSW canvas receiver on gate 5.5 (gate7-design.md G7s "Checks" and
// "Sabotages", Q7), beside gate 5.5's g55d/g55e checks that lib/gate7-gsw.ts runs through
// check-gate55.ts's own code:
//
//   compositor-equals-readback  the CDP screenshot of each compositor leg equals its last shot
//   shader-transpile-set        the predicted set (every fixture shader of gate 5.5c that the wire
//                               does not refuse) transpiles and compiles: one program per code
//                               hash, no `gsw-shader-transpile` refusal, on every honest leg
//   shader-param-parity         every item-space binding's uniform values, at every applied
//                               transaction, equal the wire's resolved parameter values (material
//                               parameters, instance parameters), converted as Godot's GLES3
//                               material storage converts a Variant (f32 floats, truncated ints,
//                               bools 0/1, short arrays zero-filled)
//   sabotage-blend-swap         the GSW-only `blend-swap` (every effective add draws sub and every
//                               sub add) mismatches the reference in exactly the (step, region)s
//                               whose items draw with an add or sub CanvasItemMaterial, predicted
//                               from gate55-cim's expected.json `effective` table
//
// Every prediction comes from the fixtures' own expected.json or the wire, never from a GSW run.

import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { decodePngRgba } from "./gate-minus1-checks";
import type { Gate7Check } from "./gate7-adapters";
import { compositorProblems, GSW_LEGS, mk } from "./gate7-gsw";
import { type Rect, readTolerance, type StepMasks } from "./gsw-tolerance";
import { type ResolvedParam, resolveRecording } from "./render-stream-2";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(HERE, "..", "..", "fixtures");

interface Ctx {
  out: string;
  sourceDir: string;
}

/** Q7's rendered success legs of gate 5.5: [leg, reference dir, gsw-tolerance.json key]. */
export const GATE55_Q7_LEGS: [string, string, string][] = [
  ["cim/receiver", "cim/reference", "gate55-cim"],
  ["cim/receiver-patch", "cim/reference", "gate55-cim"],
  ["cim/receiver-inline", "cim/reference", "gate55-cim"],
  ["cim-modulate/receiver", "cim-modulate/reference", "gate55-cim-modulate"],
  [
    "cim-modulate/receiver-patch",
    "cim-modulate/reference",
    "gate55-cim-modulate",
  ],
  [
    "cim-modulate/receiver-inline",
    "cim-modulate/reference",
    "gate55-cim-modulate",
  ],
  ["shader/receiver", "shader/reference", "gate55-shader"],
  ["shader/receiver-patch", "shader/reference", "gate55-shader"],
  ["shader/receiver-inline", "shader/reference", "gate55-shader"],
  ["shader-policy-params/receiver-lib", "shader/reference", "gate55-shader"],
];

/** Honest ShaderMaterial legs (every predicted shader is drawn with its code). */
const HONEST_SHADER_LEGS = [
  "shader/receiver",
  "shader/receiver-patch",
  "shader/receiver-inline",
  "shader-policy-params/receiver-lib",
];

async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function gswDir(ctx: Ctx, leg: string): string {
  return join(ctx.out, "gate55", "gsw", leg);
}

function shotSeqs(dir: string): number[] {
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

// ------------------------------------------------------------------------- transpile set

interface ShaderExpected {
  shader_codes: Record<string, { sha256: string }>;
  shader_scan: Record<string, { reason: string | null }>;
  shader_order: string[];
  variants: { refused: { shader_order: string[] } };
}

async function transpileSet(ctx: Ctx): Promise<Gate7Check> {
  const expected = JSON.parse(
    readFileSync(join(FIXTURES, "gate55-shader", "expected.json"), "utf8"),
  ) as ShaderExpected;
  // The predicted set: every fixture shader code the wire does not refuse (refused ones are typed
  // by the capture and never reach a receiver's transpiler). `tint_b` is a code (step 3 assigns
  // its text to `tint`), not a scanned resource of its own.
  // The honest legs replay the base scene: a shader only the `refused` variant makes (P3-ST:
  // its screen shader is `ok` now) never reaches them.
  const variantOnly = new Set(
    expected.variants.refused.shader_order.filter(
      (name) => !expected.shader_order.includes(name),
    ),
  );
  const predicted = Object.keys(expected.shader_codes).filter(
    (name) =>
      !variantOnly.has(name) &&
      (expected.shader_scan[name]?.reason ?? null) === null,
  );
  const problems: string[] = [];
  for (const leg of HONEST_SHADER_LEGS) {
    const dir = gswDir(ctx, leg);
    const perf = await readJson<{
      counts?: { programs?: { defined: number; refused: number } };
    }>(join(dir, "perf.json"));
    const applied = await readJson<{
      unsupported?: { reason: string; detail?: string }[];
    }>(join(dir, "applied.json"));
    const programs = perf?.counts?.programs;
    if (!programs) {
      problems.push(`${leg}: perf.json has no program counts`);
      continue;
    }
    if (programs.defined !== predicted.length || programs.refused !== 0)
      problems.push(
        `${leg}: ${programs.defined} programs defined, ${programs.refused} refused (predicted ${predicted.length}, 0)`,
      );
    for (const u of applied?.unsupported ?? [])
      if (
        u.reason === "gsw-shader-transpile" ||
        u.reason === "gsw-shader-builtin"
      )
        problems.push(`${leg}: ${u.reason} ${u.detail ?? ""}`);
  }
  return mk(
    "shader-transpile-set@gsw",
    `G7s "Predicted transpile set": every gate 5.5c shader the wire does not refuse (${predicted.join(", ")}) transpiles in packages/effects and compiles in canvas-items, one program per code hash, on every honest ShaderMaterial leg; none is typed gsw-shader-transpile or drawn with the builtin program`,
    problems,
    `${predicted.length} shaders, each a program on ${HONEST_SHADER_LEGS.length} legs`,
  );
}

// ------------------------------------------------------------------------ param parity

interface ParamLine {
  seq: number;
  slot: number;
  material: number | null;
  item: number | null;
  program: number;
  uniforms: Record<string, (number | null)[]>;
}

/** The wire value of a parameter as `count` GL values of `kind` (Godot's conversion,
 * material_storage.cpp `_fill_std140_variant_ubo_value`). */
function expectedValues(
  p: ResolvedParam,
  count: number,
  kind: "float" | "int",
  isArray: boolean,
  components: number,
): number[] | null {
  const v = p.value;
  if (v === null || (typeof v === "object" && !Array.isArray(v))) return null;
  const flat: number[] = Array.isArray(v)
    ? (v as (number | number[])[]).flat()
    : [v as number];
  const out = new Array<number>(count).fill(0);
  const take = isArray
    ? Math.min(Math.floor(flat.length / components) * components, count)
    : Math.min(flat.length, count);
  for (let i = 0; i < take; i++) out[i] = flat[i];
  return kind === "float"
    ? out.map((x) => Math.fround(x))
    : out.map((x) => (p.type === "bool" ? (x !== 0 ? 1 : 0) : Math.trunc(x)));
}

async function paramParity(ctx: Ctx): Promise<Gate7Check> {
  const problems: string[] = [];
  let compared = 0;
  let unset = 0;
  for (const leg of HONEST_SHADER_LEGS) {
    const dir = gswDir(ctx, leg);
    const path = join(dir, "gsw", "shader-params.jsonl");
    if (!existsSync(path)) {
      problems.push(`${leg}: gsw/shader-params.jsonl missing`);
      continue;
    }
    const lines = readFileSync(path, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as ParamLine);
    const applied = await readJson<{ transactions?: { seq: number }[] }>(
      join(dir, "applied.json"),
    );
    const resolved = resolveRecording(
      new Uint8Array(readFileSync(join(dir, "recording.rs2"))),
    );
    const bySeq = new Map(resolved.transactions.map((t) => [t.seq, t.state]));
    // Each slot's values hold from its entry's seq until its next entry.
    const live = new Map<number, ParamLine>();
    let cursor = 0;
    for (const t of applied?.transactions ?? []) {
      while (cursor < lines.length && lines[cursor].seq <= t.seq) {
        const l = lines[cursor++];
        if (l.program === 0) live.delete(l.slot);
        else live.set(l.slot, l);
      }
      const state = bySeq.get(t.seq);
      if (!state) {
        problems.push(`${leg} seq ${t.seq}: not in the recording`);
        continue;
      }
      const materials = new Map((state.materials ?? []).map((m) => [m.id, m]));
      const items = new Map(state.items.map((it) => [it.id, it]));
      for (const l of live.values()) {
        const m = l.material === null ? undefined : materials.get(l.material);
        const it = l.item === null ? undefined : items.get(l.item);
        for (const [name, got] of Object.entries(l.uniforms)) {
          const fromItem = it?.instance_params?.find((p) => p.name === name);
          const p =
            fromItem ??
            m?.params.find((x) => x.name === name && x.value !== null);
          if (!p) {
            unset++;
            continue;
          }
          const isArray =
            Array.isArray(p.value) && p.type.startsWith("packed_");
          const components =
            isArray && Array.isArray((p.value as unknown[])[0])
              ? ((p.value as number[][])[0]?.length ?? 1)
              : 1;
          const kind =
            got.every((x) => x !== null && Number.isInteger(x)) &&
            (p.type === "int" ||
              p.type === "bool" ||
              p.type.endsWith("i") ||
              p.type === "packed_int32_array" ||
              p.type === "packed_int64_array")
              ? "int"
              : "float";
          const want = expectedValues(p, got.length, kind, isArray, components);
          compared++;
          if (
            want === null ||
            want.length !== got.length ||
            want.some((w, i) => got[i] !== w)
          )
            problems.push(
              `${leg} seq ${t.seq} material ${l.material} ${name}: gsw ${JSON.stringify(got)} wire ${JSON.stringify(p.value)} (${p.type})`,
            );
        }
      }
    }
  }
  return mk(
    "shader-param-parity@gsw",
    "G7s: at every applied transaction of every honest ShaderMaterial leg, each item-space binding's uniform values (gsw/shader-params.jsonl, the core's resolved parameters through evidence) equal the wire's resolved material and instance parameter values, converted as Godot's GLES3 material storage converts a Variant",
    problems,
    `${compared} uniform values equal the wire's (${unset} declared but unset on the wire, at their defaults)`,
  );
}

// ------------------------------------------------------------------------ blend swap

interface CimExpected {
  regions: Record<string, [number, number, number, number]>;
  variants: Record<
    string,
    {
      steps: {
        step: number;
        effective: Record<string, [string, string]>;
        items: { name: string; region: string }[];
      }[];
    }
  >;
}

/** The (step, region)s where an item draws with an effective add or sub blend (and draws at
 * all: light_only draws nothing without lights). */
export function blendSwapPrediction(e: CimExpected): Map<number, Set<string>> {
  const out = new Map<number, Set<string>>();
  for (const s of e.variants.base.steps) {
    const regionOf = new Map(s.items.map((i) => [i.name, i.region]));
    const set = new Set<string>();
    for (const [item, [blend, light]] of Object.entries(s.effective))
      if ((blend === "add" || blend === "sub") && light !== "light_only") {
        const r = regionOf.get(item);
        if (r) set.add(r);
      }
    out.set(s.step, set);
  }
  return out;
}

async function blendSwap(ctx: Ctx): Promise<Gate7Check> {
  const e = JSON.parse(
    readFileSync(join(FIXTURES, "gate55-cim", "expected.json"), "utf8"),
  ) as CimExpected;
  const predicted = blendSwapPrediction(e);
  const masks = readTolerance().gates["gate55-cim"]?.steps ?? [];
  const leg = gswDir(ctx, "cim/sabotage-gsw-blend-swap");
  const seqs = shotSeqs(join(ctx.sourceDir, "cim", "receiver"));
  const problems: string[] = [];
  const found: string[] = [];
  for (const [k, seq] of seqs.entries()) {
    const ref = await decodePngRgba(
      join(ctx.sourceDir, "cim", "reference", "shots", `step-${k}.png`),
    );
    const got = await decodePngRgba(join(leg, "shots", `seq-${seq}.png`));
    if (!ref || !got) {
      problems.push(`step ${k}: shot or reference missing`);
      continue;
    }
    const m: StepMasks = masks[k] ?? { step: k, delta1: [], undecided: [] };
    const mismatching = new Set<string>();
    for (const [region, [x0, y0, x1, y1]] of Object.entries(e.regions))
      if (regionFails(ref, got, [x0, y0, x1 - x0, y1 - y0], m))
        mismatching.add(region);
    const want = predicted.get(k) ?? new Set<string>();
    const a = [...mismatching].sort().join(",");
    const b = [...want].sort().join(",");
    found.push(`${k}:{${a}}`);
    if (a !== b)
      problems.push(`step ${k}: mismatching {${a}}, predicted {${b}}`);
  }
  return mk(
    "sabotage-blend-swap@gsw",
    "G7s: the GSW-only blend-swap sabotage (add draws sub, sub draws add) mismatches the cim reference under Q7 in exactly the (step, region)s whose items draw with an effective add or sub CanvasItemMaterial (gate55-cim expected.json `effective`)",
    problems,
    `mismatching exactly as predicted: ${found.join(" ")}`,
  );
}

/** Whether `got` differs from `ref` inside `rect` beyond Q7's allowance for its masks. */
function regionFails(
  ref: { width: number; data: Uint8Array },
  got: { width: number; data: Uint8Array },
  rect: Rect,
  masks: StepMasks,
): boolean {
  const inside = (list: { rect: Rect }[], x: number, y: number) =>
    list.some(
      ({ rect: r }) =>
        x >= r[0] && x < r[0] + r[2] && y >= r[1] && y < r[1] + r[3],
    );
  const [x0, y0, w, h] = rect;
  for (let y = y0; y < y0 + h; y++)
    for (let x = x0; x < x0 + w; x++) {
      const i = (y * ref.width + x) * 4;
      let d = 0;
      for (let c = 0; c < 4; c++)
        d = Math.max(d, Math.abs(ref.data[i + c] - got.data[i + c]));
      if (d === 0 || inside(masks.undecided, x, y)) continue;
      if (d <= 1 && inside(masks.delta1, x, y)) continue;
      return true;
    }
  return false;
}

// --------------------------------------------------------------------------- entry

export async function gate55Checks(ctx: Ctx): Promise<Gate7Check[]> {
  const out: Gate7Check[] = [];
  // One per compositor leg: gating when its last shot is of the frame the canvas shows at exit;
  // the ShaderMaterial scene's PH animates every frame, so its last settle shot never is, and
  // that leg's comparison is reported with the reason (as G7a's compositorCheck does).
  for (const d of GSW_LEGS.gate55.filter((x) => x.compositor && x.replaces)) {
    const problems = await compositorProblems(gswDir(ctx, d.leg));
    const comparable = !problems.some((p) => /is not of the state/.test(p));
    out.push(
      mk(
        `compositor-equals-readback:${d.leg.split("/")[0]}@gsw`,
        "Q7: the CDP screenshot of the canvas, taken while the leg's applied.json PUT is held, equals the leg's last shot channel for channel (an opaque frame of the same state)",
        problems,
        "screenshot equals the last shot exactly",
        comparable,
      ),
    );
  }
  out.push(
    await transpileSet(ctx),
    await paramParity(ctx),
    await blendSwap(ctx),
  );
  return out;
}
