#!/usr/bin/env -S pnpm exec tsx --conditions=development

// Self-test for LAR0's registry checks (lib/registry-checks.ts): a fabricated deferred leg's
// evidence/registry.json + counters.json on which registry-live-bound passes, then mutations that
// must fail it (an entry kept past its free -- the registry-keep-freed sabotage's shape -- in a row
// and at the end, a create the registry missed, overflow, a dropped row, no pre-arm free, missing
// evidence); and registry-cost on synthetic samples: within noise passes, a registry that costs
// more than the noise fails against both references, a missing config fails. And K1's coverage pin
// for LAR0 and LAR1: every create hook REGISTRY_CREATE_HOOKS names records into the registry
// (capture/src/hooks.cpp: its hook_<name> body records a kind of that family), and
// hook_free / hook_texture_replace erase.
//
//   mise exec -- pnpm exec tsx --conditions=development \
//     experiments/render-stream/scripts/test/self-test-registry-checks.ts

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type CostSample,
  type IdleParitySample,
  idleParity,
  isDeferredLeg,
  judgeResolveQueueOnly,
  parseRegistryChurn,
  REGISTRY_CREATE_HOOKS,
  type RegistryEvidence,
  registryCost,
  registryLiveBound,
  STANDBY_HOOKS,
  shaderClockOrigin,
  standbyHotZero,
  VALIDATION_LOG_COST_BOUND_US,
  validationLogCost,
} from "../lib/registry-checks";

let failures = 0;
let assertions = 0;
function expect(ok: boolean, what: string): void {
  assertions++;
  if (!ok) {
    failures++;
    console.error(`FAIL ${what}`);
  }
}

const families = Object.keys(REGISTRY_CREATE_HOOKS);
const zero = () => families.map(() => 0);
function fam(
  entries: number,
  creates: number,
  frees: number,
  extra: Partial<Record<string, number>> = {},
) {
  return {
    entries,
    peak: Math.max(entries, creates),
    creates,
    frees,
    replaced: 0,
    recreated: 0,
    null_creates: 0,
    overflow: 0,
    bytes_estimate: entries * 40,
    ...extra,
  };
}

// The shape the deferred leg produced (a manual run): 8 textures, 2 meshes, a shader, a
// material created; the loader's churn freed at frame 6, before the arm at 12.
function good(): {
  reg: RegistryEvidence;
  counts: Record<string, number | null>;
} {
  const row = (frame: number, e: number[], c: number[], f: number[]) => ({
    frame,
    entries: e,
    creates: c,
    frees: f,
  });
  const r0 = zero();
  return {
    reg: {
      schema: "render-stream-registry/1",
      configured: true,
      enabled: true,
      fault: "none",
      cap: 1 << 20,
      entries: 2,
      peak: 10,
      bytes_estimate: 200,
      families: {
        texture: fam(2, 8, 6),
        canvas_texture: fam(0, 0, 0, { null_creates: 1 }),
        mesh: fam(0, 2, 2),
        multimesh: fam(0, 0, 0),
        shader: fam(0, 1, 1),
        material: fam(0, 1, 1),
        particles: fam(0, 0, 0),
      },
      timeline: {
        family_order: families,
        cap: 1024,
        dropped: 0,
        rows: [
          row(1, [6, 0, 1, 0, 0, 0, 0], [6, 0, 1, 0, 0, 0, 0], r0),
          row(4, [7, 0, 2, 0, 1, 1, 0], [7, 0, 2, 0, 1, 1, 0], r0),
          row(
            6,
            [6, 0, 1, 0, 0, 0, 0],
            [7, 0, 2, 0, 1, 1, 0],
            [1, 0, 1, 0, 1, 1, 0],
          ),
          row(
            16,
            [7, 0, 1, 0, 0, 0, 0],
            [8, 0, 2, 0, 1, 1, 0],
            [1, 0, 1, 0, 1, 1, 0],
          ),
        ],
      },
    },
    counts: {
      texture_2d_create: 7,
      texture_2d_placeholder_create: 1,
      canvas_texture_create: 1,
      mesh_create: 2,
      mesh_create_from_surfaces: 0,
      shader_create: 1,
      shader_create_from_code: 0,
      material_create: 1,
      material_create_from_shader: 0,
      free: 44,
      texture_replace: 0,
    },
  };
}

