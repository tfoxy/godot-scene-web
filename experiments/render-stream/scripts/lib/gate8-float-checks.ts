// Gate 8 group g8f (G8f, protocol/gate8-design.md D9 and Q3 "Compressed and float textures"): the
// checks over the evidence run-gate8.sh's g8f legs write. Pure functions of the evidence tree, so
// scripts/test/self-test-gate8f.ts can drive the helpers against fabricated data.
//
//   g8f/capture/                       /8, GRC_TEXTURE_DECODE=engine, every float format permitted:
//                                      recording.rs8 (+ patch), store, evidence/, textures.jsonl
//                                      (the fixture's independent expected payloads)
//   g8f/workers/capture/               the same with every copy on a texture worker (G8kw)
//   g8f/capture-default/               /8, decode engine, default formats: floats stay refused
//   g8f/refused-v6/                    a /6 sink asking for floats: policy-needs-v8
//   g8f/sabotage-perturb-decode/{capture,receiver}/
//   g8f/reference/                     rendered: shots/step-<k>.png
//   g8f/receiver/ receiver-patch/      native receiver on capture/'s full and patch sinks

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { decodePngRgba } from "./gate-minus1-checks";
import {
  compareWorkerRecordings,
  type G8tCheck,
  type HookTextureLine,
  type ShotDiff,
  type WorkerCompare,
} from "./gate8-tex-checks";
import {
  decodeRecording,
  type ResolvedRecording,
  resolveRecording,
  validateRecording,
  wireVersionOf,
} from "./render-stream-2";

export type G8fCheck = G8tCheck;

// ------------------------------------------------------------------------------- the rule

/** The float payload formats and their channel count and bytes per channel (D9). */
export const FLOAT_FORMATS: Record<string, { channels: number; bytes: number }> = {
  RF: { channels: 1, bytes: 4 },
  RGF: { channels: 2, bytes: 4 },
  RGBF: { channels: 3, bytes: 4 },
  RGBAF: { channels: 4, bytes: 4 },
  RH: { channels: 1, bytes: 2 },
  RGH: { channels: 2, bytes: 2 },
  RGBH: { channels: 3, bytes: 2 },
  RGBAH: { channels: 4, bytes: 2 },
};

/** IEEE-754 binary16 to a JS number, exactly. */
export function halfToNumber(h: number): number {
  const sign = h & 0x8000 ? -1 : 1;
  const exp = (h >> 10) & 0x1f;
  const frac = h & 0x3ff;
  if (exp === 0) return sign * frac * 2 ** -24;
  if (exp === 31) return frac === 0 ? sign * Number.POSITIVE_INFINITY : Number.NaN;
  return sign * (1 + frac / 1024) * 2 ** (exp - 15);
}

/**
 * The quantization rule of render-stream-8.md "As built (G8f)" (D9), written independently of
 * rs-core: NaN is 0; otherwise clamp to [0, 1] and take floor(fl32(fl32(c * 255) + 0.5)).
 */
export function quantizeUnorm8(v: number): number {
  if (Number.isNaN(v)) return 0;
  const c = Math.min(Math.max(Math.fround(v), 0), 1);
  return Math.floor(Math.fround(Math.fround(c * 255) + 0.5));
}

/** Straight RGBA8 of a float payload's level 0 (R -> (r,0,0,1), RG -> (r,g,0,1), ...). */
export function quantizeRgba8(
  format: string,
  width: number,
  height: number,
  data: Uint8Array,
): Uint8Array | null {
  const f = FLOAT_FORMATS[format];
  if (!f) return null;
  const n = width * height;
  const px = f.channels * f.bytes;
  if (data.length < n * px) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const out = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    const v = [0, 0, 0, 255];
    for (let c = 0; c < f.channels; c++) {
      const at = i * px + c * f.bytes;
      const value = f.bytes === 4 ? view.getFloat32(at, true) : halfToNumber(view.getUint16(at, true));
      v[c] = quantizeUnorm8(value);
    }
    out.set(v, i * 4);
  }
  return out;
}

// ------------------------------------------------------------------------------- evidence I/O

/** One line of the fixture's textures.jsonl (gate8_float.gd). */
export interface FloatLine {
  step: number;
  frame: number;
  name: string;
  kind: "curve" | "gradient" | "image" | "hdr";
  source: string;
  source_format: string | null;
  format: string;
  width: number;
  height: number;
  mipmaps: boolean;
  data_bytes: number;
  payload_sha256: string;
}

