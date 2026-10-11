#!/usr/bin/env -S pnpm exec tsx --conditions=development
// Self-test for gate 5.5e: the g55e evaluators of lib/gate55e-checks.ts on the committed
// fixtures/gate55-shader/expected.json and on render-stream/5 wire states synthesized from its
// oracle views (what the reference's material oracle must read back), each with a passing and a
// failing case.
//
//   mise exec -- pnpm exec tsx --conditions=development \
//     experiments/render-stream/scripts/test/self-test-gate55e.ts
//
// 1. applyPolicyToLog: params withholds every non-builtin code line, exclude also refuses it with
//    shader-excluded (a D11 reason wins), a builtin line and source are untouched.
// 2. evaluateShaderHashParity; then tint's hash moving to another id, a hash on two entries, a
//    freed shader still on the wire, a payload size off.
// 3. evaluateParamParity (bool, int, float64, colours, vector2i, the packed float32 array, the
//    texture parameter by name, I2's unset instance parameter exempt); then one ulp off, an erased
//    parameter still on the wire, an undeclared parameter, the texture parameter naming TEX16.
// 4. codeBytesIn and evaluatePolicyRespected; then a `payload` entry, a GRP1 file in the store, the
//    code inside a log, a blind control scan, the wrong declared policy.
// 5. evaluateReceiverTyped and residentShaderVersions; then a typed honest receiver, a refused
//    receiver missing an item, a nolib receiver with one withheld entry short, a lib receiver that
//    fetched.
// 6. receiver_views and their predictions: the view's raster differs from the reference raster in
//    exactly the predicted regions and steps (receiver-refused, receiver-params-nolib); the freeze
//    prediction includes the marker at {1..9}.
//
// Exits non-zero if any assertion fails.

import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { rastersOf } from "../lib/gate5-checks";
import type { Wire5, Wire5Tx } from "../lib/gate55-wire";
import { asGate5, refusedView } from "../lib/gate55c-checks";
import type { MaterialLogLine5 } from "../lib/gate55d-checks";
import {
  applyPolicyToLog,
  codeBytesIn,
  evaluateParamParity,
  evaluatePolicyRespected,
  evaluateReceiverTyped,
  evaluateShaderHashParity,
  type Gate55eExpected,
  residentShaderVersions,
  viewExpected,
} from "../lib/gate55e-checks";

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
      : problems.slice(0, 2).join(" | "),
  );

const e = JSON.parse(
  await readFile(
    join(EXPERIMENT_DIR, "fixtures", "gate55-shader", "expected.json"),
    "utf8",
  ),
) as Gate55eExpected;

// ---------------------------------------------------------------------------------------------
// Synthetic wire from the oracle views
// ---------------------------------------------------------------------------------------------

const TEX_IDS: Record<string, number> = { TEX16: 2, TEX16B: 3 };
const HASH_NAMES = new Map([
  ["h-tex16", "TEX16"],
  ["h-tex16b", "TEX16B"],
]);

function wireValue(type: string, value: unknown): unknown {
  if (type === "bool") return value ? 1 : 0;
  if (type === "rid") return { tex: TEX_IDS[(value as { tex: string }).tex] };
  return value;
}

/** One transaction per step at its settle frame whose tables hold exactly what the oracle view
 * says: shader ids by shader_order, material ids by material_order, item ids by creation order. */
function synthesize(ex: Gate55eExpected): Wire5Tx[] {
  return ex.steps.map((s, k) => {
    const shaders = s.oracle.shaders
      .map((x, i) => ({ x, id: ex.shader_order.indexOf(x.name) + 1, i }))
      .filter(({ x }) => x.status === "live")
      .map(({ x, id }) => ({
        id,
        status: "ok",
        reason: null,
        source: "payload",
        builtin: null,
        hash: x.sha256,
        payload_bytes: x.payload_bytes,
      }));
    const materials = s.oracle.materials
      .filter((m) => m.status === "live")
      .map((m) => ({
        id: ex.material_order.indexOf(m.name) + 1,
        status: "ok",
        shader: null,
        params: (m.params ?? [])
          .filter((p) => p.type !== "nil")
          .map((p) => ({
            name: p.name,
            type: p.type,
            value: wireValue(p.type, p.value),
          })),
      }));
    const items = ex.creation_order.map((name, i) => {
      const view = s.oracle.items.find((x) => x.name === name);
      return {
        id: i + 1,
        parent: null,
        material: null,
        use_parent_material: false,
        instance_params: (view?.instance_params ?? [])
          .filter((p) => p.type !== "vector4")
          .map((p) => ({
            name: p.name,
            type: p.type,
            value: wireValue(p.type, p.value),
          })),
      };
    });
    return {
      seq: k + 1,
      frame: s.settle_frame,
      encoding: "full",
      bytes: 0,
      param_f64: 0,
      wire: {},
      state: {
        shaders,
        materials,
        items,
        textures: [
          { id: 2, hash: "h-tex16" },
          { id: 3, hash: "h-tex16b" },
        ],
        canvases: [],
        meshes: [],
      },
    } as unknown as Wire5Tx;
  });
}

