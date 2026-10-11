// Gate 5.5e checks (protocol/gate5_5-design.md "G55e", D4, D8, D11-D15, Q3c, Q4, Q5, Q6c, Q6e):
// ShaderMaterial end to end on render-stream/5 over fixtures/gate55-shader, the `params` and
// `exclude` shader-source policies, and perturb-shader. Pure evaluators over values already read
// from a run-gate55.sh evidence directory, plus small loaders and runGate55e, which check-gate55.ts
// merges into the gate 5.5 report. Nothing here launches a process; scripts/test/
// self-test-gate55e.ts drives the evaluators with synthetic values. Classification never reads
// `session.sabotage`.
//
// Independent expectations only (D12): the reference's material oracle (materials.jsonl: the GRP1
// hash of `shader_get_code` and the values of `material_get_param` and
// `canvas_item_get_instance_shader_parameter` on the rendered reference) is what the wire's shader
// hashes and parameter values must equal (`shader-hash-parity`, `param-parity`); the capture's hook
// log (G55a) is the ground truth for the tables per frame (`shader-material-commands`, D15's
// material-log-divergence), with the policy (D4, applied at publication, never at the hook) applied
// to the log's view first; make_expected.py's model predicts every receiver pixel, every sabotage
// region set, and what a receiver draws without a material (`receiver_views`); the rendered
// reference judges every receiver. The params receiver's library is the oracle's own dump, never
// the capture's code.
//
// Legs (beside g55c's capture and reference legs, which g55e reuses):
//   shader/capture-inline/              400-frame capture, every payload inline, no store
//   shader-policy-params/capture/       400 frames, GRC_SHADER_POLICY=params (store: no GRP1)
//   shader-policy-exclude/capture/      400 frames, GRC_SHADER_POLICY=exclude
//   shader/receiver{,-patch,-inline}/   rendered receivers on capture/'s full and patch sinks and
//                                       on capture-inline (receiver-patch dumps state at settles)
//   shader-refused/receiver/            rendered receiver on capture-refused's full sink
//   shader-policy-params/receiver-nolib/  ... on capture-policy-params, no library
//   shader-policy-params/receiver-lib/    ... with RS_RECEIVER_SHADER_LIBRARY=<P>/library (the
//                                         reference oracle's shader-library, copied)
//   shader/sabotage-{freeze,omit-param,perturb-shader}/{capture,receiver}/
//   shader/sabotage-receiver-{ignore-material,stale-param}/   RS_RECEIVER_SABOTAGE on capture/
//   shader/import/receiver/             editor --import of receiver/

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  fileExists,
  readJson,
  readTextOrUndefined,
} from "./gate-minus1-checks";
import {
  type CaptureResultJson,
  type Checkpoint,
  classifyLeg,
  loadRecording,
  PATCH_RECORDING_NAME,
  RECORDING_NAME,
  type RecordingSummary,
  readExitCode,
} from "./gate0-checks";
import { loadResourceLog, type ResourceLine } from "./gate2-checks";
import { evaluateCapture, type Gate3CaptureEvaluation } from "./gate3-checks";
import {
  check,
  compareLegs5,
  evaluateExpectedImage5,
  type Gate5Check,
  type Gate5Checkpoint,
  loadShots5,
  type RegionBudget5,
  rastersOf,
} from "./gate5-checks";
import type { Gate5Item } from "./gate5-expected";
import {
  computeGate5Checkpoints,
  evaluateLegClass5,
  type Gate5LegExpectation,
  loadReceiverShots5,
  settleSeqs,
  shotSeqsPresent5,
} from "./gate5d-checks";
import {
  itemIdsByCreation,
  loadWire5,
  tableIdsOverRun,
  txAt,
  type Wire5,
  type Wire5Tx,
} from "./gate55-wire";
import type { Gate55Expected as Gate55CimExpected } from "./gate55b-expected";
import {
  asGate5,
  evaluateShaderCapture5,
  evaluateShaderLogClean,
  type Gate55ShaderExpected,
  jsonEqual,
  loadOracle,
  type OracleLog,
  refusedView,
  type ShaderTableView,
  type VariantView,
} from "./gate55c-checks";
import {
  type AppliedJson55d,
  classifyMaterialLeg,
  evaluateShaderStore,
  evaluateStateDumps,
  type MaterialLogLine5,
  materialLogDivergence,
  materialsPerStep,
  requestedSeqs,
} from "./gate55d-checks";
import { decodeTexturePayload, type ResolvedParam } from "./render-stream-2";
import { decodeShaderPayload } from "./render-stream-shader";

// ---------------------------------------------------------------------------------------------
// Legs
// ---------------------------------------------------------------------------------------------

export const G55E_QUIT_FRAME = 400;
export const G55E_DIR = {
  shader: "shader",
  refused: "shader-refused",
  params: "shader-policy-params",
  exclude: "shader-policy-exclude",
} as const;

export type ShaderPolicy = "source" | "params" | "exclude";

/** expected.json `receiver_views` (make_expected.py, G55e): per step, what a receiver draws when it
 * draws the named items with no material. */
export interface ReceiverView {
  variant: "" | "refused";
  without_material: string[];
  steps: { step: number; items: Gate5Item[] }[];
}

export type Gate55eExpected = Gate55ShaderExpected & {
  receiver_views: Record<string, ReceiverView>;
};

/** The base (or refused) expected file with every step's items replaced by a receiver view's. */
export function viewExpected(
  base: Gate55ShaderExpected,
  view: ReceiverView,
): Gate55ShaderExpected {
  return {
    ...base,
    steps: base.steps.map((s) => ({
      ...s,
      items: view.steps.find((v) => v.step === s.step)?.items ?? s.items,
    })),
  };
}

/** The new capture legs: report name, scene directory, leg directory, class and policy. */
export const G55E_CAPTURES = [
  {
    leg: "capture-shader-inline",
    dir: G55E_DIR.shader,
    legDir: "capture-inline",
    expect: "success",
    policy: "source",
  },
  {
    leg: "capture-policy-params",
    dir: G55E_DIR.params,
    legDir: "capture",
    expect: "success",
    policy: "params",
  },
  {
    leg: "capture-policy-exclude",
    dir: G55E_DIR.exclude,
    legDir: "capture",
    expect: "unsupported",
    policy: "exclude",
  },
] as const;

/** The non-sabotage receivers. `view` names the receiver view (and the expected.json prediction)
 * a typed leg draws: its class is `unsupported`, its regions mismatch the reference exactly where
 * the prediction says and its pixels equal the view's raster everywhere. */
export const G55E_RECEIVERS = [
  {
    leg: "receiver-shader",
    dir: "shader/receiver",
    capture: "shader/capture",
    sink: RECORDING_NAME,
    variant: "",
    view: null,
  },
  {
    leg: "receiver-shader-patch",
    dir: "shader/receiver-patch",
    capture: "shader/capture",
    sink: PATCH_RECORDING_NAME,
    variant: "",
    view: null,
  },
  {
    leg: "receiver-shader-inline",
    dir: "shader/receiver-inline",
    capture: "shader/capture-inline",
    sink: RECORDING_NAME,
    variant: "",
    view: null,
  },
  {
    leg: "receiver-params-lib",
    dir: "shader-policy-params/receiver-lib",
    capture: "shader-policy-params/capture",
    sink: RECORDING_NAME,
    variant: "",
    view: null,
  },
  {
    leg: "receiver-refused",
    dir: "shader-refused/receiver",
    capture: "shader-refused/capture",
    sink: RECORDING_NAME,
    variant: "refused",
    view: "receiver-refused",
  },
  {
    leg: "receiver-params-nolib",
    dir: "shader-policy-params/receiver-nolib",
    capture: "shader-policy-params/capture",
    sink: RECORDING_NAME,
    variant: "",
    view: "receiver-params-nolib",
  },
] as const;

