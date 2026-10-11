#!/usr/bin/env -S pnpm exec tsx --conditions=development
// Self-test for gate 5.5d: the g55d evaluators of lib/gate55d-checks.ts on the committed
// fixtures/gate55-cim/expected.json and on a hook log, render-stream/5 wire (full and patch sinks),
// applied.json and state dumps synthesized from its CimSim calls (`rs_material_calls`), each with
// a passing and a failing case.
//
//   mise exec -- pnpm exec tsx --conditions=development \
//     experiments/render-stream/scripts/test/self-test-gate55d.ts
//
// 1. g55dLegName and stepWindow.
// 2. replayMaterialLog / materialLogDivergence (`material-commands`, D15) including D5's silent
//    bump when the CIM flush frees a shader its material still names; then a version off, a hash
//    off, a parameter type off and an entry the log lacks. classifyMaterialLeg's precedence.
// 3. evaluateBuiltinModes and evaluateCanvasModulate on both sinks of both scenes; then UP's sub
//    shader recognized as add, RI still naming its freed material, UC not inheriting, the modulate
//    left white.
// 4. evaluateWireMaterialCensus; then the recreation landing a frame late, a removal missing from
//    removed_materials, a removed shader still on the full sink.
// 5. evaluateFreshWithoutRedraw; then UC redrawn on the patch sink, its content_version moving, the
//    receiver's UP not changing at step 6.
// 6. evaluateResourceQuiet; then a param set in step 7's window, a material entry in step 9's
//    patch window, a receiver without the /5 counters, a shader created twice.
// 7. evaluateReceiverTypedClean, evaluateStateDumps, the sabotage predictions through
//    evaluateLegClass5, materialsPerStep's GRP1 bytes, and evaluateShaderStore on a temporary store.
//
// Exits non-zero if any assertion fails.

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { Checkpoint, Classification } from "../lib/gate0-checks";
import { evaluateLegClass5 } from "../lib/gate5d-checks";
import type { Wire5, Wire5Tx } from "../lib/gate55-wire";
import type { Gate55Expected, Gate55Variant } from "../lib/gate55b-expected";
import {
  type AppliedJson55d,
  classifyMaterialLeg,
  evaluateBuiltinModes,
  evaluateCanvasModulate,
  evaluateFreshWithoutRedraw,
  evaluateReceiverTypedClean,
  evaluateResourceQuiet,
  evaluateShaderStore,
  evaluateStateDumps,
  evaluateWireMaterialCensus,
  g55dIds,
  g55dLegName,
  MATERIAL_COUNTERS,
  type MaterialLogLine5,
  materialLogDivergence,
  materialsPerStep,
  paramTypeMatches,
  replayMaterialLog,
  stepWindow,
} from "../lib/gate55d-checks";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const EXPERIMENT_DIR = resolve(SCRIPT_DIR, "../..");

let assertions = 0;
let failures = 0;
function assert(name: string, ok: boolean, detail = ""): void {
  assertions++;
  if (ok) console.log(`[SELF-TEST OK] ${name}`);
  else {
    failures++;
    console.error(`[SELF-TEST FAIL] ${name}${detail ? ` -- ${detail}` : ""}`);
  }
}
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const passes = (name: string, problems: string[]) =>
  assert(
    `${name} passes`,
    problems.length === 0,
    problems.slice(0, 3).join(" | "),
  );
const fails = (name: string, problems: string[], needle?: string) =>
  assert(
    `${name} fails`,
    problems.length > 0 &&
      (!needle || problems.some((p) => p.includes(needle))),
    problems.length === 0
      ? "no problem reported"
      : `no problem mentions ${JSON.stringify(needle)}: ${problems.slice(0, 3).join(" | ")}`,
  );

const expected = JSON.parse(
  await readFile(
    join(EXPERIMENT_DIR, "fixtures", "gate55-cim", "expected.json"),
    "utf8",
  ),
) as Gate55Expected;
const QUIT = 102;
const PAYLOAD_BYTES = 500;

// ---------------------------------------------------------------------------------------------
// A synthetic capture: CimSim's calls through a model with the mirror's rules (D5), emitted as
// hook-log lines (the log applies D5 silently in its registry) and as /5 full and patch sinks.
// ---------------------------------------------------------------------------------------------

interface ModelShader {
  version: number;
  builtin: { blend_mode: string; light_mode: string } | null;
}
interface ModelMaterial {
  version: number;
  shader: number | null;
  params: Map<string, { type: string; value: number }>;
}
interface Synth {
  lines: MaterialLogLine5[];
  full: Wire5Tx[];
  patch: Wire5Tx[];
  applied: AppliedJson55d;
}

