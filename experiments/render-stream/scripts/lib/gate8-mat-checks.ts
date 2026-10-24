// Gate 8 g8m checks (G8m, protocol/gate8-design.md "Q5. Pre-arm materials and shaders", D11, D12):
// pre-arm ShaderMaterials, CanvasItemMaterials and Shaders adopted at arm and at the next frame
// boundary, judged on fixtures/gate8-mat. The pure evaluators (shaderHashParity, paramParity,
// cimBuiltin, includeRefused) take resolved states and the oracle's lines, so
// scripts/test/self-test-gate8-mat.ts can drive them on synthetic values.
//
// Independent expectations only (D15):
//   - the rendered reference's material oracle (gate 5.5's material_oracle.gd: the GRP1 hash of
//     RenderingServer.shader_get_code, which GLES3 keeps as the server received it, and
//     material_get_param / canvas_item_get_instance_shader_parameter) is what each capture's wire
//     must carry (`shader-hash-parity`, `param-parity`);
//   - the born capture (every object created under the hooks) is what the late capture must equal
//     (`adopt-equivalence`, through gate8-adopt-checks' bijection, materials compared by content)
//     and what each CanvasItemMaterial's rebuilt template must hash to (`adopt-cim-builtin`: the
//     born hook copied the engine's own generated code);
//   - the rendered reference judges every receiver shot (`adopt-reference`).
// Fixture items are found on the wire by their transform origin (expected.json `items`), never by
// id; a material by the item that draws with it.

import { join } from "node:path";

import {
  check,
  equivalence,
  exitCode,
  type G8aCheck,
  jsonl,
  loadRecording,
  type Rect,
  readJson,
  readText,
  shotDiff,
  skipped,
  stateAt,
} from "./gate8-adopt-checks";
import { textureHashNames } from "./gate55e-checks";
import { type ResolvedTransaction, validateRecording } from "./render-stream-2";

type State = ResolvedTransaction["state"];

interface Builtin {
  blend_mode: string;
  light_mode: string;
  particles_animation: boolean;
}

export interface G8mExpected {
  arm_frame: number;
  checkpoints: { step: number; applied: number; settle: number }[];
  items: Record<
    string,
    { at: [number, number]; material: string; from_step: number }
  >;
  materials: Record<
    string,
    { item: string; shader?: string; builtin?: Builtin; origin: string }
  >;
  shared_shader: [string, string][];
  instance: Record<string, string[]>;
  account: Record<string, number | boolean>;
  textures: Record<
    string,
    { width: number; height: number; rgba8_hex: string }
  >;
  include_refused: { item: string; rect: Rect };
}

/** One materials.jsonl line (render-stream-gate55-materials/1). */
export interface OracleLine {
  step: number;
  frame: number;
  shaders: {
    name: string;
    status: string;
    payload_bytes?: number;
    sha256?: string;
  }[];
  materials: {
    name: string;
    status: string;
    params?: { name: string; type: string; value: unknown }[];
  }[];
  items: {
    name: string;
    instance_params: { name: string; type: string; value: unknown }[];
  }[];
}

/** The wire item a fixture item is (by its transform origin), undefined when absent. */
export function itemAt(state: State, at: [number, number]) {
  return state.items.find((i) => i.xform[4] === at[0] && i.xform[5] === at[1]);
}

const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** A wire parameter in the oracle's spelling: bool as true/false, a texture by fixture name. */
export function paramView(
  p: { type: string; value: unknown },
  state: State,
  hashNames: ReadonlyMap<string, string>,
): { type: string; value: unknown } {
  if (p.type === "bool") return { type: "bool", value: p.value !== 0 };
  if (p.type === "rid") {
    const id = (p.value as { tex: number } | null)?.tex;
    const hash = state.textures.find((t) => t.id === id)?.hash ?? null;
    return {
      type: "rid",
      value: {
        tex: hash !== null ? (hashNames.get(hash) ?? `#${id}`) : `#${id}`,
      },
    };
  }
  return { type: p.type, value: p.value };
}