/** The sabotage legs (each name is its expected.json prediction key): a host sabotage replays its
 * own capture, a receiver sabotage replays shader/capture. */
export const G55E_SABOTAGES = [
  {
    leg: "sabotage-shader-freeze",
    dir: "shader/sabotage-freeze/receiver",
    capture: "shader/sabotage-freeze/capture",
  },
  {
    leg: "sabotage-shader-omit-param",
    dir: "shader/sabotage-omit-param/receiver",
    capture: "shader/sabotage-omit-param/capture",
  },
  {
    leg: "sabotage-shader-perturb-shader",
    dir: "shader/sabotage-perturb-shader/receiver",
    capture: "shader/sabotage-perturb-shader/capture",
  },
  {
    leg: "sabotage-shader-receiver-ignore-material",
    dir: "shader/sabotage-receiver-ignore-material",
    capture: "shader/capture",
  },
  {
    leg: "sabotage-shader-receiver-stale-param",
    dir: "shader/sabotage-receiver-stale-param",
    capture: "shader/capture",
  },
] as const;

// ---------------------------------------------------------------------------------------------
// D4 applied to the hook log's view
// ---------------------------------------------------------------------------------------------

/** The hook log records what the hook saw (`source: payload` for every code it copied); the policy
 * is applied at publication (render-stream-5.md "Shader table", G55d amendment 3): under `params`
 * and `exclude` a non-builtin shader with code is `withheld`, and under `exclude` an `ok` one is
 * `unsupported` / `shader-excluded` (a D11 reason wins). This maps each shader line to the view the
 * wire must carry, so materialLogDivergence compares like with like. */
export function applyPolicyToLog<T extends MaterialLogLine5>(
  lines: readonly T[],
  policy: ShaderPolicy,
): T[] {
  if (policy === "source") return [...lines];
  return lines.map((l) => {
    if (l.kind !== "shader" || l.builtin != null || !l.hash) return l;
    if (l.op !== "shader_create_from_code" && l.op !== "shader_set_code")
      return l;
    const out = { ...l, source: "withheld" };
    if (policy === "exclude" && (l.status ?? "ok") === "ok") {
      out.status = "unsupported";
      out.reason = "shader-excluded";
    }
    return out;
  });
}

// ---------------------------------------------------------------------------------------------
// shader-hash-parity
// ---------------------------------------------------------------------------------------------

export interface SinkTx {
  label: string;
  transactions: readonly Wire5Tx[];
}

/** Pure (`shader-hash-parity`): at every settle step, each shader the reference oracle reports
 * live (its `shader_get_code` GRP1 hash) is the wire hash of exactly one shader entry of each sink,
 * with the oracle's payload size; the oracle shader -> wire id pairing never moves over a shader's
 * lifetime (tint keeps its id across step 3's code change) and is the creation-order pairing (wire
 * ids ascending against `shader_order`); a shader the oracle reports freed is off the wire. Under
 * `params`/`exclude` the entries are `withheld` and still carry the hash the payload would have
 * (D4). */
export function evaluateShaderHashParity(
  expected: Pick<Gate55ShaderExpected, "steps" | "shader_order">,
  oracle: Pick<OracleLog, "leg" | "lines" | "problem">,
  sinks: readonly SinkTx[],
): {
  problems: string[];
  compared: number;
  pairing: Record<string, Record<string, number>>;
} {
  const problems: string[] = [];
  const pairing: Record<string, Record<string, number>> = {};
  let compared = 0;
  if (oracle.problem)
    problems.push(`${oracle.leg} materials.jsonl: ${oracle.problem}`);
  for (const sink of sinks) {
    const pair = new Map<string, number>();
    const byOrder = new Map(
      tableIdsOverRun(sink.transactions, "shaders").map(
        (id, k) => [expected.shader_order[k], id] as [string, number],
      ),
    );
    for (const s of expected.steps) {
      const where = `${sink.label} step ${s.step}`;
      const t = txAt(sink.transactions, s.settle_frame);
      const o = oracle.lines.find((l) => l.step === s.step);
      if (!t || !o) {
        problems.push(
          `${where}: ${!t ? `no transaction at frame ${s.settle_frame}` : "no oracle line"}`,
        );
        continue;
      }
      const shaders = t.state.shaders ?? [];
      for (const os of o.shaders) {
        if (os.status !== "live") {
          const id = pair.get(os.name);
          if (id !== undefined && shaders.some((x) => x.id === id))
            problems.push(
              `${where}: ${os.name} is ${os.status} in the oracle but shader ${id} is on the wire`,
            );
          continue;
        }
        const hits = shaders.filter((x) => x.hash === os.sha256);
        if (hits.length !== 1) {
          problems.push(
            `${where}: ${hits.length} wire shaders carry ${os.name}'s oracle hash ${os.sha256?.slice(0, 12)} (wire: ${shaders.map((x) => `${x.id}=${(x.hash ?? "null").slice(0, 8)}`).join(",")})`,
          );
          continue;
        }
        const hit = hits[0];
        compared++;
        if (hit.payload_bytes !== os.payload_bytes)
          problems.push(
            `${where}: ${os.name} payload_bytes ${hit.payload_bytes} on the wire, ${os.payload_bytes} in the oracle`,
          );
        const prev = pair.get(os.name);
        if (prev !== undefined && prev !== hit.id)
          problems.push(
            `${where}: ${os.name} moved from shader ${prev} to ${hit.id}`,
          );
        pair.set(os.name, hit.id);
        if (byOrder.get(os.name) !== hit.id)
          problems.push(
            `${where}: ${os.name} is shader ${hit.id}, creation order gives ${byOrder.get(os.name)}`,
          );
      }
      if (problems.length > 12) break;
    }
    pairing[sink.label] = Object.fromEntries(pair);
  }
  return { problems: problems.slice(0, 12), compared, pairing };
}

// ---------------------------------------------------------------------------------------------
// param-parity
// ---------------------------------------------------------------------------------------------

/** Wire texture id -> fixture texture name, through each texture entry's GRT1 hash (hash -> name
 * from decoding the store's payloads against expected.json `textures`). */
export function textureNamesOf(
  t: Pick<Wire5Tx, "state">,
  hashNames: ReadonlyMap<string, string>,
): Map<number, string> {
  const out = new Map<number, string>();
  for (const x of t.state.textures)
    if (x.hash && hashNames.has(x.hash))
      out.set(x.id, hashNames.get(x.hash) as string);
  return out;
}

/** A resolved wire parameter in the oracle's spelling: `bool` as true/false, `rid` as the fixture
 * texture's name; numbers as they are (float64 on the wire; float32 components widened, exactly
 * what the oracle writes). */
export function wireParamView(
  p: Pick<ResolvedParam, "type" | "value">,
  texNames: ReadonlyMap<number, string>,
): VariantView {
  if (p.type === "bool") return { type: "bool", value: p.value !== 0 };
  if (p.type === "rid") {
    const id = (p.value as { tex: number } | null)?.tex;
    return {
      type: "rid",
      value: {
        tex: id === undefined ? null : (texNames.get(id) ?? `#${id}`),
      },
    };
  }
  return { type: p.type, value: p.value };
}

/** Pure (`param-parity`): at every settle step of each sink, every live material the oracle reports
 * (wire ids ascending against `material_order`) carries each declared parameter with the oracle's
 * type and value exactly, and lacks every one the oracle reads back as nil (never set, or erased:
 * MT.gain from step 4); it carries no undeclared one; a material the oracle reports freed or absent
 * is off the wire. Each item's instance parameters likewise, except an instance parameter the
 * script never set (G55c amendment 4: the oracle reads the uniform's default, a Vector4, which no
 * call carries), which must be absent from the wire. */