const hashOf = (b: { blend_mode: string; light_mode: string }) =>
  createHash("sha256").update(`${b.blend_mode}/${b.light_mode}`).digest("hex");

function synth(variant: Gate55Variant): Synth {
  const v = expected.variants[variant];
  const lines: MaterialLogLine5[] = [];
  const shaders = new Map<number, ModelShader>();
  const materials = new Map<number, ModelMaterial>();
  const items = new Map(
    v.creation_order.map((n) => [
      n,
      { material: null as number | null, up: false },
    ]),
  );
  const idOf = (n: string) => 2 + v.creation_order.indexOf(n);
  let modulate = [1, 1, 1, 1];
  const callsAt = new Map(v.steps.map((s) => [s.applied_frame, s]));
  const full: Wire5Tx[] = [];
  const patch: Wire5Tx[] = [];
  const appliedTx: NonNullable<AppliedJson55d["transactions"]> = [];
  let prev: Wire5Tx["state"] | null = null;
  let markerVersion = 2;
  for (let frame = 1; frame <= QUIT; frame++) {
    const step = callsAt.get(frame);
    const counters = Object.fromEntries(MATERIAL_COUNTERS.map((c) => [c, 0]));
    if (step) {
      if (step.step > 0) markerVersion++;
      for (const c of step.rs_material_calls) {
        const line = (extra: Partial<MaterialLogLine5>): void => {
          lines.push({
            frame,
            op: c.call,
            outcome: "applied",
            status: "ok",
            ...extra,
          });
        };
        switch (c.call) {
          case "material_create": {
            materials.set(c.material as number, {
              version: 1,
              shader: null,
              params: new Map(),
            });
            line({ kind: "material", id: c.material as number, version: 1 });
            counters.materials_created++;
            break;
          }
          case "material_set_param": {
            const m = materials.get(c.material as number) as ModelMaterial;
            const type = typeof c.value === "boolean" ? "bool" : "int";
            m.params.set(c.name as string, { type, value: Number(c.value) });
            m.version++;
            line({
              kind: "material",
              id: c.material as number,
              version: m.version,
              param: c.name as string,
              type,
              n: 1,
              decode_ns: 100,
            });
            counters.param_sets++;
            break;
          }
          case "material_set_shader": {
            const m = materials.get(c.material as number) as ModelMaterial;
            m.shader = (c.shader as number | null) ?? null;
            m.version++;
            line({
              kind: "material",
              id: c.material as number,
              version: m.version,
              target: m.shader === null ? null : `9${m.shader}`,
              ref_id: m.shader,
            });
            break;
          }
          case "shader_create": {
            shaders.set(c.shader as number, { version: 1, builtin: null });
            line({ kind: "shader", id: c.shader as number, version: 1 });
            counters.shaders_created++;
            break;
          }
          case "shader_set_code": {
            const s = shaders.get(c.shader as number) as ModelShader;
            const b = c.builtin as { blend_mode: string; light_mode: string };
            s.version++;
            s.builtin = b;
            line({
              kind: "shader",
              id: c.shader as number,
              version: s.version,
              hash: hashOf(b),
              payload_bytes: PAYLOAD_BYTES,
              mode: "canvas_item",
              source: "payload",
              builtin: {
                kind: "canvas_item_material",
                blend_mode: b.blend_mode,
                light_mode: b.light_mode,
                particles_animation: false,
              },
              uses: [],
              copy_ns: 10,
              hash_ns: 20,
              scan_ns: 30,
            });
            counters.shader_code_sets++;
            break;
          }
          case "free": {
            if (c.kind === "shader") {
              const id = c.shader as number;
              line({
                kind: "shader",
                id,
                version: shaders.get(id)?.version,
                status: "freed",
                outcome: null,
              });
              shaders.delete(id);
              for (const m of materials.values())
                if (m.shader === id) {
                  m.shader = null;
                  m.version++;
                }
            } else {
              const id = c.material as number;
              line({
                kind: "material",
                id,
                version: materials.get(id)?.version,
                status: "freed",
                outcome: null,
              });
              materials.delete(id);
              for (const it of items.values())
                if (it.material === id) it.material = null;
            }
            break;
          }
          case "canvas_item_set_material": {
            (
              items.get(c.item as string) as { material: number | null }
            ).material = (c.material as number | null) ?? null;
            line({
              kind: "item-material",
              ref_id: (c.material as number | null) ?? null,
            });
            break;
          }
          case "canvas_item_set_use_parent_material": {
            (items.get(c.item as string) as { up: boolean }).up =
              c.value as boolean;
            line({ kind: "item-material", value: c.value ? 1 : 0 });
            break;
          }
          case "canvas_set_modulate": {
            modulate = [...(c.color as number[])];
            line({ kind: "item-material" });
            break;
          }
        }
      }
    }
    const state = {
      status: "ok",
      failures: [],
      unsupported: [],
      default_texture_filter: "nearest",
      default_texture_repeat: "disabled",
      canvases: [
        {
          id: 1,
          origin: "created",
          role: "root",
          attached: true,
          items: [],
          xform: [1, 0, 0, 1, 0, 0],
          modulate: modulate.map((x) => Math.fround(x)),
        },
      ],
      items: v.creation_order.map((n) => ({
        id: idOf(n),
        parent:
          n === "UC"
            ? { kind: "item", id: idOf("UP") }
            : { kind: "canvas", id: 1 },
        material: items.get(n)?.material ?? null,
        use_parent_material: items.get(n)?.up ?? false,
        instance_params: [],
        content_version: n === "Marker" ? markerVersion : 2,
        commands: [],
      })),
      textures: [],
      meshes: [],
      shaders: [...shaders]
        .sort(([a], [b]) => a - b)
        .map(([id, s]) => ({
          id,
          origin: "created",
          status: "ok",
          reason: null,
          version: s.version,
          mode: s.builtin ? "canvas_item" : null,
          source: s.builtin ? "payload" : null,
          hash: s.builtin ? hashOf(s.builtin) : null,
          payload_bytes: s.builtin ? PAYLOAD_BYTES : 0,
          builtin: s.builtin
            ? {
                kind: "canvas_item_material",
                ...s.builtin,
                particles_animation: false,
              }
            : null,
          uses: [],
          default_textures: [],
        })),
      materials: [...materials]
        .sort(([a], [b]) => a - b)
        .map(([id, m]) => ({
          id,
          origin: "created",
          status: "ok",
          reason: null,
          version: m.version,
          shader: m.shader,
          params: [...m.params]
            .sort(([a], [b]) => (a < b ? -1 : 1))
            .map(([name, p]) => ({ name, type: p.type, value: p.value })),
        })),
    } as unknown as Wire5Tx["state"];
    const seq = frame;
    full.push({
      seq,
      frame,
      encoding: "full",
      wire: {} as never,
      bytes: 0,
      param_f64: 3 * materials.size,
      state,
    });
    // The patch sink: seq 1 full, then only what changed.
    const changed = <T extends { id: number }>(
      now: readonly T[],
      before: readonly T[] | undefined,
    ) =>
      now.filter(
        (x) =>
          JSON.stringify(x) !==
          JSON.stringify(before?.find((y) => y.id === x.id)),
      );
    const removed = (
      now: readonly { id: number }[],
      before: readonly { id: number }[] | undefined,
    ) =>
      (before ?? [])
        .filter((x) => !now.some((y) => y.id === x.id))
        .map((x) => x.id);
    const isPatch = prev !== null;
    const wire = {
      items: (isPatch ? changed(state.items, prev?.items) : state.items).map(
        (i) => ({
          ...i,
          commands: isPatch ? null : i.commands,
        }),
      ),
      shaders: isPatch
        ? changed(state.shaders ?? [], prev?.shaders)
        : state.shaders,
      materials: isPatch
        ? changed(state.materials ?? [], prev?.materials)
        : state.materials,
      removed_shaders: isPatch
        ? removed(state.shaders ?? [], prev?.shaders)
        : [],
      removed_materials: isPatch
        ? removed(state.materials ?? [], prev?.materials)
        : [],
    };
    const patchParams = (wire.materials ?? []).length * 3;
    patch.push({
      seq,
      frame,
      encoding: isPatch ? "patch" : "full",
      wire: wire as never,
      bytes: 0,
      param_f64: patchParams,
      state,
    });
    prev = state;
    appliedTx.push({
      seq,
      frame,
      rs_calls: 1,
      resources: counters as Record<string, number>,
    });
  }
  return {
    lines,
    full,
    patch,
    applied: {
      status: "ok",
      transactions: appliedTx,
      unsupported: [],
    } as AppliedJson55d,
  };
}