const oracleOf = (ex: Gate55eExpected) => ({
  leg: "oracle",
  problem: null,
  lines: ex.steps.map((s) => ({
    schema: "render-stream-gate55-materials/1",
    step: s.step,
    frame: s.settle_frame,
    ...clone(s.oracle),
  })),
});
const good = synthesize(e);
const sink = (txs: Wire5Tx[]) => [{ label: "sink", transactions: txs }];
const oracle = oracleOf(e);

// 1. applyPolicyToLog -------------------------------------------------------------------------
{
  const lines: MaterialLogLine5[] = [
    {
      frame: 1,
      op: "shader_create_from_code",
      kind: "shader",
      id: 1,
      hash: "aa",
      source: "payload",
      status: "ok",
      reason: null,
      builtin: null,
    },
    {
      frame: 1,
      op: "shader_create_from_code",
      kind: "shader",
      id: 2,
      hash: "bb",
      source: "payload",
      status: "unsupported",
      reason: "shader-time",
      builtin: null,
    },
    {
      frame: 1,
      op: "shader_set_code",
      kind: "shader",
      id: 3,
      hash: "cc",
      source: "payload",
      status: "ok",
      reason: null,
      builtin: {
        kind: "canvas_item_material",
        blend_mode: "add",
        light_mode: "normal",
        particles_animation: false,
      },
    },
    { frame: 1, op: "material_set_param", kind: "material", id: 1 },
  ] as MaterialLogLine5[];
  const src = applyPolicyToLog(lines, "source");
  assert(
    "source policy leaves the log untouched",
    JSON.stringify(src) === JSON.stringify(lines),
  );
  const params = applyPolicyToLog(lines, "params");
  assert(
    "params withholds non-builtin code, keeps status and the builtin",
    params[0].source === "withheld" &&
      params[0].status === "ok" &&
      params[1].source === "withheld" &&
      params[1].reason === "shader-time" &&
      params[2].source === "payload" &&
      params[3] === lines[3],
    JSON.stringify(params.map((l) => [l.source, l.status, l.reason])),
  );
  const exclude = applyPolicyToLog(lines, "exclude");
  assert(
    "exclude refuses an ok code with shader-excluded, a D11 reason wins, the builtin untouched",
    exclude[0].status === "unsupported" &&
      exclude[0].reason === "shader-excluded" &&
      exclude[1].reason === "shader-time" &&
      exclude[2].status === "ok",
    JSON.stringify(exclude.map((l) => [l.source, l.status, l.reason])),
  );
  assert(
    "applyPolicyToLog does not mutate its input",
    lines[0].source === "payload",
  );
}

// 2. shader-hash-parity ---------------------------------------------------------------------------
{
  const r = evaluateShaderHashParity(e, oracle, sink(good));
  passes("shader-hash-parity on the oracle's own tables", r.problems);
  assert(
    "shader-hash-parity compares every live shader-step",
    r.compared ===
      e.steps.reduce(
        (n, s) =>
          n + s.oracle.shaders.filter((x) => x.status === "live").length,
        0,
      ),
    `${r.compared}`,
  );
  assert(
    "shader-hash-parity pairs tint with id 2 for the whole run",
    r.pairing.sink?.tint === 2,
    JSON.stringify(r.pairing),
  );

  const moved = clone(good);
  for (const t of moved.slice(3))
    for (const s of t.state.shaders ?? []) if (s.id === 2) s.id = 9;
  fails(
    "shader-hash-parity when tint's code change lands on a new id",
    evaluateShaderHashParity(e, oracle, sink(moved)).problems,
    "moved from shader 2",
  );

  const twice = clone(good);
  const ts = twice[0].state.shaders ?? [];
  ts.push({ ...ts[0], id: 8 });
  fails(
    "shader-hash-parity when two entries carry one hash",
    evaluateShaderHashParity(e, oracle, sink(twice)).problems,
    "2 wire shaders carry",
  );

  const freed = clone(good);
  const step9 = freed[9].state.shaders ?? [];
  step9.push({ ...step9[0], id: 6, hash: "3ef1ae4f" });
  fails(
    "shader-hash-parity when the freed sh_a is still on the wire",
    evaluateShaderHashParity(e, oracle, sink(freed)).problems,
    "sh_a is freed",
  );

  const size = clone(good);
  (size[0].state.shaders ?? [])[0].payload_bytes += 1;
  fails(
    "shader-hash-parity when a payload size is off",
    evaluateShaderHashParity(e, oracle, sink(size)).problems,
    "payload_bytes",
  );
}