export interface FloatExpected {
  schema: string;
  /** name -> the format, size and kind the fixture must produce at the hook */
  textures: Record<
    string,
    { kind: string; format: string; width: number; width_step1?: number; height: number; mipmaps: boolean; source_format?: string; loader_thread?: boolean }
  >;
  /** the eight float formats every one of which must be carried by a texture of the fixture */
  formats: string[];
  /** frames the steps are applied at, as the fixture's defaults */
  steps: { step: number }[];
  perturbed: string[];
}

async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

async function readJson<T>(path: string): Promise<T | undefined> {
  const text = await readText(path);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

function jsonl<T>(text: string | undefined): T[] {
  if (!text) return [];
  return text
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as T);
}

async function exitCode(dir: string): Promise<string | null> {
  const t = await readText(join(dir, "exit-code.txt"));
  return t === undefined ? null : t.trim();
}

function skipped(dir: string): string | null {
  if (existsSync(join(dir, "skipped-by-tier.txt"))) return "skipped-by-tier";
  if (existsSync(join(dir, "skipped-remote.txt"))) return "skipped-remote";
  return null;
}

/** Every texture line of evidence/resources.jsonl with a payload hash (create, update, replace). */
export async function hookTextureLines(legDir: string): Promise<HookTextureLine[]> {
  return jsonl<HookTextureLine>(await readText(join(legDir, "evidence", "resources.jsonl"))).filter(
    (l) => typeof l.op === "string" && l.op.startsWith("texture"),
  );
}

export async function floatLines(legDir: string): Promise<FloatLine[]> {
  return jsonl<FloatLine>(await readText(join(legDir, "textures.jsonl")));
}

// ------------------------------------------------------------------------------- pure helpers

/**
 * float-oracle: every payload the fixture says it made (its own GDScript-side GRT1 hash) is a
 * texture payload the capture's hook published under the same hash and format. Returns the
 * problems; `matched` counts the agreeing lines.
 */
export function oracleProblems(
  lines: readonly FloatLine[],
  hook: readonly HookTextureLine[],
): { problems: string[]; matched: number } {
  const problems: string[] = [];
  let matched = 0;
  const byHash = new Map<string, HookTextureLine>();
  for (const h of hook) if (h.hash && h.status === "ok") byHash.set(h.hash, h);
  for (const l of lines) {
    const h = byHash.get(l.payload_sha256);
    const name = `${l.name}@step${l.step}`;
    if (!h) {
      problems.push(`${name}: no hook payload with the fixture's hash ${l.payload_sha256.slice(0, 12)} (${l.format} ${l.width}x${l.height})`);
      continue;
    }
    if (h.format !== l.format || h.width !== l.width || h.height !== l.height || h.mipmaps !== l.mipmaps)
      problems.push(`${name}: hook ${h.format} ${h.width}x${h.height} mipmaps ${h.mipmaps}, fixture ${l.format} ${l.width}x${l.height} mipmaps ${l.mipmaps}`);
    else if ((l.source_format ?? null) !== (h.source_format ?? null))
      problems.push(`${name}: hook source_format ${h.source_format ?? null}, fixture ${l.source_format}`);
    else matched++;
  }
  return { problems, matched };
}

/**
 * A hook log's texture lines with the cost columns, the worker keys and the process-local RID
 * dropped, in order: what must be identical between a synchronous and a worker capture (the
 * float scene also holds shader lines, whose RIDs differ per process).
 */
export function maskedTextureLines(text: string | undefined): string[] {
  const out: string[] = [];
  for (const l of jsonl<Record<string, unknown>>(text)) {
    if (!String(l.op).startsWith("texture")) continue;
    const m = { ...l };
    for (const k of ["t_us", "copy_ns", "hash_ns", "decode_ns", "worker", "hook_ns", "dup_ns", "rid"]) delete m[k];
    out.push(JSON.stringify(m));
  }
  return out;
}

/** The set of float formats a hook log carried as ok payloads. */
export function carriedFloatFormats(hook: readonly HookTextureLine[]): string[] {
  const set = new Set<string>();
  for (const h of hook) if (h.status === "ok" && h.format && h.format in FLOAT_FORMATS) set.add(h.format);
  return [...set].sort();
}