{
  const g = good();
  const r = registryLiveBound("deferred", g.reg, g.counts, {
    preArmFreesBefore: 12,
  });
  expect(
    r.problems.length === 0,
    `good evidence passes (${r.problems.join("; ")})`,
  );
  expect(
    r.summary?.pre_arm_frees === 4,
    `pre-arm frees counted (${r.summary?.pre_arm_frees})`,
  );
}
{
  // registry-keep-freed: the frame-6 free left the entry (entries stay 7), and so at the end.
  const g = good();
  g.reg.timeline.rows[2].entries = [7, 0, 2, 0, 1, 1, 0];
  const r = registryLiveBound("keep", g.reg, g.counts);
  expect(
    r.problems.some((p) => p.includes("frame 6 texture")),
    "a kept entry fails its row",
  );
  const g2 = good();
  g2.reg.families.texture.entries = 8;
  g2.reg.entries = 8;
  expect(
    registryLiveBound("keep", g2.reg, g2.counts).problems.some((p) =>
      p.includes("texture ends with 8"),
    ),
    "a kept entry fails the end",
  );
}
{
  const g = good();
  g.counts.mesh_create_from_surfaces = 1; // a create the registry did not record
  expect(
    registryLiveBound("miss", g.reg, g.counts).problems.some((p) =>
      p.includes("mesh recorded 2"),
    ),
    "a missed create fails",
  );
}
{
  const g = good();
  g.reg.families.texture.overflow = 1;
  g.counts.texture_2d_create = 8;
  expect(
    registryLiveBound("ovf", g.reg, g.counts).problems.some((p) =>
      p.includes("overflowed"),
    ),
    "overflow fails",
  );
}
{
  const g = good();
  g.reg.timeline.dropped = 3;
  expect(
    registryLiveBound("drop", g.reg, g.counts).problems.some((p) =>
      p.includes("dropped"),
    ),
    "dropped rows fail",
  );
}
{
  const g = good();
  g.reg.timeline.rows = g.reg.timeline.rows
    .slice(0, 2)
    .concat([g.reg.timeline.rows[3]]);
  g.reg.timeline.rows[2] = { ...g.reg.timeline.rows[2], frame: 16 };
  expect(
    registryLiveBound("nofree", { ...g.reg }, g.counts, {
      preArmFreesBefore: 12,
    }).problems.some((p) => p.includes("before the arm")),
    "no pre-arm free fails a deferred leg",
  );
}
{
  const g = good();
  g.reg.enabled = false;
  expect(
    registryLiveBound("off", g.reg, g.counts).problems.length > 0,
    "a registry not recording fails",
  );
  expect(
    registryLiveBound("none", undefined, g.counts).problems.length === 1,
    "missing registry.json fails",
  );
  expect(
    registryLiveBound("none", g.reg, null).problems.length === 1,
    "missing counters.json fails",
  );
}

// registry-cost
const s = (f: number, c: number, cb: number): CostSample => ({
  frame_us_p50: f,
  churn_us_mean: c,
  callback_us_mean: cb,
});
{
  // LAR7: a registry inside its budget passes however noisy GRC_ADOPT=off is (reported, not judged).
  const r = registryCost(
    {
      off: [s(3000, 380, 900), s(3050, 450, 990), s(2980, 395, 905)],
      on: [s(3010, 440, 925), s(3040, 470, 935), s(2990, 430, 930)],
      regoff: [s(3005, 401, 902), s(3030, 439, 908), s(2995, 399, 903)],
    },
    96,
  );
  expect(
    r.problems.length === 0,
    `within budget passes (${r.problems.join("; ")})`,
  );
  expect(r.comparisons.length === 4, "two metrics against two references");
  expect(
    r.comparisons.filter((c) => c.judged).every((c) => c.against === "regoff"),
    "only regoff is judged",
  );
  const churn = r.comparisons.find(
    (c) => c.judged && c.metric === "churn_us_mean",
  );
  expect(
    churn?.delta === 31 && churn.allowed === 96,
    `paired median and budget (${churn?.delta}, ${churn?.allowed})`,
  );
}
{
  const r = registryCost(
    {
      off: [s(3000, 400, 900), s(3010, 401, 901), s(3005, 402, 902)],
      on: [s(3000, 600, 900), s(3010, 610, 901), s(3005, 605, 902)],
      regoff: [s(3000, 400, 900), s(3010, 401, 901), s(3005, 402, 902)],
    },
    96,
  );
  expect(
    r.problems.length === 1 && r.problems[0].startsWith("churn_us_mean"),
    `a registry over its budget (2 µs a call) fails churn once (${r.problems.join("; ")})`,
  );
}
{
  // Paired by round: a drift shared by on and regoff in a round cancels.
  const r = registryCost(
    {
      off: [s(1, 400, 900), s(1, 520, 1020), s(1, 640, 1140)],
      on: [s(1, 430, 910), s(1, 550, 1030), s(1, 670, 1150)],
      regoff: [s(1, 400, 900), s(1, 520, 1020), s(1, 640, 1140)],
    },
    96,
  );
  const churn = r.comparisons.find(
    (c) => c.judged && c.metric === "churn_us_mean",
  );
  expect(
    r.problems.length === 0 && churn?.delta === 30,
    `round drift cancels (${churn?.delta})`,
  );
}
expect(
  registryCost({ off: [s(1, 1, 1)], on: [s(1, 1, 1)] }, 96).problems.includes(
    "no regoff samples",
  ),
  "missing config fails",
);
expect(
  registryCost(
    { off: [s(1, 1, 1)], on: [s(1, 1, 1)], regoff: [s(1, 1, 1)] },
    Number.NaN,
  ).problems.length === 1,
  "no call count fails",
);
expect(
  registryCost(
    { off: [s(1, 1, 1)], on: [s(1, 1, 1), s(1, 1, 1)], regoff: [s(1, 1, 1)] },
    96,
  ).problems.length === 1,
  "unpaired fails",
);

