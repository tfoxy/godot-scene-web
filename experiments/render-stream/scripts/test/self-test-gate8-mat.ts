#!/usr/bin/env -S pnpm exec tsx --conditions=development
// Self-test for gate 8's g8m checks (lib/gate8-mat-checks.ts, G8m) on the committed
// fixtures/gate8-mat/expected.json and on synthetic resolved states, each with a passing and a
// failing case.
//
//   mise exec -- pnpm exec tsx --conditions=development \
//     experiments/render-stream/scripts/test/self-test-gate8-mat.ts
//
// 1. expected.json is self-consistent (every material's item exists and draws with it, the
//    account's shader counts add up, the include-refused rect is the item's box).
// 2. shaderHashParity: the oracle's hash through the item passes; a raw-code hash, a wrong size
//    and a created origin where adopted is expected each fail.
// 3. paramParity: exact parameters pass; a missing, a changed and an undeclared one fail; an
//    instance parameter a script never set must be absent; a texture compares by fixture name.
// 4. cimBuiltin: the mode's builtin and born's hash pass; another hash, a missing builtin and two
//    shader entries for one mode fail.
// 5. includeRefused: the typed shader and its unsupported-material entry pass; a hashed shader
//    fails.
// 6. canonicalState (gate8-adopt-checks, G8m's material content): two states with other material
//    and shader ids but the same content are equal; another parameter value differs.
//
// Exits non-zero if any assertion fails.

import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalState, compareStates } from "../lib/gate8-adopt-checks";
import {
  cimBuiltin,
  type G8mExpected,
  includeRefused,
  type OracleLine,
  paramParity,
  shaderHashParity,
} from "../lib/gate8-mat-checks";
import type { ResolvedTransaction } from "../lib/render-stream-2";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const EXPERIMENT_DIR = resolve(SCRIPT_DIR, "..", "..");

let assertions = 0;
let failures = 0;
function assert(condition: boolean, what: string): void {
  assertions++;
  if (!condition) {
    failures++;
    console.error(`FAIL ${what}`);
  }
}

type State = ResolvedTransaction["state"];
const H = (c: string) => c.repeat(64);

// A two-item scene: X (10,10) on material 1 / shader 1 (a ShaderMaterial on "main", a texture and a
// colour parameter, an instance parameter), Y (60,10) on material 2 / shader 2 (a CanvasItemMaterial
// add template). `ids` offsets every id, as another capture would number them.
function scene(
  ids = 0,
  over: {
    hash?: string;
    tint?: number;
    origin?: string;
    yShader?: number;
  } = {},
): State {
  const item = (
    id: number,
    x: number,
    material: number,
    inst: unknown[] = [],
  ) => ({
    id: id + ids,
    origin: "created",
    parent: { kind: "canvas", id: 1 },
    children: [],
    visible: true,
    draw_index: id,
    z_index: 0,
    z_relative: true,
    behind: false,
    clip: false,
    custom_rect: false,
    visibility_layer: 1,
    texture_filter: "default",
    texture_repeat: "default",
    material: material + ids,
    use_parent_material: false,
    instance_params: inst,
    content_version: 1,
    xform: [1, 0, 0, 1, x, 10],
    modulate: [1, 1, 1, 1],
    self_modulate: [1, 1, 1, 1],
    custom_rect_rect: [0, 0, 0, 0],
    commands: [
      { op: "add_rect", aa: false, rect: [0, 0, 4, 4], color: [1, 1, 1, 1] },
    ],
  });
  const builtin = {
    kind: "canvas_item_material",
    blend_mode: "add",
    light_mode: "normal",
    particles_animation: false,
  };
  return {
    status: "ok",
    failures: [],
    unsupported: [],
    default_texture_filter: "linear",
    default_texture_repeat: "disabled",
    canvases: [
      {
        id: 1,
        origin: "root-query",
        role: "root",
        attached: true,
        layer: 0,
        sublayer: 0,
        items: [1 + ids, 2 + ids],
        xform: [1, 0, 0, 1, 0, 0],
        modulate: [1, 1, 1, 1],
      },
    ],
    items: [
      item(1, 10, 1, [{ name: "inst", type: "color", value: [0.5, 1, 1, 1] }]),
      item(2, 60, 2),
    ],
    textures: [
      {
        id: 1 + ids,
        origin: "created",
        hash: H("7"),
        kind: "image",
        status: "ok",
      },
    ],
    shaders: [
      {
        id: 1 + ids,
        origin: over.origin ?? "adopted",
        status: "ok",
        reason: null,
        version: 1,
        mode: "canvas_item",
        source: "payload",
        hash: over.hash ?? H("a"),
        payload_bytes: 300,
        builtin: null,
        uses: [],
        default_textures: [],
      },
      {
        id: 2 + ids,
        origin: "adopted",
        status: "ok",
        reason: null,
        version: 1,
        mode: "canvas_item",
        source: "payload",
        hash: H("c"),
        payload_bytes: 193,
        builtin,
        uses: [],
        default_textures: [],
      },
    ],
    materials: [
      {
        id: 1 + ids,
        origin: "adopted",
        status: "ok",
        reason: null,
        version: 1,
        shader: 1 + ids,
        params: [
          { name: "pal", type: "rid", value: { tex: 1 + ids } },
          { name: "tint", type: "color", value: [over.tint ?? 0.5, 1, 1, 1] },
        ],
      },
      {
        id: 2 + ids,
        origin: "adopted",
        status: "ok",
        reason: null,
        version: 1,
        shader: (over.yShader ?? 2) + ids,
        params: [],
      },
    ],
  } as unknown as State;
}

