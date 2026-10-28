#!/usr/bin/env -S pnpm exec tsx --conditions=development
// Self-test for gate 8's g8pt checks (lib/gate8-pt-checks.ts, PM5) on synthetic hook logs and
// recordings resolved through render-stream-2.ts (applyTransaction), against the real
// fixtures/gate8-pt/expected.json.
//
//   mise exec -- pnpm exec tsx --conditions=development \
//     experiments/render-stream/scripts/test/self-test-gate8-pt.ts
//
// A small simulator plays pt.gd's ten emitters (nine cells and H_SUB's child) through a capture
// that follows render-stream-12.md: per-call hook lines (GPUParticles2D's constructor, the
// fixture's setters, B_SPHERE's per-frame emission transform, the steps, the teardown), one state
// line per emitter per frame its version moved, and both sinks (every transaction full; seq 1 full
// then patches), the emit list included.
//
// 1. parsePtLine: spellings normalize; other kinds are not particles lines; a freed state line
//    gets its rid back by id.
// 2. honest legs: pt-hook-census, pt-wire (table, emits, naming) pass on both sinks; pt_f32 bytes.
// 3. census failures: a missing restart, a missing per-frame emission transform, a stray emitter,
//    a wrong last-state seed each fail.
// 4. pt-wire: perturb-seed and drop-restart fail on the patch sink; a dropped emit, a perturbed
//    float, a missing emitter fail.
// 5. deriveMaterialKey: every expected cell key round-trips through code built the way
//    _update_shader builds it (low-end: sub_emitter underivable; not: derived); golden-12's
//    shader-ppm payload derives its decoded builtin; a wrong shape fails builtinDiffs.
// 6. ptBuiltinProblems, ptV11Problems, ptCurveProblems, ptNoShimProblems, ptShimDistinctProblems,
//    replayedParticleCommands, receiverUndrawn, ptPumpProblems' control half on hand-built traces.
//
// Exits non-zero if any assertion fails.

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { G8mmExpected } from "../lib/gate8-mm-checks";
import {
  builtinDiffs,
  cellKey,
  deriveMaterialKey,
  type G8ptExpected,
  mapPtCells,
  parsePtLine,
  parsePtLog,
  type PtLine,
  type PtTrace,
  type PtTx,
  ptBuiltinProblems,
  ptBytes,
  ptCensusProblems,
  ptCurveProblems,
  ptEmitProblems,
  ptNamedProblems,
  ptNoShimProblems,
  ptPumpProblems,
  ptShimDistinctProblems,
  ptTraceFromTransactions,
  ptV11Problems,
  ptWireProblems,
  receiverUndrawn,
  replayedParticleCommands,
} from "../lib/gate8-pt-checks";
import type {
  BuiltinParticleProcessMaterial,
  ResolvedMaterial,
  ResolvedParticles,
  ResolvedShader,
  ResolvedTexture,
  TransactionMeta,
  TransactionParticles,
} from "../lib/render-stream-2";
import { decodeShaderPayload } from "../lib/render-stream-shader";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXPECTED_PATH = resolve(HERE, "..", "..", "fixtures", "gate8-pt", "expected.json");
const MM_EXPECTED_PATH = resolve(HERE, "..", "..", "fixtures", "gate8-mm", "expected.json");
const GOLDEN_12 = resolve(HERE, "..", "..", "protocol", "golden-12");

let assertions = 0;
let failures = 0;
function expect(ok: boolean, what: string, detail?: unknown): void {
  assertions++;
  if (!ok) {
    failures++;
    console.log(`FAIL ${what}${detail === undefined ? "" : ` -- ${JSON.stringify(detail).slice(0, 700)}`}`);
  }
}

// ------------------------------------------------------------------------------ the simulator

const F = Math.fround;
const QUIT = 90;
const SAB_FRAME = 30;
const IDENT = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];

type Sabotage = "none" | "perturb-seed" | "drop-restart";
interface SimOptions {
  sabotage?: Sabotage;
  /** drop D_ONESHOT's restart line at frame 40 from the hook log (the census must see it) */
  dropRestartLine?: boolean;
  /** skip B_SPHERE's emission transform at this frame */
  skipTransformFrame?: number;
  /** an extra emitter nobody expects */
  stray?: boolean;
  /** drop the second emit of step 1 from the wire */
  dropEmit?: boolean;
  /** perturb E_FLIP's lifetime float on the wire from frame 30 */
  perturbFloat?: boolean;
  /** leave I_TRAILS out of every table */
  hideI?: boolean;
}
interface Emitter {
  name: string;
  rid: string;
  id: number;
  fields: Record<string, unknown>;
  floats: number[];
  moved: boolean;
}
interface Emit {
  frame: number;
  id: number;
  restarts: number;
  flags: number;
  floats: number[];
}
interface Sim {
  lines: PtLine[];
  full: PtTrace;
  patch: PtTrace;
}