// LS0: material_set_param judged alone, on - regoff paired by round, at the per-call budget.
{
  const sp = (churn: number, params: number): CostSample => ({
    frame_us_p50: 1,
    churn_us_mean: churn,
    callback_us_mean: 900,
    params_us: params,
  });
  const quiet = [sp(400, 100), sp(410, 105), sp(405, 98)];
  const cheap = registryCost(
    {
      off: quiet,
      on: [sp(420, 120), sp(425, 118), sp(430, 112)],
      regoff: quiet,
    },
    96,
    64,
  );
  const judged = cheap.comparisons.find(
    (c) => c.judged && c.metric === "params_us",
  );
  expect(
    cheap.problems.length === 0 &&
      judged?.delta === 14 &&
      judged.allowed === 64,
    `0.3 µs a param call passes a 1 µs budget (${cheap.problems.join("; ")}; ${judged?.delta}, ${judged?.allowed})`,
  );
  const dear = registryCost(
    {
      off: quiet,
      on: [sp(420, 190), sp(425, 185), sp(430, 180)],
      regoff: quiet,
    },
    96,
    64,
  );
  expect(
    dear.problems.length === 1 &&
      dear.problems[0].startsWith("material_set_param alone"),
    `3 µs a param call fails alone, the churn passing (${dear.problems.join("; ")})`,
  );
  expect(
    registryCost(
      {
        off: quiet,
        on: [s(1, 420, 900), s(1, 420, 900), s(1, 420, 900)],
        regoff: quiet,
      },
      96,
      64,
    ).problems.length === 1,
    "missing params_us fails once param calls are named",
  );
  expect(
    registryCost({ off: quiet, on: quiet, regoff: quiet }, 96).problems
      .length === 0,
    "no param calls named: not judged",
  );
}

// LS0 validation-log-cost
{
  const i = (v: number) => ({ cpu_us_mean: v });
  const base = [750, 760, 745, 755, 748].map(i);
  const near = (d: number) => base.map((x) => i(x.cpu_us_mean + d));
  const ok = validationLogCost({ a0: base, b: near(8), c: near(22) });
  expect(
    ok.problems.length === 0 && ok.comparisons.length === 2,
    `b +8 and c +22 pass (${ok.problems.join("; ")})`,
  );
  const bad = validationLogCost({ a0: base, b: near(8), c: near(22 + 80) });
  expect(
    bad.problems.length === 1 && bad.problems[0].startsWith("c - a0"),
    `K2 back on c fails (${bad.problems.join("; ")})`,
  );
  const sab = validationLogCost({ a0: base, cs: near(100) }, ["cs"]);
  expect(
    sab.problems.length === 1,
    "the sabotage's legs fail the same judgement",
  );
  expect(
    validationLogCost({ a0: base, b: near(VALIDATION_LOG_COST_BOUND_US.b) }, [
      "b",
    ]).problems.length === 0,
    "the bound itself passes",
  );
  expect(
    validationLogCost({ a0: [], b: base }).problems.includes("no a0 samples"),
    "no a0 fails",
  );
  expect(
    validationLogCost({ a0: base, b: near(1), c: near(1).slice(1) }).problems
      .length === 1,
    "unpaired fails",
  );
  // a noisy outlier round does not decide: the median does
  const noisy = base.map((x, k) => i(x.cpu_us_mean + (k === 2 ? 300 : 10)));
  expect(
    validationLogCost({ a0: base, c: noisy }, ["c"]).problems.length === 0,
    "one outlier round is not the median",
  );
}

// clock-origin (LAR7)
{
  const startup = {
    source: "draw-hook",
    origin: "startup",
    first_tick_process_frames: 0,
    first_tick_frames_drawn: 1,
    draws_missed: 0,
  };
  const late = {
    source: "draw-hook",
    origin: "late-load",
    first_tick_process_frames: 12,
    first_tick_frames_drawn: 13,
    draws_missed: 12,
  };
  expect(
    shaderClockOrigin(startup, "startup").problems.length === 0,
    "a startup clock passes startup",
  );
  expect(
    shaderClockOrigin(late, "late-load").problems.length === 0,
    "a late clock passes late-load",
  );
  expect(
    shaderClockOrigin(late, "startup").problems.length > 0,
    "a late clock fails startup",
  );
  expect(
    shaderClockOrigin(startup, "late-load").problems.length > 0,
    "a startup clock fails late-load",
  );
  expect(
    shaderClockOrigin({ ...startup, draws_missed: 3 }, "startup").problems
      .length > 0,
    "missed draws fail startup",
  );
  expect(
    shaderClockOrigin(undefined, "startup").problems.length === 1,
    "an absent clock fails",
  );
}