const S = { base: synth("base"), modulate: synth("modulate") };
const sinks = (s: Synth) => [
  { label: "full", transactions: s.full },
  { label: "patch", transactions: s.patch },
];
const at = (txs: Wire5Tx[], frame: number) =>
  txs.find((t) => t.frame === frame) as Wire5Tx;

// ---------------------------------------------------------------------------------------------
// 1. Names and windows
// ---------------------------------------------------------------------------------------------

assert(
  "g55dLegName names legs with the scene",
  g55dLegName("receiver", "base") === "receiver-cim" &&
    g55dLegName("receiver-patch", "modulate") ===
      "receiver-cim-modulate-patch" &&
    g55dLegName("capture-inline", "base") === "capture-cim-inline" &&
    g55dLegName("sabotage-receiver-ignore-canvas-modulate", "modulate") ===
      "sabotage-cim-modulate-receiver-ignore-canvas-modulate",
);
assert(
  "stepWindow: step 0 from frame 1, step 7 is 71-80, step 9 to the quit frame",
  JSON.stringify(stepWindow(expected, "base", 0, QUIT)) === "[1,11]" &&
    JSON.stringify(stepWindow(expected, "base", 7, QUIT)) === "[71,81]" &&
    JSON.stringify(stepWindow(expected, "base", 9, 400)) === "[91,401]",
);