// 3. param-parity ---------------------------------------------------------------------------------
{
  const r = evaluateParamParity(e, oracle, sink(good), HASH_NAMES);
  passes("param-parity on the oracle's own values", r.problems);
  assert(
    "param-parity exempts I2's unset instance parameter at steps 0 and 1",
    r.exempt === 2,
    `exempt ${r.exempt}`,
  );
  assert(
    "param-parity compares every declared and instance parameter",
    r.compared > 100,
    `${r.compared}`,
  );

  const ulp = clone(good);
  const mt = (ulp[1].state.materials ?? []).find((m) => m.id === 1);
  const tint = mt?.params.find((p) => p.name === "tint");
  if (tint) (tint.value as number[])[0] = 0.8000000119209291;
  fails(
    "param-parity when MT.tint is one ulp off",
    evaluateParamParity(e, oracle, sink(ulp), HASH_NAMES).problems,
    "MT.tint",
  );

  const erased = clone(good);
  const mt4 = (erased[4].state.materials ?? []).find((m) => m.id === 1);
  mt4?.params.push({ name: "gain", type: "float", value: 0.5 });
  fails(
    "param-parity when MT.gain survives its erase at step 4",
    evaluateParamParity(e, oracle, sink(erased), HASH_NAMES).problems,
    "MT.gain is nil",
  );

  const extra = clone(good);
  (extra[0].state.materials ?? [])[0].params.push({
    name: "bogus",
    type: "int",
    value: 1,
  });
  fails(
    "param-parity with an undeclared parameter",
    evaluateParamParity(e, oracle, sink(extra), HASH_NAMES).problems,
    "undeclared parameter bogus",
  );

  const tex = clone(good);
  const mp = (tex[6].state.materials ?? []).find((m) => m.id === 2);
  const pal = mp?.params.find((p) => p.name === "pal");
  if (pal) pal.value = { tex: 2 };
  fails(
    "param-parity when MP.pal names TEX16 instead of TEX16B",
    evaluateParamParity(e, oracle, sink(tex), HASH_NAMES).problems,
    "MP.pal",
  );

  const bool = clone(good);
  const my = (bool[7].state.materials ?? []).find((m) => m.id === 4);
  const on = my?.params.find((p) => p.name === "on");
  if (on) on.value = 0;
  fails(
    "param-parity when MY.on stays false at step 7",
    evaluateParamParity(e, oracle, sink(bool), HASH_NAMES).problems,
    "MY.on",
  );

  const inst = clone(good);
  const i2 = inst[2].state.items.find((i) => i.id === 4);
  if (i2) i2.instance_params = [];
  fails(
    "param-parity when I2's set instance parameter is missing at step 2",
    evaluateParamParity(e, oracle, sink(inst), HASH_NAMES).problems,
    "I2 instance inst_color",
  );
}