// K1 coverage pin (source scan of hooks.cpp).
{
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, "../../capture/src/hooks.cpp"), "utf8");
  const body = (name: string): string | null => {
    const m = new RegExp(`\\n(?:RID|void) hook_${name}\\(`).exec(src);
    if (!m) return null;
    const end = src.indexOf("\n}\n", m.index);
    return end < 0 ? null : src.slice(m.index, end);
  };
  const kinds: Record<string, string[]> = {
    texture: ["Texture2d", "TexturePlaceholder"],
    canvas_texture: ["CanvasTexture"],
    mesh: ["Mesh"],
    multimesh: ["Multimesh"],
    shader: ["Shader"],
    material: ["Material"],
    particles: ["Particles"],
  };
  for (const [family, hooks] of Object.entries(REGISTRY_CREATE_HOOKS))
    for (const h of hooks) {
      const b = body(h);
      expect(b !== null, `hooks.cpp has hook_${h}`);
      const m = b
        ? /registry_create\([^,]+, rs::RegistryKind::(\w+)\)/.exec(b)
        : null;
      const kind =
        h === "texture_2d_create"
          ? /rs::registry_note_texture_create\(result\.id,/.test(b ?? "")
            ? "Texture2d"
            : undefined
          : m?.[1];
      expect(
        kind !== undefined && kinds[family].includes(kind),
        `hook_${h} records a ${family} kind (${kind ?? "no registry create"})`,
      );
    }
  expect(
    !/\bregistry_create\(/.test(body("texture_2d_create") ?? ""),
    "hook_texture_2d_create has no plain registry_create (records once)",
  );
  expect(
    /registry_note_free\(rid\.id\)/.test(body("free") ?? ""),
    "hook_free erases",
  );
  expect(
    /registry_note_replace\(texture\.id, by_texture\.id\)/.test(
      body("texture_replace") ?? "",
    ),
    "hook_texture_replace erases the by-texture",
  );
  // LAR1 (K1 for the CanvasTexture payload): every hooked canvas_texture_set_* records into the
  // registry, and the adoption hands the mirror exactly the recorded fields, so the registry's
  // field set equals canvas_texture_adopt's arguments.
  const setters = [
    ...src.matchAll(/\nvoid hook_(canvas_texture_set_\w+)\(/g),
  ].map((m) => m[1]);
  expect(
    setters.length === 3,
    `three hooked canvas_texture setters (${setters.join(", ")})`,
  );
  for (const h of setters)
    expect(
      /rs::registry_note_canvas_(channel|filter|repeat)\(canvas_texture\.id, /.test(
        body(h) ?? "",
      ),
      `hook_${h} records into the registry`,
    );
  const adopt = readFileSync(
    join(here, "../../capture/src/rs_adopt.cpp"),
    "utf8",
  );
  expect(
    /hooks_adopt_canvas_texture\(rid, c\.diffuse, c\.normal, c\.specular, c\.filter, c\.repeat\)/.test(
      adopt,
    ),
    "a registered CanvasTexture is adopted with every recorded field",
  );
  const header = readFileSync(
    join(here, "../../capture/src/rs_registry.h"),
    "utf8",
  );
  const struct =
    /struct RegistryCanvasTexture \{([^}]*)\}/.exec(header)?.[1] ?? "";
  for (const f of ["diffuse", "normal", "specular", "filter", "repeat"])
    expect(
      new RegExp(`\\b${f} = 0;`).test(struct),
      `RegistryCanvasTexture records ${f}`,
    );
  // LAR2 (K1 for the multimesh payload): every hooked multimesh setter that changes the state an
  // adoption carries records into the registry (allocate, mesh, visible, custom AABB, both buffer
  // sets, the four instance setters), and the adoption hands Mirror::MultimeshAdopt every recorded
  // field -- no getter but the buffer's.
  const mmTaps: Record<string, RegExp> = {
    multimesh_allocate_data:
      /rs::registry_note_multimesh_allocate\(multimesh\.id, instances, format, colors, custom, indirect\)/,
    multimesh_set_mesh:
      /rs::registry_note_multimesh_mesh\(multimesh\.id, mesh\.id\)/,
    multimesh_set_visible_instances:
      /rs::registry_note_multimesh_visible\(multimesh\.id, visible\)/,
    multimesh_set_custom_aabb: /rs::registry_note_multimesh_custom_aabb\(/,
    multimesh_set_buffer: /rs::registry_note_multimesh_buffer\(multimesh\.id, /,
    multimesh_set_buffer_interpolated:
      /rs::registry_note_multimesh_buffer\(multimesh\.id, /,
    multimesh_instance_set_transform:
      /rs::registry_note_multimesh_instance_edit\(multimesh\.id\)/,
    multimesh_instance_set_transform_2d:
      /rs::registry_note_multimesh_instance_edit\(multimesh\.id\)/,
    multimesh_instance_set_color:
      /rs::registry_note_multimesh_instance_edit\(multimesh\.id\)/,
    multimesh_instance_set_custom_data:
      /rs::registry_note_multimesh_instance_edit\(multimesh\.id\)/,
  };
  for (const [h, re] of Object.entries(mmTaps))
    expect(re.test(body(h) ?? ""), `hook_${h} records into the registry`);
  const mirrorHeader = readFileSync(
    join(here, "../../capture/src/rs_mirror.h"),
    "utf8",
  );
  const mmStruct =
    /struct MultimeshAdopt \{([^}]*)\}/.exec(mirrorHeader)?.[1] ?? "";
  const regStruct =
    /struct RegistryMultimesh \{([^}]*)\}/.exec(header)?.[1] ?? "";
  for (const f of [
    "instances",
    "format",
    "colors",
    "custom",
    "indirect",
    "visible",
    "mesh",
    "custom_aabb",
  ]) {
    expect(
      new RegExp(`\\b${f}\\b`).test(regStruct),
      `RegistryMultimesh records ${f}`,
    );
    expect(
      new RegExp(`\\b${f}\\b`).test(mmStruct),
      `MultimeshAdopt carries ${f}`,
    );
    expect(
      new RegExp(`adopt\\.${f} = reg\\.${f};`).test(adopt),
      `a registered multimesh is adopted with its recorded ${f}`,
    );
  }
  expect(
    !/kRsMultimeshGet(InstanceCount|VisibleInstances|Mesh|CustomAabb)\b/.test(
      adopt,
    ) && !/multimesh_format_via_node|infer_multimesh_format/.test(adopt),
    "no multimesh getter but the buffer's, no node format read, no honest stride guess (LAR2)",
  );
}

// LAR3 (K1 for the shader/material payload): the shader and material hooks record into the registry
// and note the references an adoption resolves; the adoption takes the recorded code, defaults,
// binding and params from the registry, with no epoch scan of the node map.
{
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, "../../capture/src/hooks.cpp"), "utf8");
  const body = (name: string): string => {
    const m = new RegExp(`\\n(?:RID|void) hook_${name}\\(`).exec(src);
    if (!m) return "";
    const end = src.indexOf("\n}\n", m.index);
    return end < 0 ? "" : src.slice(m.index, end);
  };
  const has = (hook: string, needle: string) =>
    expect(
      body(hook).includes(needle),
      `LAR3: hook_${hook} contains ${needle}`,
    );
  has("shader_create_from_code", "registry_note_shader_code(result.id");
  has("shader_set_code", "registry_note_shader_code(shader.id");
  has(
    "shader_set_default_texture_parameter",
    "registry_note_shader_default_texture(shader.id",
  );
  has("material_create_from_shader", "registry_note_material_shader(result.id");
  has(
    "material_create_from_shader",
    "materialize(shader.id, rs::RefKind::Shader)",
  );
  has("material_set_shader", "registry_note_material_shader(material.id");
  has("material_set_shader", "materialize(shader.id, rs::RefKind::Shader)");
  has("material_set_param", "registry_param(material.id");
  has("set_material", "materialize(material.id, rs::RefKind::Material)");
  const adopt = readFileSync(
    join(here, "../../capture/src/rs_adopt.cpp"),
    "utf8",
  );
  expect(
    adopt.includes("take_pending_material_refs()"),
    "LAR3: the adoption drains take_pending_material_refs()",
  );
  expect(
    adopt.includes("hooks_adopt_shader(rid, code)"),
    "LAR3: a registered shader is adopted with its recorded code",
  );
  expect(
    !adopt.includes("material_refs_epoch") &&
      !/\bpending_material_refs\(\)/.test(adopt),
    "LAR3: no epoch scan of the node map in rs_adopt.cpp",
  );
  const mirrorHeader = readFileSync(
    join(here, "../../capture/src/rs_mirror.h"),
    "utf8",
  );
  expect(
    !mirrorHeader.includes("material_refs_epoch"),
    "LAR3: rs_mirror.h has no material_refs_epoch",
  );
  const header = readFileSync(
    join(here, "../../capture/src/rs_registry.h"),
    "utf8",
  );
  const shaderStruct =
    /struct RegistryShader \{([^}]*)\}/.exec(header)?.[1] ?? "";
  const materialStruct =
    /struct RegistryMaterial \{([^}]*)\}/.exec(header)?.[1] ?? "";
  for (const f of ["code", "defaults"])
    expect(
      new RegExp(`\\b${f}\\b`).test(shaderStruct),
      `LAR3: RegistryShader records ${f}`,
    );
  for (const f of ["shader", "params"])
    expect(
      new RegExp(`\\b${f}\\b`).test(materialStruct),
      `LAR3: RegistryMaterial records ${f}`,
    );
}