// ---------------------------------------------------------------------------------------------
// 2. The hook log against the wire
// ---------------------------------------------------------------------------------------------

for (const variant of ["base", "modulate"] as const) {
  passes(
    `${variant}: material-commands (full sink)`,
    materialLogDivergence(S[variant].lines, S[variant].full).problems,
  );
  passes(
    `${variant}: material-commands (patch sink, resolved)`,
    materialLogDivergence(S[variant].lines, S[variant].patch).problems,
  );
}
{
  // D5: step 1 frees the disabled shader (6) while material 6 names it; the replay must null and
  // bump it with no line of its own, and the next set_shader line already carries the bump.
  const snaps = replayMaterialLog(S.base.lines);
  const at11 = snaps.find((x) => x.frame === 11)?.state.materials.get(6);
  const wire11 = at(S.base.full, 11).state.materials?.find((m) => m.id === 6);
  assert(
    "replayMaterialLog applies D5 (material 6 at frame 11 equals the wire's version and shader 5)",
    at11 !== undefined &&
      at11.shader === 5 &&
      wire11 !== undefined &&
      at11.version === wire11.version,
    `${at11?.version}/${at11?.shader} vs ${wire11?.version}/${wire11?.shader}`,
  );
  const noD5 = S.base.lines.filter(
    (l) => !(l.op === "free" && l.kind === "shader" && l.frame === 11),
  );
  fails(
    "material-commands when the log never frees the disabled shader",
    materialLogDivergence(noD5, S.base.full).problems,
    "shader 6",
  );
  const version = clone(S.base.full);
  const m3 = at(version, 50).state.materials?.find((m) => m.id === 3);
  if (m3) m3.version += 1;
  fails(
    "material-commands with one material version off",
    materialLogDivergence(S.base.lines, version).problems,
    "material 3",
  );
  const hash = clone(S.base.full);
  const sh = at(hash, 40).state.shaders?.find((x) => x.id === 2);
  if (sh) sh.hash = "0".repeat(64);
  fails(
    "material-commands with a shader hash off",
    materialLogDivergence(S.base.lines, hash).problems,
    "shader 2",
  );
  const type = clone(S.base.full);
  const p = at(type, 30).state.materials?.find((m) => m.id === 1)?.params[0];
  if (p) p.type = "float";
  fails(
    "material-commands with a parameter type off",
    materialLogDivergence(S.base.lines, type).problems,
    "param",
  );
  const extra = clone(S.base.full);
  at(extra, 20).state.materials?.push({
    id: 99,
    origin: "created",
    status: "ok",
    reason: null,
    version: 1,
    shader: null,
    params: [],
  });
  fails(
    "material-commands with a material the log lacks",
    materialLogDivergence(S.base.lines, extra).problems,
    "material 99 is not in the hook log",
  );
  const omitted = [
    ...S.base.lines,
    {
      frame: 30,
      op: "material_set_shader",
      kind: "material",
      id: 9,
      version: 99,
      omitted: true,
      sabotage: true,
    } as MaterialLogLine5,
  ];
  passes(
    "material-commands ignores an omitted line",
    materialLogDivergence(omitted, S.base.full).problems,
  );
  assert(
    "paramTypeMatches: scalar, packed by element type, count",
    paramTypeMatches({ type: "int", n: 1 }, { type: "int", n: 1 }) &&
      paramTypeMatches(
        { type: "float32", n: 4 },
        { type: "packed_float32_array", n: 4 },
      ) &&
      paramTypeMatches(
        { type: "color", n: 2 },
        { type: "packed_color_array", n: 2 },
      ) &&
      !paramTypeMatches(
        { type: "float32", n: 3 },
        { type: "packed_float32_array", n: 4 },
      ) &&
      !paramTypeMatches({ type: "int", n: 1 }, { type: "bool", n: 1 }),
  );
}
{
  const base: Classification = {
    result_class: "success",
    reasons: [],
    mismatching_steps: [],
    harmless_ties: [],
  };
  assert(
    "classifyMaterialLeg: a divergence is capture-failure / material-log-divergence",
    classifyMaterialLeg(base, ["seq 3: material 1"]).result_class ===
      "capture-failure" &&
      classifyMaterialLeg(base, ["x"]).reasons[0].includes(
        "material-log-divergence",
      ),
  );
  const mismatch = { ...base, result_class: "pixel-mismatch" as const };
  const compiled = classifyMaterialLeg(
    mismatch,
    [],
    "ok\nSHADER ERROR: Unknown identifier\n",
  );
  assert(
    "classifyMaterialLeg: a receiver SHADER ERROR outranks pixel-mismatch as replay-failure / shader-compile",
    compiled.result_class === "replay-failure" &&
      compiled.reasons[0].includes("shader-compile"),
  );
  assert(
    "classifyMaterialLeg: unsupported outranks a shader compile error; nothing extra keeps the class",
    classifyMaterialLeg(
      { ...base, result_class: "unsupported" },
      [],
      "SHADER ERROR",
    ).result_class === "unsupported" &&
      classifyMaterialLeg(base, [], "clean").result_class === "success",
  );
}