// ------------------------------------------------------------------------------- shots

async function shotPath(dir: string, step: number): Promise<string> {
  const fixtureShot = join(dir, "shots", `step-${step}.png`);
  const seqs = await readText(join(dir, "shot-seqs.txt"));
  if (seqs === undefined) return fixtureShot;
  const seq = seqs.trim().split(",")[step];
  return join(dir, "shots", `seq-${seq}.png`);
}

async function shotDiff(a: string, b: string, step: number): Promise<ShotDiff> {
  const pa = await shotPath(a, step);
  const pb = await shotPath(b, step);
  const ia = existsSync(pa) ? await decodePngRgba(pa) : undefined;
  const ib = existsSync(pb) ? await decodePngRgba(pb) : undefined;
  const out: ShotDiff = { step, a: pa, b: pb, present: false, differing: 0, max_delta: 0 };
  if (!ia || !ib || ia.width !== ib.width || ia.height !== ib.height) return out;
  out.present = true;
  for (let i = 0; i < ia.data.length; i += 4) {
    let d = 0;
    for (let c = 0; c < 4; c++) d = Math.max(d, Math.abs(ia.data[i + c] - ib.data[i + c]));
    if (d > 0) {
      out.differing++;
      out.max_delta = Math.max(out.max_delta, d);
    }
  }
  return out;
}

function check(
  id: string,
  criterion: string,
  problems: string[] | null,
  detailOk?: string,
  missing = "a leg did not run",
): G8fCheck {
  if (problems === null)
    return { id, criterion, passed: false, status: "fail", detail: `evidence missing (${missing})` };
  const passed = problems.length === 0;
  return { id, criterion, passed, status: passed ? "pass" : "fail", detail: passed ? detailOk : problems.slice(0, 12).join("; ") };
}

// ------------------------------------------------------------------------------- the group

export interface G8fReport {
  checks: G8fCheck[];
  legs: Record<string, { exit_code: string | null; skipped: string | null }>;
  carried_formats: string[];
  shot_diffs: Record<string, ShotDiff[]>;
  workers: { full: WorkerCompare | null; patch: WorkerCompare | null };
}