// LAR4 (process materials): M16's duplicate trick is removed; a registered process material is adopted
// from the registry, the residual through LATE-PPM's placeholder, builtin keying is queue-driven.
{
  const here = dirname(fileURLToPath(import.meta.url));
  const dir = join(here, "../../capture/src");
  const adopt = readFileSync(join(dir, "rs_adopt.cpp"), "utf8");
  for (const gone of [
    "g_pta.duplicate",
    "hooks_internal_material",
    "ppm_epoch",
    "PpmNoShader",
  ])
    expect(
      !adopt.includes(gone),
      `LAR4: rs_adopt.cpp no longer contains ${gone}`,
    );
  const start = adopt.indexOf(
    "bool adopt_ppm(void *material, std::uint64_t rid) {",
  );
  const adoptPpm =
    start < 0 ? "" : adopt.slice(start, adopt.indexOf("\n}\n", start));
  expect(
    adoptPpm.includes("rs::registry_material("),
    "LAR4: adopt_ppm reads rs::registry_material(",
  );
  const resolveAt = adopt.indexOf("void adopt_particles_resolve() {");
  const resolve =
    resolveAt < 0
      ? ""
      : adopt.slice(resolveAt, adopt.indexOf("\n}\n", resolveAt));
  expect(
    resolve.includes("take_ppm_candidates()"),
    "LAR4: adopt_particles_resolve calls take_ppm_candidates()",
  );
  const registry = readFileSync(join(dir, "rs_registry.cpp"), "utf8");
  const noteAt = registry.indexOf("void registry_note_material_shader(");
  const note =
    noteAt < 0 ? "" : registry.slice(noteAt, registry.indexOf("\n}\n", noteAt));
  expect(
    note.includes("RegistryFault::DropBinding"),
    "LAR4: registry_note_material_shader checks RegistryFault::DropBinding",
  );
  const hooks = readFileSync(join(dir, "hooks.cpp"), "utf8");
  for (const gone of ["t_internal_shader", "t_internal_param_names"])
    expect(!hooks.includes(gone), `LAR4: hooks.cpp no longer contains ${gone}`);
  const mirror = readFileSync(join(dir, "rs_mirror.cpp"), "utf8");
  expect(
    !mirror.includes("ppm_epoch_"),
    "LAR4: rs_mirror.cpp no longer contains ppm_epoch_",
  );
}