// ---------------------------------------------------------------------------------------------
// 3. Blend and light modes, canvas modulate
// ---------------------------------------------------------------------------------------------

for (const variant of ["base", "modulate"] as const) {
  const ids = g55dIds(expected, variant, S[variant].full);
  passes(`${variant}: wire ids pair with CimSim's`, ids.problems);
  passes(
    `${variant}: builtin-modes`,
    evaluateBuiltinModes(expected, variant, ids, sinks(S[variant])).problems,
  );
  passes(
    `${variant}: canvas-modulate-wire`,
    evaluateCanvasModulate(expected, variant, sinks(S[variant])).problems,
  );
}
{
  const ids = g55dIds(expected, "base", S.base.full);
  const sub = clone(S.base.full);
  const sh1 = at(sub, 88).state.shaders?.find((x) => x.id === 1);
  if (sh1?.builtin) sh1.builtin.blend_mode = "add";
  fails(
    "builtin-modes when UP's sub shader reads add at step 8",
    evaluateBuiltinModes(expected, "base", ids, [
      { label: "full", transactions: sub },
    ]).problems,
    "step 8: UP",
  );
  const ri = clone(S.base.full);
  const riItem = at(ri, 48).state.items.find(
    (i) => i.id === ids.items.get("RI"),
  );
  if (riItem) riItem.material = 11;
  fails(
    "builtin-modes when RI still names its freed material at step 4",
    evaluateBuiltinModes(expected, "base", ids, [
      { label: "full", transactions: ri },
    ]).problems,
    "step 4: RI",
  );
  const uc = clone(S.base.full);
  const ucItem = at(uc, 68).state.items.find(
    (i) => i.id === ids.items.get("UC"),
  );
  if (ucItem) ucItem.use_parent_material = false;
  fails(
    "builtin-modes when UC does not inherit at step 6",
    evaluateBuiltinModes(expected, "base", ids, [
      { label: "full", transactions: uc },
    ]).problems,
    "step 6: UC",
  );
  const white = clone(S.modulate.full);
  const root = at(white, 8).state.canvases[0];
  root.modulate = [1, 1, 1, 1];
  fails(
    "canvas-modulate-wire when the modulate scene's canvas stays white at step 0",
    evaluateCanvasModulate(expected, "modulate", [
      { label: "full", transactions: white },
    ]).problems,
    "step 0",
  );
}

// ---------------------------------------------------------------------------------------------
// 4. The census on the wire
// ---------------------------------------------------------------------------------------------