const EXP: Pick<
  G8mExpected,
  | "checkpoints"
  | "items"
  | "materials"
  | "instance"
  | "shared_shader"
  | "include_refused"
> = {
  checkpoints: [{ step: 0, applied: 0, settle: 2 }],
  items: {
    X: { at: [10, 10], material: "MX", from_step: 0 },
    Y: { at: [60, 10], material: "MY", from_step: 0 },
  },
  materials: {
    MX: { item: "X", shader: "main", origin: "adopted" },
    MY: {
      item: "Y",
      builtin: {
        blend_mode: "add",
        light_mode: "normal",
        particles_animation: false,
      },
      origin: "adopted",
    },
  },
  instance: { X: ["inst"] },
  shared_shader: [],
  include_refused: { item: "X", rect: [10, 10, 57, 49] },
};
const ORACLE: OracleLine[] = [
  {
    step: 0,
    frame: 14,
    shaders: [
      { name: "main", status: "live", payload_bytes: 300, sha256: H("a") },
    ],
    materials: [
      {
        name: "MX",
        status: "live",
        params: [
          { name: "pal", type: "rid", value: { tex: "PAL" } },
          { name: "tint", type: "color", value: [0.5, 1, 1, 1] },
        ],
      },
    ],
    items: [
      {
        name: "X",
        instance_params: [
          { name: "inst", type: "color", value: [0.5, 1, 1, 1] },
        ],
      },
    ],
  },
];
const NAMES = new Map([[H("7"), "PAL"]]);
const adopted = () => "adopted";

