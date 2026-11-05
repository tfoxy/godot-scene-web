#!/usr/bin/env -S pnpm exec tsx --conditions=development

// Self-test for LAR0's registry checks (lib/registry-checks.ts): a fabricated deferred leg's
// evidence/registry.json + counters.json on which registry-live-bound passes, then mutations that
// must fail it (an entry kept past its free -- the registry-keep-freed sabotage's shape -- in a row
// and at the end, a create the registry missed, overflow, a dropped row, no pre-arm free, missing
// evidence); and registry-cost on synthetic samples: within noise passes, a registry that costs
// more than the noise fails against both references, a missing config fails. And K1's coverage pin
// for LAR0 and LAR1: every create hook REGISTRY_CREATE_HOOKS names records into the registry
// (capture/src/hooks.cpp: its hook_<name> body calls registry_create with a kind of that family), and
// hook_free / hook_texture_replace erase.
//
//   mise exec -- pnpm exec tsx --conditions=development \
//     experiments/render-stream/scripts/test/self-test-registry-checks.ts

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type CostSample,
  REGISTRY_CREATE_HOOKS,
  type RegistryEvidence,
  registryCost,
  registryLiveBound,
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
function fam(entries: number, creates: number, frees: number, extra: Partial<Record<string, number>> = {}) {
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

// The shape the deferred leg produced (2026-11-04 manual run): 8 textures, 2 meshes, a shader, a
// material created; the loader's churn freed at frame 6, before the arm at 12.
function good(): { reg: RegistryEvidence; counts: Record<string, number | null> } {
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
          row(6, [6, 0, 1, 0, 0, 0, 0], [7, 0, 2, 0, 1, 1, 0], [1, 0, 1, 0, 1, 1, 0]),
          row(16, [7, 0, 1, 0, 0, 0, 0], [8, 0, 2, 0, 1, 1, 0], [1, 0, 1, 0, 1, 1, 0]),
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
  const r = registryLiveBound("deferred", g.reg, g.counts, { preArmFreesBefore: 12 });
  expect(r.problems.length === 0, `good evidence passes (${r.problems.join("; ")})`);
  expect(r.summary?.pre_arm_frees === 4, `pre-arm frees counted (${r.summary?.pre_arm_frees})`);
}
{
  // registry-keep-freed: the frame-6 free left the entry (entries stay 7), and so at the end.
  const g = good();
  g.reg.timeline.rows[2].entries = [7, 0, 2, 0, 1, 1, 0];
  const r = registryLiveBound("keep", g.reg, g.counts);
  expect(r.problems.some((p) => p.includes("frame 6 texture")), "a kept entry fails its row");
  const g2 = good();
  g2.reg.families.texture.entries = 8;
  g2.reg.entries = 8;
  expect(
    registryLiveBound("keep", g2.reg, g2.counts).problems.some((p) => p.includes("texture ends with 8")),
    "a kept entry fails the end",
  );
}
{
  const g = good();
  g.counts.mesh_create_from_surfaces = 1;  // a create the registry did not record
  expect(
    registryLiveBound("miss", g.reg, g.counts).problems.some((p) => p.includes("mesh recorded 2")),
    "a missed create fails",
  );
}
{
  const g = good();
  g.reg.families.texture.overflow = 1;
  g.counts.texture_2d_create = 8;
  expect(registryLiveBound("ovf", g.reg, g.counts).problems.some((p) => p.includes("overflowed")), "overflow fails");
}
{
  const g = good();
  g.reg.timeline.dropped = 3;
  expect(registryLiveBound("drop", g.reg, g.counts).problems.some((p) => p.includes("dropped")), "dropped rows fail");
}
{
  const g = good();
  g.reg.timeline.rows = g.reg.timeline.rows.slice(0, 2).concat([g.reg.timeline.rows[3]]);
  g.reg.timeline.rows[2] = { ...g.reg.timeline.rows[2], frame: 16 };
  expect(
    registryLiveBound("nofree", { ...g.reg }, g.counts, { preArmFreesBefore: 12 }).problems.some((p) =>
      p.includes("before the arm"),
    ),
    "no pre-arm free fails a deferred leg",
  );
}
{
  const g = good();
  g.reg.enabled = false;
  expect(registryLiveBound("off", g.reg, g.counts).problems.length > 0, "a registry not recording fails");
  expect(registryLiveBound("none", undefined, g.counts).problems.length === 1, "missing registry.json fails");
  expect(registryLiveBound("none", g.reg, null).problems.length === 1, "missing counters.json fails");
}

// registry-cost
const s = (f: number, c: number, cb: number): CostSample => ({
  frame_us_p50: f,
  churn_us_mean: c,
  callback_us_mean: cb,
});
{
  const r = registryCost({
    off: [s(3000, 400, 900), s(3050, 410, 910), s(2980, 395, 905)],
    on: [s(3010, 405, 905), s(3040, 412, 915), s(2990, 398, 900)],
    regoff: [s(3005, 401, 902), s(3030, 409, 908), s(2995, 399, 903)],
  });
  expect(r.problems.length === 0, `within noise passes (${r.problems.join("; ")})`);
  expect(r.comparisons.length === 4, "two judged metrics against two references");
}
{
  const r = registryCost({
    off: [s(3000, 400, 900), s(3010, 401, 901), s(3005, 402, 902)],
    on: [s(3000, 600, 900), s(3010, 610, 901), s(3005, 605, 902)],
    regoff: [s(3000, 400, 900), s(3010, 401, 901), s(3005, 402, 902)],
  });
  expect(
    r.problems.filter((p) => p.startsWith("churn_us_mean")).length === 2,
    "a costly registry fails churn against off and regoff",
  );
}
expect(registryCost({ off: [s(1, 1, 1)], on: [s(1, 1, 1)] }).problems.includes("no regoff samples"), "missing config fails");

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
      const m = b ? /registry_create\([^,]+, rs::RegistryKind::(\w+)\)/.exec(b) : null;
      expect(
        m !== null && kinds[family].includes(m[1]),
        `hook_${h} records a ${family} kind (${m?.[1] ?? "no registry_create"})`,
      );
    }
  expect(/registry_note_free\(rid\.id\)/.test(body("free") ?? ""), "hook_free erases");
  expect(
    /registry_note_replace\(texture\.id, by_texture\.id\)/.test(body("texture_replace") ?? ""),
    "hook_texture_replace erases the by-texture",
  );
  // LAR1 (K1 for the CanvasTexture payload): every hooked canvas_texture_set_* records into the
  // registry, and the adoption hands the mirror exactly the recorded fields, so the registry's
  // field set equals canvas_texture_adopt's arguments.
  const setters = [...src.matchAll(/\nvoid hook_(canvas_texture_set_\w+)\(/g)].map((m) => m[1]);
  expect(setters.length === 3, `three hooked canvas_texture setters (${setters.join(", ")})`);
  for (const h of setters)
    expect(
      /rs::registry_note_canvas_(channel|filter|repeat)\(canvas_texture\.id, /.test(body(h) ?? ""),
      `hook_${h} records into the registry`,
    );
  const adopt = readFileSync(join(here, "../../capture/src/rs_adopt.cpp"), "utf8");
  expect(
    /hooks_adopt_canvas_texture\(rid, c\.diffuse, c\.normal, c\.specular, c\.filter, c\.repeat\)/.test(
      adopt,
    ),
    "a registered CanvasTexture is adopted with every recorded field",
  );
  const header = readFileSync(join(here, "../../capture/src/rs_registry.h"), "utf8");
  const struct = /struct RegistryCanvasTexture \{([^}]*)\}/.exec(header)?.[1] ?? "";
  for (const f of ["diffuse", "normal", "specular", "filter", "repeat"])
    expect(new RegExp(`\\b${f} = 0;`).test(struct), `RegistryCanvasTexture records ${f}`);
  // LAR2 (K1 for the multimesh payload): every hooked multimesh setter that changes the state an
  // adoption carries records into the registry (allocate, mesh, visible, custom AABB, both buffer
  // sets, the four instance setters), and the adoption hands Mirror::MultimeshAdopt every recorded
  // field -- no getter but the buffer's.
  const mmTaps: Record<string, RegExp> = {
    multimesh_allocate_data:
      /rs::registry_note_multimesh_allocate\(multimesh\.id, instances, format, colors, custom, indirect\)/,
    multimesh_set_mesh: /rs::registry_note_multimesh_mesh\(multimesh\.id, mesh\.id\)/,
    multimesh_set_visible_instances: /rs::registry_note_multimesh_visible\(multimesh\.id, visible\)/,
    multimesh_set_custom_aabb: /rs::registry_note_multimesh_custom_aabb\(/,
    multimesh_set_buffer: /rs::registry_note_multimesh_buffer\(multimesh\.id, /,
    multimesh_set_buffer_interpolated: /rs::registry_note_multimesh_buffer\(multimesh\.id, /,
    multimesh_instance_set_transform: /rs::registry_note_multimesh_instance_edit\(multimesh\.id\)/,
    multimesh_instance_set_transform_2d: /rs::registry_note_multimesh_instance_edit\(multimesh\.id\)/,
    multimesh_instance_set_color: /rs::registry_note_multimesh_instance_edit\(multimesh\.id\)/,
    multimesh_instance_set_custom_data: /rs::registry_note_multimesh_instance_edit\(multimesh\.id\)/,
  };
  for (const [h, re] of Object.entries(mmTaps))
    expect(re.test(body(h) ?? ""), `hook_${h} records into the registry`);
  const mirrorHeader = readFileSync(join(here, "../../capture/src/rs_mirror.h"), "utf8");
  const mmStruct = /struct MultimeshAdopt \{([^}]*)\}/.exec(mirrorHeader)?.[1] ?? "";
  const regStruct = /struct RegistryMultimesh \{([^}]*)\}/.exec(header)?.[1] ?? "";
  for (const f of ["instances", "format", "colors", "custom", "indirect", "visible", "mesh", "custom_aabb"]) {
    expect(new RegExp(`\\b${f}\\b`).test(regStruct), `RegistryMultimesh records ${f}`);
    expect(new RegExp(`\\b${f}\\b`).test(mmStruct), `MultimeshAdopt carries ${f}`);
    expect(
      new RegExp(`adopt\\.${f} = reg\\.${f};`).test(adopt),
      `a registered multimesh is adopted with its recorded ${f}`,
    );
  }
  expect(
    !/kRsMultimeshGet(InstanceCount|VisibleInstances|Mesh|CustomAabb)\b/.test(adopt) &&
      !/multimesh_format_via_node|infer_multimesh_format/.test(adopt),
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
    expect(body(hook).includes(needle), `LAR3: hook_${hook} contains ${needle}`);
  has("shader_create_from_code", "registry_note_shader_code(result.id");
  has("shader_set_code", "registry_note_shader_code(shader.id");
  has("shader_set_default_texture_parameter", "registry_note_shader_default_texture(shader.id");
  has("material_create_from_shader", "registry_note_material_shader(result.id");
  has("material_create_from_shader", "adopt_shader_ref(shader.id)");
  has("material_set_shader", "registry_note_material_shader(material.id");
  has("material_set_shader", "adopt_shader_ref(shader.id)");
  has("material_set_param", "registry_param(material.id");
  has("set_material", "adopt_material_ref(material.id)");
  const adopt = readFileSync(join(here, "../../capture/src/rs_adopt.cpp"), "utf8");
  expect(adopt.includes("take_pending_material_refs()"), "LAR3: the adoption drains take_pending_material_refs()");
  expect(adopt.includes("hooks_adopt_shader(rid, code)"), "LAR3: a registered shader is adopted with its recorded code");
  expect(
    !adopt.includes("material_refs_epoch") && !/\bpending_material_refs\(\)/.test(adopt),
    "LAR3: no epoch scan of the node map in rs_adopt.cpp",
  );
  const mirrorHeader = readFileSync(join(here, "../../capture/src/rs_mirror.h"), "utf8");
  expect(!mirrorHeader.includes("material_refs_epoch"), "LAR3: rs_mirror.h has no material_refs_epoch");
  const header = readFileSync(join(here, "../../capture/src/rs_registry.h"), "utf8");
  const shaderStruct = /struct RegistryShader \{([^}]*)\}/.exec(header)?.[1] ?? "";
  const materialStruct = /struct RegistryMaterial \{([^}]*)\}/.exec(header)?.[1] ?? "";
  for (const f of ["code", "defaults"])
    expect(new RegExp(`\\b${f}\\b`).test(shaderStruct), `LAR3: RegistryShader records ${f}`);
  for (const f of ["shader", "params"])
    expect(new RegExp(`\\b${f}\\b`).test(materialStruct), `LAR3: RegistryMaterial records ${f}`);
}