// LAR5 (particles): a pre-arm emitter is adopted purely from the registry; the node-getter reads and
// the draw-note side channel are gone, the late arm refuses with a typed reason.
{
  const here = dirname(fileURLToPath(import.meta.url));
  const dir = join(here, "../../capture/src");
  const adopt = readFileSync(join(dir, "rs_adopt.cpp"), "utf8");
  for (const gone of [
    "get_amount",
    "adopt_particles_note_draw",
    "pta_instance_id",
    "refused_no_draw",
  ])
    expect(
      !adopt.includes(gone),
      `LAR5: rs_adopt.cpp no longer contains ${gone}`,
    );
  for (const present of ["registry_particles(", "refused_preload_particles"])
    expect(adopt.includes(present), `LAR5: rs_adopt.cpp contains ${present}`);
  const hooks = readFileSync(join(dir, "hooks.cpp"), "utf8");
  for (const gone of ["t_pt_surface_mesh", "adopt_particles_note_draw"])
    expect(!hooks.includes(gone), `LAR5: hooks.cpp no longer contains ${gone}`);
  // LAR6 merged adopt_process_material_ref into materialize (RefKind::ProcessMaterial).
  for (const present of ["registry_note_particles", "RefKind::ProcessMaterial"])
    expect(hooks.includes(present), `LAR5: hooks.cpp contains ${present}`);
  const header = readFileSync(join(dir, "rs_registry.h"), "utf8");
  for (const present of ["RegistryParticles", "registry-skip-particles"])
    expect(header.includes(present), `LAR5: rs_registry.h contains ${present}`);
}