async function main(): Promise<void> {
  // 1. expected.json
  const expected = JSON.parse(
    await readFile(
      join(EXPERIMENT_DIR, "fixtures", "gate8-mat", "expected.json"),
      "utf8",
    ),
  ) as G8mExpected & { schema: string };
  assert(
    expected.schema === "render-stream-gate8-mat-expected/1",
    "expected.json schema",
  );
  for (const [name, m] of Object.entries(expected.materials)) {
    assert(
      expected.items[m.item]?.material === name,
      `${name}'s item draws with it`,
    );
    assert(
      (m.shader === undefined) !== (m.builtin === undefined),
      `${name} has a shader or a builtin`,
    );
  }
  const a = expected.account as Record<string, number>;
  assert(
    a.materials === a.shader_materials + a.canvas_item_materials,
    "account: materials by class",
  );
  assert(
    a.shaders === 3 + a.shaders_builtin,
    "account: three fixture Shaders plus the templates",
  );
  const box = expected.items[expected.include_refused.item].at;
  assert(
    JSON.stringify(expected.include_refused.rect) ===
      JSON.stringify([box[0], box[1], box[0] + 47, box[1] + 39]),
    "include-refused rect is the item's 48x40 box",
  );

  // 2. shaderHashParity
  const one = (s: State) => () => s;
  assert(
    shaderHashParity(EXP, ORACLE, one(scene()), adopted).problems.length === 0,
    "hash parity: passes",
  );
  assert(
    shaderHashParity(EXP, ORACLE, one(scene(0, { hash: H("b") })), adopted)
      .problems.length === 1,
    "hash parity: a raw-code hash fails",
  );
  assert(
    shaderHashParity(EXP, ORACLE, one(scene(0, { origin: "created" })), adopted)
      .problems.length === 1,
    "hash parity: a created origin fails",
  );
  const sized = structuredClone(ORACLE);
  sized[0].shaders[0].payload_bytes = 301;
  assert(
    shaderHashParity(EXP, sized, one(scene()), adopted).problems.length === 1,
    "hash parity: a size mismatch fails",
  );
  assert(
    shaderHashParity(EXP, ORACLE, () => undefined, adopted).problems.length ===
      1,
    "hash parity: no transaction fails",
  );

  // 3. paramParity
  assert(
    paramParity(EXP, ORACLE, one(scene(5)), NAMES).problems.length === 0,
    "params: pass (other ids)",
  );
  assert(
    paramParity(EXP, ORACLE, one(scene(0, { tint: 0.25 })), NAMES).problems
      .length === 1,
    "params: a changed value fails",
  );
  const missing = scene();
  (missing.materials ?? [])[0].params.pop();
  assert(
    paramParity(EXP, ORACLE, one(missing), NAMES).problems.length === 1,
    "params: a missing parameter fails",
  );
  const extra = scene();
  (extra.materials ?? [])[0].params.push({
    name: "gain",
    type: "float",
    value: 1,
  });
  assert(
    paramParity(EXP, ORACLE, one(extra), NAMES).problems.length === 1,
    "params: an undeclared parameter fails",
  );
  assert(
    paramParity(EXP, ORACLE, one(scene()), new Map()).problems.length === 1,
    "params: an unnamed texture fails",
  );
  const unset = { ...EXP, instance: { X: [] } };
  assert(
    paramParity(unset, ORACLE, one(scene()), NAMES).problems.length === 1,
    "params: a never-set instance parameter on the wire fails",
  );
  const noInst = scene();
  noInst.items[0].instance_params = [];
  assert(
    paramParity(unset, ORACLE, one(noInst), NAMES).problems.length === 0,
    "params: a never-set instance parameter absent passes",
  );
  assert(
    paramParity(EXP, ORACLE, one(noInst), NAMES).problems.length === 1,
    "params: a set instance parameter missing fails",
  );

  // 4. cimBuiltin
  assert(
    cimBuiltin(EXP, one(scene(3)), one(scene())).problems.length === 0,
    "cim: builtin and born's hash pass",
  );
  const otherHash = scene();
  (otherHash.shaders ?? [])[1].hash = H("d");
  assert(
    cimBuiltin(EXP, one(scene()), one(otherHash)).problems.length === 1,
    "cim: another hash fails",
  );
  const noBuiltin = scene();
  (noBuiltin.shaders ?? [])[1].builtin = null;
  assert(
    cimBuiltin(EXP, one(scene()), one(noBuiltin)).problems.length >= 1,
    "cim: a missing builtin fails",
  );
  const shared = { ...EXP, shared_shader: [["X", "Y"]] as [string, string][] };
  assert(
    cimBuiltin(shared, one(scene()), one(scene())).problems.length === 1,
    "cim: two entries for one shared mode fail",
  );
  assert(
    cimBuiltin(shared, one(scene()), one(scene(0, { yShader: 1 }))).problems
      .length >= 1 &&
      cimBuiltin(
        shared,
        one(scene()),
        one(scene(0, { yShader: 1 })),
      ).problems.every((p) => !p.includes("expected one entry")),
    "cim: one shared entry satisfies the pair",
  );

  // 5. includeRefused
  const fault = scene();
  Object.assign((fault.shaders ?? [])[0], {
    status: "unsupported",
    reason: "shader-adopt-include",
    hash: null,
    payload_bytes: 0,
    mode: null,
    source: null,
  });
  (fault as { unsupported: unknown[] }).unsupported = [
    { op: "canvas_item_set_material", item: 1, reason: "unsupported-material" },
  ];
  assert(
    includeRefused(EXP, one(scene()), one(fault)).problems.length === 0,
    "include: the typed refusal passes",
  );
  assert(
    includeRefused(EXP, one(scene()), one(scene())).problems.length === 2,
    "include: a hashed shader and no entry fail",
  );

  // 6. canonicalState: material content, not ids
  assert(
    compareStates(canonicalState(scene()), canonicalState(scene(7))).problems
      .length === 0,
    "canon: other ids, same content",
  );
  assert(
    compareStates(
      canonicalState(scene()),
      canonicalState(scene(0, { tint: 0.25 })),
    ).problems.length === 1,
    "canon: another parameter differs",
  );
  assert(
    compareStates(
      canonicalState(scene()),
      canonicalState(scene(0, { hash: H("e") })),
    ).problems.length === 1,
    "canon: another shader hash differs",
  );

  console.log(
    `\nself-test-gate8-mat: ${assertions - failures}/${assertions} assertions passed`,
  );
  if (failures > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