// LAR4 (process materials): M16's duplicate trick is removed; a registered process material is adopted
// from the registry, the residual through LATE-PPM's placeholder, builtin keying is queue-driven.
{
  const here = dirname(fileURLToPath(import.meta.url));
  const dir = join(here, "../../capture/src");
  const adopt = readFileSync(join(dir, "rs_adopt.cpp"), "utf8");
  for (const gone of ["g_pta.duplicate", "hooks_internal_material", "ppm_epoch", "PpmNoShader"])
    expect(!adopt.includes(gone), `LAR4: rs_adopt.cpp no longer contains ${gone}`);
  const start = adopt.indexOf("bool adopt_ppm(void *material, std::uint64_t rid) {");
  const adoptPpm = start < 0 ? "" : adopt.slice(start, adopt.indexOf("\n}\n", start));
  expect(adoptPpm.includes("rs::registry_material("), "LAR4: adopt_ppm reads rs::registry_material(");
  const resolveAt = adopt.indexOf("void adopt_particles_resolve() {");
  const resolve = resolveAt < 0 ? "" : adopt.slice(resolveAt, adopt.indexOf("\n}\n", resolveAt));
  expect(resolve.includes("take_ppm_candidates()"), "LAR4: adopt_particles_resolve calls take_ppm_candidates()");
  const registry = readFileSync(join(dir, "rs_registry.cpp"), "utf8");
  const noteAt = registry.indexOf("void registry_note_material_shader(");
  const note = noteAt < 0 ? "" : registry.slice(noteAt, registry.indexOf("\n}\n", noteAt));
  expect(
    note.includes("RegistryFault::DropBinding"),
    "LAR4: registry_note_material_shader checks RegistryFault::DropBinding",
  );
  const hooks = readFileSync(join(dir, "hooks.cpp"), "utf8");
  for (const gone of ["t_internal_shader", "t_internal_param_names"])
    expect(!hooks.includes(gone), `LAR4: hooks.cpp no longer contains ${gone}`);
  const mirror = readFileSync(join(dir, "rs_mirror.cpp"), "utf8");
  expect(!mirror.includes("ppm_epoch_"), "LAR4: rs_mirror.cpp no longer contains ppm_epoch_");
}