/** shader-hash-parity on one capture: at each checkpoint, every fixture material's shader (named in
 * expected.json `materials[].shader`) is, through the item that draws with it, a wire shader whose
 * hash and payload size are the oracle's for that Shader, with the expected origin. */
export function shaderHashParity(
  expected: Pick<G8mExpected, "checkpoints" | "items" | "materials">,
  oracle: OracleLine[],
  stateAtSettle: (step: number) => State | undefined,
  originOf: (material: string) => string | null,
): { problems: string[]; compared: number } {
  const problems: string[] = [];
  let compared = 0;
  for (const cp of expected.checkpoints) {
    const s = stateAtSettle(cp.step);
    const o = oracle.find((l) => l.step === cp.step);
    if (!s || !o) {
      problems.push(
        `step ${cp.step}: ${!s ? "no transaction" : "no oracle line"}`,
      );
      continue;
    }
    for (const [name, m] of Object.entries(expected.materials)) {
      if (!m.shader || expected.items[m.item].from_step > cp.step) continue;
      const os = o.shaders.find((x) => x.name === m.shader);
      const item = itemAt(s, expected.items[m.item].at);
      const mat = (s.materials ?? []).find((x) => x.id === item?.material);
      const sh = (s.shaders ?? []).find((x) => x.id === mat?.shader);
      compared++;
      if (!os?.sha256 || !item || !mat || !sh) {
        problems.push(
          `step ${cp.step} ${name}: ${!os?.sha256 ? "no oracle hash" : !item ? "item absent" : !mat ? "no material" : "no shader"}`,
        );
        continue;
      }
      if (sh.hash !== os.sha256 || sh.payload_bytes !== os.payload_bytes)
        problems.push(
          `step ${cp.step} ${name}: wire shader ${sh.id} ${sh.status}${sh.reason ? `/${sh.reason}` : ""} hash ${(sh.hash ?? "null").slice(0, 12)} ${sh.payload_bytes} B, oracle ${m.shader} ${os.sha256.slice(0, 12)} ${os.payload_bytes} B`,
        );
      const want = originOf(m.shader);
      if (want !== null && sh.origin !== want)
        problems.push(
          `step ${cp.step} ${name}: shader origin ${sh.origin}, expected ${want}`,
        );
    }
  }
  return { problems, compared };
}

/** param-parity on one capture: at each checkpoint, every fixture material carries exactly the
 * parameters the oracle reads back (the declared names; a nil one absent), type and value exact,
 * textures by fixture name; and each oracle item's instance parameters equal the oracle's for the
 * ones a script set (expected.json `instance`), the others absent from the wire. */
export function paramParity(
  expected: Pick<
    G8mExpected,
    "checkpoints" | "items" | "materials" | "instance"
  >,
  oracle: OracleLine[],
  stateAtSettle: (step: number) => State | undefined,
  hashNames: ReadonlyMap<string, string>,
): { problems: string[]; compared: number } {
  const problems: string[] = [];
  let compared = 0;
  for (const cp of expected.checkpoints) {
    const s = stateAtSettle(cp.step);
    const o = oracle.find((l) => l.step === cp.step);
    if (!s || !o) {
      problems.push(
        `step ${cp.step}: ${!s ? "no transaction" : "no oracle line"}`,
      );
      continue;
    }
    for (const om of o.materials) {
      const m = expected.materials[om.name];
      if (!m || om.status !== "live") continue;
      const item = itemAt(s, expected.items[m.item].at);
      const mat = (s.materials ?? []).find((x) => x.id === item?.material);
      if (!mat) {
        problems.push(
          `step ${cp.step} ${om.name}: no wire material on ${m.item}`,
        );
        continue;
      }
      const declared = new Set((om.params ?? []).map((p) => p.name));
      for (const p of mat.params)
        if (!declared.has(p.name))
          problems.push(
            `step ${cp.step} ${om.name}: undeclared parameter ${p.name}`,
          );
      for (const op of om.params ?? []) {
        compared++;
        const wp = mat.params.find((p) => p.name === op.name);
        if (op.type === "nil") {
          if (wp)
            problems.push(
              `step ${cp.step} ${om.name}.${op.name}: nil in the oracle, on the wire`,
            );
          continue;
        }
        const got = wp ? paramView(wp, s, hashNames) : null;
        if (!got || got.type !== op.type || !eq(got.value, op.value))
          problems.push(
            `step ${cp.step} ${om.name}.${op.name}: wire ${JSON.stringify(got)} != oracle ${JSON.stringify({ type: op.type, value: op.value })}`,
          );
      }
    }
    for (const oi of o.items) {
      const item = itemAt(s, expected.items[oi.name]?.at ?? [-1, -1]);
      if (!item) {
        problems.push(`step ${cp.step}: item ${oi.name} not on the wire`);
        continue;
      }
      const set = new Set(expected.instance[oi.name] ?? []);
      for (const op of oi.instance_params) {
        compared++;
        const wp = (item.instance_params ?? []).find((p) => p.name === op.name);
        if (!set.has(op.name)) {
          if (wp)
            problems.push(
              `step ${cp.step} ${oi.name} instance ${op.name}: never set, on the wire as ${JSON.stringify(wp)}`,
            );
          continue;
        }
        const got = wp ? paramView(wp, s, hashNames) : null;
        if (!got || got.type !== op.type || !eq(got.value, op.value))
          problems.push(
            `step ${cp.step} ${oi.name} instance ${op.name}: wire ${JSON.stringify(got)} != oracle ${JSON.stringify({ type: op.type, value: op.value })}`,
          );
      }
    }
  }
  return { problems, compared };
}