export async function runG8f(out: string, expected: FloatExpected): Promise<G8fReport> {
  const checks: G8fCheck[] = [];
  const root = join(out, "g8f");
  const legDirs = [
    "capture",
    "workers/capture",
    "capture-default",
    "refused-v6",
    "sabotage-perturb-decode/capture",
    "reference",
    "receiver",
    "receiver-patch",
    "sabotage-perturb-decode/receiver",
  ];
  const legs: G8fReport["legs"] = {};
  for (const l of legDirs) legs[l] = { exit_code: await exitCode(join(root, l)), skipped: skipped(join(root, l)) };
  const ran = (l: string) => legs[l].exit_code !== null && legs[l].skipped === null;
  const capDir = join(root, "capture");
  const hook = await hookTextureLines(capDir);
  const lines = await floatLines(capDir);
  const steps = expected.steps;

  // --- float-oracle -------------------------------------------------------------------------
  {
    const problems: string[] = [];
    if (legs.capture.exit_code !== "0") problems.push(`capture exit ${legs.capture.exit_code}`);
    const o = oracleProblems(lines, hook);
    problems.push(...o.problems);
    for (const [name, e] of Object.entries(expected.textures))
      for (const step of steps) {
        if (step.step === 1 && e.kind === "hdr") continue;
        const l = lines.find((x) => x.name === name && x.step === step.step);
        if (!l) {
          problems.push(`${name}: the fixture logged no step ${step.step} payload`);
          continue;
        }
        const width = step.step === 1 && e.width_step1 !== undefined ? e.width_step1 : e.width;
        if (l.format !== e.format || l.width !== width || l.height !== e.height || l.mipmaps !== e.mipmaps)
          problems.push(`${name}@step${step.step}: fixture made ${l.format} ${l.width}x${l.height} mipmaps ${l.mipmaps}, expected.json says ${e.format} ${width}x${e.height} mipmaps ${e.mipmaps}`);
      }
    // an update really changed the content (the step-1 payload is not the step-0 one)
    for (const name of ["curve_rf", "curve_rgb", "curve_xyz", "grad_hdr", "img_rh", "img_rgbah"]) {
      const a = lines.find((x) => x.name === name && x.step === 0);
      const b = lines.find((x) => x.name === name && x.step === 1);
      if (a && b && a.payload_sha256 === b.payload_sha256) problems.push(`${name}: step 1 did not change the payload`);
    }
    checks.push(
      check(
        "float-oracle",
        "every float payload the fixture computed itself (curve samples, gradient colours, the images it built, Image.decompress of the imported HDR) is published by the capture's hook under the same GRT1 SHA-256, format and shape, at both steps (the update and replace paths included), and BC6H/ASTC-HDR carry source_format with a half-float payload",
        ran("capture") ? problems : null,
        `${o.matched} payloads agree`,
      ),
    );
  }

  // --- float-census -------------------------------------------------------------------------
  {
    const problems: string[] = [];
    const carried = carriedFloatFormats(hook);
    for (const f of expected.formats) if (!carried.includes(f)) problems.push(`${f} was never carried as an ok payload`);
    const refused = hook.filter((h) => h.status !== "ok" && h.reason !== null && h.format !== null && (h.format in FLOAT_FORMATS || h.source_format !== undefined));
    if (refused.length > 0) problems.push(`${refused.length} float or decoded textures refused (${refused[0].format}: ${refused[0].reason})`);
    for (const [name, e] of Object.entries(expected.textures)) {
      if (e.source_format === undefined) continue;
      const l = lines.find((x) => x.name === name && x.step === 0);
      const h = l ? hook.find((x) => x.hash === l.payload_sha256) : undefined;
      if (!h) problems.push(`${name}: no hook line`);
      else if (h.source_format !== e.source_format) problems.push(`${name}: source_format ${h.source_format}, expected ${e.source_format}`);
      else if (h.format !== e.format) problems.push(`${name}: decoded to ${h.format}, expected ${e.format}`);
    }
    const threads = new Set(hook.filter((h) => h.status === "ok" && h.format !== null && h.format in FLOAT_FORMATS).map((h) => h.thread));
    if (threads.size < 2) problems.push(`float payloads came from ${threads.size} thread(s) (${[...threads].join(", ")}); the loader-thread case needs a second`);
    checks.push(
      check(
        "float-census",
        "all eight float formats (RF RGF RGBF RGBAF RH RGH RGBH RGBAH) appear as ok payloads, none refused, the two HDR imports decode to RGBH (BPTC_RGBFU) and RGBAH (ASTC_4x4_HDR) with their source_format, and the float creates come from the main thread and a loader thread",
        ran("capture") ? problems : null,
        `carried ${carried.join(" ")}; threads ${[...threads].join(", ")}`,
      ),
    );
  }

  // --- float-wire ---------------------------------------------------------------------------
  {
    const problems: string[] = [];
    for (const name of ["recording.rs8", "recording-patch.rs8"]) {
      const path = join(capDir, name);
      if (!existsSync(path)) {
        problems.push(`capture/${name} missing`);
        continue;
      }
      const bytes = new Uint8Array(await readFile(path));
      if (wireVersionOf(bytes) !== 8) {
        problems.push(`capture/${name} is not GRS8`);
        continue;
      }
      const errors = validateRecording(bytes, 8);
      if (errors.length > 0) {
        problems.push(`invalid /8 ${name}: ${errors[0]}`);
        continue;
      }
      const decoded = decodeRecording(bytes, 8) as unknown as { records: { meta: Record<string, unknown> }[] };
      const session = decoded.records[0]?.meta as { resources?: { decode?: string; permitted_formats?: string[] } } | undefined;
      if (session?.resources?.decode !== "engine") problems.push(`${name}: session resources.decode ${session?.resources?.decode}`);
      const permitted = session?.resources?.permitted_formats ?? [];
      for (const f of Object.keys(FLOAT_FORMATS)) if (!permitted.includes(f)) problems.push(`${name}: permitted_formats lacks ${f}`);
      const formats = new Set<string>();
      for (const r of decoded.records) {
        const textures = r.meta.textures as { status: string; format: string | null }[] | undefined;
        for (const t of textures ?? []) if (t.status === "ok" && t.format && t.format in FLOAT_FORMATS) formats.add(t.format);
      }
      if (formats.size < Object.keys(FLOAT_FORMATS).length) problems.push(`${name}: table entries carry ${formats.size} float formats`);
    }
    checks.push(
      check(
        "float-wire",
        "both /8 recordings of the float capture validate, declare resources.decode \"engine\" and every float format in permitted_formats, and their texture entries carry all eight float formats as ok",
        ran("capture") ? problems : null,
      ),
    );
  }

  // --- the default-formats control and the /6 refusal ----------------------------------------
  {
    const dir = join(root, "capture-default");
    const h = await hookTextureLines(dir);
    const problems: string[] = [];
    if (legs["capture-default"].exit_code !== "0") problems.push(`capture-default exit ${legs["capture-default"].exit_code}`);
    const floatOk = h.filter((x) => x.status === "ok" && x.format !== null && x.format in FLOAT_FORMATS);
    if (floatOk.length > 0) problems.push(`${floatOk.length} float payloads carried without GRC_RESOURCE_FORMATS naming them`);
    const refusedFloat = h.filter((x) => x.status === "unsupported" && x.reason === "unsupported-format" && x.format !== null && x.format in FLOAT_FORMATS);
    if (refusedFloat.length < 9) problems.push(`${refusedFloat.length} float textures refused unsupported-format, expected at least 9 (the engine and loader ones)`);
    const hdr = h.filter((x) => x.status === "unsupported" && (x.format === "BPTC_RGBFU" || x.format === "ASTC_4x4_HDR"));
    if (hdr.length < 2) problems.push(`${hdr.length} HDR block-compressed refusals, expected 2 (BPTC_RGBFU and ASTC_4x4_HDR)`);
    if (hdr.some((x) => x.decode_ns !== null && x.decode_ns > 0)) problems.push("a decode ran for a payload the policy would refuse");
    checks.push(
      check(
        "float-default-refused",
        "with a /8 decode sink but the default GRC_RESOURCE_FORMATS no float payload is carried: every float texture is refused unsupported-format with its own format, and BC6H/ASTC-HDR are refused without a decode being run",
        ran("capture-default") ? problems : null,
        `${refusedFloat.length} float refusals, ${hdr.length} HDR refusals`,
      ),
    );
  }
  {
    const dir = join(root, "refused-v6");
    const r = await readJson<{ stream?: { status?: string; reason?: string | null } }>(join(dir, "evidence", "result.json"));
    const problems: string[] = [];
    if (!r?.stream) problems.push("refused-v6/evidence/result.json has no stream");
    else {
      if (r.stream.status !== "refused") problems.push(`stream status ${r.stream.status}`);
      if (!String(r.stream.reason ?? "").includes("policy-needs-v8")) problems.push(`reason ${r.stream.reason}`);
    }
    if (existsSync(join(dir, "recording.rs2")) && (await readFile(join(dir, "recording.rs2"))).length > 0)
      problems.push("a /6 recording was written for a refused stream");
    checks.push(
      check(
        "float-v6-refused",
        "a /6 file sink asked for float formats (GRC_RESOURCE_FORMATS) refuses to publish with policy-needs-v8 and writes no recording",
        ran("refused-v6") ? problems : null,
        "refused: policy-needs-v8",
      ),
    );
  }

  // --- workers ---------------------------------------------------------------------------------
  const workers: G8fReport["workers"] = { full: null, patch: null };
  {
    const problems: string[] = [];
    const wDir = join(root, "workers", "capture");
    const load = async (dir: string, name: string): Promise<ResolvedRecording | string> => {
      const path = join(dir, name);
      if (!existsSync(path)) return `${name} missing`;
      const bytes = new Uint8Array(await readFile(path));
      const errors = validateRecording(bytes, 8);
      if (errors.length > 0) return `invalid /8 ${name}: ${errors[0]}`;
      return resolveRecording(bytes, 8);
    };
    for (const [key, name] of [["full", "recording.rs8"], ["patch", "recording-patch.rs8"]] as const) {
      const a = await load(capDir, name);
      const b = await load(wDir, name);
      if (typeof a === "string" || typeof b === "string") {
        problems.push(typeof a === "string" ? `capture/${a}` : `workers/capture/${b as string}`);
        continue;
      }
      const c = compareWorkerRecordings(a, b);
      workers[key] = c;
      problems.push(...c.problems.map((p) => `${name}: ${p}`));
    }
    const a = { texture: maskedTextureLines(await readText(join(capDir, "evidence", "resources.jsonl"))) };
    const b = { texture: maskedTextureLines(await readText(join(wDir, "evidence", "resources.jsonl"))) };
    if (a.texture.length !== b.texture.length) problems.push(`${b.texture.length} hook lines, the synchronous log has ${a.texture.length}`);
    for (let i = 0; i < Math.min(a.texture.length, b.texture.length); i++)
      if (a.texture[i] !== b.texture[i]) {
        problems.push(`hook line ${i + 1} differs: ${b.texture[i].slice(0, 140)}`);
        break;
      }
    const wHook = await hookTextureLines(wDir);
    const onWorker = wHook.filter((h) => h.worker === true && h.status === "ok" && h.format !== null && h.format in FLOAT_FORMATS);
    if (onWorker.length === 0) problems.push("no float payload was copied by a worker");
    checks.push(
      check(
        "float-workers",
        "G8kw with floats: under GRC_TEXTURE_WORKERS=2 the float capture's two /8 sinks resolve to the synchronous capture's states and its hook log is the synchronous one, with float payloads copied by workers",
        ran("workers/capture") && ran("capture") ? problems : null,
        `${onWorker.length} float worker copies`,
        "workers/capture",
      ),
    );
  }

  // --- float-exact: the native receiver against the reference -------------------------------
  const shot_diffs: Record<string, ShotDiff[]> = {};
  {
    const problems: string[] = [];
    let compared = 0;
    for (const leg of ["receiver", "receiver-patch"]) {
      if (legs[leg].exit_code !== "0") problems.push(`${leg} exit ${legs[leg].exit_code}`);
      const applied = await readJson<{ errors?: unknown[]; result?: { class?: string } }>(join(root, leg, "applied.json"));
      if (!applied) problems.push(`${leg}/applied.json missing`);
      shot_diffs[leg] = [];
      for (const s of steps) {
        const d = await shotDiff(join(root, "reference"), join(root, leg), s.step);
        shot_diffs[leg].push(d);
        compared++;
        if (!d.present) problems.push(`${leg} step ${s.step}: shot missing`);
        else if (d.differing > 0) problems.push(`${leg} step ${s.step}: ${d.differing} px differ (max delta ${d.max_delta})`);
      }
    }
    checks.push(
      check(
        "float-exact",
        "the native receiver (Rust core, GLES3) on the full and the patch sink draws the float scene (curve, gradient and loader-made float textures as shader inputs and sprites, decoded BC6H/ASTC-HDR, the update and replace step) pixel-identical to the reference at both steps",
        ran("reference") && ran("receiver") && ran("receiver-patch") ? problems : null,
        `${compared} shots identical`,
        "reference/receiver",
      ),
    );
  }

  // --- sabotage-perturb-decode -----------------------------------------------------------------
  {
    const sabCap = join(root, "sabotage-perturb-decode", "capture");
    const sabHook = await hookTextureLines(sabCap);
    const sabLines = await floatLines(sabCap);
    const o = oracleProblems(sabLines, sabHook);
    const problems: string[] = [];
    const hdrNames = expected.perturbed;
    const hdrFailed = hdrNames.filter((n) => o.problems.some((p) => p.startsWith(`${n}@`)));
    for (const n of hdrNames) if (!hdrFailed.includes(n)) problems.push(`${n}: the oracle did not catch a perturbed half-float decode`);
    const other = o.problems.filter((p) => !hdrNames.some((n) => p.startsWith(`${n}@`)));
    if (other.length > 0) problems.push(`perturb-decode also broke an unrelated payload: ${other[0]}`);
    const d = await shotDiff(join(root, "reference"), join(root, "sabotage-perturb-decode", "receiver"), 0);
    if (!d.present) problems.push("sabotage receiver step 0 shot missing");
    else if (d.differing === 0) problems.push("the perturbed decode left the receiver's pixels identical to the reference");
    checks.push(
      check(
        "sabotage-perturb-decode",
        "perturb-decode (the first channel of texel 0 of every host-decoded payload inverted whole, after the decode and before the hash) fails the float oracle for exactly the two HDR decodes and changes the receiver's pixels",
        ran("sabotage-perturb-decode/capture") && ran("sabotage-perturb-decode/receiver") && ran("reference") ? problems : null,
        `oracle caught ${hdrFailed.join(", ")}; ${d.differing} px differ`,
        "sabotage-perturb-decode",
      ),
    );
  }

  return { checks, legs, carried_formats: carriedFloatFormats(hook), shot_diffs, workers };
}