export function evaluateParamParity(
  expected: Pick<
    Gate55ShaderExpected,
    "steps" | "material_order" | "creation_order"
  >,
  oracle: Pick<OracleLog, "leg" | "lines" | "problem">,
  sinks: readonly SinkTx[],
  hashNames: ReadonlyMap<string, string>,
): { problems: string[]; compared: number; exempt: number } {
  const problems: string[] = [];
  let compared = 0;
  let exempt = 0;
  if (oracle.problem)
    problems.push(`${oracle.leg} materials.jsonl: ${oracle.problem}`);
  for (const sink of sinks) {
    const matIds = new Map(
      tableIdsOverRun(sink.transactions, "materials").map(
        (id, k) => [expected.material_order[k], id] as [string, number],
      ),
    );
    const items = itemIdsByCreation(sink.transactions, expected.creation_order);
    problems.push(...items.problems.map((p) => `${sink.label}: ${p}`));
    for (const s of expected.steps) {
      const where = `${sink.label} step ${s.step}`;
      const t = txAt(sink.transactions, s.settle_frame);
      const o = oracle.lines.find((l) => l.step === s.step);
      if (!t || !o) {
        problems.push(
          `${where}: ${!t ? `no transaction at frame ${s.settle_frame}` : "no oracle line"}`,
        );
        continue;
      }
      const tex = textureNamesOf(t, hashNames);
      const wireMats = new Map((t.state.materials ?? []).map((m) => [m.id, m]));
      for (const om of o.materials) {
        const id = matIds.get(om.name);
        const m = id === undefined ? undefined : wireMats.get(id);
        if (om.status !== "live") {
          if (m)
            problems.push(
              `${where}: ${om.name} is ${om.status} in the oracle, material ${id} is on the wire`,
            );
          continue;
        }
        if (!m) {
          problems.push(
            `${where}: ${om.name} (material ${id}) not on the wire`,
          );
          continue;
        }
        const declared = new Set((om.params ?? []).map((p) => p.name));
        for (const p of m.params)
          if (!declared.has(p.name))
            problems.push(
              `${where}: ${om.name} carries undeclared parameter ${p.name}`,
            );
        for (const op of om.params ?? []) {
          const wp = m.params.find((p) => p.name === op.name);
          compared++;
          if (op.type === "nil") {
            if (wp)
              problems.push(
                `${where}: ${om.name}.${op.name} is nil in the oracle, ${JSON.stringify(wireParamView(wp, tex))} on the wire`,
              );
            continue;
          }
          const got = wp ? wireParamView(wp, tex) : null;
          if (!got || got.type !== op.type || !jsonEqual(got.value, op.value))
            problems.push(
              `${where}: ${om.name}.${op.name} wire ${JSON.stringify(got)} != oracle ${JSON.stringify({ type: op.type, value: op.value })}`,
            );
        }
      }
      const model = new Map(s.oracle.items.map((i) => [i.name, i]));
      for (const oi of o.items) {
        const id = items.ids.get(oi.name);
        const item = t.state.items.find((i) => i.id === id);
        if (!item) {
          problems.push(`${where}: item ${oi.name} not on the wire`);
          continue;
        }
        for (const op of oi.instance_params) {
          const wp = (item.instance_params ?? []).find(
            (p) => p.name === op.name,
          );
          const unset =
            model.get(oi.name)?.instance_params.find((p) => p.name === op.name)
              ?.type === "vector4";
          if (unset && !wp) {
            exempt++;
            continue;
          }
          compared++;
          const got = wp ? wireParamView(wp, tex) : null;
          if (!got || got.type !== op.type || !jsonEqual(got.value, op.value))
            problems.push(
              `${where}: ${oi.name} instance ${op.name} wire ${JSON.stringify(got)} != oracle ${JSON.stringify({ type: op.type, value: op.value })}${unset ? " (never set by the script: expected absent)" : ""}`,
            );
        }
      }
      if (problems.length > 12) break;
    }
  }
  return { problems: problems.slice(0, 12), compared, exempt };
}

/** GRT1 hash -> fixture texture name: every texture payload in the store whose pixels equal one of
 * expected.json `textures` (rgba8 hex). */
export async function textureHashNames(
  storeDir: string,
  textures: Gate55ShaderExpected["textures"],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  let files: string[] = [];
  try {
    files = await readdir(join(storeDir, "sha256"));
  } catch {
    return out;
  }
  for (const f of files) {
    if (!f.endsWith(".grt")) continue;
    try {
      const p = decodeTexturePayload(
        new Uint8Array(await readFile(join(storeDir, "sha256", f))),
      );
      const hex = Buffer.from(p.data).toString("hex");
      for (const [name, t] of Object.entries(textures))
        if (t.width === p.width && t.height === p.height && t.rgba8_hex === hex)
          out.set(f.replace(/\.grt$/, ""), name);
    } catch {
      // not a decodable texture: no name
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// shader-policy-respected
// ---------------------------------------------------------------------------------------------

/** Every regular file under `dir`, recursively (absolute paths). */
export async function filesUnder(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries: import("node:fs").Dirent[] = [];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await filesUnder(p)));
    else if (e.isFile()) out.push(p);
  }
  return out;
}

const GRP1_MAGIC = Buffer.from([
  0x47, 0x52, 0x50, 0x31, 0x0d, 0x0a, 0x1a, 0x0a,
]);

/** Pure over file contents: which needles (GRP1 magic, `shader_type`, every fixture shader's code
 * as the server received it) each file contains. */
export function codeBytesIn(
  files: readonly { path: string; bytes: Uint8Array }[],
  codes: readonly string[],
): string[] {
  const needles: { label: string; bytes: Buffer }[] = [
    { label: "GRP1 magic", bytes: GRP1_MAGIC },
    { label: "`shader_type`", bytes: Buffer.from("shader_type", "utf8") },
    ...codes.map((c, k) => ({
      label: `fixture code #${k} (${c.length} chars)`,
      bytes: Buffer.from(c, "utf8"),
    })),
  ];
  const found: string[] = [];
  for (const f of files) {
    const buf = Buffer.from(f.bytes.buffer, f.bytes.byteOffset, f.bytes.length);
    for (const n of needles)
      if (n.bytes.length > 0 && buf.indexOf(n.bytes) >= 0)
        found.push(`${f.path}: ${n.label}`);
  }
  return found;
}

/** Pure (`shader-policy-respected`, D4, Q7): the session declares the policy; every non-builtin
 * shader entry with code on both sinks is `withheld` (under `params` `ok`; under `exclude`
 * `unsupported` / `shader-excluded`) with a hash; the store holds no GRP1 file and index.jsonl no
 * shader-code line; no resource record is a shader payload; and no file the capture wrote (both
 * recordings, the store, evidence/ with the hook log, stdout) contains the GRP1 magic, the token
 * `shader_type` or any fixture shader's code. `control` (capture-shader under `source`) must
 * contain code, which proves the scan can see it. */