/** adopt-cim-builtin: every CanvasItemMaterial of the fixture names, in the late capture, an ok
 * shader with its mode's builtin object and the hash of the born capture's (engine-generated) code
 * for the same item; the declared pairs share one shader entry. */
export function cimBuiltin(
  expected: Pick<
    G8mExpected,
    "checkpoints" | "items" | "materials" | "shared_shader"
  >,
  bornAt: (step: number) => State | undefined,
  lateAt: (step: number) => State | undefined,
): { problems: string[]; compared: number } {
  const problems: string[] = [];
  let compared = 0;
  const shaderOf = (s: State, item: string) => {
    const it = itemAt(s, expected.items[item].at);
    const mat = (s.materials ?? []).find((x) => x.id === it?.material);
    return (s.shaders ?? []).find((x) => x.id === mat?.shader);
  };
  for (const cp of expected.checkpoints) {
    const b = bornAt(cp.step);
    const l = lateAt(cp.step);
    if (!b || !l) {
      problems.push(`step ${cp.step}: no ${!b ? "born" : "late"} transaction`);
      continue;
    }
    for (const [name, m] of Object.entries(expected.materials)) {
      if (!m.builtin || expected.items[m.item].from_step > cp.step) continue;
      compared++;
      const ls = shaderOf(l, m.item);
      const bs = shaderOf(b, m.item);
      if (!ls || !bs) {
        problems.push(
          `step ${cp.step} ${name}: no ${!ls ? "late" : "born"} shader`,
        );
        continue;
      }
      const want = { kind: "canvas_item_material", ...m.builtin };
      if (
        ls.status !== "ok" ||
        ls.origin !== "adopted" ||
        !eq(ls.builtin, want)
      )
        problems.push(
          `step ${cp.step} ${name}: late shader ${ls.status} ${ls.origin} builtin ${JSON.stringify(ls.builtin)}`,
        );
      if (!eq(bs.builtin, want))
        problems.push(
          `step ${cp.step} ${name}: born builtin ${JSON.stringify(bs.builtin)}`,
        );
      if (ls.hash === null || ls.hash !== bs.hash)
        problems.push(
          `step ${cp.step} ${name}: late hash ${ls.hash?.slice(0, 12)}, born ${bs.hash?.slice(0, 12)}`,
        );
    }
    for (const [x, y] of expected.shared_shader) {
      if (
        expected.items[x].from_step > cp.step ||
        expected.items[y].from_step > cp.step
      )
        continue;
      compared++;
      const sx = shaderOf(l, x);
      const sy = shaderOf(l, y);
      if (!sx || !sy || sx.id !== sy.id)
        problems.push(
          `step ${cp.step}: ${x} and ${y} name shaders ${sx?.id} and ${sy?.id}, expected one entry`,
        );
    }
  }
  return { problems, compared };
}