function simulate(expected: G8ptExpected, o: SimOptions = {}): Sim {
  const sab = o.sabotage ?? "none";
  const raw: Record<string, unknown>[] = [];
  const emitters: Emitter[] = [];
  const emits: Emit[] = [];
  let frame = 1;
  let nextId = 1;
  const call = (e: Emitter, name: string, args: Record<string, unknown> = {}) =>
    raw.push({ kind: "particles", call: `particles_${name}`, frame, rid: e.rid, id: e.id, accepted: true, ...args });
  const set = (e: Emitter, k: string, v: unknown) => {
    if (JSON.stringify(e.fields[k]) !== JSON.stringify(v)) {
      e.fields[k] = v;
      e.fields.version = (e.fields.version as number) + 1;
      e.moved = true;
    }
  };
  const setF = (e: Emitter, at: number, vs: number[]) => {
    const f = vs.map(F);
    if (f.some((v, i) => !Object.is(v, e.floats[at + i]))) {
      f.forEach((v, i) => {
        e.floats[at + i] = v;
      });
      e.fields.version = (e.fields.version as number) + 1;
      e.moved = true;
    }
  };
  const count = (e: Emitter, k: string) => {
    e.fields[k] = (e.fields[k] as number) + 1;
    e.fields.version = (e.fields.version as number) + 1;
    e.moved = true;
  };
  const make = (name: string): Emitter => {
    const c = expected.cells[name];
    const e: Emitter = {
      name,
      rid: `${1000 + nextId}`,
      id: nextId++,
      fields: {
        status: "ok", reason: null, version: 1, mode: "3d", emitting: false, amount: 0, one_shot: false,
        fixed_fps: 0, interpolate: true, fractional_delta: false, local: false, draw_order: "index",
        transform_align: "disabled", trails: false, trail_poses: 0, seed: 0, restarts: 0, emits: 0,
        process_requests: 0, process_material: null, draw_passes: [], subemitter: null,
      },
      floats: [1, 1, 0, 0, 0, 1, 0.01, 0, 0, 0, -4, -4, -4, 8, 8, 8, ...IDENT, 0, 0, 0].map(F),
      moved: true,
    };
    emitters.push(e);
    call(e, "create");
    // GPUParticles2D's constructor
    call(e, "set_mode", { mode: 0 });
    set(e, "mode", "2d");
    call(e, "set_draw_passes", { count: 1 });
    set(e, "draw_passes", [null]);
    call(e, "set_draw_pass_mesh", { pass: 0, mesh: 500 + e.id, mesh_rid: "9" });
    set(e, "draw_passes", [500 + e.id]);
    call(e, "set_emitting", { enable: true });
    set(e, "emitting", true);
    call(e, "set_one_shot", { one_shot: false });
    call(e, "restart");
    count(e, "restarts");
    call(e, "set_seed", { seed: 77 });
    set(e, "seed", 77);
    call(e, "set_amount", { amount: 8 });
    set(e, "amount", 8);
    call(e, "set_amount_ratio", { amount_ratio: 1 });
    call(e, "set_lifetime", { lifetime: 1 });
    call(e, "set_fixed_fps", { fps: 0 });
    call(e, "set_fractional_delta", { enable: true });
    set(e, "fractional_delta", true);
    call(e, "set_interpolate", { enable: true });
    call(e, "set_pre_process_time", { time: 0 });
    call(e, "set_explosiveness_ratio", { ratio: 0 });
    call(e, "set_randomness_ratio", { ratio: 0 });
    call(e, "set_custom_aabb", { aabb: [-100, -100, 0, 200, 200, 0] });
    setF(e, 10, [-100, -100, 0, 200, 200, 0]);
    call(e, "set_use_local_coordinates", { enable: false });
    call(e, "set_draw_order", { order: 1 });
    set(e, "draw_order", "lifetime");
    call(e, "set_speed_scale", { scale: 1 });
    call(e, "set_fixed_fps", { fps: 30 });
    set(e, "fixed_fps", 30);
    call(e, "set_collision_base_size", { size: 1 });
    setF(e, 6, [1]);
    // _particles()
    call(e, "set_amount", { amount: c.amount });
    set(e, "amount", c.amount);
    call(e, "set_lifetime", { lifetime: 1 });
    call(e, "set_seed", { seed: name === "C_RING" ? 1003 : c.seed });
    set(e, "seed", name === "C_RING" ? 1003 : c.seed);
    call(e, "set_use_local_coordinates", { enable: c.local });
    set(e, "local", c.local);
    call(e, "set_process_material", { material: 200 + e.id, material_rid: "5" });
    set(e, "process_material", 200 + e.id);
    const size = name === "E_FLIP" ? 10 : 2;
    call(e, "set_collision_base_size", { size: 2 });
    setF(e, 6, [2]);
    if (name === "E_FLIP") {
      call(e, "set_collision_base_size", { size });
      setF(e, 6, [size]);
    }
    return e;
  };
  const byName = new Map<string, Emitter>();
  for (const name of Object.keys(expected.cells)) byName.set(name, make(name));
  const D = byName.get("D_ONESHOT") as Emitter;
  call(D, "set_one_shot", { one_shot: true });
  set(D, "one_shot", true);
  call(D, "set_explosiveness_ratio", { ratio: 1 });
  setF(D, 3, [1]);
  call(D, "set_emitting", { enable: false });
  set(D, "emitting", false);
  const HC = byName.get("H_CHILD") as Emitter;
  call(HC, "set_emitting", { enable: false });
  set(HC, "emitting", false);
  const I = byName.get("I_TRAILS") as Emitter;
  call(I, "set_trails", { enable: true, length_sec: 1 });
  set(I, "trails", true);
  call(I, "set_transform_align", { transform_align: 2 });
  set(I, "transform_align", "y_to_velocity");
  call(I, "set_trails", { enable: true, length_sec: 0.3 });
  setF(I, 7, [0.3]);
  if (o.stray) raw.push({ kind: "particles", call: "particles_create", frame, rid: "4242", id: 99, accepted: true });
  // ENTER_TREE, then the first transform flush (every item, local or not)
  for (const e of emitters) call(e, "set_speed_scale", { scale: 1 });
  emitters.forEach((e, k) => {
    const t = [1, 0, 0, 0, 1, 0, 0, 0, 1, 10 * k, 20, 0];
    call(e, "set_emission_transform", { transform: t });
    setF(e, 16, t);
  });
  const H = byName.get("H_SUB") as Emitter;
  call(H, "set_subemitter", { subemitter_particles: HC.id, subemitter_particles_rid: HC.rid });
  set(H, "subemitter", HC.id);
  // the first draw
  for (const e of emitters) {
    const poses = e === I ? [IDENT, IDENT, IDENT, IDENT, IDENT] : [];
    call(e, "set_trail_bind_poses", { bind_poses: poses });
    if (poses.length !== e.fields.trail_poses) {
      e.floats = [...e.floats.slice(0, 31), ...poses.flat().map(F)];
      set(e, "trail_poses", poses.length);
    }
  }
  const A = byName.get("A_BOX") as Emitter;
  const B = byName.get("B_SPHERE") as Emitter;
  const C = byName.get("C_RING") as Emitter;
  const emit = (at: number[]) => {
    const floats = [...IDENT.slice(0, 9), at[0], at[1], 0, 20, 0, 0, 1, 0.2, 0.2, 1, 0, 0, 0, 0].map(F);
    call(A, "emit", {
      transform: floats.slice(0, 12),
      velocity: floats.slice(12, 15),
      color: floats.slice(15, 19),
      custom: floats.slice(19, 23),
      emit_flags: 7,
      restarts: A.fields.restarts,
    });
    count(A, "emits");
    emits.push({ frame, id: A.id, restarts: A.fields.restarts as number, flags: 7, floats });
  };

  const tables: { frame: number; snapshot: Map<number, Emitter> }[] = [];
  let velocity = 0;
  for (frame = 1; frame <= QUIT; frame++) {
    // physics: B's velocity when it changes
    const v = frame === 1 ? 0 : frame % 30 === 1 ? -58 * 60 : 120;
    if (v !== velocity) {
      call(B, "set_emitter_velocity", { velocity: [v, 0, 0] });
      setF(B, 28, [v, 0, 0]);
      velocity = v;
    }
    if (frame === 20) {
      emit([0, 0]);
      emit([4, 4]);
      call(C, "request_process_time", { request_process_time: 0.5 });
      count(C, "process_requests");
      setF(C, 9, [0.5]);
    }
    if (frame === 20 || frame === 40) {
      if (!(o.dropRestartLine && frame === 40)) call(D, "restart");
      if (!(sab === "drop-restart" && frame === 40)) count(D, "restarts");
      call(D, "set_emitting", { enable: true });
      set(D, "emitting", true);
    }
    if (frame === 40) {
      emit([10, 5]);
      emit([14, 9]);
      call(C, "set_seed", { seed: 2003 });
      set(C, "seed", 2003);
    }
    // the transform flush: B's emission transform every frame
    if (frame !== o.skipTransformFrame) {
      const x = 260 + 2 * (frame % 30);
      const t = [1, 0, 0, 0, 1, 0, 0, 0, 1, x, 60, 0];
      call(B, "set_emission_transform", { transform: t });
      setF(B, 16, t);
    }
    for (const e of emitters) {
      if (!e.moved) continue;
      e.moved = false;
      raw.push({ kind: "particles", call: "state", frame, rid: e.rid, id: e.id, ...e.fields, floats: e.floats.slice() });
    }
    const snapshot = new Map<number, Emitter>();
    for (const e of emitters)
      if (!(o.hideI && e === I)) snapshot.set(e.id, { ...e, fields: { ...e.fields }, floats: e.floats.slice() });
    tables.push({ frame, snapshot });
  }
  frame = QUIT + 1;
  for (const e of emitters) call(e, "set_subemitter", { subemitter_particles: null, subemitter_particles_rid: "0" });
  for (const e of emitters) raw.push({ kind: "particles", call: "free", frame, rid: e.rid, id: e.id, accepted: true });
  const lines = raw.map((r) => parsePtLine(r)).filter((l): l is PtLine => l !== null);
  return {
    lines,
    full: ptTraceFromTransactions(encode(tables, emits, "full", sab, o), 12),
    patch: ptTraceFromTransactions(encode(tables, emits, "patch", sab, o), 12),
  };
}