export function evaluatePolicyRespected(
  input: {
    leg: string;
    policy: ShaderPolicy;
    wires: readonly Wire5[];
    storeFiles: readonly string[];
    storeIndex: string | undefined;
    found: readonly string[];
    scanned: number;
  },
  control: { found: readonly string[] },
): { problems: string[]; shaders: number } {
  const problems: string[] = [];
  let shaders = 0;
  for (const w of input.wires) {
    if (w.error) problems.push(`${w.path}: ${w.error}`);
    const declared = w.session?.materials?.shader_policy;
    if (declared !== input.policy)
      problems.push(
        `${w.path}: session materials.shader_policy ${JSON.stringify(declared)}, expected ${input.policy}`,
      );
    const grp = new Set<string>();
    for (const t of w.transactions)
      for (const s of t.state.shaders ?? []) {
        if (s.builtin !== null || s.source === null) continue;
        shaders++;
        if (s.hash) grp.add(s.hash);
        const want =
          input.policy === "params"
            ? s.status === "ok" && s.reason === null
            : s.status === "unsupported" &&
              (s.reason === "shader-excluded" ||
                (s.reason ?? "").startsWith("shader-"));
        if (s.source !== "withheld" || !s.hash || !want) {
          problems.push(
            `${w.path} frame ${t.frame}: shader ${s.id} is ${s.status}/${s.reason} source ${s.source} hash ${s.hash ? "set" : "null"}, expected withheld ${input.policy === "params" ? "ok" : "unsupported/shader-excluded"} with a hash`,
          );
          break;
        }
      }
    for (const r of w.resources)
      if (grp.has(r.hash))
        problems.push(
          `${w.path}: resource record ${r.hash.slice(0, 12)} is a shader payload`,
        );
  }
  const grpFiles = input.storeFiles.filter((f) => f.endsWith(".grp"));
  if (grpFiles.length > 0)
    problems.push(`store holds ${grpFiles.length} GRP1 files`);
  if ((input.storeIndex ?? "").includes('"shader-code"'))
    problems.push("store index.jsonl has a shader-code line");
  problems.push(...input.found.slice(0, 4).map((f) => `code bytes: ${f}`));
  if (input.scanned === 0) problems.push("no file scanned");
  if (control.found.length === 0)
    problems.push(
      "the control scan of capture-shader (policy source) found no code: the scan is blind",
    );
  return { problems: problems.slice(0, 10), shaders };
}

async function scanCaptureDir(
  dir: string,
  codes: readonly string[],
): Promise<{ found: string[]; scanned: number; storeFiles: string[] }> {
  const paths = [
    join(dir, RECORDING_NAME),
    join(dir, PATCH_RECORDING_NAME),
    join(dir, "stdout.log"),
    ...(await filesUnder(join(dir, "evidence"))),
    ...(await filesUnder(join(dir, "store"))),
  ];
  const files: { path: string; bytes: Uint8Array }[] = [];
  for (const p of paths)
    if (await fileExists(p))
      files.push({ path: p, bytes: new Uint8Array(await readFile(p)) });
  return {
    found: codeBytesIn(files, codes),
    scanned: files.length,
    storeFiles: await filesUnder(join(dir, "store")),
  };
}

/** Every code in a GRP1 library directory (<dir>/sha256/<hash>.grp), decoded. */
export async function libraryCodes(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const f of await filesUnder(join(dir, "sha256")))
    if (f.endsWith(".grp"))
      try {
        out.push(decodeShaderPayload(new Uint8Array(await readFile(f))).code);
      } catch {
        // an undecodable library file is the receiver's problem, not a needle
      }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Typed receivers
// ---------------------------------------------------------------------------------------------

/** Pure (`shader-receiver-typed`): honest receivers record no typed refusal and skip nothing;
 * receiver-refused records exactly canvas_item_set_material / unsupported-material on the five
 * refused items (wire ids by creation order) and nothing else; receiver-params-nolib records
 * exactly one shader_set_code / shader-withheld per (shader id, hash) its recording makes resident
 * (every withheld hash a named material reaches), and receiver-params-lib none, fetching no shader
 * payload and setting exactly that many codes from its library; no receiver stdout (sabotages
 * included) carries a shader compile error or a script error. */
export function evaluateReceiverTyped(
  legs: readonly {
    leg: string;
    kind: "honest" | "refused" | "nolib" | "lib" | "sabotage";
    applied: AppliedJson55d | undefined;
    stdout: string | undefined;
    refusedItems?: readonly number[];
    withheld?: readonly string[];
  }[],
): { problems: string[]; table: Record<string, string> } {
  const problems: string[] = [];
  const table: Record<string, string> = {};
  const bad =
    /SHADER ERROR|Shader compilation failed|SCRIPT ERROR|SCRIPT WARNING|Parse Error|Failed to load script/;
  for (const l of legs) {
    if (l.stdout === undefined) problems.push(`${l.leg}: stdout.log missing`);
    else {
      const line = l.stdout.split("\n").find((x) => bad.test(x));
      if (line) problems.push(`${l.leg}: ${line.trim()}`);
    }
    if (l.kind === "sabotage") continue;
    if (!l.applied) {
      problems.push(`${l.leg}: applied.json missing`);
      continue;
    }
    const typed = (l.applied.unsupported ?? []) as {
      item?: number | null;
      name?: string;
      reason?: string;
      shader?: number;
    }[];
    const sums: Record<string, number> = {};
    for (const t of l.applied.transactions ?? [])
      for (const [k, v] of Object.entries(t.resources ?? {}))
        if (typeof v === "number") sums[k] = (sums[k] ?? 0) + v;
    table[l.leg] =
      `${typed.length} typed; shader_code_sets ${sums.shader_code_sets ?? 0}, fetches ${sums.shader_payload_fetches ?? 0}`;
    if (l.kind === "honest" || l.kind === "lib") {
      if (typed.length > 0)
        problems.push(
          `${l.leg}: applied.json unsupported ${typed
            .slice(0, 3)
            .map((u) => `${u.name}/${u.reason}`)
            .join(", ")}`,
        );
      const skipped = Object.entries(sums).filter(
        ([k, v]) => k.startsWith("skipped") && v > 0,
      );
      if (skipped.length > 0)
        problems.push(
          `${l.leg}: ${skipped.map(([k, v]) => `${k} ${v}`).join(", ")}`,
        );
    }
    if (l.kind === "lib") {
      if ((sums.shader_payload_fetches ?? 0) !== 0)
        problems.push(
          `${l.leg}: fetched ${sums.shader_payload_fetches} shader payloads (code comes from the library)`,
        );
      if ((sums.shader_code_sets ?? 0) !== (l.withheld ?? []).length)
        problems.push(
          `${l.leg}: shader_code_sets ${sums.shader_code_sets ?? 0}, the recording makes ${(l.withheld ?? []).length} withheld (id, hash) pairs resident`,
        );
    }
    if (l.kind === "refused") {
      const got = typed
        .map((u) => `${u.name}/${u.reason}/${u.item}`)
        .sort()
        .join(",");
      const want = [...(l.refusedItems ?? [])]
        .map((id) => `canvas_item_set_material/unsupported-material/${id}`)
        .sort()
        .join(",");
      if (got !== want) problems.push(`${l.leg}: typed {${got}} != {${want}}`);
    }
    if (l.kind === "nolib") {
      const got = typed
        .map((u) => `${u.name}/${u.reason}`)
        .filter((x) => x !== "shader_set_code/shader-withheld");
      if (got.length > 0)
        problems.push(`${l.leg}: other typed entries ${got.join(", ")}`);
      const n = typed.length;
      if (n !== (l.withheld ?? []).length)
        problems.push(
          `${l.leg}: ${n} shader-withheld entries, the recording makes ${(l.withheld ?? []).length} withheld (id, hash) pairs resident`,
        );
      if ((sums.shader_code_sets ?? 0) !== 0)
        problems.push(
          `${l.leg}: shader_code_sets ${sums.shader_code_sets} with no library`,
        );
    }
  }
  return { problems: problems.slice(0, 12), table };
}

/** The (shader id, hash) pairs a receiver makes resident: every shader version an item's effective
 * material reaches in some transaction (by own material or use_parent_material), counted once. */