/** adopt-include-refused on the no-include-path capture: the refused item's material names an
 * adopted shader typed unsupported / shader-adopt-include with no code, the item carries the
 * derived unsupported-material entry, and every other fixture material is as in the late capture
 * (same shader hashes, same parameters). */
export function includeRefused(
  expected: Pick<
    G8mExpected,
    "checkpoints" | "items" | "materials" | "include_refused"
  >,
  lateAt: (step: number) => State | undefined,
  faultAt: (step: number) => State | undefined,
): { problems: string[] } {
  const problems: string[] = [];
  const view = (s: State, item: string) => {
    const it = itemAt(s, expected.items[item].at);
    const mat = (s.materials ?? []).find((x) => x.id === it?.material);
    const sh = (s.shaders ?? []).find((x) => x.id === mat?.shader);
    return { it, mat, sh };
  };
  for (const cp of expected.checkpoints) {
    const l = lateAt(cp.step);
    const f = faultAt(cp.step);
    if (!l || !f) {
      problems.push(`step ${cp.step}: no ${!l ? "late" : "fault"} transaction`);
      continue;
    }
    const r = view(f, expected.include_refused.item);
    if (
      !r.sh ||
      r.sh.status !== "unsupported" ||
      r.sh.reason !== "shader-adopt-include" ||
      r.sh.hash !== null ||
      r.sh.origin !== "adopted"
    )
      problems.push(
        `step ${cp.step}: ${expected.include_refused.item}'s shader ${JSON.stringify(r.sh ? { status: r.sh.status, reason: r.sh.reason, hash: r.sh.hash, origin: r.sh.origin } : null)}`,
      );
    if (
      !f.unsupported.some(
        (u) => u.reason === "unsupported-material" && u.item === r.it?.id,
      )
    )
      problems.push(
        `step ${cp.step}: no unsupported-material entry on ${expected.include_refused.item}`,
      );
    for (const [name, m] of Object.entries(expected.materials)) {
      if (
        m.item === expected.include_refused.item ||
        expected.items[m.item].from_step > cp.step
      )
        continue;
      const a = view(l, m.item);
      const b = view(f, m.item);
      if (a.sh?.hash !== b.sh?.hash || !eq(a.mat?.params, b.mat?.params))
        problems.push(`step ${cp.step} ${name}: differs from the late capture`);
    }
  }
  return { problems };
}

// ------------------------------------------------------------------------------- the group

const SABOTAGES = ["adopt-raw-shader-code", "adopt-skip-params"] as const;

export interface G8mReport {
  legs: Record<string, { exit_code: string | null; skipped: string | null }>;
  equivalence: { frames_compared: number; first_problems: string[] } | null;
  account: unknown;
  pixels: Record<string, unknown>;
  sabotages: Record<string, unknown>;
}