/** Both sinks' decoded transactions over the simulated tables. */
function encode(
  tables: { frame: number; snapshot: Map<number, Emitter> }[],
  emits: Emit[],
  sink: "full" | "patch",
  sab: Sabotage,
  o: SimOptions,
): { meta: TransactionMeta; blocks: number[][] }[] {
  const out: { meta: TransactionMeta; blocks: number[][] }[] = [];
  let base = new Map<number, Emitter>();
  let prevFrame = 0;
  tables.forEach((t, i) => {
    const full = sink === "full" || i === 0;
    const entries: TransactionParticles[] = [];
    const pt: number[] = [];
    let first = true;
    for (const e of t.snapshot.values()) {
      const b = base.get(e.id);
      if (!full && b && b.fields.version === e.fields.version) continue;
      const floats = e.floats.slice();
      if (o.perturbFloat && e.name === "E_FLIP" && t.frame >= SAB_FRAME) floats[1] = F(floats[1] + 0.5);
      const entry = { id: e.id, origin: "created", ...e.fields, f: pt.length } as unknown as TransactionParticles;
      if (sab === "perturb-seed" && t.frame >= SAB_FRAME && first) entry.seed += 1;
      first = false;
      pt.push(...floats);
      entries.push(entry);
    }
    const from = full ? t.frame - 1 : prevFrame;
    const listed = emits.filter((m) => m.frame > from && m.frame <= t.frame).filter((_, k) => !(o.dropEmit && k === 1));
    const pe = listed.map((m) => {
      const f = pt.length;
      pt.push(...m.floats);
      return { particles: m.id, restarts: m.restarts, flags: m.flags, f };
    });
    const ids = new Set(t.snapshot.keys());
    const removed = full ? [] : [...base.keys()].filter((id) => !ids.has(id)).sort((a, b) => a - b);
    const meta = {
      type: "transaction",
      seq: i + 1,
      frame: t.frame,
      encoding: full ? "full" : "patch",
      base_seq: full ? null : i,
      status: "ok",
      failures: [],
      unsupported: [],
      default_texture_filter: "nearest",
      default_texture_repeat: "disabled",
      removed_canvases: [],
      removed_items: [],
      removed_textures: [],
      canvases: [],
      items: [],
      textures: [],
      ...(entries.length > 0 ? { particles: entries } : {}),
      ...(removed.length > 0 ? { removed_particles: removed } : {}),
      ...(pe.length > 0 ? { particle_emits: pe } : {}),
    } as unknown as TransactionMeta;
    out.push({ meta, blocks: [[], [], [], [], [], [], [], [], [], pt] });
    base = new Map(t.snapshot);
    prevFrame = t.frame;
  });
  return out;
}