// 4. shader-policy-respected ----------------------------------------------------------------------
{
  const code =
    "shader_type canvas_item;\nvoid fragment() { COLOR = vec4(1.0); }\n";
  const found = codeBytesIn(
    [
      { path: "a.rs2", bytes: new TextEncoder().encode(`xx${code}yy`) },
      { path: "b.jsonl", bytes: new TextEncoder().encode('{"hash":"abc"}') },
      {
        path: "c.grp",
        bytes: new Uint8Array([
          0x47, 0x52, 0x50, 0x31, 0x0d, 0x0a, 0x1a, 0x0a, 0,
        ]),
      },
    ],
    [code],
  );
  assert(
    "codeBytesIn finds code and the GRP1 magic, and nothing in a hash-only line",
    found.some((f) => f.startsWith("a.rs2: fixture code")) &&
      found.some((f) => f === "c.grp: GRP1 magic") &&
      !found.some((f) => f.startsWith("b.jsonl")),
    JSON.stringify(found),
  );
  const withheld = (policy: "params" | "exclude"): Wire5 => ({
    path: `${policy}.rs2`,
    present: true,
    error: null,
    session: {
      materials: { shader_policy: policy },
    } as unknown as Wire5["session"],
    resources: [],
    transactions: [
      {
        frame: 1,
        state: {
          shaders: [
            {
              id: 1,
              status: policy === "params" ? "ok" : "unsupported",
              reason: policy === "params" ? null : "shader-excluded",
              source: "withheld",
              hash: "aa",
              builtin: null,
            },
            {
              id: 2,
              status: "ok",
              reason: null,
              source: "payload",
              hash: "bb",
              builtin: { kind: "canvas_item_material" },
            },
          ],
        },
      } as unknown as Wire5Tx,
    ],
  });
  const input = (
    policy: "params" | "exclude",
    over: Partial<Parameters<typeof evaluatePolicyRespected>[0]> = {},
  ) => ({
    leg: policy,
    policy,
    wires: [withheld(policy)],
    storeFiles: ["store/sha256/x.grt"],
    storeIndex: '{"type":"texture"}\n',
    found: [],
    scanned: 5,
    ...over,
  });
  const control = { found: ["capture-shader/recording.rs2: GRP1 magic"] };
  passes(
    "shader-policy-respected under params",
    evaluatePolicyRespected(input("params"), control).problems,
  );
  passes(
    "shader-policy-respected under exclude",
    evaluatePolicyRespected(input("exclude"), control).problems,
  );
  const payload = withheld("params");
  (payload.transactions[0].state.shaders ?? [])[0].source = "payload";
  fails(
    "shader-policy-respected with a payload entry under params",
    evaluatePolicyRespected(input("params", { wires: [payload] }), control)
      .problems,
    "expected withheld",
  );
  fails(
    "shader-policy-respected with a GRP1 file in the store",
    evaluatePolicyRespected(
      input("params", { storeFiles: ["store/sha256/aa.grp"] }),
      control,
    ).problems,
    "GRP1 files",
  );
  fails(
    "shader-policy-respected with code in the hook log",
    evaluatePolicyRespected(
      input("exclude", { found: ["evidence/resources.jsonl: `shader_type`"] }),
      control,
    ).problems,
    "code bytes",
  );
  fails(
    "shader-policy-respected with a blind control scan",
    evaluatePolicyRespected(input("params"), { found: [] }).problems,
    "blind",
  );
  fails(
    "shader-policy-respected with the wrong declared policy",
    evaluatePolicyRespected({ ...input("params"), policy: "exclude" }, control)
      .problems,
    "shader_policy",
  );
}