for (const variant of ["base", "modulate"] as const) {
  const ids = g55dIds(expected, variant, S[variant].full);
  const r = evaluateWireMaterialCensus(
    expected,
    variant,
    ids,
    S[variant].full,
    S[variant].patch,
  );
  passes(`${variant}: material-census-wire`, r.problems);
  assert(
    `${variant}: material-census-wire names the step 3, 4 and 5 events`,
    r.events.some((x) => x.startsWith("3:shader-new 9@31")) &&
      r.events.some((x) => x.startsWith("4:material-removed 11@41")) &&
      r.events.some((x) => x.startsWith("5:material-new 12@51")),
    r.events.join(" "),
  );
}
{
  const ids = g55dIds(expected, "base", S.base.full);
  // The recreation's entry moved from the frame-51 patch to the frame-52 one.
  const late = clone(S.base.patch);
  const t51 = at(late, 51);
  const m12 = t51.wire.materials?.find((m) => m.id === 12);
  t51.wire.materials = (t51.wire.materials ?? []).filter((m) => m.id !== 12);
  if (m12) at(late, 52).wire.materials = [m12];
  fails(
    "material-census-wire when the recreation first lands a frame late",
    evaluateWireMaterialCensus(expected, "base", ids, S.base.full, late)
      .problems,
    "material 12",
  );
  const kept = clone(S.base.patch);
  at(kept, 41).wire.removed_materials = [];
  fails(
    "material-census-wire when the removal is not in removed_materials",
    evaluateWireMaterialCensus(expected, "base", ids, S.base.full, kept)
      .problems,
    "removed_materials",
  );
  const stale = clone(S.base.full);
  at(stale, 35).state.shaders?.push(
    clone(at(stale, 30).state.shaders?.find((x) => x.id === 4)) as never,
  );
  fails(
    "material-census-wire when the freed unshaded shader stays on the full sink",
    evaluateWireMaterialCensus(expected, "base", ids, stale, S.base.patch)
      .problems,
    "still on the full sink",
  );
}

// ---------------------------------------------------------------------------------------------
// 5. Fresh without redraw
// ---------------------------------------------------------------------------------------------

{
  const fresh = { "6": ["UP", "Marker"] };
  for (const variant of ["base", "modulate"] as const) {
    const ids = g55dIds(expected, variant, S[variant].full);
    passes(
      `${variant}: fresh-without-redraw`,
      evaluateFreshWithoutRedraw(
        expected,
        variant,
        ids,
        S[variant].full,
        S[variant].patch,
        fresh,
      ).problems,
    );
  }
  const ids = g55dIds(expected, "base", S.base.full);
  const redrawn = clone(S.base.patch);
  const ucEntry = at(redrawn, 61).wire.items.find(
    (i) => i.id === ids.items.get("UC"),
  );
  if (ucEntry) ucEntry.commands = [];
  fails(
    "fresh-without-redraw when UC is redrawn at step 6",
    evaluateFreshWithoutRedraw(
      expected,
      "base",
      ids,
      S.base.full,
      redrawn,
      fresh,
    ).problems,
    "a redraw",
  );
  const version = clone(S.base.full);
  const ucItem = at(version, 70).state.items.find(
    (i) => i.id === ids.items.get("UC"),
  );
  if (ucItem) ucItem.content_version = 3;
  fails(
    "fresh-without-redraw when UC's content_version moves",
    evaluateFreshWithoutRedraw(
      expected,
      "base",
      ids,
      version,
      S.base.patch,
      fresh,
    ).problems,
    "UC's content_version",
  );
  fails(
    "fresh-without-redraw when the receiver's UP does not change at 6",
    evaluateFreshWithoutRedraw(
      expected,
      "base",
      ids,
      S.base.full,
      S.base.patch,
      { "6": ["Marker"] },
    ).problems,
    "UP region",
  );
}

// ---------------------------------------------------------------------------------------------
// 6. Resource quiet
// ---------------------------------------------------------------------------------------------