// LAR5 (particles): a pre-arm emitter is adopted purely from the registry; the node-getter reads and
// the draw-note side channel are gone, the late arm refuses with a typed reason.
{
  const here = dirname(fileURLToPath(import.meta.url));
  const dir = join(here, "../../capture/src");
  const adopt = readFileSync(join(dir, "rs_adopt.cpp"), "utf8");
  for (const gone of ["get_amount", "adopt_particles_note_draw", "pta_instance_id", "refused_no_draw"])
    expect(!adopt.includes(gone), `LAR5: rs_adopt.cpp no longer contains ${gone}`);
  for (const present of ["registry_particles(", "refused_preload_particles"])
    expect(adopt.includes(present), `LAR5: rs_adopt.cpp contains ${present}`);
  const hooks = readFileSync(join(dir, "hooks.cpp"), "utf8");
  for (const gone of ["t_pt_surface_mesh", "adopt_particles_note_draw"])
    expect(!hooks.includes(gone), `LAR5: hooks.cpp no longer contains ${gone}`);
  for (const present of ["registry_note_particles", "adopt_process_material_ref"])
    expect(hooks.includes(present), `LAR5: hooks.cpp contains ${present}`);
  const header = readFileSync(join(dir, "rs_registry.h"), "utf8");
  for (const present of ["RegistryParticles", "registry-skip-particles"])
    expect(header.includes(present), `LAR5: rs_registry.h contains ${present}`);
}

if (failures > 0) {
  console.error(`self-test-registry-checks: ${failures} of ${assertions} assertion(s) failed`);
  process.exit(1);
}
console.log(`self-test-registry-checks: ${assertions}/${assertions} assertions passed`);