// LAR6 (one entry, one refused map, the off-main queue, the `updated` bit).
{
  const here = dirname(fileURLToPath(import.meta.url));
  const dir = join(here, "../../capture/src");
  const adopt = readFileSync(join(dir, "rs_adopt.cpp"), "utf8");
  for (const gone of [
    "g_res_refused_textures",
    "g_res_refused_meshes",
    "g_res_refused_multimeshes",
    "g_pta_refused;",
    "std::set<std::uint64_t> g_pta_refused_materials",
    "void adopt_texture_ref(",
    "void adopt_mesh_ref(",
    "void adopt_multimesh_ref(",
    "bool adopt_material_ref(",
    "bool adopt_shader_ref(",
    "void adopt_particles_ref(",
    "bool adopt_process_material_ref(",
  ])
    expect(
      !adopt.includes(gone),
      `LAR6: rs_adopt.cpp no longer contains ${gone}`,
    );
  for (const present of [
    "RidMap<Refusal> g_refused",
    "bool materialize(",
    "drain_offmain",
    "textures_registry",
  ])
    expect(adopt.includes(present), `LAR6: rs_adopt.cpp contains ${present}`);
  const hooks = readFileSync(join(dir, "hooks.cpp"), "utf8");
  expect(
    !/rs::adopt_[a-z_]+_ref\(/.test(hooks),
    "LAR6: hooks.cpp calls no adopt_*_ref (materialize only)",
  );
  expect(
    hooks.includes("registry_note_texture_update"),
    "LAR6: hooks.cpp records the updated bit",
  );
  const entry = readFileSync(join(dir, "entry.cpp"), "utf8");
  expect(
    entry.includes("rs::adopt_frame_drain()") &&
      !entry.includes("rs::adopt_materials_resolve()"),
    "LAR6: entry.cpp's frame callback drains through adopt_frame_drain",
  );
  const q = judgeResolveQueueOnly([
    { leg: "g8a/deferred", resolve_scans: 0 },
    { leg: "g8pt/headless-deferred", resolve_scans: 0 },
  ]);
  expect(
    q.problems !== null && q.problems.length === 0,
    "resolve-queue-only: all zero passes",
  );
  expect(
    (
      judgeResolveQueueOnly([{ leg: "g8m/deferred", resolve_scans: 2 }])
        .problems ?? []
    ).length === 1,
    "resolve-queue-only: a scan fails",
  );
  expect(
    (
      judgeResolveQueueOnly([{ leg: "g8m/deferred", resolve_scans: undefined }])
        .problems ?? []
    ).length === 1,
    "resolve-queue-only: a missing counter fails",
  );
  expect(
    judgeResolveQueueOnly([]).problems === null,
    "resolve-queue-only: nothing ran is not-run",
  );
  for (const [leg, want] of [
    ["deferred", true],
    ["headless-deferred", true],
    ["deferred-cmbt", true],
    ["late", false],
    ["sabotage-registry-off", false],
    ["fault-no-resources", false],
  ] as const)
    expect(isDeferredLeg(leg) === want, `isDeferredLeg(${leg}) is ${want}`);
}

// LS1: registry-live-bound against the fixture's own create count, the
// standby-hot-zero judge, and the TS standby list against rs_standby.cpp's.
{
  const churn = parseRegistryChurn(
    'x\n[fixture] registry-churn {"own_creates":{"texture":1,"mesh":1,"shader":1,"material":1,"canvas_texture":1},"own_frees":5}\n',
  );
  expect(
    churn?.own_creates.canvas_texture === 1 && churn.own_frees === 5,
    "parseRegistryChurn reads the line",
  );
  expect(
    parseRegistryChurn("no line") === null,
    "parseRegistryChurn: no line is null",
  );
  const own = { texture: 1, mesh: 1, shader: 1, material: 1 };
  const g = good();
  expect(
    registryLiveBound("own", g.reg, g.counts, { ownCreates: own }).problems
      .length === 0,
    "own creates at or under the registry's pass",
  );
  // good()'s canvas texture is a null create (the dummy's RID()): it counts as seen.
  expect(
    registryLiveBound("own", g.reg, g.counts, {
      ownCreates: { ...own, canvas_texture: 1 },
    }).problems.length === 0,
    "a null create counts toward the fixture's own creates",
  );
  // The drop-tracked shape: canvas_texture_create absent from the standby table, so neither the hook
  // counter nor the registry saw the fixture's canvas texture; the counters identity still holds.
  const d = good();
  d.reg.families.canvas_texture = fam(0, 0, 0);
  d.counts.canvas_texture_create = 0;
  expect(
    registryLiveBound("drop", d.reg, d.counts).problems.length === 0,
    "drop-tracked: the counters identity alone passes (why the own count is needed)",
  );
  expect(
    registryLiveBound("drop", d.reg, d.counts, {
      ownCreates: { ...own, canvas_texture: 1 },
    }).problems.some((p) => p.includes("below the fixture's own 1")),
    "drop-tracked: the own count fails it",
  );

  const planned = [
    "canvas_item_add_rect",
    "canvas_item_set_transform",
    "texture_2d_create",
    "free",
    "texture_set_path",
  ];
  const result = {
    status: "standby",
    vtable: {
      published: "standby",
      standby_hooks: ["texture_2d_create", "free", "texture_set_path"],
    },
  };
  const counts = {
    canvas_item_add_rect: 0,
    canvas_item_set_transform: 0,
    texture_2d_create: 9,
    free: 4,
    texture_set_path: 0,
  };
  const ok = standbyHotZero(
    "s",
    result,
    { hooks_planned: planned, counts },
    STANDBY_HOOKS,
  );
  expect(
    ok.problems.length === 0 && ok.hot_planned === 2 && ok.standby_calls === 13,
    "standby-hot-zero passes",
  );
  const full = standbyHotZero(
    "s",
    { ...result, vtable: { published: "standby", standby_hooks: planned } },
    {
      hooks_planned: planned,
      counts: { ...counts, canvas_item_add_rect: 120 },
    },
    STANDBY_HOOKS,
  );
  expect(
    full.problems.some((p) => p.includes("canvas_item_add_rect ran 120")),
    "full-table: a hot hook ran",
  );
  expect(
    full.problems.some((p) => p.includes("installs [canvas_item_add_rect")),
    "full-table: the table installs a hot slot",
  );
  expect(
    standbyHotZero(
      "s",
      { ...result, status: "armed" },
      { hooks_planned: planned, counts },
      STANDBY_HOOKS,
    ).problems.length === 1,
    "standby-hot-zero: an armed capture fails",
  );
  expect(
    standbyHotZero("s", result, null, STANDBY_HOOKS).problems.length > 0,
    "standby-hot-zero: no counters fails",
  );

  const here = dirname(fileURLToPath(import.meta.url));
  const cpp = readFileSync(
    join(here, "../../capture/src/rs_standby.cpp"),
    "utf8",
  );
  const body = cpp.slice(
    cpp.indexOf("std::vector<std::string> names = {"),
    cpp.indexOf("};", cpp.indexOf("std::vector<std::string> names = {")),
  );
  const names = [...body.matchAll(/^\s*"([a-z0-9_]+)",/gm)]
    .map((m) => m[1])
    .sort();
  expect(
    names.join(",") === [...STANDBY_HOOKS].sort().join(","),
    `STANDBY_HOOKS equals rs_standby.cpp's list (${names.length} names)`,
  );
}

// idle-parity: paired block costs, whole-frame residual and unchanged RSS bound.
{
  const sample = (cpu: number, params = 1, churn = 1) => ({
    cpu_us_mean: cpu,
    rss_kb: 100_000,
    section_us: { movers: 100, redraws: 200, mesh_updates: 100, params, churn },
  });
  const n = sample(1000);
  const s = sample(1002, 2, 2);
  s.section_us.movers += 40;
  s.section_us.redraws -= 40;
  s.section_us.mesh_updates += 40;
  expect(
    idleParity({ n: [n], s: [s] }).problems.length === 0,
    "idle-parity: hooked blocks under bound pass despite controls at ±40 µs",
  );
  expect(
    idleParity({ n: [n], s: [sample(1000, 8, 8)] }).problems.length > 0,
    "idle-parity: hooked blocks over bound fail even with whole frame flat",
  );
  expect(
    idleParity({ n: [n], s: [sample(1010, 6, 6)] }).problems.length === 0,
    "idle-parity: exactly at tracked bound passes",
  );
  expect(
    idleParity({ n: [n], s: [sample(1080, 2, 2)] }).problems.some((p) =>
      p.includes("cost outside the timed blocks"),
    ),
    "idle-parity: whole frame +80 with tracked +2 fails outside guard",
  );
  expect(
    idleParity({
      n: [n],
      s: [{ cpu_us_mean: 1000, rss_kb: 100_000 }],
    }).problems.some((p) => p.includes("section_us")),
    "idle-parity: missing section_us fails",
  );
  expect(
    idleParity({ n: [n], s: [s, s] }).problems.some((p) =>
      p.includes("unpaired"),
    ),
    "idle-parity: unpaired samples fail",
  );
  const whole = [61.3, 12.6, 42, -8.8, 116.9];
  expect(
    idleParity({
      n: whole.map(() => sample(692.4)),
      s: whole.map((delta) => sample(692.4 + delta, 6, 29.1)),
    }).problems.some((p) => p.includes("tracked +33.1")),
    "idle-parity: LS1-shaped data fails at tracked +33.1 µs",
  );
  for (const config of ["n", "s"]) {
    for (const block of ["params", "churn"] as const) {
      const samples: Record<string, IdleParitySample[]> = {
        n: [sample(1000)],
        s: [sample(1002)],
      };
      delete samples[config][0].section_us?.[block];
      const result = idleParity(samples);
      expect(
        result.tracked === null &&
          result.problems.some((p) => p.includes(`section_us.${block}`)),
        `idle-parity: missing ${config} hooked block ${block} fails, never zero`,
      );
    }
  }
  expect(
    idleParity({ n: [n], s: [{ ...s, section_us: {} }] }).problems.length > 0,
    "idle-parity: empty section_us fails",
  );
  expect(
    idleParity({ n: [n], s: [sample(1002, Number.NaN)] }).problems.length > 0,
    "idle-parity: nonfinite hooked data fails",
  );
  // A sum of paired medians is 4; median of the per-round sums is 22.
  // The changing n values also distinguish paired medians from differences of medians.
  const ns = [sample(1000, 1, 1), sample(1000, 101, 101), sample(1000, 1, 1)];
  const ss = [sample(1004, 1, 21), sample(1004, 103, 103), sample(1004, 21, 1)];
  ss[0].section_us.movers += 40;
  ss[1].section_us.movers -= 40;
  const paired = idleParity({ n: ns, s: ss });
  expect(
    paired.problems.length === 0 &&
      paired.tracked?.us === 4 &&
      paired.blocks.every((b) => b.median === 2),
    "idle-parity: sum each block's paired median, preserving round order",
  );
  const movers = paired.controls.find((b) => b.block === "movers");
  expect(
    paired.controls.length === 3 &&
      movers?.median === 0 &&
      movers.min === -40 &&
      movers.max === 40 &&
      movers.paired.join(",") === "40,-40,0",
    "idle-parity: controls report paired median and min..max",
  );
  expect(
    idleParity({ n: [n], s: [sample(1052, 2, 2)] }).problems.length === 0,
    "idle-parity: exactly at residual bound passes",
  );
  expect(
    idleParity({ n: [n], s: [{ ...s, rss_kb: n.rss_kb + 10 * 1024 }] }).problems
      .length === 0,
    "idle-parity: exactly 10 MB RSS passes",
  );
  expect(
    idleParity({
      n: [n],
      s: [{ ...s, rss_kb: n.rss_kb + 10 * 1024 + 1 }],
    }).problems.some((p) => p.includes("RSS")),
    "idle-parity: RSS over bound fails",
  );
  expect(
    idleParity({ n: [n], s: [{ ...s, rss_kb: undefined }] }).problems.some(
      (p) => p.includes("rss_kb"),
    ),
    "idle-parity: missing RSS fails",
  );
}

if (failures > 0) {
  console.error(
    `self-test-registry-checks: ${failures} of ${assertions} assertion(s) failed`,
  );
  process.exit(1);
}
console.log(
  `self-test-registry-checks: ${assertions}/${assertions} assertions passed`,
);