export function residentShaderVersions(
  transactions: readonly Wire5Tx[],
): string[] {
  const out = new Set<string>();
  for (const t of transactions) {
    const items = new Map(t.state.items.map((i) => [i.id, i]));
    const materials = new Map((t.state.materials ?? []).map((m) => [m.id, m]));
    const shaders = new Map((t.state.shaders ?? []).map((s) => [s.id, s]));
    for (const item of t.state.items) {
      let cur = item;
      for (
        let g = 0;
        g < 64 && cur.use_parent_material && cur.parent?.kind === "item";
        g++
      ) {
        const p = items.get(cur.parent.id);
        if (!p) break;
        cur = p;
      }
      const m = cur.material == null ? undefined : materials.get(cur.material);
      if (m?.status !== "ok" || m.shader == null) continue;
      const s = shaders.get(m.shader);
      if (s && s.status === "ok" && s.hash) out.add(`${s.id}:${s.hash}`);
    }
  }
  return [...out].sort();
}

// ---------------------------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------------------------

export interface G55eLegEntry {
  group: string;
  expected_class: string | null;
  result_class: string | null;
  reasons: string[];
  harmless_ties?: string[];
  exit_code: number | null;
  artifacts: string[];
}

export interface Gate55eResult {
  checks: Gate5Check[];
  legs: Record<string, G55eLegEntry>;
  checkpoints: Gate5Checkpoint[];
  materials: Record<string, unknown>;
}

/** The step-window helpers of lib/gate55d-checks.ts read only `variants[variant].steps[]`'s step,
 * applied and settle frames: this hands them the shader fixture's steps. */
function stepsAsCim(e: Gate55ShaderExpected): Gate55CimExpected {
  return {
    variants: { base: { steps: e.steps } },
  } as unknown as Gate55CimExpected;
}

async function stdoutOf(dir: string): Promise<string | undefined> {
  return readTextOrUndefined(join(dir, "stdout.log"));
}

function receiverShotPaths(
  cps: Gate5Checkpoint[],
  dir: string,
  seqs: ReadonlyMap<number, number>,
): Gate5Checkpoint[] {
  return cps.map((c) => ({
    ...c,
    shot: join(dir, "shots", `seq-${seqs.get(c.step) ?? "missing"}.png`),
  }));
}