// ------------------------------------------------------------- generated code for a MaterialKey

/** The key-bearing lines of ParticleProcessMaterial::_update_shader (4.5.1) for `k`, in its
 * order and spelling (tabs and all); everything not key-bearing is a fixed filler. */
function codeFor(k: BuiltinParticleProcessMaterial, lowEnd: boolean): string {
  const L: string[] = [
    "// NOTE: Shader automatically converted from Godot Engine 4.5.1.stable's ParticleProcessMaterial.",
    "",
    "shader_type particles;",
    "render_mode disable_velocity;",
  ];
  if (k.collision_scale) L.push("render_mode collision_use_scale;");
  L.push("uniform vec3 direction;", "uniform float spread;");
  if (k.textures.includes("scale_over_velocity")) L.push("uniform float scale_over_velocity_min = 0.0;");
  const shape: Record<string, string[]> = {
    point: [],
    sphere: ["uniform float emission_sphere_radius;"],
    sphere_surface: ["uniform float emission_sphere_radius;"],
    box: ["uniform vec3 emission_box_extents;"],
    points: ["uniform sampler2D emission_texture_points : hint_default_black;", "uniform int emission_texture_point_count;"],
    directed_points: ["uniform sampler2D emission_texture_normal : hint_default_black;", "uniform sampler2D emission_texture_points : hint_default_black;"],
    ring: ["uniform vec3 emission_ring_axis;", "uniform float emission_ring_height;"],
  };
  L.push(...shape[k.emission_shape]);
  if (k.emission_color_texture) L.push("uniform sampler2D emission_texture_color : hint_default_white;");
  if (k.sub_emitter !== "disabled" && !lowEnd) {
    L.push(
      {
        constant: "uniform float sub_emitter_frequency;",
        at_end: "uniform int sub_emitter_amount_at_end;",
        at_collision: "uniform int sub_emitter_amount_at_collision;",
        at_start: "uniform int sub_emitter_amount_at_start;",
      }[k.sub_emitter as "constant"],
      "uniform bool sub_emitter_keep_velocity;",
    );
  }
  L.push("uniform vec4 color_value : source_color;");
  if (k.color_ramp) L.push("uniform sampler2D color_ramp : repeat_disable;");
  if (k.color_initial_ramp) L.push("uniform sampler2D color_initial_ramp : repeat_disable;");
  if (k.alpha_curve) L.push("uniform sampler2D alpha_curve : repeat_disable;");
  if (k.emission_curve) L.push("uniform sampler2D emission_curve : repeat_disable;");
  const samplers: Record<string, string> = {
    initial_linear_velocity: "linear_velocity_texture", orbit_velocity: "orbit_velocity_curve",
    angular_velocity: "angular_velocity_texture", linear_accel: "linear_accel_texture",
    radial_accel: "radial_accel_texture", tangential_accel: "tangent_accel_texture",
    damping: "damping_texture", angle: "angle_texture", scale: "scale_curve",
    hue_variation: "hue_rot_curve", anim_speed: "animation_speed_curve",
    anim_offset: "animation_offset_curve", radial_velocity: "radial_velocity_curve",
    scale_over_velocity: "scale_over_velocity_curve", directional_velocity: "directional_velocity_curve",
  };
  for (const p of k.textures) if (samplers[p]) L.push(`uniform sampler2D ${samplers[p]} : repeat_disable;`);
  if (k.velocity_limit_curve) L.push("uniform sampler2D velocity_limit_curve : repeat_disable;");
  if (k.collision === "rigid") L.push("uniform float collision_friction;", "uniform float collision_bounce;");
  if (k.turbulence) {
    L.push("uniform float turbulence_noise_strength;");
    if (k.textures.includes("turb_influence_over_life")) L.push("uniform sampler2D turbulence_influence_over_life;");
  }
  const disableZ = k.particle_flags.includes("disable_z");
  if (k.emission_shape === "sphere")
    L.push("\t\tpos = mix(vec3(0.0, 0.0, 0.0), vec3(radius * cos(t), radius * sin(t), emission_sphere_radius * s), p);");
  if (k.emission_shape === "sphere_surface")
    L.push("\t\tpos = vec3(radius * cos(t), radius * sin(t), emission_sphere_radius * s);");
  if (k.textures.includes("orbit_velocity") && disableZ)
    L.push(`\torbit_amount *= texture(orbit_velocity_curve, vec2(lifetime)).${k.orbit_velocity_curve_xyz ? "b" : "r"};`);
  if (k.attractor) L.push("\t\tforce += ATTRACTOR_FORCE;");
  if (disableZ) L.push("\t\tforce.z = 0.0;");
  if (k.particle_flags.includes("damping_as_friction"))
    L.push("\t\t\t\tfloat damp = v * v * physics_params.damping * 0.05 * DELTA;");
  else L.push("\t\t\tv -= physics_params.damping * DELTA;");
  if (k.collision === "hide_on_contact") L.push("\tif (COLLIDED) {", "\t\tACTIVE = false;", "\t}");
  if (k.particle_flags.includes("align_y_to_velocity")) L.push("\t\tTRANSFORM[1].xyz = normalize(final_velocity);");
  if (!disableZ && k.particle_flags.includes("rotate_y")) L.push("\tvec4 origin = TRANSFORM[3];");
  if (disableZ) L.push("\tTRANSFORM[3].z = 0.0;");
  return `${L.join("\n")}\n`;
}