{
  const recv = (s: Synth, applied = s.applied) => [
    { leg: "receiver-cim", applied, transactions: s.full },
    { leg: "receiver-cim-patch", applied, transactions: s.patch },
  ];
  for (const variant of ["base", "modulate"] as const)
    passes(
      `${variant}: resource-quiet`,
      evaluateResourceQuiet(
        expected,
        variant,
        S[variant].patch,
        recv(S[variant]),
        QUIT,
      ).problems,
    );
  const busy = clone(S.base.applied);
  const t75 = busy.transactions?.find((t) => t.frame === 75);
  if (t75?.resources) (t75.resources as Record<string, number>).param_sets = 1;
  fails(
    "resource-quiet with a param set in step 7's window",
    evaluateResourceQuiet(
      expected,
      "base",
      S.base.patch,
      recv(S.base, busy),
      QUIT,
    ).problems,
    "step 7",
  );
  const loud = clone(S.base.patch);
  at(loud, 95).wire.materials = [
    clone(at(loud, 95).state.materials?.[0]) as never,
  ];
  fails(
    "resource-quiet with a material entry in step 9's patch window",
    evaluateResourceQuiet(expected, "base", loud, recv(S.base), QUIT).problems,
    "frame 95",
  );
  const old = clone(S.base.applied);
  for (const t of old.transactions ?? []) t.resources = { created: 0 };
  fails(
    "resource-quiet when the receiver writes no /5 counters",
    evaluateResourceQuiet(
      expected,
      "base",
      S.base.patch,
      recv(S.base, old),
      QUIT,
    ).problems,
    "/5 counters",
  );
  const twice = clone(S.base.applied);
  const t1 = twice.transactions?.[0];
  if (t1?.resources)
    (t1.resources as Record<string, number>).shaders_created += 1;
  fails(
    "resource-quiet when a shader is created twice",
    evaluateResourceQuiet(
      expected,
      "base",
      S.base.patch,
      recv(S.base, twice),
      QUIT,
    ).problems,
    "shaders_created totals",
  );
}

// ---------------------------------------------------------------------------------------------
// 7. Typed-clean, state dumps, sabotage predictions, report, store
// ---------------------------------------------------------------------------------------------