export async function runG8m(
  out: string,
  expected: G8mExpected,
): Promise<{ checks: G8aCheck[]; report: G8mReport }> {
  const root = join(out, "g8m");
  const checks: G8aCheck[] = [];
  const legDirs = [
    "import/fixture",
    "import/receiver",
    "born/capture",
    "late/capture",
    ...SABOTAGES.map((s) => `sabotage-${s}/capture`),
    "fault-no-include-path/capture",
    "reference",
    "born/receiver",
    "late/receiver",
    "late/receiver-patch",
    "fault-no-include-path/receiver",
  ];
  const legs: G8mReport["legs"] = {};
  for (const l of legDirs)
    legs[l] = {
      exit_code: await exitCode(join(root, l)),
      skipped: skipped(join(root, l)),
    };
  const report: G8mReport = {
    legs,
    equivalence: null,
    account: null,
    pixels: {},
    sabotages: {},
  };
  const K = expected.arm_frame;
  const settle = (step: number) =>
    K + (expected.checkpoints.find((c) => c.step === step)?.settle ?? 0);
  {
    const problems: string[] = [];
    for (const l of legDirs) {
      if (legs[l].skipped !== null) continue;
      if (legs[l].exit_code !== "0")
        problems.push(`${l} exit ${legs[l].exit_code}`);
    }
    checks.push(
      check(
        "g8m-legs",
        "every g8m leg that ran (imports, the born/late/sabotage/fault captures, the rendered reference with its material oracle and every receiver) exits 0",
        problems,
        `${legDirs.filter((l) => legs[l].exit_code !== null && legs[l].skipped === null).length} legs`,
      ),
    );
  }

  const load = async (leg: string) => loadRecording(join(root, leg, "capture"));
  const born = await load("born");
  const late = await load("late");
  const at = (r: Awaited<ReturnType<typeof load>>) => (step: number) =>
    r.rec ? stateAt(r.rec, settle(step))?.state : undefined;
  const oracleText = await readText(join(root, "reference/materials.jsonl"));
  const oracle =
    oracleText === undefined ? undefined : jsonl<OracleLine>(oracleText);
  const hashNames = await textureHashNames(
    join(root, "late/capture/store"),
    expected.textures,
  );
  const bornHashNames = await textureHashNames(
    join(root, "born/capture/store"),
    expected.textures,
  );
  const originOf = (late: boolean) => (shader: string) => {
    if (!late) return "created";
    // The Shader a born capture creates is adopted by a late one, whichever material reaches it.
    return ["main", "rel", "spare"].includes(shader) ? "adopted" : null;
  };

  // --- g8m-wire: both recordings validate at /8, late declares adoption --------------------
  {
    const problems: string[] = [];
    for (const [name, r] of [
      ["born", born],
      ["late", late],
    ] as const) {
      if (r.error || !r.bytes) {
        problems.push(r.error ?? `${name}: no recording`);
        continue;
      }
      const errors = validateRecording(r.bytes, 8);
      if (errors.length > 0)
        problems.push(`${name}: invalid /8 recording: ${errors[0]}`);
    }
    if (born.rec)
      for (const t of born.rec.transactions)
        if (
          (t.state.shaders ?? []).some((x) => x.origin === "adopted") ||
          (t.state.materials ?? []).some((x) => x.origin === "adopted")
        )
          problems.push(`born: adopted shader or material at frame ${t.frame}`);
    if (late.rec) {
      // Every reference resolves before its transaction: no frame carries an unknown material or
      // a material with an unknown shader.
      for (const t of late.rec.transactions) {
        const unknown = t.state.unsupported.filter(
          (u) =>
            u.reason === "unknown-material" ||
            u.reason === "unsupported-material",
        );
        if (unknown.length > 0)
          problems.push(
            `late frame ${t.frame}: ${unknown.map((u) => u.reason).join(",")}`,
          );
        for (const m of t.state.materials ?? [])
          if (m.status !== "ok")
            problems.push(
              `late frame ${t.frame}: material ${m.id} ${m.reason}`,
            );
      }
    }
    checks.push(
      check(
        "g8m-wire",
        "the born and late /8 recordings validate; born publishes no adopted shader or material; in the late capture no transaction carries an unknown-material or unsupported-material entry or a material that is not ok (every pre-arm reference resolved before its transaction)",
        born.bytes || late.bytes ? problems : null,
      ),
    );
  }

  // --- shader-hash-parity and param-parity (late, and born as the control) -----------------
  {
    let problems: string[] | null = null;
    const detail: string[] = [];
    if (oracle && born.rec && late.rec) {
      problems = [];
      for (const [name, r, isLate] of [
        ["born", born, false],
        ["late", late, true],
      ] as const) {
        const e = shaderHashParity(expected, oracle, at(r), originOf(isLate));
        problems.push(...e.problems.map((p) => `${name} ${p}`));
        detail.push(`${name} ${e.compared}`);
      }
    }
    checks.push(
      check(
        "shader-hash-parity",
        "at every checkpoint, each fixture ShaderMaterial's shader on the born and the late wire (found through the item that draws with it) carries the GRP1 hash and size of the code the rendered reference's server holds (gate 5.5's material oracle: shader_get_code, preprocessed, @@ markers included); the late capture's Shaders are adopted",
        problems,
        `compared ${detail.join(", ")}`,
      ),
    );
  }
  {
    let problems: string[] | null = null;
    const detail: string[] = [];
    if (oracle && born.rec && late.rec) {
      problems = [];
      for (const [name, r, names] of [
        ["born", born, bornHashNames],
        ["late", late, hashNames],
      ] as const) {
        const e = paramParity(expected, oracle, at(r), names);
        problems.push(...e.problems.map((p) => `${name} ${p}`));
        detail.push(`${name} ${e.compared}`);
      }
    }
    checks.push(
      check(
        "param-parity",
        "at every checkpoint, each fixture material on the born and the late wire carries exactly the parameters the reference's material_get_param reads back (type and value exact, a texture by its fixture name, a nil one absent), and each oracle item's instance parameters equal canvas_item_get_instance_shader_parameter for the ones a script set, the others absent",
        problems,
        `compared ${detail.join(", ")}`,
      ),
    );
  }

  // --- adopt-cim-builtin --------------------------------------------------------------------
  {
    let problems: string[] | null = null;
    let compared = 0;
    if (born.rec && late.rec) {
      const e = cimBuiltin(expected, at(born), at(late));
      problems = e.problems;
      compared = e.compared;
    }
    checks.push(
      check(
        "adopt-cim-builtin",
        "every CanvasItemMaterial (the pre-arm add mode adopted at arm; post-arm mul and add on modes first used before arm) names, in the late capture, an adopted ok shader with its mode's builtin object and the hash of the code the born capture's hook copied from the engine; C and N4 (one mode) share one shader entry",
        problems,
        `${compared} comparisons`,
      ),
    );
  }

  // --- adopt-equivalence --------------------------------------------------------------------
  {
    let problems: string[] | null = null;
    if (born.rec && late.rec) {
      const e = equivalence(born.rec, late.rec, K, 0);
      problems = e.problems;
      report.equivalence = {
        frames_compared: e.frames,
        first_problems: e.problems.slice(0, 20),
      };
    }
    checks.push(
      check(
        "adopt-equivalence",
        `at every frame from the arm (${K}) on, the late capture's resolved state equals the born capture's under gate8-adopt's id bijection and Q2's exceptions, every item's material compared by content (status, shader status, reason, hash, builtin and default textures, parameters with textures by payload hash) and its instance parameters likewise`,
        problems,
        `${report.equivalence?.frames_compared} frames equal`,
      ),
    );
  }

  // --- adopt-material-account -------------------------------------------------------------
  {
    const problems: string[] = [];
    const result = await readJson<{
      stream?: {
        gate8?: { adopt_stats?: { material_adoption?: Record<string, unknown> } };
      };
    }>(join(root, "late/capture/evidence/result.json"));
    const st = result?.stream?.gate8?.adopt_stats?.material_adoption;
    report.account = st ?? null;
    if (!st) problems.push("no stream.gate8.adopt_stats.material_adoption");
    else
      for (const [k, v] of Object.entries(expected.account))
        if (st[k] !== v)
          problems.push(
            `${k} ${JSON.stringify(st[k])}, expected ${JSON.stringify(v)}`,
          );
    if (
      st &&
      (typeof st.nodes_added !== "number" || (st.nodes_added as number) < 4)
    )
      problems.push(
        `nodes_added ${st.nodes_added}, expected >= 4 (the K+4 items)`,
      );
    checks.push(
      check(
        "adopt-material-account",
        `the late capture's result.json stream.gate8.adopt_stats.material_adoption equals expected.json account (${Object.entries(
          expected.account,
        )
          .map(([k, v]) => `${k} ${v}`)
          .join(", ")}) and the node map saw the post-arm items`,
        result ? problems : null,
      ),
    );
  }

  // --- adopt-reference: receiver shots equal the rendered reference ------------------------
  {
    const problems: string[] = [];
    let any = false;
    for (const leg of [
      "born/receiver",
      "late/receiver",
      "late/receiver-patch",
    ]) {
      const diffs = [];
      for (const cp of expected.checkpoints) {
        const d = await shotDiff(
          join(root, "reference"),
          join(root, leg),
          cp.step,
        );
        diffs.push(d);
        if (!d.present) problems.push(`${leg} step ${cp.step}: shot missing`);
        else if (d.differing > 0)
          problems.push(
            `${leg} step ${cp.step}: ${d.differing} px differ (max delta ${d.max_delta})`,
          );
        any = any || d.present;
      }
      report.pixels[leg] = diffs;
    }
    checks.push(
      check(
        "adopt-reference",
        "the native receiver's shots of the born capture and of the late capture (full and patch sinks) equal the unarmed rendered reference at every checkpoint, pixel for pixel",
        any ? problems : null,
      ),
    );
  }

  // --- adopt-include-refused (GRC_ADOPT_FAULT=no-include-path) -------------------------------
  {
    let problems: string[] | null = null;
    const fault = await load("fault-no-include-path");
    if (late.rec && fault.rec) {
      problems = includeRefused(expected, at(late), at(fault)).problems;
      const result = await readJson<{
        stream?: {
          gate8?: { adopt_stats?: { material_adoption?: Record<string, unknown> } };
        };
      }>(join(root, "fault-no-include-path/capture/evidence/result.json"));
      const n =
        result?.stream?.gate8?.adopt_stats?.material_adoption?.shaders_include_refused;
      if (n !== 1) problems.push(`shaders_include_refused ${n}, expected 1`);
      if (fault.bytes) {
        const errors = validateRecording(fault.bytes, 8);
        if (errors.length > 0)
          problems.push(`invalid /8 recording: ${errors[0]}`);
      }
      const rect = expected.include_refused.rect;
      for (const cp of expected.checkpoints) {
        const d = await shotDiff(
          join(root, "reference"),
          join(root, "fault-no-include-path/receiver"),
          cp.step,
          [rect],
        );
        report.pixels["fault-no-include-path/receiver"] = [
          ...((report.pixels["fault-no-include-path/receiver"] as unknown[]) ??
            []),
          d,
        ];
        if (!d.present) problems.push(`receiver step ${cp.step}: shot missing`);
        else if (d.outside > 0 || d.inside[0] === 0)
          problems.push(
            `receiver step ${cp.step}: ${d.outside} px differ outside ${expected.include_refused.item}, ${d.inside[0]} inside`,
          );
      }
    }
    checks.push(
      check(
        "adopt-include-refused",
        `with GRC_ADOPT_FAULT=no-include-path (the temporary Shader gets no path, D11 as written) the relative #include cannot resolve: ${expected.include_refused.item}'s shader publishes adopted, unsupported / shader-adopt-include with no code, the item carries unsupported-material, every other material equals the late capture's, the recording validates at /8, and the receiver differs from the reference only inside ${expected.include_refused.item} (drawn without its material)`,
        problems,
      ),
    );
  }

  // --- the two Q5 sabotages: each must fail its check ---------------------------------------
  for (const s of SABOTAGES) {
    const leg = `sabotage-${s}`;
    const r = await load(leg);
    let problems: string[] | null = null;
    if (r.rec && oracle) {
      problems = [];
      const e =
        s === "adopt-raw-shader-code"
          ? shaderHashParity(expected, oracle, at(r), originOf(true))
          : paramParity(
              expected,
              oracle,
              at(r),
              await textureHashNames(
                join(root, leg, "capture/store"),
                expected.textures,
              ),
            );
      report.sabotages[s] = {
        detected: e.problems.length,
        first: e.problems.slice(0, 4),
      };
      if (e.problems.length === 0)
        problems.push(
          `${s === "adopt-raw-shader-code" ? "shader-hash-parity" : "param-parity"} passed on the sabotage capture`,
        );
    }
    checks.push(
      check(
        `sabotage-${s}`,
        s === "adopt-raw-shader-code"
          ? "the adopt-raw-shader-code capture (adopted shaders publish Shader.get_code(), unpreprocessed) fails shader-hash-parity"
          : "the adopt-skip-params capture (adopted materials and items publish no parameters) fails param-parity",
        problems,
        `detected: ${JSON.stringify(report.sabotages[s])}`,
      ),
    );
  }
  return { checks, report };
}