// ------------------------------------------------------------------------------- trace helpers

function tx(seq: number, frame: number, over: Partial<PtTx> = {}): PtTx {
  return {
    seq,
    frame,
    full: true,
    base_seq: null,
    pt_floats: 0,
    has_keys: false,
    table: new Map(),
    emits: [],
    shaders: new Map(),
    materials: new Map(),
    textures: new Map(),
    items: new Map(),
    item_unsupported: {},
    ...over,
  };
}
function traceOf(version: number, txs: PtTx[]): PtTrace {
  return { version, txs, errors: [] };
}

// ------------------------------------------------------------------------------------- tests

async function main(): Promise<void> {
  const expected = JSON.parse(await readFile(EXPECTED_PATH, "utf8")) as G8ptExpected;
  const mmExpected = JSON.parse(await readFile(MM_EXPECTED_PATH, "utf8")) as G8mmExpected;
  const LAST = QUIT;

  // 1. parsePtLine
  {
    const a = parsePtLine({ kind: "particles", call: "particles_set_amount", frame: 3, rid: 7, id: 2, accepted: true, amount: 5 });
    expect(a?.kind === "call" && a.call === "set_amount" && a.rid === "7" && a.args.amount === 5, "parsePtLine: a call line", a);
    const f = parsePtLine({ kind: "particles", call: "free", frame: 9, rid: "7", id: 2 });
    expect(f?.kind === "call" && f.call === "free" && f.accepted, "parsePtLine: free, accepted by default", f);
    expect(parsePtLine({ kind: "multimesh", call: "state", frame: 1 }) === null, "parsePtLine: a multimesh line is not a particles line");
    const s = parsePtLine({ kind: "particles", call: "state", frame: 4, rid: "7", id: 2, status: "ok", version: 3, seed: 9, floats: [1, 2] });
    expect(s?.kind === "state" && s.fields.version === 3 && s.fields.seed === 9 && s.floats?.length === 2, "parsePtLine: a state line", s);
    const log = parsePtLog(
      [
        '{"frame":1,"kind":"particles","call":"particles_create","rid":"55","id":8,"accepted":true}',
        '{"frame":40,"kind":"particles","call":"state","rid":null,"id":8,"status":"freed","version":5,"floats":null}',
        '{"frame":2,"kind":"mesh","op":"mesh_create"}',
        "not json",
      ].join("\n"),
    );
    expect(log.length === 2 && log[1].rid === "55" && log[1].kind === "state" && log[1].floats === null, "parsePtLog: a freed state line gets its rid by id", log);
  }

  // 2. honest legs
  const honest = simulate(expected);
  {
    const map = mapPtCells(honest.lines, expected);
    expect(map.problems.length === 0 && map.ridOfCell.size === Object.keys(expected.cells).length, "mapPtCells: every cell by its amount", map.problems);
    const census = ptCensusProblems(honest.lines, expected, LAST);
    expect(census.length === 0, "honest: pt-hook-census passes", census);
    for (const [sink, t] of [["full", honest.full], ["patch", honest.patch]] as const) {
      expect(t.errors.length === 0, `honest ${sink}: trace without errors`, t.errors);
      const w = ptWireProblems(t, honest.lines);
      expect(w.length === 0, `honest ${sink}: pt-wire table half passes`, w);
      const e = ptEmitProblems(t, honest.lines);
      expect(e.length === 0, `honest ${sink}: pt-wire emit half passes`, e);
      const n = ptNamedProblems(t, honest.lines, expected);
      expect(n.length === 0, `honest ${sink}: pt-wire naming half passes`, n);
    }
    const listed = honest.patch.txs.reduce((x, t) => x + t.emits.length, 0);
    expect(listed === 4, "honest patch: four emits listed over the run", listed);
    const fb = ptBytes(honest.full);
    const pb = ptBytes(honest.patch);
    expect(fb.transactions === QUIT && fb.max_bytes_per_transaction > 0, "ptBytes: full sink measured", fb);
    expect(pb.mean_bytes_per_patch !== null && pb.mean_bytes_per_patch < fb.mean_bytes_per_transaction, "ptBytes: patches carry fewer floats than fulls", [fb, pb]);
  }

  // 3. census failures
  {
    const noRestart = simulate(expected, { dropRestartLine: true });
    expect(ptCensusProblems(noRestart.lines, expected, LAST).some((p) => p.startsWith("D_ONESHOT")), "census: a missing restart fails");
    const skip = simulate(expected, { skipTransformFrame: 50 });
    expect(ptCensusProblems(skip.lines, expected, LAST).some((p) => p.includes("set_emission_transform missing")), "census: a missing per-frame emission transform fails");
    const stray = simulate(expected, { stray: true });
    expect(ptCensusProblems(stray.lines, expected, LAST).some((p) => p.includes("no cell")), "census: a stray emitter fails");
    const bad = honest.lines.map((l) => (l.kind === "state" && l.id === 1 ? { ...l, fields: { ...l.fields, seed: 5 } } : l));
    expect(ptCensusProblems(bad, expected, LAST).some((p) => p.includes("last state seed")), "census: a wrong last-state seed fails");
  }

  // 4. pt-wire catches
  {
    const ps = simulate(expected, { sabotage: "perturb-seed" });
    const w = ptWireProblems(ps.patch, ps.lines);
    expect(w.some((p) => p.includes("seed")), "pt-wire: perturb-seed fails on the patch sink", w.slice(0, 2));
    const dr = simulate(expected, { sabotage: "drop-restart" });
    const dw = ptWireProblems(dr.patch, dr.lines);
    expect(dw.some((p) => p.includes("restarts")), "pt-wire: drop-restart fails on the patch sink (the call lines' counter)", dw.slice(0, 2));
    const de = simulate(expected, { dropEmit: true });
    expect(ptEmitProblems(de.patch, de.lines).length > 0, "pt-wire: a dropped emit fails");
    const pf = simulate(expected, { perturbFloat: true });
    expect(ptWireProblems(pf.full, pf.lines).some((p) => p.includes("float 1")), "pt-wire: a perturbed float fails (full sink)");
    const hi = simulate(expected, { hideI: true });
    expect(ptNamedProblems(hi.full, hi.lines, expected).some((p) => p.startsWith("I_TRAILS")), "pt-wire: a missing emitter fails");
  }

  // 5. deriveMaterialKey
  {
    for (const [name, cell] of Object.entries(expected.cells)) {
      const k = cellKey(expected, cell);
      const low = deriveMaterialKey(codeFor(k, true));
      expect(builtinDiffs(k, low).length === 0, `deriveMaterialKey: ${name} round-trips (low end)`, [builtinDiffs(k, low), low]);
      expect(low.underivable.includes("sub_emitter"), `deriveMaterialKey: ${name}: sub_emitter underivable on a low-end host`);
      const hi = deriveMaterialKey(codeFor(k, false));
      // a disabled sub-emitter writes no line on any host, so it reads as "disabled or low-end"
      const shown = k.sub_emitter !== "disabled";
      expect(builtinDiffs(k, hi).length === 0 && hi.underivable.includes("sub_emitter") !== shown, `deriveMaterialKey: ${name} round-trips (not low end)`, [builtinDiffs(k, hi), hi.underivable]);
    }
    const variety: BuiltinParticleProcessMaterial = {
      ...expected.key_defaults,
      emission_shape: "sphere_surface",
      particle_flags: ["align_y_to_velocity", "damping_as_friction"],
      textures: ["orbit_velocity", "damping", "scale_over_velocity"],
      color_initial_ramp: true,
      alpha_curve: true,
      emission_curve: true,
      velocity_limit_curve: true,
      sub_emitter: "constant",
      attractor: false,
      collision: "hide_on_contact",
      collision_scale: true,
    } as BuiltinParticleProcessMaterial;
    const dv = deriveMaterialKey(codeFor(variety, false));
    expect(builtinDiffs(variety, dv).length === 0, "deriveMaterialKey: a varied 3D key round-trips", builtinDiffs(variety, dv));
    const rigid = { ...variety, emission_shape: "directed_points", emission_color_texture: true, collision: "rigid", particle_flags: ["rotate_y"] } as BuiltinParticleProcessMaterial;
    expect(builtinDiffs(rigid, deriveMaterialKey(codeFor(rigid, false))).length === 0, "deriveMaterialKey: directed points, rigid collision, rotate_y");
    const wrong = { ...cellKey(expected, expected.cells.A_BOX), emission_shape: "ring" } as BuiltinParticleProcessMaterial;
    const box = deriveMaterialKey(codeFor(cellKey(expected, expected.cells.A_BOX), true));
    expect(builtinDiffs(wrong, box).some((d) => d.startsWith("emission_shape")), "builtinDiffs: a wrong shape fails");
    // golden-12's shader-ppm payload against its decoded builtin
    const payload = decodeShaderPayload(new Uint8Array(await readFile(resolve(GOLDEN_12, "payloads", "shader-ppm.grp"))));
    const decoded = JSON.parse(await readFile(resolve(GOLDEN_12, "patch.decoded.json"), "utf8")) as unknown;
    const builtins: BuiltinParticleProcessMaterial[] = [];
    const walk = (o: unknown) => {
      if (Array.isArray(o)) o.forEach(walk);
      else if (o && typeof o === "object") {
        const r = o as Record<string, unknown>;
        if (r.kind === "particle_process_material") builtins.push(r as unknown as BuiltinParticleProcessMaterial);
        else Object.values(r).forEach(walk);
      }
    };
    walk(decoded);
    expect(builtins.length > 0, "golden-12: a decoded particle_process_material builtin");
    if (builtins.length > 0) {
      const d = builtinDiffs(builtins[0], deriveMaterialKey(payload.code));
      expect(d.length === 0, "golden-12: shader-ppm's code derives its builtin", d);
    }
  }

  // 6. the trace-level helpers on hand-built traces
  {
    const map = mapPtCells(honest.lines, expected);
    const shaders = new Map<number, ResolvedShader>();
    const materials = new Map<number, ResolvedMaterial>();
    const table = new Map<number, ResolvedParticles>();
    const codes = new Map<string, string>();
    for (const [name, cell] of Object.entries(expected.cells)) {
      const id = map.idOfCell.get(name) as number;
      const k = cellKey(expected, cell);
      const hash = `h${id}`;
      codes.set(hash, codeFor(k, true));
      shaders.set(id, { id, origin: "created", status: "ok", reason: null, version: 1, mode: "particles", source: "payload", hash, payload_bytes: 1, builtin: k, uses: ["time"], default_textures: [] } as unknown as ResolvedShader);
      materials.set(200 + id, { id: 200 + id, origin: "created", status: "ok", reason: null, version: 1, shader: id, params: [] });
      table.set(id, { id, process_material: 200 + id, status: "ok" } as unknown as ResolvedParticles);
    }
    const t = traceOf(12, [tx(1, 90, { shaders, materials, table })]);
    const ok = ptBuiltinProblems(t, honest.lines, expected, (h) => codes.get(h) ?? null);
    expect(ok.problems.length === 0 && ok.shaders === Object.keys(expected.cells).length, "ptBuiltinProblems: honest builtins pass", ok.problems);
    const aId = map.idOfCell.get("A_BOX") as number;
    const sh2 = new Map(shaders);
    sh2.set(aId, { ...(shaders.get(aId) as ResolvedShader), builtin: { ...(shaders.get(aId)?.builtin as BuiltinParticleProcessMaterial), emission_shape: "sphere" } });
    const bad = ptBuiltinProblems(traceOf(12, [tx(1, 90, { shaders: sh2, materials, table })]), honest.lines, expected, (h) => codes.get(h) ?? null);
    expect(bad.problems.some((p) => p.includes("emission_shape")), "ptBuiltinProblems: a wrong builtin fails (code and expected key)", bad.problems);
    const sh3 = new Map(shaders);
    sh3.set(aId, { ...(shaders.get(aId) as ResolvedShader), status: "unsupported", reason: "shader-mode", builtin: null } as unknown as ResolvedShader);
    expect(ptBuiltinProblems(traceOf(12, [tx(1, 90, { shaders: sh3, materials, table })]), honest.lines, expected, (h) => codes.get(h) ?? null).problems.length > 0, "ptBuiltinProblems: an unkeyed particles shader fails");

    // pt-v11
    const v11ok = traceOf(11, [
      tx(1, 1, {
        items: new Map([[1, { content_version: 1, add_particles: 0, unsupported: { "unsupported-op": 2 } }]]),
        shaders: new Map([[1, { id: 1, mode: "particles", status: "unsupported", reason: "shader-mode", builtin: null } as unknown as ResolvedShader]]),
      }),
    ]);
    expect(ptV11Problems(v11ok, []).length === 0, "ptV11Problems: an honest /11 trace passes", ptV11Problems(v11ok, []));
    expect(ptV11Problems(traceOf(11, [tx(1, 1, { has_keys: true })]), []).length > 0, "ptV11Problems: a particles key fails");
    expect(ptV11Problems(v11ok, honest.lines.slice(0, 1)).length > 0, "ptV11Problems: a particles hook line fails");
    const v11bad = traceOf(11, [tx(1, 1, { items: new Map([[1, { content_version: 1, add_particles: 0, unsupported: { "unknown-particles": 1 } }]]) })]);
    expect(ptV11Problems(v11bad, []).some((p) => p.includes("unknown-particles")), "ptV11Problems: a non-op reason fails");

    // pt-curve-textures
    const tex = (id: number, status: string, format: string | null, reason: string | null) =>
      ({ id, width: 64, height: 1, status, format, reason }) as unknown as ResolvedTexture;
    const curveMats = new Map<number, ResolvedMaterial>([
      [9, { id: 9, origin: "created", status: "ok", reason: null, version: 1, shader: 3, params: [{ name: "scale_curve", type: "sampler2D" as never, value: { tex: 1 } }, { name: "color_ramp", type: "sampler2D" as never, value: { tex: 2 } }] }],
    ]);
    const curveShaders = new Map([[3, { id: 3, mode: "particles" } as unknown as ResolvedShader]]);
    const t12 = traceOf(12, [tx(1, 1, { textures: new Map([[1, tex(1, "ok", "RGBF", null)], [2, tex(2, "ok", "RGBAF", null)]]), materials: curveMats, shaders: curveShaders })]);
    expect(ptCurveProblems(t12, expected, 2).problems.length === 0, "ptCurveProblems: /12 float textures pass", ptCurveProblems(t12, expected, 2));
    const t12bad = traceOf(12, [tx(1, 1, { textures: new Map([[1, tex(1, "unsupported", null, "unsupported-format")], [2, tex(2, "ok", "RGBA8", null)]]), materials: curveMats, shaders: curveShaders })]);
    expect(ptCurveProblems(t12bad, expected, 2).problems.length === 2, "ptCurveProblems: an unsupported or non-float /12 texture fails", ptCurveProblems(t12bad, expected, 2));
    const t11 = traceOf(11, [tx(1, 1, { textures: new Map([[1, tex(1, "unsupported", null, "unsupported-format")]]) })]);
    expect(ptCurveProblems(t11, expected, 2).problems.length === 0, "ptCurveProblems: /11 unsupported-format passes");
    const t11bad = traceOf(11, [tx(1, 1, { textures: new Map([[1, tex(1, "ok", "RGBF", null)]]) })]);
    expect(ptCurveProblems(t11bad, expected, 2).problems.length > 0, "ptCurveProblems: an ok /11 curve fails");

    // pt-shim
    const noShim = traceOf(12, [tx(1, 1, { items: new Map([[1, { content_version: 1, add_particles: 0, unsupported: { "unknown-particles": 10 } }]]) })]);
    expect(ptNoShimProblems(noShim).length === 0, "ptNoShimProblems: every add_particles unknown passes");
    expect(ptNoShimProblems(traceOf(12, [tx(1, 1, { table: new Map([[1, {} as ResolvedParticles]]) })])).length > 0, "ptNoShimProblems: an entry without the shim fails");
    expect(ptShimDistinctProblems(honest.lines, expected).length === 0, "ptShimDistinctProblems: distinct rids pass", ptShimDistinctProblems(honest.lines, expected));
    const nullRids = honest.lines.map((l) => (l.kind === "call" && l.call === "create" ? { ...l, rid: "0" } : l));
    expect(ptShimDistinctProblems(nullRids, expected).length > 0, "ptShimDistinctProblems: shared null rids fail");

    // pt-receiver
    const items1 = new Map([[1, { content_version: 1, add_particles: 2, unsupported: {} }], [2, { content_version: 1, add_particles: 1, unsupported: {} }]]);
    const items2 = new Map([[1, { content_version: 2, add_particles: 2, unsupported: {} }], [2, { content_version: 1, add_particles: 1, unsupported: {} }]]);
    const rt = traceOf(12, [tx(1, 1, { items: items1 }), tx(2, 2, { items: items1 }), tx(3, 3, { items: items2 })]);
    expect(replayedParticleCommands(rt) === 5, "replayedParticleCommands: new items, then the item whose content moved", replayedParticleCommands(rt));
    expect(receiverUndrawn({ w12: { particles: { particles_commands_undrawn: 5 } } }, "").count === 5, "receiverUndrawn: applied.json's total");
    const so = "seq 1 item 3: unsupported command canvas_item_add_particles (particles-undrawn) logged, not drawn\n".repeat(3);
    expect(receiverUndrawn({ status: "ok" }, so).count === 3, "receiverUndrawn: stdout's lines");

    // pt-pump's control half
    const mmLine = (call: string, frame: number, rid: string, extra: Record<string, unknown> = {}) =>
      JSON.stringify({ kind: "multimesh", call, frame, rid, id: Number(rid), accepted: true, ...extra });
    const quiet = [mmLine("multimesh_allocate_data", 1, "7", { instances: 7, format: 0 })].join("\n");
    const noisy = [quiet, mmLine("multimesh_set_buffer", 5, "7")].join("\n");
    expect(ptPumpProblems(undefined, quiet, mmExpected, 90).nopump.length === 0, "ptPumpProblems: no set_buffer without the pump passes");
    expect(ptPumpProblems(undefined, noisy, mmExpected, 90).nopump.some((p) => p.startsWith("C_FLIP")), "ptPumpProblems: a set_buffer without the pump fails");
    expect(ptPumpProblems(undefined, quiet, mmExpected, 90).pump.length > 0, "ptPumpProblems: no pump hook log fails");
  }

  console.log(`self-test-gate8-pt: ${assertions - failures}/${assertions} assertions passed`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