export async function runGate55e(
  outDir: string,
  e: Gate55eExpected,
): Promise<Gate55eResult> {
  const checks: Gate5Check[] = [];
  const legs: Record<string, G55eLegEntry> = {};
  const checkpoints: Gate5Checkpoint[] = [];
  const at = (rel: string) => join(outDir, rel);
  const base = e as Gate55ShaderExpected;
  const refused = refusedView(e);
  const e5 = asGate5(base);
  const r5 = asGate5(refused);
  const rasters = rastersOf(e5);
  const refusedRasters = rastersOf(r5);

  // Wires and logs.
  const shaderFull = await loadWire5(at(`shader/capture/${RECORDING_NAME}`));
  const shaderPatch = await loadWire5(
    at(`shader/capture/${PATCH_RECORDING_NAME}`),
  );
  const inlineWire = await loadWire5(
    at(`shader/capture-inline/${RECORDING_NAME}`),
  );
  const refusedFull = await loadWire5(
    at(`shader-refused/capture/${RECORDING_NAME}`),
  );
  const refusedPatch = await loadWire5(
    at(`shader-refused/capture/${PATCH_RECORDING_NAME}`),
  );
  const paramsFull = await loadWire5(
    at(`shader-policy-params/capture/${RECORDING_NAME}`),
  );
  const paramsPatch = await loadWire5(
    at(`shader-policy-params/capture/${PATCH_RECORDING_NAME}`),
  );
  const excludeFull = await loadWire5(
    at(`shader-policy-exclude/capture/${RECORDING_NAME}`),
  );
  const excludePatch = await loadWire5(
    at(`shader-policy-exclude/capture/${PATCH_RECORDING_NAME}`),
  );
  const logs = {
    shader: await loadResourceLog(at("shader/capture")),
    inline: await loadResourceLog(at("shader/capture-inline")),
    refused: await loadResourceLog(at("shader-refused/capture")),
    params: await loadResourceLog(at("shader-policy-params/capture")),
    exclude: await loadResourceLog(at("shader-policy-exclude/capture")),
  };
  const oracle = await loadOracle(
    at(G55E_DIR.shader),
    "reference",
    "reference-shader",
  );
  const refusedOracle = await loadOracle(
    at(G55E_DIR.refused),
    "reference",
    "reference-refused",
  );
  const hashNames = await textureHashNames(
    at("shader/capture/store"),
    e.textures,
  );

  // The new captures.
  const captureEvals = new Map<string, Gate3CaptureEvaluation>();
  for (const c of G55E_CAPTURES) {
    const ev = await evaluateCapture(at(c.dir), {
      legDir: c.legDir,
      expectedClass: c.expect,
    });
    captureEvals.set(c.leg, ev);
  }
  const tables = (w: Wire5): ShaderTableView[] =>
    w.transactions.map((t) => ({
      frame: t.frame,
      shaders: t.state.shaders ?? [],
    }));
  const nonMarker = base.creation_order.filter((n) => n !== "Marker");
  const excludedScan = Object.fromEntries(
    Object.entries(base.shader_scan).map(([k, v]) => [
      k,
      { ...v, reason: v.reason ?? "shader-excluded" },
    ]),
  );
  const captureTyped: Record<string, string[]> = {
    "capture-shader-inline": evaluateShaderCapture5(
      base,
      [],
      captureEvals.get("capture-shader-inline") as Gate3CaptureEvaluation,
      tables(inlineWire),
    ).problems,
    "capture-policy-params": evaluateShaderCapture5(
      base,
      [],
      captureEvals.get("capture-policy-params") as Gate3CaptureEvaluation,
      tables(paramsFull),
    ).problems,
    "capture-policy-exclude": evaluateShaderCapture5(
      { ...base, shader_scan: excludedScan },
      nonMarker,
      captureEvals.get("capture-policy-exclude") as Gate3CaptureEvaluation,
      tables(excludeFull),
    ).problems,
  };

  // shader-material-commands: every honest capture against its own hook log (policy applied).
  const divergence = {
    shader: [
      materialLogDivergence(logs.shader.lines, shaderFull.transactions),
      materialLogDivergence(logs.shader.lines, shaderPatch.transactions),
    ],
    inline: [materialLogDivergence(logs.inline.lines, inlineWire.transactions)],
    refused: [
      materialLogDivergence(logs.refused.lines, refusedFull.transactions),
      materialLogDivergence(logs.refused.lines, refusedPatch.transactions),
    ],
    params: [
      materialLogDivergence(
        applyPolicyToLog(logs.params.lines, "params"),
        paramsFull.transactions,
      ),
      materialLogDivergence(
        applyPolicyToLog(logs.params.lines, "params"),
        paramsPatch.transactions,
      ),
    ],
    exclude: [
      materialLogDivergence(
        applyPolicyToLog(logs.exclude.lines, "exclude"),
        excludeFull.transactions,
      ),
      materialLogDivergence(
        applyPolicyToLog(logs.exclude.lines, "exclude"),
        excludePatch.transactions,
      ),
    ],
  };
  const divProblems = (k: keyof typeof divergence) =>
    divergence[k].flatMap((d) => d.problems);
  const wireErrors = [
    shaderFull,
    shaderPatch,
    inlineWire,
    refusedFull,
    refusedPatch,
    paramsFull,
    paramsPatch,
    excludeFull,
    excludePatch,
  ]
    .filter((w) => w.error !== null)
    .map((w) => `${w.path}: ${w.error}`);
  const logErrors = Object.entries(logs).flatMap(([k, l]) =>
    l.problem ? [`${k} resources.jsonl: ${l.problem}`] : [],
  );
  checks.push(
    check(
      "shader-material-commands",
      "at every transaction of both sinks of capture-shader, capture-refused, capture-policy-params and capture-policy-exclude, and of capture-shader-inline, the resolved shader and material tables equal that capture's hook log at the end of the frame (ids, versions with D5, status, reason, mode, source, GRP1 hash and size, builtin, uses, default textures; material shader and parameter names, types and counts), with the policy applied to the log's view (D4: under params and exclude a non-builtin shader with code is withheld, under exclude an ok one unsupported/shader-excluded)",
      [
        ...wireErrors,
        ...logErrors,
        ...(
          ["shader", "inline", "refused", "params", "exclude"] as const
        ).flatMap((k) => divProblems(k).map((p) => `${k}: ${p}`)),
      ].slice(0, 10),
      `${Object.values(divergence)
        .flat()
        .reduce((n, d) => n + d.compared, 0)} table entries equal the hook log`,
      Object.values(logs).map((l) => l.path),
    ),
  );

  // Capture leg classes.
  for (const c of G55E_CAPTURES) {
    const ev = captureEvals.get(c.leg) as Gate3CaptureEvaluation;
    const key = c.leg === "capture-shader-inline" ? "inline" : c.policy;
    const div = divProblems(key as keyof typeof divergence);
    const problems = [...captureTyped[c.leg]];
    if (div.length > 0) problems.unshift(`material-log-divergence: ${div[0]}`);
    if (
      c.leg === "capture-shader-inline" &&
      inlineWire.session?.resources?.delivery !== "inline"
    )
      problems.push(`delivery ${inlineWire.session?.resources?.delivery}`);
    checks.push(
      check(
        `leg-class-${c.leg}`,
        c.expect === "success"
          ? `the ${c.leg} leg classifies as success on render-stream/5 (policy ${c.policy}): armed, stream closed, both sinks valid and equivalent, no unsupported entry, every shader entry ok, no material-log-divergence`
          : `the ${c.leg} leg classifies as unsupported: its only entries are canvas_item_set_material / unsupported-material on exactly the eight items with a ShaderMaterial at every settle frame, and every fixture shader is unsupported / shader-excluded (D4)`,
        problems.slice(0, 8),
        `${ev.result_class}`,
        ev.artifacts,
      ),
    );
    legs[c.leg] = {
      group: "g55e",
      expected_class: c.expect,
      result_class: div.length > 0 ? "capture-failure" : ev.result_class,
      reasons: [
        ...(div.length > 0
          ? [`capture-failure: material-log-divergence: ${div[0]}`]
          : []),
        ...ev.reasons,
      ],
      harmless_ties: ev.harmless_ties,
      exit_code: ev.exit_code,
      artifacts: ev.artifacts,
    };
  }

  // shader-hash-parity and param-parity: the wire against the reference oracle.
  const honestSinks: SinkTx[] = [
    { label: "capture-shader/full", transactions: shaderFull.transactions },
    { label: "capture-shader/patch", transactions: shaderPatch.transactions },
    { label: "capture-shader-inline", transactions: inlineWire.transactions },
    {
      label: "capture-policy-params/full",
      transactions: paramsFull.transactions,
    },
    {
      label: "capture-policy-params/patch",
      transactions: paramsPatch.transactions,
    },
    {
      label: "capture-policy-exclude/full",
      transactions: excludeFull.transactions,
    },
  ];
  const refusedSinks: SinkTx[] = [
    { label: "capture-refused/full", transactions: refusedFull.transactions },
    { label: "capture-refused/patch", transactions: refusedPatch.transactions },
  ];
  const hashParity = evaluateShaderHashParity(base, oracle, honestSinks);
  const refusedHashParity = evaluateShaderHashParity(
    refused,
    refusedOracle,
    refusedSinks,
  );
  const paramParity = evaluateParamParity(base, oracle, honestSinks, hashNames);
  const refusedParamParity = evaluateParamParity(
    refused,
    refusedOracle,
    refusedSinks,
    hashNames,
  );
  if (hashNames.size !== Object.keys(e.textures).length)
    paramParity.problems.unshift(
      `${hashNames.size} store textures matched expected.json textures (${[...hashNames.values()].join(",")}), expected ${Object.keys(e.textures).length}`,
    );
  checks.push(
    check(
      "shader-hash-parity",
      "at every settle step each shader the reference oracle reads back live (GRP1 hash of shader_get_code) is the hash of exactly one wire shader entry, with the oracle's payload size, on both sinks of capture-shader, capture-shader-inline, both sinks of capture-policy-params and capture-policy-exclude's full sink (withheld entries keep the hash, D4), and on capture-refused against reference-refused's oracle; the oracle-shader -> wire-id pairing never moves (tint keeps its id across step 3's code change) and is the creation-order pairing; freed shaders are off the wire",
      [...hashParity.problems, ...refusedHashParity.problems].slice(0, 10),
      `${hashParity.compared + refusedHashParity.compared} shader-steps pair one to one; pairing ${JSON.stringify(hashParity.pairing["capture-shader/full"] ?? {})}`,
      [
        oracle.path,
        refusedOracle.path,
        shaderFull.path,
        paramsFull.path,
        excludeFull.path,
      ],
    ),
    check(
      "param-parity",
      "at every settle step each live material's declared parameters on the wire have the oracle's (material_get_param on the reference) Variant type and value exactly -- float64 floats and ints, float32 components widened, bool, vector2i, the packed float32 array, colours, the texture parameter as the fixture texture the wire's texture id names (by its GRT1 payload's pixels) -- and a parameter the oracle reads as nil is absent (unset, or erased at step 4); no undeclared parameter; each item's instance parameters equal the oracle's (canvas_item_get_instance_shader_parameter), except I2's before step 2, which the script never set (absent on the wire; the oracle reads the uniform's Vector4 default); same sinks as shader-hash-parity",
      [...paramParity.problems, ...refusedParamParity.problems].slice(0, 10),
      `${paramParity.compared + refusedParamParity.compared} parameter values equal the oracle's (${paramParity.exempt + refusedParamParity.exempt} unset instance parameters exempt)`,
      [oracle.path, refusedOracle.path],
    ),
  );

  // shader-policy-respected.
  const codes = await libraryCodes(at("shader-policy-params/library"));
  const control = await scanCaptureDir(at("shader/capture"), codes);
  const policyRows: string[] = [];
  const policyProblems: string[] = [];
  for (const [leg, rel, policy, wires] of [
    [
      "capture-policy-params",
      "shader-policy-params/capture",
      "params",
      [paramsFull, paramsPatch],
    ],
    [
      "capture-policy-exclude",
      "shader-policy-exclude/capture",
      "exclude",
      [excludeFull, excludePatch],
    ],
  ] as const) {
    const scan = await scanCaptureDir(at(rel), codes);
    const r = evaluatePolicyRespected(
      {
        leg,
        policy,
        wires,
        storeFiles: scan.storeFiles,
        storeIndex: await readTextOrUndefined(at(`${rel}/store/index.jsonl`)),
        found: scan.found,
        scanned: scan.scanned,
      },
      control,
    );
    policyProblems.push(...r.problems.map((p) => `${leg}: ${p}`));
    policyRows.push(
      `${leg}: ${r.shaders} withheld shader-entries, ${scan.scanned} files scanned clean`,
    );
  }
  if (codes.length === 0)
    policyProblems.push(
      "the oracle library has no decodable code (no needles)",
    );
  checks.push(
    check(
      "shader-policy-respected",
      "under GRC_SHADER_POLICY=params and =exclude the session declares the policy, every fixture shader entry on both sinks is withheld with its hash (ok under params, unsupported/shader-excluded under exclude), the store holds no GRP1 file and no shader-code index line, no resource record is a shader payload, and no file the capture wrote (both recordings, store, evidence/ including the hook log, stdout) contains the GRP1 magic, `shader_type` or any fixture shader's code (needles: the oracle library's codes); the same scan finds code in capture-shader (policy source)",
      policyProblems.slice(0, 10),
      `${policyRows.join("; ")}; control: ${control.found.length} hits in capture-shader`,
      [at("shader-policy-params/capture"), at("shader-policy-exclude/capture")],
    ),
  );

  // shader-store (capture-shader and capture-inline, G55d's evaluator).
  const store = await evaluateShaderStore(
    at("shader/capture/store"),
    [shaderFull.transactions, shaderPatch.transactions],
    inlineWire,
    await fileExists(at("shader/capture-inline/store/index.jsonl")),
  );
  checks.push(
    check(
      "shader-store",
      "every payload shader hash of either capture-shader sink is <store>/sha256/<hash>.grp, hashing to its name, a valid GRP1 payload of its entry's size, with an index.jsonl line of type shader-code; capture-shader-inline has no store and sends every shader hash as a resource record before the first transaction naming it",
      store.problems,
      `${store.payloads} GRP1 payloads stored (${store.bytes} bytes)`,
      [at("shader/capture/store/index.jsonl"), inlineWire.path],
    ),
  );

  // Receivers.
  const referenceShots = await loadShots5(at(G55E_DIR.shader), "reference", e5);
  const refusedShots = await loadShots5(at(G55E_DIR.refused), "reference", r5);
  const vsRef: string[] = [];
  const imageProblems: string[] = [];
  const budgets: Record<string, RegionBudget5[]> = {};
  const typedInputs: Parameters<typeof evaluateReceiverTyped>[0][number][] = [];
  const receiverTotals: { leg: string; applied: AppliedJson55d | undefined }[] =
    [];
  const refusedItemIds = (() => {
    const ids = itemIdsByCreation(
      refusedFull.transactions,
      refused.creation_order,
    );
    return Object.keys(e.variants.refused.refused_items).map(
      (n) => ids.ids.get(n) ?? -1,
    );
  })();
  const paramsWithheld = residentShaderVersions(paramsFull.transactions);
  const captureOf = async (rel: string) => ({
    captureResult: await readJson<CaptureResultJson>(
      at(`${rel}/evidence/result.json`),
    ),
  });
  for (const r of G55E_RECEIVERS) {
    const isRefused = r.variant === "refused";
    const ex = isRefused ? refused : base;
    const ex5 = isRefused ? r5 : e5;
    const refDir = at(
      `${isRefused ? G55E_DIR.refused : G55E_DIR.shader}/reference`,
    );
    const refShots = isRefused ? refusedShots : referenceShots;
    const rdir = at(r.dir);
    const recording: RecordingSummary = await loadRecording(
      at(`${r.capture}/${r.sink}`),
    );
    const seqs = settleSeqs(ex5, recording);
    const shots = await loadReceiverShots5(rdir, ex5, seqs);
    const cps = computeGate5Checkpoints(
      ex5,
      refDir,
      refShots,
      rdir,
      shots,
      seqs,
    );
    const applied = await readJson<AppliedJson55d>(join(rdir, "applied.json"));
    const stdout = await stdoutOf(rdir);
    const div =
      r.capture === "shader/capture"
        ? divProblems("shader")
        : r.capture === "shader/capture-inline"
          ? divProblems("inline")
          : r.capture === "shader-refused/capture"
            ? divProblems("refused")
            : divProblems("params");
    const cls = classifyMaterialLeg(
      classifyLeg({
        captureResult: (await captureOf(r.capture)).captureResult,
        recording,
        receiver: {
          applied,
          requestedShotSeqs: await requestedSeqs(rdir, seqs),
          shotFiles: await shotSeqsPresent5(rdir),
        },
        checkpoints: cps as Checkpoint[],
      }),
      div,
      stdout,
    );
    const view = r.view ? e.receiver_views[r.view] : undefined;
    const exp: Gate5LegExpectation = r.view
      ? {
          class: "unsupported",
          regions:
            (
              e.predictions[r.view] as
                | { regions?: Record<string, number[]> }
                | undefined
            )?.regions ?? {},
        }
      : { class: "success" };
    const lc = evaluateLegClass5(cls, cps as Checkpoint[], exp);
    if (r.view && (!view || !e.predictions[r.view]))
      lc.problems.unshift(
        `expected.json lacks receiver_views/predictions ${r.view}`,
      );
    checks.push(
      check(
        `leg-class-${r.leg}`,
        r.view
          ? `the ${r.leg} leg (rendered receiver on ${r.capture}/${r.sink}) classifies as unsupported, with mismatching regions against the reference exactly expected.json predictions[${r.view}] (${JSON.stringify(exp.regions)}): it draws ${view?.without_material.join(",")} with no material`
          : `the ${r.leg} leg (rendered receiver on ${r.capture}/${r.sink}) classifies as success: no material-log-divergence, no shader compile error, applied every seq, every region of every settle shot equal to the reference`,
        lc.problems,
        `${cls.result_class}${
          Object.keys(lc.table).length > 0
            ? `; mismatching per step ${Object.entries(lc.table)
                .map(([k, v]) => `${k}:${v}`)
                .join(" ")}`
            : ""
        }`,
        [join(rdir, "applied.json"), join(rdir, "stdout.log")],
      ),
    );
    legs[r.leg] = {
      group: "g55e",
      expected_class: exp.class,
      result_class: cls.result_class,
      reasons: cls.reasons,
      harmless_ties: cls.harmless_ties,
      exit_code: await readExitCode(rdir),
      artifacts: [join(rdir, "applied.json"), join(rdir, "shots")],
    };
    // Pixels: an honest receiver equals the reference everywhere and the model's raster; a typed
    // one equals its view's raster everywhere (and the reference outside its predicted regions,
    // which leg-class proves region by region).
    const imgExpected = view ? asGate5(viewExpected(ex, view)) : ex5;
    const imgRasters = view
      ? rastersOf(imgExpected)
      : isRefused
        ? refusedRasters
        : rasters;
    if (!view) {
      const cmp = compareLegs5(ex5, refShots, shots, rasters, [
        isRefused ? "reference-refused" : "reference-shader",
        r.leg,
      ]);
      vsRef.push(...cmp.problems.map((p) => `${r.leg}: ${p}`));
      budgets[r.leg] = cmp.budgets.filter((b) => b.mismatched_pixels > 0);
    }
    const image = evaluateExpectedImage5(imgExpected, r.leg, shots, imgRasters);
    imageProblems.push(...image.problems);
    checkpoints.push(...receiverShotPaths(image.checkpoints, rdir, seqs));
    typedInputs.push({
      leg: r.leg,
      kind: isRefused
        ? "refused"
        : r.leg === "receiver-params-nolib"
          ? "nolib"
          : r.leg === "receiver-params-lib"
            ? "lib"
            : "honest",
      applied,
      stdout,
      refusedItems: refusedItemIds,
      withheld: paramsWithheld,
    });
    receiverTotals.push({ leg: r.leg, applied });
  }
  const honestLegs = G55E_RECEIVERS.filter((r) => !r.view).map((r) => r.leg);
  checks.push(
    check(
      "shader-receiver-vs-reference",
      `${honestLegs.join(", ")}: every pixel of every settle shot equals reference-shader's, raw per channel with alpha, budget 0 as the reference repeat measures (D13); receiver-refused and receiver-params-nolib equal the reference in every region but their predicted ones (leg-class) and their receiver view's raster on every decided pixel (shader-expected-image-receiver)`,
      vsRef.slice(0, 10),
      `${honestLegs.length * e5.steps.length} honest receiver shots identical to the reference`,
      G55E_RECEIVERS.map((r) => at(`${r.dir}/shots`)),
    ),
    check(
      "shader-expected-image-receiver",
      "every honest receiver shot equals make_expected.py's raster of its step on every decided pixel (each region the Python twin of its fragment() at that step's parameters, exact, D13); receiver-refused's equals the refused raster with TM, SC, SD, GU (and SP) drawn with no material, receiver-params-nolib's the raster with every item drawn with no material (expected.json receiver_views)",
      imageProblems.slice(0, 10),
      `${G55E_RECEIVERS.length * e5.steps.length} receiver shots match their raster`,
      G55E_RECEIVERS.map((r) => at(`${r.dir}/shots`)),
    ),
  );
  const dumps = new Map<number, unknown>();
  for (const s of e5.steps) {
    const t = txAt(shaderPatch.transactions, s.settle_frame);
    if (!t) continue;
    const dump = await readJson<unknown>(
      at(`shader/receiver-patch/state/seq-${t.seq}.json`),
    );
    if (dump !== undefined) dumps.set(t.seq, dump);
  }
  const dumpEval = evaluateStateDumps(
    stepsAsCim(base),
    "base",
    shaderPatch.transactions,
    dumps,
  );
  checks.push(
    check(
      "shader-receiver-state-dumps",
      "receiver-shader-patch's state dumps at the settle seqs equal the patch recording's resolved /5 state (shader and material tables with every parameter value, items' material and instance_params, canvas modulate)",
      dumpEval.problems,
      `${dumpEval.compared} state dumps equal`,
      [at("shader/receiver-patch/state")],
    ),
  );

  // Sabotages.
  const sabotageRegions: Record<string, Record<string, string>> = {};
  for (const sab of G55E_SABOTAGES) {
    const rdir = at(sab.dir);
    const recording = await loadRecording(
      at(`${sab.capture}/${RECORDING_NAME}`),
    );
    const seqs = settleSeqs(e5, recording);
    const shots = await loadReceiverShots5(rdir, e5, seqs);
    const cps = computeGate5Checkpoints(
      e5,
      at("shader/reference"),
      referenceShots,
      rdir,
      shots,
      seqs,
    );
    const applied = await readJson<AppliedJson55d>(join(rdir, "applied.json"));
    const stdout = await stdoutOf(rdir);
    const cls = classifyMaterialLeg(
      classifyLeg({
        captureResult: (await captureOf(sab.capture)).captureResult,
        recording,
        receiver: {
          applied,
          requestedShotSeqs: await requestedSeqs(rdir, seqs),
          shotFiles: await shotSeqsPresent5(rdir),
        },
        checkpoints: cps as Checkpoint[],
      }),
      [],
      stdout,
    );
    const pred = e.predictions[sab.leg] as
      | { regions?: Record<string, number[]> }
      | undefined;
    const exp: Gate5LegExpectation = {
      class: "pixel-mismatch",
      regions: pred?.regions ?? {},
    };
    const r = evaluateLegClass5(cls, cps as Checkpoint[], exp);
    if (!pred) r.problems.unshift(`expected.json has no prediction ${sab.leg}`);
    sabotageRegions[sab.leg] = r.table;
    const artifacts = [
      at(`${sab.capture}/${RECORDING_NAME}`),
      join(rdir, "applied.json"),
    ];
    checks.push(
      check(
        `leg-class-${sab.leg}`,
        `the ${sab.leg} leg classifies as pixel-mismatch with mismatching regions exactly expected.json predictions[${sab.leg}] (${JSON.stringify(exp.regions)}), shots aligned by requested sequence`,
        r.problems,
        `${cls.result_class}; mismatching regions per step ${Object.entries(
          r.table,
        )
          .map(([k, v]) => `${k}:${v}`)
          .join(" ")}`,
        artifacts,
      ),
    );
    legs[sab.leg] = {
      group: "g55e",
      expected_class: "pixel-mismatch",
      result_class: cls.result_class,
      reasons: cls.reasons,
      harmless_ties: cls.harmless_ties,
      exit_code: await readExitCode(rdir),
      artifacts,
    };
    typedInputs.push({ leg: sab.leg, kind: "sabotage", applied, stdout });
  }
  const typed = evaluateReceiverTyped(typedInputs);
  checks.push(
    check(
      "shader-receiver-typed",
      "honest receivers (receiver-shader, -patch, -inline, receiver-params-lib) record no typed refusal and skip nothing; receiver-refused records exactly canvas_item_set_material / unsupported-material on the five refused items; receiver-params-nolib records exactly one shader_set_code / shader-withheld per withheld (shader, hash) pair it would make resident and sets no code; receiver-params-lib fetches no shader payload and sets exactly that many codes from its library; no receiver stdout (sabotages included) carries SHADER ERROR, Shader compilation failed or a script error",
      typed.problems,
      Object.entries(typed.table)
        .map(([k, v]) => `${k}: ${v}`)
        .join("; "),
      typedInputs.map((t) => t.leg),
    ),
  );

  // Capture hosts print no shader compile error (Q1f), the new captures included.
  const logClean = evaluateShaderLogClean(
    await Promise.all(
      [
        ["capture-shader-inline", "shader/capture-inline"],
        ["capture-policy-params", "shader-policy-params/capture"],
        ["capture-policy-exclude", "shader-policy-exclude/capture"],
        ["sabotage-shader-freeze", "shader/sabotage-freeze/capture"],
        ["sabotage-shader-omit-param", "shader/sabotage-omit-param/capture"],
        [
          "sabotage-shader-perturb-shader",
          "shader/sabotage-perturb-shader/capture",
        ],
      ].map(async ([leg, rel]) => ({ leg, text: await stdoutOf(at(rel)) })),
    ),
  );
  checks.push(
    check(
      "g55e-capture-log-clean",
      "no g55e capture host (capture-shader-inline, both policy captures, the three host-sabotage captures) printed a shader compile error: the dummy compiles every code it is given (Q1f); perturb-shader changes only the recorded code",
      logClean.problems,
      "6 capture stdouts carry no shader error",
      [],
    ),
  );

  const importDir = at("shader/import/receiver");
  const importCode = await readExitCode(importDir);
  checks.push(
    check(
      "shader-receiver-import-exit",
      "the g55e editor --import of receiver/ exited 0",
      importCode === 0
        ? []
        : [`import/receiver exit ${importCode ?? "<none>"}`],
      "receiver import exited 0",
      [join(importDir, "stdout.log")],
    ),
  );
  legs["import-receiver-shader"] = {
    group: "g55e",
    expected_class: null,
    result_class: null,
    reasons: [],
    exit_code: importCode,
    artifacts: [join(importDir, "stdout.log")],
  };

  // Report: per step, code bytes, parameter bytes, capture costs and receiver calls.
  const perStep = (
    full: Wire5,
    patch: Wire5,
    lines: readonly ResourceLine[],
    receivers: { leg: string; applied: AppliedJson55d | undefined }[],
  ) =>
    materialsPerStep(
      stepsAsCim(base),
      "base",
      full.transactions,
      patch.transactions,
      lines as readonly MaterialLogLine5[],
      receivers,
      G55E_QUIT_FRAME,
    );
  return {
    checks,
    legs,
    checkpoints,
    materials: {
      per_step: perStep(
        shaderFull,
        shaderPatch,
        logs.shader.lines,
        receiverTotals.filter((r) => r.leg.startsWith("receiver-shader")),
      ),
      per_step_params: perStep(
        paramsFull,
        paramsPatch,
        logs.params.lines,
        receiverTotals.filter((r) => r.leg.startsWith("receiver-params")),
      ),
      store: { grp1_payloads: store.payloads, grp1_bytes: store.bytes },
      shader_pairing: hashParity.pairing,
      receiver_budgets: budgets,
      sabotage_regions: sabotageRegions,
      receiver_typed: typed.table,
      policy: policyRows,
    },
  };
}