{
  const clean = {
    status: "ok",
    unsupported: [],
    transactions: [],
  } as AppliedJson55d;
  passes(
    "receiver-typed-clean",
    evaluateReceiverTypedClean([
      {
        leg: "receiver-cim",
        honest: true,
        applied: clean,
        stdout: "receiver ready\n",
      },
      {
        leg: "sabotage-cim-receiver-ignore-material",
        honest: false,
        applied: {
          ...clean,
          unsupported: [{ seq: 1, name: "x", reason: "y" }],
        },
        stdout: "",
      },
    ]).problems,
  );
  fails(
    "receiver-typed-clean with a receiver SHADER ERROR",
    evaluateReceiverTypedClean([
      {
        leg: "receiver-cim",
        honest: true,
        applied: clean,
        stdout: "SHADER ERROR: bad\n",
      },
    ]).problems,
    "SHADER ERROR",
  );
  fails(
    "receiver-typed-clean with a typed refusal on an honest receiver",
    evaluateReceiverTypedClean([
      {
        leg: "receiver-cim",
        honest: true,
        applied: {
          ...clean,
          unsupported: [
            {
              seq: 4,
              name: "canvas_item_set_material",
              reason: "unsupported-material",
            },
          ],
        },
        stdout: "",
      },
    ]).problems,
    "unsupported-material",
  );
  fails(
    "receiver-typed-clean with a skipped command",
    evaluateReceiverTypedClean([
      {
        leg: "receiver-cim-patch",
        honest: true,
        applied: {
          ...clean,
          transactions: [{ seq: 2, resources: { skipped_commands: 1 } }],
        },
        stdout: "",
      },
    ]).problems,
    "skipped_commands",
  );
}
{
  const dumps = new Map<number, unknown>();
  for (const s of expected.variants.base.steps) {
    const t = at(S.base.patch, s.settle_frame);
    dumps.set(t.seq, clone(t.state));
  }
  passes(
    "receiver-state-dumps",
    evaluateStateDumps(expected, "base", S.base.patch, dumps).problems,
  );
  const bad = new Map(dumps);
  const t38 = clone(at(S.base.patch, 38).state);
  (t38.materials ?? [])[0].version += 1;
  bad.set(38, t38);
  fails(
    "receiver-state-dumps with a material version off",
    evaluateStateDumps(expected, "base", S.base.patch, bad).problems,
    "materials",
  );
  const missing = new Map(dumps);
  missing.delete(98);
  fails(
    "receiver-state-dumps with a dump missing",
    evaluateStateDumps(expected, "base", S.base.patch, missing).problems,
    "seq-98",
  );
}
// Each sabotage prediction, as checkpoints mismatching exactly there, is pixel-mismatch with
// exactly those regions; one region fewer fails.
for (const key of [
  "sabotage-freeze",
  "sabotage-omit-material-set-shader",
  "sabotage-receiver-ignore-material",
  "sabotage-receiver-ignore-canvas-modulate",
]) {
  const regions = expected.predictions[key]?.regions ?? {};
  const variant = (expected.predictions[key]?.variant ??
    "base") as Gate55Variant;
  const cps: Checkpoint[] = expected.variants[variant].steps.map((s) => {
    const bad = Object.entries(regions)
      .filter(([, steps]) => steps.includes(s.step))
      .map(([r]) => r);
    return {
      step: s.step,
      settle_frame: s.settle_frame,
      seq: s.settle_frame,
      reference_png: "",
      receiver_png: "",
      diff_png: null,
      mismatched_pixels: bad.length * 10,
      max_channel_delta: bad.length > 0 ? 51 : 0,
      regions: Object.keys(expected.regions).map((name) => ({
        name,
        rect_px: expected.regions[name],
        mismatched_pixels: bad.includes(name) ? 10 : 0,
        max_channel_delta: bad.includes(name) ? 51 : 0,
      })),
    };
  });
  const cls = { result_class: "pixel-mismatch" as const, reasons: [] };
  passes(
    `${key}: leg class on its predicted regions`,
    evaluateLegClass5(cls, cps, { class: "pixel-mismatch", regions }).problems,
  );
  const first = Object.keys(regions)[0];
  const fewer = { ...regions, [first]: regions[first].slice(1) };
  fails(
    `${key}: leg class with one region-step fewer predicted`,
    evaluateLegClass5(cls, cps, { class: "pixel-mismatch", regions: fewer })
      .problems,
    "step",
  );
}
{
  const rows = materialsPerStep(
    expected,
    "base",
    S.base.full,
    S.base.patch,
    S.base.lines,
    [{ leg: "receiver-cim", applied: S.base.applied }],
    QUIT,
  );
  assert(
    "materials report: GRP1 bytes per step (8 shaders at 0, 1 at 3, none at 7), counts, receiver calls",
    rows["0"].grp1_payload_bytes === 8 * PAYLOAD_BYTES &&
      rows["3"].grp1_payload_bytes === PAYLOAD_BYTES &&
      rows["7"].grp1_payload_bytes === 0 &&
      rows["0"].shaders === 8 &&
      rows["0"].materials === 11 &&
      rows["5"].materials === 11 &&
      (rows["0"].receivers as Record<string, { material_calls: number }>)[
        "receiver-cim"
      ].material_calls ===
        8 + 8 + 11 + 33,
    JSON.stringify(rows["0"]),
  );
}
{
  // A store with one GRP1 payload, its index line, and an inline recording carrying it.
  const code = "shader_type canvas_item;\n";
  const meta = JSON.stringify({ type: "shader-code", code_bytes: code.length });
  const head = Buffer.alloc(12);
  Buffer.from([0x47, 0x52, 0x50, 0x31, 0x0d, 0x0a, 0x1a, 0x0a]).copy(head);
  head.writeUInt32LE(meta.length, 8);
  const payload = Buffer.concat([head, Buffer.from(meta), Buffer.from(code)]);
  const hash = createHash("sha256").update(payload).digest("hex");
  const dir = await mkdtemp(join(tmpdir(), "self-test-gate55d-"));
  try {
    await mkdir(join(dir, "sha256"));
    await writeFile(join(dir, "sha256", `${hash}.grp`), payload);
    await writeFile(
      join(dir, "index.jsonl"),
      `${JSON.stringify({ hash, bytes: payload.length, type: "shader-code", code_bytes: code.length, first_frame: 1 })}\n`,
    );
    const tx = (seq: number) =>
      ({
        seq,
        frame: seq,
        state: {
          shaders: [
            {
              id: 1,
              status: "ok",
              reason: null,
              source: "payload",
              hash,
              payload_bytes: payload.length,
            },
          ],
        },
      }) as unknown as Wire5Tx;
    const inline: Wire5 = {
      path: "inline",
      present: true,
      error: null,
      transactions: [tx(1), tx(2)],
      resources: [{ hash, bytes: payload.length, before_seq: 1 }],
    };
    passes(
      "shader-store",
      (await evaluateShaderStore(dir, [[tx(1)]], inline, false)).problems,
    );
    fails(
      "shader-store when capture-inline sends the payload after its first transaction",
      (
        await evaluateShaderStore(
          dir,
          [[tx(1)]],
          {
            ...inline,
            resources: [{ hash, bytes: payload.length, before_seq: 2 }],
          },
          false,
        )
      ).problems,
      "capture-inline",
    );
    await writeFile(join(dir, "index.jsonl"), "");
    fails(
      "shader-store with no index line",
      (await evaluateShaderStore(dir, [[tx(1)]], inline, false)).problems,
      "index.jsonl line",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

console.log(
  `\nself-test-gate55d: ${assertions - failures}/${assertions} assertions passed`,
);
if (failures > 0) process.exitCode = 1;