// 5. shader-receiver-typed, residentShaderVersions --------------------------------------------------
{
  const tx = (resources: Record<string, number>) => ({
    seq: 1,
    frame: 1,
    resources,
  });
  const legs = [
    {
      leg: "receiver-shader",
      kind: "honest" as const,
      stdout: "ok\n",
      applied: {
        unsupported: [],
        transactions: [tx({ shader_code_sets: 8, shader_payload_fetches: 8 })],
      },
    },
    {
      leg: "receiver-refused",
      kind: "refused" as const,
      stdout: "",
      refusedItems: [9, 10],
      applied: {
        unsupported: [
          {
            name: "canvas_item_set_material",
            reason: "unsupported-material",
            item: 10,
          },
          {
            name: "canvas_item_set_material",
            reason: "unsupported-material",
            item: 9,
          },
        ],
        transactions: [],
      },
    },
    {
      leg: "receiver-params-nolib",
      kind: "nolib" as const,
      stdout: "",
      withheld: ["1:aa", "2:bb"],
      applied: {
        unsupported: [
          { name: "shader_set_code", reason: "shader-withheld", item: null },
          { name: "shader_set_code", reason: "shader-withheld", item: null },
        ],
        transactions: [tx({ shader_code_sets: 0 })],
      },
    },
    {
      leg: "receiver-params-lib",
      kind: "lib" as const,
      stdout: "",
      withheld: ["1:aa", "2:bb"],
      applied: {
        unsupported: [],
        transactions: [tx({ shader_code_sets: 2, shader_payload_fetches: 0 })],
      },
    },
    {
      leg: "sabotage",
      kind: "sabotage" as const,
      stdout: "",
      applied: undefined,
    },
  ];
  passes(
    "shader-receiver-typed",
    evaluateReceiverTyped(legs as never).problems,
  );
  const mutate = (k: number, f: (l: (typeof legs)[number]) => void) => {
    const c = clone(legs);
    f(c[k]);
    return evaluateReceiverTyped(c as never).problems;
  };
  fails(
    "shader-receiver-typed when an honest receiver types something",
    mutate(0, (l) =>
      (l.applied as { unsupported: unknown[] }).unsupported.push({
        name: "x",
        reason: "y",
      }),
    ),
    "applied.json unsupported",
  );
  fails(
    "shader-receiver-typed when the refused receiver misses an item",
    mutate(1, (l) =>
      (l.applied as { unsupported: unknown[] }).unsupported.pop(),
    ),
    "typed {",
  );
  fails(
    "shader-receiver-typed when nolib reports one withheld shader short",
    mutate(2, (l) =>
      (l.applied as { unsupported: unknown[] }).unsupported.pop(),
    ),
    "shader-withheld entries",
  );
  fails(
    "shader-receiver-typed when the lib receiver fetched code",
    mutate(
      3,
      (l) =>
        ((
          l.applied as { transactions: { resources: Record<string, number> }[] }
        ).transactions[0].resources.shader_payload_fetches = 1),
    ),
    "fetched",
  );
  fails(
    "shader-receiver-typed when a sabotage receiver logs a shader error",
    mutate(4, (l) => (l.stdout = "SHADER ERROR: x")),
    "SHADER ERROR",
  );

  const txs = [
    {
      frame: 1,
      state: {
        items: [
          { id: 1, parent: null, material: 1, use_parent_material: false },
          {
            id: 2,
            parent: { kind: "item", id: 1 },
            material: null,
            use_parent_material: true,
          },
          { id: 3, parent: null, material: 2, use_parent_material: false },
        ],
        materials: [
          { id: 1, status: "ok", shader: 1 },
          { id: 2, status: "unsupported", shader: 2 },
        ],
        shaders: [
          { id: 1, status: "ok", hash: "aa" },
          { id: 2, status: "ok", hash: "bb" },
        ],
      },
    },
    {
      frame: 2,
      state: {
        items: [
          { id: 1, parent: null, material: 1, use_parent_material: false },
        ],
        materials: [{ id: 1, status: "ok", shader: 1 }],
        shaders: [{ id: 1, status: "ok", hash: "cc" }],
      },
    },
  ] as unknown as Wire5Tx[];
  const res = residentShaderVersions(txs);
  assert(
    "residentShaderVersions: every reachable (id, hash) once, an unsupported material's shader not",
    JSON.stringify(res) === JSON.stringify(["1:aa", "1:cc"]),
    JSON.stringify(res),
  );
}

// 6. receiver views against their predictions -----------------------------------------------------
{
  for (const [view, ex] of [
    ["receiver-refused", refusedView(e)],
    ["receiver-params-nolib", e],
  ] as const) {
    const v = e.receiver_views[view];
    const ref = rastersOf(asGate5(ex));
    const got = rastersOf(asGate5(viewExpected(ex, v)));
    const pred = (e.predictions[view] as { regions: Record<string, number[]> })
      .regions;
    const diffs: string[] = [];
    for (const s of ex.steps) {
      const a = ref.get(s.step);
      const b = got.get(s.step);
      if (!a || !b) continue;
      const W = ex.viewport[0];
      for (const [region, box] of Object.entries(ex.regions)) {
        let differ = false;
        for (let y = box[1]; y < box[3] && !differ; y++)
          for (let x = box[0]; x < box[2] && !differ; x++) {
            const i = (y * W + x) * 4;
            for (let c = 0; c < 4; c++)
              if (a.rgba[i + c] !== b.rgba[i + c]) differ = true;
          }
        const want = (pred[region] ?? []).includes(s.step);
        if (differ !== want)
          diffs.push(
            `step ${s.step} ${region}: raster ${differ ? "differs" : "equal"}, prediction ${want ? "mismatch" : "match"}`,
          );
      }
    }
    passes(
      `${view}'s raster differs from the reference raster exactly where predicted`,
      diffs,
    );
  }
  const freeze = (
    e.predictions["sabotage-shader-freeze"] as {
      regions: Record<string, number[]>;
    }
  ).regions;
  assert(
    "the freeze prediction includes the marker at {1..9}",
    JSON.stringify(freeze.Marker) ===
      JSON.stringify([1, 2, 3, 4, 5, 6, 7, 8, 9]),
    JSON.stringify(freeze.Marker),
  );
}

console.log(
  `\nself-test-gate55e: ${assertions - failures}/${assertions} assertions passed`,
);
if (failures > 0) process.exitCode = 1;
